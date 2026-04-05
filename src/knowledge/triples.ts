import { createHash } from "node:crypto";
import { eq, and, or, sql, ilike, desc, inArray } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { triples, atoms, vectorToDriver } from "../db/schema.js";
import { getConfig } from "../config/index.js";
import type { Triple, RetrievalResult } from "../core/types.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
} from "../providers/embedding-provider.js";
import { resolveTripleEntities } from "./entity-resolver.js";

// ─── LIKE Escape Helper ─────────────────────────────────────────

function escapeLike(input: string): string {
  return input.replace(/[%_\\]/g, (c) => `\\${c}`);
}

// ─── Query Classification ────────────────────────────────────────

const FACTUAL_SIGNALS = new Set([
  "what", "which", "who", "when", "where", "how many", "how much",
  "rating", "rate", "score", "name", "list", "time", "date",
  "profession", "job", "age", "genre", "show", "movie", "anime",
  "music", "song", "track", "schedule", "address", "number",
]);

const CONTEXTUAL_SIGNALS = new Set([
  "why", "how does", "what does it mean", "relationship", "feel",
  "emotion", "think", "believe", "value", "identity", "who is",
  "personality", "philosophy", "meaning", "important", "matter",
  "growth", "evolve", "change", "improve", "learn",
]);

export function classifyQuery(query: string): { type: string; tripleRatio: number } {
  const lower = query.toLowerCase();
  let factualScore = 0;
  let contextualScore = 0;
  for (const s of FACTUAL_SIGNALS) {
    if (lower.includes(s)) factualScore++;
  }
  for (const s of CONTEXTUAL_SIGNALS) {
    if (lower.includes(s)) contextualScore++;
  }
  if (factualScore > contextualScore) return { type: "factual", tripleRatio: 0.5 };
  if (contextualScore > factualScore) return { type: "contextual", tripleRatio: 0.15 };
  return { type: "mixed", tripleRatio: 0.3 };
}

// ─── Extraction Prompt ───────────────────────────────────────────

const EXTRACTION_PROMPT = `Extract factual triples (subject, predicate, object) from this memory atom.

ENTITY RULES:
- Subject/Object must be a NAMED ENTITY (person, organization, tool, system, place, project), max 30 chars
- Normalize entities: Title_Case with underscores (Andrew_Peltekci, not drew/Drew/DREW)
- NEVER use "true", "false", "yes", "no", numbers alone, or generic words as objects
- If about the user's preferences, subject = "User"

PREDICATE RULES - USE ONLY THESE PREDICATES:
  Identity: is_founder_of, is_member_of, has_role, is_instance_of, is_type_of
  Location: located_in, headquartered_in, deployed_on, runs_on
  Relationship: works_with, reports_to, manages, collaborates_with, is_client_of
  Ownership: owns, manages_asset, created, authored, maintains
  Technical: uses_tool, depends_on, integrates_with, connects_to, configured_with
  Schedule: scheduled_for, has_schedule, meets_on, deadline_is
  Status: has_status, completed, assigned_to, blocked_by, priority_is
  Preference: prefers, likes, dislikes, follows, subscribes_to
  Communication: sent_to, received_from, discussed_with, announced_to
  Content: posted_on, published_to, drafted_for, targets_audience

If no predicate fits, use the closest match. NEVER use generic "is", "has", "includes", "contains".

SKIP if: emotional commentary, meta-discussion, system logs, JSON blobs, or no concrete facts.

Atom content:
{content}

Output format (one per line, or SKIP):
(subject, predicate, object)`;

// ─── Triple ID ───────────────────────────────────────────────────

function generateTripleId(subject: string, predicate: string, object: string): string {
  const normKey = `${subject.toLowerCase().trim()}:${predicate.toLowerCase().trim()}:${object.toLowerCase().trim()}`;
  return createHash("sha256").update(normKey).digest("hex").slice(0, 16);
}

// ─── Embedding Helper ────────────────────────────────────────────

let _embeddingProvider: EmbeddingProvider | null = null;

function getEmbeddingProvider(): EmbeddingProvider {
  if (!_embeddingProvider) {
    const cfg = getConfig();
    _embeddingProvider = createEmbeddingProvider({
      provider: cfg.embedding.provider as "nvidia-nim" | "openai" | "onnx" | "local",
      model: cfg.embedding.model,
      apiKey: cfg.embedding.api_key ?? process.env[cfg.embedding.api_key_env] ?? undefined,
      baseUrl: cfg.embedding.url,
      batchSize: cfg.embedding.batch_size,
      dimensions: cfg.embedding.dimensions,
    });
  }
  return _embeddingProvider;
}

async function embedTripleSafe(subject: string, predicate: string, object: string): Promise<number[] | null> {
  try {
    const text = `${subject} ${predicate.replace(/_/g, " ")} ${object}`;
    return await getEmbeddingProvider().embedSingle(text);
  } catch {
    return null;
  }
}

// ─── LLM Call Helper ─────────────────────────────────────────────

function getLlmConfig(): { url: string; model: string; apiKey: string } | null {
  const cfg = getConfig();
  const keyEnv = cfg.triples.api_key_env;
  let apiKey = keyEnv ? process.env[keyEnv] : undefined;
  let url = cfg.triples.llm_url;
  const model = cfg.triples.llm_model;

  if (!apiKey) {
    apiKey = process.env.OPENAI_API_KEY;
    if (!url) url = "https://api.openai.com/v1/chat/completions";
  }
  if (!apiKey) {
    apiKey = process.env.NVIDIA_NIM_API_KEY;
    if (!url) url = "https://integrate.api.nvidia.com/v1/chat/completions";
  }
  if (!apiKey || !url) return null;
  return { url, model, apiKey };
}

// ─── Parse LLM Output ───────────────────────────────────────────

function parseTriples(text: string, atomId: string): Array<{ atomId: string; subject: string; predicate: string; object: string }> {
  const result: Array<{ atomId: string; subject: string; predicate: string; object: string }> = [];
  const pattern = /\(([^,]+),\s*([^,]+),\s*([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    let subj = match[1].trim().replace(/^["']|["']$/g, "");
    let pred = match[2].trim().replace(/^["']|["']$/g, "");
    let obj = match[3].trim().replace(/^["']|["']$/g, "");
    if (subj.length > 50 || obj.length > 50) continue;
    if (subj.length < 2 || obj.length < 2 || pred.length < 2) continue;
    pred = pred.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
    if (!pred) continue;

    // Resolve entities to canonical forms
    const resolved = resolveTripleEntities(subj, pred, obj);
    if (!resolved) continue;

    result.push({ atomId, subject: resolved.subject, predicate: resolved.predicate, object: resolved.object });
  }
  return result;
}

// ─── Public API ──────────────────────────────────────────────────

export async function extractTriples(atomId: string, content: string): Promise<number> {
  const llm = getLlmConfig();
  if (!llm) return 0;

  const prompt = EXTRACTION_PROMPT.replace("{content}", content);
  let responseText: string;
  try {
    const res = await fetch(llm.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${llm.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: llm.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return 0;
    const json = (await res.json()) as { choices: Array<{ message: { content?: string; reasoning?: string } }> };
    responseText = (json.choices[0].message.content ?? json.choices[0].message.reasoning ?? "").trim();
  } catch {
    return 0;
  }

  if (responseText.toUpperCase().includes("SKIP") && responseText.length < 20) return 0;

  const parsed = parseTriples(responseText, atomId);
  if (!parsed.length) return 0;

  let stored = 0;
  for (const t of parsed) {
    try {
      await storeTriple({
        subject: t.subject,
        predicate: t.predicate,
        object: t.object,
        atomId: t.atomId,
        agentId: "default",
        confidence: 1.0,
      });
      stored++;
    } catch {
      // content-level dedup conflict is expected
    }
  }
  return stored;
}

export async function storeTriple(triple: {
  subject: string;
  predicate: string;
  object: string;
  atomId: string;
  agentId: string;
  confidence: number;
}): Promise<void> {
  const db = getDb();
  const id = generateTripleId(triple.subject, triple.predicate, triple.object);
  const now = new Date();

  const embedding = await embedTripleSafe(triple.subject, triple.predicate, triple.object);

  await db.insert(triples).values({
    id,
    atomId: triple.atomId,
    subject: triple.subject,
    predicate: triple.predicate,
    object: triple.object,
    confidence: triple.confidence,
    state: "active",
    embedding,
    createdAt: now,
  }).onConflictDoNothing();
}

export async function getTriples(params: {
  agentId?: string;
  subject?: string;
  object?: string;
  limit?: number;
}): Promise<Triple[]> {
  const db = getDb();
  const conditions = [eq(triples.state, "active")];

  if (params.subject) {
    conditions.push(ilike(triples.subject, escapeLike(params.subject)));
  }
  if (params.object) {
    conditions.push(ilike(triples.object, escapeLike(params.object)));
  }

  const rows = await db
    .select()
    .from(triples)
    .where(and(...conditions))
    .orderBy(desc(triples.createdAt))
    .limit(params.limit ?? 50);

  return rows.map(rowToTriple);
}

export async function graphTraverse(
  entity: string,
  hops = 3,
): Promise<{ entities: string[]; relations: Triple[] }> {
  const db = getDb();
  const visited = new Set<string>();
  let frontier = new Set([entity.toLowerCase()]);
  const allTriples: Triple[] = [];

  for (let hop = 0; hop < hops; hop++) {
    if (frontier.size === 0) break;

    const nextFrontier = new Set<string>();
    for (const node of frontier) {
      if (visited.has(node)) continue;
      visited.add(node);

      const rows = await db
        .select()
        .from(triples)
        .where(
          and(
            eq(triples.state, "active"),
            or(
              ilike(triples.subject, escapeLike(node)),
              ilike(triples.object, escapeLike(node)),
            ),
          ),
        );

      for (const row of rows) {
        allTriples.push(rowToTriple(row));
        nextFrontier.add(row.subject.toLowerCase());
        nextFrontier.add(row.object.toLowerCase());
      }
    }
    frontier = new Set([...nextFrontier].filter((n) => !visited.has(n)));
  }

  const entities = new Set<string>();
  for (const t of allTriples) {
    entities.add(t.subject);
    entities.add(t.object);
  }

  return { entities: [...entities], relations: allTriples };
}

export async function graphPath(
  from: string,
  to: string,
  maxHops = 4,
): Promise<Triple[][]> {
  const db = getDb();
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();

  type QueueItem = { node: string; path: string[] };
  const queue: QueueItem[] = [{ node: fromLower, path: [fromLower] }];
  const visited = new Set<string>([fromLower]);
  const foundPaths: Triple[][] = [];

  while (queue.length > 0) {
    const { node, path } = queue.shift()!;

    if (node === toLower && path.length > 1) {
      const chain = await reconstructChain(db, path);
      if (chain.length > 0) foundPaths.push(chain);
      continue;
    }

    if (path.length > maxHops) continue;

    const rows = await db
      .select()
      .from(triples)
      .where(
        and(
          eq(triples.state, "active"),
          or(
            ilike(triples.subject, escapeLike(node)),
            ilike(triples.object, escapeLike(node)),
          ),
        ),
      );

    for (const row of rows) {
      const neighbor =
        row.subject.toLowerCase() === node
          ? row.object.toLowerCase()
          : row.subject.toLowerCase();

      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ node: neighbor, path: [...path, neighbor] });
      }
    }
  }

  return foundPaths;
}

async function reconstructChain(
  db: ReturnType<typeof getDb>,
  path: string[],
): Promise<Triple[]> {
  const chain: Triple[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const rows = await db
      .select()
      .from(triples)
      .where(
        and(
          eq(triples.state, "active"),
          or(
            and(ilike(triples.subject, escapeLike(a)), ilike(triples.object, escapeLike(b))),
            and(ilike(triples.subject, escapeLike(b)), ilike(triples.object, escapeLike(a))),
          ),
        ),
      )
      .limit(1);
    if (rows.length > 0) chain.push(rowToTriple(rows[0]));
  }
  return chain;
}

export async function hybridRetrieve(
  query: string,
  params: { agentId?: string; topK?: number },
): Promise<{ atoms: RetrievalResult[]; triples: Triple[] }> {
  const { type, tripleRatio } = classifyQuery(query);
  const topK = params.topK ?? 20;
  const tripleK = Math.max(3, Math.round(topK * tripleRatio));
  const atomK = Math.max(3, topK - tripleK);

  const tripleResults = await retrieveTriplesBySimilarity(query, tripleK);

  // atom retrieval is left to the caller's pipeline -- return empty placeholder
  return {
    atoms: [],
    triples: tripleResults,
  };
}

async function retrieveTriplesBySimilarity(query: string, topK: number): Promise<Triple[]> {
  const db = getDb();
  let queryVec: number[];
  try {
    queryVec = await getEmbeddingProvider().embedSingle(query);
  } catch {
    return keywordFallback(query, topK);
  }

  const limit = Math.min(topK, 50);
  const minSim = 0.2;
  const vectorParam = vectorToDriver(queryVec);

  const result = await db.execute(sql`
    SELECT t.*, 1 - (t.embedding <=> ${vectorParam}::vector) AS similarity
    FROM triples t
    WHERE t.state = 'active' AND t.embedding IS NOT NULL
    ORDER BY t.embedding <=> ${vectorParam}::vector
    LIMIT ${limit}
  `);

  return result.rows
    .filter((r: any) => Number(r.similarity) >= minSim)
    .map((r: any) => rowToTriple(r));
}

async function keywordFallback(query: string, topK: number): Promise<Triple[]> {
  const db = getDb();
  const terms = query
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .map((t) => t.toLowerCase());

  if (!terms.length) return [];

  const conditions = terms.map(
    (term) =>
      or(
        ilike(triples.subject, `%${escapeLike(term)}%`),
        ilike(triples.predicate, `%${escapeLike(term)}%`),
        ilike(triples.object, `%${escapeLike(term)}%`),
      ),
  );

  const rows = await db
    .select()
    .from(triples)
    .where(and(eq(triples.state, "active"), or(...conditions)))
    .limit(topK * 3);

  const scored = rows.map((row) => {
    const text = `${row.subject} ${row.predicate} ${row.object}`.toLowerCase();
    const score = terms.reduce((s, t) => s + (text.includes(t) ? 1 : 0), 0);
    return { triple: rowToTriple(row), score: score * (row.confidence ?? 1.0) };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.triple);
}

export async function getTripleStats(agentId?: string): Promise<{
  total: number;
  byPredicate: Record<string, number>;
}> {
  const db = getDb();
  const condition = eq(triples.state, "active");

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(triples)
    .where(condition);

  const predRows = await db
    .select({
      predicate: triples.predicate,
      count: sql<number>`count(*)`,
    })
    .from(triples)
    .where(condition)
    .groupBy(triples.predicate);

  const byPredicate: Record<string, number> = {};
  for (const r of predRows) {
    byPredicate[r.predicate] = Number(r.count);
  }

  return { total: Number(count), byPredicate };
}

// ─── Helpers ─────────────────────────────────────────────────────

function rowToTriple(row: typeof triples.$inferSelect): Triple {
  return {
    id: row.id,
    atomId: row.atomId,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    confidence: row.confidence ?? 1.0,
    state: row.state ?? "active",
    embedding: row.embedding,
    createdAt: row.createdAt ?? new Date(),
  };
}

// ─── Unique/Multi Predicates (for contradiction detection) ───────

export const UNIQUE_PREDICATES = new Set([
  "has_profession", "works_as", "lives_in", "has_status",
  "wake_time", "has_schedule", "has_threshold",
  "has_limit", "tours_with", "is_type",
]);

export const MULTI_PREDICATES = new Set([
  "has_genre_preference", "has_value", "has_trait", "has_capability",
  "has_hobby", "likes", "uses", "has_rule", "has_principle",
  "has_rating", "watched", "played", "listened_to",
]);
