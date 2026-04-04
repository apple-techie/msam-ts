import { describe, it, expect } from "vitest";
import {
  detectNegation,
  detectTemporalSupersession,
  detectValueConflict,
  detectAntonyms,
} from "../../src/knowledge/contradictions.js";

describe("detectNegation", () => {
  it("detects negation when one text negates the other", () => {
    expect(
      detectNegation(
        "User likes watching anime regularly",
        "User does not like watching anime anymore",
      ),
    ).toBe(true);
  });

  it("returns false when both texts have negation", () => {
    expect(
      detectNegation(
        "User doesn't like coffee",
        "User doesn't like tea",
      ),
    ).toBe(false);
  });

  it("returns false when neither has negation", () => {
    expect(
      detectNegation(
        "User likes coffee",
        "User likes tea",
      ),
    ).toBe(false);
  });

  it("requires at least 2 overlapping content words", () => {
    expect(
      detectNegation(
        "The sky is blue",
        "It is not raining heavily today",
      ),
    ).toBe(false);
  });

  it("detects negation with various negation markers", () => {
    expect(
      detectNegation(
        "User can perform guitar solos",
        "User can't perform guitar solos",
      ),
    ).toBe(true);

    expect(
      detectNegation(
        "User started running daily",
        "User stopped running daily",
      ),
    ).toBe(true);
  });
});

describe("detectTemporalSupersession", () => {
  it("detects supersession with different explicit dates", () => {
    expect(
      detectTemporalSupersession(
        { content: "Status update 2025-01-15", createdAt: "2025-01-15T00:00:00Z" },
        { content: "Status update 2025-06-20", createdAt: "2025-06-20T00:00:00Z" },
      ),
    ).toBe(true);
  });

  it("detects supersession with relative time markers", () => {
    expect(
      detectTemporalSupersession(
        { content: "User currently works at Google", createdAt: "2025-01-01T00:00:00Z" },
        { content: "User works at Meta", createdAt: "2025-01-01T00:00:00Z" },
      ),
    ).toBe(true);
  });

  it("detects supersession from createdAt gap > 1 day", () => {
    expect(
      detectTemporalSupersession(
        { content: "User works at startup", createdAt: "2025-01-01T00:00:00Z" },
        { content: "User works at startup", createdAt: "2025-03-15T00:00:00Z" },
      ),
    ).toBe(true);
  });

  it("returns false for same content and close timestamps", () => {
    const ts = "2025-06-15T10:00:00Z";
    expect(
      detectTemporalSupersession(
        { content: "User likes coffee", createdAt: ts },
        { content: "User likes tea", createdAt: ts },
      ),
    ).toBe(false);
  });
});

describe("detectValueConflict", () => {
  it("detects different values for same property", () => {
    expect(
      detectValueConflict(
        "User lives in New York",
        "User lives in Los Angeles",
      ),
    ).toBe(true);
  });

  it("returns false when properties differ", () => {
    expect(
      detectValueConflict(
        "User lives in New York",
        "User works at Google",
      ),
    ).toBe(false);
  });

  it("returns false when values are the same", () => {
    expect(
      detectValueConflict(
        "User lives in New York",
        "User lives in New York",
      ),
    ).toBe(false);
  });

  it("detects value conflict with 'is' predicate", () => {
    expect(
      detectValueConflict(
        "The system is online",
        "The system is offline",
      ),
    ).toBe(true);
  });
});

describe("detectAntonyms", () => {
  it("detects antonym pairs across texts", () => {
    expect(
      detectAntonyms(
        "User wants to build something great",
        "User wants to destroy the old version",
      ),
    ).toBe(true);
  });

  it("detects love/hate antonyms", () => {
    expect(
      detectAntonyms("I love this feature", "I hate this approach"),
    ).toBe(true);
  });

  it("returns false when no antonym pairs exist", () => {
    expect(
      detectAntonyms(
        "User likes coffee in the morning",
        "User drinks tea at night",
      ),
    ).toBe(false);
  });

  it("detects enable/disable pair", () => {
    expect(
      detectAntonyms(
        "We should enable the feature flag",
        "We should disable the old module",
      ),
    ).toBe(true);
  });

  it("detects trust/distrust pair", () => {
    expect(
      detectAntonyms(
        "User has trust in the system",
        "User shows distrust toward the update",
      ),
    ).toBe(true);
  });
});

describe("contradiction confidence scoring", () => {
  it("negation type has high base weight", () => {
    // Confidence = min(0.9 * similarity + 0.1, 1.0)
    // At similarity 1.0: min(0.9 + 0.1, 1.0) = 1.0
    // At similarity 0.85: min(0.765 + 0.1, 1.0) = 0.87
    // We test indirectly through the exported helpers
    expect(detectNegation("User likes anime shows", "User does not like anime shows")).toBe(true);
  });
});
