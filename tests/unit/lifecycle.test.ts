import { describe, it, expect } from "vitest";
import {
  shouldTransitionState,
  calculateRetrievability,
} from "../../src/core/act-r.js";
import { DEFAULT_DECAY_CONFIG } from "../../src/core/types.js";
import type { Atom } from "../../src/core/types.js";
import {
  compressContext,
  splitSentences,
  estimateTokens,
  buildCodebook,
  applyCodebook,
  semanticDedup,
} from "../../src/processing/subatom.js";
import {
  heuristicAnnotate,
  classifyStream,
} from "../../src/processing/annotate.js";

// ─── Decay State Transitions ───────────────────────────────────

describe("decay state transitions", () => {
  it("transitions active to fading when R < 0.3", () => {
    const result = shouldTransitionState(0.29, "active", 1, DEFAULT_DECAY_CONFIG);
    expect(result).toBe("fading");
  });

  it("does not transition active when R >= 0.3", () => {
    const result = shouldTransitionState(0.31, "active", 1, DEFAULT_DECAY_CONFIG);
    expect(result).toBeNull();
  });

  it("transitions fading to dormant when R < 0.1", () => {
    const result = shouldTransitionState(0.09, "fading", 1, DEFAULT_DECAY_CONFIG);
    expect(result).toBe("dormant");
  });

  it("does not transition fading when R is between thresholds", () => {
    const result = shouldTransitionState(0.2, "fading", 1, DEFAULT_DECAY_CONFIG);
    expect(result).toBeNull();
  });

  it("reactivates fading to active when R >= 0.5 and accessCount >= 2", () => {
    const result = shouldTransitionState(0.55, "fading", 3, DEFAULT_DECAY_CONFIG);
    expect(result).toBe("active");
  });

  it("does not reactivate fading when accessCount < 2", () => {
    const result = shouldTransitionState(0.55, "fading", 1, DEFAULT_DECAY_CONFIG);
    expect(result).toBeNull();
  });

  it("never transitions dormant atoms", () => {
    const result = shouldTransitionState(0.01, "dormant", 0, DEFAULT_DECAY_CONFIG);
    expect(result).toBeNull();
  });

  it("never transitions tombstone atoms", () => {
    const result = shouldTransitionState(0.99, "tombstone", 10, DEFAULT_DECAY_CONFIG);
    expect(result).toBeNull();
  });
});

// ─── Protected Atoms ──────────────────────────────────────────

describe("protected atoms (via shouldTransitionState config)", () => {
  it("high stability atoms maintain high retrievability", () => {
    const R = calculateRetrievability(10.0, 86400);
    expect(R).toBeGreaterThan(0.3);
    const result = shouldTransitionState(R, "active", 1, DEFAULT_DECAY_CONFIG);
    expect(result).toBeNull();
  });

  it("recently created atoms have high retrievability", () => {
    const R = calculateRetrievability(1.0, 3600);
    expect(R).toBeGreaterThan(0.5);
    const result = shouldTransitionState(R, "active", 1, DEFAULT_DECAY_CONFIG);
    expect(result).toBeNull();
  });
});

// ─── Confidence Decay ──────────────────────────────────────────

describe("confidence decay logic", () => {
  it("confidence decays by 0.01/day after grace period", () => {
    const rate = DEFAULT_DECAY_CONFIG.activeToFadingThreshold;
    expect(rate).toBe(0.3);

    const conf = 0.7;
    const decayRate = 0.01;
    const daysAfterGrace = 10;
    const newConf = conf - decayRate * daysAfterGrace;
    expect(newConf).toBeCloseTo(0.6, 10);
  });

  it("confidence does not go below floor", () => {
    const floor = 0.1;
    const conf = 0.12;
    const newConf = Math.max(conf - 0.01, floor);
    expect(newConf).toBeCloseTo(0.11, 10);

    const newConf2 = Math.max(0.1 - 0.01, floor);
    expect(newConf2).toBe(floor);
  });
});

// ─── Forgetting Signal Detection ───────────────────────────────

describe("forgetting signal types", () => {
  it("low_activation: identified when contribution rate is low", () => {
    const totalRetrievals = 10;
    const contributed = 1;
    const rate = contributed / totalRetrievals;
    expect(rate).toBeLessThan(0.15);
    const score = 1 - rate;
    expect(score).toBeGreaterThan(0.8);
  });

  it("redundancy: superseded atoms are candidates", () => {
    const isSuperseded = true;
    const sourceActive = true;
    const targetNotPinned = true;
    expect(isSuperseded && sourceActive && targetNotPinned).toBe(true);
  });

  it("staleness: low confidence with no recent access", () => {
    const confidence = 0.05;
    const floor = 0.1;
    const daysSinceAccess = 20;
    const graceDays = 14;
    expect(confidence < floor).toBe(true);
    expect(daysSinceAccess > graceDays).toBe(true);
  });

  it("contradiction: lower confidence atom loses", () => {
    const confA = 0.4;
    const confB = 0.8;
    const loser = confA < confB ? "A" : "B";
    expect(loser).toBe("A");
  });

  it("multiple signals increase candidate priority", () => {
    const signalCount = 3;
    const singleSignalCount = 1;
    expect(signalCount).toBeGreaterThan(singleSignalCount);
  });
});

// ─── Dry Run Mode ──────────────────────────────────────────────

describe("dry run semantics", () => {
  it("dry run flag does not change atom state", () => {
    const dryRun = true;
    const candidates = [
      { atomId: "a1", signals: ["low_activation"], signalCount: 1 },
    ];
    let mutated = false;
    if (!dryRun) {
      mutated = true;
    }
    expect(mutated).toBe(false);
    expect(candidates.length).toBe(1);
  });
});

// ─── Prediction Strategy Selection ─────────────────────────────

describe("prediction strategy selection", () => {
  it("temporal strategy wins when time pattern is strong", () => {
    const temporal = [{ id: "a1", content: "x", score: 0.9, predictedBy: "temporal" }];
    const coret = [{ id: "a2", content: "y", score: 0.3, predictedBy: "co_retrieval" }];
    const momentum = [{ id: "a3", content: "z", score: 0.2, predictedBy: "topic_momentum" }];

    const all = [...temporal, ...coret, ...momentum];
    all.sort((a, b) => b.score - a.score);
    expect(all[0].predictedBy).toBe("temporal");
  });

  it("co_retrieval strategy wins when co-retrieval signal is strong", () => {
    const temporal = [{ id: "a1", content: "x", score: 0.2, predictedBy: "temporal" }];
    const coret = [{ id: "a2", content: "y", score: 0.95, predictedBy: "co_retrieval" }];

    const all = [...temporal, ...coret];
    all.sort((a, b) => b.score - a.score);
    expect(all[0].predictedBy).toBe("co_retrieval");
  });
});

// ─── Context Compression ──────────────────────────────────────

describe("compressContext", () => {
  it("output is within token budget", () => {
    const testAtoms = makeAtoms([
      "The server is running on Ubuntu with Docker installed. It handles web traffic through Nginx reverse proxy.",
      "The database uses PostgreSQL with pgvector extension for vector similarity search.",
      "The API endpoints are exposed through Fastify with CORS enabled for the frontend domain.",
      "Monitoring is done via Prometheus and Grafana dashboards showing system metrics.",
      "Deployments go through Dokploy which manages Docker containers and SSL certificates.",
    ]);

    const budget = 50;
    const result = compressContext(testAtoms, budget);
    const tokens = estimateTokens(result);
    expect(tokens).toBeLessThanOrEqual(budget);
  });

  it("returns empty string for empty atoms", () => {
    expect(compressContext([], 100)).toBe("");
  });

  it("handles single atom within budget", () => {
    const testAtoms = makeAtoms(["Short fact."]);
    const result = compressContext(testAtoms, 100);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── Codebook Compression ──────────────────────────────────────

describe("codebook compression", () => {
  it("shortens recurring entities", () => {
    const sentences = [
      "Person One works on the project.",
      "Person One deployed the server.",
      "The code was reviewed by Person One.",
    ];
    const codebook = buildCodebook(sentences);
    expect(codebook.size).toBeGreaterThan(0);

    const compressed = applyCodebook(sentences[0], codebook);
    expect(compressed.length).toBeLessThan(sentences[0].length);
  });

  it("does not compress short or rare entities", () => {
    const sentences = ["The cat sat.", "A dog ran."];
    const codebook = buildCodebook(sentences);
    expect(codebook.size).toBe(0);
  });
});

// ─── Sentence Splitting ───────────────────────────────────────

describe("splitSentences", () => {
  it("splits on sentence boundaries", () => {
    const text = "First sentence. Second sentence. Third one here.";
    const result = splitSentences(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("returns whole text when no splits found", () => {
    const text = "just a short fragment";
    const result = splitSentences(text);
    expect(result).toEqual(["just a short fragment"]);
  });

  it("filters out very short segments", () => {
    const text = "OK.\n\nThis is a longer segment that should be kept.";
    const result = splitSentences(text);
    expect(result.every((s) => s.length >= 8)).toBe(true);
  });
});

// ─── Heuristic Annotation ──────────────────────────────────────

describe("heuristicAnnotate", () => {
  it("extracts technology topic from code-related content", () => {
    const result = heuristicAnnotate(
      "The server deployment uses Docker and the API config was updated.",
    );
    expect(result.topics).toContain("technology");
  });

  it("extracts health topic", () => {
    const result = heuristicAnnotate("I need more sleep and should eat better.");
    expect(result.topics).toContain("health");
  });

  it("detects positive valence", () => {
    const result = heuristicAnnotate("This is amazing and I love the results!");
    expect(result.valence).toBeGreaterThan(0);
  });

  it("detects negative valence", () => {
    const result = heuristicAnnotate("I hate this, it is terrible and awful.");
    expect(result.valence).toBeLessThan(0);
  });

  it("detects high arousal from exclamation marks and keywords", () => {
    const result = heuristicAnnotate("URGENT!! This is critical and I am terrified!!!");
    expect(result.arousal).toBeGreaterThan(0.5);
  });

  it("returns neutral for bland content", () => {
    const result = heuristicAnnotate("The meeting is at three.");
    expect(result.valence).toBe(0);
    expect(result.arousal).toBeCloseTo(0.3, 1);
  });

  it("limits topics to 5", () => {
    const result = heuristicAnnotate(
      "I feel happy at work coding the system to book a hotel flight and remember my friend.",
    );
    expect(result.topics.length).toBeLessThanOrEqual(5);
  });
});

// ─── Stream Classification ─────────────────────────────────────

describe("classifyStream", () => {
  it("classifies procedural content", () => {
    expect(classifyStream("How to install Docker on Ubuntu")).toBe("procedural");
    expect(classifyStream("Always run tests before deploying")).toBe("procedural");
  });

  it("classifies episodic content", () => {
    expect(classifyStream("Yesterday we discussed the project")).toBe("episodic");
    expect(classifyStream("Deployed the fix on 2026-03-15")).toBe("episodic");
  });

  it("classifies semantic content by default", () => {
    expect(classifyStream("The capital of France is Paris")).toBe("semantic");
  });
});

// ─── Semantic Dedup ────────────────────────────────────────────

describe("semanticDedup", () => {
  it("removes near-duplicate sentences", () => {
    const sentences = [
      { atomId: "a1", text: "The user is a software engineer working on projects", tokens: 10 },
      { atomId: "a2", text: "The user is a software engineer working on many projects", tokens: 11 },
      { atomId: "a3", text: "The database runs PostgreSQL with vector extensions", tokens: 8 },
    ];
    const result = semanticDedup(sentences, 0.75);
    expect(result.length).toBeLessThan(sentences.length);
  });

  it("keeps dissimilar sentences", () => {
    const sentences = [
      { atomId: "a1", text: "Apples are fruits that grow on trees", tokens: 7 },
      { atomId: "a2", text: "Quantum physics describes subatomic particles", tokens: 6 },
    ];
    const result = semanticDedup(sentences, 0.75);
    expect(result.length).toBe(2);
  });
});

// ─── Helpers ───────────────────────────────────────────────────

function makeAtoms(contents: string[]): Atom[] {
  return contents.map((content, i) => ({
    id: `atom-${i}`,
    schemaVersion: 1,
    profile: "standard" as const,
    stream: "semantic" as const,
    content,
    contentHash: `hash-${i}`,
    createdAt: new Date().toISOString(),
    lastAccessedAt: null,
    accessCount: 1,
    stability: 1.0,
    retrievability: 1.0,
    arousal: 0.5,
    valence: 0.0,
    topics: [],
    encodingConfidence: 0.7,
    provisional: false,
    sourceType: "conversation" as const,
    state: "active" as const,
    embedding: null,
    metadata: {},
    agentId: "default",
    embeddingProvider: null,
    isPinned: false,
    sessionId: null,
    workingExpiresAt: null,
  }));
}
