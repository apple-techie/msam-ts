import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  sigmoidBoost,
  calculateBaseLevelActivation,
  calculateSpreadingActivation,
  calculateRetrievability,
  calculateStability,
  calculateActivation,
  shouldTransitionState,
  classifyConfidenceTier,
} from "../../src/core/act-r.js";
import { DEFAULT_DECAY_CONFIG } from "../../src/core/types.js";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 10);
  });

  it("returns -1.0 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 10);
  });

  it("returns 0.0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0.0);
  });

  it("returns 0.0 for zero-norm vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0.0);
  });

  it("computes known value for [1,2,3] vs [4,5,6]", () => {
    // dot=32, normA=sqrt(14), normB=sqrt(77)
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
    expect(cosineSimilarity([1, 2, 3], [4, 5, 6])).toBeCloseTo(expected, 10);
  });
});

describe("sigmoidBoost", () => {
  it("returns ~0.5 at midpoint", () => {
    expect(sigmoidBoost(0.35)).toBeCloseTo(0.5, 5);
  });

  it("approaches 0 for low similarity", () => {
    expect(sigmoidBoost(0.0)).toBeLessThan(0.01);
  });

  it("approaches 1 for high similarity", () => {
    expect(sigmoidBoost(0.7)).toBeGreaterThan(0.99);
  });

  it("respects custom midpoint and steepness", () => {
    expect(sigmoidBoost(0.5, 0.5, 10)).toBeCloseTo(0.5, 5);
  });
});

describe("calculateBaseLevelActivation", () => {
  it("returns 0 for zero access and very recent atom", () => {
    // ln(0+1)=0, 0.5*ln(0.01+1)~=0.005 -> ~-0.005
    const result = calculateBaseLevelActivation(0, 0.01);
    expect(result).toBeCloseTo(Math.log(1) - 0.5 * Math.log(0.01 + 1), 5);
  });

  it("increases with access count", () => {
    const low = calculateBaseLevelActivation(1, 1);
    const high = calculateBaseLevelActivation(10, 1);
    expect(high).toBeGreaterThan(low);
  });

  it("decreases with age", () => {
    const young = calculateBaseLevelActivation(5, 1);
    const old = calculateBaseLevelActivation(5, 1000);
    expect(young).toBeGreaterThan(old);
  });

  it("caps frequency at 3.0", () => {
    // e^3 ~ 20.09, so access_count=1000 would give ln(1001)~6.9 but cap at 3
    const result = calculateBaseLevelActivation(1000, 0.01);
    const capped = 3.0 - 0.5 * Math.log(0.01 + 1);
    expect(result).toBeCloseTo(capped, 5);
  });

  it("matches Python formula: min(ln(ac+1), 3.0) - 0.5*ln(age+1)", () => {
    const ac = 7;
    const age = 48;
    const expected = Math.min(Math.log(ac + 1), 3.0) - 0.5 * Math.log(age + 1);
    expect(calculateBaseLevelActivation(ac, age)).toBeCloseTo(expected, 10);
  });
});

describe("calculateSpreadingActivation", () => {
  it("computes weighted sum", () => {
    expect(calculateSpreadingActivation([2, 3], [0.5, 0.3])).toBeCloseTo(1.9, 10);
  });

  it("returns 0 for empty arrays", () => {
    expect(calculateSpreadingActivation([], [])).toBe(0);
  });

  it("throws for mismatched lengths", () => {
    expect(() => calculateSpreadingActivation([1, 2], [1])).toThrow();
  });
});

describe("calculateRetrievability", () => {
  it("returns ~1.0 at t=0", () => {
    expect(calculateRetrievability(1.0, 0)).toBeCloseTo(1.0, 2);
  });

  it("implements R(t) = e^(-t/S) with S in week-hours", () => {
    const stability = 2.0;
    const elapsedSeconds = 3600 * 24; // 24 hours
    const ageHours = 24;
    const expected = Math.exp(-ageHours / (stability * 168));
    expect(calculateRetrievability(stability, elapsedSeconds)).toBeCloseTo(expected, 10);
  });

  it("decays over time", () => {
    const r1 = calculateRetrievability(1.0, 3600); // 1 hour
    const r2 = calculateRetrievability(1.0, 3600 * 24); // 24 hours
    const r3 = calculateRetrievability(1.0, 3600 * 168); // 1 week
    expect(r1).toBeGreaterThan(r2);
    expect(r2).toBeGreaterThan(r3);
  });

  it("higher stability = slower decay", () => {
    const elapsed = 3600 * 48;
    const low = calculateRetrievability(0.5, elapsed);
    const high = calculateRetrievability(5.0, elapsed);
    expect(high).toBeGreaterThan(low);
  });

  it("returns e^(-1) at exactly one week with stability=1", () => {
    const oneWeekSeconds = 168 * 3600;
    expect(calculateRetrievability(1.0, oneWeekSeconds)).toBeCloseTo(Math.exp(-1), 5);
  });

  it("matches Python at several time points", () => {
    const cases = [
      { stability: 1.0, hours: 1 },
      { stability: 1.0, hours: 24 },
      { stability: 1.0, hours: 168 },
      { stability: 3.0, hours: 48 },
      { stability: 0.5, hours: 100 },
      { stability: 10.0, hours: 500 },
    ];
    for (const { stability, hours } of cases) {
      const expected = Math.exp(-hours / (stability * 168));
      const actual = calculateRetrievability(stability, hours * 3600);
      expect(actual).toBeCloseTo(expected, 10);
    }
  });
});

describe("calculateStability", () => {
  it("boosts by default factor 1.1", () => {
    expect(calculateStability(1.0)).toBeCloseTo(1.1, 10);
  });

  it("caps at max stability", () => {
    expect(calculateStability(9.5)).toBeCloseTo(10.0, 10);
    expect(calculateStability(10.0)).toBeCloseTo(10.0, 10);
  });

  it("uses custom boost and max", () => {
    expect(calculateStability(2.0, 1.5, 5.0)).toBeCloseTo(3.0, 10);
    expect(calculateStability(4.0, 1.5, 5.0)).toBeCloseTo(5.0, 10);
  });
});

describe("shouldTransitionState", () => {
  const cfg = DEFAULT_DECAY_CONFIG;

  it("transitions active -> fading when R < 0.3", () => {
    expect(shouldTransitionState(0.29, "active", 0, cfg)).toBe("fading");
    expect(shouldTransitionState(0.31, "active", 0, cfg)).toBeNull();
  });

  it("transitions fading -> dormant when R < 0.1", () => {
    expect(shouldTransitionState(0.09, "fading", 0, cfg)).toBe("dormant");
    expect(shouldTransitionState(0.11, "fading", 0, cfg)).toBeNull();
  });

  it("reactivates fading -> active when R >= 0.5 and access >= 2", () => {
    expect(shouldTransitionState(0.5, "fading", 2, cfg)).toBe("active");
    expect(shouldTransitionState(0.5, "fading", 1, cfg)).toBeNull();
    expect(shouldTransitionState(0.49, "fading", 2, cfg)).toBeNull();
  });

  it("returns null for dormant state", () => {
    expect(shouldTransitionState(0.01, "dormant", 0, cfg)).toBeNull();
  });

  it("returns null for tombstone state", () => {
    expect(shouldTransitionState(0.5, "tombstone", 10, cfg)).toBeNull();
  });

  it("returns null at exact threshold boundaries (active)", () => {
    expect(shouldTransitionState(0.3, "active", 0, cfg)).toBeNull();
  });

  it("returns null at exact threshold boundaries (fading->dormant)", () => {
    expect(shouldTransitionState(0.1, "fading", 0, cfg)).toBeNull();
  });
});

describe("calculateActivation", () => {
  const baseParams = {
    accessCount: 5,
    createdAt: new Date(Date.now() - 3600_000 * 24), // 24 hours ago
    querySimilarity: 0.4,
    mode: "task" as const,
    arousal: 0.5,
    valence: 0.0,
    encodingConfidence: 0.7,
    stability: 1.0,
    provisional: false,
    outcomeCount: 0,
    outcomeScore: 0,
  };

  it("produces a finite number", () => {
    const result = calculateActivation(baseParams);
    expect(Number.isFinite(result)).toBe(true);
  });

  it("similarity below threshold contributes 0", () => {
    const withLowSim = { ...baseParams, querySimilarity: 0.1 };
    const withNoSim = { ...baseParams, querySimilarity: 0.0 };
    const low = calculateActivation(withLowSim);
    const none = calculateActivation(withNoSim);
    expect(low).toBeCloseTo(none, 5);
  });

  it("companion mode boosts arousal", () => {
    const task = calculateActivation({ ...baseParams, arousal: 0.9, mode: "task" });
    const companion = calculateActivation({ ...baseParams, arousal: 0.9, mode: "companion" });
    expect(companion).toBeGreaterThan(task);
  });

  it("provisional atoms get penalty", () => {
    const normal = calculateActivation(baseParams);
    const provisional = calculateActivation({ ...baseParams, provisional: true });
    expect(normal - provisional).toBeCloseTo(0.2, 5);
  });

  it("outcome bonus applies with enough outcomes", () => {
    const noOutcome = calculateActivation(baseParams);
    const withOutcome = calculateActivation({
      ...baseParams,
      outcomeCount: 5,
      outcomeScore: 3.0,
    });
    expect(withOutcome).toBeGreaterThan(noOutcome);
  });

  it("negative outcome score reduces activation", () => {
    const positive = calculateActivation({
      ...baseParams,
      outcomeCount: 5,
      outcomeScore: 3.0,
    });
    const negative = calculateActivation({
      ...baseParams,
      outcomeCount: 5,
      outcomeScore: -3.0,
    });
    expect(positive).toBeGreaterThan(negative);
  });
});

describe("classifyConfidenceTier", () => {
  it("returns high for sim >= 0.45", () => {
    expect(classifyConfidenceTier(0.45, 0)).toBe("high");
  });

  it("returns high for score >= 40 with semantic signal", () => {
    expect(classifyConfidenceTier(0.25, 45)).toBe("high");
  });

  it("returns medium for sim >= 0.30", () => {
    expect(classifyConfidenceTier(0.30, 0)).toBe("medium");
  });

  it("returns low for sim >= 0.15", () => {
    expect(classifyConfidenceTier(0.15, 0)).toBe("low");
  });

  it("returns none for very low sim", () => {
    expect(classifyConfidenceTier(0.05, 5)).toBe("none");
  });

  it("score alone without semantic signal returns none", () => {
    // sim=0.10 < simLow=0.15, no semantic signal (< 0.20), score ignored
    expect(classifyConfidenceTier(0.10, 100)).toBe("none");
    expect(classifyConfidenceTier(0.05, 100)).toBe("none");
  });
});
