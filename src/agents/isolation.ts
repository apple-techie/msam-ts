import { eq, and, sql, count } from "drizzle-orm";
import crypto from "node:crypto";
import { getDb } from "../db/connection.js";
import { atoms, agents } from "../db/schema.js";

export interface AgentInfo {
  id: string;
  name: string | null;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
  alreadyExisted: boolean;
}

export interface AgentStats {
  agentId: string;
  totalAtoms: number;
  activeAtoms: number;
  streams: Record<string, number>;
  sharedAtoms: number;
  lastActivity: Date | null;
  topTopics: string[];
}

export async function registerAgent(params: {
  agentId: string;
  name?: string;
  description?: string;
}): Promise<AgentInfo> {
  const db = getDb();
  const now = new Date();
  const meta = params.description ? { description: params.description } : {};

  const existing = await db
    .select()
    .from(agents)
    .where(eq(agents.id, params.agentId))
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0];
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      metadata: row.metadata as Record<string, unknown> | null,
      alreadyExisted: true,
    };
  }

  await db.insert(agents).values({
    id: params.agentId,
    name: params.name ?? params.agentId,
    createdAt: now,
    metadata: meta,
  });

  return {
    id: params.agentId,
    name: params.name ?? params.agentId,
    createdAt: now,
    metadata: meta,
    alreadyExisted: false,
  };
}

export async function listAgents(): Promise<AgentInfo[]> {
  const db = getDb();
  const rows = await db.select().from(agents);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    metadata: r.metadata as Record<string, unknown> | null,
    alreadyExisted: true,
  }));
}

export async function getAgentStats(agentId: string): Promise<AgentStats> {
  const db = getDb();

  const [totalResult] = await db
    .select({ count: count() })
    .from(atoms)
    .where(eq(atoms.agentId, agentId));

  const [activeResult] = await db
    .select({ count: count() })
    .from(atoms)
    .where(and(eq(atoms.agentId, agentId), eq(atoms.state, "active")));

  const streamRows = await db
    .select({
      stream: atoms.stream,
      count: count(),
    })
    .from(atoms)
    .where(eq(atoms.agentId, agentId))
    .groupBy(atoms.stream);

  const streams: Record<string, number> = {};
  for (const row of streamRows) {
    if (row.stream) streams[row.stream] = row.count;
  }

  const [sharedResult] = await db
    .select({ count: count() })
    .from(atoms)
    .where(and(eq(atoms.agentId, agentId), eq(atoms.sourceType, "shared")));

  const lastActivityRows = await db
    .select({ lastAccessed: atoms.lastAccessedAt })
    .from(atoms)
    .where(eq(atoms.agentId, agentId))
    .orderBy(sql`${atoms.lastAccessedAt} DESC NULLS LAST`)
    .limit(1);

  const lastActivity = lastActivityRows[0]?.lastAccessed ?? null;

  const topicRows = await db
    .select({ topics: atoms.topics })
    .from(atoms)
    .where(and(eq(atoms.agentId, agentId), eq(atoms.state, "active")))
    .limit(100);

  const topicCounts = new Map<string, number>();
  for (const row of topicRows) {
    const topics = (row.topics ?? []) as string[];
    for (const t of topics) {
      topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
    }
  }
  const topTopics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([t]) => t);

  return {
    agentId,
    totalAtoms: totalResult.count,
    activeAtoms: activeResult.count,
    streams,
    sharedAtoms: sharedResult.count,
    lastActivity,
    topTopics,
  };
}

export async function shareAtom(
  atomId: string,
  fromAgent: string,
  toAgent: string,
): Promise<void> {
  const db = getDb();

  const [source] = await db
    .select()
    .from(atoms)
    .where(and(eq(atoms.id, atomId), eq(atoms.agentId, fromAgent)))
    .limit(1);

  if (!source) {
    throw new Error(
      `Atom ${atomId} not found for agent ${fromAgent}`,
    );
  }

  const [existing] = await db
    .select({ id: atoms.id })
    .from(atoms)
    .where(
      and(eq(atoms.contentHash, source.contentHash), eq(atoms.agentId, toAgent)),
    )
    .limit(1);

  if (existing) return;

  const now = new Date();
  const newId = crypto
    .createHash("sha256")
    .update(`${source.content}${toAgent}${now.toISOString()}`)
    .digest("hex")
    .slice(0, 16);

  await db.insert(atoms).values({
    id: newId,
    schemaVersion: source.schemaVersion,
    profile: source.profile,
    stream: source.stream,
    content: source.content,
    contentHash: source.contentHash,
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    stability: source.stability,
    retrievability: source.retrievability,
    arousal: source.arousal,
    valence: source.valence,
    topics: source.topics,
    encodingConfidence: source.encodingConfidence,
    provisional: source.provisional,
    sourceType: "shared" as const,
    state: source.state,
    embedding: source.embedding,
    metadata: { shared_from: fromAgent, original_atom_id: atomId },
    agentId: toAgent,
    embeddingProvider: source.embeddingProvider,
  });
}
