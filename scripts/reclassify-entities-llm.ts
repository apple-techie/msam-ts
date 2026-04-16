/**
 * One-shot LLM reclassification of existing entities into the open ontology.
 *
 * Reads every DISTINCT entity name from `triples`, asks the LLM to pick a
 * specific Title_Case type, then updates subject_type / object_type columns
 * in bulk.
 *
 * Usage:
 *   DATABASE_URL=... OPENAI_API_KEY=... tsx scripts/reclassify-entities-llm.ts
 *
 * Safe to re-run: only updates rows whose type is currently NULL or one of the
 * coarse fallback types (Person, Organization, Technology, Concept, Location,
 * Entity). Triples the LLM has already classified with specific types are left
 * alone unless --force is passed.
 */

import { Pool } from "pg";

const BATCH_SIZE = 50;
const CONCURRENCY = 3;
const COARSE_TYPES = new Set(["Person", "Organization", "Technology", "Concept", "Location", "Entity", "unknown", null]);

const LLM_URL = process.env.LLM_URL || "https://api.openai.com/v1/chat/completions";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;

if (!LLM_API_KEY) {
  console.error("LLM_API_KEY (or OPENAI_API_KEY) required");
  process.exit(1);
}

const PROMPT = `Classify each entity with the most SPECIFIC type that fits. Use Title_Case_With_Underscores, singular.

Types can be anything natural. Examples:
  Person, Founder, Investor, Engineer, Partner
  Organization, Startup, VC_Firm, LLC, Agency, Bank, Cafe
  Agent, Bot, AI_Agent, Orchestrator, Worker
  SaaS, Library, Framework, Database, API, Endpoint
  Codebase, Repository, Fork, Package
  Gateway, Server, Node, Container
  Infrastructure, Hardware, Cloud, Device
  Dashboard, Widget, UI_Component, Page
  Automation, Workflow, Cron_Job, Pipeline, Script
  Document, Note, Email, Message, Thread, Post, Reel, Campaign
  Meeting, Call, Event, Deadline
  Role, Skill, Concept, Principle
  Location, City, Office
  Project, Initiative, Milestone
  Task, Issue, Bug, PR
  Commodity, Product, Jewelry

Prefer SPECIFIC over generic. Stripe is SaaS, not "Technology". Aurora is AI_Agent, not "Technology".

Input: one entity name per line.
Output: one line per entity in the format \`NAME\\tTYPE\` — nothing else. No numbering, no prose.`;

async function classifyBatch(names: string[]): Promise<Record<string, string>> {
  // Retry 503 (provider rate-limit) and 429 with exponential backoff up to 4 tries.
  const MAX_RETRIES = 4;
  let res: Response | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    res = await fetch(LLM_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${LLM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: names.join("\n") },
        ],
        temperature: 0.1,
        max_tokens: 4000,
        stream: false,
      }),
    });
    if (res.status !== 503 && res.status !== 429) break;
    const backoffMs = 1500 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
    await new Promise((r) => setTimeout(r, backoffMs));
  }

  if (!res || !res.ok) {
    const bodyForLog = res ? await res.text().catch(() => "") : "no response";
    console.error(`LLM call failed: ${res?.status ?? "?"} ${bodyForLog.slice(0, 200)}`);
    return {};
  }

  // Some proxies return SSE even when we ask for non-streaming; handle both.
  const bodyText = await res.text();
  let text = "";
  if (bodyText.trimStart().startsWith("{")) {
    try {
      const data = JSON.parse(bodyText) as { choices: Array<{ message: { content: string } }> };
      text = data.choices[0]?.message?.content ?? "";
    } catch (e) {
      console.error("JSON parse failed:", (e as Error).message);
      return {};
    }
  } else {
    // SSE: collect .choices[0].delta.content across events
    for (const line of bodyText.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        const delta = evt.choices?.[0]?.delta?.content ?? evt.choices?.[0]?.message?.content;
        if (typeof delta === "string") text += delta;
      } catch {}
    }
  }

  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Accept "NAME\tTYPE" or "NAME - TYPE" or "NAME: TYPE"
    const m = trimmed.match(/^(.+?)[\t:\- ]+(\S+)\s*$/);
    if (!m) continue;
    const name = m[1].trim();
    const type = m[2].trim().replace(/[\[\]]/g, "");
    if (name && type) out[name] = type;
  }
  return out;
}

// Short all-uppercase tokens are acronyms — preserve them as-is.
const KNOWN_ACRONYMS = new Set(["AI", "API", "UI", "UX", "SDK", "CLI", "PR", "VC", "LLC", "CEO", "CTO", "CFO", "KB", "DB", "URL", "SQL", "JSON", "SSE", "REST"]);

function normalizeType(t: string): string | null {
  if (!t) return null;
  let cleaned = t.replace(/[^\w-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (!cleaned || cleaned.length > 40) return null;
  const parts = cleaned.split(/[_\-]/).filter(Boolean);
  return parts
    .map((p) => {
      if (KNOWN_ACRONYMS.has(p.toUpperCase())) return p.toUpperCase();
      if (/[a-z]/.test(p) && /[A-Z]/.test(p)) return p; // mixed case — leave alone (SaaS, VC_Firm)
      return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    })
    .join("_");
}

async function main() {
  const force = process.argv.includes("--force");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required");

  const pool = new Pool({ connectionString: dbUrl });

  // Pick entities that need reclassification: NULL type, or currently one of
  // the coarse fallback types (the results of my earlier rule-based backfill).
  const needingClassification = await pool.query<{ name: string }>(
    force
      ? `SELECT DISTINCT subject AS name FROM triples
         UNION
         SELECT DISTINCT object AS name FROM triples`
      : `SELECT DISTINCT subject AS name FROM triples
         WHERE subject_type IS NULL OR subject_type = ANY($1)
         UNION
         SELECT DISTINCT object AS name FROM triples
         WHERE object_type IS NULL OR object_type = ANY($1)`,
    force ? undefined : [["Person", "Organization", "Technology", "Concept", "Location", "Entity", "unknown"]],
  );

  const names = needingClassification.rows.map((r) => r.name).filter((n) => n && n.length > 0);
  console.log(`Entities to classify: ${names.length}`);
  if (names.length === 0) {
    await pool.end();
    return;
  }

  const assigned: Record<string, string> = {};
  let processed = 0;

  // Split into batches, then run CONCURRENCY batches in parallel.
  const batches: string[][] = [];
  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    batches.push(names.slice(i, i + BATCH_SIZE));
  }
  console.log(`${batches.length} batches of up to ${BATCH_SIZE}, concurrency ${CONCURRENCY}`);

  let nextIdx = 0;
  async function worker(workerId: number) {
    while (nextIdx < batches.length) {
      const idx = nextIdx++;
      const batch = batches[idx];
      const t0 = Date.now();
      const result = await classifyBatch(batch);
      let hits = 0;
      for (const name of batch) {
        const raw = result[name];
        const norm = raw ? normalizeType(raw) : null;
        if (norm) { assigned[name] = norm; hits++; }
      }
      processed += batch.length;
      const ms = Date.now() - t0;
      console.log(`  [w${workerId}] batch ${idx + 1}/${batches.length}: ${hits}/${batch.length} (${ms}ms, total ${processed}/${names.length})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));

  console.log(`\nLLM assigned ${Object.keys(assigned).length} types. Applying to DB...`);

  // Group by type → one UPDATE per type with IN (...) for efficient batched updates.
  const byType: Record<string, string[]> = {};
  for (const [name, type] of Object.entries(assigned)) {
    (byType[type] ??= []).push(name);
  }

  let updated = 0;
  for (const [type, namesOfType] of Object.entries(byType)) {
    const CHUNK = 400;
    for (let i = 0; i < namesOfType.length; i += CHUNK) {
      const slice = namesOfType.slice(i, i + CHUNK);
      const r1 = await pool.query(
        "UPDATE triples SET subject_type = $1 WHERE subject = ANY($2)",
        [type, slice],
      );
      const r2 = await pool.query(
        "UPDATE triples SET object_type = $1 WHERE object = ANY($2)",
        [type, slice],
      );
      updated += (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    }
  }

  const distribution: Record<string, number> = {};
  for (const t of Object.values(assigned)) distribution[t] = (distribution[t] ?? 0) + 1;
  const top = Object.entries(distribution).sort((a, b) => b[1] - a[1]).slice(0, 30);
  console.log(`\nUpdated ${updated} columns across ${Object.keys(distribution).length} distinct types.`);
  console.log("Top 30 types by entity count:");
  for (const [t, n] of top) console.log(`  ${t.padEnd(30)} ${n}`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
