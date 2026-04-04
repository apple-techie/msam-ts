import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

import { getConfig } from "./config/index.js";
import { healthCheck } from "./db/connection.js";
import { storeAtom, getAtomStats, storeWorkingMemory, expireWorkingMemory, recordAccess, deleteAtom, getAtom, updateAtom } from "./core/atoms.js";
import { getEmbedding, configureEmbeddings } from "./core/embeddings.js";
import { annotateContent, classifyStream } from "./processing/annotate.js";
import { retrieve } from "./retrieval/strategies.js";
import { extractTriples, graphTraverse } from "./knowledge/triples.js";
import { detectContradictions } from "./knowledge/contradictions.js";
import { runDecayCycle } from "./lifecycle/decay.js";
import { runConsolidation } from "./lifecycle/consolidation.js";
import { runForgetting } from "./lifecycle/forgetting.js";
import { predictiveRetrieve } from "./lifecycle/prediction.js";
import { compressContext } from "./processing/subatom.js";
import { scheduleGraphSync } from "./graph/sync.js";
import { getDb } from "./db/connection.js";
import { atoms, accessLog } from "./db/schema.js";
import { eq, and, sql, gte, desc } from "drizzle-orm";
import {
  incAtomStored,
  observeRetrievalDuration,
  incRetrievalResult,
  incDecayTransition,
  incApiRequest,
  observeApiDuration,
  metricsEndpoint,
} from "./metrics/instrumentation.js";

// ─── Decay Lock ─────────────────────────────────────────────────

let _decayRunning = false;

// ─── Auth Hook ──────────────────────────────────────────────────

function verifyApiKey(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) {
  const apiKey = process.env.MSAM_API_KEY;
  if (!apiKey) return done();
  const provided = request.headers["x-api-key"] as string | undefined;
  if (!provided || provided.length !== apiKey.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(apiKey))) {
    reply.code(401).send({ detail: "Invalid API key" });
    return;
  }
  done();
}

// ─── Validation Sets ────────────────────────────────────────────

const VALID_STREAMS = new Set(["semantic", "episodic", "procedural", "working"]);
const VALID_PROFILES = new Set(["lightweight", "standard", "full"]);
const VALID_SOURCE_TYPES = new Set(["api", "conversation", "observation", "reflection", "system"]);

// ─── Build App ──────────────────────────────────────────────────

export async function buildApp(): Promise<FastifyInstance> {
  const config = getConfig();
  const app = Fastify({ logger: true, bodyLimit: 51200 });

  await app.register(cors, {
    origin: config.api.allowed_origins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
    allowList: (request) => {
      const path = request.url.split("?")[0];
      return path === "/v1/health" || path === "/v1/metrics";
    },
    errorResponseBuilder: () => ({
      detail: "Rate limit exceeded. Max 100 requests per minute.",
      statusCode: 429,
    }),
  });

  app.setErrorHandler((error: { statusCode?: number; message: string }, request, reply) => {
    request.log.error(error);
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      reply.code(statusCode).send({ detail: "Internal server error" });
    } else {
      reply.code(statusCode).send({ detail: error.message });
    }
  });

  // ─── Metrics Hook ──────────────────────────────────────────

  app.addHook("onResponse", (request, reply, done) => {
    incApiRequest(request.method, request.url, reply.statusCode);
    observeApiDuration(request.method, request.url, reply.elapsedTime / 1000);
    done();
  });

  // ─── GET /v1/metrics ───────────────────────────────────────

  app.get("/v1/metrics", async (_request, reply) => {
    const metrics = await metricsEndpoint();
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return metrics;
  });

  // ─── GET /v1/health ─────────────────────────────────────────

  app.get("/v1/health", async () => {
    const dbOk = await healthCheck();
    return {
      status: dbOk ? "ok" : "degraded",
      version: "2026.4.3",
      timestamp: Date.now() / 1000,
    };
  });

  // ─── POST /v1/store ─────────────────────────────────────────

  app.post<{
    Body: {
      content: string;
      stream?: string;
      profile?: string;
      use_llm_annotate?: boolean;
      source_type?: string;
      metadata?: Record<string, unknown>;
      agent_id?: string;
      embedding?: number[];
    };
  }>("/v1/store", { preHandler: verifyApiKey }, async (request, reply) => {
    const { content, stream, profile, use_llm_annotate, source_type, metadata, agent_id, embedding } = request.body;

    if (stream && !VALID_STREAMS.has(stream)) {
      return reply.code(400).send({ detail: `Invalid stream: ${stream}. Must be one of: ${[...VALID_STREAMS].join(", ")}` });
    }
    if (profile && !VALID_PROFILES.has(profile)) {
      return reply.code(400).send({ detail: `Invalid profile: ${profile}. Must be one of: ${[...VALID_PROFILES].join(", ")}` });
    }
    if (source_type && !VALID_SOURCE_TYPES.has(source_type)) {
      return reply.code(400).send({ detail: `Invalid source_type: ${source_type}. Must be one of: ${[...VALID_SOURCE_TYPES].join(", ")}` });
    }

    const annotations = await annotateContent(content, use_llm_annotate);
    const resolvedStream = stream ?? classifyStream(content);
    const resolvedProfile = profile ?? "standard";
    const resolvedAgentId = agent_id ?? config.agents.default_agent_id;

    const atomId = await storeAtom({
      content,
      stream: resolvedStream as any,
      profile: resolvedProfile as any,
      arousal: annotations.arousal,
      valence: annotations.valence,
      topics: annotations.topics,
      encodingConfidence: annotations.encodingConfidence,
      sourceType: (source_type ?? "api") as any,
      metadata: metadata ?? {},
      agentId: resolvedAgentId,
      embedding: embedding ?? undefined,
    });

    if (atomId === null) {
      return {
        stored: false,
        atom_id: null,
        stream: resolvedStream,
        profile: resolvedProfile,
        annotations,
        triples_extracted: 0,
        reason: "duplicate content",
      };
    }

    let triplesExtracted = 0;
    if (resolvedStream === "semantic") {
      try {
        triplesExtracted = await extractTriples(atomId, content);
      } catch {
        // triple extraction is best-effort
      }
    }

    scheduleGraphSync();
    incAtomStored();

    return {
      stored: true,
      atom_id: atomId,
      stream: resolvedStream,
      profile: resolvedProfile,
      annotations,
      triples_extracted: triplesExtracted,
    };
  });

  // ─── POST /v1/store-working ─────────────────────────────────

  app.post<{
    Body: {
      content: string;
      session_id: string;
      ttl_minutes?: number;
      agent_id?: string;
      source_type?: string;
      metadata?: Record<string, unknown>;
    };
  }>("/v1/store-working", { preHandler: verifyApiKey }, async (request) => {
    const { content, session_id, ttl_minutes, agent_id } = request.body;
    const ttlSeconds = (ttl_minutes ?? config.working_memory.default_ttl_minutes) * 60;
    const resolvedAgentId = agent_id ?? config.agents.default_agent_id;

    const atomId = await storeWorkingMemory(content, resolvedAgentId, session_id, ttlSeconds);
    return { stored: atomId !== null, atom_id: atomId, stream: "working" };
  });

  // ─── POST /v1/expire-working ─────────────────────────────────

  app.post("/v1/expire-working", { preHandler: verifyApiKey }, async () => {
    const count = await expireWorkingMemory();
    return { expired: count };
  });

  // ─── POST /v1/query ─────────────────────────────────────────

  app.post<{
    Body: {
      query: string;
      mode?: string;
      top_k?: number;
      token_budget?: number;
      agent_id?: string;
      stream?: string;
    };
  }>("/v1/query", { preHandler: verifyApiKey }, async (request) => {
    const { query, mode, top_k, token_budget, agent_id } = request.body;
    const topK = Math.min(top_k ?? 12, 100);

    const t0 = performance.now();

    const db = getDb();
    const result = await retrieve({
      query,
      mode: (mode ?? "task") as any,
      topK,
      agentId: agent_id,
      db: {
        async hybridRetrieve(queryEmbedding, retrievalMode, topK) {
          const { similaritySearch } = await import("./core/atoms.js");
          return (await similaritySearch(queryEmbedding, {
            agentId: agent_id,
            topK,
            states: ["active", "fading"],
          })).map((r) => ({
            atom: r.atom as any,
            similarity: r.similarity,
            combinedScore: r.activation,
            retrievalVersion: "v2",
          }));
        },
        async findTriplesByEntity(entity) {
          const { getTriples } = await import("./knowledge/triples.js");
          return getTriples({ subject: entity });
        },
        async getAtomById(id) {
          return getAtom(id) as any;
        },
        async getAtomCount() {
          const rows = await db.execute(sql`SELECT COUNT(*) as count FROM atoms WHERE state = 'active'`);
          return Number(rows.rows[0]?.count ?? 0);
        },
        async getAtomFeedback(atomId) {
          const rows = await db.execute(sql`
            SELECT COUNT(*) as total,
              SUM(CASE WHEN contributed = 1 THEN 1 ELSE 0 END) as used
            FROM access_log WHERE atom_id = ${atomId}
          `);
          const row = rows.rows[0] as any;
          return { total: Number(row?.total ?? 0), used: Number(row?.used ?? 0) };
        },
      },
      embed: getEmbedding,
    });

    const latencyMs = performance.now() - t0;
    observeRetrievalDuration(latencyMs / 1000);

    const outputAtoms = result.atoms.map((a) => ({
      id: a.atom.id,
      content: a.atom.content,
      stream: a.atom.stream ?? "semantic",
      similarity: Math.round(a.similarity * 1000) / 1000,
      score: Math.round(a.combinedScore * 1000) / 1000,
      confidence_tier: result.tier,
      topics: a.atom.topics ?? [],
    }));

    for (const _a of outputAtoms) {
      incRetrievalResult(result.tier);
    }

    const totalTokens = outputAtoms.reduce((sum, a) => sum + Math.max(1, Math.floor(a.content.length / 4)), 0);

    const response: Record<string, unknown> = {
      query,
      mode: mode ?? "task",
      confidence_tier: result.tier,
      triples: [],
      atoms: outputAtoms,
      query_type: "mixed",
      total_tokens: totalTokens,
      items_returned: outputAtoms.length,
      latency_ms: Math.round(latencyMs * 100) / 100,
      gated: true,
      gated_reason: result.advisory ?? null,
    };

    if (result.tier === "none") {
      response.confidence_advisory = "[NO_DATA] No reliable memory on this topic.";
    } else if (result.tier === "low") {
      response.confidence_advisory =
        "[LOW_CONFIDENCE] Results exist but confidence is below threshold. Treat with caution.";
    }

    return response;
  });

  // ─── POST /v1/context ───────────────────────────────────────

  app.post<{
    Body: { top_k?: number; agent_id?: string };
  }>("/v1/context", { preHandler: verifyApiKey }, async (request) => {
    const topK = Math.min(request.body?.top_k ?? 5, 50);
    const agentId = request.body?.agent_id;

    const queries = {
      identity: config.context.startup_identity_query,
      user: config.context.startup_user_query,
      recent: config.context.startup_recent_query,
      emotional: config.context.startup_emotional_query,
    };

    const dbAdapter = {
      async hybridRetrieve(queryEmbedding: number[], _mode: any, topK: number) {
        const { similaritySearch } = await import("./core/atoms.js");
        return (await similaritySearch(queryEmbedding, {
          agentId,
          topK,
          states: ["active", "fading"],
        })).map((r) => ({
          atom: r.atom as any,
          similarity: r.similarity,
          combinedScore: r.activation,
          retrievalVersion: "v2",
        }));
      },
      async findTriplesByEntity(entity: string) {
        const { getTriples } = await import("./knowledge/triples.js");
        return getTriples({ subject: entity });
      },
      async getAtomById(id: string) { return getAtom(id) as any; },
      async getAtomCount() {
        const db = getDb();
        const rows = await db.execute(sql`SELECT COUNT(*) as count FROM atoms WHERE state = 'active'`);
        return Number(rows.rows[0]?.count ?? 0);
      },
      async getAtomFeedback(atomId: string) {
        const db = getDb();
        const rows = await db.execute(sql`
          SELECT COUNT(*) as total,
            SUM(CASE WHEN contributed = 1 THEN 1 ELSE 0 END) as used
          FROM access_log WHERE atom_id = ${atomId}
        `);
        const row = rows.rows[0] as any;
        return { total: Number(row?.total ?? 0), used: Number(row?.used ?? 0) };
      },
    };

    const sectionResults = await Promise.all(
      Object.entries(queries).map(async ([name, query]) => {
        const result = await retrieve({
          query,
          mode: "task",
          topK,
          agentId,
          db: dbAdapter,
          embed: getEmbedding,
        });
        const sectionAtoms = result.atoms.map((a) => ({
          id: a.atom.id,
          content: a.atom.content,
          stream: a.atom.stream ?? "semantic",
          score: Math.round(a.combinedScore * 1000) / 1000,
        }));
        return [name, sectionAtoms] as const;
      }),
    );

    const sections = Object.fromEntries(sectionResults);
    const totalTokens = Object.values(sections).flat().reduce(
      (sum, a: any) => sum + Math.max(1, Math.floor(a.content.length / 4)),
      0,
    );

    return {
      sections,
      total_tokens: totalTokens,
      atom_count: Object.values(sections).flat().length,
    };
  });

  // ─── POST /v1/feedback ──────────────────────────────────────

  app.post<{
    Body: { atom_ids: string[]; response_text: string; feedback?: string };
  }>("/v1/feedback", { preHandler: verifyApiKey }, async (request) => {
    const { atom_ids, response_text } = request.body;
    const db = getDb();

    let marked = 0;
    for (const atomId of atom_ids) {
      const atom = await getAtom(atomId);
      if (!atom) continue;

      const contentLower = atom.content.toLowerCase();
      const responseLower = response_text.toLowerCase();
      const contributed = responseLower.includes(contentLower.slice(0, 50)) ? 1 : 0;

      await db.execute(
        sql`UPDATE access_log SET contributed = ${contributed} WHERE atom_id = ${atomId}`,
      );

      if (contributed) {
        await db.execute(sql`
          UPDATE atoms SET
            outcome_count = outcome_count + 1,
            outcome_score = outcome_score + 1.0,
            last_outcome_at = NOW()
          WHERE id = ${atomId}
        `);
      }
      marked++;
    }

    return { marked, atom_ids };
  });

  // ─── POST /v1/decay ─────────────────────────────────────────

  app.post("/v1/decay", { preHandler: verifyApiKey }, async (_request, reply) => {
    if (_decayRunning) {
      return reply.code(409).send({ detail: "Decay cycle already in progress" });
    }
    _decayRunning = true;
    try {
      const decayResult = await runDecayCycle();
      const workingExpired = await expireWorkingMemory();

      if (decayResult.faded > 0) incDecayTransition("active", "fading");
      if (decayResult.dormanted > 0) incDecayTransition("fading", "dormant");
      if (decayResult.reactivated > 0) incDecayTransition("fading", "active");

      return {
        ...decayResult,
        working_expired: workingExpired,
      };
    } finally {
      _decayRunning = false;
    }
  });

  // ─── GET /v1/stats ──────────────────────────────────────────

  app.get<{
    Querystring: { agent_id?: string };
  }>("/v1/stats", { preHandler: verifyApiKey }, async (request) => {
    const agentId = request.query.agent_id;
    const stats = await getAtomStats(agentId);

    const db = getDb();
    const agentRows = await db.execute(
      sql`SELECT agent_id, state, count(*) as count FROM atoms GROUP BY agent_id, state`,
    );

    const byAgent: Record<string, Record<string, number>> = {};
    for (const row of agentRows.rows as any[]) {
      const agent = String(row.agent_id);
      if (!byAgent[agent]) {
        byAgent[agent] = { total: 0, active: 0, fading: 0, dormant: 0, tombstone: 0 };
      }
      byAgent[agent][String(row.state)] = Number(row.count);
      byAgent[agent].total += Number(row.count);
    }

    return { ...stats, by_agent: byAgent };
  });

  // ─── POST /v1/tombstone ─────────────────────────────────────

  app.post<{
    Body: { atom_id: string };
  }>("/v1/tombstone", { preHandler: verifyApiKey }, async (request) => {
    const atom = await getAtom(request.body.atom_id);
    if (!atom) return { success: false, reason: "atom not found" };
    if (atom.state === "tombstone") return { success: true, reason: "already tombstoned" };

    await deleteAtom(request.body.atom_id);
    return { success: true, atom_id: request.body.atom_id, previous_state: atom.state };
  });

  // ─── POST /v1/triples/extract ───────────────────────────────

  app.post<{
    Body: { atom_id: string; content: string };
  }>("/v1/triples/extract", { preHandler: verifyApiKey }, async (request) => {
    const count = await extractTriples(request.body.atom_id, request.body.content);
    return { atom_id: request.body.atom_id, triples_extracted: count };
  });

  // ─── GET /v1/triples/graph/:entity ──────────────────────────

  app.get<{
    Params: { entity: string };
    Querystring: { max_hops?: string };
  }>("/v1/triples/graph/:entity", { preHandler: verifyApiKey }, async (request) => {
    const maxHops = Math.min(Number(request.query.max_hops ?? 3), 6);
    return graphTraverse(request.params.entity, maxHops);
  });

  // ─── POST /v1/contradictions ────────────────────────────────

  app.post<{
    Body: { mode?: string; threshold?: number; agent_id?: string };
  }>("/v1/contradictions", { preHandler: verifyApiKey }, async (request) => {
    const results = await detectContradictions(request.body?.agent_id);
    return { contradictions: results, count: results.length };
  });

  // ─── POST /v1/predict ──────────────────────────────────────

  app.post<{
    Body: {
      time_of_day?: string;
      day_type?: string;
      recent_topics?: string[];
      last_session_topics?: string[];
      user_active?: boolean;
      agent_id?: string;
    };
  }>("/v1/predict", { preHandler: verifyApiKey }, async (request) => {
    const agentId = request.body?.agent_id ?? config.agents.default_agent_id;
    const result = await predictiveRetrieve(agentId);
    return { predictions: result.predicted, count: result.predicted.length, strategy: result.strategy, confidence: result.confidence };
  });

  // ─── POST /v1/consolidate ──────────────────────────────────

  app.post<{
    Body: { dry_run?: boolean; max_clusters?: number; agent_id?: string };
  }>("/v1/consolidate", { preHandler: verifyApiKey }, async (request) => {
    const agentId = request.body?.agent_id;
    return runConsolidation(agentId);
  });

  // ─── POST /v1/replay ───────────────────────────────────────

  app.post<{
    Body: { topic: string; since?: string; before?: string; max_events?: number };
  }>("/v1/replay", { preHandler: verifyApiKey }, async (request) => {
    const { topic, since, before, max_events } = request.body;
    const db = getDb();

    const conditions = [
      sql`state IN ('active', 'fading')`,
      sql`stream = 'episodic'`,
    ];

    if (topic) {
      const escaped = topic.replace(/[%_\\]/g, (c) => `\\${c}`);
      conditions.push(sql`(content ILIKE ${'%' + escaped + '%'} OR ${topic} = ANY(topics))`);
    }
    if (since) {
      conditions.push(sql`created_at >= ${new Date(since)}`);
    }
    if (before) {
      conditions.push(sql`created_at < ${new Date(before)}`);
    }

    const whereClause = sql.join(conditions, sql` AND `);
    const limit = Math.min(max_events ?? 50, 200);

    const rows = await db.execute(
      sql`SELECT id, content, stream, created_at, topics FROM atoms WHERE ${whereClause} ORDER BY created_at DESC LIMIT ${limit}`,
    );

    const events = (rows.rows as any[]).map((r) => ({
      id: r.id,
      content: r.content,
      stream: r.stream,
      created_at: r.created_at,
      topics: r.topics ?? [],
    }));

    return { events, count: events.length, topic };
  });

  // ─── POST /v1/forget ───────────────────────────────────────

  app.post<{
    Body: {
      dry_run?: boolean;
      min_retrievals?: number;
      contribution_threshold?: number;
      contradiction_threshold?: number;
      confidence_floor?: number;
      grace_days?: number;
    };
  }>("/v1/forget", { preHandler: verifyApiKey }, async (request, reply) => {
    if (_decayRunning) {
      return reply.code(409).send({ detail: "Decay/forget cycle already in progress" });
    }
    _decayRunning = true;
    try {
      return await runForgetting({ dryRun: request.body?.dry_run ?? true });
    } finally {
      _decayRunning = false;
    }
  });

  // ─── POST /v1/calibrate ────────────────────────────────────

  app.post<{
    Body: { target_provider: string; queries?: string[]; top_k?: number };
  }>("/v1/calibrate", { preHandler: verifyApiKey }, async (request) => {
    // Calibration compares current embeddings vs target provider
    // Stub: return comparison structure; full implementation needs provider factory
    return {
      status: "not_implemented",
      message: "Embedding calibration requires provider hot-swap infrastructure",
      target_provider: request.body.target_provider,
    };
  });

  // ─── POST /v1/re-embed ─────────────────────────────────────

  app.post<{
    Body: { target_provider: string; batch_size?: number; dry_run?: boolean };
  }>("/v1/re-embed", { preHandler: verifyApiKey }, async (request, reply) => {
    if (_decayRunning) {
      return reply.code(409).send({ detail: "Another maintenance operation is in progress" });
    }
    _decayRunning = true;
    try {
      // Re-embedding requires provider factory + batch processing
      return {
        status: "not_implemented",
        message: "Re-embedding requires provider hot-swap infrastructure",
        target_provider: request.body.target_provider,
      };
    } finally {
      _decayRunning = false;
    }
  });

  // ─── POST /v1/agents/register ──────────────────────────────

  app.post<{
    Body: { agent_id: string; name?: string; metadata?: Record<string, unknown> };
  }>("/v1/agents/register", { preHandler: verifyApiKey }, async (request) => {
    const { agent_id, name, metadata: meta } = request.body;
    const db = getDb();

    await db.execute(sql`
      INSERT INTO agents (id, name, metadata, created_at)
      VALUES (${agent_id}, ${name ?? agent_id}, ${JSON.stringify(meta ?? {})}::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, agents.name),
        metadata = COALESCE(EXCLUDED.metadata, agents.metadata)
    `);

    return { registered: true, agent_id };
  });

  // ─── GET /v1/agents ────────────────────────────────────────

  app.get("/v1/agents", { preHandler: verifyApiKey }, async () => {
    const db = getDb();
    const rows = await db.execute(sql`SELECT id, name, metadata, created_at FROM agents ORDER BY created_at`);
    const agentList = (rows.rows as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      metadata: r.metadata ?? {},
      created_at: r.created_at,
    }));
    return { agents: agentList, count: agentList.length };
  });

  // ─── GET /v1/agents/:id/stats ──────────────────────────────

  app.get<{
    Params: { id: string };
  }>("/v1/agents/:id/stats", { preHandler: verifyApiKey }, async (request) => {
    return getAtomStats(request.params.id);
  });

  // ─── POST /v1/agents/share ─────────────────────────────────

  app.post<{
    Body: { atom_id: string; from_agent: string; to_agent: string };
  }>("/v1/agents/share", { preHandler: verifyApiKey }, async (request) => {
    const { atom_id, from_agent, to_agent } = request.body;
    const atom = await getAtom(atom_id);

    if (!atom) {
      return { shared: false, atom_id, from: from_agent, to: to_agent, reason: "atom not found" };
    }

    await updateAtom(atom_id, { agentId: "shared" } as any);
    return { shared: true, atom_id, from: from_agent, to: to_agent };
  });

  // ─── GET /v1/audit/recent ──────────────────────────────────

  app.get<{
    Querystring: { limit?: string };
  }>("/v1/audit/recent", { preHandler: verifyApiKey }, async (request) => {
    const limit = Number(request.query.limit ?? "50");
    const db = getDb();

    const oneHourAgo = new Date(Date.now() - 3_600_000);

    const storeRows = await db.execute(sql`
      SELECT id, agent_id, stream, source_type, content, created_at
      FROM atoms
      WHERE created_at >= ${oneHourAgo}
        AND state IN ('active', 'fading')
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);

    const stores = (storeRows.rows as any[]).map((r) => ({
      atom_id: r.id,
      agent_id: r.agent_id,
      stream: r.stream,
      source_type: r.source_type,
      content_preview: r.content.length > 80 ? r.content.slice(0, 80) + "..." : r.content,
      created_at: r.created_at,
    }));

    const activeResult = await db.execute(
      sql`SELECT COUNT(*) as count FROM atoms WHERE state = 'active'`,
    );
    const activeCount = Number((activeResult.rows[0] as any)?.count ?? 0);

    const tokenResult = await db.execute(
      sql`SELECT COALESCE(SUM(LENGTH(content) / 4), 0) as tokens FROM atoms WHERE state = 'active'`,
    );
    const totalTokens = Number((tokenResult.rows[0] as any)?.tokens ?? 0);

    return {
      stores,
      recalls: [],
      decay: [],
      summary: {
        stores_last_hour: stores.length,
        recalls_last_hour: 0,
        active_atoms: activeCount,
        budget_pct: Math.round((totalTokens / 100000) * 1000) / 10,
      },
    };
  });

  // ─── POST /v1/discovery/run ─────────────────────────────────

  app.post("/v1/discovery/run", { preHandler: verifyApiKey }, async (_request, reply) => {
    const crossDiscovery = config.agents.cross_discovery;
    if (!crossDiscovery.enabled) {
      return reply.code(400).send({ detail: "Cross-agent discovery is not enabled" });
    }

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      return reply.code(500).send({ detail: "DATABASE_URL not configured" });
    }

    const { runCrossAgentDiscovery } = await import("./agents/cross-discovery.js");
    const result = await runCrossAgentDiscovery(dbUrl, crossDiscovery);

    return {
      shared_entities: result.sharedEntities.length,
      cross_triples: result.crossTriples.length,
      group_stats: result.groupStats,
      entities: result.sharedEntities,
      triples: result.crossTriples,
    };
  });

  // ─── GET /v1/discovery/config ─────────────────────────────────

  app.get("/v1/discovery/config", { preHandler: verifyApiKey }, async () => {
    return config.agents.cross_discovery;
  });

  // ─── GET /v1/discovery/shared-entities ────────────────────────

  app.get("/v1/discovery/shared-entities", { preHandler: verifyApiKey }, async (_request, reply) => {
    const crossDiscovery = config.agents.cross_discovery;
    if (!crossDiscovery.enabled) {
      return reply.code(400).send({ detail: "Cross-agent discovery is not enabled" });
    }

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      return reply.code(500).send({ detail: "DATABASE_URL not configured" });
    }

    const { discoverSharedEntities } = await import("./agents/cross-discovery.js");
    const entities = await discoverSharedEntities(dbUrl, crossDiscovery);
    return { shared_entities: entities, count: entities.length };
  });

  // ─── GET /v1/discovery/groups ─────────────────────────────────

  app.get("/v1/discovery/groups", { preHandler: verifyApiKey }, async () => {
    const crossDiscovery = config.agents.cross_discovery;
    const groups = crossDiscovery.groups.map((g) => ({
      name: g.name,
      agents: g.agents,
      agent_count: g.agents.length,
    }));

    const bridges = crossDiscovery.bridges.map((b) => ({
      from: b.from,
      to: b.to,
      mode: b.mode,
    }));

    return {
      enabled: crossDiscovery.enabled,
      groups,
      bridges,
      group_count: groups.length,
      bridge_count: bridges.length,
    };
  });

  return app;
}

// ─── Start Server ───────────────────────────────────────────────

export async function startServer(opts: { host?: string; port?: number } = {}): Promise<FastifyInstance> {
  const config = getConfig();
  const host = opts.host ?? config.api.host;
  const port = opts.port ?? config.api.port;

  // Initialize embedding provider from config/env
  const embeddingProvider = (config.embedding.provider as "nvidia-nim" | "openai" | "onnx" | "local") ?? "nvidia-nim";
  const embeddingApiKey = embeddingProvider === "nvidia-nim"
    ? (process.env.NVIDIA_NIM_API_KEY ?? config.embedding.api_key ?? undefined)
    : (process.env.OPENAI_API_KEY ?? config.embedding.api_key ?? undefined);
  configureEmbeddings({
    provider: embeddingProvider,
    model: config.embedding.model,
    apiKey: embeddingApiKey,
    baseUrl: config.embedding.url,
    dimensions: config.embedding.dimensions,
  });

  const app = await buildApp();

  // Test database connectivity before accepting requests
  const dbOk = await healthCheck();
  if (!dbOk) {
    console.error("FATAL: Cannot connect to database. Check DATABASE_URL.");
    process.exit(1);
  }
  console.log("Database connection verified");

  await app.listen({ host, port });
  console.log(`MSAM REST API server listening on ${host}:${port}`);
  console.log(`  Health check: http://${host}:${port}/v1/health`);
  console.log(`  API key: ${process.env.MSAM_API_KEY ? "required" : "not required (open access)"}`);

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    const forceExit = setTimeout(() => {
      console.error("Shutdown timed out after 10s, forcing exit");
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    const { cancelGraphSync } = await import("./graph/sync.js");
    cancelGraphSync();
    await app.close();
    const { shutdown: closeDb } = await import("./db/connection.js");
    await closeDb();
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return app;
}
