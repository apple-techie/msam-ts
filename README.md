# MSAM

**Multi-Stream Adaptive Memory** -- a production-grade cognitive memory architecture for AI agents. TypeScript port.

MSAM gives agents persistent, structured memory that self-regulates what it stores, how it retrieves, and when it forgets. Knowledge lives as discrete atoms across semantic, episodic, procedural, and working memory streams, scored using ACT-R activation theory, and retrieved through a hybrid pipeline combining pgvector similarity search, keyword matching, and a knowledge graph of subject-predicate-object triples. A REST API exposes the full system for language-agnostic integration, and a multi-agent protocol lets multiple agents share or isolate memories.

When MSAM knows something, it delivers. When it doesn't, it says so. Output volume is proportional to confidence -- not padded with noise.

This is a ground-up TypeScript rewrite of the [original Python MSAM](https://github.com/jadenschwab/msam). The storage backend has been replaced: SQLite + FAISS gives way to PostgreSQL + pgvector, enabling native vector indexing, concurrent multi-agent access, and simpler operational deployment. Every module, CLI command, and API endpoint has been ported. A migration script handles SQLite-to-PostgreSQL data transfer.

Built for production. Running in production. 35 source files, 8.5K LOC, 285 tests, 57 CLI commands, 22+ API endpoints.

## Benchmark Highlights

Measured on production hardware (Hetzner CAX11, 2 vCPU ARM64, 4GB RAM).

| Scenario | MD Baseline | Output | vs MD | Shannon Eff | Tier | Latency |
|---|---|---|---|---|---|---|
| Startup (delta) | 7,327t | 51t | **99.3%** | 51.0% | -- | 2,477ms |
| Known query | 7,327t | 91t | **98.8%** | 14.3% | medium | 1,082ms |
| Unknown query | 7,327t | 33t | **99.5%** | 57.6% | low | 1,082ms |
| No data | 7,327t | 0t | **100%** | -- | none | 1,064ms |

### Session Economics (startup + 10 queries)

| Metric | Flat Files (selective) | MSAM | Savings |
|---|---|---|---|
| Tokens per session | ~12,000t | ~1,351t | **89%** |
| Cost (Opus @ $15/MTok) | ~$0.18 | $0.02 | **$0.16** |
| Context window usage | ~30% of 40K | 0.3% of 40K | ~30% freed |

Note: file baseline assumes selective loading (only relevant files per query). Naive full-reload systems see 98%+ savings.

## Why MSAM

Most agent memory systems are vector stores with a retrieval wrapper. MSAM is different:

- **Adaptive output.** Confidence-gated retrieval: high confidence returns full results, low returns minimal context, none returns nothing. The system doesn't hallucinate -- it admits gaps.

- **Multi-stream architecture.** Semantic (facts), episodic (events), procedural (how-to), and working (session-scoped) streams. Each has different retrieval behavior, decay characteristics, and promotion rules.

- **Shannon-compressed startup.** Session context uses subatom extraction, codebook compression, delta encoding, and semantic deduplication to reach 51 tokens from a 7,327-token markdown baseline. 51% of Shannon's theoretical minimum.

- **Cognitive scoring.** ACT-R activation model: base-level activation (frequency + recency) x sigmoid similarity x annotation bonuses x stability. Not just "closest vector."

- **Adaptive scaling.** Multi-beam retrieval sleeps until the database is large enough to benefit. Compression only runs where it earns its compute. The pipeline doesn't pay scale-tax before scale arrives.

- **Forgetting as a feature.** Intentional forgetting with four signal types (low activation, redundancy, staleness, contradiction). Exponential decay based on retrievability. Atoms transition through active, fading, dormant, and tombstone states. Nothing is deleted -- everything is auditable.

- **Self-improving retrieval.** Contribution tracking marks which atoms influenced agent responses. Over-retrieved noise gets dampened. High-value atoms get boosted. The feedback loop runs every decay cycle.

- **Temporal awareness.** Queries about "right now" or "today" require recent atoms. Stale data is demoted regardless of similarity score.

- **Knowledge graph with contradiction detection.** Subject-predicate-object triples extracted from atoms, traversable via graph queries, with semantic contradiction detection across negation, temporal supersession, value conflicts, and antonyms.

- **Multi-agent memory.** Agent isolation via namespaced atoms, selective sharing between agents, per-agent statistics. Multiple agents can share a single MSAM instance without interference.

- **Predictive prefetch.** Three-strategy prediction engine (temporal patterns, co-retrieval history, topic momentum) anticipates what atoms an agent will need before it asks. Predictive Context Assembly pre-loads atoms into session context based on time-of-day and co-retrieval patterns, with a configurable warmup gate.

- **Felt Consequence.** Outcome-attributed memory scoring tracks whether retrieved atoms led to good or bad outcomes. Atoms that consistently contribute to successful responses get boosted; atoms that produce poor outcomes get dampened. The feedback signal decays exponentially so recent outcomes matter more.

- **Post-store graph sync.** Debounced automatic Neo4j sync via graph accelerator. After any store call, a configurable debounce timer schedules a full ETL sync (atoms, triples, entities, domain labels, tombstone cleanup). Multiple stores within the debounce window coalesce into a single sync.

- **Multi-gateway agent registry.** Agent-to-gateway mapping with automatic grouping, legacy agent exclusion, and sorted export for the KG viewer. Connected gateways include Enduru (ubuntu-root + mac-studio), Enduru (ubuntu-root), and Turkules (vm-1).

- **REST API.** Full HTTP interface (`msam serve`) with 22+ endpoints covering every subsystem -- store, query, context, feedback, decay, stats, triples, contradictions, prediction, consolidation, replay, forget, calibrate, re-embed, agents, audit, and Grafana metrics.

- **Native pgvector search.** PostgreSQL with the pgvector extension replaces SQLite + FAISS. Vector similarity is computed server-side using pgvector's indexed cosine distance, eliminating the need for a separate vector index process and enabling concurrent access from multiple services.

## Technology Stack

| Component | Python (original) | TypeScript (this port) |
|---|---|---|
| Language | Python 3.11+ | TypeScript 5.7+ / Node.js 22+ |
| HTTP server | FastAPI | Fastify 5 |
| ORM | raw SQLite3 | Drizzle ORM |
| Database | SQLite | PostgreSQL 16 |
| Vector search | FAISS (in-process) | pgvector (server-side) |
| CLI framework | argparse + custom | Commander.js |
| Testing | pytest | Vitest |
| Logging | stdlib logging | Pino |
| Metrics | custom JSON | prom-client (Prometheus) |
| Config format | TOML | TOML (smol-toml parser) |
| Validation | manual | Zod |
| Container | single Python process | multi-stage Node.js (node:22-slim) |

## Quick Start

### Prerequisites
- Node.js 22+ (uses ESM modules)
- PostgreSQL 16 with the pgvector extension (or use the included `docker-compose.yml`)
- An embedding provider (choose one):
  - **NVIDIA NIM** (default) -- free tier, API key from [build.nvidia.com](https://build.nvidia.com)
  - **OpenAI** -- `text-embedding-3-small`, API key from OpenAI
  - **ONNX Runtime** (local) -- no API key needed
  - **Local** (sentence-transformers) -- no API key needed

### Install

```bash
git clone <repo-url>
cd msam-ts
npm install
npm run build
```

### Configure

```bash
mkdir -p ~/.msam
cp msam.example.toml ~/.msam/msam.toml
```

Edit `~/.msam/msam.toml` for your deployment. The critical section is `[embedding]`:

```toml
# Option A: NVIDIA NIM (free, recommended)
[embedding]
provider = "nvidia-nim"
# Set env: export NVIDIA_NIM_API_KEY="your-key"

# Option B: OpenAI
[embedding]
provider = "openai"
model = "text-embedding-3-small"
# Set env: export OPENAI_API_KEY="your-key"

# Option C: ONNX Runtime (local, no API key)
[embedding]
provider = "onnx"
model = "BAAI/bge-small-en-v1.5"
dimensions = 384
```

Set the database connection:

```bash
export DATABASE_URL="postgresql://msam:msam@localhost:5432/msam"
```

### Docker Compose (recommended)

The easiest way to run MSAM with all supporting services:

```bash
cp .env.example .env
# Edit .env with your API keys and Tailscale auth key
docker compose up -d
```

This starts all 7 services. See the [Services](#services) section for details.

### Standalone

```bash
# Run database migrations
npm run db:migrate

# Store your first memory
node dist/index.js store "The user prefers dark mode and concise responses"

# Retrieve (confidence-gated output)
node dist/index.js query "What are the user's preferences?"

# Session startup context (compressed)
node dist/index.js context

# Start the REST API server
node dist/index.js serve

# See all commands
node dist/index.js help
```

### Development

```bash
# Run in dev mode (tsx, auto-reload)
npm run dev -- serve

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Type check
npm run lint

# Open Drizzle Studio (database GUI)
npm run db:studio
```

## Migration from Python (SQLite to PostgreSQL)

A migration script transfers all data from an existing Python MSAM SQLite database to PostgreSQL:

```bash
npm run migrate:sqlite -- --sqlite /path/to/msam.db --postgres postgresql://msam:msam@localhost:5432/msam
```

The script handles:
- Deserializing FAISS float32 embedding blobs to pgvector format
- Timestamp normalization (SQLite's loose datetime strings to PostgreSQL `timestamptz`)
- All tables: atoms, triples, access_log, co_retrieval, temporal_patterns, negative_knowledge, provenance, forgetting_log, atom_versions, corrections

The migration is additive (INSERT with ON CONFLICT skip) and safe to re-run.

## Configuration

Every subsystem is configurable via `~/.msam/msam.toml`. Configuration is validated at startup with Zod schemas -- invalid or unrecognized keys cause immediate, descriptive errors.

Key sections:

| Section | Controls |
|---------|----------|
| `[embedding]` | Provider (nvidia-nim, openai, onnx, local), model, dimensions, API keys |
| `[storage]` | Token budget ceiling, auto-compact threshold, DB paths |
| `[retrieval]` | top_k, similarity threshold, sigmoid curve, semantic/keyword weights, confidence tiers, outcome scoring |
| `[retrieval_v2]` | Beam search gate, entity roles, quality filter, temporal detection, reranking |
| `[decay]` | State transition thresholds, confidence decay rate, stability factors, forgetting config, compaction profiles |
| `[working_memory]` | Session atom TTL, promotion threshold, default profile |
| `[atoms]` | Default profile, encoding confidence, arousal, valence |
| `[merge]` | Similarity threshold for merge suggestions |
| `[negative_knowledge]` | TTL for negative examples |
| `[emotional_context]` | Urgency, valence, arousal scoring bonuses |
| `[relations]` | Supersedes penalty, supports bonus |
| `[consolidation]` | Cluster similarity, min cluster size, stability reduction |
| `[annotation]` | LLM URL, model, timeout for annotation |
| `[triples]` | LLM URL and model for triple extraction |
| `[compression]` | Subatom extraction, sentence dedup, synthesis model and thresholds |
| `[prediction]` | Temporal/co-retrieval/momentum weights, lookback, warmup gate, predictive context assembly |
| `[agents]` | Default agent ID, sharing toggle |
| `[context]` | Startup queries, probe queries, token budgets |
| `[api]` | Server port, host binding, CORS allowed origins |
| `[metrics]` | Metrics logging toggles, probe settings |
| `[entity_resolution]` | Alias mappings (nicknames to canonical names) |
| `[query_expansion]` | Synonym groups for query rewriting |
| `[world_model]` | Temporal world model: enable/disable, auto-close on conflict |
| `[sycophancy]` | Agreement rate tracking: enable/disable, warning threshold, window size |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `MSAM_API_KEY` | API key for authenticated endpoints (optional, open access if unset) |
| `OPENAI_API_KEY` | OpenAI embedding provider key |
| `NVIDIA_NIM_API_KEY` | NVIDIA NIM embedding provider key |
| `GRAPH_ACCEL_URL` | Graph accelerator endpoint (default: `http://graph-accelerator:3902`) |
| `GRAPH_SYNC_DEBOUNCE_SECONDS` | Debounce interval for graph sync (default: `300`) |

## Architecture

```
Query
  |
  v
retrieve pipeline:
  rewrite -> temporal detect -> [beam search | single retrieve]
  -> triple augment -> entity role scoring -> quality filter -> sort
  |                                    |
  |                        pgvector cosine distance
  |                        (server-side, indexed)
  v
Confidence gating:
  high:   full results, zero-sim pruned, <=12 triples
  medium: top 3 atoms (sim > 0.15), <=8 triples
  low:    1 atom, no triples, advisory
  none:   empty, advisory only
  |
  v
Output (91-176t high, 0-33t low, 0t none)

Post-store hook:
  store call -> scheduleGraphSync() -> [debounce 5min] -> POST graph-accelerator/sync
                                                           |
                                                    Neo4j ETL pipeline


Context startup:
  4 queries (identity/partner/recent/emotional)
  -> subatom extraction -> codebook -> delta encoding -> dedup
  -> 51 tokens (99.3% compression)
```

### Confidence Tier System

| Tier | Similarity | Output | Token Volume |
|---|---|---|---|
| High | >= 0.45 | Full results, zero-sim pruned, <=12 triples | 140-176t |
| Medium | >= 0.30 | Top 3 atoms (sim > 0.15), <=8 triples | 91-131t |
| Low | >= 0.15 | 1 atom for context, no triples, advisory | 0-33t |
| None | < 0.15 | Empty, advisory only | 0t |

Note: confidence tiers reflect similarity relative to stored atoms. Small databases (< 50 atoms) produce higher similarity scores for off-topic queries because the embedding space has fewer candidates. Discrimination improves as the database grows. Tune thresholds via `confidence_sim_high`, `confidence_sim_medium`, and `confidence_sim_low` in `msam.toml`.

### Adaptive Scaling

Multi-beam retrieval activates based on database size:

```toml
[retrieval_v2]
enable_beam_search = "auto"          # "auto" | true | false
beam_search_atom_threshold = 10000   # activates above this atom count
beam_width = 3
```

At current scale, single-beam. At 10K+, multi-beam. The code stays, the architecture scales, the pipeline doesn't pay for features it doesn't need yet.

### Storage Model

**Atoms** are discrete memory units with three profiles:

| Profile | Tokens | Use Case |
|---------|--------|----------|
| Lightweight | ~50 | Working memory, compressed facts |
| Standard | ~150 | Most knowledge |
| Full | ~300 | Rich context, important events |

Atoms are stored in PostgreSQL with pgvector embeddings (1536-dimensional by default). Content deduplication uses a `content_hash` + `agent_id` unique index, scoped to active/fading states.

**Triples** are structured subject-predicate-object facts:
- `(User, has_profession, engineer)`
- Traversable via `graph_traverse()` and `graph_path()`
- Contradiction detection across conflicting predicates
- Optional embeddings for semantic triple search

### Database Schema

18 tables managed by Drizzle ORM:

| Table | Purpose |
|-------|---------|
| `atoms` | Core memory atoms with embeddings, state, scores |
| `atom_topics` | Topic tags per atom |
| `access_log` | Retrieval history with contribution tracking |
| `triples` | Subject-predicate-object knowledge graph |
| `sentence_embeddings` | Subatom-level embeddings for fine-grained retrieval |
| `co_retrieval` | Co-retrieval pairs for predictive prefetch |
| `temporal_patterns` | Hour/day retrieval patterns |
| `negative_knowledge` | Queries with no results (prevents re-searching) |
| `corrections` | Atom correction history |
| `atom_versions` | Version history for edited atoms |
| `atom_relations` | Typed relations between atoms |
| `provenance` | Full audit trail for all entity actions |
| `forgetting_log` | State transition audit log |
| `retrieval_outcomes` | Session-level retrieval feedback |
| `retrieval_feedback` | Per-atom retrieval quality signals |
| `agents` | Registered agent metadata |
| `schema_version` | Migration tracking |

### Decay Cycle

```
ACTIVE --(R < 0.3)--> FADING --(R < 0.1)--> DORMANT --(manual)--> TOMBSTONE
  ^                                                                    |
  +----------------------- (accessed: reactivate) ---------------------+
```

- Retrievability: `R(t) = e^(-t/S)` (exponential decay with stability)
- Protected atoms: recently accessed or pinned
- Confidence decay: 0.01/day after 7-day grace period
- Every state transition logged with justification

### Graph Sync Hook

The MSAM server includes a post-store hook that automatically syncs data to Neo4j via the graph accelerator:

1. Agent stores memory via `/v1/store`
2. `scheduleGraphSync()` starts/resets a debounce timer
3. After the debounce interval (default 5 minutes) with no new stores, triggers `POST graph-accelerator:3902/sync`
4. Graph accelerator runs full ETL: atoms, triples, entities, domain labels, tombstone cleanup

Multiple stores within the debounce window coalesce into a single sync. Configurable via `GRAPH_ACCEL_URL` and `GRAPH_SYNC_DEBOUNCE_SECONDS` environment variables.

## CLI Reference

57 commands. Highlights below -- run `msam help` for the full list.

```bash
# Storage
msam store "Your memory content"
msam batch "atom1" "atom2" "atom3"       # batch store
msam working store "session context"     # working memory (TTL-scoped)

# Retrieval (confidence-gated)
msam query "search query"
msam query "search query" --mode companion --top-k 20
msam hybrid "search query"               # atoms + triples
msam explain "query"                     # detailed scoring breakdown
msam diverse "query"                     # MMR diversity-optimized retrieval
msam dry "query"                         # dry-run, no side effects
msam emotion-retrieve "query" --urgency high

# Session startup
msam context                             # compressed startup context

# Text search
msam grep "pattern"                      # ILIKE search across atom content

# Feedback and contribution tracking
msam feedback-mark <atom_ids> <response_text>
msam contribute <atomIds> <responseText>
msam feedback <atomId> <type>

# Lifecycle
msam decay                               # run decay cycle
msam confidence-decay                    # confidence gradient update
msam forgetting --dry-run                # preview forgetting candidates
msam forget                              # execute forgetting
msam consolidate                         # sleep-inspired consolidation
msam snapshot                            # log metrics

# Knowledge graph
msam contradictions                      # detect conflicts
msam gaps <entity>                       # knowledge gap analysis
msam graph traverse <entity>             # traverse relationships
msam graph path <from> <to>              # find path between entities
msam triple-stats                        # triple statistics
msam relations add <source> <target>     # manage atom relations

# World model (temporal knowledge)
msam world query <entity>                # query current world state
msam world update <s> <p> <o>            # update world fact
msam world history <entity>              # temporal history

# Analysis
msam metamemory "topic"                  # coverage assessment
msam stats                               # database statistics
msam analytics                           # retrieval analytics
msam predict                             # predictive prefetch
msam outcomes <atomId>                   # outcome feedback history
msam agreement                           # sycophancy/agreement rate
msam emotional                           # emotional state summary
msam importance "content"                # importance estimation
msam quality "query"                     # context quality scoring
msam drift <entity>                      # concept drift detection
msam rewrite "query"                     # query rewrite preview

# Data management
msam export backup.json                  # export all atoms
msam import backup.json                  # import atoms
msam merge suggest                       # suggest atom merges
msam split <atomId> "seg1" "seg2"        # split atom
msam summarize <atomId> [targetTokens]   # summarize atom
msam versions <atomId>                   # version history
msam pin add <atomId>                    # protect from decay
msam negative store "X is NOT Y"         # negative knowledge
msam provenance atom <id>                # audit trail

# Session
msam session-clear                       # clear dedup tracking
msam session-boundary start              # log session boundary
msam associations add <a> <b>            # manual co-retrieval

# Administration
msam serve                               # start REST API server
msam calibrate <provider>                # cross-provider calibration
msam re-embed <provider>                 # re-embed all atoms
msam migrate                             # run database migrations
msam replay [topic]                      # replay episodic events
```

## API Reference

All endpoints require the `x-api-key` header when `MSAM_API_KEY` is set.

### Core Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/health` | Health check, version, database status |
| POST | `/v1/store` | Store a memory atom |
| POST | `/v1/store-working` | Store a working memory atom (TTL-scoped) |
| POST | `/v1/query` | Confidence-gated retrieval |
| POST | `/v1/context` | Shannon-compressed session startup context |
| POST | `/v1/feedback` | Mark atom contribution to responses |
| GET | `/v1/stats` | Database statistics, per-agent breakdown |

### Lifecycle Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/decay` | Run decay cycle (mutex-protected) |
| POST | `/v1/consolidate` | Sleep-inspired memory consolidation |
| POST | `/v1/forget` | Intentional forgetting (dry-run by default) |
| POST | `/v1/tombstone` | Tombstone a specific atom |

### Knowledge Graph Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/triples/extract` | Extract triples from content |
| GET | `/v1/triples/graph/:entity` | Traverse knowledge graph |
| POST | `/v1/contradictions` | Detect semantic contradictions |

### Agent Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/agents/register` | Register a new agent |
| GET | `/v1/agents` | List all registered agents |
| GET | `/v1/agents/:id/stats` | Per-agent statistics |
| POST | `/v1/agents/share` | Share an atom between agents |

### Other Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/predict` | Predictive prefetch |
| POST | `/v1/replay` | Replay episodic events by topic/time |
| POST | `/v1/calibrate` | Cross-provider calibration |
| POST | `/v1/re-embed` | Re-embed all atoms with new provider |
| GET | `/v1/audit/recent` | Recent store/recall activity |

### Grafana Metrics API

5 additional endpoints serve the Grafana JSON datasource plugin:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/grafana/` | Datasource health check |
| POST | `/grafana/search` | List available metrics targets |
| POST | `/grafana/query` | Query metric values |
| GET | `/metrics` | Prometheus-format metrics (prom-client) |

## Project Structure

```
msam-ts/
  src/
    index.ts               # CLI entrypoint (Commander.js program setup)
    cli.ts                 # 57 CLI commands registration
    server.ts              # Fastify REST API (22+ endpoints)
    metrics-api.ts         # Grafana JSON datasource + Prometheus metrics
    config/
      index.ts             # TOML config loader with Zod validation
    core/
      atoms.ts             # Atom storage, similarity search, ACT-R scoring
      embeddings.ts        # Embedding dispatch (delegates to providers)
      act-r.ts             # ACT-R activation model implementation
      types.ts             # Shared type definitions
    db/
      schema.ts            # Drizzle ORM schema (18 tables, pgvector types)
      connection.ts        # PostgreSQL connection management
      migrations/          # Drizzle-generated migrations
    providers/
      embedding-provider.ts  # Provider factory and interface
      nvidia-nim.ts        # NVIDIA NIM embeddings
      openai.ts            # OpenAI-compatible embeddings
      onnx.ts              # ONNX Runtime local embeddings
      local.ts             # sentence-transformers local embeddings
    retrieval/
      strategies.ts        # Retrieve pipeline, confidence gating, MMR
      beam-search.ts       # Multi-beam retrieval for large databases
      reranker.ts          # Result reranking
    knowledge/
      triples.ts           # Triple extraction, graph traversal, hybrid retrieval
      contradictions.ts    # Semantic contradiction detection
      entity-roles.ts      # Entity-aware query scoring
    lifecycle/
      decay.ts             # State transitions, retrievability decay
      forgetting.ts        # Intentional forgetting (4 signal types)
      consolidation.ts     # Sleep-inspired memory consolidation
      prediction.ts        # 3-strategy predictive prefetch
    processing/
      annotate.ts          # Heuristic + LLM annotation (arousal, valence, topics)
      subatom.ts           # Shannon compression pipeline
      session-dedup.ts     # Multi-turn retrieval deduplication
    graph/
      sync.ts              # Debounced post-store Neo4j sync hook
      export.ts            # Agent triples export for KG viewer
    agents/
      registry.ts          # Gateway mapping, agent exclusion, grouped export
      isolation.ts         # Agent namespace isolation
    metrics/
      instrumentation.ts   # prom-client metrics (Prometheus)
    calibration/
      index.ts             # Cross-provider embedding calibration
  scripts/
    migrate-from-sqlite.ts # SQLite -> PostgreSQL data migration
  tests/
    unit/                  # 13 test files, 285 tests (Vitest)
    integration/
    fixtures/
  docker-compose.yml       # 7-service compose stack
  Dockerfile               # Multi-stage build (node:22-slim)
  drizzle.config.ts        # Drizzle Kit configuration
  msam.example.toml        # Documented config template
  .env.example             # Environment variable template
  package.json
  tsconfig.json
```

## Services (Docker Compose)

The `docker-compose.yml` defines 7 services:

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| `msam-db` | pgvector/pgvector:pg16 | 5432 (internal) | PostgreSQL with pgvector extension |
| `msam-server` | built from Dockerfile | 3901 | MSAM REST API (main memory store) |
| `msam-graph-accelerator` | msam-graph-accelerator:latest | 3902 | ETL pipeline: PostgreSQL -> Neo4j |
| `msam-neo4j-central` | neo4j:5-community | 9474, 9687 | Neo4j knowledge graph (cross-domain intelligence) |
| `msam-kg-viewer` | node:22-slim | 7780 | Live knowledge graph visualization |
| `msam-grafana` | grafana/grafana:12.4.1 | 3000 | Grafana dashboards (simpod-json-datasource) |
| `msam-tailscale` | tailscale/tailscale:latest | -- | Tailscale sidecar for tailnet access |

Health checks are configured on all stateful services. The `msam-server` depends on `msam-db` being healthy before starting. The graph accelerator depends on both Neo4j and the MSAM server.

## Connected Gateways

MSAM serves as the shared memory backend for multiple OpenClaw gateway instances via the msam-bridge plugin:

| Gateway | Host | Agent IDs |
|---------|------|-----------|
| Enduru | ubuntu-root + mac-studio | enduru, enduru-botchat, enduru-group, enduru-kainotomic, dexter |
| Enduru | ubuntu-root | main |
| Turkules | vm-1 | turkules, mv-ops, mv-data, mv-marketing, mv-product |

Legacy/stale agent IDs (andrew, kevin, default, orchestrator, aurora, aurora-worker, justin) are excluded from the agent registry and KG viewer exports. Aurora and Sam use Mem0 as their memory system, not MSAM.

The agent registry in `src/agents/registry.ts` maintains the gateway-to-agent mapping, generates grouped exports for the KG viewer dropdown, and queries per-agent atom/triple counts directly from PostgreSQL.

## Theoretical Foundation

- **ACT-R** (Anderson, 1993) -- activation-based memory retrieval
- **Ebbinghaus forgetting curve** (1885) -- exponential decay of retrievability
- **Shannon entropy** (1948) -- theoretical compression floor for startup context
- **Maximal Marginal Relevance** (Carbonell & Goldstein, 1998) -- diversity in retrieval
- **Dual-process theory** -- semantic vs. episodic stream separation
- **Metamemory** (Nelson & Narens, 1990) -- monitoring and control of memory

## Roadmap

### Current (2026.4.3)
- **TypeScript port** -- ground-up rewrite from Python. Every module, CLI command, and API endpoint ported. Zod validation on config, Drizzle ORM for type-safe queries, Fastify for the HTTP layer.
- **PostgreSQL + pgvector** -- replaces SQLite + FAISS. Native server-side vector indexing, concurrent multi-agent access, proper transactions. pgvector cosine distance eliminates the need for in-process FAISS.
- **Post-store graph sync hook** -- debounced automatic Neo4j sync. Configurable debounce interval (default 5 minutes). Multiple stores coalesce into a single sync.
- **Multi-gateway agent registry** -- agent-to-gateway mapping with grouped export for KG viewer. Gateway assignment, legacy agent exclusion, sorted by gateway group.
- **SQLite migration script** -- `npm run migrate:sqlite` transfers all data from the Python MSAM SQLite database to PostgreSQL, handling embedding format conversion and timestamp normalization.
- **Prometheus metrics** -- prom-client integration alongside the existing Grafana JSON datasource API.
- **285-test suite** across 13 test files covering atoms, retrieval, triples, contradictions, lifecycle, config, CLI, server, agents, ACT-R, schema, migration, and embedding providers.

### Carried forward from Python
- **Felt Consequence** -- outcome-attributed memory scoring
- **Predictive Context Assembly** -- pre-loads atoms based on temporal/co-retrieval patterns
- **Sycophancy detection** -- agreement rate tracking with sliding window
- **Semantic contradiction detection** -- embedding-based with negation, temporal supersession, value conflict, and antonym analysis
- **Shannon-compressed context startup** -- 99.3% compression via subatom extraction, codebook, delta encoding, dedup
- **Adaptive beam search** -- scales with data, sleeps when small
- **57-command CLI** with confidence-gated retrieval, knowledge graph, lifecycle management, world model, export/import

### Next
- HNSW index tuning for pgvector (ivfflat vs. HNSW benchmarking at scale)
- Contribution tracking closed-loop (automatic retrieval-to-decay feedback without explicit marking)
- Cross-agent knowledge discovery (agents surfacing insights from each other's memories)
- WebSocket real-time subscriptions (push notifications on store/decay events)
- Async embedding pipeline (background embedding for batch imports)

## License

MIT. See [LICENSE](LICENSE).
