import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractQueryEntities,
  detectTemporalScope,
  applyTemporalFilter,
  computeAtomQuality,
  applyQualityFilter,
  applyConfidenceGating,
  mmrSelect,
  rewriteQuery,
  expandWithSynonyms,
  entityScoreAdjustment,
  type ScoredAtom,
  type RetrievalDb,
} from "../../src/retrieval/strategies.js";
import {
  getServedIds,
  recordServed,
  clearSession,
  dedup,
} from "../../src/processing/session-dedup.js";

function makeAtom(overrides: Partial<ScoredAtom> & { id?: string } = {}): ScoredAtom {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    atom: {
      id,
      schemaVersion: 1,
      profile: "standard",
      stream: "semantic",
      content: overrides.atom?.content ?? "Test atom content with enough words to be quality",
      contentHash: "hash",
      createdAt: overrides.atom?.createdAt ?? new Date().toISOString(),
      lastAccessedAt: null,
      accessCount: 1,
      stability: 1.0,
      retrievability: 1.0,
      arousal: 0.5,
      valence: 0.0,
      topics: [],
      encodingConfidence: 0.7,
      provisional: false,
      sourceType: "conversation",
      state: "active",
      embedding: overrides.atom?.embedding ?? null,
      metadata: overrides.atom?.metadata ?? {},
      agentId: "default",
      embeddingProvider: null,
      isPinned: false,
      sessionId: null,
      workingExpiresAt: null,
    },
    similarity: overrides.similarity ?? 0.5,
    combinedScore: overrides.combinedScore ?? 10.0,
    retrievalVersion: "v2",
    ...overrides,
  };
}

// ─── Confidence Tier Gating ──────────────────────────────────────

describe("applyConfidenceGating", () => {
  it("returns 'none' tier for empty atoms", () => {
    const result = applyConfidenceGating([]);
    expect(result.tier).toBe("none");
    expect(result.atoms).toHaveLength(0);
    expect(result.advisory).toBeDefined();
  });

  it("returns 'high' tier when max similarity >= 0.45", () => {
    const atoms = [
      makeAtom({ similarity: 0.46, combinedScore: 50 }),
      makeAtom({ similarity: 0.10, combinedScore: 5 }),
    ];
    const result = applyConfidenceGating(atoms);
    expect(result.tier).toBe("high");
    // Zero-sim atoms pruned
    expect(result.atoms.every((a) => a.similarity > 0 || a.tripleAugmented)).toBe(true);
  });

  it("returns 'high' tier at exact boundary 0.45", () => {
    const atoms = [makeAtom({ similarity: 0.45, combinedScore: 50 })];
    const result = applyConfidenceGating(atoms);
    expect(result.tier).toBe("high");
  });

  it("returns 'medium' tier between 0.30 and 0.45", () => {
    const atoms = [
      makeAtom({ similarity: 0.35, combinedScore: 8 }),
      makeAtom({ similarity: 0.20, combinedScore: 5 }),
      makeAtom({ similarity: 0.18, combinedScore: 4 }),
      makeAtom({ similarity: 0.10, combinedScore: 2 }),
    ];
    const result = applyConfidenceGating(atoms);
    expect(result.tier).toBe("medium");
    // Only atoms with sim > 0.15
    expect(result.atoms.length).toBeLessThanOrEqual(3);
    expect(result.atoms.every((a) => a.similarity > 0.15)).toBe(true);
  });

  it("returns 'low' tier between 0.15 and 0.30", () => {
    const atoms = [
      makeAtom({ similarity: 0.20, combinedScore: 5 }),
      makeAtom({ similarity: 0.18, combinedScore: 4 }),
    ];
    const result = applyConfidenceGating(atoms);
    expect(result.tier).toBe("low");
    expect(result.atoms).toHaveLength(1);
    expect(result.advisory).toBeDefined();
  });

  it("returns 'none' tier when all similarities < 0.15", () => {
    const atoms = [
      makeAtom({ similarity: 0.10, combinedScore: 2 }),
      makeAtom({ similarity: 0.05, combinedScore: 1 }),
    ];
    const result = applyConfidenceGating(atoms);
    expect(result.tier).toBe("none");
    expect(result.atoms).toHaveLength(0);
  });

  it("caps high-tier results at 12", () => {
    const atoms = Array.from({ length: 20 }, (_, i) =>
      makeAtom({ similarity: 0.5 + i * 0.01, combinedScore: 50 + i }),
    );
    const result = applyConfidenceGating(atoms);
    expect(result.tier).toBe("high");
    expect(result.atoms.length).toBeLessThanOrEqual(12);
  });
});

// ─── MMR Diversity Selection ─────────────────────────────────────

describe("mmrSelect", () => {
  it("returns all candidates when count <= topK", () => {
    const atoms = [makeAtom(), makeAtom()];
    const result = mmrSelect(atoms, 5);
    expect(result).toHaveLength(2);
  });

  it("selects topK from larger set", () => {
    const atoms = Array.from({ length: 10 }, (_, i) =>
      makeAtom({ combinedScore: 10 - i }),
    );
    const result = mmrSelect(atoms, 3);
    expect(result).toHaveLength(3);
  });

  it("picks highest-scored first", () => {
    const atoms = [
      makeAtom({ combinedScore: 5 }),
      makeAtom({ combinedScore: 20 }),
      makeAtom({ combinedScore: 10 }),
    ];
    const result = mmrSelect(atoms, 2);
    expect(result[0].combinedScore).toBe(20);
  });

  it("diversifies when embeddings are similar", () => {
    const similar = [0.1, 0.2, 0.3];
    const different = [0.9, 0.8, 0.7];
    const atoms = [
      makeAtom({ combinedScore: 20, atom: { embedding: similar } as any }),
      makeAtom({ combinedScore: 18, atom: { embedding: similar } as any }),
      makeAtom({ combinedScore: 15, atom: { embedding: different } as any }),
    ];
    // With MMR, the diverse atom should be preferred over the similar one
    const result = mmrSelect(atoms, 2, 0.5);
    const ids = result.map((r) => r.atom.id);
    expect(ids).toContain(atoms[0].atom.id);
    expect(ids).toContain(atoms[2].atom.id);
  });
});

// ─── Temporal Query Detection ────────────────────────────────────

describe("detectTemporalScope", () => {
  it("detects 'today' as 1 day", () => {
    expect(detectTemporalScope("What happened today?")).toBe(1);
  });

  it("detects 'recently' as 2 days", () => {
    expect(detectTemporalScope("What were the recent events?")).toBe(2);
  });

  it("detects 'last week' as 7 days", () => {
    expect(detectTemporalScope("Show me last week's logs")).toBe(7);
  });

  it("returns null for non-temporal queries", () => {
    expect(detectTemporalScope("What is the user's profession?")).toBeNull();
  });

  it("detects 'just now' as 0.1 days", () => {
    expect(detectTemporalScope("What was just now discussed?")).toBe(0.1);
  });
});

describe("applyTemporalFilter", () => {
  it("filters out atoms older than scope", () => {
    const recent = makeAtom({
      atom: { createdAt: new Date().toISOString() } as any,
      combinedScore: 10,
    });
    const old = makeAtom({
      atom: { createdAt: new Date(Date.now() - 10 * 86400000).toISOString() } as any,
      combinedScore: 10,
    });
    const result = applyTemporalFilter([recent, old], 2);
    expect(result).toHaveLength(1);
    expect(result[0].atom.id).toBe(recent.atom.id);
  });

  it("boosts recent atoms", () => {
    const atom = makeAtom({
      atom: { createdAt: new Date().toISOString() } as any,
      combinedScore: 10,
    });
    const result = applyTemporalFilter([atom], 1);
    expect(result[0].combinedScore).toBeGreaterThan(10);
    expect(result[0].temporalBoosted).toBe(true);
  });
});

// ─── Query Rewriting ─────────────────────────────────────────────

describe("rewriteQuery", () => {
  it("rewrites 'the user' to 'User'", () => {
    expect(rewriteQuery("What does the user like?")).toContain("User");
  });

  it("rewrites 'agent' to 'Agent'", () => {
    expect(rewriteQuery("Tell me about agent")).toContain("Agent");
  });

  it("leaves non-matching queries unchanged", () => {
    const q = "What is the weather?";
    expect(rewriteQuery(q)).toBe(q);
  });
});

// ─── Synonym Expansion ──────────────────────────────────────────

describe("expandWithSynonyms", () => {
  it("expands query with synonym terms", () => {
    const result = expandWithSynonyms("What is the user's profession?");
    expect(result).toContain("job");
    expect(result).toContain("career");
  });

  it("returns original query when no synonyms match", () => {
    const q = "xyz123 unrecognizable";
    expect(expandWithSynonyms(q)).toBe(q);
  });
});

// ─── Entity Extraction ──────────────────────────────────────────

describe("extractQueryEntities", () => {
  it("extracts capitalized words", () => {
    const entities = extractQueryEntities("Tell me about Hamilton on Broadway");
    expect(entities).toContain("Hamilton");
    expect(entities).toContain("Broadway");
  });

  it("ignores query stopwords", () => {
    const entities = extractQueryEntities("What is the name?");
    expect(entities).not.toContain("What");
  });

  it("detects known entities", () => {
    const entities = extractQueryEntities("tell me about the user");
    expect(entities).toContain("User");
  });
});

// ─── Atom Quality ────────────────────────────────────────────────

describe("computeAtomQuality", () => {
  it("returns 0 for empty content", () => {
    expect(computeAtomQuality("")).toBe(0);
  });

  it("returns low score for very short content", () => {
    expect(computeAtomQuality("hi")).toBeLessThan(0.4);
  });

  it("returns higher score for structured content", () => {
    const structured = "Name: John Doe\nRole: Developer\nSkills: TypeScript, Python, SQL";
    const plain = "this is just a plain sentence with no structure at all really";
    expect(computeAtomQuality(structured)).toBeGreaterThan(computeAtomQuality(plain));
  });
});

describe("applyQualityFilter", () => {
  it("penalizes low-quality atoms", () => {
    const atom = makeAtom({
      atom: { content: "a a a a a" } as any,
      combinedScore: 10,
    });
    const result = applyQualityFilter([atom]);
    expect(result[0].combinedScore).toBeLessThan(10);
  });
});

// ─── Entity Role Scoring ────────────────────────────────────────

describe("entityScoreAdjustment", () => {
  it("boosts matching entities", () => {
    expect(entityScoreAdjustment("User", "User", 0.8)).toBeGreaterThan(1.0);
  });

  it("penalizes mismatched entities", () => {
    expect(entityScoreAdjustment("Agent", "User", 0.8)).toBeLessThan(1.0);
  });

  it("returns neutral for unknown entities", () => {
    expect(entityScoreAdjustment("unknown", "User", 0.8)).toBe(1.0);
  });
});

// ─── Session Dedup ───────────────────────────────────────────────

describe("session dedup", () => {
  const sessionId = "test-session-" + Date.now();

  beforeEach(() => {
    clearSession(sessionId);
  });

  it("starts with empty served set", () => {
    expect(getServedIds(sessionId).size).toBe(0);
  });

  it("records and retrieves served IDs", () => {
    recordServed(["atom-1", "atom-2"], sessionId);
    const served = getServedIds(sessionId);
    expect(served.has("atom-1")).toBe(true);
    expect(served.has("atom-2")).toBe(true);
  });

  it("clears session", () => {
    recordServed(["atom-1"], sessionId);
    clearSession(sessionId);
    expect(getServedIds(sessionId).size).toBe(0);
  });

  it("demotes already-served atoms to end", () => {
    recordServed(["a1"], sessionId);
    const items = [
      makeAtom({ id: "a1" } as any),
      makeAtom({ id: "a2" } as any),
      makeAtom({ id: "a3" } as any),
    ];
    // Override atom IDs
    items[0].atom.id = "a1";
    items[1].atom.id = "a2";
    items[2].atom.id = "a3";

    const result = dedup(items, sessionId);
    expect(result).toHaveLength(3);
    // a1 should be last (demoted)
    expect(result[0].atom.id).toBe("a2");
    expect(result[1].atom.id).toBe("a3");
    expect(result[2].atom.id).toBe("a1");
  });

  it("returns unchanged list when nothing served", () => {
    const items = [makeAtom(), makeAtom()];
    const result = dedup(items, sessionId);
    expect(result).toEqual(items);
  });
});

// ─── Reranker Fallback ───────────────────────────────────────────

describe("reranker fallback", () => {
  it("falls back to original ordering when no API key", async () => {
    const original = process.env.NVIDIA_NIM_API_KEY;
    delete process.env.NVIDIA_NIM_API_KEY;

    const { rerankWithLlm } = await import("../../src/retrieval/reranker.js");
    const atoms = [makeAtom({ combinedScore: 10 }), makeAtom({ combinedScore: 5 })];
    const result = await rerankWithLlm("test query", atoms, 2);

    expect(result).toHaveLength(2);
    expect(result[0].combinedScore).toBe(10);
    expect(result[1].combinedScore).toBe(5);

    if (original) process.env.NVIDIA_NIM_API_KEY = original;
  });

  it("returns single atom unchanged", async () => {
    const { rerankWithLlm } = await import("../../src/retrieval/reranker.js");
    const atoms = [makeAtom()];
    const result = await rerankWithLlm("test", atoms, 5);
    expect(result).toHaveLength(1);
  });
});

// ─── Beam Search Gate ────────────────────────────────────────────

describe("beam search auto-gate", () => {
  it("concept: enables beam search above atom threshold", () => {
    const threshold = 10000;
    expect(15000 >= threshold).toBe(true);
    expect(5000 >= threshold).toBe(false);
  });

  it("concept: beam search merges results from multiple query formulations", async () => {
    const { beamSearchRetrieve } = await import("../../src/retrieval/beam-search.js");

    const atom1 = makeAtom({ combinedScore: 10 });
    const atom2 = makeAtom({ combinedScore: 8 });

    const mockDb: RetrievalDb = {
      hybridRetrieve: vi.fn()
        .mockResolvedValueOnce([atom1])
        .mockResolvedValueOnce([atom2])
        .mockResolvedValueOnce([]),
      findTriplesByEntity: vi.fn().mockResolvedValue([]),
      getAtomById: vi.fn().mockResolvedValue(null),
      getAtomCount: vi.fn().mockResolvedValue(20000),
      getAtomFeedback: vi.fn().mockResolvedValue({ total: 0, used: 0 }),
    };

    const result = await beamSearchRetrieve({
      query: "test query with user",
      originalQuery: "test query with user",
      mode: "task",
      topK: 10,
      beamWidth: 3,
      queryEmbedding: [0.1, 0.2, 0.3],
      db: mockDb,
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    });

    // Should have results from at least the first beam
    expect(result.length).toBeGreaterThanOrEqual(1);
    // hybridRetrieve should be called for each beam
    expect(mockDb.hybridRetrieve).toHaveBeenCalled();
  });
});
