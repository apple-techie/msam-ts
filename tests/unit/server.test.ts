import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock all dependencies before importing server
vi.mock("../../src/db/connection.js", () => {
  const mockDb = {
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
  return {
    getDb: () => mockDb,
    healthCheck: vi.fn().mockResolvedValue(true),
    initExtensions: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/config/index.js", () => {
  const defaultConfig = {
    api: { allowed_origins: ["http://localhost:3000"], host: "127.0.0.1", port: 3001, api_key: null },
    agents: { default_agent_id: "default", enable_sharing: true },
    context: {
      startup_identity_query: "agent identity",
      startup_user_query: "user preferences",
      startup_recent_query: "recent activity",
      startup_emotional_query: "emotional state",
      default_token_budget: 500,
      default_top_k: 10,
    },
    working_memory: { default_ttl_minutes: 120 },
    retrieval: { default_top_k: 12, confidence_sim_high: 0.45, confidence_sim_medium: 0.30, confidence_sim_low: 0.15, mmr_lambda: 0.7 },
    retrieval_v2: { enabled: true, enable_beam_search: false, enable_rewrite: false, enable_query_expansion: false, enable_triple_augment: false, enable_entity_roles: false, enable_quality_filter: false, enable_temporal: false, enable_rerank: false, enable_feedback: false, max_expansion_terms: 5 },
    decay: { protection_days: 7, active_to_fading_threshold: 0.3, fading_to_dormant_threshold: 0.1, confidence_decay_rate: 0.01, confidence_decay_grace_days: 7, confidence_floor: 0.1 },
    query_expansion: { synonyms: {} },
  };
  return {
    getConfig: vi.fn().mockReturnValue(defaultConfig),
    getConfigValue: vi.fn().mockImplementation((_section: string, _key: string, defaultValue?: unknown) => defaultValue),
    reloadConfig: vi.fn(),
    resetConfig: vi.fn(),
  };
});

vi.mock("../../src/core/atoms.js", () => ({
  storeAtom: vi.fn().mockResolvedValue("test-atom-id"),
  getAtom: vi.fn().mockResolvedValue(null),
  getAtoms: vi.fn().mockResolvedValue([]),
  getAtomStats: vi.fn().mockResolvedValue({
    totalAtoms: 100,
    activeAtoms: 80,
    byStream: { semantic: 60, episodic: 20 },
    byProfile: { standard: 80 },
    byState: { active: 80, fading: 10, dormant: 10 },
    totalAccesses: 500,
    avgActivation: 0.5,
    estActiveTokens: 10000,
  }),
  updateAtom: vi.fn().mockResolvedValue(undefined),
  deleteAtom: vi.fn().mockResolvedValue(undefined),
  storeWorkingMemory: vi.fn().mockResolvedValue("working-atom-id"),
  expireWorkingMemory: vi.fn().mockResolvedValue(0),
  recordAccess: vi.fn().mockResolvedValue(undefined),
  similaritySearch: vi.fn().mockResolvedValue([]),
  contentHash: vi.fn().mockReturnValue("abc123"),
  generateAtomId: vi.fn().mockReturnValue("test-id"),
}));

vi.mock("../../src/core/embeddings.js", () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Array(1024).fill(0)),
  getEmbeddings: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/processing/annotate.js", () => ({
  annotateContent: vi.fn().mockResolvedValue({
    topics: ["test"],
    arousal: 0.5,
    valence: 0.0,
    sourceType: "conversation",
    encodingConfidence: 0.7,
  }),
  classifyStream: vi.fn().mockReturnValue("semantic"),
  heuristicAnnotate: vi.fn(),
}));

vi.mock("../../src/retrieval/strategies.js", () => ({
  retrieve: vi.fn().mockResolvedValue({
    atoms: [],
    tier: "none",
    advisory: "No relevant memories found.",
  }),
}));

vi.mock("../../src/knowledge/triples.js", () => ({
  extractTriples: vi.fn().mockResolvedValue(2),
  graphTraverse: vi.fn().mockResolvedValue({ entities: [], relations: [] }),
  getTriples: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/knowledge/contradictions.js", () => ({
  detectContradictions: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/lifecycle/decay.js", () => ({
  runDecayCycle: vi.fn().mockResolvedValue({
    processed: 10,
    transitioned: 2,
    protected: 5,
    errors: 0,
    faded: 1,
    dormanted: 1,
    reactivated: 0,
    confidenceDecayed: 0,
  }),
}));

vi.mock("../../src/lifecycle/consolidation.js", () => ({
  runConsolidation: vi.fn().mockResolvedValue({
    clustersFound: 0,
    abstractionsCreated: 0,
    relationsCreated: 0,
    sourcesReduced: 0,
    errors: 0,
  }),
}));

vi.mock("../../src/lifecycle/forgetting.js", () => ({
  runForgetting: vi.fn().mockResolvedValue({
    candidates: [],
    forgotten: 0,
    signals: {},
    dryRun: true,
  }),
}));

vi.mock("../../src/lifecycle/prediction.js", () => ({
  predictiveRetrieve: vi.fn().mockResolvedValue({
    predicted: [],
    strategy: "none",
    confidence: 0,
  }),
}));

vi.mock("../../src/processing/subatom.js", () => ({
  compressContext: vi.fn().mockReturnValue(""),
}));

vi.mock("../../src/graph/sync.js", () => ({
  scheduleGraphSync: vi.fn(),
  cancelGraphSync: vi.fn(),
}));

vi.mock("../../src/db/schema.js", () => ({
  atoms: { id: "id", state: "state", agentId: "agent_id" },
  accessLog: { atomId: "atom_id", contributed: "contributed" },
  triples: {},
  atomTopics: {},
  atomRelations: {},
  forgettingLog: {},
  temporalPatterns: {},
  coRetrieval: {},
  vectorToDriver: vi.fn((v: number[]) => `[${v.join(",")}]`),
}));

import { buildApp } from "../../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeEach(async () => {
  delete process.env.MSAM_API_KEY;
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

// ─── API Key Validation ─────────────────────────────────────────

describe("API key validation", () => {
  it("rejects requests without API key when MSAM_API_KEY is set", async () => {
    process.env.MSAM_API_KEY = "test-secret-key";
    const securedApp = await buildApp();

    const res = await securedApp.inject({
      method: "POST",
      url: "/v1/store",
      payload: { content: "test" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toBe("Invalid API key");
    await securedApp.close();
  });

  it("accepts requests with correct API key", async () => {
    process.env.MSAM_API_KEY = "test-secret-key";
    const securedApp = await buildApp();

    const res = await securedApp.inject({
      method: "POST",
      url: "/v1/store",
      headers: { "x-api-key": "test-secret-key" },
      payload: { content: "test memory content" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().stored).toBe(true);
    await securedApp.close();
  });

  it("allows open access when MSAM_API_KEY is not set", async () => {
    delete process.env.MSAM_API_KEY;

    const res = await app.inject({
      method: "POST",
      url: "/v1/store",
      payload: { content: "test content" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().stored).toBe(true);
  });
});

// ─── Health Endpoint ────────────────────────────────────────────

describe("GET /v1/health", () => {
  it("returns correct shape", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("status", "ok");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("timestamp");
    expect(typeof body.timestamp).toBe("number");
  });
});

// ─── Store Endpoint ─────────────────────────────────────────────

describe("POST /v1/store", () => {
  it("calls storeAtom and schedules graph sync", async () => {
    const { storeAtom } = await import("../../src/core/atoms.js");
    const { scheduleGraphSync } = await import("../../src/graph/sync.js");

    const res = await app.inject({
      method: "POST",
      url: "/v1/store",
      payload: { content: "The user likes TypeScript" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stored).toBe(true);
    expect(body.atom_id).toBe("test-atom-id");
    expect(storeAtom).toHaveBeenCalled();
    expect(scheduleGraphSync).toHaveBeenCalled();
  });

  it("returns duplicate info when storeAtom returns null", async () => {
    const { storeAtom } = await import("../../src/core/atoms.js");
    (storeAtom as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await app.inject({
      method: "POST",
      url: "/v1/store",
      payload: { content: "duplicate content" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stored).toBe(false);
    expect(body.reason).toBe("duplicate content");
  });
});

// ─── Query Endpoint ─────────────────────────────────────────────

describe("POST /v1/query", () => {
  it("delegates to retrieve and returns structured response", async () => {
    const { retrieve } = await import("../../src/retrieval/strategies.js");

    const res = await app.inject({
      method: "POST",
      url: "/v1/query",
      payload: { query: "What does the user like?", mode: "task" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("query", "What does the user like?");
    expect(body).toHaveProperty("confidence_tier");
    expect(body).toHaveProperty("atoms");
    expect(body).toHaveProperty("latency_ms");
    expect(retrieve).toHaveBeenCalled();
  });
});

// ─── Decay Endpoint ─────────────────────────────────────────────

describe("POST /v1/decay", () => {
  it("acquires lock and returns decay stats", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/decay",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("processed");
    expect(body).toHaveProperty("transitioned");
    expect(body).toHaveProperty("working_expired");
  });

  it("rejects concurrent decay calls", async () => {
    const { runDecayCycle } = await import("../../src/lifecycle/decay.js");

    // Make decay take a while
    let resolveDecay: () => void;
    const decayPromise = new Promise<void>((resolve) => { resolveDecay = resolve; });
    (runDecayCycle as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => decayPromise.then(() => ({
        processed: 10, transitioned: 2, protected: 5, errors: 0,
        faded: 1, dormanted: 1, reactivated: 0, confidenceDecayed: 0,
      })),
    );

    // Start first decay
    const firstCall = app.inject({ method: "POST", url: "/v1/decay" });

    // Give it a tick to start
    await new Promise((r) => setTimeout(r, 10));

    // Second call should be rejected
    const secondRes = await app.inject({ method: "POST", url: "/v1/decay" });
    expect(secondRes.statusCode).toBe(409);
    expect(secondRes.json().detail).toContain("already in progress");

    // Clean up
    resolveDecay!();
    await firstCall;
  });
});

// ─── Stats Endpoint ─────────────────────────────────────────────

describe("GET /v1/stats", () => {
  it("returns atom statistics", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/stats" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("totalAtoms");
    expect(body).toHaveProperty("activeAtoms");
    expect(body).toHaveProperty("byStream");
    expect(body).toHaveProperty("by_agent");
  });
});
