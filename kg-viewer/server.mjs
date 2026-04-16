/**
 * kg-viewer — Live Knowledge Graph Visualizer
 * 
 * Data sources:
 *   1. MSAM triples (http://127.0.0.1:3901/v1/triples)
 *   2. Goose KG memory (JSONL file, if available)
 * 
 * Polls MSAM every 30s, watches JSONL for live changes.
 * Serves force-directed D3 graph on port 7780.
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7780;
const MSAM_URL = process.env.MSAM_URL || "http://msam:3901";
const MSAM_HEADERS = { "Content-Type": "application/json", "X-API-Key": process.env.MSAM_API_KEY || "" };
const POLL_INTERVAL_MS = 300_000; // 5 minutes (was 30s, caused access_log bloat)
const GRAPH_ACCEL_URL = process.env.GRAPH_ACCEL_URL || "http://msam-graph-accelerator:3902";

const AGENT_TRIPLES_FILE = "/app/agent-triples.json";

function loadAgentData() {
  try {
    if (!fs.existsSync(AGENT_TRIPLES_FILE)) return null;
    return JSON.parse(fs.readFileSync(AGENT_TRIPLES_FILE, "utf-8"));
  } catch { return null; }
}

// Optional: Goose KG memory JSONL
const GOOSE_KG_FILE = path.join(
  process.env.HOME,
  ".config/goose/memory/memory.jsonl"
);

const log = (...args) =>
  console.log(`[kg-viewer ${new Date().toISOString().slice(11, 19)}]`, ...args);

// ── State ────────────────────────────────────────────────────────────────────

let graphData = { entities: [], relations: [], meta: {} };
const clients = new Set();

// ── MSAM Data Fetch ──────────────────────────────────────────────────────────

async function fetchMsamTriples(agentId) {
  try {
    const res = await fetch(`${MSAM_URL}/v1/stats`, { headers: MSAM_HEADERS });
    if (!res.ok) return { triples: [], stats: null };
    const stats = await res.json();

    // Get all distinct entities from the triples table via a raw SQL approach:
    // We'll query the top connected entities and their triples.
    // MSAM's /v1/triples/graph/{entity} returns hops from one entity,
    // so we need to get ALL triples directly from the DB.
    // Use a bulk query approach: fetch top entities and their neighborhoods.
    
    // Strategy: query triples for the top 50 entities by connection count
    const topRes = await fetch(`${MSAM_URL}/v1/query`, {
      method: "POST",
      headers: MSAM_HEADERS,
      body: JSON.stringify({
        query: "all entities people projects organizations",
        top_k: 1, // we just need to trigger the API, we'll use triples directly
      }),
    });

    // Instead, let's use a smarter approach:
    // Fetch graph neighborhoods for key seed entities
    const agentData = loadAgentData();
    if (agentId) {
      if (agentData && agentData.agent_triples && agentData.agent_triples[agentId]) {
        return { triples: agentData.agent_triples[agentId], stats };
      }
      return { triples: [], stats };
    }

    // All Agents: aggregate all triples from export file
    if (agentData && agentData.agent_triples) {
      const allTriples = [];
      const seen = new Set();
      for (const [aid, triples] of Object.entries(agentData.agent_triples)) {
        for (const t of triples) {
          const key = t.subject + "|" + t.predicate + "|" + t.object;
          if (!seen.has(key)) {
            seen.add(key);
            allTriples.push(t);
          }
        }
      }
      if (allTriples.length > 0) {
        return { triples: allTriples, stats };
      }
    }

    const FALLBACK_SEEDS = [
      "Drew", "Kainotomic", "Enduru AI", "Ryan", "User",
      "LetsDisagree", "Vercel", "Stripe", "HubSpot", "Aurora",
      "Mark Fulton", "Justin Walker", "Sannidhya Sah",
    ];

    let seeds = FALLBACK_SEEDS;
    try {
      const accelRes = await fetch(`${GRAPH_ACCEL_URL}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cypher: "MATCH (n:Entity) WITH n, size([(n)-[]-() | 1]) AS degree RETURN n.name AS name ORDER BY degree DESC LIMIT 30",
        }),
      });
      if (accelRes.ok) {
        const accelData = await accelRes.json();
        const dynamicSeeds = (accelData.results || [])
          .map((r) => r.name)
          .filter((n) => n && n.length > 1);
        if (dynamicSeeds.length >= 5) {
          seeds = dynamicSeeds;
          log(`Using ${seeds.length} dynamic seeds from graph accelerator`);
        }
      }
    } catch (e) {
      log("Graph accelerator unreachable, using fallback seeds:", e.message);
    }

    const allTriples = new Map();
    const entityTypes = new Map(); // name -> { type: string, votes: number }

    await Promise.all(
      seeds.map(async (entity) => {
        try {
          const r = await fetch(
            `${MSAM_URL}/v1/triples/graph/${encodeURIComponent(entity)}`,
            { headers: MSAM_HEADERS }
          );
          if (!r.ok) return;
          const data = await r.json();
          // Handle both legacy {hops: {0: [...], 1: [...]}} and current {relations: [...]} shapes
          const triples = [
            ...(data.relations || []),
            ...Object.values(data.hops || {}).flat(),
          ];
          for (const t of triples) {
            if (!t || !t.subject || !t.predicate || !t.object) continue;
            const key = `${t.subject}|${t.predicate}|${t.object}`;
            if (!allTriples.has(key)) {
              allTriples.set(key, t);
            }
          }
          // Capture per-entity types from MSAM's graphTraverse response
          if (data.entity_types && typeof data.entity_types === "object") {
            for (const [name, type] of Object.entries(data.entity_types)) {
              if (!type) continue;
              const existing = entityTypes.get(name);
              if (!existing || existing.type === type) {
                entityTypes.set(name, { type, votes: (existing?.votes ?? 0) + 1 });
              }
            }
          }
        } catch {}
      })
    );

    return {
      triples: [...allTriples.values()],
      entityTypes,
      stats,
    };
  } catch (e) {
    log("MSAM fetch failed:", e.message);
    return { triples: [], entityTypes: new Map(), stats: null };
  }
}

// ── Goose KG JSONL Parse ─────────────────────────────────────────────────────

function parseGooseKG() {
  if (!fs.existsSync(GOOSE_KG_FILE)) return { entities: [], relations: [] };
  try {
    const lines = fs.readFileSync(GOOSE_KG_FILE, "utf-8").split("\n").filter(Boolean);
    const entities = [];
    const relations = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "entity") entities.push(obj);
        else if (obj.type === "relation") relations.push(obj);
      } catch {}
    }
    return { entities, relations };
  } catch {
    return { entities: [], relations: [] };
  }
}

// ── Merge into unified graph ─────────────────────────────────────────────────

// Predicates that are noisy/low-value for visualization
const SKIP_PREDICATES = new Set([
  "has", "is", "status", "includes", "include", "has_status",
  "has_env_var", "has_column", "model", "available_models",
  "checks", "remaining_targets", "shows", "schedule",
  "added", "updated", "created", "fixed",
]);

// Entities that are too generic to visualize
const SKIP_ENTITIES = new Set([
  "User", "true", "false", "True", "False", "None", "null",
  "unknown", "N/A", "n/a", "",
]);

/**
 * Per-triple entity type resolver.
 *
 * Priority:
 *   1. Type from MSAM `entity_types` map (populated from triples.subject_type /
 *      object_type columns, which are LLM-assigned at extraction time).
 *   2. Per-triple type carried on the relation itself (`subjectType`/`objectType`
 *      fields from MSAM's /v1/triples/graph response).
 *   3. Fallback "Entity" for triples whose entities haven't been typed yet
 *      (pre-Plan-B data that the backfill missed).
 *
 * There is no pattern matching here. Types are source-of-truth from MSAM.
 */
function resolveEntityType(name, triples, entityTypesMap) {
  // 1. MSAM's graphTraverse-resolved map (majority vote across all known triples)
  const fromMap = entityTypesMap.get(name);
  if (fromMap?.type) return fromMap.type;

  // 2. Per-triple annotation (first seen wins since the map above already votes)
  for (const t of triples) {
    if (t.subject === name && t.subjectType) return t.subjectType;
    if (t.object === name && t.objectType) return t.objectType;
  }

  // 3. Untyped — schedule for backfill or next LLM re-extraction
  return "Entity";
}

function buildGraph(msamTriples, gooseKG, entityTypesMap) {
  const entityMap = new Map(); // name -> { entityType, observations, source }
  const relations = [];

  // 1. Goose KG entities carry their own types — use them directly.
  for (const e of gooseKG.entities) {
    entityMap.set(e.name, {
      name: e.name,
      entityType: e.entityType || "Entity",
      observations: e.observations || [],
      source: "goose",
    });
  }
  for (const r of gooseKG.relations) {
    relations.push({
      from: r.from,
      to: r.to,
      relationType: r.relationType,
      source: "goose",
    });
  }

  // 2. Filter MSAM triples.
  const filteredTriples = msamTriples.filter(
    (t) =>
      !SKIP_PREDICATES.has(t.predicate) &&
      !SKIP_ENTITIES.has(t.subject) &&
      !SKIP_ENTITIES.has(t.object) &&
      (t.confidence || 0) >= 0.3,
  );

  // 3. Build entities + relations using types from MSAM (source of truth).
  for (const t of filteredTriples) {
    if (!entityMap.has(t.subject)) {
      entityMap.set(t.subject, {
        name: t.subject,
        entityType: resolveEntityType(t.subject, filteredTriples, entityTypesMap),
        observations: [],
        source: "msam",
      });
    }

    if (looksLikeEntity(t.object, t.predicate)) {
      if (!entityMap.has(t.object)) {
        entityMap.set(t.object, {
          name: t.object,
          entityType: resolveEntityType(t.object, filteredTriples, entityTypesMap),
          observations: [],
          source: "msam",
        });
      }

      relations.push({
        from: t.subject,
        to: t.object,
        relationType: t.predicate.replace(/_/g, " "),
        confidence: t.confidence,
        source: "msam",
      });
    } else {
      const ent = entityMap.get(t.subject);
      if (ent) {
        const obs = `${t.predicate.replace(/_/g, " ")}: ${t.object}`;
        if (!ent.observations.includes(obs)) {
          ent.observations.push(obs);
        }
      }
    }
  }

  return {
    entities: [...entityMap.values()],
    relations,
    meta: {
      msamTriples: msamTriples.length,
      gooseEntities: gooseKG.entities.length,
      gooseRelations: gooseKG.relations.length,
      filteredEntities: entityMap.size,
      filteredRelations: relations.length,
      updatedAt: new Date().toISOString(),
    },
  };
}

function looksLikeEntity(value, predicate) {
  if (!value || value.length > 80) return false;
  if (/^\d+(\.\d+)?$/.test(value)) return false; // pure number
  if (/^(https?:\/\/|\/|~)/.test(value)) return false; // URL or path
  if (/^\$\d/.test(value)) return false; // money amount
  if (/^\d{4}-\d{2}/.test(value)) return false; // date
  if (/^(true|false|null|none|yes|no|n\/a)$/i.test(value)) return false;

  // Predicates that typically have entity objects
  const entityPredicates = [
    "is_founder_of", "is_cofounder_of", "co_founder_of", "works_with",
    "is_business_partner_at", "is_strategic_partner_of", "consulting_client",
    "invested_in", "backed", "uses", "prefers", "belongs_to",
    "is_technical_cofounder_partner_to", "replied_about", "has_contacted",
    "connection_request_status", "running_on", "is_type_of", "target_audience",
    "is_a", "recipient_of", "follows",
  ];
  if (entityPredicates.some((p) => predicate.includes(p))) return true;

  // If it starts with uppercase or has underscores (like a name), it's probably an entity
  if (/^[A-Z]/.test(value) && value.length < 40) return true;
  if (value.includes("_") && value.length < 40) return true;

  return false;
}

// Entity typing is now MSAM's responsibility. See:
//   src/knowledge/triples.ts              — LLM extracts types at ingestion
//   src/db/schema.ts                      — triples.subject_type / object_type
//   patches/graph-accelerator/            — propagates types to Neo4j labels
//
// This file consumes the resulting types; it no longer infers them.


// ── Polling Loop ─────────────────────────────────────────────────────────────

async function refreshGraph() {
  const [msamResult, gooseKG] = await Promise.all([
    fetchMsamTriples(),
    Promise.resolve(parseGooseKG()),
  ]);

  const newGraph = buildGraph(msamResult.triples, gooseKG, msamResult.entityTypes ?? new Map());

  const changed =
    newGraph.meta.filteredEntities !== graphData.meta.filteredEntities ||
    newGraph.meta.filteredRelations !== graphData.meta.filteredRelations;

  graphData = newGraph;

  if (changed) {
    log(
      `Graph updated: ${newGraph.entities.length} nodes, ${newGraph.relations.length} edges ` +
        `(${msamResult.triples.length} MSAM triples, ${gooseKG.entities.length} Goose entities)`
    );
    broadcast(graphData);
  }
}

// ── SSE Broadcast ────────────────────────────────────────────────────────────

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {}
  }
}

// ── Watch Goose KG file for live changes ─────────────────────────────────────

let debounceTimer = null;
try {
  if (fs.existsSync(GOOSE_KG_FILE)) {
    fs.watch(GOOSE_KG_FILE, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => refreshGraph(), 200);
    });
    log(`Watching Goose KG: ${GOOSE_KG_FILE}`);
  } else {
    log(`Goose KG file not found (${GOOSE_KG_FILE}), MSAM-only mode`);
  }
} catch (e) {
  log(`Could not watch Goose KG: ${e.message}`);
}

// ── HTML ─────────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Knowledge Graph — Live</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"><\/script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0a0f; --sidebar-bg: #111118; --topbar-bg: #0d0d14;
    --border: #1e1e2e; --text: #e2e8f0; --text-muted: #64748b; --text-dim: #334155;
    --person: #f59e0b; --org: #8b5cf6; --project: #06b6d4; --tech: #10b981;
    --config: #f97316; --concept: #ec4899; --entity: #94a3b8;
    --sidebar-w: 340px; --topbar-h: 52px;
  }
  html, body { width: 100%; height: 100%; background: var(--bg); color: var(--text);
    font-family: 'Inter', sans-serif; overflow: hidden; -webkit-font-smoothing: antialiased; }

  #topbar {
    position: fixed; top: 0; left: 0; right: var(--sidebar-w);
    height: var(--topbar-h); background: var(--topbar-bg);
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 12px; padding: 0 18px; z-index: 100;
  }
  .logo { font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 500;
    color: var(--project); letter-spacing: 0.06em; flex-shrink: 0; }
  #live-dot {
    width: 7px; height: 7px; border-radius: 50%; background: #22c55e;
    box-shadow: 0 0 6px #22c55e; flex-shrink: 0; transition: background 0.3s, box-shadow 0.3s;
  }
  #live-dot.stale { background: #ef4444; box-shadow: 0 0 6px #ef4444; }
  #live-dot.flash { background: #facc15; box-shadow: 0 0 10px #facc15; }
  #stats-pill {
    background: rgba(255,255,255,0.05); border: 1px solid var(--border);
    border-radius: 20px; padding: 3px 10px; font-size: 11px;
    color: var(--text-muted); font-family: 'JetBrains Mono', monospace; flex-shrink: 0;
  }
  #source-pill {
    background: rgba(139,92,246,0.1); border: 1px solid rgba(139,92,246,0.25);
    border-radius: 20px; padding: 3px 10px; font-size: 10px;
    color: #a78bfa; font-family: 'JetBrains Mono', monospace; flex-shrink: 0;
  }
  #search-wrap { flex: 1; position: relative; max-width: 300px; }
  #search {
    width: 100%; background: rgba(255,255,255,0.04); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text); font-family: 'Inter', sans-serif;
    font-size: 12px; padding: 5px 10px 5px 28px; outline: none; transition: border-color 0.2s;
  }
  #search::placeholder { color: var(--text-dim); }
  #search:focus { border-color: rgba(255,255,255,0.2); }
  #search-icon { position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
    color: var(--text-dim); font-size: 12px; pointer-events: none; }
  #reset-btn {
    background: rgba(255,255,255,0.05); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text-muted); font-size: 11px; font-weight: 500;
    padding: 5px 12px; cursor: pointer; transition: all 0.2s; flex-shrink: 0;
  }
  #reset-btn:hover { background: rgba(255,255,255,0.1); color: var(--text); }

  #canvas-wrap {
    position: fixed; top: var(--topbar-h); left: 0; bottom: 0; right: var(--sidebar-w); overflow: hidden;
  }
  #graph-svg { width: 100%; height: 100%; cursor: grab; }
  #graph-svg:active { cursor: grabbing; }

  .link { stroke: rgba(255,255,255,0.08); stroke-width: 1px; fill: none; transition: stroke 0.2s, stroke-width 0.2s; }
  .link.highlighted { stroke: rgba(255,255,255,0.4); stroke-width: 1.5px; }
  .link.dimmed { stroke: rgba(255,255,255,0.02); }
  .link.msam { stroke: rgba(6,182,212,0.12); }
  .link.goose { stroke: rgba(139,92,246,0.15); }

  .node-group { cursor: pointer; }
  .node-glow { pointer-events: none; }
  .node-circle { stroke-width: 1.5px; transition: filter 0.2s; }
  .node-group:hover .node-circle { filter: brightness(1.35) drop-shadow(0 0 8px currentColor); }
  .node-group.selected .node-circle { stroke-width: 2.5px; filter: brightness(1.5) drop-shadow(0 0 14px currentColor); }
  .node-group.dimmed { opacity: 0.08; }
  .node-group.new-node .node-circle { animation: popIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
  @keyframes popIn { 0% { r: 0; opacity: 0; } 100% { opacity: 1; } }

  .node-label {
    font-size: 10px; font-weight: 500; fill: #e2e8f0; text-anchor: middle;
    pointer-events: none; paint-order: stroke; stroke: #0a0a0f; stroke-width: 3px; stroke-linejoin: round;
  }
  .node-type {
    font-size: 8px; fill: #475569; text-anchor: middle;
    pointer-events: none; paint-order: stroke; stroke: #0a0a0f; stroke-width: 3px;
  }
  .edge-label {
    font-size: 8px; fill: rgba(255,255,255,0.4); text-anchor: middle;
    pointer-events: none; paint-order: stroke; stroke: #0a0a0f; stroke-width: 2px;
    opacity: 0; transition: opacity 0.2s;
  }
  .edge-label.visible { opacity: 1; }

  #sidebar {
    position: fixed; top: 0; right: 0; bottom: 0; width: var(--sidebar-w);
    background: var(--sidebar-bg); border-left: 1px solid var(--border);
    display: flex; flex-direction: column; z-index: 200;
  }
  #sidebar-header { padding: 16px 16px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  #sidebar-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  #sidebar-title::before { content: ''; width: 6px; height: 6px; border-radius: 50%;
    background: var(--project); box-shadow: 0 0 8px var(--project); flex-shrink: 0; }
  #sidebar-counts { font-size: 10px; color: var(--text-dim); margin-top: 4px; font-family: 'JetBrains Mono', monospace; }
  #last-updated { font-size: 10px; color: var(--text-dim); margin-top: 2px; font-family: 'JetBrains Mono', monospace; }

  #filter-section { padding: 10px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  #filter-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--text-dim); margin-bottom: 7px; font-weight: 600; }
  #filter-buttons { display: flex; flex-wrap: wrap; gap: 5px; }
  .filter-btn {
    font-size: 10px; font-weight: 500; padding: 3px 9px; border-radius: 20px;
    border: 1px solid transparent; cursor: pointer; transition: all 0.18s;
    display: flex; align-items: center; gap: 5px; font-family: 'Inter', sans-serif;
  }
  .filter-btn .dot { width: 5px; height: 5px; border-radius: 50%; }
  .filter-btn.inactive { opacity: 0.3; filter: grayscale(0.8); }
  /* Colors are applied inline via typeColor(type) — the ontology is dynamic. */
  .filter-btn .count { font-size: 9px; opacity: 0.6; font-weight: 400; }

  #detail-section { flex: 1; overflow-y: auto; padding: 14px 16px;
    scrollbar-width: thin; scrollbar-color: #1e1e2e transparent; }
  #detail-section::-webkit-scrollbar { width: 4px; }
  #detail-section::-webkit-scrollbar-thumb { background: #1e1e2e; border-radius: 2px; }

  #empty-state { display: flex; flex-direction: column; align-items: center;
    justify-content: center; height: 100%; gap: 10px; color: var(--text-dim); text-align: center; padding: 20px; }
  #empty-state svg { opacity: 0.2; }
  #empty-state p { font-size: 12px; line-height: 1.6; }
  #empty-state span { font-size: 10px; }

  #node-detail { display: none; }
  #node-detail.visible { display: block; }

  .detail-badge {
    display: inline-flex; align-items: center; gap: 5px; font-size: 9px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.12em; padding: 3px 8px;
    border-radius: 20px; margin-bottom: 4px;
  }
  .detail-badge .dot { width: 5px; height: 5px; border-radius: 50%; }
  .source-badge {
    display: inline-flex; align-items: center; font-size: 9px; font-weight: 500;
    padding: 2px 7px; border-radius: 12px; margin-left: 6px;
  }
  .source-badge.msam { color: #22d3ee; background: rgba(6,182,212,0.12); border: 1px solid rgba(6,182,212,0.25); }
  .source-badge.goose { color: #a78bfa; background: rgba(139,92,246,0.12); border: 1px solid rgba(139,92,246,0.25); }

  .detail-name { font-size: 15px; font-weight: 700; line-height: 1.3; margin-bottom: 14px; word-break: break-word; }
  .detail-section-label {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--text-dim); font-weight: 600; margin-bottom: 7px; margin-top: 14px;
    display: flex; align-items: center; gap: 6px;
  }
  .detail-section-label::after { content: ''; flex: 1; height: 1px; background: var(--border); }
  .observations-list { list-style: none; display: flex; flex-direction: column; gap: 5px; }
  .observations-list li { font-size: 11px; color: #94a3b8; line-height: 1.5; padding-left: 12px; position: relative; }
  .observations-list li::before { content: '›'; position: absolute; left: 0; color: var(--text-dim); font-size: 13px; line-height: 1.3; }
  .relations-list { display: flex; flex-direction: column; gap: 5px; }
  .relation-item {
    display: flex; align-items: flex-start; gap: 7px; font-size: 11px;
    padding: 5px 8px; border-radius: 5px; background: rgba(255,255,255,0.025);
    border: 1px solid var(--border); cursor: pointer; transition: background 0.15s;
  }
  .relation-item:hover { background: rgba(255,255,255,0.05); }
  .relation-arrow { font-size: 10px; flex-shrink: 0; margin-top: 1px; }
  .relation-arrow.out { color: var(--project); }
  .relation-arrow.in { color: var(--org); }
  .relation-type { color: var(--text-dim); font-size: 9px; font-family: 'JetBrains Mono', monospace; flex-shrink: 0; margin-top: 1px; }
  .relation-target { color: var(--text); font-weight: 500; word-break: break-word; }

  #tooltip {
    position: fixed; background: #1a1a2e; border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 10px; font-size: 11px; color: var(--text);
    pointer-events: none; z-index: 9999; opacity: 0; transition: opacity 0.15s;
    max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  }
  #tooltip.visible { opacity: 1; }

  #toast {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(60px);
    background: #1a1a2e; border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 16px; font-size: 12px; color: var(--text);
    box-shadow: 0 4px 20px rgba(0,0,0,0.6); transition: transform 0.3s cubic-bezier(0.34,1.56,0.64,1);
    z-index: 9998; pointer-events: none;
  }
  #toast.show { transform: translateX(-50%) translateY(0); }
</style>
</head>
<body>

<div id="topbar">
  <div class="logo">\u2B21 KNOWLEDGE GRAPH</div>
  <div id="live-dot" title="Live connection status"></div>
  <div id="stats-pill">\u2014 nodes \u00B7 \u2014 edges</div>
  <div id="source-pill">MSAM + Goose KG</div>
  <div id="search-wrap">
    <span id="search-icon">\u2315</span>
    <input id="search" type="text" placeholder="Search nodes\u2026" autocomplete="off" spellcheck="false">
  </div>
  <select id="agent-select" style="background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:'Inter',sans-serif;font-size:12px;padding:5px 8px;outline:none;cursor:pointer;flex-shrink:0;min-width:130px;">
    <option value="">All Agents</option>
  </select>
  <button id="reset-btn">\u21BA Reset</button>
</div>

<div id="canvas-wrap">
  <svg id="graph-svg">
    <defs>
      <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M0,0 L0,6 L6,3 z" fill="rgba(255,255,255,0.15)"/>
      </marker>
      <marker id="arrow-hi" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M0,0 L0,6 L6,3 z" fill="rgba(255,255,255,0.5)"/>
      </marker>
    </defs>
    <g id="graph-root"></g>
  </svg>
</div>

<div id="sidebar">
  <div id="sidebar-header">
    <div id="sidebar-title">Knowledge Graph</div>
    <div id="sidebar-counts">Loading\u2026</div>
    <div id="last-updated"></div>
  </div>
  <div id="filter-section">
    <div id="filter-label">Filter by type</div>
    <div id="filter-buttons"></div>
  </div>
  <div id="detail-section">
    <div id="empty-state">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
        <circle cx="20" cy="20" r="18" stroke="#64748b" stroke-width="1.5"/>
        <circle cx="20" cy="14" r="3" fill="#64748b"/>
        <circle cx="10" cy="28" r="3" fill="#64748b"/>
        <circle cx="30" cy="28" r="3" fill="#64748b"/>
        <line x1="20" y1="14" x2="10" y2="28" stroke="#64748b" stroke-width="1" stroke-dasharray="2,2"/>
        <line x1="20" y1="14" x2="30" y2="28" stroke="#64748b" stroke-width="1" stroke-dasharray="2,2"/>
        <line x1="10" y1="28" x2="30" y2="28" stroke="#64748b" stroke-width="1" stroke-dasharray="2,2"/>
      </svg>
      <p>Click any node to explore its connections and details</p>
      <span>Double-click to zoom \u00B7 Right-click to unpin \u00B7 Polls MSAM every 30s</span>
    </div>
    <div id="node-detail">
      <div id="detail-badge-wrap"></div>
      <div id="detail-name" class="detail-name"></div>
      <div class="detail-section-label">Observations</div>
      <ul id="detail-observations" class="observations-list"></ul>
      <div class="detail-section-label">Relations</div>
      <div id="detail-relations" class="relations-list"></div>
    </div>
  </div>
</div>

<div id="tooltip"></div>
<div id="toast"></div>

<script>
// ── Dynamic ontology colors ─────────────────────────────────────────
// The ontology is defined by the data, not the code. Every type the LLM
// produces is rendered with a deterministic hash-based color so the same
// type always gets the same hue across reloads, and new types get a color
// automatically without any code change.

function typeHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return h >>> 0;
}
function typeHue(type) {
  if (!type) return 220;
  // Golden-angle multiplier spreads consecutive hashes around the color wheel.
  return (typeHash(String(type)) * 137) % 360;
}
function typeColor(type)       { return type ? 'hsl('  + typeHue(type) + ', 62%, 60%)'      : '#94a3b8'; }
function typeBgColor(type)     { return type ? 'hsla(' + typeHue(type) + ', 62%, 60%, 0.10)' : 'rgba(148,163,184,0.08)'; }
function typeBorderColor(type) { return type ? 'hsla(' + typeHue(type) + ', 62%, 60%, 0.35)' : 'rgba(148,163,184,0.3)'; }

let rawEntities = [], rawRelations = [], rawMeta = {};
let nodes = [], links = [];
let simulation, svg, root, linkSel, nodeSel, edgeLabelSel, zoom;
let selectedNodeId = null;
let searchQuery = '';
let activeFilters = new Set();   // populated from data; starts empty until first render
let seenTypes = new Set();       // every type we've ever rendered, used to decide whether a type is "new"
let width, height;
let initialized = false;

const liveDot = document.getElementById('live-dot');
let es;

function connect() {
  es = new EventSource('/events');
  es.onopen = () => { liveDot.classList.remove('stale'); };
  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    flashDot();
    updateGraph(data.entities, data.relations, data.meta);
  };
  es.onerror = () => {
    liveDot.classList.add('stale');
    es.close();
    setTimeout(connect, 3000);
  };
}
connect();

function flashDot() {
  liveDot.classList.add('flash');
  setTimeout(() => liveDot.classList.remove('flash'), 600);
}

function updateGraph(entities, relations, meta) {
  const prevNodeIds = new Set(rawEntities.map(e => e.name));
  rawEntities = entities;
  rawRelations = relations;
  rawMeta = meta || {};

  const newNodeIds = new Set(entities.map(e => e.name));
  const addedIds = [...newNodeIds].filter(id => !prevNodeIds.has(id));

  document.getElementById('last-updated').textContent =
    'updated ' + new Date().toLocaleTimeString();

  // Rebuild filter chips from the current data — the ontology is dynamic.
  setupFilters();

  if (!initialized) { buildAndRender(); initialized = true; }
  else { rebuildGraph(addedIds); }

  updateStats();
  updateSidebarCounts();
  updateSourcePill();

  if (addedIds.length > 0 && prevNodeIds.size > 0)
    showToast('+' + addedIds.length + ' new node' + (addedIds.length > 1 ? 's' : ''));
  if (selectedNodeId) {
    const n = rawEntities.find(e => e.name === selectedNodeId);
    if (n) populateSidebar(n);
  }
}

function updateSourcePill() {
  const p = document.getElementById('source-pill');
  const m = rawMeta.msamTriples || 0;
  const g = rawMeta.gooseEntities || 0;
  p.textContent = m + ' triples';
}

function buildNodeList() {
  const cc = {};
  rawRelations.forEach(r => { cc[r.from] = (cc[r.from]||0)+1; cc[r.to] = (cc[r.to]||0)+1; });
  return rawEntities.map(e => {
    const ex = nodes.find(n => n.id === e.name);
    return { id: e.name, entityType: e.entityType, observations: e.observations,
      source: e.source, connections: cc[e.name]||0,
      x: ex?.x, y: ex?.y, vx: ex?.vx, vy: ex?.vy, fx: ex?.fx, fy: ex?.fy };
  });
}

function buildLinkList(nodeMap) {
  return rawRelations.filter(r => nodeMap.has(r.from) && nodeMap.has(r.to))
    .map(r => ({ source: r.from, target: r.to, relationType: r.relationType, rSource: r.source }));
}

function buildAndRender() {
  nodes = buildNodeList();
  const nm = new Map(nodes.map(n => [n.id, n]));
  links = buildLinkList(nm);
  renderGraph([]);
  runSimulation();
}

function rebuildGraph(addedIds) {
  const prev = nodes;
  nodes = buildNodeList();
  prev.forEach(p => { const n = nodes.find(x => x.id === p.id); if(n){n.x=p.x;n.y=p.y;n.vx=p.vx;n.vy=p.vy;n.fx=p.fx;n.fy=p.fy;} });
  const nm = new Map(nodes.map(n => [n.id, n]));
  links = buildLinkList(nm);
  renderGraph(addedIds);
  if (simulation) {
    const vn = nodes.filter(n => activeFilters.has(n.entityType));
    const vi = new Set(vn.map(n=>n.id));
    simulation.nodes(vn);
    simulation.force('link').links(links.filter(l => {
      const s = typeof l.source==='object'?l.source.id:l.source;
      const t = typeof l.target==='object'?l.target.id:l.target;
      return vi.has(s)&&vi.has(t);
    }));
    simulation.alpha(0.3).restart();
  } else { runSimulation(); }
}

function getRadius(n) { return 5 + Math.sqrt((n.connections||0)+1)*2.5; }
function nodeColor(type) { return typeColor(type); }

function renderGraph(newIds) {
  if(!svg) return;
  root.selectAll('*').remove();
  const vn = nodes.filter(n => activeFilters.has(n.entityType));
  const vi = new Set(vn.map(n=>n.id));
  const vl = links.filter(l => {
    const s = typeof l.source==='object'?l.source.id:l.source;
    const t = typeof l.target==='object'?l.target.id:l.target;
    return vi.has(s)&&vi.has(t);
  });

  const lg = root.append('g');
  linkSel = lg.selectAll('.link').data(vl).enter().append('line')
    .attr('class', d => 'link ' + (d.rSource||''))
    .attr('marker-end','url(#arrow)');

  const elg = root.append('g');
  edgeLabelSel = elg.selectAll('.edge-label').data(vl).enter().append('text')
    .attr('class','edge-label').text(d => d.relationType);

  const ng = root.append('g');
  nodeSel = ng.selectAll('.node-group').data(vn, d=>d.id).enter().append('g')
    .attr('class', d => 'node-group'+(newIds.includes(d.id)?' new-node':''))
    .call(d3.drag().on('start',dragStart).on('drag',dragged).on('end',dragEnd))
    .on('click',(ev,d)=>{ev.stopPropagation();selectNode(d);})
    .on('dblclick',(ev,d)=>{ev.stopPropagation();zoomToNode(d);})
    .on('contextmenu',(ev,d)=>{ev.preventDefault();unpinNode(d);})
    .on('mouseenter',(ev,d)=>{showTip(ev,d);highlightConns(d);})
    .on('mousemove',moveTip)
    .on('mouseleave',()=>{hideTip();resetHighlight();});

  nodeSel.append('circle').attr('class','node-glow')
    .attr('r',d=>getRadius(d)+4).attr('fill',d=>nodeColor(d.entityType)).attr('opacity',0.06);
  nodeSel.append('circle').attr('class','node-circle')
    .attr('r',d=>getRadius(d))
    .attr('fill',d=>nodeColor(d.entityType)+'22')
    .attr('stroke',d=>nodeColor(d.entityType));
  nodeSel.append('text').attr('class','node-type')
    .attr('dy',d=>-(getRadius(d)+11)).text(d=>d.entityType);
  nodeSel.append('text').attr('class','node-label')
    .attr('dy',d=>getRadius(d)+13)
    .text(d=>d.id.length>20?d.id.slice(0,18)+'\\u2026':d.id);

  updateSearchHighlight();
  if(selectedNodeId) nodeSel.classed('selected',d=>d.id===selectedNodeId);
}

function runSimulation() {
  const vn = nodes.filter(n=>activeFilters.has(n.entityType));
  const vi = new Set(vn.map(n=>n.id));
  const vl = links.filter(l=>{
    const s=typeof l.source==='object'?l.source.id:l.source;
    const t=typeof l.target==='object'?l.target.id:l.target;
    return vi.has(s)&&vi.has(t);
  });
  if(simulation) simulation.stop();
  simulation = d3.forceSimulation(vn)
    .force('link',d3.forceLink(vl).id(d=>d.id)
      .distance(d=>{
        const sr=getRadius(typeof d.source==='object'?d.source:{connections:1});
        const tr=getRadius(typeof d.target==='object'?d.target:{connections:1});
        return 50+sr+tr;
      }).strength(0.25))
    .force('charge',d3.forceManyBody().strength(d=>-120-getRadius(d)*6))
    .force('center',d3.forceCenter(width/2,height/2))
    .force('collision',d3.forceCollide().radius(d=>getRadius(d)+12).strength(0.8))
    .force('x',d3.forceX(width/2).strength(0.03))
    .force('y',d3.forceY(height/2).strength(0.03))
    .alphaDecay(0.02)
    .on('tick',ticked);
}

function ticked() {
  if(!linkSel||!nodeSel) return;
  linkSel.attr('x1',d=>(typeof d.source==='object'?d.source.x:0)||0)
    .attr('y1',d=>(typeof d.source==='object'?d.source.y:0)||0)
    .attr('x2',d=>(typeof d.target==='object'?d.target.x:0)||0)
    .attr('y2',d=>(typeof d.target==='object'?d.target.y:0)||0);
  edgeLabelSel.attr('x',d=>(((typeof d.source==='object'?d.source.x:0)||0)+((typeof d.target==='object'?d.target.x:0)||0))/2)
    .attr('y',d=>(((typeof d.source==='object'?d.source.y:0)||0)+((typeof d.target==='object'?d.target.y:0)||0))/2);
  nodeSel.attr('transform',d=>'translate('+(d.x||0)+','+(d.y||0)+')');
}

function dragStart(ev,d){if(!ev.active)simulation.alphaTarget(0.3).restart();d.fx=d.x;d.fy=d.y;}
function dragged(ev,d){d.fx=ev.x;d.fy=ev.y;}
function dragEnd(ev,d){if(!ev.active)simulation.alphaTarget(0);}
function unpinNode(d){d.fx=null;d.fy=null;simulation?.alpha(0.1).restart();}

function selectNode(d){
  selectedNodeId=d.id;
  nodeSel?.classed('selected',n=>n.id===d.id);
  populateSidebar(d);
}
function deselectNode(){
  selectedNodeId=null;
  nodeSel?.classed('selected',false);
  document.getElementById('empty-state').style.display='';
  document.getElementById('node-detail').classList.remove('visible');
  resetHighlight();
}

function getConnIds(d){
  const ids=new Set([d.id]);
  links.forEach(l=>{
    const s=typeof l.source==='object'?l.source.id:l.source;
    const t=typeof l.target==='object'?l.target.id:l.target;
    if(s===d.id)ids.add(t);if(t===d.id)ids.add(s);
  });
  return ids;
}

function highlightConns(d){
  if(!linkSel||!nodeSel) return;
  const ids=getConnIds(d);
  linkSel.classed('highlighted',l=>{const s=typeof l.source==='object'?l.source.id:l.source;const t=typeof l.target==='object'?l.target.id:l.target;return s===d.id||t===d.id;})
    .classed('dimmed',l=>{const s=typeof l.source==='object'?l.source.id:l.source;const t=typeof l.target==='object'?l.target.id:l.target;return s!==d.id&&t!==d.id;});
  edgeLabelSel.classed('visible',l=>{const s=typeof l.source==='object'?l.source.id:l.source;const t=typeof l.target==='object'?l.target.id:l.target;return s===d.id||t===d.id;});
  if(!searchQuery)nodeSel.classed('dimmed',n=>!ids.has(n.id));
}

function resetHighlight(){
  linkSel?.classed('highlighted',false).classed('dimmed',false);
  edgeLabelSel?.classed('visible',false);
  if(!searchQuery)nodeSel?.classed('dimmed',false);
}

function zoomToNode(d){
  const ids=getConnIds(d);
  const connected=nodes.filter(n=>ids.has(n.id)&&n.x!==undefined);
  if(!connected.length) return;
  const xs=connected.map(n=>n.x),ys=connected.map(n=>n.y);
  const [x0,x1,y0,y1]=[Math.min(...xs),Math.max(...xs),Math.min(...ys),Math.max(...ys)];
  const pad=80;
  const scale=Math.min(2.5,0.85/Math.max((x1-x0+pad*2)/width,(y1-y0+pad*2)/height));
  const tx=width/2-scale*(x0+x1)/2,ty=height/2-scale*(y0+y1)/2;
  svg.transition().duration(600).ease(d3.easeCubicInOut)
    .call(zoom.transform,d3.zoomIdentity.translate(tx,ty).scale(scale));
}

function updateSearchHighlight(){
  if(!nodeSel) return;
  nodeSel.classed('dimmed',d=>searchQuery
    ?!d.id.toLowerCase().includes(searchQuery)&&!d.entityType.toLowerCase().includes(searchQuery)
    :false);
}

function setupFilters(){
  // Rebuild every render — the ontology is dynamic, types come and go with the data.
  const wrap = document.getElementById('filter-buttons');
  wrap.innerHTML = '';

  // Count types across the current entity set.
  const counts = new Map();
  for (const e of rawEntities) {
    const t = e.entityType || 'Unknown';
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  if (counts.size === 0) return;

  // Sort by count desc, then name. Show everything — they're color-coded and wrap naturally.
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  // Preserve user toggles across re-renders. On first render activeFilters is empty,
  // so all types get activated. On later renders, only types we've never seen before
  // get auto-activated (so new data isn't silently hidden, but toggles stick).
  for (const [t] of sorted) {
    if (!seenTypes.has(t)) {
      activeFilters.add(t);
      seenTypes.add(t);
    }
  }

  for (const [type, count] of sorted) {
    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.dataset.type = type;
    btn.style.color = typeColor(type);
    btn.style.borderColor = typeBorderColor(type);
    btn.style.backgroundColor = typeBgColor(type);
    btn.innerHTML =
      '<span class="dot" style="background:' + typeColor(type) + '"></span>' +
      type + ' <span class="count">' + count + '</span>';
    if (!activeFilters.has(type)) btn.classList.add('inactive');
    btn.addEventListener('click', () => {
      if (activeFilters.has(type)) { activeFilters.delete(type); btn.classList.add('inactive'); }
      else { activeFilters.add(type); btn.classList.remove('inactive'); }
      selectedNodeId = null;
      document.getElementById('empty-state').style.display = '';
      document.getElementById('node-detail').classList.remove('visible');
      renderGraph([]); runSimulation(); updateSidebarCounts();
    });
    wrap.appendChild(btn);
  }
}

function populateSidebar(d){
  document.getElementById('empty-state').style.display='none';
  const detail=document.getElementById('node-detail');
  detail.classList.add('visible');
  const srcBadge=d.source==='goose'?'<span class="source-badge goose">Goose KG</span>'
    :'<span class="source-badge msam">MSAM</span>';
  {
    const badgeColor = typeColor(d.entityType);
    const badgeBg = typeBgColor(d.entityType);
    const badgeBorder = typeBorderColor(d.entityType);
    document.getElementById('detail-badge-wrap').innerHTML=
      '<div class="detail-badge" style="color:'+badgeColor+';background:'+badgeBg+';border:1px solid '+badgeBorder+'">' +
        '<span class="dot" style="background:'+badgeColor+'"></span>'+d.entityType+
      '</div>'+srcBadge;
  }
  document.getElementById('detail-name').textContent=d.name||d.id;
  const obsList=document.getElementById('detail-observations');
  obsList.innerHTML='';
  (d.observations||[]).forEach(obs=>{
    const li=document.createElement('li');li.textContent=obs;obsList.appendChild(li);
  });
  if(!d.observations||!d.observations.length){
    obsList.innerHTML='<li style="color:var(--text-dim)">No observations</li>';
  }
  const relList=document.getElementById('detail-relations');
  relList.innerHTML='';
  const name=d.name||d.id;
  const out=rawRelations.filter(r=>r.from===name);
  const inn=rawRelations.filter(r=>r.to===name);
  if(!out.length&&!inn.length){
    relList.innerHTML='<div style="font-size:11px;color:#334155;">No relations</div>';
  } else {
    out.forEach(r=>relList.appendChild(makeRelItem('\\u2192','out',r.relationType,r.to)));
    inn.forEach(r=>relList.appendChild(makeRelItem('\\u2190','in',r.relationType,r.from)));
  }
}

function makeRelItem(arrow,dir,type,target){
  const div=document.createElement('div');
  div.className='relation-item';
  div.innerHTML='<span class="relation-arrow '+dir+'">'+arrow+'</span><span class="relation-type">'+type+'</span><span class="relation-target">'+target+'</span>';
  div.addEventListener('click',()=>{
    const n=nodes.find(n=>n.id===target);
    if(n&&activeFilters.has(n.entityType)){selectNode(n);zoomToNode(n);}
  });
  return div;
}

function updateStats(){
  document.getElementById('stats-pill').textContent=
    rawEntities.length+' nodes \\u00B7 '+rawRelations.length+' edges';
}
function updateSidebarCounts(){
  const vis=nodes.filter(n=>activeFilters.has(n.entityType));
  const vi2=new Set(vis.map(n=>n.id));
  const el=links.filter(l=>{
    const s=typeof l.source==='object'?l.source.id:l.source;
    const t=typeof l.target==='object'?l.target.id:l.target;
    return vi2.has(s)&&vi2.has(t);
  });
  document.getElementById('sidebar-counts').textContent=
    vis.length+' nodes \\u00B7 '+el.length+' edges visible';
}

const tip=document.getElementById('tooltip');
function showTip(ev,d){tip.textContent=d.id+' ('+d.entityType+')';tip.classList.add('visible');moveTip(ev);}
function moveTip(ev){tip.style.left=Math.min(ev.clientX+14,window.innerWidth-250)+'px';tip.style.top=Math.max(4,ev.clientY-28)+'px';}
function hideTip(){tip.classList.remove('visible');}

let toastTimer;
function showToast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg;t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove('show'),3000);
}

function init(){
  const wrap=document.getElementById('canvas-wrap');
  width=wrap.clientWidth;height=wrap.clientHeight;
  svg=d3.select('#graph-svg').attr('width',width).attr('height',height);
  zoom=d3.zoom().scaleExtent([0.05,5]).on('zoom',ev=>root.attr('transform',ev.transform));
  svg.call(zoom);
  svg.on('dblclick.zoom',null);
  svg.on('click',ev=>{if(ev.target===svg.node()||ev.target.tagName==='svg')deselectNode();});
  root=d3.select('#graph-root');
  setupFilters();
  document.getElementById('search').addEventListener('input',e=>{
    searchQuery=e.target.value.trim().toLowerCase();updateSearchHighlight();
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){deselectNode();document.getElementById('search').value='';searchQuery='';updateSearchHighlight();}
  });
  document.getElementById('reset-btn').addEventListener('click',()=>{
    nodes.forEach(n=>{n.fx=null;n.fy=null;n.x=undefined;n.y=undefined;});
    selectedNodeId=null;
    document.getElementById('empty-state').style.display='';
    document.getElementById('node-detail').classList.remove('visible');
    renderGraph([]);runSimulation();
    svg.transition().duration(400).call(zoom.transform,d3.zoomIdentity);
  });
  window.addEventListener('resize',()=>{
    width=wrap.clientWidth;height=wrap.clientHeight;
    svg.attr('width',width).attr('height',height);
    simulation?.force('center',d3.forceCenter(width/2,height/2))
      .force('x',d3.forceX(width/2).strength(0.03))
      .force('y',d3.forceY(height/2).strength(0.03))
      .alpha(0.1).restart();
  });
  fetch('/graph').then(r=>r.json()).then(data=>{
    updateGraph(data.entities,data.relations,data.meta);
  });
}

let currentAgentId = '';

async function loadAgents() {
  try {
    const r = await fetch('/api/agents');
    const data = await r.json();
    const sel = document.getElementById('agent-select');
    const agents = data.agents || [];
    const groups = {};
    agents.forEach(a => {
      const gw = a.gateway || 'Unknown';
      if (!groups[gw]) groups[gw] = [];
      groups[gw].push(a);
    });
    Object.entries(groups).forEach(([gw, list]) => {
      const grp = document.createElement('optgroup');
      grp.label = gw;
      list.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.id + ' (' + (a.triples || a.atoms) + ' triples)';
        grp.appendChild(opt);
      });
      sel.appendChild(grp);
    });
  } catch (e) { console.warn('Failed to load agents:', e); }
}

async function loadGraphForAgent(agentId) {
  currentAgentId = agentId;
  const url = agentId ? '/api/graph?agent_id=' + encodeURIComponent(agentId) : '/graph';
  try {
    const r = await fetch(url);
    const data = await r.json();
    updateGraph(data.entities, data.relations, data.meta);
  } catch (e) { console.warn('Failed to load agent graph:', e); }
}

document.getElementById('agent-select').addEventListener('change', (e) => {
  loadGraphForAgent(e.target.value);
});

init();
loadAgents();
<\/script>
</body>
</html>`;

// ── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/graph.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML);
  } else if (req.url === "/graph") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(graphData));
  } else if (req.url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
  } else if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        nodes: graphData.entities.length,
        edges: graphData.relations.length,
        clients: clients.size,
        meta: graphData.meta,
      })
    );
  } else if (req.url === "/api/agents") {
    const agentData = loadAgentData();
    const agents = agentData ? agentData.agents || [] : [];
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ agents, exported_at: agentData?.exported_at }));
  } else if (req.url?.startsWith("/api/graph")) {
    try {
      const url = new URL(req.url, "http://localhost");
      const agentId = url.searchParams.get("agent_id") || null;
      const msamResult = await fetchMsamTriples(agentId);
      const gooseKG = agentId ? { entities: [], relations: [] } : parseGooseKG();
      const data = buildGraph(msamResult.triples, gooseKG);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.error(`[kg-viewer] Port ${PORT} in use`);
    process.exit(1);
  }
  console.error("[kg-viewer] Server error:", error);
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", async () => {
  log(`Live at http://0.0.0.0:${PORT}`);
  log(`Tailscale: http://mac-studio.tail3c92ee.ts.net:${PORT}`);
  log(`Polling MSAM at ${MSAM_URL} every ${POLL_INTERVAL_MS / 1000}s`);

  // Initial load
  await refreshGraph();
  log(
    `Startup: ${graphData.entities.length} nodes, ${graphData.relations.length} edges`
  );

  // Poll MSAM periodically
  setInterval(refreshGraph, POLL_INTERVAL_MS);
});

process.on("SIGINT", () => {
  log("Shutting down...");
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  log("Shutting down...");
  server.close(() => process.exit(0));
});
