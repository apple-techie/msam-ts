import { describe, it, expect, beforeEach } from "vitest";
import {
  getConfig,
  getConfigValue,
  loadConfigFromString,
  resetConfig,
  MsamConfigSchema,
} from "../../src/config/index.js";

beforeEach(() => {
  resetConfig();
});

describe("config", () => {
  describe("parsing a minimal TOML config", () => {
    it("parses a config with only one section", () => {
      const cfg = loadConfigFromString(`
[embedding]
provider = "openai"
url = "https://api.openai.com/v1/embeddings"
model = "text-embedding-3-small"
dimensions = 1536
`);
      expect(cfg.embedding.provider).toBe("openai");
      expect(cfg.embedding.url).toBe("https://api.openai.com/v1/embeddings");
      expect(cfg.embedding.model).toBe("text-embedding-3-small");
      expect(cfg.embedding.dimensions).toBe(1536);
    });

    it("parses a multi-section config", () => {
      const cfg = loadConfigFromString(`
[storage]
db_path = "custom.db"
token_budget_ceiling = 500000

[api]
port = 3901
host = "0.0.0.0"
`);
      expect(cfg.storage.db_path).toBe("custom.db");
      expect(cfg.storage.token_budget_ceiling).toBe(500000);
      expect(cfg.api.port).toBe(3901);
      expect(cfg.api.host).toBe("0.0.0.0");
    });

    it("parses the production config format", () => {
      const cfg = loadConfigFromString(`
[embedding]
provider = "openai"
url = "https://api.openai.com/v1/embeddings"
model = "text-embedding-3-small"
dimensions = 1536
api_key_env = "OPENAI_API_KEY"
max_input_chars = 2000
timeout_seconds = 10
batch_size = 50

[storage]
db_path = "msam.db"
metrics_db_path = "msam_metrics.db"
token_budget_ceiling = 500000
auto_compact_threshold_pct = 90
refuse_threshold_pct = 99
db_busy_timeout_ms = 5000

[retrieval]
default_top_k = 12
semantic_weight = 0.7
spreading_activation_enabled = true
max_spread_hops = 4

[agents]
default_agent_id = "gateway-one"
enable_sharing = true

[triples]
llm_url = "https://integrate.api.nvidia.com/v1/chat/completions"
llm_model = "mistralai/mistral-large-3-675b-instruct-2512"
`);
      expect(cfg.embedding.provider).toBe("openai");
      expect(cfg.storage.token_budget_ceiling).toBe(500000);
      expect(cfg.retrieval.max_spread_hops).toBe(4);
      expect(cfg.agents.default_agent_id).toBe("gateway-one");
      expect(cfg.triples.llm_model).toBe("mistralai/mistral-large-3-675b-instruct-2512");
    });
  });

  describe("default values", () => {
    it("applies all defaults for an empty config", () => {
      const cfg = loadConfigFromString("");
      expect(cfg.embedding.provider).toBe("nvidia-nim");
      expect(cfg.embedding.dimensions).toBe(1024);
      expect(cfg.embedding.batch_size).toBe(50);
      expect(cfg.storage.db_path).toBe("msam.db");
      expect(cfg.storage.token_budget_ceiling).toBe(40000);
      expect(cfg.retrieval.default_top_k).toBe(12);
      expect(cfg.retrieval.semantic_weight).toBe(0.7);
      expect(cfg.decay.protection_days).toBe(7);
      expect(cfg.decay.intentional_forgetting_enabled).toBe(false);
      expect(cfg.working_memory.default_ttl_minutes).toBe(120);
      expect(cfg.atoms.default_profile).toBe("standard");
      expect(cfg.merge.similarity_threshold).toBe(0.85);
      expect(cfg.consolidation.min_cluster_size).toBe(3);
      expect(cfg.negative_knowledge.default_ttl_hours).toBe(168);
      expect(cfg.emotional_context.urgency_recency_bonus).toBe(1.0);
      expect(cfg.relations.supersedes_demotion).toBe(2.0);
      expect(cfg.prediction.temporal_weight).toBe(0.4);
      expect(cfg.prediction.warmup_sessions).toBe(50);
      expect(cfg.context.default_token_budget).toBe(500);
      expect(cfg.agents.default_agent_id).toBe("default");
      expect(cfg.compression.enable_subatom).toBe(true);
      expect(cfg.compression.enable_synthesis).toBe(false);
      expect(cfg.api.port).toBe(3001);
      expect(cfg.api.host).toBe("127.0.0.1");
      expect(cfg.metrics.enabled).toBe(true);
      expect(cfg.world_model.enabled).toBe(true);
      expect(cfg.sycophancy.tracking_enabled).toBe(true);
      expect(cfg.sycophancy.window_size).toBe(20);
      expect(cfg.retrieval_v2.enabled).toBe(true);
      expect(cfg.retrieval_v2.enable_beam_search).toBe("auto");
      expect(cfg.predictive_retrieval.user_active).toBe(true);
    });

    it("preserves defaults for sections not in the TOML", () => {
      const cfg = loadConfigFromString(`
[embedding]
provider = "openai"
`);
      expect(cfg.embedding.provider).toBe("openai");
      expect(cfg.embedding.dimensions).toBe(1024);
      expect(cfg.storage.db_path).toBe("msam.db");
      expect(cfg.decay.protection_days).toBe(7);
      expect(cfg.api.port).toBe(3001);
    });

    it("preserves defaults for keys not in a partial section", () => {
      const cfg = loadConfigFromString(`
[retrieval]
default_top_k = 20
`);
      expect(cfg.retrieval.default_top_k).toBe(20);
      expect(cfg.retrieval.semantic_weight).toBe(0.7);
      expect(cfg.retrieval.mmr_lambda).toBe(0.7);
      expect(cfg.retrieval.spreading_activation_enabled).toBe(true);
    });
  });

  describe("getConfigValue helper", () => {
    it("returns the value for an existing key", () => {
      loadConfigFromString(`
[embedding]
provider = "openai"
dimensions = 1536
`);
      expect(getConfigValue("embedding", "provider")).toBe("openai");
      expect(getConfigValue("embedding", "dimensions")).toBe(1536);
    });

    it("returns the default for a missing key", () => {
      loadConfigFromString("");
      expect(getConfigValue("embedding", "nonexistent", "fallback")).toBe("fallback");
    });

    it("throws when key is missing and no default provided", () => {
      loadConfigFromString("");
      expect(() => getConfigValue("embedding", "nonexistent")).toThrow(
        "Config key not found: [embedding] nonexistent",
      );
    });

    it("throws for a missing section when no default provided", () => {
      loadConfigFromString("");
      expect(() => getConfigValue("nonexistent_section", "key")).toThrow(
        "Config key not found: [nonexistent_section] key",
      );
    });

    it("returns default for a missing section", () => {
      loadConfigFromString("");
      expect(getConfigValue("nonexistent_section", "key", 42)).toBe(42);
    });

    it("returns falsy values correctly (not confused with missing)", () => {
      loadConfigFromString(`
[decay]
intentional_forgetting_enabled = false
confidence_floor = 0.0
`);
      expect(getConfigValue("decay", "intentional_forgetting_enabled")).toBe(false);
      expect(getConfigValue("decay", "confidence_floor")).toBe(0.0);
    });
  });

  describe("Zod validation rejects invalid config", () => {
    it("rejects wrong type for a number field", () => {
      expect(() =>
        MsamConfigSchema.parse({
          embedding: { dimensions: "not-a-number" },
        }),
      ).toThrow();
    });

    it("rejects wrong type for a boolean field", () => {
      expect(() =>
        MsamConfigSchema.parse({
          retrieval: { spreading_activation_enabled: "yes" },
        }),
      ).toThrow();
    });

    it("rejects invalid enum value for intentional_forgetting_mode", () => {
      expect(() =>
        MsamConfigSchema.parse({
          decay: { intentional_forgetting_mode: "delete" },
        }),
      ).toThrow();
    });
  });

  describe("getConfig singleton", () => {
    it("returns the same object on repeated calls", () => {
      loadConfigFromString("");
      const a = getConfig();
      const b = getConfig();
      expect(a).toBe(b);
    });
  });

  describe("entity_resolution and query_expansion defaults", () => {
    it("has default aliases", () => {
      const cfg = loadConfigFromString("");
      expect(cfg.entity_resolution.aliases).toEqual({
        user_nick: "user",
        agent_nick: "agent",
      });
    });

    it("has default synonyms", () => {
      const cfg = loadConfigFromString("");
      expect(cfg.query_expansion.synonyms.profession).toEqual([
        "job", "career", "work", "occupation",
      ]);
      expect(cfg.query_expansion.synonyms.memory).toEqual([
        "remember", "recall", "memories", "msam",
      ]);
    });

    it("overrides aliases from TOML", () => {
      const cfg = loadConfigFromString(`
[entity_resolution.aliases]
person_one = "user"
"gateway-one" = "agent"
`);
      expect(cfg.entity_resolution.aliases).toEqual({
        person_one: "user",
        "gateway-one": "agent",
      });
    });
  });
});
