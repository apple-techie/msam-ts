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

const EXTRACTION_PROMPT = `Extract factual triples from this memory atom. Classify each entity with the most SPECIFIC type that fits.

ENTITY RULES:
- Subject/Object must be a NAMED ENTITY, max 30 chars
- Normalize entities: Title_Case with underscores (Andrew_Peltekci, not drew/Drew/DREW)
- NEVER use "true", "false", "yes", "no", numbers alone, or generic words as objects
- If about the user's preferences, subject = "User"

TYPE RULES — pick whatever is most specific and natural. Use singular, Title_Case.
Reuse types you've seen before when they fit. Invent new types when reality demands it.

Examples of good types (non-exhaustive, use anything that fits):
  Person, Founder, Investor, Engineer, Partner, Advisor
  Organization, Startup, VC_Firm, LLC, Agency, Bank, Cafe
  Agent, Bot, AI_Agent, Orchestrator, Worker
  SaaS, Library, Framework, Database, API, Endpoint
  Codebase, Repository, Fork, Package
  Gateway, Server, Node, Container, Cluster
  Infrastructure, Hardware, Cloud, Device
  Dashboard, Widget, UI_Component, Page, Screen
  Automation, Workflow, Cron_Job, Pipeline, Script
  Document, Note, Email, Message, Thread, Post, Reel, Story, Campaign
  Meeting, Call, Event, Deadline, Milestone
  Role, Skill, Concept, Category, Theme, Principle
  Location, City, Office, Venue
  Project, Initiative, Slug, Milestone
  Task, Issue, Bug, Feature_Request, PR
  Commodity, Product, Jewelry, Currency
  Dataset, Schema, Table, Field, Property, Config
  Account, Credential, Secret, Keychain_Item

Prefer SPECIFIC over generic. Stripe is a SaaS, not "Technology". Vercel is a Platform, not "Technology".
Andrew_Peltekci is a Founder (or Person), not just "Person". An investor is an Investor, not a "Concept".

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
(subject [Type], predicate, object [Type])

Examples:
(Andrew_Peltekci [Founder], is_founder_of, Kainotomic [Startup])
(Enduru_Gateway [Gateway], deployed_on, Mac_Studio [Hardware])
(Stripe [SaaS], integrates_with, Enduru_AI [Startup])
(Aurora [AI_Agent], manages, FB_Marketplace_Scan [Automation])
(Ryan_Hoover [Founder], founded, Product_Hunt [Startup])
(User [Person], prefers, Dark_Mode [UI_Preference])`;

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

/**
 * Normalize a raw type annotation from the LLM.
 *
 * Dynamic ontology: we accept any Title_Case identifier. Per-word
 * title-casing handles multi-word types ("VC_Firm", "AI_Agent") while
 * still catching lowercase/uppercase drift ("saas" -> "SaaS" is handled
 * via the ALIASES map below, "person" -> "Person" by default rule).
 *
 * Returns null for empty / non-identifier-shaped values.
 */
const TYPE_ALIASES: Record<string, string> = {
  // Canonical variants for things the LLM tends to wobble on
  "tools": "Tool",
  "technologies": "Technology",
  "orgs": "Organization",
  "organizations": "Organization",
  "company": "Organization",
  "companies": "Organization",
  "corporation": "Organization",
  "enterprise": "Organization",
  "people": "Person",
  "persons": "Person",
  "humans": "Person",
  "individual": "Person",
  "agents": "Agent",
  "bots": "Bot",
  "ai": "AI_Agent",
  "ai_agents": "AI_Agent",
  "saas": "SaaS",
  "api": "API",
  "apis": "API",
  "sdk": "SDK",
  "cli": "CLI",
  "ui": "UI_Component",
  "ux": "UX_Concept",
  "vc": "VC_Firm",
  "venture_capital": "VC_Firm",
  "vc_fund": "VC_Firm",
  "llc": "LLC",
  "inc": "Organization",
  "kb": "Knowledge_Base",
  "pr": "Pull_Request",
  "prs": "Pull_Request",
  "crons": "Cron_Job",
  "crontab": "Cron_Job",
  "workflows": "Workflow",
  "automations": "Automation",
  "pipelines": "Pipeline",
  "codebases": "Codebase",
  "repos": "Repository",
  "repository": "Repository",
  "dashboards": "Dashboard",
  "dataset": "Dataset",
  "datasets": "Dataset",
  "file": "File",
  "files": "File",
  "directory": "Directory",
  "directories": "Directory",
  "docs": "Document",
  "documents": "Document",
  "messages": "Message",
  "emails": "Email",
  "post": "Post",
  "posts": "Post",
  "reel": "Reel",
  "reels": "Reel",
  "story": "Story",
  "stories": "Story",
  "campaign": "Campaign",
  "campaigns": "Campaign",
  "channel": "Channel",
  "channels": "Channel",
  "collection": "Collection",
  "collections": "Collection",
  "status": "Status",
  "statuses": "Status",
  "metric": "Metric",
  "metrics": "Metric",
  "contact": "Contact",
  "contacts": "Contact",
  "contact_list": "Contact_List",
  "career": "Role",
  "career_path": "Role",
  "sprint": "Event",
  "deal": "Deal",
  "deals": "Deal",
  "frequency": "Metric",
  "code_concept": "Concept",
  "industry": "Domain",
};

function normalizeType(raw: string | undefined): string | null {
  if (!raw) return null;
  let cleaned = raw.trim().replace(/^\[|\]$/g, "").trim();
  if (!cleaned) return null;

  // Strip non-identifier chars (keep letters, digits, underscore, hyphen)
  cleaned = cleaned.replace(/[^\w-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (!cleaned || cleaned.length > 40) return null;

  // Alias lookup (case-insensitive, on the cleaned form)
  const aliasKey = cleaned.toLowerCase();
  if (TYPE_ALIASES[aliasKey]) return TYPE_ALIASES[aliasKey];

  // Title-case each underscore-separated word (preserve known all-caps like API, SaaS, UI)
  // If a word is already mixed-case, leave it; else upper-first + lower-rest.
  const parts = cleaned.split(/[_\-]/);
  const titled = parts
    .filter((p) => p.length > 0)
    .map((p) => {
      // Mixed case? (has at least one upper and one lower, like "SaaS") — leave alone.
      if (/[a-z]/.test(p) && /[A-Z]/.test(p)) return p;
      // All same case — Title-case it.
      return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    })
    .join("_");

  return titled.length >= 2 ? titled : null;
}

type ParsedTriple = {
  atomId: string;
  subject: string;
  subjectType: string | null;
  predicate: string;
  object: string;
  objectType: string | null;
};

function parseTriples(text: string, atomId: string): ParsedTriple[] {
  const result: ParsedTriple[] = [];
  // Typed pattern: (subject [Type], predicate, object [Type])
  // Also matches legacy untyped (subject, predicate, object) via optional [Type] groups.
  const typedPattern = /\(\s*([^,\[\]()]+?)\s*(?:\[([^\]]+)\])?\s*,\s*([^,\[\]()]+?)\s*,\s*([^,\[\]()]+?)\s*(?:\[([^\]]+)\])?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = typedPattern.exec(text)) !== null) {
    let subj = match[1].trim().replace(/^["']|["']$/g, "");
    const subjType = normalizeType(match[2]);
    let pred = match[3].trim().replace(/^["']|["']$/g, "");
    let obj = match[4].trim().replace(/^["']|["']$/g, "");
    const objType = normalizeType(match[5]);

    if (subj.length > 50 || obj.length > 50) continue;
    if (subj.length < 2 || obj.length < 2 || pred.length < 2) continue;
    pred = pred.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
    if (!pred) continue;

    // Resolve entities to canonical forms
    const resolved = resolveTripleEntities(subj, pred, obj);
    if (!resolved) continue;

    result.push({
      atomId,
      subject: resolved.subject,
      subjectType: subjType,
      predicate: resolved.predicate,
      object: resolved.object,
      objectType: objType,
    });
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
        subjectType: t.subjectType ?? undefined,
        predicate: t.predicate,
        object: t.object,
        objectType: t.objectType ?? undefined,
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
  subjectType?: string;
  predicate: string;
  object: string;
  objectType?: string;
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
    subjectType: triple.subjectType ?? null,
    predicate: triple.predicate,
    object: triple.object,
    objectType: triple.objectType ?? null,
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
): Promise<{
  entities: string[];
  entity_types: Record<string, string>;
  relations: Triple[];
}> {
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

      // Case-insensitive exact match using the `lower()` functional indexes
      // (idx_triples_subject_lower / idx_triples_object_lower). Much faster
      // than ILIKE which can't benefit from a plain btree index.
      const rows = await db
        .select()
        .from(triples)
        .where(
          and(
            eq(triples.state, "active"),
            or(
              sql`lower(${triples.subject}) = ${node}`,
              sql`lower(${triples.object}) = ${node}`,
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

  // Collect distinct entity names and resolve a single type per entity.
  // Majority vote across all mentions; ties broken by first-seen.
  const entities = new Set<string>();
  const typeVotes: Map<string, Map<string, number>> = new Map();
  for (const t of allTriples) {
    entities.add(t.subject);
    entities.add(t.object);
    if (t.subjectType) {
      const m = typeVotes.get(t.subject) ?? new Map();
      m.set(t.subjectType, (m.get(t.subjectType) ?? 0) + 1);
      typeVotes.set(t.subject, m);
    }
    if (t.objectType) {
      const m = typeVotes.get(t.object) ?? new Map();
      m.set(t.objectType, (m.get(t.objectType) ?? 0) + 1);
      typeVotes.set(t.object, m);
    }
  }
  const entity_types: Record<string, string> = {};
  for (const [name, votes] of typeVotes) {
    let best: string | null = null;
    let bestCount = 0;
    for (const [type, count] of votes) {
      if (count > bestCount) { bestCount = count; best = type; }
    }
    if (best) entity_types[name] = best;
  }

  return { entities: [...entities], entity_types, relations: allTriples };
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
            sql`lower(${triples.subject}) = ${node}`,
            sql`lower(${triples.object}) = ${node}`,
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
            and(sql`lower(${triples.subject}) = ${a}`, sql`lower(${triples.object}) = ${b}`),
            and(sql`lower(${triples.subject}) = ${b}`, sql`lower(${triples.object}) = ${a}`),
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
    subjectType: row.subjectType ?? null,
    predicate: row.predicate,
    object: row.object,
    objectType: row.objectType ?? null,
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
