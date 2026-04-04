import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecute = vi.fn();
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
  orderBy: vi.fn().mockReturnThis(),
  groupBy: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockResolvedValue(undefined),
  onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  execute: mockExecute,
};

vi.mock("../../src/db/connection.js", () => ({
  getDb: () => mockDb,
}));

vi.mock("../../src/db/schema.js", async () => {
  const actual = await vi.importActual("../../src/db/schema.js");
  return actual;
});

import {
  GATEWAY_MAP,
  GATEWAY_ORDER,
  EXCLUDE_AGENTS,
} from "../../src/agents/registry.js";
import {
  metricsEndpoint,
  incAtomStored,
  atomsStoredTotal,
  getRegister,
} from "../../src/metrics/instrumentation.js";

describe("agents/isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.orderBy.mockReturnThis();
    mockDb.groupBy.mockReturnThis();
    mockDb.insert.mockReturnThis();
    mockDb.values.mockResolvedValue(undefined);
    mockDb.limit.mockResolvedValue([]);
  });

  it("registerAgent returns alreadyExisted=true for existing agent", async () => {
    const { registerAgent } = await import(
      "../../src/agents/isolation.js"
    );
    mockDb.limit.mockResolvedValueOnce([
      {
        id: "agent-1",
        name: "Test Agent",
        createdAt: new Date("2026-01-01"),
        metadata: { description: "test" },
      },
    ]);

    const result = await registerAgent({ agentId: "agent-1" });
    expect(result.alreadyExisted).toBe(true);
    expect(result.id).toBe("agent-1");
  });

  it("registerAgent creates new agent when not existing", async () => {
    const { registerAgent } = await import(
      "../../src/agents/isolation.js"
    );
    mockDb.limit.mockResolvedValueOnce([]);

    const result = await registerAgent({
      agentId: "agent-new",
      name: "New Agent",
      description: "A new agent",
    });
    expect(result.alreadyExisted).toBe(false);
    expect(result.id).toBe("agent-new");
    expect(result.name).toBe("New Agent");
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("listAgents returns all agents", async () => {
    const { listAgents } = await import(
      "../../src/agents/isolation.js"
    );
    mockDb.select.mockReturnThis();
    mockDb.from.mockResolvedValueOnce([
      {
        id: "a1",
        name: "Agent 1",
        createdAt: new Date(),
        metadata: null,
      },
      {
        id: "a2",
        name: "Agent 2",
        createdAt: new Date(),
        metadata: {},
      },
    ]);

    const result = await listAgents();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("a1");
  });

  it("shareAtom throws if source atom not found", async () => {
    const { shareAtom } = await import(
      "../../src/agents/isolation.js"
    );
    mockDb.limit.mockResolvedValueOnce([]);

    await expect(
      shareAtom("nonexistent", "agent-a", "agent-b"),
    ).rejects.toThrow("not found");
  });

  it("shareAtom skips if already shared (dedup by contentHash)", async () => {
    const { shareAtom } = await import(
      "../../src/agents/isolation.js"
    );
    // Source atom found
    mockDb.limit.mockResolvedValueOnce([
      {
        id: "atom-1",
        content: "test",
        contentHash: "abc123",
        agentId: "agent-a",
        schemaVersion: 1,
        profile: "standard",
        stream: "semantic",
        stability: 1,
        retrievability: 1,
        arousal: 0.5,
        valence: 0,
        topics: [],
        encodingConfidence: 0.7,
        provisional: false,
        state: "active",
        embedding: null,
        embeddingProvider: null,
      },
    ]);
    // Already shared check: found
    mockDb.limit.mockResolvedValueOnce([{ id: "existing-shared" }]);

    await shareAtom("atom-1", "agent-a", "agent-b");
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

describe("agents/registry", () => {
  it("GATEWAY_MAP maps agent IDs to gateway labels", () => {
    expect(GATEWAY_MAP["enduru"]).toBe("Enduru (ubuntu-root + mac-studio)");
    expect(GATEWAY_MAP["main"]).toBe("Enduru (ubuntu-root)");
    expect(GATEWAY_MAP["turkules"]).toBe("Turkules (vm-1)");
  });

  it("GATEWAY_ORDER defines sorting", () => {
    expect(GATEWAY_ORDER["Enduru (ubuntu-root + mac-studio)"]).toBe(0);
    expect(GATEWAY_ORDER["Enduru (ubuntu-root)"]).toBe(1);
    expect(GATEWAY_ORDER["Turkules (vm-1)"]).toBe(2);
  });

  it("EXCLUDE_AGENTS filters stale agents", () => {
    expect(EXCLUDE_AGENTS.has("andrew")).toBe(true);
    expect(EXCLUDE_AGENTS.has("kevin")).toBe(true);
    expect(EXCLUDE_AGENTS.has("default")).toBe(true);
    expect(EXCLUDE_AGENTS.has("orchestrator")).toBe(true);
    expect(EXCLUDE_AGENTS.has("aurora")).toBe(true);
    expect(EXCLUDE_AGENTS.has("enduru")).toBe(false);
    expect(EXCLUDE_AGENTS.has("turkules")).toBe(false);
  });

  it("EXCLUDE_AGENTS does not contain active agents", () => {
    for (const agentId of Object.keys(GATEWAY_MAP)) {
      expect(EXCLUDE_AGENTS.has(agentId)).toBe(false);
    }
  });
});

describe("metrics/instrumentation", () => {
  beforeEach(async () => {
    const reg = getRegister();
    await reg.resetMetrics();
  });

  it("registers all expected metric names", async () => {
    const text = await metricsEndpoint();
    expect(text).toContain("msam_atoms_total");
    expect(text).toContain("msam_atoms_stored_total");
    expect(text).toContain("msam_retrieval_duration_seconds");
    expect(text).toContain("msam_retrieval_results_total");
    expect(text).toContain("msam_decay_transitions_total");
    expect(text).toContain("msam_embedding_duration_seconds");
    expect(text).toContain("msam_triples_total");
    expect(text).toContain("msam_api_requests_total");
    expect(text).toContain("msam_api_duration_seconds");
  });

  it("incAtomStored increments the counter", async () => {
    incAtomStored();
    incAtomStored();
    const text = await metricsEndpoint();
    expect(text).toMatch(/msam_atoms_stored_total\{.*\} 2/);
  });

  it("metricsEndpoint returns valid Prometheus format", async () => {
    const text = await metricsEndpoint();
    expect(text).toContain("# HELP");
    expect(text).toContain("# TYPE");
  });
});
