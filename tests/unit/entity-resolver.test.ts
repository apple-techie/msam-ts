import { describe, it, expect, beforeEach } from "vitest";
import { resolveEntity, resolveTripleEntities, addAlias, getAllAliases, resetAliasCache } from "../../src/knowledge/entity-resolver.js";

beforeEach(() => {
  resetAliasCache();
});

describe("resolveEntity", () => {
  it("resolves Drew to Andrew_Peltekci", () => {
    expect(resolveEntity("Drew")).toBe("Andrew_Peltekci");
  });

  it("resolves case-insensitive aliases", () => {
    expect(resolveEntity("drew")).toBe("Andrew_Peltekci");
    expect(resolveEntity("DREW")).toBe("Andrew_Peltekci");
    expect(resolveEntity("user")).toBe("Andrew_Peltekci");
    expect(resolveEntity("User")).toBe("Andrew_Peltekci");
  });

  it("resolves social handles", () => {
    expect(resolveEntity("@apple_techie")).toBe("Andrew_Peltekci");
    expect(resolveEntity("@MrPeltekci")).toBe("Andrew_Peltekci");
    expect(resolveEntity("MrPeltekci")).toBe("Andrew_Peltekci");
  });

  it("resolves project aliases", () => {
    expect(resolveEntity("hydra")).toBe("HYDRA");
    expect(resolveEntity("Kainotomic_Inc")).toBe("Kainotomic");
    expect(resolveEntity("MV_Jewelry")).toBe("MV_Jewelry_Exchange");
    expect(resolveEntity("Kevin")).toBe("Sam");
  });

  it("resolves infra aliases", () => {
    expect(resolveEntity("mac-studio")).toBe("Mac_Studio");
    expect(resolveEntity("ubuntu-root")).toBe("Ubuntu_Root");
    expect(resolveEntity("vm-1")).toBe("VM_1");
  });

  it("cleans numbered list artifacts", () => {
    expect(resolveEntity("1._(Drew")).toBe("Andrew_Peltekci");
    expect(resolveEntity("12._(User")).toBe("Andrew_Peltekci");
    expect(resolveEntity("4. Andrew_Peltekci")).toBe("Andrew_Peltekci");
    expect(resolveEntity("7._(Drew")).toBe("Andrew_Peltekci");
  });

  it("cleans backtick-wrapped entities", () => {
    expect(resolveEntity("`Kainotomic`")).toBe("Kainotomic");
  });

  it("skips URLs", () => {
    expect(resolveEntity("https://mv.peltekci.com")).toBeNull();
  });

  it("skips file paths", () => {
    expect(resolveEntity("/Users/andrew/code")).toBeNull();
  });

  it("skips booleans and generics", () => {
    expect(resolveEntity("true")).toBeNull();
    expect(resolveEntity("false")).toBeNull();
    expect(resolveEntity("null")).toBeNull();
    expect(resolveEntity("42")).toBeNull();
    expect(resolveEntity("it")).toBeNull();
  });

  it("skips entities shorter than 2 chars", () => {
    expect(resolveEntity("a")).toBeNull();
    expect(resolveEntity("")).toBeNull();
  });

  it("normalizes unknown entities to Title_Case", () => {
    expect(resolveEntity("some new project")).toBe("some_new_project");
    expect(resolveEntity("My-Cool-App")).toBe("My_Cool_App");
  });

  it("strips special characters", () => {
    expect(resolveEntity("React.js")).toBe("React.js");
    expect(resolveEntity("Node (v22)")).toBe("Node_v22");
  });
});

describe("resolveTripleEntities", () => {
  it("resolves both subject and object", () => {
    const result = resolveTripleEntities("Drew", "is_founder_of", "kainotomic");
    expect(result).toEqual({
      subject: "Andrew_Peltekci",
      predicate: "is_founder_of",
      object: "Kainotomic",
    });
  });

  it("returns null if subject should be skipped", () => {
    expect(resolveTripleEntities("true", "is", "something")).toBeNull();
  });

  it("returns null if object should be skipped", () => {
    expect(resolveTripleEntities("Drew", "uses", "42")).toBeNull();
  });

  it("returns null for self-referential triples", () => {
    expect(resolveTripleEntities("Drew", "is", "User")).toBeNull();
  });

  it("cleans artifacts in both subject and object", () => {
    const result = resolveTripleEntities("1._(Drew", "works_with", "4._(Justin");
    expect(result).toEqual({
      subject: "Andrew_Peltekci",
      predicate: "works_with",
      object: "Justin",
    });
  });
});

describe("addAlias", () => {
  it("adds runtime alias", () => {
    addAlias("DrewP", "Andrew_Peltekci");
    expect(resolveEntity("DrewP")).toBe("Andrew_Peltekci");
    expect(resolveEntity("drewp")).toBe("Andrew_Peltekci");
  });
});

describe("getAllAliases", () => {
  it("includes builtin aliases", () => {
    const aliases = getAllAliases();
    expect(aliases["drew"]).toBe("Andrew_Peltekci");
    expect(aliases["hydra"]).toBe("HYDRA");
    expect(Object.keys(aliases).length).toBeGreaterThan(20);
  });
});
