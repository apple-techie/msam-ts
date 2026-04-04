/**
 * Integration tests against a real PostgreSQL + pgvector instance.
 * Requires: docker compose up -d msam-db
 * DATABASE_URL=postgresql://msam:msam@localhost:5433/msam
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://msam:msam@localhost:5433/msam";

let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query("DELETE FROM access_log");
  await pool.query("DELETE FROM atom_topics");
  await pool.query("DELETE FROM atom_relations");
  await pool.query("DELETE FROM triples");
  await pool.query("DELETE FROM corrections");
  await pool.query("DELETE FROM atoms");
});

function randomVector(dim: number): number[] {
  const vec = Array.from({ length: dim }, () => Math.random() * 2 - 1);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

function vectorToText(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

describe("pgvector integration", () => {
  it("stores and retrieves a vector", async () => {
    const vec = randomVector(1536);
    await pool.query(
      `INSERT INTO atoms (id, content, content_hash, agent_id, stream, profile, state, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
      ["test-1", "test content", "hash1", "enduru", "semantic", "standard", "active", vectorToText(vec)]
    );

    const result = await pool.query(
      `SELECT id, embedding::text FROM atoms WHERE id = $1`,
      ["test-1"]
    );
    expect(result.rows.length).toBe(1);

    const stored = result.rows[0].embedding
      .replace(/[\[\]]/g, "")
      .split(",")
      .map(Number);
    expect(stored.length).toBe(1536);

    // Verify float32 precision — pgvector stores as float32
    for (let i = 0; i < 10; i++) {
      expect(stored[i]).toBeCloseTo(vec[i], 5);
    }
  });

  it("performs cosine similarity search", async () => {
    // Use deterministic vectors: target is [1,0,0,...], similar is [0.99,0.1,0,...], orthogonal is [0,1,0,...]
    const target = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1.0 : 0.0));

    // Similar: mostly aligned with target
    const rawSimilar = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 0.99 : i === 1 ? 0.1 : 0.0));
    const normSim = Math.sqrt(rawSimilar.reduce((s, v) => s + v * v, 0));
    const normalizedSimilar = rawSimilar.map((v) => v / normSim);

    // Orthogonal: perpendicular to target
    const orthogonal = Array.from({ length: 1536 }, (_, i) => (i === 1 ? 1.0 : 0.0));

    await pool.query(
      `INSERT INTO atoms (id, content, content_hash, agent_id, stream, profile, state, embedding)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8::vector),
         ($9, $10, $11, $12, $13, $14, $15, $16::vector),
         ($17, $18, $19, $20, $21, $22, $23, $24::vector)`,
      [
        "atom-target", "target content", "h1", "enduru", "semantic", "standard", "active", vectorToText(target),
        "atom-similar", "similar content", "h2", "enduru", "semantic", "standard", "active", vectorToText(normalizedSimilar),
        "atom-ortho", "orthogonal content", "h3", "enduru", "semantic", "standard", "active", vectorToText(orthogonal),
      ]
    );

    // Search for atoms similar to target
    const result = await pool.query(
      `SELECT id, 1 - (embedding <=> $1::vector) AS similarity
       FROM atoms
       WHERE state = 'active' AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT 3`,
      [vectorToText(target)]
    );

    expect(result.rows.length).toBe(3);
    // Results sorted by similarity descending
    const sims = result.rows.map((r: any) => Number(r.similarity));
    for (let i = 1; i < sims.length; i++) {
      expect(sims[i]).toBeLessThanOrEqual(sims[i - 1]);
    }
    // Target should have near-perfect similarity
    const targetRow = result.rows.find((r: any) => r.id === "atom-target");
    expect(targetRow).toBeDefined();
    expect(Number(targetRow!.similarity)).toBeGreaterThan(0.99);

    // Similar vector should have high similarity
    const similarRow = result.rows.find((r: any) => r.id === "atom-similar");
    expect(similarRow).toBeDefined();
    expect(Number(similarRow!.similarity)).toBeGreaterThan(0.8);
  });

  it("filters by agent_id in similarity search", async () => {
    const vec = randomVector(1536);

    await pool.query(
      `INSERT INTO atoms (id, content, content_hash, agent_id, stream, profile, state, embedding)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8::vector),
         ($9, $10, $11, $12, $13, $14, $15, $16::vector)`,
      [
        "a1", "enduru atom", "h1", "enduru", "semantic", "standard", "active", vectorToText(vec),
        "a2", "turkules atom", "h2", "turkules", "semantic", "standard", "active", vectorToText(vec),
      ]
    );

    const result = await pool.query(
      `SELECT id FROM atoms
       WHERE state = 'active' AND agent_id = $1 AND embedding IS NOT NULL
       ORDER BY embedding <=> $2::vector LIMIT 10`,
      ["enduru", vectorToText(vec)]
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].id).toBe("a1");
  });

  it("handles JSONB metadata", async () => {
    const meta = { source: "conversation", channel: "telegram", tags: ["important", "personal"] };

    await pool.query(
      `INSERT INTO atoms (id, content, content_hash, agent_id, stream, profile, state, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      ["meta-1", "test", "hm", "enduru", "semantic", "standard", "active", JSON.stringify(meta)]
    );

    const result = await pool.query(
      `SELECT metadata FROM atoms WHERE id = $1`,
      ["meta-1"]
    );
    expect(result.rows[0].metadata).toEqual(meta);
  });

  it("stores and queries triples", async () => {
    await pool.query(
      `INSERT INTO atoms (id, content, content_hash, agent_id, stream, profile, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["src-atom", "Drew is the founder of Kainotomic", "ht", "enduru", "semantic", "standard", "active"]
    );

    await pool.query(
      `INSERT INTO triples (id, atom_id, subject, predicate, object, confidence, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["t1", "src-atom", "Drew", "is_founder_of", "Kainotomic", 0.95, "active"]
    );

    const result = await pool.query(
      `SELECT subject, predicate, object, confidence
       FROM triples WHERE subject = $1 AND state = 'active'`,
      ["Drew"]
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].predicate).toBe("is_founder_of");
    expect(result.rows[0].object).toBe("Kainotomic");
    expect(Number(result.rows[0].confidence)).toBeCloseTo(0.95, 2);
  });

  it("tracks access_log entries", async () => {
    await pool.query(
      `INSERT INTO atoms (id, content, content_hash, agent_id, stream, profile, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["log-atom", "test content", "hl", "enduru", "semantic", "standard", "active"]
    );

    await pool.query(
      `INSERT INTO access_log (atom_id, activation_score, retrieval_mode)
       VALUES ($1, $2, $3)`,
      ["log-atom", 2.45, "task"]
    );

    const result = await pool.query(
      `SELECT COUNT(*) as cnt, MAX(activation_score) as max_score
       FROM access_log WHERE atom_id = $1`,
      ["log-atom"]
    );
    expect(Number(result.rows[0].cnt)).toBe(1);
    expect(Number(result.rows[0].max_score)).toBeCloseTo(2.45, 2);
  });

  it("enforces content_hash + agent_id uniqueness for active atoms", async () => {
    await pool.query(
      `INSERT INTO atoms (id, content, content_hash, agent_id, stream, profile, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["dup-1", "same content", "same_hash", "enduru", "semantic", "standard", "active"]
    );

    // Same content_hash + agent_id should fail for active state
    await expect(
      pool.query(
        `INSERT INTO atoms (id, content, content_hash, agent_id, stream, profile, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ["dup-2", "same content", "same_hash", "enduru", "semantic", "standard", "active"]
      )
    ).rejects.toThrow();

    // Different agent_id should succeed
    await pool.query(
      `INSERT INTO atoms (id, content, content_hash, agent_id, stream, profile, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["dup-3", "same content", "same_hash", "turkules", "semantic", "standard", "active"]
    );
  });

  it("performs IVFFlat indexed search at scale", async () => {
    // Insert 200 atoms to test IVFFlat index behavior
    const values: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    for (let i = 0; i < 200; i++) {
      const vec = randomVector(1536);
      values.push(
        `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}::vector)`
      );
      params.push(
        `scale-${i}`, `content ${i}`, `hash-${i}`, "enduru",
        "semantic", "standard", "active", vectorToText(vec)
      );
    }

    await pool.query(
      `INSERT INTO atoms (id, content, content_hash, agent_id, stream, profile, state, embedding)
       VALUES ${values.join(",")}`,
      params
    );

    // Build IVFFlat index (requires at least some data)
    try {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_atoms_embedding_ivfflat
         ON atoms USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10)`
      );
    } catch {
      // Index may already exist from schema push
    }

    const query = randomVector(1536);
    const result = await pool.query(
      `SELECT id, 1 - (embedding <=> $1::vector) AS similarity
       FROM atoms WHERE state = 'active' AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector LIMIT 5`,
      [vectorToText(query)]
    );

    expect(result.rows.length).toBe(5);
    // Results should be sorted by similarity (descending)
    for (let i = 1; i < result.rows.length; i++) {
      expect(Number(result.rows[i].similarity)).toBeLessThanOrEqual(
        Number(result.rows[i - 1].similarity)
      );
    }
  });
});
