import { describe, it, expect } from "vitest";
import { vectorToDriver, vectorFromDriver } from "../../src/db/schema.js";

describe("pgvector custom type", () => {
  describe("toDriver", () => {
    it("serializes number array to pgvector string", () => {
      expect(vectorToDriver([0.1, 0.2, 0.3])).toBe("[0.1,0.2,0.3]");
    });

    it("handles empty array", () => {
      expect(vectorToDriver([])).toBe("[]");
    });

    it("handles single element", () => {
      expect(vectorToDriver([42])).toBe("[42]");
    });

    it("preserves negative values", () => {
      expect(vectorToDriver([-0.5, 0.0, 0.5])).toBe("[-0.5,0,0.5]");
    });

    it("handles high-dimensional vectors", () => {
      const vec = Array.from({ length: 1024 }, (_, i) => i * 0.001);
      const result = vectorToDriver(vec);
      expect(result.startsWith("[")).toBe(true);
      expect(result.endsWith("]")).toBe(true);
      const parsed = result
        .replace(/[\[\]]/g, "")
        .split(",")
        .map(Number);
      expect(parsed).toHaveLength(1024);
    });
  });

  describe("fromDriver", () => {
    it("deserializes pgvector string to number array", () => {
      expect(vectorFromDriver("[0.1,0.2,0.3]")).toEqual([0.1, 0.2, 0.3]);
    });

    it("handles negative values", () => {
      expect(vectorFromDriver("[-0.5,0.0,0.5]")).toEqual([-0.5, 0.0, 0.5]);
    });

    it("handles single element", () => {
      expect(vectorFromDriver("[42]")).toEqual([42]);
    });
  });

  describe("round-trip", () => {
    it("preserves values through toDriver -> fromDriver", () => {
      const original = [0.123, -0.456, 0.789, 0.0, 1.0];
      const serialized = vectorToDriver(original);
      const deserialized = vectorFromDriver(serialized);
      expect(deserialized).toEqual(original);
    });

    it("preserves 1024-dim vector through round-trip", () => {
      const original = Array.from({ length: 1024 }, () =>
        parseFloat((Math.random() * 2 - 1).toFixed(6)),
      );
      const serialized = vectorToDriver(original);
      const deserialized = vectorFromDriver(serialized);
      expect(deserialized).toHaveLength(1024);
      for (let i = 0; i < original.length; i++) {
        expect(deserialized[i]).toBeCloseTo(original[i], 5);
      }
    });
  });
});
