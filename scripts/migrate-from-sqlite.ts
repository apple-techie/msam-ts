#!/usr/bin/env tsx

import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import pg from "pg";

// ─── Pure utility functions (exported for testing) ───

// ─── Helpers ───

function deserializeEmbedding(blob: Buffer): number[] {
  const dim = blob.length / 4;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const values: number[] = new Array(dim);
  for (let i = 0; i < dim; i++) {
    values[i] = view.getFloat32(i * 4, true); // little-endian float32
  }
  return values;
}

function embeddingToVector(values: number[]): string {
  return `[${values.join(",")}]`;
}

function parseTimestamp(val: string | null | undefined): Date | null {
  if (!val) return null;
  const d = new Date(val.includes("T") ? val : val.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? null : d;
}

function intToBool(val: number | null | undefined): boolean {
  return val === 1;
}

function parseJsonb(val: string | null | undefined): unknown {
  if (val == null) return null;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ─── Table migration configs ───

interface TableMigration {
  name: string;
  sqliteTable: string;
  pgTable: string;
  hasSerial: boolean;
  transform: (row: Record<string, unknown>) => Record<string, unknown>;
  insertSql: (rows: Record<string, unknown>[]) => { text: string; values: unknown[] };
}

function buildInsert(
  tableName: string,
  columns: string[],
  rows: Record<string, unknown>[],
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const rowPlaceholders: string[] = [];

  for (const row of rows) {
    const placeholders: string[] = [];
    for (const col of columns) {
      let val = row[col] ?? null;
      // pg driver needs jsonb values stringified
      if (val !== null && typeof val === "object" && !(val instanceof Date) && !Buffer.isBuffer(val)) {
        val = JSON.stringify(val);
      }
      values.push(val);
      placeholders.push(`$${values.length}`);
    }
    rowPlaceholders.push(`(${placeholders.join(",")})`);
  }

  const text = `INSERT INTO "${tableName}" (${columns.map((c) => `"${c}"`).join(",")}) VALUES ${rowPlaceholders.join(",")} ON CONFLICT DO NOTHING`;
  return { text, values };
}

const TABLES: TableMigration[] = [
  // ─── atoms (first, no FK deps) ───
  {
    name: "atoms",
    sqliteTable: "atoms",
    pgTable: "atoms",
    hasSerial: false,
    transform(row) {
      const embedding = row.embedding
        ? embeddingToVector(deserializeEmbedding(row.embedding as Buffer))
        : null;
      return {
        id: row.id,
        schema_version: row.schema_version ?? 1,
        profile: row.profile ?? "standard",
        stream: row.stream ?? "semantic",
        content: row.content,
        content_hash: row.content_hash,
        created_at: parseTimestamp(row.created_at as string),
        last_accessed_at: parseTimestamp(row.last_accessed_at as string),
        access_count: row.access_count ?? 0,
        stability: row.stability ?? 1.0,
        retrievability: row.retrievability ?? 1.0,
        arousal: row.arousal ?? 0.5,
        valence: row.valence ?? 0.0,
        topics: parseJsonb(row.topics as string) ?? [],
        encoding_confidence: row.encoding_confidence ?? 0.7,
        provisional: intToBool(row.provisional as number),
        source_type: row.source_type ?? "conversation",
        state: row.state ?? "active",
        embedding,
        metadata: parseJsonb(row.metadata as string) ?? {},
        agent_id: row.agent_id ?? "default",
        embedding_provider: row.embedding_provider ?? null,
        is_pinned: intToBool(row.is_pinned as number),
        session_id: row.session_id ?? null,
        working_expires_at: row.working_expires_at ?? null,
        outcome_score: row.outcome_score ?? 0.0,
        outcome_count: row.outcome_count ?? 0,
        last_outcome_at: parseTimestamp(row.last_outcome_at as string),
      };
    },
    insertSql(rows) {
      return buildInsert("atoms", [
        "id", "schema_version", "profile", "stream", "content", "content_hash",
        "created_at", "last_accessed_at", "access_count", "stability", "retrievability",
        "arousal", "valence", "topics", "encoding_confidence", "provisional",
        "source_type", "state", "embedding", "metadata", "agent_id",
        "embedding_provider", "is_pinned", "session_id", "working_expires_at",
        "outcome_score", "outcome_count", "last_outcome_at",
      ], rows);
    },
  },

  // ─── agents (no FK deps) ───
  {
    name: "agents",
    sqliteTable: "agents",
    pgTable: "agents",
    hasSerial: false,
    transform(row) {
      return {
        id: row.id,
        name: row.name ?? null,
        created_at: parseTimestamp(row.created_at as string),
        metadata: parseJsonb(row.metadata as string),
      };
    },
    insertSql(rows) {
      return buildInsert("agents", ["id", "name", "created_at", "metadata"], rows);
    },
  },

  // ─── schema_version (no FK deps) ───
  {
    name: "schema_version",
    sqliteTable: "schema_version",
    pgTable: "schema_version",
    hasSerial: false,
    transform(row) {
      return { version: row.version };
    },
    insertSql(rows) {
      return buildInsert("schema_version", ["version"], rows);
    },
  },

  // ─── atom_topics (FK → atoms) ───
  {
    name: "atom_topics",
    sqliteTable: "atom_topics",
    pgTable: "atom_topics",
    hasSerial: false,
    transform(row) {
      return { atom_id: row.atom_id, topic: row.topic };
    },
    insertSql(rows) {
      return buildInsert("atom_topics", ["atom_id", "topic"], rows);
    },
  },

  // ─── access_log (FK → atoms, has serial) ───
  {
    name: "access_log",
    sqliteTable: "access_log",
    pgTable: "access_log",
    hasSerial: true,
    transform(row) {
      return {
        id: row.id,
        atom_id: row.atom_id,
        accessed_at: parseTimestamp(row.accessed_at as string),
        activation_score: row.activation_score ?? null,
        retrieval_mode: row.retrieval_mode ?? null,
        contributed: row.contributed ?? -1,
      };
    },
    insertSql(rows) {
      return buildInsert("access_log", [
        "id", "atom_id", "accessed_at", "activation_score", "retrieval_mode", "contributed",
      ], rows);
    },
  },

  // ─── corrections (FK → atoms) ───
  {
    name: "corrections",
    sqliteTable: "corrections",
    pgTable: "corrections",
    hasSerial: false,
    transform(row) {
      return {
        id: row.id,
        original_atom_id: row.original_atom_id,
        correction_content: row.correction_content,
        reason: row.reason ?? null,
        created_at: parseTimestamp(row.created_at as string),
      };
    },
    insertSql(rows) {
      return buildInsert("corrections", [
        "id", "original_atom_id", "correction_content", "reason", "created_at",
      ], rows);
    },
  },

  // ─── triples (FK → atoms) ───
  {
    name: "triples",
    sqliteTable: "triples",
    pgTable: "triples",
    hasSerial: false,
    transform(row) {
      const embedding = row.embedding
        ? embeddingToVector(deserializeEmbedding(row.embedding as Buffer))
        : null;
      return {
        id: row.id,
        atom_id: row.atom_id,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        confidence: row.confidence ?? 1.0,
        state: row.state ?? "active",
        embedding,
        created_at: parseTimestamp(row.created_at as string),
      };
    },
    insertSql(rows) {
      return buildInsert("triples", [
        "id", "atom_id", "subject", "predicate", "object",
        "confidence", "state", "embedding", "created_at",
      ], rows);
    },
  },

  // ─── co_retrieval (has serial) ───
  {
    name: "co_retrieval",
    sqliteTable: "co_retrieval",
    pgTable: "co_retrieval",
    hasSerial: true,
    transform(row) {
      return {
        id: row.id,
        atom_a: row.atom_a,
        atom_b: row.atom_b,
        co_count: row.co_count ?? 1,
        last_co_retrieval: parseTimestamp(row.last_co_retrieval as string),
        session_id: row.session_id ?? null,
      };
    },
    insertSql(rows) {
      return buildInsert("co_retrieval", [
        "id", "atom_a", "atom_b", "co_count", "last_co_retrieval", "session_id",
      ], rows);
    },
  },

  // ─── negative_knowledge (has serial) ───
  {
    name: "negative_knowledge",
    sqliteTable: "negative_knowledge",
    pgTable: "negative_knowledge",
    hasSerial: true,
    transform(row) {
      return {
        id: row.id,
        query: row.query,
        domain: row.domain ?? null,
        result: row.result ?? "empty",
        searched_at: parseTimestamp(row.searched_at as string),
        expires_at: parseTimestamp(row.expires_at as string),
        notes: row.notes ?? null,
      };
    },
    insertSql(rows) {
      return buildInsert("negative_knowledge", [
        "id", "query", "domain", "result", "searched_at", "expires_at", "notes",
      ], rows);
    },
  },

  // ─── provenance (has serial) ───
  {
    name: "provenance",
    sqliteTable: "provenance",
    pgTable: "provenance",
    hasSerial: true,
    transform(row) {
      return {
        id: row.id,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        parent_type: row.parent_type ?? null,
        parent_id: row.parent_id ?? null,
        action: row.action,
        source: row.source ?? null,
        timestamp: parseTimestamp(row.timestamp as string),
        metadata: parseJsonb(row.metadata as string) ?? {},
      };
    },
    insertSql(rows) {
      return buildInsert("provenance", [
        "id", "entity_type", "entity_id", "parent_type", "parent_id",
        "action", "source", "timestamp", "metadata",
      ], rows);
    },
  },

  // ─── forgetting_log (has serial) ───
  {
    name: "forgetting_log",
    sqliteTable: "forgetting_log",
    pgTable: "forgetting_log",
    hasSerial: true,
    transform(row) {
      return {
        id: row.id,
        atom_id: row.atom_id,
        previous_state: row.previous_state,
        new_state: row.new_state,
        reason: row.reason,
        factors: parseJsonb(row.factors as string) ?? {},
        timestamp: parseTimestamp(row.timestamp as string),
      };
    },
    insertSql(rows) {
      return buildInsert("forgetting_log", [
        "id", "atom_id", "previous_state", "new_state", "reason", "factors", "timestamp",
      ], rows);
    },
  },

  // ─── atom_versions (has serial) ───
  {
    name: "atom_versions",
    sqliteTable: "atom_versions",
    pgTable: "atom_versions",
    hasSerial: true,
    transform(row) {
      return {
        id: row.id,
        atom_id: row.atom_id,
        version: row.version,
        content: row.content,
        changed_by: row.changed_by ?? null,
        change_reason: row.change_reason ?? null,
        timestamp: parseTimestamp(row.timestamp as string),
        metadata: parseJsonb(row.metadata as string) ?? {},
      };
    },
    insertSql(rows) {
      return buildInsert("atom_versions", [
        "id", "atom_id", "version", "content", "changed_by", "change_reason", "timestamp", "metadata",
      ], rows);
    },
  },

  // ─── atom_relations (has serial) ───
  {
    name: "atom_relations",
    sqliteTable: "atom_relations",
    pgTable: "atom_relations",
    hasSerial: true,
    transform(row) {
      return {
        id: row.id,
        source_id: row.source_id,
        target_id: row.target_id,
        relation_type: row.relation_type,
        confidence: row.confidence ?? 0.8,
        created_at: parseTimestamp(row.created_at as string),
        metadata: parseJsonb(row.metadata as string) ?? {},
      };
    },
    insertSql(rows) {
      return buildInsert("atom_relations", [
        "id", "source_id", "target_id", "relation_type", "confidence", "created_at", "metadata",
      ], rows);
    },
  },

  // ─── retrieval_outcomes (has serial) ───
  {
    name: "retrieval_outcomes",
    sqliteTable: "retrieval_outcomes",
    pgTable: "retrieval_outcomes",
    hasSerial: true,
    transform(row) {
      return {
        id: row.id,
        session_id: row.session_id ?? null,
        atom_ids: row.atom_ids,
        query: row.query ?? null,
        feedback: row.feedback ?? null,
        feedback_at: parseTimestamp(row.feedback_at as string),
        created_at: parseTimestamp(row.created_at as string),
      };
    },
    insertSql(rows) {
      return buildInsert("retrieval_outcomes", [
        "id", "session_id", "atom_ids", "query", "feedback", "feedback_at", "created_at",
      ], rows);
    },
  },

  // ─── temporal_patterns (has serial) ───
  {
    name: "temporal_patterns",
    sqliteTable: "temporal_patterns",
    pgTable: "temporal_patterns",
    hasSerial: true,
    transform(row) {
      return {
        id: row.id,
        atom_id: row.atom_id,
        hour_of_day: row.hour_of_day ?? null,
        day_of_week: row.day_of_week ?? null,
        retrieval_count: row.retrieval_count ?? 1,
        last_retrieved_at: parseTimestamp(row.last_retrieved_at as string),
      };
    },
    insertSql(rows) {
      return buildInsert("temporal_patterns", [
        "id", "atom_id", "hour_of_day", "day_of_week", "retrieval_count", "last_retrieved_at",
      ], rows);
    },
  },

  // ─── sentence_embeddings ───
  {
    name: "sentence_embeddings",
    sqliteTable: "sentence_embeddings",
    pgTable: "sentence_embeddings",
    hasSerial: false,
    transform(row) {
      const embedding = row.embedding
        ? embeddingToVector(deserializeEmbedding(row.embedding as Buffer))
        : null;
      return {
        atom_id: row.atom_id,
        sentence_idx: row.sentence_idx,
        sentence: row.sentence,
        embedding,
        token_count: row.token_count ?? null,
      };
    },
    insertSql(rows) {
      return buildInsert("sentence_embeddings", [
        "atom_id", "sentence_idx", "sentence", "embedding", "token_count",
      ], rows);
    },
  },

  // ─── retrieval_feedback (has serial) ───
  {
    name: "retrieval_feedback",
    sqliteTable: "retrieval_feedback",
    pgTable: "retrieval_feedback",
    hasSerial: true,
    transform(row) {
      return {
        id: row.id,
        query: row.query,
        atom_id: row.atom_id,
        retrieved_rank: row.retrieved_rank ?? null,
        was_used: row.was_used == null ? null : intToBool(row.was_used as number),
        similarity: row.similarity ?? null,
        created_at: parseTimestamp(row.created_at as string),
      };
    },
    insertSql(rows) {
      return buildInsert("retrieval_feedback", [
        "id", "query", "atom_id", "retrieved_rank", "was_used", "similarity", "created_at",
      ], rows);
    },
  },
];

export { deserializeEmbedding, embeddingToVector, parseTimestamp, intToBool, parseJsonb, cosineSimilarity };

// ─── Main (only runs when executed directly) ───

const BATCH_SIZE = 500;

const isDirectExecution =
  process.argv[1]?.endsWith("migrate-from-sqlite.ts") ||
  process.argv[1]?.endsWith("migrate-from-sqlite.js");

if (isDirectExecution) {
  const { values: args } = parseArgs({
    options: {
      sqlite: { type: "string" },
      pg: { type: "string" },
      force: { type: "boolean", default: false },
      "verify-only": { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!args.sqlite) {
    console.error("Usage: migrate-from-sqlite --sqlite <path> [--pg <url>] [--force] [--verify-only]");
    process.exit(1);
  }

  const pgUrl = args.pg ?? process.env.DATABASE_URL;
  if (!pgUrl) {
    console.error("No PostgreSQL URL. Provide --pg <url> or set DATABASE_URL.");
    process.exit(1);
  }

  async function main() {
    const sqliteDb = new Database(args.sqlite!, { readonly: true });
    const pool = new pg.Pool({ connectionString: pgUrl, max: 5 });
    const client = await pool.connect();

    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");

      if (args["verify-only"]) {
        await verify(sqliteDb, client);
        return;
      }

      const atomCount = await client.query("SELECT COUNT(*) as cnt FROM atoms");
      const existingCount = parseInt(atomCount.rows[0].cnt, 10);

      if (existingCount > 0 && !args.force) {
        console.log(`PostgreSQL already has ${existingCount} atoms. Use --force to truncate and re-migrate.`);
        process.exit(0);
      }

      if (args.force && existingCount > 0) {
        console.log("--force: truncating all tables...");
        const truncateOrder = [
          "retrieval_feedback", "sentence_embeddings", "temporal_patterns",
          "retrieval_outcomes", "atom_relations", "atom_versions", "forgetting_log",
          "provenance", "negative_knowledge", "co_retrieval", "triples",
          "corrections", "access_log", "atom_topics", "schema_version",
          "agents", "atoms",
        ];
        for (const table of truncateOrder) {
          await client.query(`TRUNCATE "${table}" CASCADE`);
        }
        console.log("Truncated all tables.");
      }

      for (const table of TABLES) {
        const rows = sqliteDb.prepare(`SELECT * FROM "${table.sqliteTable}"`).all() as Record<string, unknown>[];
        const total = rows.length;

        if (total === 0) {
          console.log(`${table.name}: 0 rows (skipped)`);
          continue;
        }

        let migrated = 0;

        for (let i = 0; i < total; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          const transformed = batch.map(table.transform);
          const { text, values } = table.insertSql(transformed);

          await client.query(text, values);
          migrated += batch.length;
          process.stdout.write(`\rMigrated ${table.name}: ${migrated}/${total}`);
        }

        if (table.hasSerial) {
          await client.query(
            `SELECT setval(pg_get_serial_sequence('"${table.pgTable}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table.pgTable}"), 0) + 1, false)`,
          );
        }

        console.log(`\rMigrated ${table.name}: ${migrated}/${total}`);
      }

      console.log("\nMigration complete. Running verification...\n");
      await verify(sqliteDb, client);
    } finally {
      client.release();
      await pool.end();
      sqliteDb.close();
    }
  }

  async function verify(sqliteDb: Database.Database, client: pg.PoolClient) {
    console.log("─── Row Count Verification ───");

    let allMatch = true;

    for (const table of TABLES) {
      const sqliteCount = (
        sqliteDb.prepare(`SELECT COUNT(*) as cnt FROM "${table.sqliteTable}"`).get() as { cnt: number }
      ).cnt;
      const pgResult = await client.query(`SELECT COUNT(*) as cnt FROM "${table.pgTable}"`);
      const pgCount = parseInt(pgResult.rows[0].cnt, 10);

      const status = sqliteCount === pgCount ? "OK" : "MISMATCH";
      if (status === "MISMATCH") allMatch = false;
      console.log(`  ${table.name}: SQLite=${sqliteCount} PG=${pgCount} [${status}]`);
    }

    console.log("\n─── Embedding Verification ───");

    const atomsWithEmbeddings = sqliteDb
      .prepare("SELECT id, embedding FROM atoms WHERE embedding IS NOT NULL ORDER BY RANDOM() LIMIT 50")
      .all() as { id: string; embedding: Buffer }[];

    if (atomsWithEmbeddings.length === 0) {
      console.log("  No atoms with embeddings to verify.");
    } else {
      let minSim = 1.0;
      let verified = 0;

      for (const row of atomsWithEmbeddings) {
        const sqliteVec = deserializeEmbedding(row.embedding);

        const pgResult = await client.query(
          `SELECT embedding::text FROM atoms WHERE id = $1`,
          [row.id],
        );

        if (!pgResult.rows[0]?.embedding) {
          console.log(`  WARN: atom ${row.id} has no PG embedding`);
          allMatch = false;
          continue;
        }

        const pgVecStr = pgResult.rows[0].embedding as string;
        const pgVec = pgVecStr
          .replace(/[\[\]]/g, "")
          .split(",")
          .map(Number);

        const sim = cosineSimilarity(sqliteVec, pgVec);
        if (sim < minSim) minSim = sim;

        if (sim < 0.999999) {
          console.log(`  FAIL: atom ${row.id} similarity=${sim}`);
          allMatch = false;
        }

        verified++;
      }

      console.log(`  Verified ${verified} embeddings, min similarity: ${minSim.toFixed(9)}`);
    }

    console.log(`\n─── Result: ${allMatch ? "ALL PASSED" : "FAILURES DETECTED"} ───`);

    if (!allMatch) process.exit(1);
  }

  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
