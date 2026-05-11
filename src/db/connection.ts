import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

let pool: pg.Pool | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    pool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on("error", (err) => {
      console.error("Unexpected PostgreSQL pool error:", err.message);
      // Don't crash — the pool will attempt to reconnect
    });
  }
  return pool;
}

export function getDb() {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}

export async function initExtensions(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  } finally {
    client.release();
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    const client = await getPool().connect();
    try {
      const result = await client.query("SELECT 1 AS ok");
      return result.rows[0]?.ok === 1;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}

export async function shutdown(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
