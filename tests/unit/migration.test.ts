import { describe, it, expect } from "vitest";
import {
  deserializeEmbedding,
  embeddingToVector,
  parseTimestamp,
  intToBool,
  parseJsonb,
  cosineSimilarity,
} from "../../scripts/migrate-from-sqlite.js";

describe("deserializeEmbedding", () => {
  it("deserializes little-endian float32 blob correctly", () => {
    // Pack [1.0, -2.0, 0.5] as little-endian float32
    const buf = Buffer.alloc(12);
    buf.writeFloatLE(1.0, 0);
    buf.writeFloatLE(-2.0, 4);
    buf.writeFloatLE(0.5, 8);

    const result = deserializeEmbedding(buf);
    expect(result).toHaveLength(3);
    expect(result[0]).toBeCloseTo(1.0, 6);
    expect(result[1]).toBeCloseTo(-2.0, 6);
    expect(result[2]).toBeCloseTo(0.5, 6);
  });

  it("handles 1536-dim embeddings (MSAM production size)", () => {
    const dim = 1536;
    const buf = Buffer.alloc(dim * 4);
    for (let i = 0; i < dim; i++) {
      buf.writeFloatLE(i * 0.001, i * 4);
    }

    const result = deserializeEmbedding(buf);
    expect(result).toHaveLength(1536);
    expect(result[0]).toBeCloseTo(0.0, 6);
    expect(result[100]).toBeCloseTo(0.1, 4);
    expect(result[1000]).toBeCloseTo(1.0, 4);
  });

  it("preserves float32 precision through round-trip", () => {
    const original = [0.033935546875, -0.036529541015625, 0.04681396484375];
    const buf = Buffer.alloc(original.length * 4);
    for (let i = 0; i < original.length; i++) {
      buf.writeFloatLE(original[i], i * 4);
    }

    const result = deserializeEmbedding(buf);
    for (let i = 0; i < original.length; i++) {
      // Float32 has ~7 decimal digits of precision
      const f32 = Math.fround(original[i]);
      expect(result[i]).toBe(f32);
    }
  });

  it("handles empty buffer", () => {
    const result = deserializeEmbedding(Buffer.alloc(0));
    expect(result).toHaveLength(0);
  });
});

describe("embeddingToVector", () => {
  it("formats as pgvector text representation", () => {
    const result = embeddingToVector([1.0, -2.0, 0.5]);
    expect(result).toBe("[1,-2,0.5]");
  });

  it("handles empty array", () => {
    expect(embeddingToVector([])).toBe("[]");
  });

  it("preserves float precision in output", () => {
    const result = embeddingToVector([0.033935546875]);
    expect(result).toBe("[0.033935546875]");
  });
});

describe("parseTimestamp", () => {
  it("parses ISO format", () => {
    const d = parseTimestamp("2026-01-15T10:30:00Z");
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString()).toBe("2026-01-15T10:30:00.000Z");
  });

  it("parses SQLite datetime format (space-separated)", () => {
    const d = parseTimestamp("2026-01-15 10:30:00");
    expect(d).toBeInstanceOf(Date);
    expect(d!.getFullYear()).toBe(2026);
  });

  it("returns null for null/undefined", () => {
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
  });

  it("returns null for invalid dates", () => {
    expect(parseTimestamp("not-a-date")).toBeNull();
  });
});

describe("intToBool", () => {
  it("converts 1 to true", () => {
    expect(intToBool(1)).toBe(true);
  });

  it("converts 0 to false", () => {
    expect(intToBool(0)).toBe(false);
  });

  it("converts null/undefined to false", () => {
    expect(intToBool(null)).toBe(false);
    expect(intToBool(undefined)).toBe(false);
  });
});

describe("parseJsonb", () => {
  it("parses JSON object", () => {
    expect(parseJsonb('{"key":"value"}')).toEqual({ key: "value" });
  });

  it("parses JSON array", () => {
    expect(parseJsonb('["a","b"]')).toEqual(["a", "b"]);
  });

  it("returns null for null", () => {
    expect(parseJsonb(null)).toBeNull();
    expect(parseJsonb(undefined)).toBeNull();
  });

  it("returns raw string for invalid JSON", () => {
    expect(parseJsonb("not json")).toBe("not json");
  });
});

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1.0, 2.0, 3.0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 9);
  });

  it("returns -1.0 for opposite vectors", () => {
    const a = [1.0, 0.0];
    const b = [-1.0, 0.0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 9);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1.0, 0.0];
    const b = [0.0, 1.0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 9);
  });

  it("works with high-dimensional vectors", () => {
    const dim = 1536;
    const a = Array.from({ length: dim }, (_, i) => Math.sin(i));
    const b = Array.from({ length: dim }, (_, i) => Math.sin(i));
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 9);
  });
});
