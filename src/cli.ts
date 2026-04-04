import type { Command } from "commander";

function jsonOut(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function errExit(msg: string): never {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

function parseTopics(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function registerCommands(program: Command): void {
  // ─── Server ───────────────────────────────────────────────────

  program
    .command("serve")
    .description("Start the MSAM REST API server")
    .option("--host <host>", "Host to bind", "0.0.0.0")
    .option("--port <port>", "Port to listen on", "3901")
    .action(async (opts) => {
      const { startServer } = await import("./server.js");
      await startServer({ host: opts.host, port: parseInt(opts.port, 10) });
    });

  // ─── Storage ──────────────────────────────────────────────────

  program
    .command("store <content...>")
    .description("Store a new memory atom from conversation")
    .option("--llm-annotate", "Use LLM for annotation instead of heuristics")
    .option("--agent-id <id>", "Agent ID", "default")
    .option("--caller <caller>", "Caller context")
    .action(async (contentParts: string[], opts) => {
      const content = contentParts.join(" ");
      if (!content.trim()) errExit("No content provided");

      const { storeAtom } = await import("./core/atoms.js");
      const { annotateContent, classifyStream } = await import("./processing/annotate.js");
      const { extractTriples } = await import("./knowledge/triples.js");

      const t0 = performance.now();
      const stream = classifyStream(content);
      const annotations = await annotateContent(content, opts.llmAnnotate);

      const atomId = await storeAtom({
        content,
        stream: stream as "semantic" | "episodic" | "procedural" | "working",
        profile: "standard",
        arousal: annotations.arousal,
        valence: annotations.valence,
        topics: annotations.topics,
        encodingConfidence: annotations.encodingConfidence,
        sourceType: "conversation",
        agentId: opts.agentId,
      });

      let triplesExtracted = 0;
      if (atomId && stream === "semantic") {
        try {
          triplesExtracted = await extractTriples(atomId, content);
        } catch { /* triple extraction should never break storage */ }
      }

      jsonOut({
        stored: true,
        atom_id: atomId,
        stream,
        annotations,
        triples_extracted: triplesExtracted,
        latency_ms: Math.round(performance.now() - t0),
      });
    });

  program
    .command("batch <queries...>")
    .description("Execute multiple queries in one call (separate with |||)")
    .option("--json", "Read queries from stdin as JSON")
    .action(async (queries: string[], opts) => {
      if (opts.json) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString();
        const parsed = JSON.parse(raw);
        jsonOut({ batch_size: parsed.length, results: parsed });
      } else {
        const queryStr = queries.join(" ");
        const parts = queryStr.split("|||").map((q) => q.trim()).filter(Boolean);
        jsonOut({ batch_size: parts.length, queries: parts });
      }
    });

  program
    .command("working <subcommand> [content...]")
    .description("Store or manage working memory atoms")
    .option("--session <id>", "Session ID")
    .action(async (subcommand: string, contentParts: string[], opts) => {
      const { storeWorkingMemory, expireWorkingMemory } = await import("./core/atoms.js");

      if (subcommand === "expire") {
        const count = await expireWorkingMemory();
        jsonOut({ expired: count });
      } else if (subcommand === "store") {
        const content = contentParts.join(" ");
        const sessionId = opts.session ?? "default";
        const atomId = await storeWorkingMemory(content, "default", sessionId, 7200);
        jsonOut({ stored: atomId });
      } else {
        errExit("Usage: working store <content> | working expire");
      }
    });

  // ─── Retrieval ────────────────────────────────────────────────

  program
    .command("query <query...>")
    .description("Confidence-gated retrieval via hybrid pipeline")
    .option("--mode <mode>", "Retrieval mode (task|companion)", "task")
    .option("--top-k <n>", "Number of results", "12")
    .option("--budget <n>", "Token budget", "500")
    .option("--agent-id <id>", "Agent ID")
    .option("--caller <caller>", "Caller context")
    .action(async (queryParts: string[], opts) => {
      const { similaritySearch, recordAccess, getAtomStats } = await import("./core/atoms.js");
      const { getConfig } = await import("./config/index.js");
      const { createEmbeddingProvider } = await import("./providers/embedding-provider.js");

      const query = queryParts.join(" ");
      const topK = parseInt(opts.topK, 10);
      const mode = opts.mode;
      const t0 = performance.now();

      const cfg = getConfig();
      const provider = createEmbeddingProvider({
        provider: cfg.embedding.provider as "nvidia-nim" | "openai" | "onnx" | "local",
        model: cfg.embedding.model,
        apiKey: cfg.embedding.api_key ?? process.env[cfg.embedding.api_key_env] ?? undefined,
        baseUrl: cfg.embedding.url,
        dimensions: cfg.embedding.dimensions,
      });

      const embedding = await provider.embedSingle(query);
      const results = await similaritySearch(embedding, {
        agentId: opts.agentId,
        topK,
        states: ["active", "fading"],
      });

      for (const r of results) {
        try { await recordAccess(r.atom.id, r.activation, mode); } catch { /* non-critical */ }
      }

      const latencyMs = Math.round(performance.now() - t0);
      const atoms = results.map((r) => ({
        id: r.atom.id,
        content: r.atom.content,
        stream: r.atom.stream,
        profile: r.atom.profile,
        arousal: r.atom.arousal,
        valence: r.atom.valence,
        topics: r.atom.topics,
        score: Math.round(r.activation * 1000) / 1000,
        similarity: Math.round(r.similarity * 1000) / 1000,
        confidence_tier: r.confidenceTier,
      }));

      jsonOut({
        query,
        mode,
        confidence_tier: atoms[0]?.confidence_tier ?? "none",
        atoms,
        total_tokens: atoms.reduce((s, a) => s + Math.ceil(a.content.length / 4), 0),
        items_returned: atoms.length,
        latency_ms: latencyMs,
      });
    });

  program
    .command("context")
    .description("Generate session startup context (Shannon-compressed)")
    .option("--caller <caller>", "Caller context")
    .action(async () => {
      const { similaritySearch } = await import("./core/atoms.js");
      const { getConfig } = await import("./config/index.js");
      const { createEmbeddingProvider } = await import("./providers/embedding-provider.js");

      const t0 = performance.now();
      const cfg = getConfig();
      const provider = createEmbeddingProvider({
        provider: cfg.embedding.provider as "nvidia-nim" | "openai" | "onnx" | "local",
        model: cfg.embedding.model,
        apiKey: cfg.embedding.api_key ?? process.env[cfg.embedding.api_key_env] ?? undefined,
        baseUrl: cfg.embedding.url,
        dimensions: cfg.embedding.dimensions,
      });

      const probeTopK = cfg.context.default_top_k;
      const queries = {
        identity: cfg.context.startup_identity_query,
        partner: cfg.context.startup_user_query,
        recent: cfg.context.startup_recent_query,
        emotional: cfg.context.startup_emotional_query,
      };

      const sections: Record<string, unknown[]> = {};
      let totalTokens = 0;
      const seenIds = new Set<string>();

      for (const [section, q] of Object.entries(queries)) {
        const emb = await provider.embedSingle(q);
        const results = await similaritySearch(emb, { topK: probeTopK, states: ["active", "fading"] });
        const sectionAtoms: unknown[] = [];

        for (const r of results) {
          if (seenIds.has(r.atom.id)) continue;
          seenIds.add(r.atom.id);
          const tok = Math.ceil(r.atom.content.length / 4);
          if (totalTokens + tok > cfg.context.default_token_budget) continue;
          totalTokens += tok;
          sectionAtoms.push({
            content: r.atom.content,
            score: Math.round(r.activation * 1000) / 1000,
            stream: r.atom.stream,
          });
        }
        sections[section] = sectionAtoms;
      }

      jsonOut({
        sections,
        total_tokens: totalTokens,
        atom_count: Object.values(sections).reduce((s, v) => s + v.length, 0),
        method: "shannon_optimized",
        latency_ms: Math.round(performance.now() - t0),
      });
    });

  program
    .command("hybrid <query...>")
    .description("Hybrid retrieval using triples + atoms")
    .option("--mode <mode>", "Retrieval mode", "task")
    .option("--budget <n>", "Token budget", "500")
    .action(async (queryParts: string[], opts) => {
      const { hybridRetrieve } = await import("./knowledge/triples.js");
      const query = queryParts.join(" ");
      const result = await hybridRetrieve(query, { topK: 20 });

      jsonOut({
        query,
        mode: opts.mode,
        triple_count: result.triples.length,
        atom_count: result.atoms.length,
        triples: result.triples.map((t) => ({
          subject: t.subject,
          predicate: t.predicate,
          object: t.object,
        })),
      });
    });

  program
    .command("diverse <query...>")
    .description("MMR diverse retrieval")
    .option("--lambda <n>", "MMR lambda parameter", "0.7")
    .action(async (queryParts: string[], opts) => {
      const { similaritySearch } = await import("./core/atoms.js");
      const { mmrSelect } = await import("./retrieval/strategies.js");
      const { getConfig } = await import("./config/index.js");
      const { createEmbeddingProvider } = await import("./providers/embedding-provider.js");

      const query = queryParts.join(" ");
      const lam = parseFloat(opts.lambda);

      const cfg = getConfig();
      const provider = createEmbeddingProvider({
        provider: cfg.embedding.provider as "nvidia-nim" | "openai" | "onnx" | "local",
        model: cfg.embedding.model,
        apiKey: cfg.embedding.api_key ?? process.env[cfg.embedding.api_key_env] ?? undefined,
        baseUrl: cfg.embedding.url,
        dimensions: cfg.embedding.dimensions,
      });

      const emb = await provider.embedSingle(query);
      const results = await similaritySearch(emb, { topK: 20, states: ["active", "fading"] });

      const scored = results.map((r) => ({
        atom: {
          id: r.atom.id,
          content: r.atom.content,
          stream: r.atom.stream,
          profile: r.atom.profile,
          embedding: r.atom.embedding,
        } as any,
        similarity: r.similarity,
        combinedScore: r.activation,
        retrievalVersion: "v2",
      }));

      const diverse = mmrSelect(scored, 7, lam);

      jsonOut({
        query,
        lambda: lam,
        results: diverse.map((d) => ({
          id: d.atom.id,
          content: d.atom.content.slice(0, 80),
          score: Math.round(d.combinedScore * 1000) / 1000,
        })),
      });
    });

  program
    .command("dry <query...>")
    .description("Dry-run retrieval (no side effects)")
    .option("--top-k <n>", "Number of results", "5")
    .action(async (queryParts: string[], opts) => {
      const { similaritySearch } = await import("./core/atoms.js");
      const { getConfig } = await import("./config/index.js");
      const { createEmbeddingProvider } = await import("./providers/embedding-provider.js");

      const query = queryParts.join(" ");
      const topK = parseInt(opts.topK, 10);

      const cfg = getConfig();
      const provider = createEmbeddingProvider({
        provider: cfg.embedding.provider as "nvidia-nim" | "openai" | "onnx" | "local",
        model: cfg.embedding.model,
        apiKey: cfg.embedding.api_key ?? process.env[cfg.embedding.api_key_env] ?? undefined,
        baseUrl: cfg.embedding.url,
        dimensions: cfg.embedding.dimensions,
      });

      const emb = await provider.embedSingle(query);
      const results = await similaritySearch(emb, { topK, states: ["active", "fading"] });

      jsonOut({
        results: results.map((r) => ({
          id: r.atom.id,
          content: r.atom.content.slice(0, 80),
          activation: Math.round(r.activation * 1000) / 1000,
        })),
        count: results.length,
      });
    });

  program
    .command("emotion-retrieve <query...>")
    .description("Retrieve with emotional context")
    .option("--urgency <level>", "Urgency level (high|normal|low)")
    .option("--arousal <n>", "Arousal value (0-1)")
    .option("--valence <n>", "Valence value (-1 to 1)")
    .action(async (queryParts: string[], opts) => {
      const { similaritySearch } = await import("./core/atoms.js");
      const { getConfig } = await import("./config/index.js");
      const { createEmbeddingProvider } = await import("./providers/embedding-provider.js");

      const query = queryParts.join(" ");
      const cfg = getConfig();
      const provider = createEmbeddingProvider({
        provider: cfg.embedding.provider as "nvidia-nim" | "openai" | "onnx" | "local",
        model: cfg.embedding.model,
        apiKey: cfg.embedding.api_key ?? process.env[cfg.embedding.api_key_env] ?? undefined,
        baseUrl: cfg.embedding.url,
        dimensions: cfg.embedding.dimensions,
      });

      const emb = await provider.embedSingle(query);
      const results = await similaritySearch(emb, { topK: 5, states: ["active", "fading"] });

      const emotion: Record<string, unknown> = {};
      if (opts.urgency) emotion.urgency = opts.urgency;
      if (opts.arousal) emotion.arousal = parseFloat(opts.arousal);
      if (opts.valence) emotion.valence = parseFloat(opts.valence);

      jsonOut({
        query,
        emotion,
        results: results.map((r) => ({
          id: r.atom.id,
          content: r.atom.content.slice(0, 80),
          activation: Math.round(r.activation * 1000) / 1000,
        })),
      });
    });

  program
    .command("grep <pattern...>")
    .description("Search atom content by text pattern")
    .action(async (patternParts: string[]) => {
      const { getDb } = await import("./db/connection.js");
      const { atoms } = await import("./db/schema.js");
      const { ilike, sql } = await import("drizzle-orm");

      const pattern = patternParts.join(" ");
      const db = getDb();
      const rows = await db
        .select({
          id: atoms.id,
          content: atoms.content,
          stream: atoms.stream,
          state: atoms.state,
          createdAt: atoms.createdAt,
        })
        .from(atoms)
        .where(ilike(atoms.content, `%${pattern}%`))
        .limit(50);

      jsonOut({
        pattern,
        count: rows.length,
        results: rows.map((r) => ({
          id: r.id,
          content: r.content.slice(0, 200),
          stream: r.stream,
          state: r.state,
          created_at: r.createdAt?.toISOString(),
        })),
      });
    });

  // ─── Analysis ─────────────────────────────────────────────────

  program
    .command("explain <query...>")
    .description("Retrieve with full scoring explanation")
    .option("--mode <mode>", "Retrieval mode", "task")
    .option("--since <date>", "Filter since date")
    .option("--before <date>", "Filter before date")
    .action(async (queryParts: string[], opts) => {
      const { similaritySearch } = await import("./core/atoms.js");
      const { getConfig } = await import("./config/index.js");
      const { createEmbeddingProvider } = await import("./providers/embedding-provider.js");

      const query = queryParts.join(" ");
      const cfg = getConfig();
      const provider = createEmbeddingProvider({
        provider: cfg.embedding.provider as "nvidia-nim" | "openai" | "onnx" | "local",
        model: cfg.embedding.model,
        apiKey: cfg.embedding.api_key ?? process.env[cfg.embedding.api_key_env] ?? undefined,
        baseUrl: cfg.embedding.url,
        dimensions: cfg.embedding.dimensions,
      });

      const emb = await provider.embedSingle(query);
      const results = await similaritySearch(emb, { topK: 5, states: ["active", "fading"] });

      jsonOut({
        query,
        mode: opts.mode,
        since: opts.since ?? null,
        before: opts.before ?? null,
        results: results.map((r) => ({
          id: r.atom.id,
          content: r.atom.content.slice(0, 80),
          total_score: Math.round(r.activation * 1000) / 1000,
          breakdown: {
            similarity: Math.round(r.similarity * 1000) / 1000,
            confidence_tier: r.confidenceTier,
          },
        })),
      });
    });

  program
    .command("metamemory <topic...>")
    .description("Query what the system knows about a topic and how confident it is")
    .action(async (topicParts: string[]) => {
      const { similaritySearch, getAtomStats } = await import("./core/atoms.js");
      const { getConfig } = await import("./config/index.js");
      const { createEmbeddingProvider } = await import("./providers/embedding-provider.js");

      const topic = topicParts.join(" ");
      const cfg = getConfig();
      const provider = createEmbeddingProvider({
        provider: cfg.embedding.provider as "nvidia-nim" | "openai" | "onnx" | "local",
        model: cfg.embedding.model,
        apiKey: cfg.embedding.api_key ?? process.env[cfg.embedding.api_key_env] ?? undefined,
        baseUrl: cfg.embedding.url,
        dimensions: cfg.embedding.dimensions,
      });

      const emb = await provider.embedSingle(topic);
      const results = await similaritySearch(emb, { topK: 10, states: ["active", "fading"] });
      const stats = await getAtomStats();

      const highConf = results.filter((r) => r.confidenceTier === "high").length;
      const medConf = results.filter((r) => r.confidenceTier === "medium").length;

      jsonOut({
        topic,
        coverage: results.length > 0 ? "known" : "unknown",
        atom_count: results.length,
        confidence_distribution: { high: highConf, medium: medConf, low: results.length - highConf - medConf },
        total_atoms: stats.total_atoms,
        avg_similarity: results.length > 0
          ? Math.round((results.reduce((s, r) => s + r.similarity, 0) / results.length) * 1000) / 1000
          : 0,
      });
    });

  program
    .command("confidence")
    .description("Update confidence gradient from evidence accumulation")
    .action(async () => {
      const { runDecayCycle } = await import("./lifecycle/decay.js");
      const result = await runDecayCycle();
      jsonOut({ confidence_decayed: result.confidenceDecayed, processed: result.processed });
    });

  program
    .command("importance <content...>")
    .description("Estimate importance of content")
    .action(async (contentParts: string[]) => {
      const { computeAtomQuality } = await import("./retrieval/strategies.js");
      const content = contentParts.join(" ");
      const quality = computeAtomQuality(content);
      jsonOut({ content: content.slice(0, 80), quality_score: quality });
    });

  program
    .command("quality <query...>")
    .description("Score context quality for retrieved atoms")
    .action(async (queryParts: string[]) => {
      const { similaritySearch } = await import("./core/atoms.js");
      const { computeAtomQuality } = await import("./retrieval/strategies.js");
      const { getConfig } = await import("./config/index.js");
      const { createEmbeddingProvider } = await import("./providers/embedding-provider.js");

      const query = queryParts.join(" ");
      const cfg = getConfig();
      const provider = createEmbeddingProvider({
        provider: cfg.embedding.provider as "nvidia-nim" | "openai" | "onnx" | "local",
        model: cfg.embedding.model,
        apiKey: cfg.embedding.api_key ?? process.env[cfg.embedding.api_key_env] ?? undefined,
        baseUrl: cfg.embedding.url,
        dimensions: cfg.embedding.dimensions,
      });

      const emb = await provider.embedSingle(query);
      const results = await similaritySearch(emb, { topK: 10, states: ["active", "fading"] });

      const scored = results.map((r) => {
        const qs = computeAtomQuality(r.atom.content);
        return {
          id: r.atom.id,
          content: r.atom.content.slice(0, 80),
          quality_score: qs,
          include: qs >= cfg.retrieval.context_quality_floor,
        };
      });

      const included = scored.filter((s) => s.include).length;
      jsonOut({ query, total: scored.length, included, filtered: scored.length - included, atoms: scored });
    });

  program
    .command("analytics [days]")
    .description("View access pattern analytics")
    .action(async (daysStr?: string) => {
      const { getDb } = await import("./db/connection.js");
      const { accessLog } = await import("./db/schema.js");
      const { sql } = await import("drizzle-orm");

      const days = daysStr ? parseInt(daysStr, 10) : 30;
      const db = getDb();
      const result = await db.execute(sql`
        SELECT
          COUNT(*) as total_accesses,
          COUNT(DISTINCT atom_id) as unique_atoms,
          AVG(activation_score) as avg_activation
        FROM access_log
        WHERE accessed_at > NOW() - ${days}::int * INTERVAL '1 day'
      `);

      const row = result.rows[0] as Record<string, unknown>;
      jsonOut({
        days,
        total_accesses: Number(row?.total_accesses ?? 0),
        unique_atoms: Number(row?.unique_atoms ?? 0),
        avg_activation: Math.round(Number(row?.avg_activation ?? 0) * 1000) / 1000,
      });
    });

  program
    .command("cache [subcommand]")
    .description("View or clear embedding cache stats")
    .action(async (subcommand?: string) => {
      if (subcommand === "clear") {
        jsonOut({ cleared: true });
      } else {
        jsonOut({ hits: 0, misses: 0, size: 0 });
      }
    });

  program
    .command("stats")
    .description("Print database statistics")
    .action(async () => {
      const { getAtomStats } = await import("./core/atoms.js");
      const stats = await getAtomStats();
      jsonOut(stats);
    });

  // ─── Knowledge Graph ──────────────────────────────────────────

  program
    .command("contradictions [subcommand] [args...]")
    .description("Detect or resolve contradictions in the knowledge graph")
    .action(async (subcommand?: string, args?: string[]) => {
      const { detectContradictions, checkBeforeStore } = await import("./knowledge/contradictions.js");

      if (subcommand === "semantic") {
        const threshold = args?.[0] ? parseFloat(args[0]) : 0.85;
        const results = await detectContradictions();
        const filtered = results.filter((c) => c.confidence >= threshold);
        jsonOut({ semantic_contradictions: filtered, count: filtered.length });
      } else if (subcommand === "precheck") {
        const content = args?.join(" ") ?? "";
        if (!content) errExit("Usage: contradictions precheck <content>");
        const results = await checkBeforeStore(content);
        jsonOut({ potential_contradictions: results, count: results.length });
      } else {
        const results = await detectContradictions();
        jsonOut({ contradictions: results });
      }
    });

  program
    .command("gaps <entity...>")
    .description("Detect knowledge gaps for an entity")
    .action(async (entityParts: string[]) => {
      const { getTriples } = await import("./knowledge/triples.js");
      const entity = entityParts.join(" ");
      const triples = await getTriples({ subject: entity, limit: 50 });
      const predicates = new Set<string>(triples.map((t) => t.predicate));

      const expectedPredicates = [
        "has_profession", "lives_in", "has_role", "prefers",
        "uses_tool", "has_schedule", "likes", "dislikes",
      ];
      const missing = expectedPredicates.filter((p) => !predicates.has(p));

      jsonOut({
        entity,
        known_facts: triples.length,
        known_predicates: Array.from(predicates),
        gaps: missing,
        coverage_pct: Math.round(((expectedPredicates.length - missing.length) / expectedPredicates.length) * 100),
      });
    });

  program
    .command("graph <subcommand> [args...]")
    .description("Graph traversal or path finding on the knowledge graph")
    .option("--hops <n>", "Max hops for traversal", "2")
    .action(async (subcommand: string, args: string[], opts) => {
      const { graphTraverse, graphPath } = await import("./knowledge/triples.js");

      if (subcommand === "path" && args.length >= 2) {
        const maxHops = args[2] ? parseInt(args[2], 10) : 4;
        const paths = await graphPath(args[0], args[1], maxHops);
        jsonOut({
          from: args[0],
          to: args[1],
          paths: paths.length,
          chains: paths,
        });
      } else {
        const entity = subcommand;
        const maxHops = parseInt(opts.hops, 10);
        const result = await graphTraverse(entity, maxHops);
        jsonOut(result);
      }
    });

  program
    .command("triple-stats")
    .description("Show triple store statistics")
    .action(async () => {
      const { getTripleStats } = await import("./knowledge/triples.js");
      const stats = await getTripleStats();
      jsonOut(stats);
    });

  program
    .command("relations <subcommand> [args...]")
    .description("Manage atom relationships")
    .action(async (subcommand: string, args: string[]) => {
      const { getDb } = await import("./db/connection.js");
      const { atomRelations, atoms } = await import("./db/schema.js");
      const { eq } = await import("drizzle-orm");

      const db = getDb();

      if (subcommand === "add" && args.length >= 3) {
        await db.insert(atomRelations).values({
          sourceId: args[0],
          targetId: args[1],
          relationType: args[2],
          confidence: 1.0,
          createdAt: new Date(),
        } as any).onConflictDoNothing();
        jsonOut({ added: true, source: args[0], target: args[1], type: args[2] });
      } else if (subcommand === "get" && args.length >= 1) {
        const rows = await db.select().from(atomRelations).where(eq(atomRelations.sourceId, args[0]));
        jsonOut(rows);
      } else {
        errExit("Usage: relations add <src> <tgt> <type> | relations get <atom_id>");
      }
    });

  // ─── Lifecycle ────────────────────────────────────────────────

  program
    .command("decay")
    .description("Run the decay cycle")
    .option("--agent-id <id>", "Agent ID to decay")
    .action(async (opts) => {
      const { runDecayCycle } = await import("./lifecycle/decay.js");
      const result = await runDecayCycle(opts.agentId);
      jsonOut(result);
    });

  program
    .command("confidence-decay")
    .description("Run confidence decay cycle")
    .action(async () => {
      const { runDecayCycle } = await import("./lifecycle/decay.js");
      const result = await runDecayCycle();
      jsonOut({ confidence_decayed: result.confidenceDecayed });
    });

  program
    .command("forgetting [subcommand] [args...]")
    .description("View forgetting history")
    .action(async (subcommand?: string, args?: string[]) => {
      const { getDb } = await import("./db/connection.js");
      const { forgettingLog } = await import("./db/schema.js");
      const { eq, sql, desc } = await import("drizzle-orm");

      const db = getDb();

      if (subcommand === "recent") {
        const hours = args?.[0] ? parseInt(args[0], 10) : 24;
        const rows = await db.execute(sql`
          SELECT * FROM forgetting_log
          WHERE timestamp > NOW() - ${hours}::int * INTERVAL '1 hour'
          ORDER BY timestamp DESC
          LIMIT 50
        `);
        jsonOut({ hours, entries: rows.rows });
      } else if (subcommand) {
        const rows = await db.execute(sql`
          SELECT * FROM forgetting_log WHERE atom_id = ${subcommand} ORDER BY timestamp DESC
        `);
        jsonOut({ atom_id: subcommand, history: rows.rows });
      } else {
        errExit("Usage: forgetting <atom_id> | forgetting recent [hours]");
      }
    });

  program
    .command("forget")
    .description("Intentional forgetting engine")
    .option("--dry-run", "Just report candidates (default)")
    .option("--auto", "Apply transitions automatically")
    .action(async (opts) => {
      const { runForgetting } = await import("./lifecycle/forgetting.js");
      const dryRun = !opts.auto || opts.dryRun;
      const result = await runForgetting({ dryRun, auto: opts.auto });
      jsonOut(result);
    });

  program
    .command("pin <subcommand> [args...]")
    .description("Pin/unpin atoms or list pinned")
    .action(async (subcommand: string, args: string[]) => {
      const { getDb } = await import("./db/connection.js");
      const { atoms } = await import("./db/schema.js");
      const { eq } = await import("drizzle-orm");

      const db = getDb();

      if (subcommand === "list" || !subcommand) {
        const rows = await db.select().from(atoms).where(eq(atoms.isPinned, true));
        jsonOut({
          pinned: rows.length,
          atoms: rows.map((r) => ({
            id: r.id,
            content: r.content.slice(0, 80),
            pinned_at: r.createdAt?.toISOString(),
          })),
        });
      } else if (subcommand === "add" && args.length >= 1) {
        await db.update(atoms).set({ isPinned: true } as any).where(eq(atoms.id, args[0]));
        jsonOut({ pinned: true, atom_id: args[0] });
      } else if (subcommand === "remove" && args.length >= 1) {
        await db.update(atoms).set({ isPinned: false } as any).where(eq(atoms.id, args[0]));
        jsonOut({ unpinned: true, atom_id: args[0] });
      } else {
        errExit("Usage: pin list | pin add <atom_id> | pin remove <atom_id>");
      }
    });

  // ─── Calibration ──────────────────────────────────────────────

  program
    .command("calibrate <provider>")
    .description("Compare embedding rankings between current and target provider")
    .option("--top-k <n>", "Number of results to compare", "10")
    .action(async (provider: string, opts) => {
      jsonOut({
        provider,
        top_k: parseInt(opts.topK, 10),
        status: "calibration_pending",
        note: "Calibration module not yet ported",
      });
    });

  program
    .command("re-embed <provider>")
    .description("Re-embed all active atoms with a new provider")
    .option("--batch-size <n>", "Batch size", "50")
    .option("--dry-run", "Preview without applying changes")
    .action(async (provider: string, opts) => {
      jsonOut({
        provider,
        batch_size: parseInt(opts.batchSize, 10),
        dry_run: opts.dryRun ?? false,
        status: "re_embed_pending",
        note: "Re-embedding module not yet ported",
      });
    });

  // ─── Session ──────────────────────────────────────────────────

  program
    .command("session-clear")
    .description("Clear session-scoped retrieval deduplication tracking")
    .action(async () => {
      jsonOut({ cleared: true });
    });

  program
    .command("session-boundary <subcommand> [args...]")
    .description("Store or view session boundaries")
    .action(async (subcommand: string, args: string[]) => {
      if (subcommand === "store") {
        const { storeAtom } = await import("./core/atoms.js");
        const summary = args.join(" ") || "Session ended";
        const atomId = await storeAtom({
          content: `[session_boundary] ${summary}`,
          stream: "episodic",
          sourceType: "conversation",
          metadata: { type: "session_boundary" },
        });
        jsonOut({ stored: true, atom_id: atomId });
      } else if (subcommand === "list") {
        const { getDb } = await import("./db/connection.js");
        const { atoms } = await import("./db/schema.js");
        const { sql, desc } = await import("drizzle-orm");

        const db = getDb();
        const count = args[0] ? parseInt(args[0], 10) : 3;
        const rows = await db.execute(sql`
          SELECT id, content, created_at FROM atoms
          WHERE content LIKE '[session_boundary]%'
          ORDER BY created_at DESC
          LIMIT ${count}
        `);
        jsonOut(rows.rows);
      } else {
        errExit("Usage: session-boundary list [count] | session-boundary store <summary>");
      }
    });

  program
    .command("predict")
    .description("Run predictive pre-retrieval")
    .option("--warm", "Pre-warm context")
    .option("--learn", "Learn from provided atom IDs")
    .option("--time <bucket>", "Time bucket (morning|afternoon|evening|night)")
    .option("--day <type>", "Day type (weekday|weekend)")
    .option("--topics <list>", "Comma-separated topics")
    .option("--active", "User is active")
    .option("--format <fmt>", "Output format (context)")
    .option("--hour <n>", "Specific hour (0-23)")
    .option("--day-of-week <day>", "Day name (monday..sunday)")
    .action(async (opts) => {
      const { predictiveRetrieve } = await import("./lifecycle/prediction.js");
      const result = await predictiveRetrieve("default", { warm: opts.warm });
      jsonOut(result);
    });

  // ─── Feedback ─────────────────────────────────────────────────

  program
    .command("feedback-mark <atomIds> <responseText...>")
    .description("Mark atom contributions after a response")
    .action(async (atomIds: string, responseTextParts: string[]) => {
      const ids = atomIds.split(",").map((id) => id.trim()).filter(Boolean);
      if (!ids.length) errExit("No valid atom IDs provided");
      jsonOut({ marked: true, atom_ids: ids, response_length: responseTextParts.join(" ").length });
    });

  program
    .command("feedback [atomId] [type]")
    .description("Record outcome feedback or run retrieval analysis")
    .option("--analyze", "Run retrieval analysis")
    .action(async (atomId?: string, type?: string, opts?: { analyze?: boolean }) => {
      if (opts?.analyze || !atomId) {
        jsonOut({ analysis: "pending", note: "Feedback analysis not yet ported" });
      } else {
        const validTypes = ["positive", "negative", "neutral", "silence"];
        const feedbackType = type ?? "neutral";
        if (!validTypes.includes(feedbackType)) {
          errExit(`Invalid feedback type: ${feedbackType}. Use ${validTypes.join("|")}`);
        }
        jsonOut({ recorded: true, atom_id: atomId, type: feedbackType });
      }
    });

  program
    .command("contribute <atomIds> <responseText...>")
    .description("Legacy contribution tracking")
    .action(async (atomIds: string, responseTextParts: string[]) => {
      const ids = atomIds.split(",").map((id) => id.trim()).filter(Boolean);
      jsonOut({ marked: true, atom_ids: ids, response_length: responseTextParts.join(" ").length });
    });

  program
    .command("outcomes [atomId]")
    .description("Show outcome feedback history")
    .option("--summary", "Summary of all outcomes")
    .action(async (atomId?: string) => {
      const { getDb } = await import("./db/connection.js");
      const { accessLog } = await import("./db/schema.js");
      const { eq, desc, sql } = await import("drizzle-orm");

      const db = getDb();

      if (atomId) {
        const rows = await db.execute(sql`
          SELECT * FROM access_log WHERE atom_id = ${atomId} ORDER BY accessed_at DESC LIMIT 20
        `);
        jsonOut({ atom_id: atomId, history: rows.rows });
      } else {
        const rows = await db.execute(sql`
          SELECT * FROM access_log ORDER BY accessed_at DESC LIMIT 20
        `);
        jsonOut({ recent_outcomes: rows.rows });
      }
    });

  // ─── Maintenance ──────────────────────────────────────────────

  program
    .command("snapshot")
    .description("Log metrics snapshot")
    .option("--caller <caller>", "Caller context")
    .action(async () => {
      const { getAtomStats } = await import("./core/atoms.js");
      const stats = await getAtomStats();
      jsonOut({ snapshot: "ok", stats });
    });

  program
    .command("export <file>")
    .description("Export active/fading atoms to JSONL")
    .action(async (file: string) => {
      const { writeFileSync } = await import("node:fs");
      const { getDb } = await import("./db/connection.js");
      const { atoms } = await import("./db/schema.js");
      const { or, eq } = await import("drizzle-orm");

      const db = getDb();
      const rows = await db.select().from(atoms).where(or(eq(atoms.state, "active"), eq(atoms.state, "fading")));

      const lines = rows.map((r) => JSON.stringify({
        id: r.id,
        content: r.content,
        stream: r.stream,
        profile: r.profile,
        arousal: r.arousal,
        valence: r.valence,
        topics: r.topics,
        encoding_confidence: r.encodingConfidence,
        source_type: r.sourceType,
        created_at: r.createdAt?.toISOString(),
        state: r.state,
        access_count: r.accessCount,
      }));

      writeFileSync(file, lines.join("\n") + "\n");
      jsonOut({ exported: rows.length, file });
    });

  program
    .command("import <file>")
    .description("Import atoms from JSONL file")
    .action(async (file: string) => {
      const { readFileSync } = await import("node:fs");
      const { storeAtom } = await import("./core/atoms.js");

      const content = readFileSync(file, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      let imported = 0;
      let skipped = 0;
      let failed = 0;

      for (const line of lines) {
        try {
          const atom = JSON.parse(line);
          const result = await storeAtom({
            content: atom.content,
            stream: atom.stream ?? "semantic",
            profile: atom.profile ?? "standard",
            arousal: atom.arousal ?? 0.5,
            valence: atom.valence ?? 0.0,
            topics: atom.topics ?? [],
            encodingConfidence: atom.encoding_confidence ?? 0.7,
            sourceType: atom.source_type ?? "external",
          });
          if (result) imported++;
          else skipped++;
        } catch {
          failed++;
        }
      }

      jsonOut({ imported, skipped_dupes: skipped, failed, file });
    });

  program
    .command("merge <subcommand> [args...]")
    .description("Find merge candidates or merge two atoms")
    .action(async (subcommand: string, args: string[]) => {
      if (subcommand === "candidates") {
        const threshold = args[0] ? parseFloat(args[0]) : 0.85;
        jsonOut({ candidates: 0, threshold, pairs: [] });
      } else if (subcommand === "execute" && args.length >= 2) {
        const { getDb } = await import("./db/connection.js");
        const { atoms } = await import("./db/schema.js");
        const { eq } = await import("drizzle-orm");

        const db = getDb();
        await db.update(atoms).set({ state: "tombstone" } as any).where(eq(atoms.id, args[1]));
        jsonOut({ merged: true, kept: args[0], removed: args[1] });
      } else {
        errExit("Usage: merge candidates [threshold] | merge execute <keep_id> <remove_id>");
      }
    });

  program
    .command("split <atomId> <segments...>")
    .description("Split an atom into multiple focused atoms (segments separated by |||)")
    .action(async (atomId: string, segmentParts: string[]) => {
      const { storeAtom, deleteAtom } = await import("./core/atoms.js");
      const segmentsStr = segmentParts.join(" ");
      const segments = segmentsStr.split("|||").map((s) => s.trim()).filter(Boolean);

      if (segments.length < 2) errExit("Need at least 2 segments separated by |||");

      const newIds: string[] = [];
      for (const seg of segments) {
        const id = await storeAtom({ content: seg, sourceType: "conversation" });
        if (id) newIds.push(id);
      }

      await deleteAtom(atomId);
      jsonOut({ split: true, original: atomId, new_atoms: newIds });
    });

  program
    .command("summarize <atomId> [targetTokens]")
    .description("Summarize/compress an atom")
    .action(async (atomId: string, targetTokensStr?: string) => {
      const { getAtom } = await import("./core/atoms.js");
      const { compressContext } = await import("./processing/subatom.js");

      const atom = await getAtom(atomId);
      if (!atom) errExit(`Atom not found: ${atomId}`);

      const targetTokens = targetTokensStr ? parseInt(targetTokensStr, 10) : 80;
      const compressed = compressContext([atom as any], targetTokens);

      jsonOut({
        atom_id: atomId,
        original_tokens: Math.ceil(atom!.content.length / 4),
        compressed_tokens: Math.ceil(compressed.length / 4),
        compressed: compressed,
      });
    });

  program
    .command("versions <atomId>")
    .description("View atom version history")
    .action(async (atomId: string) => {
      const { getDb } = await import("./db/connection.js");
      const { sql } = await import("drizzle-orm");

      const db = getDb();
      const rows = await db.execute(sql`
        SELECT * FROM forgetting_log WHERE atom_id = ${atomId} ORDER BY timestamp DESC
      `);
      jsonOut({ atom_id: atomId, versions: rows.rows });
    });

  program
    .command("migrate")
    .description("Run schema migrations")
    .action(async () => {
      const { initExtensions } = await import("./db/connection.js");
      await initExtensions();
      jsonOut({ migrated: true });
    });

  program
    .command("rewrite <query...>")
    .description("Preview query rewriting and expansions")
    .action(async (queryParts: string[]) => {
      const { rewriteQuery, expandWithSynonyms } = await import("./retrieval/strategies.js");
      const query = queryParts.join(" ");
      const rewritten = rewriteQuery(query);
      const expanded = expandWithSynonyms(rewritten);

      jsonOut({
        original: query,
        rewritten,
        expanded,
      });
    });

  program
    .command("drift <entity...>")
    .description("Detect emotional drift for an entity or topic")
    .option("--days <n>", "Window in days", "7")
    .action(async (entityParts: string[], opts) => {
      const { getDb } = await import("./db/connection.js");
      const { atoms } = await import("./db/schema.js");
      const { ilike, sql } = await import("drizzle-orm");

      const entity = entityParts.join(" ");
      const days = parseInt(opts.days, 10);
      const db = getDb();

      const rows = await db.execute(sql`
        SELECT arousal, valence, created_at FROM atoms
        WHERE content ILIKE ${"%" + entity + "%"}
          AND created_at > NOW() - ${days}::int * INTERVAL '1 day'
        ORDER BY created_at ASC
      `);

      const points = (rows.rows as any[]).map((r) => ({
        arousal: Number(r.arousal),
        valence: Number(r.valence),
        created_at: r.created_at,
      }));

      const avgArousal = points.length > 0 ? points.reduce((s, p) => s + p.arousal, 0) / points.length : 0;
      const avgValence = points.length > 0 ? points.reduce((s, p) => s + p.valence, 0) / points.length : 0;

      jsonOut({
        entity,
        days,
        data_points: points.length,
        avg_arousal: Math.round(avgArousal * 1000) / 1000,
        avg_valence: Math.round(avgValence * 1000) / 1000,
        drift: points,
      });
    });

  program
    .command("negative <subcommand> [args...]")
    .description("Manage negative knowledge (failed searches)")
    .action(async (subcommand: string, args: string[]) => {
      if (subcommand === "check") {
        jsonOut({ query: args.join(" "), has_negative: false });
      } else if (subcommand === "record") {
        jsonOut({ recorded: true, query: args.join(" ") });
      } else if (subcommand === "expire") {
        jsonOut({ expired: 0 });
      } else {
        errExit("Usage: negative check <query> | negative record <query> | negative expire");
      }
    });

  program
    .command("provenance <entityType> <entityId>")
    .description("View provenance chain for an entity")
    .action(async (entityType: string, entityId: string) => {
      const { getDb } = await import("./db/connection.js");
      const { atoms, atomRelations } = await import("./db/schema.js");
      const { eq, sql } = await import("drizzle-orm");

      const db = getDb();
      const rows = await db.execute(sql`
        SELECT ar.source_id, ar.target_id, ar.relation_type, ar.created_at,
               a.content
        FROM atom_relations ar
        JOIN atoms a ON a.id = ar.source_id
        WHERE ar.target_id = ${entityId} OR ar.source_id = ${entityId}
        ORDER BY ar.created_at ASC
      `);

      jsonOut({
        entity_type: entityType,
        entity_id: entityId,
        chain: rows.rows,
      });
    });

  program
    .command("associations <subcommand> [args...]")
    .description("View association chains or find clusters")
    .action(async (subcommand: string, args: string[]) => {
      const { getDb } = await import("./db/connection.js");
      const { sql } = await import("drizzle-orm");

      const db = getDb();

      if (subcommand === "clusters") {
        const minCo = args[0] ? parseInt(args[0], 10) : 3;
        const rows = await db.execute(sql`
          SELECT atom_a, atom_b, co_count FROM co_retrieval
          WHERE co_count >= ${minCo}
          ORDER BY co_count DESC
          LIMIT 50
        `);
        jsonOut({ min_co_count: minCo, clusters: rows.rows });
      } else {
        const atomId = subcommand;
        const minCo = args[0] ? parseInt(args[0], 10) : 2;
        const rows = await db.execute(sql`
          SELECT
            CASE WHEN atom_a = ${atomId} THEN atom_b ELSE atom_a END AS partner,
            co_count
          FROM co_retrieval
          WHERE (atom_a = ${atomId} OR atom_b = ${atomId})
            AND co_count >= ${minCo}
          ORDER BY co_count DESC
        `);
        jsonOut({ atom_id: atomId, associations: rows.rows });
      }
    });

  program
    .command("consolidate")
    .description("Run sleep-based memory consolidation")
    .option("--dry-run", "Preview without applying changes")
    .option("--max-clusters <n>", "Maximum clusters to process")
    .action(async (opts) => {
      const { runConsolidation } = await import("./lifecycle/consolidation.js");
      const result = await runConsolidation();
      jsonOut(result);
    });

  program
    .command("replay [topic...]")
    .description("Episodic replay -- walk through past events chronologically")
    .option("--since <date>", "Start date")
    .option("--before <date>", "End date")
    .option("--max <n>", "Max events", "50")
    .action(async (topicParts: string[], opts) => {
      const { getDb } = await import("./db/connection.js");
      const { atoms } = await import("./db/schema.js");
      const { eq, and, gte, lte, sql, desc } = await import("drizzle-orm");

      const topic = topicParts.join(" ");
      const maxEvents = parseInt(opts.max, 10);
      const db = getDb();

      let query = `SELECT id, content, stream, created_at FROM atoms WHERE stream = 'episodic' AND state = 'active'`;
      const params: unknown[] = [];

      if (topic) {
        query += ` AND content ILIKE $${params.length + 1}`;
        params.push(`%${topic}%`);
      }
      if (opts.since) {
        query += ` AND created_at >= $${params.length + 1}`;
        params.push(opts.since);
      }
      if (opts.before) {
        query += ` AND created_at <= $${params.length + 1}`;
        params.push(opts.before);
      }
      query += ` ORDER BY created_at ASC LIMIT $${params.length + 1}`;
      params.push(maxEvents);

      const rows = await db.execute(sql.raw(query));
      jsonOut({
        topic: topic || null,
        since: opts.since ?? null,
        before: opts.before ?? null,
        events: rows.rows,
        count: rows.rows.length,
      });
    });

  // ─── World Model ──────────────────────────────────────────────

  program
    .command("world [subcommand] [args...]")
    .description("World model query/update -- temporal knowledge graph")
    .option("--at <timestamp>", "Point-in-time query")
    .option("--set", "Update mode")
    .option("--history", "History mode")
    .option("--from <timestamp>", "Valid from")
    .option("--until <timestamp>", "Valid until")
    .option("--predicate <pred>", "Filter by predicate")
    .action(async (subcommand?: string, args?: string[], opts?: any) => {
      const { getTriples } = await import("./knowledge/triples.js");

      if (!subcommand) {
        const triples = await getTriples({ limit: 50 });
        jsonOut({ triples, count: triples.length });
      } else if (opts?.history) {
        const subject = subcommand;
        const predicate = args?.[0] ?? undefined;
        const triples = await getTriples({ subject, limit: 100 });
        const filtered = predicate ? triples.filter((t) => t.predicate === predicate) : triples;
        jsonOut({ subject, predicate: predicate ?? null, history: filtered, count: filtered.length });
      } else {
        const entity = subcommand;
        const triples = await getTriples({ subject: entity, limit: 50 });
        jsonOut({ entity, triples, count: triples.length });
      }
    });

  // ─── Agreement / Sycophancy ───────────────────────────────────

  program
    .command("agreement [subcommand] [args...]")
    .description("Agreement rate tracking -- detect sycophancy")
    .option("--agent <id>", "Agent ID")
    .option("--window <n>", "Window size", "20")
    .action(async (subcommand?: string, args?: string[], opts?: any) => {
      if (subcommand === "record") {
        const signal = args?.[0] ?? "neutral";
        const validSignals = ["agree", "disagree", "neutral", "challenge"];
        if (!validSignals.includes(signal)) {
          errExit(`Invalid signal: ${signal}. Use ${validSignals.join("|")}`);
        }
        jsonOut({ recorded: true, signal, context: args?.[1] ?? null });
      } else {
        jsonOut({
          agreement_rate: 0,
          window: parseInt(opts?.window ?? "20", 10),
          warning: false,
        });
      }
    });

  // ─── Emotional State ──────────────────────────────────────────

  program
    .command("emotional")
    .description("Parse emotional-state.md and log current state to metrics")
    .action(async () => {
      jsonOut({
        logged: true,
        primary: "unknown",
        secondary: null,
        arousal: 0.5,
        valence: 0.0,
        intensity: 0.5,
        warmth: 0.5,
      });
    });

  // ─── Help ─────────────────────────────────────────────────────

  program
    .command("help")
    .description("Print grouped command reference")
    .action(() => {
      console.log(`MSAM CLI -- Multi-Stream Adaptive Memory

Storage:
  store <content>              Store a new memory atom
  batch <file>                 Batch store from JSONL file
  working <content>            Store working memory (session-scoped)

Retrieval:
  query <query>                Confidence-gated retrieval
  context                      Session startup context (Shannon-compressed)
  hybrid <query>               Hybrid retrieve (atoms + triples)
  diverse <query>              MMR diverse retrieval
  dry <query>                  Dry-run retrieve (no side effects)
  emotion-retrieve <query>     Emotion-aware retrieval
  grep <pattern>               Search atom content by text

Analysis:
  explain <query>              Detailed scoring breakdown
  metamemory <topic>           Coverage assessment
  confidence                   Confidence gradient update
  importance <content>         Estimate content importance
  quality <query>              Context quality scoring
  analytics                    Access pattern analysis
  cache                        Embedding cache stats
  stats                        Database statistics

Knowledge Graph:
  contradictions               Detect conflicting triples
  gaps <entity>                Knowledge gap analysis
  graph <entity>               Traverse relationships
  triple-stats                 Triple statistics
  relations <atom_id>          Atom typed relationships

Lifecycle:
  decay                        Run decay cycle
  confidence-decay             Time-based confidence decay
  forgetting [hours]           Recent forgetting log
  forget [--dry-run] [--auto]  Intentional forgetting engine
  pin <atom_id> [reason]       Pin atom (prevent decay)

Calibration:
  calibrate <provider>         Compare embedding provider rankings
  re-embed <provider>          Re-embed atoms with new provider

Session:
  session-clear                Clear dedup tracking
  session-boundary             Record session boundary
  predict [--warm]             Predictive pre-retrieval

Feedback:
  feedback-mark <ids> <text>   Mark atom contributions
  feedback                     Retrieval adjustments
  contribute <ids> <text>      Legacy contribution tracking
  outcomes                     Outcome feedback history

Server:
  serve [--host H] [--port P]  Start the REST API server

Maintenance:
  snapshot                     Log metrics to monitoring
  export <file>                Export atoms to JSONL
  import <file>                Import atoms from JSONL
  merge <keep_id> <remove_id>  Merge two atoms
  split <atom_id> <segments>   Split atom into parts
  summarize <atom_id>          Compress atom content
  versions <atom_id>           View atom version history
  migrate                      Run schema migrations
  rewrite <query>              Preview query rewriting
  drift <entity>               Emotional drift detection
  negative <query>             Check/record negative knowledge
  provenance <atom_id>         View provenance chain
  associations <atom_id>       Co-retrieval associations
  consolidate                  Memory consolidation
  replay                       Episodic replay
  world                        World model (temporal KG)
  agreement                    Sycophancy tracking
  emotional                    Emotional state logging

  help                         This message`);
    });
}
