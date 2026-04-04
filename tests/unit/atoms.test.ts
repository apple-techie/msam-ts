import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import { contentHash, generateAtomId } from "../../src/core/atoms.js";

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
  return { getDb: () => mockDb };
});

vi.mock("../../src/db/schema.js", async () => {
  const actual = await vi.importActual("../../src/db/schema.js");
  return actual;
});

describe("contentHash", () => {
  it("produces a deterministic 32-char hex hash", () => {
    const h1 = contentHash("hello world");
    const h2 = contentHash("hello world");
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(32);
    expect(h1).toMatch(/^[0-9a-f]{32}$/);
  });

  it("matches sha256 prefix of input", () => {
    const input = "test content";
    const expected = crypto
      .createHash("sha256")
      .update(input)
      .digest("hex")
      .slice(0, 32);
    expect(contentHash(input)).toBe(expected);
  });

  it("produces different hashes for different content", () => {
    expect(contentHash("alpha")).not.toBe(contentHash("beta"));
  });
});

describe("generateAtomId", () => {
  it("produces a 16-char hex string", () => {
    const id = generateAtomId("some content");
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces unique IDs for same content (timestamp-dependent)", async () => {
    const id1 = generateAtomId("same");
    await new Promise((r) => setTimeout(r, 2));
    const id2 = generateAtomId("same");
    expect(id1).not.toBe(id2);
  });
});

describe("storeAtom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for empty content", async () => {
    const { storeAtom } = await import("../../src/core/atoms.js");
    const result = await storeAtom({ content: "" });
    expect(result).toBeNull();
  });

  it("returns null for whitespace-only content", async () => {
    const { storeAtom } = await import("../../src/core/atoms.js");
    const result = await storeAtom({ content: "   " });
    expect(result).toBeNull();
  });

  it("returns atom ID on success", async () => {
    const { getDb } = await import("../../src/db/connection.js");
    const db = getDb();
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    });
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    });

    const { storeAtom } = await import("../../src/core/atoms.js");
    const result = await storeAtom({ content: "test atom content" });
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns null on duplicate key violation", async () => {
    const { getDb } = await import("../../src/db/connection.js");
    const db = getDb();
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({
      values: vi.fn().mockRejectedValue(new Error("duplicate key value violates unique constraint idx_atoms_dedup")),
    });

    const { storeAtom } = await import("../../src/core/atoms.js");
    const result = await storeAtom({ content: "duplicate content" });
    expect(result).toBeNull();
  });
});

describe("deleteAtom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets state to tombstone", async () => {
    const { getDb } = await import("../../src/db/connection.js");
    const db = getDb();
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue({ set: setMock });

    const { deleteAtom } = await import("../../src/core/atoms.js");
    await deleteAtom("abc123");

    expect(setMock).toHaveBeenCalledWith({ state: "tombstone" });
  });
});

describe("recordAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts access log and updates atom", async () => {
    const { getDb } = await import("../../src/db/connection.js");
    const db = getDb();

    const insertValuesMock = vi.fn().mockResolvedValue(undefined);
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({
      values: insertValuesMock,
    });

    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue({ set: setMock });

    const { recordAccess } = await import("../../src/core/atoms.js");
    await recordAccess("atom-1", 5.2, "task");

    expect(db.insert).toHaveBeenCalled();
    expect(db.update).toHaveBeenCalled();
  });
});

describe("storeWorkingMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores with working stream and lightweight profile", async () => {
    const { getDb } = await import("../../src/db/connection.js");
    const db = getDb();
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    });

    const { storeWorkingMemory } = await import("../../src/core/atoms.js");
    const result = await storeWorkingMemory(
      "temp data",
      "agent-1",
      "session-abc",
      3600,
    );
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("expireWorkingMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 when no expired atoms", async () => {
    const { getDb } = await import("../../src/db/connection.js");
    const db = getDb();
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const { expireWorkingMemory } = await import("../../src/core/atoms.js");
    const count = await expireWorkingMemory();
    expect(count).toBe(0);
  });
});

describe("getAtomStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns stats structure with expected keys", async () => {
    const { getDb } = await import("../../src/db/connection.js");
    const db = getDb();
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [{ count: 10, avg: 3.5, chars: 4000, stream: "semantic", profile: "standard", state: "active" }],
    });

    const { getAtomStats } = await import("../../src/core/atoms.js");
    const stats = await getAtomStats();

    expect(stats).toHaveProperty("totalAtoms");
    expect(stats).toHaveProperty("activeAtoms");
    expect(stats).toHaveProperty("byStream");
    expect(stats).toHaveProperty("byProfile");
    expect(stats).toHaveProperty("byState");
    expect(stats).toHaveProperty("totalAccesses");
    expect(stats).toHaveProperty("avgActivation");
    expect(stats).toHaveProperty("estActiveTokens");
  });
});

describe("similaritySearch", () => {
  it("returns empty array when no rows match", async () => {
    const { getDb } = await import("../../src/db/connection.js");
    const db = getDb();
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const { similaritySearch } = await import("../../src/core/atoms.js");
    const results = await similaritySearch([0.1, 0.2, 0.3]);
    expect(results).toEqual([]);
  });

  it("filters results below minSimilarity", async () => {
    const { getDb } = await import("../../src/db/connection.js");
    const db = getDb();
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [
        {
          id: "atom-1",
          similarity: 0.1,
          content: "low sim",
          created_at: new Date().toISOString(),
          access_count: 0,
          stability: 1.0,
          arousal: 0.5,
          valence: 0.0,
          encoding_confidence: 0.7,
          provisional: false,
          outcome_count: 0,
          outcome_score: 0,
          state: "active",
          stream: "semantic",
          profile: "standard",
          content_hash: "abc",
          topics: [],
          metadata: {},
          agent_id: "default",
        },
      ],
    });

    const { similaritySearch } = await import("../../src/core/atoms.js");
    const results = await similaritySearch([0.1, 0.2], {
      minSimilarity: 0.5,
    });
    expect(results).toHaveLength(0);
  });

  it("includes results above minSimilarity with activation scores", async () => {
    const { getDb } = await import("../../src/db/connection.js");
    const db = getDb();
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [
        {
          id: "atom-2",
          similarity: 0.8,
          content: "high sim content",
          created_at: new Date().toISOString(),
          access_count: 5,
          stability: 2.0,
          arousal: 0.5,
          valence: 0.0,
          encoding_confidence: 0.7,
          provisional: false,
          outcome_count: 0,
          outcome_score: 0,
          state: "active",
          stream: "semantic",
          profile: "standard",
          content_hash: "def",
          topics: [],
          metadata: {},
          agent_id: "default",
        },
      ],
    });

    const { similaritySearch } = await import("../../src/core/atoms.js");
    const results = await similaritySearch([0.1, 0.2], {
      minSimilarity: 0.5,
    });
    expect(results).toHaveLength(1);
    expect(results[0].similarity).toBe(0.8);
    expect(results[0].activation).toBeTypeOf("number");
    expect(results[0].confidenceTier).toBeTypeOf("string");
    expect(results[0].atom.id).toBe("atom-2");
  });

  it("respects topK limit", async () => {
    const { getDb } = await import("../../src/db/connection.js");
    const db = getDb();

    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `atom-${i}`,
      similarity: 0.9 - i * 0.01,
      content: `content ${i}`,
      created_at: new Date().toISOString(),
      access_count: 1,
      stability: 1.0,
      arousal: 0.5,
      valence: 0.0,
      encoding_confidence: 0.7,
      provisional: false,
      outcome_count: 0,
      outcome_score: 0,
      state: "active",
      stream: "semantic",
      profile: "standard",
      content_hash: `hash${i}`,
      topics: [],
      metadata: {},
      agent_id: "default",
    }));

    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ rows });

    const { similaritySearch } = await import("../../src/core/atoms.js");
    const results = await similaritySearch([0.1], { topK: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });
});
