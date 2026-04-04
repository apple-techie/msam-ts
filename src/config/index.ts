import { z } from "zod";
import { parse as parseToml } from "smol-toml";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Zod Schema ──────────────────────────────────────────────────

const EmbeddingSchema = z.object({
  provider: z.string().default("nvidia-nim"),
  url: z.string().default("https://integrate.api.nvidia.com/v1/embeddings"),
  model: z.string().default("nvidia/nv-embedqa-e5-v5"),
  dimensions: z.number().int().default(1024),
  max_input_chars: z.number().int().default(2000),
  timeout_seconds: z.number().default(10),
  api_key: z.string().nullable().default(null),
  api_key_env: z.string().default("OPENAI_API_KEY"),
  batch_size: z.number().int().default(50),
}).default({});

const StorageSchema = z.object({
  db_path: z.string().default("msam.db"),
  metrics_db_path: z.string().default("msam_metrics.db"),
  token_budget_ceiling: z.number().int().default(40000),
  auto_compact_threshold_pct: z.number().default(85),
  db_busy_timeout_ms: z.number().int().default(5000),
  refuse_threshold_pct: z.number().default(95),
}).default({});

const RetrievalSchema = z.object({
  default_top_k: z.number().int().default(12),
  semantic_weight: z.number().default(0.7),
  similarity_threshold: z.number().default(0.2),
  sigmoid_midpoint: z.number().default(0.35),
  sigmoid_steepness: z.number().default(15.0),
  base_activation_cap: z.number().default(3.0),
  quality_threshold: z.number().default(2.0),
  context_quality_floor: z.number().default(0.15),
  mmr_lambda: z.number().default(0.7),
  keyword_top_k: z.number().int().default(10),
  spreading_activation_enabled: z.boolean().default(true),
  max_spread_hops: z.number().int().default(2),
  spread_decay_factor: z.number().default(0.3),
  confidence_sim_high: z.number().default(0.45),
  confidence_sim_medium: z.number().default(0.30),
  confidence_sim_low: z.number().default(0.15),
  confidence_score_high: z.number().default(40.0),
  confidence_score_medium: z.number().default(10.0),
  temporal_recency_hours: z.number().default(24),
  outcome_weight: z.number().default(0.15),
  outcome_decay: z.number().default(0.95),
  min_outcomes_for_effect: z.number().int().default(3),
}).default({});

const DecaySchema = z.object({
  active_to_fading_threshold: z.number().default(0.3),
  fading_to_dormant_threshold: z.number().default(0.1),
  confidence_decay_rate: z.number().default(0.01),
  confidence_decay_grace_days: z.number().int().default(7),
  confidence_floor: z.number().default(0.1),
  stability_dampen_factor: z.number().default(0.9),
  stability_boost_factor: z.number().default(1.1),
  max_stability: z.number().default(10.0),
  intentional_forgetting_enabled: z.boolean().default(false),
  intentional_forgetting_mode: z.enum(["flag", "auto"]).default("flag"),
  forgetting_contribution_threshold: z.number().default(0.15),
  forgetting_min_retrievals: z.number().int().default(5),
  forgetting_contradiction_threshold: z.number().default(0.85),
  forgetting_confidence_floor: z.number().default(0.1),
  forgetting_grace_days: z.number().int().default(14),
  protection_days: z.number().int().default(7),
  compaction_full_min_age_days: z.number().int().default(7),
  compaction_full_max_access: z.number().int().default(3),
  compaction_standard_min_age_days: z.number().int().default(14),
  compaction_standard_max_access: z.number().int().default(2),
  compaction_trigger_ratio: z.number().default(1.5),
  profile_target_lightweight_chars: z.number().int().default(90),
  profile_target_standard_chars: z.number().int().default(240),
}).default({});

const WorkingMemorySchema = z.object({
  default_ttl_minutes: z.number().int().default(120),
  promotion_threshold: z.number().int().default(3),
  default_profile: z.string().default("lightweight"),
}).default({});

const AtomsSchema = z.object({
  default_profile: z.string().default("standard"),
  default_encoding_confidence: z.number().default(0.7),
  default_arousal: z.number().default(0.5),
  default_valence: z.number().default(0.0),
  profile_lightweight_max_words: z.number().int().default(20),
  profile_full_min_words: z.number().int().default(80),
}).default({});

const MergeSchema = z.object({
  similarity_threshold: z.number().default(0.85),
  max_candidates: z.number().int().default(20),
}).default({});

const VectorIndexSchema = z.object({
  approx_threshold: z.number().int().default(50000),
}).default({});

const ConsolidationSchema = z.object({
  similarity_threshold: z.number().default(0.80),
  min_cluster_size: z.number().int().default(3),
  max_clusters_per_run: z.number().int().default(50),
  stability_reduction_factor: z.number().default(0.5),
}).default({});

const NegativeKnowledgeSchema = z.object({
  default_ttl_hours: z.number().int().default(168),
}).default({});

const AnnotationSchema = z.object({
  llm_url: z.string().default("https://integrate.api.nvidia.com/v1/chat/completions"),
  llm_model: z.string().default("mistralai/mistral-large-3-675b-instruct-2512"),
  timeout_seconds: z.number().default(15),
  api_key_env: z.string().optional(),
}).default({});

const EmotionalContextSchema = z.object({
  urgency_recency_bonus: z.number().default(1.0),
  negative_valence_support_bonus: z.number().default(0.5),
  low_arousal_depth_bonus: z.number().default(0.5),
  high_arousal_recent_bonus: z.number().default(0.3),
}).default({});

const RelationsSchema = z.object({
  supersedes_demotion: z.number().default(2.0),
  supports_bonus: z.number().default(0.5),
}).default({});

const EntityResolutionSchema = z.object({
  aliases: z.record(z.string(), z.string()).default({
    user_nick: "user",
    agent_nick: "agent",
  }),
}).default({});

const QueryExpansionSchema = z.object({
  synonyms: z.record(z.string(), z.array(z.string())).default({
    profession: ["job", "career", "work", "occupation"],
    show: ["performance", "tour", "concert"],
    anime: ["manga", "japanese animation"],
    music: ["songs", "playlist", "listening"],
    schedule: ["routine", "calendar", "plan", "timetable"],
    home: ["hometown", "residence", "where lives", "based"],
    family: ["parents", "siblings", "relatives"],
    feelings: ["emotions", "mood", "emotional state"],
    memory: ["remember", "recall", "memories", "msam"],
  }),
}).default({});

const RetrievalV2Schema = z.object({
  enabled: z.boolean().default(true),
  enable_beam_search: z.union([z.boolean(), z.literal("auto")]).default("auto"),
  beam_search_atom_threshold: z.number().int().default(10000),
  beam_width: z.number().int().default(3),
  enable_rewrite: z.boolean().default(true),
  enable_query_expansion: z.boolean().default(true),
  enable_triple_augment: z.boolean().default(true),
  enable_entity_roles: z.boolean().default(true),
  enable_quality_filter: z.boolean().default(true),
  enable_temporal: z.boolean().default(true),
  enable_rerank: z.boolean().default(false),
  enable_feedback: z.boolean().default(true),
  max_expansion_terms: z.number().int().default(5),
  rerank_model: z.string().default("mistralai/mistral-large-3-675b-instruct-2512"),
  entity_mappings: z.record(z.string(), z.unknown()).nullable().default(null),
}).default({});

const PredictiveRetrievalSchema = z.object({
  user_active: z.boolean().default(true),
}).default({});

const PredictionSchema = z.object({
  temporal_weight: z.number().default(0.4),
  coretrieval_weight: z.number().default(0.4),
  momentum_weight: z.number().default(0.2),
  lookback_days: z.number().int().default(30),
  min_confidence: z.number().default(0.3),
  enabled: z.boolean().default(true),
  temporal_window_hours: z.number().default(2),
  min_pattern_count: z.number().int().default(5),
  co_retrieval_threshold: z.number().int().default(3),
  max_predicted_atoms: z.number().int().default(8),
  warmup_sessions: z.number().int().default(50),
}).default({});

const ContextSchema = z.object({
  default_token_budget: z.number().int().default(500),
  default_top_k: z.number().int().default(10),
  probe_token_budget: z.number().int().default(200),
  probe_top_k: z.number().int().default(5),
  startup_identity_query: z.string().default("agent identity core traits personality"),
  startup_user_query: z.string().default("user preferences relationship current situation"),
  startup_recent_query: z.string().default("what happened today recent activity"),
  startup_emotional_query: z.string().default("emotional state mood current feeling"),
  probe_queries: z.array(z.string()).default([
    "user current situation schedule",
    "agent identity personality traits",
  ]),
  probe_atom_queries: z.array(z.string()).default([
    "What is the user's profession?",
    "Who is the agent?",
  ]),
  emotional_state_file: z.string().default("memory/context/emotional-state.md"),
  metrics_port: z.number().int().optional(),
}).default({});

const CrossDiscoveryGroupSchema = z.object({
  name: z.string(),
  agents: z.array(z.string()),
});

const CrossDiscoveryBridgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  mode: z.enum(["entities-only", "full", "off"]).default("off"),
});

const CrossDiscoverySchema = z.object({
  enabled: z.boolean().default(false),
  groups: z.array(CrossDiscoveryGroupSchema).default([]),
  bridges: z.array(CrossDiscoveryBridgeSchema).default([]),
}).default({});

const AgentsSchema = z.object({
  default_agent_id: z.string().default("default"),
  enable_sharing: z.boolean().default(true),
  cross_discovery: CrossDiscoverySchema,
}).default({});

const CompressionSchema = z.object({
  enable_subatom: z.boolean().default(true),
  enable_fact_dedup: z.boolean().default(true),
  enable_synthesis: z.boolean().default(false),
  subatom_token_budget: z.number().int().default(120),
  subatom_section_budget: z.number().int().default(30),
  sentence_similarity_threshold: z.number().default(0.25),
  dedup_similarity_threshold: z.number().default(0.85),
  synthesis_max_tokens: z.number().int().default(30),
  synthesis_model: z.string().default("mistralai/mistral-large-3-675b-instruct-2512"),
}).default({});

const ComparisonSchema = z.object({
  startup_files: z.array(z.string()).default([]),
  query_files: z.array(z.string()).default([]),
}).default({});

const TriplesSchema = z.object({
  llm_url: z.string().default("https://integrate.api.nvidia.com/v1/chat/completions"),
  llm_model: z.string().default("mistralai/mistral-large-3-675b-instruct-2512"),
  api_key_env: z.string().optional(),
}).default({});

const ApiSchema = z.object({
  port: z.number().int().default(3001),
  host: z.string().default("127.0.0.1"),
  allowed_origins: z.array(z.string()).default([
    "http://127.0.0.1:3000",
    "http://localhost:3000",
  ]),
  api_key: z.string().nullable().default(null),
}).default({});

const MetricsSchema = z.object({
  enabled: z.boolean().default(true),
  log_access_events: z.boolean().default(true),
  log_emotional_state: z.boolean().default(true),
  hybrid_probe_on_snapshot: z.boolean().default(true),
  default_emotional_intensity: z.number().default(0.5),
  default_emotional_warmth: z.number().default(0.5),
  continuity_history_limit: z.number().int().default(100),
  retrieval_history_limit: z.number().int().default(100),
}).default({});

const WorldModelSchema = z.object({
  enabled: z.boolean().default(true),
  auto_close_on_conflict: z.boolean().default(true),
  temporal_extraction: z.boolean().default(true),
  default_confidence: z.number().default(1.0),
}).default({});

const SycophancySchema = z.object({
  tracking_enabled: z.boolean().default(true),
  warning_threshold: z.number().default(0.85),
  window_size: z.number().int().default(20),
}).default({});

export const MsamConfigSchema = z.object({
  embedding: EmbeddingSchema,
  storage: StorageSchema,
  retrieval: RetrievalSchema,
  retrieval_v2: RetrievalV2Schema,
  decay: DecaySchema,
  working_memory: WorkingMemorySchema,
  atoms: AtomsSchema,
  merge: MergeSchema,
  vector_index: VectorIndexSchema,
  consolidation: ConsolidationSchema,
  negative_knowledge: NegativeKnowledgeSchema,
  annotation: AnnotationSchema,
  emotional_context: EmotionalContextSchema,
  relations: RelationsSchema,
  entity_resolution: EntityResolutionSchema,
  query_expansion: QueryExpansionSchema,
  predictive_retrieval: PredictiveRetrievalSchema,
  prediction: PredictionSchema,
  context: ContextSchema,
  agents: AgentsSchema,
  compression: CompressionSchema,
  comparison: ComparisonSchema,
  triples: TriplesSchema,
  api: ApiSchema,
  metrics: MetricsSchema,
  world_model: WorldModelSchema,
  sycophancy: SycophancySchema,
}).passthrough();

export type MsamConfig = z.infer<typeof MsamConfigSchema>;

// ─── Config Resolution ───────────────────────────────────────────

function findTomlPath(): string | null {
  const envConfig = process.env.MSAM_CONFIG;
  if (envConfig) {
    const expanded = envConfig.replace(/^~/, homedir());
    if (existsSync(expanded)) return expanded;
  }

  const envData = process.env.MSAM_DATA_DIR;
  if (envData) {
    const expanded = join(envData.replace(/^~/, homedir()), "msam.toml");
    if (existsSync(expanded)) return expanded;
  }

  const userConfig = join(homedir(), ".msam", "msam.toml");
  if (existsSync(userConfig)) return userConfig;

  return null;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (
      k in result &&
      typeof result[k] === "object" &&
      result[k] !== null &&
      !Array.isArray(result[k]) &&
      typeof v === "object" &&
      v !== null &&
      !Array.isArray(v)
    ) {
      result[k] = deepMerge(
        result[k] as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ─── Singleton ───────────────────────────────────────────────────

let _config: MsamConfig | null = null;

function loadConfig(): MsamConfig {
  if (_config) return _config;

  let rawData: Record<string, unknown> = {};

  const tomlPath = findTomlPath();
  if (tomlPath) {
    const content = readFileSync(tomlPath, "utf-8");
    rawData = parseToml(content) as Record<string, unknown>;
  }

  _config = MsamConfigSchema.parse(rawData);
  return _config;
}

export function getConfig(): MsamConfig {
  return loadConfig();
}

export function getConfigValue<T>(section: string, key: string, defaultValue?: T): T {
  const config = loadConfig();
  const sec = (config as Record<string, unknown>)[section];
  if (sec && typeof sec === "object" && sec !== null) {
    const sectionObj = sec as Record<string, unknown>;
    if (key in sectionObj) {
      return sectionObj[key] as T;
    }
  }
  if (arguments.length >= 3) {
    return defaultValue as T;
  }
  throw new Error(`Config key not found: [${section}] ${key}`);
}

export function reloadConfig(): MsamConfig {
  _config = null;
  return loadConfig();
}

export function getRawConfig(): Record<string, unknown> {
  return loadConfig() as unknown as Record<string, unknown>;
}

// For testing: allow injecting config from parsed TOML string
export function loadConfigFromString(toml: string): MsamConfig {
  const rawData = parseToml(toml) as Record<string, unknown>;
  _config = MsamConfigSchema.parse(rawData);
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
