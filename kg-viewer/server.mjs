/**
 * kg-viewer — Live Knowledge Graph Visualizer
 *
 * Single data source: MSAM triples (http://msam:3901/v1/triples/graph/{entity}).
 * Polls every POLL_INTERVAL_MS. Serves force-directed D3 graph on port 7780.
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

const AGENT_TRIPLES_FILE = process.env.AGENT_TRIPLES_FILE || "/data/agent-triples.json";

function loadAgentData() {
  try {
    if (!fs.existsSync(AGENT_TRIPLES_FILE)) return null;
    return JSON.parse(fs.readFileSync(AGENT_TRIPLES_FILE, "utf-8"));
  } catch { return null; }
}

const log = (...args) =>
  console.log(`[kg-viewer ${new Date().toISOString().slice(11, 19)}]`, ...args);

// ── State ────────────────────────────────────────────────────────────────────

let graphData = { entities: [], relations: [], meta: {} };
const clients = new Set();

// ── MSAM Data Fetch ──────────────────────────────────────────────────────────

// Bounded entity vocabulary — Mem0 enduru/turkules/hermes stacks emit only
// these (15 types + the special internal `__User__`). Aurora/Sam are unbounded
// by design (we deliberately didn't apply MEM0_BOUND_PROMPT to them); their
// free-form types — Process, Action, File, Unknown, Date, Object, Feature,
// System, Activity, Category, Path, Command, Component, Data, Quantity, Time,
// Configuration, Technology, Api, Identifier, etc. — collapse to "Other"
// here so the All Agents type filter stays at the bounded-16 set.
const BOUNDED_TYPES = new Set([
  "Person", "Organization", "Project", "Tool", "Service",
  "Document", "Task", "Concept", "Event", "Location",
  "Status", "Code", "Endpoint", "Issue", "Other", "User",
]);

function titleCase(s) {
  if (!s) return s;
  if (s === "__User__") return "User";
  const tc = s.charAt(0).toUpperCase() + s.slice(1);
  return BOUNDED_TYPES.has(tc) ? tc : "Other";
}

async function fetchMsamTriples(agentId) {
  // Single source of truth: agent-triples.json (Mem0-sourced, refreshed by the
  // /opt/msam-data/agent-graph-export-mem0.py cron every 15min). We no longer
  // hit MSAM at all — both the per-agent and aggregate views read from the
  // same exported snapshot, so type and predicate vocabularies are consistent.
  const agentData = loadAgentData();
  const entityTypes = new Map();

  if (!agentData || !agentData.agent_triples) {
    return { triples: [], entityTypes, stats: null };
  }

  // Pick which agents to include: a single one or all.
  const sources = agentId
    ? (agentData.agent_triples[agentId] ? [[agentId, agentData.agent_triples[agentId]]] : [])
    : Object.entries(agentData.agent_triples);

  const allTriples = new Map();
  // Track which Mem0 stacks each entity appears in (cross-stack annotation
  // from mem0-graph-resolver). Empty for triples produced by the older
  // exporter — falls back gracefully.
  const seenIn = new Map();

  for (const [, agentTriples] of sources) {
    for (const raw of agentTriples) {
      if (!raw || !raw.subject || !raw.predicate || !raw.object) continue;
      const subjectType = titleCase(raw.subject_type || raw.subjectType);
      const objectType = titleCase(raw.object_type || raw.objectType);
      const t = {
        subject: raw.subject,
        predicate: raw.predicate,
        object: raw.object,
        subjectType,
        objectType,
        confidence: raw.confidence ?? 1.0,
        // 'topology' edges come from the infra harvester; 'mem0' from LLM extraction.
        source: raw.source || "mem0",
      };
      const key = `${t.subject}|${t.predicate}|${t.object}`;
      if (!allTriples.has(key)) allTriples.set(key, t);

      const tally = (name, type) => {
        if (!name || !type) return;
        const existing = entityTypes.get(name);
        if (!existing) entityTypes.set(name, { type, votes: 1 });
        else if (existing.type === type) existing.votes += 1;
        else if (existing.votes < 1) entityTypes.set(name, { type, votes: 1 });
      };
      tally(t.subject, subjectType);
      tally(t.object, objectType);

      // Resolver-emitted `subject_in` / `object_in` arrays list the Mem0
      // stacks where that entity appears. We unify them per-entity so a
      // node clicked in one view can surface its cross-stack memberships.
      const merge = (name, list) => {
        if (!name || !list || !Array.isArray(list)) return;
        const cur = seenIn.get(name) || new Set();
        for (const a of list) cur.add(a);
        seenIn.set(name, cur);
      };
      merge(t.subject, raw.subject_in);
      merge(t.object, raw.object_in);
    }
  }

  return {
    triples: [...allTriples.values()],
    entityTypes,
    seenIn,
    stats: { agents: agentData.agents || [] },
  };
}

// ── Build graph from Mem0 triples ────────────────────────────────────────────

// Predicates we deliberately keep — these come from the bounded Mem0 vocab
// (15 relation types) and every one is meaningful as an edge. The previous
// MSAM-era SKIP set incorrectly suppressed `created`, `has_status`, etc.
// because MSAM's free-form predicates dwarfed the signal there.
// Empty SKIP set lets all bounded relations through.
const SKIP_PREDICATES = new Set([]);

// Entities that are too generic to visualize as nodes.
const SKIP_ENTITIES = new Set([
  "true", "false", "True", "False", "None", "null",
  "unknown", "N/A", "n/a", "",
]);

/**
 * Per-triple entity type resolver — uses the export's own subject/object types
 * (already normalized to TitleCase). Falls back to Entity for the rare untyped
 * case (e.g. a name that appears in MSAM-legacy triples without typing).
 */
function resolveEntityType(name, triples, entityTypesMap) {
  const fromMap = entityTypesMap.get(name);
  if (fromMap?.type) return fromMap.type;
  for (const t of triples) {
    if (t.subject === name && t.subjectType) return t.subjectType;
    if (t.object === name && t.objectType) return t.objectType;
  }
  return "Entity";
}

function buildGraph(msamTriples, entityTypesMap, seenInMap) {
  const entityMap = new Map();
  const relations = [];
  const seen = seenInMap || new Map();

  const filteredTriples = msamTriples.filter(
    (t) =>
      !SKIP_PREDICATES.has(t.predicate) &&
      !SKIP_ENTITIES.has(t.subject) &&
      !SKIP_ENTITIES.has(t.object) &&
      (t.confidence || 0) >= 0.3,
  );

  const seenInOf = (name) => {
    const s = seen.get(name);
    return s ? [...s].sort() : [];
  };

  for (const t of filteredTriples) {
    if (!entityMap.has(t.subject)) {
      entityMap.set(t.subject, {
        name: t.subject,
        entityType: resolveEntityType(t.subject, filteredTriples, entityTypesMap),
        observations: [],
        seenIn: seenInOf(t.subject),
        source: "mem0",
      });
    }

    if (looksLikeEntity(t.object, t.predicate)) {
      if (!entityMap.has(t.object)) {
        entityMap.set(t.object, {
          name: t.object,
          entityType: resolveEntityType(t.object, filteredTriples, entityTypesMap),
          observations: [],
          seenIn: seenInOf(t.object),
          source: "mem0",
        });
      }

      relations.push({
        from: t.subject,
        to: t.object,
        relationType: t.predicate.replace(/_/g, " "),
        confidence: t.confidence,
        // 'topology' edges (runs_on, member_of, uses, owns from harvester)
        // get rendered with the orange .link.topology style.
        source: t.source || "mem0",
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

  const connected = new Set();
  for (const rel of relations) { connected.add(rel.from); connected.add(rel.to); }
  for (const [name, ent] of entityMap) {
    if (!connected.has(name) && ent.observations.length === 0) {
      entityMap.delete(name);
    }
  }

  // Cross-stack roll-up: how many entities are referenced by 2+ Mem0 stacks.
  let crossStack = 0;
  for (const ent of entityMap.values()) {
    if (ent.seenIn.length >= 2) crossStack += 1;
  }

  return {
    entities: [...entityMap.values()],
    relations,
    meta: {
      mem0Triples: msamTriples.length,
      filteredEntities: entityMap.size,
      filteredRelations: relations.length,
      crossStackEntities: crossStack,
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

  // Predicates from the bounded Mem0 vocab that always relate entities to
  // entities (not entity-to-literal observations). Treat anything related
  // by these as a node, even if the value is a kebab-case hostname.
  const entityPredicates = [
    "runs_on", "located_in", "member_of", "uses", "owns",
    "created", "depends_on", "assigned_to", "discussed_with",
    "blocked_by", "replaces", "scheduled_for", "is_founder_of",
    "is_cofounder_of", "works_with", "invested_in", "is_a",
  ];
  if (entityPredicates.some((p) => predicate === p || predicate.includes(p))) return true;

  // Looks like an identifier (hostname, container name, repo slug, person name)
  if (/^[A-Z]/.test(value) && value.length < 40) return true;
  if (/[_-]/.test(value) && value.length < 50) return true;

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
  const msamResult = await fetchMsamTriples();
  const newGraph = buildGraph(msamResult.triples, msamResult.entityTypes ?? new Map(), msamResult.seenIn ?? new Map());

  const changed =
    newGraph.meta.filteredEntities !== graphData.meta.filteredEntities ||
    newGraph.meta.filteredRelations !== graphData.meta.filteredRelations;

  graphData = newGraph;

  if (changed) {
    log(
      `Graph updated: ${newGraph.entities.length} nodes, ${newGraph.relations.length} edges ` +
        `(${msamResult.triples.length} MSAM triples)`
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

  .link { stroke: rgba(34,211,238,0.18); stroke-width: 0.8px; fill: none; transition: stroke 0.2s, stroke-width 0.2s; }
  .link.highlighted { stroke: rgba(255,255,255,0.55); stroke-width: 1.6px; }
  .link.dimmed { stroke: rgba(34,211,238,0.04); }
  .link.mem0 { stroke: rgba(34,211,238,0.22); }
  .link.msam { stroke: rgba(34,211,238,0.22); }
  .link.goose { stroke: rgba(139,92,246,0.22); }
  /* Topology edges (runs_on, member_of, uses, owns, located_in from the
     mem0-topology-harvester) are rendered brighter so the deployment
     skeleton pops above the LLM-extracted observation noise. */
  .link.topology { stroke: rgba(245,158,11,0.5); stroke-width: 1.4px; }
  .link.topology.highlighted { stroke: rgba(252,211,77,0.85); stroke-width: 2px; }

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

  #filter-section {
    padding: 10px 16px; border-bottom: 1px solid var(--border);
    /* Cap the filter rail so a large dynamic ontology doesn't push the detail pane off-screen.
       Internally scrollable, detail pane stays reachable. */
    max-height: 35vh; overflow-y: auto;
    scrollbar-width: thin; scrollbar-color: #1e1e2e transparent; flex-shrink: 0;
  }
  #filter-section::-webkit-scrollbar { width: 4px; }
  #filter-section::-webkit-scrollbar-thumb { background: #1e1e2e; border-radius: 2px; }
  #filter-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 7px; gap: 8px;
  }
  #filter-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--text-dim); font-weight: 600; }
  #filter-search {
    flex: 1; min-width: 0; background: rgba(30,30,46,0.4); border: 1px solid var(--border);
    border-radius: 14px; padding: 3px 10px; color: var(--text); font-size: 10px;
    font-family: 'Inter', sans-serif; outline: none;
  }
  #filter-search::placeholder { color: var(--text-dim); }
  #filter-search:focus { border-color: rgba(148,163,184,0.4); }
  #filter-actions { display: flex; gap: 6px; }
  .filter-action {
    font-size: 9px; color: var(--text-dim); background: transparent; border: 1px solid transparent;
    cursor: pointer; padding: 2px 6px; border-radius: 10px; font-family: 'Inter', sans-serif;
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .filter-action:hover { color: var(--text); border-color: var(--border); }
  #filter-buttons { display: flex; flex-wrap: wrap; gap: 5px; }
  .filter-btn.filtered-out { display: none; }

  #confidence-row {
    display: flex; align-items: center; gap: 8px; margin-top: 8px;
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--text-dim); font-weight: 600;
  }
  #confidence-slider { flex: 1; cursor: pointer; accent-color: #22d3ee; }
  #confidence-value {
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    color: var(--text); min-width: 30px; text-align: right; text-transform: none;
    letter-spacing: 0; font-weight: 500;
  }
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

  .detail-name { font-size: 15px; font-weight: 700; line-height: 1.3; margin-bottom: 6px; word-break: break-word; }
  .detail-seen-in { font-size: 10px; color: var(--text-muted); margin-bottom: 12px; font-family: 'JetBrains Mono', monospace; display: flex; flex-wrap: wrap; gap: 4px; }
  .detail-seen-in:empty { display: none; }
  .detail-seen-in .stack-pill {
    background: rgba(34,211,238,0.08); border: 1px solid rgba(34,211,238,0.2);
    border-radius: 10px; padding: 1px 7px; font-size: 9px; color: #67e8f9;
  }
  .detail-seen-in .seen-label { color: var(--text-dim); margin-right: 4px; align-self: center; }
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
  <div id="source-pill">Mem0</div>
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
    <div id="filter-header">
      <span id="filter-label">Filter by type</span>
      <input id="filter-search" placeholder="filter types…" type="text" />
      <div id="filter-actions">
        <button class="filter-action" id="filter-all">All</button>
        <button class="filter-action" id="filter-none">None</button>
      </div>
    </div>
    <div id="filter-buttons"></div>
    <div id="confidence-row" title="Hide edges below this confidence threshold">
      <span>Min conf</span>
      <input id="confidence-slider" type="range" min="0" max="1" step="0.05" value="0" />
      <span id="confidence-value">0.00</span>
    </div>
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
      <span>Double-click to zoom \u00B7 Right-click to unpin \u00B7 Polls Mem0 fleet every 30s</span>
    </div>
    <div id="node-detail">
      <div id="detail-badge-wrap"></div>
      <div id="detail-name" class="detail-name"></div>
      <div id="detail-seen-in" class="detail-seen-in"></div>
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
let minConfidence = 0;           // edge-confidence floor; 0 = show all (server already drops conf<0.3)
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
  // mem0Triples is the new field; msamTriples kept as a fallback for cached pages.
  const m = rawMeta.mem0Triples ?? rawMeta.msamTriples ?? 0;
  const cs = rawMeta.crossStackEntities;
  p.textContent = m + ' triples' + (cs ? ' · ' + cs + ' cross-stack' : '');
}

function buildNodeList() {
  const cc = {};
  rawRelations.forEach(r => { cc[r.from] = (cc[r.from]||0)+1; cc[r.to] = (cc[r.to]||0)+1; });
  return rawEntities.map(e => {
    const ex = nodes.find(n => n.id === e.name);
    return { id: e.name, entityType: e.entityType, observations: e.observations,
      seenIn: e.seenIn || [],
      source: e.source, connections: cc[e.name]||0,
      x: ex?.x, y: ex?.y, vx: ex?.vx, vy: ex?.vy, fx: ex?.fx, fy: ex?.fy };
  });
}

function buildLinkList(nodeMap) {
  return rawRelations.filter(r => nodeMap.has(r.from) && nodeMap.has(r.to))
    .map(r => ({ source: r.from, target: r.to, relationType: r.relationType, rSource: r.source, confidence: r.confidence }));
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

// Dramatic degree-based sizing: leaves stay tiny dots, hubs dominate.
// Range ~2..50 px. Pow(0.55) curve gives mid-tier hubs (degree 30-200)
// significantly bigger than leaves so all THREE tiers are visually
// distinct: leaves (1-3 conn ≈ 2-4 px), secondary hubs (50-200 ≈ 12-22 px),
// mega-hubs (1000+ ≈ 35-50 px).
function getRadius(n) {
  const c = n.connections || 0;
  if (c === 0) return 2;
  return Math.min(50, 2 + Math.pow(c, 0.55) * 1.4);
}
function nodeColor(type) { return typeColor(type); }

function renderGraph(newIds) {
  if(!svg) return;
  root.selectAll('*').remove();
  const vn = nodes.filter(n => activeFilters.has(n.entityType));
  const vi = new Set(vn.map(n=>n.id));
  const vl = links.filter(l => {
    const s = typeof l.source==='object'?l.source.id:l.source;
    const t = typeof l.target==='object'?l.target.id:l.target;
    if (!vi.has(s) || !vi.has(t)) return false;
    const conf = (l.confidence == null) ? 1 : l.confidence;
    return conf >= minConfidence;
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

  // Soft glow scales with node — bigger hubs cast bigger glows, drawing the eye.
  nodeSel.append('circle').attr('class','node-glow')
    .attr('r',d=>getRadius(d)*1.6+4).attr('fill',d=>nodeColor(d.entityType))
    .attr('opacity',d=>Math.min(0.22, 0.05 + getRadius(d)*0.005));
  // Solid filled circle (fully opaque) so volume reads instantly. Was 13%
  // alpha fill which made nodes look like rings — couldn't tell sizes apart.
  nodeSel.append('circle').attr('class','node-circle')
    .attr('r',d=>getRadius(d))
    .attr('fill',d=>nodeColor(d.entityType))
    .attr('stroke',d=>nodeColor(d.entityType))
    .attr('stroke-width',d=>getRadius(d)>15?2:1);
  // Only label hubs in dense views — leaf labels at this scale just produce noise.
  // Threshold: radius >= 8 (~degree 20+) when total nodes > 500.
  const labelThreshold = vn.length > 500 ? 8 : 0;
  nodeSel.filter(d=>getRadius(d) >= labelThreshold).append('text').attr('class','node-type')
    .attr('dy',d=>-(getRadius(d)+11)).text(d=>d.entityType);
  nodeSel.filter(d=>getRadius(d) >= labelThreshold).append('text').attr('class','node-label')
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
  // Scale forces by visible node count so 3000+ nodes still spread to fill
  // the viewport. With small N the original strengths were fine; with thousands
  // of nodes the previous parameters collapsed everything into a dense ball.
  const N = vn.length;
  const isLarge = N > 500;

  simulation = d3.forceSimulation(vn)
    .force('link',d3.forceLink(vl).id(d=>d.id)
      .distance(d=>{
        const sr=getRadius(typeof d.source==='object'?d.source:{connections:1});
        const tr=getRadius(typeof d.target==='object'?d.target:{connections:1});
        // Longer links at higher density so spokes radiate further from hubs.
        return (isLarge ? 90 : 50) + sr + tr;
      }).strength(isLarge ? 0.4 : 0.25))
    // Hubs repel HARDER so they spread out as anchors; leaves are nearly weightless.
    // Strong base repulsion is essential at high N to prevent the black-hole effect.
    .force('charge',d3.forceManyBody()
      .strength(d => (isLarge ? -260 : -60) - Math.pow(getRadius(d), 1.7) * 9)
      .distanceMin(2)
      .distanceMax(800))
    .force('center',d3.forceCenter(width/2,height/2).strength(isLarge ? 0.04 : 0.1))
    .force('collision',d3.forceCollide().radius(d=>getRadius(d) + (isLarge ? 4 : 12)).strength(0.85))
    // Drop the x/y gravity at scale — it was pulling everything inward.
    .force('x',d3.forceX(width/2).strength(isLarge ? 0.005 : 0.03))
    .force('y',d3.forceY(height/2).strength(isLarge ? 0.005 : 0.03))
    // Slower decay so the layout has time to fully spread before settling.
    .alphaDecay(isLarge ? 0.012 : 0.02)
    .velocityDecay(isLarge ? 0.35 : 0.4)
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

  // Apply current filter-search text if any.
  applyFilterSearch();
}

function applyFilterSearch() {
  const q = (document.getElementById('filter-search')?.value || '').trim().toLowerCase();
  for (const btn of document.querySelectorAll('.filter-btn')) {
    const type = btn.dataset.type || '';
    btn.classList.toggle('filtered-out', q.length > 0 && !type.toLowerCase().includes(q));
  }
}

function installFilterControls() {
  const search = document.getElementById('filter-search');
  if (search) search.addEventListener('input', applyFilterSearch);

  const slider = document.getElementById('confidence-slider');
  const valueEl = document.getElementById('confidence-value');
  if (slider && valueEl) {
    slider.addEventListener('input', () => {
      minConfidence = parseFloat(slider.value) || 0;
      valueEl.textContent = minConfidence.toFixed(2);
      renderGraph([]); runSimulation(); updateSidebarCounts();
    });
  }

  const allBtn = document.getElementById('filter-all');
  if (allBtn) allBtn.addEventListener('click', () => {
    // Activate every currently-rendered (non-filtered-out) type.
    for (const btn of document.querySelectorAll('.filter-btn')) {
      if (btn.classList.contains('filtered-out')) continue;
      const t = btn.dataset.type;
      activeFilters.add(t); btn.classList.remove('inactive');
    }
    selectedNodeId = null;
    document.getElementById('empty-state').style.display = '';
    document.getElementById('node-detail').classList.remove('visible');
    renderGraph([]); runSimulation(); updateSidebarCounts();
  });

  const noneBtn = document.getElementById('filter-none');
  if (noneBtn) noneBtn.addEventListener('click', () => {
    for (const btn of document.querySelectorAll('.filter-btn')) {
      if (btn.classList.contains('filtered-out')) continue;
      const t = btn.dataset.type;
      activeFilters.delete(t); btn.classList.add('inactive');
    }
    selectedNodeId = null;
    document.getElementById('empty-state').style.display = '';
    document.getElementById('node-detail').classList.remove('visible');
    renderGraph([]); runSimulation(); updateSidebarCounts();
  });
}

function populateSidebar(d){
  document.getElementById('empty-state').style.display='none';
  const detail=document.getElementById('node-detail');
  detail.classList.add('visible');
  const srcBadge='<span class="source-badge msam">Mem0</span>';
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
  // Cross-stack annotation: which Mem0 instances reference this entity.
  const seenInEl = document.getElementById('detail-seen-in');
  seenInEl.innerHTML = '';
  if (Array.isArray(d.seenIn) && d.seenIn.length) {
    seenInEl.innerHTML = '<span class="seen-label">seen in</span>' +
      d.seenIn.map(a => '<span class="stack-pill">'+a+'</span>').join('');
  }
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
  installFilterControls();
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
      const data = buildGraph(msamResult.triples, msamResult.entityTypes ?? new Map(), msamResult.seenIn ?? new Map());
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === "/favicon.ico") {
    // Tiny inline SVG favicon — three connected nodes forming the logo glyph.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="6" fill="#0a0a0f"/>' +
      '<circle cx="16" cy="10" r="3" fill="#22d3ee"/>' +
      '<circle cx="8" cy="22" r="3" fill="#f59e0b"/>' +
      '<circle cx="24" cy="22" r="3" fill="#8b5cf6"/>' +
      '<line x1="16" y1="10" x2="8" y2="22" stroke="#64748b" stroke-width="1.5"/>' +
      '<line x1="16" y1="10" x2="24" y2="22" stroke="#64748b" stroke-width="1.5"/>' +
      '<line x1="8" y1="22" x2="24" y2="22" stroke="#64748b" stroke-width="1.5"/>' +
      '</svg>';
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
    res.end(svg);
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
