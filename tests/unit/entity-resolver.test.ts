import { describe, it, expect, beforeEach } from "vitest";
import { resolveEntity, resolveTripleEntities, addAlias, getAllAliases, resetAliasCache } from "../../src/knowledge/entity-resolver.js";

beforeEach(() => {
  resetAliasCache();
});

describe("resolveEntity", () => {
  it("resolves alias to canonical form", () => {
    expect(resolveEntity("user")).toBe("Person_One");
  });

  it("resolves case-insensitive aliases", () => {
    expect(resolveEntity("user")).toBe("Person_One");
    expect(resolveEntity("USER")).toBe("Person_One");
    expect(resolveEntity("User")).toBe("Person_One");
  });

  it("resolves social handles", () => {
    expect(resolveEntity("@person_one")).toBe("Person_One");
    expect(resolveEntity("@PersonOne")).toBe("Person_One");
    expect(resolveEntity("PersonOne")).toBe("Person_One");
  });

  it("resolves project aliases", () => {
    expect(resolveEntity("Project_Two_Long")).toBe("Project_Two");
    expect(resolveEntity("Project_One_Inc")).toBe("Project_One");
    expect(resolveEntity("MV")).toBe("Project_Three");
  });

  it("resolves infra aliases", () => {
    expect(resolveEntity("host-b")).toBe("Host_B");
    expect(resolveEntity("host-a")).toBe("Host_A");
    expect(resolveEntity("host-c")).toBe("Host_C");
  });

  it("cleans numbered list artifacts", () => {
    expect(resolveEntity("1._(user")).toBe("Person_One");
    expect(resolveEntity("12._(User")).toBe("Person_One");
    expect(resolveEntity("4. user")).toBe("Person_One");
    expect(resolveEntity("7._(user")).toBe("Person_One");
  });

  it("cleans backtick-wrapped entities", () => {
    expect(resolveEntity("`Project_One`")).toBe("Project_One");
  });

  it("skips URLs", () => {
    expect(resolveEntity("https://mv.example.com")).toBeNull();
  });

  it("skips file paths", () => {
    expect(resolveEntity("/Users/person_one/code")).toBeNull();
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
    const result = resolveTripleEntities("user", "is_founder_of", "Project_One_Inc");
    expect(result).toEqual({
      subject: "Person_One",
      predicate: "is_founder_of",
      object: "Project_One",
    });
  });

  it("returns null if subject should be skipped", () => {
    expect(resolveTripleEntities("true", "is", "something")).toBeNull();
  });

  it("returns null if object should be skipped", () => {
    expect(resolveTripleEntities("user", "uses", "42")).toBeNull();
  });

  it("returns null for self-referential triples", () => {
    expect(resolveTripleEntities("user", "is", "User")).toBeNull();
  });

  it("cleans artifacts in both subject and object", () => {
    const result = resolveTripleEntities("1._(user", "works_with", "4._(host-b");
    expect(result).toEqual({
      subject: "Person_One",
      predicate: "works_with",
      object: "Host_B",
    });
  });
});

describe("addAlias", () => {
  it("adds runtime alias", () => {
    addAlias("Person_OneP", "Person_One");
    expect(resolveEntity("Person_OneP")).toBe("Person_One");
    expect(resolveEntity("person_onep")).toBe("Person_One");
  });
});

describe("getAllAliases", () => {
  it("includes builtin aliases", () => {
    const aliases = getAllAliases();
    expect(aliases["user"]).toBe("Person_One");
    expect(aliases["project_two_long"]).toBe("Project_Two");
    expect(Object.keys(aliases).length).toBeGreaterThan(10);
  });
});
