import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerCommands } from "../../src/cli.js";

function buildProgram(): Command {
  const program = new Command();
  program.name("msam").exitOverride();
  registerCommands(program);
  return program;
}

describe("CLI command registration", () => {
  it("registers all 56 commands", () => {
    const program = buildProgram();
    const commandNames = program.commands.map((c) => c.name());
    expect(commandNames.length).toBe(57);
  });

  it("registers all expected command names", () => {
    const program = buildProgram();
    const commandNames = new Set(program.commands.map((c) => c.name()));

    const expected = [
      "serve", "store", "batch", "working",
      "query", "context", "hybrid", "diverse", "dry", "emotion-retrieve", "grep",
      "explain", "metamemory", "confidence", "importance", "quality", "analytics", "cache",
      "stats",
      "contradictions", "gaps", "graph", "triple-stats", "relations",
      "decay", "confidence-decay", "forgetting", "forget", "pin",
      "calibrate", "re-embed",
      "session-clear", "session-boundary", "predict",
      "feedback-mark", "feedback", "contribute", "outcomes",
      "snapshot", "export", "import", "merge", "split", "summarize", "versions",
      "migrate", "rewrite", "drift", "negative", "provenance", "associations",
      "consolidate", "replay", "world", "agreement", "emotional", "help",
    ];

    for (const name of expected) {
      expect(commandNames.has(name), `Missing command: ${name}`).toBe(true);
    }
    expect(expected.length).toBe(57);
  });
});

describe("store command", () => {
  it("accepts content argument", () => {
    const program = buildProgram();
    const storeCmd = program.commands.find((c) => c.name() === "store");
    expect(storeCmd).toBeDefined();
    expect(storeCmd!.description()).toBe("Store a new memory atom from conversation");
  });

  it("has --llm-annotate option", () => {
    const program = buildProgram();
    const storeCmd = program.commands.find((c) => c.name() === "store");
    const optNames = storeCmd!.options.map((o) => o.long);
    expect(optNames).toContain("--llm-annotate");
  });

  it("has --agent-id option", () => {
    const program = buildProgram();
    const storeCmd = program.commands.find((c) => c.name() === "store");
    const optNames = storeCmd!.options.map((o) => o.long);
    expect(optNames).toContain("--agent-id");
  });
});

describe("query command", () => {
  it("accepts query argument", () => {
    const program = buildProgram();
    const queryCmd = program.commands.find((c) => c.name() === "query");
    expect(queryCmd).toBeDefined();
    expect(queryCmd!.description()).toContain("retrieval");
  });

  it("has --mode option", () => {
    const program = buildProgram();
    const queryCmd = program.commands.find((c) => c.name() === "query");
    const optNames = queryCmd!.options.map((o) => o.long);
    expect(optNames).toContain("--mode");
  });

  it("has --top-k option", () => {
    const program = buildProgram();
    const queryCmd = program.commands.find((c) => c.name() === "query");
    const optNames = queryCmd!.options.map((o) => o.long);
    expect(optNames).toContain("--top-k");
  });

  it("has --agent-id option", () => {
    const program = buildProgram();
    const queryCmd = program.commands.find((c) => c.name() === "query");
    const optNames = queryCmd!.options.map((o) => o.long);
    expect(optNames).toContain("--agent-id");
  });
});

describe("serve command", () => {
  it("has --host option", () => {
    const program = buildProgram();
    const serveCmd = program.commands.find((c) => c.name() === "serve");
    const optNames = serveCmd!.options.map((o) => o.long);
    expect(optNames).toContain("--host");
  });

  it("has --port option", () => {
    const program = buildProgram();
    const serveCmd = program.commands.find((c) => c.name() === "serve");
    const optNames = serveCmd!.options.map((o) => o.long);
    expect(optNames).toContain("--port");
  });

  it("has default host 0.0.0.0", () => {
    const program = buildProgram();
    const serveCmd = program.commands.find((c) => c.name() === "serve");
    const hostOpt = serveCmd!.options.find((o) => o.long === "--host");
    expect(hostOpt!.defaultValue).toBe("0.0.0.0");
  });

  it("has default port 3901", () => {
    const program = buildProgram();
    const serveCmd = program.commands.find((c) => c.name() === "serve");
    const portOpt = serveCmd!.options.find((o) => o.long === "--port");
    expect(portOpt!.defaultValue).toBe("3901");
  });
});

describe("export/import commands", () => {
  it("export command exists and accepts file argument", () => {
    const program = buildProgram();
    const exportCmd = program.commands.find((c) => c.name() === "export");
    expect(exportCmd).toBeDefined();
    expect(exportCmd!.description()).toContain("Export");
  });

  it("import command exists and accepts file argument", () => {
    const program = buildProgram();
    const importCmd = program.commands.find((c) => c.name() === "import");
    expect(importCmd).toBeDefined();
    expect(importCmd!.description()).toContain("Import");
  });
});

describe("help output", () => {
  it("help command exists", () => {
    const program = buildProgram();
    const helpCmd = program.commands.find((c) => c.name() === "help");
    expect(helpCmd).toBeDefined();
  });

  it("all command groups are represented", () => {
    const program = buildProgram();
    const commandNames = program.commands.map((c) => c.name());

    // Storage group
    expect(commandNames).toContain("store");
    expect(commandNames).toContain("batch");
    expect(commandNames).toContain("working");

    // Retrieval group
    expect(commandNames).toContain("query");
    expect(commandNames).toContain("context");
    expect(commandNames).toContain("hybrid");
    expect(commandNames).toContain("diverse");
    expect(commandNames).toContain("dry");
    expect(commandNames).toContain("emotion-retrieve");
    expect(commandNames).toContain("grep");

    // Analysis group
    expect(commandNames).toContain("explain");
    expect(commandNames).toContain("metamemory");
    expect(commandNames).toContain("confidence");
    expect(commandNames).toContain("importance");
    expect(commandNames).toContain("quality");
    expect(commandNames).toContain("analytics");
    expect(commandNames).toContain("cache");
    expect(commandNames).toContain("stats");

    // Knowledge Graph group
    expect(commandNames).toContain("contradictions");
    expect(commandNames).toContain("gaps");
    expect(commandNames).toContain("graph");
    expect(commandNames).toContain("triple-stats");
    expect(commandNames).toContain("relations");

    // Lifecycle group
    expect(commandNames).toContain("decay");
    expect(commandNames).toContain("confidence-decay");
    expect(commandNames).toContain("forgetting");
    expect(commandNames).toContain("forget");
    expect(commandNames).toContain("pin");

    // Calibration group
    expect(commandNames).toContain("calibrate");
    expect(commandNames).toContain("re-embed");

    // Session group
    expect(commandNames).toContain("session-clear");
    expect(commandNames).toContain("session-boundary");
    expect(commandNames).toContain("predict");

    // Feedback group
    expect(commandNames).toContain("feedback-mark");
    expect(commandNames).toContain("feedback");
    expect(commandNames).toContain("contribute");
    expect(commandNames).toContain("outcomes");

    // Server group
    expect(commandNames).toContain("serve");

    // Maintenance group
    expect(commandNames).toContain("snapshot");
    expect(commandNames).toContain("export");
    expect(commandNames).toContain("import");
    expect(commandNames).toContain("merge");
    expect(commandNames).toContain("split");
    expect(commandNames).toContain("summarize");
    expect(commandNames).toContain("versions");
    expect(commandNames).toContain("migrate");
    expect(commandNames).toContain("rewrite");
    expect(commandNames).toContain("drift");
    expect(commandNames).toContain("negative");
    expect(commandNames).toContain("provenance");
    expect(commandNames).toContain("associations");
    expect(commandNames).toContain("consolidate");
    expect(commandNames).toContain("replay");
    expect(commandNames).toContain("world");
    expect(commandNames).toContain("agreement");
    expect(commandNames).toContain("emotional");
  });
});

describe("decay command", () => {
  it("has --agent-id option", () => {
    const program = buildProgram();
    const decayCmd = program.commands.find((c) => c.name() === "decay");
    const optNames = decayCmd!.options.map((o) => o.long);
    expect(optNames).toContain("--agent-id");
  });
});

describe("forget command", () => {
  it("has --dry-run option", () => {
    const program = buildProgram();
    const forgetCmd = program.commands.find((c) => c.name() === "forget");
    const optNames = forgetCmd!.options.map((o) => o.long);
    expect(optNames).toContain("--dry-run");
  });

  it("has --auto option", () => {
    const program = buildProgram();
    const forgetCmd = program.commands.find((c) => c.name() === "forget");
    const optNames = forgetCmd!.options.map((o) => o.long);
    expect(optNames).toContain("--auto");
  });
});

describe("predict command", () => {
  it("has --warm option", () => {
    const program = buildProgram();
    const predictCmd = program.commands.find((c) => c.name() === "predict");
    const optNames = predictCmd!.options.map((o) => o.long);
    expect(optNames).toContain("--warm");
  });

  it("has --hour option", () => {
    const program = buildProgram();
    const predictCmd = program.commands.find((c) => c.name() === "predict");
    const optNames = predictCmd!.options.map((o) => o.long);
    expect(optNames).toContain("--hour");
  });
});
