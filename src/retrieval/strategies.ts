import { getConfig, getConfigValue } from "../config/index.js";
import {
  cosineSimilarity,
  sigmoidBoost,
  calculateActivation,
  classifyConfidenceTier,
} from "../core/act-r.js";
import type {
  Atom,
  Triple,
  RetrievalResult,
  ConfidenceTier,
  RetrievalMode,
} from "../core/types.js";

// ─── Types ───────────────────────────────────────────────────────

export interface RetrievalParams {
  query: string;
  mode: RetrievalMode;
  topK?: number;
  agentId?: string;
  sessionId?: string;
  /** Injected DB adapter — keeps strategies DB-agnostic */
  db: RetrievalDb;
  /** Injected embedding function */
  embed: (text: string) => Promise<number[]>;
}

export interface ScoredAtom {
  atom: Atom;
  similarity: number;
  combinedScore: number;
  tripleAugmented?: boolean;
  matchedTriples?: number;
  temporalBoosted?: boolean;
  beam?: string;
  multiBeam?: number;
  entityMatch?: boolean;
  queryEntity?: string;
  reranked?: boolean;
  originalRank?: number;
  retrievalVersion: string;
}

export interface RetrievalDb {
  hybridRetrieve(
    queryEmbedding: number[],
    mode: RetrievalMode,
    topK: number,
  ): Promise<ScoredAtom[]>;
  findTriplesByEntity(entity: string): Promise<Triple[]>;
  getAtomById(id: string): Promise<Atom | null>;
  getAtomCount(): Promise<number>;
  getAtomFeedback(atomId: string): Promise<{ total: number; used: number }>;
}

// ─── Query Stopwords ─────────────────────────────────────────────

const QUERY_STOPWORDS = new Set([
  "What", "Where", "When", "Which", "Who", "Whom", "How", "Why",
  "Does", "Did", "Can", "Could", "Would", "Should", "Will",
  "Are", "Is", "Was", "Were", "Has", "Have", "Had",
  "The", "This", "That", "These", "Those",
]);

const CONTENT_STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "no",
  "nor", "not", "only", "own", "same", "so", "than", "too", "very",
  "just", "because", "but", "and", "or", "if", "while", "about", "up",
  "what", "which", "who", "whom", "this", "that", "these", "those",
  "am", "it", "its", "my", "your", "his", "her", "our", "their",
]);

// ─── 1. Triple-Augmented Retrieval ──────────────────────────────

export function extractQueryEntities(query: string): string[] {
  const entities: string[] = [];

  const caps = query.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/g) ?? [];
  for (const c of caps) {
    if (!QUERY_STOPWORDS.has(c) && !entities.includes(c)) {
      entities.push(c);
    }
  }

  const knownEntities: Record<string, string> = {
    user: "User",
    agent: "Agent",
    msam: "MSAM",
    openclaw: "OpenClaw",
  };
  const lower = query.toLowerCase();
  for (const [key, canonical] of Object.entries(knownEntities)) {
    if (lower.includes(key) && !entities.includes(canonical)) {
      entities.push(canonical);
    }
  }

  for (const w of query.split(/\s+/)) {
    const clean = w.replace(/[^\w]/g, "");
    if (clean.length > 4 && !CONTENT_STOPWORDS.has(clean.toLowerCase()) && !entities.includes(clean)) {
      entities.push(clean);
    }
  }

  return entities;
}

export async function tripleAugmentedRetrieve(
  atoms: ScoredAtom[],
  query: string,
  db: RetrievalDb,
): Promise<ScoredAtom[]> {
  const entities = extractQueryEntities(query);
  if (entities.length === 0) return atoms;

  const existingIds = new Set(atoms.map((a) => a.atom.id));
  const augmented: ScoredAtom[] = [...atoms];

  for (const entity of entities) {
    const triples = await db.findTriplesByEntity(entity);
    for (const triple of triples) {
      if (existingIds.has(triple.atomId)) continue;
      const atom = await db.getAtomById(triple.atomId);
      if (!atom || (atom.state !== "active" && atom.state !== "fading")) continue;
      existingIds.add(triple.atomId);
      augmented.push({
        atom,
        similarity: 0,
        combinedScore: triple.confidence * 3.0,
        tripleAugmented: true,
        matchedTriples: 1,
        retrievalVersion: "v2",
      });
    }
  }

  return augmented;
}

// ─── 2. Query Expansion via Entity Resolution ───────────────────

const NOISE_PREDICATES = new Set([
  "can_perform_action_in_browser", "uses_tool", "uses_tool_for",
  "uses_command", "config_file_path", "config_apply_method",
  "requires_condition", "data_source", "data_scraped_date",
  "max_file_lines", "uses_tool_behavior", "uses_tool_purpose",
  "availability_window", "fully_free_time",
  "pre_show_availability", "post_show_response_time",
  "conversation_cadence_time", "sleep_time", "wake_time",
]);

const ALWAYS_EXPAND_PREDICATES = new Set([
  "has_profession", "works_as", "tours_with", "role",
  "has_role", "is_a", "profession", "occupation",
  "performs_in", "show", "production", "identity",
  "lives_in", "based_in", "from", "birthday",
  "has_name", "known_as", "nickname",
]);

function stems(words: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const w of words) {
    result.add(w);
    if (w.endsWith("ing") && w.length > 5) result.add(w.slice(0, -3));
    if (w.endsWith("s") && w.length > 4) result.add(w.slice(0, -1));
    if (w.endsWith("ed") && w.length > 4) result.add(w.slice(0, -2));
    if (w.endsWith("er") && w.length > 4) result.add(w.slice(0, -2));
    if (w.endsWith("tion") && w.length > 6) result.add(w.slice(0, -4));
  }
  return result;
}

export async function expandQuery(query: string, db: RetrievalDb): Promise<string> {
  const entities = extractQueryEntities(query);
  const lower = query.toLowerCase();
  if (lower.includes("user") && !entities.includes("User")) {
    entities.push("User");
  }

  const expansionTerms = new Set<string>();
  const queryContentWords = new Set(lower.split(/\s+/).filter((w) => w.length > 3));
  const queryStems = stems(queryContentWords);

  for (const entity of entities) {
    const triples = await db.findTriplesByEntity(entity);
    for (const triple of triples) {
      const predLower = triple.predicate.toLowerCase();
      if (NOISE_PREDICATES.has(predLower)) continue;

      const predWords = new Set(predLower.replace(/_/g, " ").split(/\s+/));
      const predStems_ = stems(predWords);
      const predRelevant = setsOverlap(predStems_, queryStems);

      const objLower = triple.object.toLowerCase().replace(/_/g, " ");
      const objStems_ = stems(new Set(objLower.split(/\s+/)));
      const objRelevant = setsOverlap(objStems_, queryStems);

      if (ALWAYS_EXPAND_PREDICATES.has(predLower) || predRelevant || objRelevant) {
        const objClean = triple.object.replace(/_/g, " ");
        if (objClean.split(/\s+/).length > 4) continue;
        const noise = ["knows what", "what she", "what he", "self improve", "nothing to", "builds"];
        if (noise.some((n) => objClean.toLowerCase().includes(n))) continue;
        expansionTerms.add(objClean);
      }
    }
  }

  if (expansionTerms.size > 0) {
    const sorted = [...expansionTerms].sort((a, b) => b.length - a.length);
    const maxTerms = getConfigValue("retrieval_v2", "max_expansion_terms", 5);
    return query + " " + sorted.slice(0, maxTerms).join(" ");
  }

  return query;
}

function setsOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const v of a) {
    if (b.has(v)) return true;
  }
  return false;
}

// ─── 3. Temporal Query Detection ─────────────────────────────────

const TEMPORAL_SIGNALS: Record<string, number> = {
  "today": 1,
  "yesterday": 1,
  "recent": 2,
  "recently": 2,
  "latest": 2,
  "last week": 7,
  "this week": 7,
  "last month": 30,
  "this month": 30,
  "just now": 0.1,
  "earlier": 1,
  "ago": 3,
};

export function detectTemporalScope(query: string): number | null {
  const lower = query.toLowerCase();
  for (const [signal, days] of Object.entries(TEMPORAL_SIGNALS)) {
    if (lower.includes(signal)) return days;
  }
  return null;
}

export function applyTemporalFilter(atoms: ScoredAtom[], maxAgeDays: number): ScoredAtom[] {
  const now = Date.now();
  const cutoffMs = maxAgeDays * 24 * 60 * 60 * 1000;

  const filtered: ScoredAtom[] = [];
  for (const item of atoms) {
    const createdAt = item.atom.createdAt ? new Date(item.atom.createdAt).getTime() : 0;
    if (!createdAt) {
      filtered.push(item);
      continue;
    }
    if (now - createdAt <= cutoffMs) {
      const ageHours = (now - createdAt) / 3_600_000;
      const recencyBoost = 1.0 / (1.0 + ageHours / 24.0);
      filtered.push({
        ...item,
        combinedScore: item.combinedScore * (1 + recencyBoost),
        temporalBoosted: true,
      });
    }
  }

  filtered.sort((a, b) => b.combinedScore - a.combinedScore);
  return filtered;
}

// ─── 4. Atom Quality Scoring ─────────────────────────────────────

export function computeAtomQuality(content: string): number {
  if (!content) return 0.0;

  const words = content.split(/\s+/).filter(Boolean);
  const nWords = words.length;

  let lengthScore: number;
  if (nWords < 5) lengthScore = 0.2;
  else if (nWords < 10) lengthScore = 0.5;
  else if (nWords <= 50) lengthScore = 1.0;
  else if (nWords <= 100) lengthScore = 0.9;
  else lengthScore = 0.8;

  const unique = new Set(words.map((w) => w.toLowerCase())).size;
  const uniqueRatio = unique / Math.max(nWords, 1);
  const vocabScore = Math.min(uniqueRatio * 1.5, 1.0);

  const entities = (content.match(/\b[A-Z][a-z]+\b/g) ?? []).length;
  const numbers = (content.match(/\b\d+\b/g) ?? []).length;
  const techTerms = (content.match(/\b[A-Z]{2,}\b/g) ?? []).length;
  const entityDensity = Math.min(((entities + numbers + techTerms) / Math.max(nWords, 1)) * 5, 1.0);

  const structureMarkers =
    (content.match(/:/g) ?? []).length +
    (content.match(/\u2022/g) ?? []).length +
    (content.match(/- /g) ?? []).length;
  const structureScore = Math.min(structureMarkers / 3, 1.0);

  const quality = lengthScore * 0.3 + vocabScore * 0.3 + entityDensity * 0.2 + structureScore * 0.2;
  return Math.round(quality * 1000) / 1000;
}

// ─── 5. Negative Example Tracking (Feedback) ────────────────────

export async function getAtomUsefulness(atomId: string, db: RetrievalDb): Promise<number> {
  const { total, used } = await db.getAtomFeedback(atomId);
  if (total < 3) return 0.5;
  return used / total;
}

// ─── 6. Cross-Encoder Re-Ranking (see reranker.ts) ──────────────

// ─── 7. Embedding Model Hot-Swap — migration tool, not per-query

// ─── 8. Query Rewriting ──────────────────────────────────────────

const DEFAULT_REWRITES: Array<[RegExp, string]> = [
  [/\buser\b/i, "User"],
  [/\bthe user\b/i, "User"],
  [/\buser's\b/i, "User's"],
  [/\bagent\b/i, "Agent"],
  [/\bthe agent\b/i, "Agent"],
  [/\bagent's\b/i, "Agent's"],
  [/\bthis system\b/i, "system"],
  [/\bthis server\b/i, "system"],
];

function getEntityMappings(): Array<[RegExp, string]> {
  const mappings = getConfigValue<Record<string, unknown> | null>("retrieval_v2", "entity_mappings", null);
  if (mappings && typeof mappings === "object") {
    return Object.entries(mappings).map(([k, v]) => [
      new RegExp(`\\b${k}\\b`, "i"),
      String(v),
    ]);
  }
  return DEFAULT_REWRITES;
}

export function rewriteQuery(query: string): string {
  let rewritten = query;
  for (const [pattern, replacement] of getEntityMappings()) {
    rewritten = rewritten.replace(pattern, replacement);
  }
  return rewritten;
}

// ─── 9. Synonym Expansion ────────────────────────────────────────

export function expandWithSynonyms(query: string): string {
  const cfg = getConfig();
  const synonyms = cfg.query_expansion.synonyms;
  const lower = query.toLowerCase();
  const additions: string[] = [];

  for (const [term, syns] of Object.entries(synonyms)) {
    if (lower.includes(term)) {
      additions.push(...syns);
    }
  }

  if (additions.length === 0) return query;
  const maxTerms = getConfigValue("retrieval_v2", "max_expansion_terms", 5);
  return query + " " + additions.slice(0, maxTerms).join(" ");
}

// ─── Entity-Role Scoring ─────────────────────────────────────────

export function entityScoreAdjustment(
  atomEntity: string,
  queryEntity: string,
  confidence: number,
): number {
  if (atomEntity === queryEntity) return 1.0 + confidence * 0.3;
  if (atomEntity === "unknown" || queryEntity === "unknown") return 1.0;
  return Math.max(1.0 - confidence * 0.4, 0.5);
}

// ─── MMR Diversity Selection ─────────────────────────────────────

export function mmrSelect(
  candidates: ScoredAtom[],
  topK: number,
  lambda: number = 0.7,
): ScoredAtom[] {
  if (candidates.length <= topK) return candidates;

  const selected: ScoredAtom[] = [];
  const remaining = [...candidates];

  // Pick the top-scored candidate first
  remaining.sort((a, b) => b.combinedScore - a.combinedScore);
  selected.push(remaining.shift()!);

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const relevance = cand.combinedScore;

      let maxSim = 0;
      for (const sel of selected) {
        if (cand.atom.embedding && sel.atom.embedding) {
          const sim = cosineSimilarity(cand.atom.embedding, sel.atom.embedding);
          if (sim > maxSim) maxSim = sim;
        }
      }

      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

// ─── Quality Filter ──────────────────────────────────────────────

export function applyQualityFilter(atoms: ScoredAtom[]): ScoredAtom[] {
  return atoms.map((item) => {
    const quality = computeAtomQuality(item.atom.content);
    let scoreMultiplier = 1.0;
    if (quality < 0.3) scoreMultiplier = 0.5;
    else if (quality > 0.7) scoreMultiplier = 1.1;
    return { ...item, combinedScore: item.combinedScore * scoreMultiplier };
  });
}

// ─── Confidence Gating ───────────────────────────────────────────

export interface GatedResult {
  atoms: ScoredAtom[];
  tier: ConfidenceTier;
  advisory?: string;
}

export function applyConfidenceGating(atoms: ScoredAtom[]): GatedResult {
  if (atoms.length === 0) {
    return { atoms: [], tier: "none", advisory: "No relevant memories found." };
  }

  const cfg = getConfig();
  const simHigh = cfg.retrieval.confidence_sim_high;
  const simMedium = cfg.retrieval.confidence_sim_medium;
  const simLow = cfg.retrieval.confidence_sim_low;

  const maxSim = Math.max(...atoms.map((a) => a.similarity));
  const topScore = Math.max(...atoms.map((a) => a.combinedScore));

  const tier = classifyConfidenceTier(maxSim, topScore, simHigh, simMedium, simLow);

  if (tier === "high") {
    const pruned = atoms.filter((a) => a.similarity > 0 || a.tripleAugmented);
    return { atoms: pruned.slice(0, 12), tier };
  }
  if (tier === "medium") {
    const filtered = atoms.filter((a) => a.similarity > 0.15);
    return { atoms: filtered.slice(0, 3), tier };
  }
  if (tier === "low") {
    return {
      atoms: atoms.slice(0, 1),
      tier,
      advisory: "Low confidence retrieval. Results may not be relevant.",
    };
  }
  return {
    atoms: [],
    tier: "none",
    advisory: "No relevant memories found for this query.",
  };
}

// ─── Unified Retrieval Pipeline ──────────────────────────────────

export async function retrieve(params: RetrievalParams): Promise<GatedResult> {
  const cfg = getConfig();
  const v2 = cfg.retrieval_v2;
  const topK = params.topK ?? cfg.retrieval.default_top_k;
  const originalQuery = params.query;
  let query = params.query;

  // Step 1: Query rewriting
  if (v2.enable_rewrite) {
    query = rewriteQuery(query);
  }

  // Synonym expansion
  if (v2.enable_query_expansion) {
    query = expandWithSynonyms(query);
  }

  // Step 2: Temporal detection
  let temporalScope: number | null = null;
  if (v2.enable_temporal) {
    temporalScope = detectTemporalScope(query);
  }

  // Step 3: Embed the (possibly rewritten) query
  const queryEmbedding = await params.embed(query);

  // Step 4: Beam search or standard retrieval
  let atoms: ScoredAtom[];
  const beamSetting = v2.enable_beam_search;
  let useBeam = false;

  if (beamSetting === "auto") {
    const count = await params.db.getAtomCount();
    useBeam = count >= v2.beam_search_atom_threshold;
  } else {
    useBeam = Boolean(beamSetting);
  }

  if (useBeam) {
    const { beamSearchRetrieve } = await import("./beam-search.js");
    atoms = await beamSearchRetrieve({
      ...params,
      query,
      originalQuery,
      topK: topK * 2,
      beamWidth: v2.beam_width,
      queryEmbedding,
    });
  } else {
    atoms = await params.db.hybridRetrieve(queryEmbedding, params.mode, topK * 2);
  }

  // Step 5: Triple augmentation
  if (v2.enable_triple_augment) {
    atoms = await tripleAugmentedRetrieve(atoms, originalQuery, params.db);
  }

  // Step 6: Entity-role scoring
  if (v2.enable_entity_roles) {
    const entities = extractQueryEntities(originalQuery);
    const queryEntity = entities.length > 0 ? entities[0] : "unknown";
    for (const item of atoms) {
      const atomEntity = (item.atom.metadata as Record<string, unknown>)?.about_entity as string ?? "unknown";
      const entityConf = Number((item.atom.metadata as Record<string, unknown>)?.entity_confidence ?? 0);
      const combinedConf = Math.min(0.8, Math.max(entityConf, 0.3));
      const multiplier = entityScoreAdjustment(atomEntity, queryEntity, combinedConf);
      item.combinedScore *= multiplier;
      item.entityMatch = atomEntity === queryEntity;
      item.queryEntity = queryEntity;
    }
  }

  // Step 7: Temporal filter
  if (temporalScope !== null) {
    atoms = applyTemporalFilter(atoms, temporalScope);
  }

  // Step 8: Quality filter
  if (v2.enable_quality_filter) {
    atoms = applyQualityFilter(atoms);
  }

  // Sort and take topK
  atoms.sort((a, b) => b.combinedScore - a.combinedScore);
  atoms = atoms.slice(0, topK);

  // Step 9: MMR diversity
  const mmrLambda = cfg.retrieval.mmr_lambda;
  atoms = mmrSelect(atoms, topK, mmrLambda);

  // Step 10: LLM re-ranking
  if (v2.enable_rerank) {
    const { rerankWithLlm } = await import("./reranker.js");
    atoms = await rerankWithLlm(originalQuery, atoms, topK);
  }

  // Tag metadata
  for (const item of atoms) {
    item.retrievalVersion = "v2";
  }

  // Apply confidence gating
  return applyConfidenceGating(atoms);
}
