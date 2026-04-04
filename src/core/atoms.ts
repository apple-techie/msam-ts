import crypto from "node:crypto";
import { eq, and, sql, inArray, lt, isNotNull } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import {
  atoms,
  atomTopics,
  accessLog,
  vectorToDriver,
} from "../db/schema.js";
import type {
  AtomState,
  AtomStream,
  AtomProfile,
  SourceType,
  RetrievalResult,
  ConfidenceTier,
  RetrievalMode,
} from "./types.js";
import {
  calculateActivation,
  classifyConfidenceTier,
} from "./act-r.js";

export interface StoreAtomParams {
  content: string;
  stream?: AtomStream;
  profile?: AtomProfile;
  arousal?: number;
  valence?: number;
  topics?: string[];
  encodingConfidence?: number;
  provisional?: boolean;
  sourceType?: SourceType;
  metadata?: Record<string, unknown>;
  embedding?: number[];
  agentId?: string;
  embeddingProvider?: string;
}

export interface GetAtomsParams {
  agentId?: string;
  state?: AtomState;
  stream?: AtomStream;
  limit?: number;
}

export interface SimilaritySearchParams {
  agentId?: string;
  topK?: number;
  minSimilarity?: number;
  states?: AtomState[];
}

export interface AtomStats {
  total_atoms: number;
  active_atoms: number;
  by_stream: Record<string, number>;
  by_profile: Record<string, number>;
  by_state: Record<string, number>;
  total_accesses: number;
  avg_activation: number;
  est_active_tokens: number;
  db_size_kb: number;
}

export function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 32);
}

export function generateAtomId(content: string): string {
  const ts = new Date().toISOString();
  const raw = `${content}:${ts}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export async function storeAtom(params: StoreAtomParams): Promise<string | null> {
  const content = params.content?.trim();
  if (!content) return null;

  const db = getDb();
  const hash = contentHash(content);
  const atomId = generateAtomId(content);
  const now = new Date();

  const meta = params.metadata ?? {};
  const isPinned = Boolean(meta.pinned);
  const sessionId = (meta.session_id as string) ?? null;
  const workingExpiresAt = (meta.working_expires_at as number) ?? null;

  const topicsList = params.topics ?? [];

  try {
    await db.transaction(async (tx) => {
      await tx.insert(atoms).values({
        id: atomId,
        profile: params.profile ?? "standard",
        stream: params.stream ?? "semantic",
        content,
        contentHash: hash,
        createdAt: now,
        arousal: params.arousal ?? 0.5,
        valence: params.valence ?? 0.0,
        topics: topicsList,
        encodingConfidence: params.encodingConfidence ?? 0.7,
        provisional: params.provisional ?? false,
        sourceType: params.sourceType ?? "conversation",
        embedding: params.embedding ?? null,
        metadata: meta,
        agentId: params.agentId ?? "default",
        embeddingProvider: params.embeddingProvider ?? null,
        isPinned,
        sessionId,
        workingExpiresAt,
      });

      if (topicsList.length > 0) {
        await tx
          .insert(atomTopics)
          .values(topicsList.map((t) => ({ atomId, topic: t })))
          .onConflictDoNothing();
      }
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("duplicate key") || msg.includes("unique constraint") || msg.includes("idx_atoms_dedup")) {
      return null;
    }
    throw err;
  }

  return atomId;
}

export async function getAtom(atomId: string): Promise<typeof atoms.$inferSelect | null> {
  const db = getDb();
  const rows = await db.select().from(atoms).where(eq(atoms.id, atomId)).limit(1);
  return rows[0] ?? null;
}

export async function getAtoms(params: GetAtomsParams = {}): Promise<(typeof atoms.$inferSelect)[]> {
  const db = getDb();
  const conditions = [];

  if (params.agentId) {
    conditions.push(inArray(atoms.agentId, [params.agentId, "shared"]));
  }
  if (params.state) {
    conditions.push(eq(atoms.state, params.state));
  }
  if (params.stream) {
    conditions.push(eq(atoms.stream, params.stream));
  }

  const limit = params.limit ?? 100;

  const query = conditions.length > 0
    ? db.select().from(atoms).where(and(...conditions)).limit(limit)
    : db.select().from(atoms).limit(limit);

  return query;
}

export async function updateAtom(
  atomId: string,
  updates: Partial<typeof atoms.$inferInsert>,
): Promise<void> {
  const db = getDb();
  await db.update(atoms).set(updates).where(eq(atoms.id, atomId));
}

export async function deleteAtom(atomId: string): Promise<void> {
  const db = getDb();
  await db.update(atoms).set({ state: "tombstone" }).where(eq(atoms.id, atomId));
}

export async function similaritySearch(
  embedding: number[],
  params: SimilaritySearchParams = {},
): Promise<RetrievalResult[]> {
  const db = getDb();
  const topK = params.topK ?? 12;
  const minSimilarity = params.minSimilarity ?? 0.0;
  const states = params.states ?? ["active", "fading"];

  const vectorParam = vectorToDriver(embedding);
  const statesSql = sql.join(states.map(s => sql`${s}`), sql`, `);

  let queryStr = sql`
    SELECT *,
      1 - (embedding <=> ${vectorParam}::vector) AS similarity
    FROM atoms
    WHERE state IN (${statesSql})
      AND embedding IS NOT NULL
  `;

  if (params.agentId) {
    queryStr = sql`${queryStr} AND agent_id IN (${params.agentId}, 'shared')`;
  }

  queryStr = sql`${queryStr} ORDER BY embedding <=> ${vectorParam}::vector LIMIT ${topK * 3}`;

  const rows = await db.execute(queryStr);

  const results: RetrievalResult[] = [];

  for (const row of rows.rows) {
    const sim = Number(row.similarity);
    if (sim < minSimilarity) continue;

    const atom = rowToAtomShape(row);

    const activation = calculateActivation({
      accessCount: atom.accessCount ?? 0,
      createdAt: new Date(atom.createdAt),
      querySimilarity: sim,
      mode: "task",
      arousal: atom.arousal ?? 0.5,
      valence: atom.valence ?? 0.0,
      encodingConfidence: atom.encodingConfidence ?? 0.7,
      stability: atom.stability ?? 1.0,
      provisional: atom.provisional ?? false,
      outcomeCount: atom.outcomeCount ?? 0,
      outcomeScore: atom.outcomeScore ?? 0.0,
    });

    const tier = classifyConfidenceTier(sim, activation);

    results.push({
      atom,
      activation,
      similarity: sim,
      confidenceTier: tier,
    });
  }

  results.sort((a, b) => b.activation - a.activation);
  return results.slice(0, topK);
}

export async function recordAccess(
  atomId: string,
  activationScore: number,
  mode: string,
  agentId?: string,
): Promise<void> {
  const db = getDb();
  const now = new Date();

  await db.insert(accessLog).values({
    atomId,
    accessedAt: now,
    activationScore,
    retrievalMode: mode,
  });

  await db
    .update(atoms)
    .set({
      accessCount: sql`access_count + 1`,
      lastAccessedAt: now,
      stability: sql`LEAST(stability * 1.1, 10.0)`,
    })
    .where(eq(atoms.id, atomId));
}

export async function storeWorkingMemory(
  content: string,
  agentId: string,
  sessionId: string,
  ttlSeconds: number,
): Promise<string | null> {
  const expiresAt = Date.now() / 1000 + ttlSeconds;

  return storeAtom({
    content,
    stream: "working",
    profile: "lightweight",
    agentId,
    metadata: {
      session_id: sessionId,
      working_expires_at: expiresAt,
    },
  });
}

export async function expireWorkingMemory(): Promise<number> {
  const db = getDb();
  const nowUnix = Date.now() / 1000;

  const expired = await db
    .select({ id: atoms.id, accessCount: atoms.accessCount })
    .from(atoms)
    .where(
      and(
        eq(atoms.stream, "working"),
        eq(atoms.state, "active"),
        isNotNull(atoms.workingExpiresAt),
        lt(atoms.workingExpiresAt, nowUnix),
      ),
    );

  let count = 0;
  const PROMOTION_THRESHOLD = 3;

  for (const row of expired) {
    if ((row.accessCount ?? 0) > PROMOTION_THRESHOLD) {
      await db
        .update(atoms)
        .set({ stream: "episodic" })
        .where(eq(atoms.id, row.id));
    } else {
      await db
        .update(atoms)
        .set({ state: "tombstone" })
        .where(eq(atoms.id, row.id));
    }
    count++;
  }

  return count;
}

export async function getAtomStats(agentId?: string): Promise<AtomStats> {
  const db = getDb();

  const agentFilter = agentId
    ? sql`AND agent_id IN (${agentId}, 'shared')`
    : sql``;

  const totalResult = await db.execute(
    sql`SELECT COUNT(*) as count FROM atoms WHERE 1=1 ${agentFilter}`,
  );
  const totalRow = totalResult.rows[0];

  const activeResult = await db.execute(
    sql`SELECT COUNT(*) as count FROM atoms WHERE state = 'active' ${agentFilter}`,
  );
  const activeRow = activeResult.rows[0];

  const streamResult = await db.execute(
    sql`SELECT stream, COUNT(*) as count FROM atoms WHERE 1=1 ${agentFilter} GROUP BY stream`,
  );

  const profileResult = await db.execute(
    sql`SELECT profile, COUNT(*) as count FROM atoms WHERE 1=1 ${agentFilter} GROUP BY profile`,
  );

  const stateResult = await db.execute(
    sql`SELECT state, COUNT(*) as count FROM atoms WHERE 1=1 ${agentFilter} GROUP BY state`,
  );

  const accessResult = await db.execute(
    sql`SELECT COUNT(*) as count, AVG(activation_score) as avg FROM access_log`,
  );
  const accessRow = accessResult.rows[0];

  const tokenResult = await db.execute(
    sql`SELECT COALESCE(SUM(LENGTH(content)), 0) as chars FROM atoms WHERE state = 'active' ${agentFilter}`,
  );
  const tokenRow = tokenResult.rows[0];

  const byStream: Record<string, number> = {};
  for (const r of streamResult.rows) byStream[String(r.stream)] = Number(r.count);

  const byProfile: Record<string, number> = {};
  for (const r of profileResult.rows) byProfile[String(r.profile)] = Number(r.count);

  const byState: Record<string, number> = {};
  for (const r of stateResult.rows) byState[String(r.state)] = Number(r.count);

  const sizeResult = await db.execute(
    sql`SELECT pg_database_size(current_database()) / 1024 AS size_kb`,
  );
  const dbSizeKb = Number(sizeResult.rows[0]?.size_kb ?? 0);

  return {
    total_atoms: Number(totalRow?.count ?? 0),
    active_atoms: Number(activeRow?.count ?? 0),
    by_stream: byStream,
    by_profile: byProfile,
    by_state: byState,
    total_accesses: Number(accessRow?.count ?? 0),
    avg_activation: Number(accessRow?.avg ?? 0),
    est_active_tokens: Math.floor(Number(tokenRow?.chars ?? 0) / 4),
    db_size_kb: Math.round(dbSizeKb * 10) / 10,
  };
}

function rowToAtomShape(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    schemaVersion: Number(row.schema_version ?? 1),
    profile: String(row.profile ?? "standard") as AtomProfile,
    stream: String(row.stream ?? "semantic") as AtomStream,
    content: String(row.content ?? ""),
    contentHash: String(row.content_hash ?? ""),
    createdAt: row.created_at as unknown as Date,
    lastAccessedAt: (row.last_accessed_at as Date) ?? null,
    accessCount: Number(row.access_count ?? 0),
    stability: Number(row.stability ?? 1.0),
    retrievability: Number(row.retrievability ?? 1.0),
    arousal: Number(row.arousal ?? 0.5),
    valence: Number(row.valence ?? 0.0),
    topics: (row.topics as string[]) ?? [],
    encodingConfidence: Number(row.encoding_confidence ?? 0.7),
    provisional: Boolean(row.provisional),
    sourceType: String(row.source_type ?? "conversation") as SourceType,
    state: String(row.state ?? "active") as AtomState,
    embedding: row.embedding as number[] | null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    agentId: String(row.agent_id ?? "default"),
    embeddingProvider: row.embedding_provider as string | null,
    isPinned: Boolean(row.is_pinned),
    sessionId: (row.session_id as string) ?? null,
    workingExpiresAt: row.working_expires_at as number | null,
    outcomeScore: Number(row.outcome_score ?? 0),
    outcomeCount: Number(row.outcome_count ?? 0),
    lastOutcomeAt: (row.last_outcome_at as Date) ?? null,
  };
}
