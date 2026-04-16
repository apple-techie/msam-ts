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
        } catch {}
      })
    );

    return {
      triples: [...allTriples.values()],
      stats,
    };
  } catch (e) {
    log("MSAM fetch failed:", e.message);
    return { triples: [], stats: null };
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

function buildGraph(msamTriples, gooseKG) {
  const entityMap = new Map(); // name -> { type, observations, sources }
  const relations = [];

  // 1. Add Goose KG entities (these have rich types + observations)
  for (const e of gooseKG.entities) {
    entityMap.set(e.name, {
      name: e.name,
      entityType: e.entityType || "Entity",
      observations: e.observations || [],
      source: "goose",
    });
  }

  // 2. Add Goose KG relations
  for (const r of gooseKG.relations) {
    relations.push({
      from: r.from,
      to: r.to,
      relationType: r.relationType,
      source: "goose",
    });
  }

  // 3. Filter MSAM triples and collect per-entity evidence for type voting
  const entityEvidence = new Map(); // name -> [{ predicate, role }]
  const filteredTriples = [];

  for (const t of msamTriples) {
    if (SKIP_PREDICATES.has(t.predicate)) continue;
    if (SKIP_ENTITIES.has(t.subject) || SKIP_ENTITIES.has(t.object)) continue;
    if ((t.confidence || 0) < 0.3) continue;
    filteredTriples.push(t);

    if (!entityEvidence.has(t.subject)) entityEvidence.set(t.subject, []);
    entityEvidence.get(t.subject).push({ predicate: t.predicate, role: "subject" });

    if (looksLikeEntity(t.object, t.predicate)) {
      if (!entityEvidence.has(t.object)) entityEvidence.set(t.object, []);
      entityEvidence.get(t.object).push({ predicate: t.predicate, role: "object" });
    }
  }

  // 4. Build entities + relations using accumulated evidence (fixes first-triple-wins bug)
  for (const t of filteredTriples) {
    if (!entityMap.has(t.subject)) {
      entityMap.set(t.subject, {
        name: t.subject,
        entityType: inferType(t.subject, entityEvidence.get(t.subject) || []),
        observations: [],
        source: "msam",
      });
    }

    if (looksLikeEntity(t.object, t.predicate)) {
      if (!entityMap.has(t.object)) {
        entityMap.set(t.object, {
          name: t.object,
          entityType: inferType(t.object, entityEvidence.get(t.object) || []),
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

// Predicates that imply the SUBJECT is a person
const PERSON_AS_SUBJECT = new Set([
  "founder", "cofounder", "co_founder", "partner", "works_with",
  "contacted", "replied", "investor", "recipient", "manages",
  "collaborates_with", "reports_to", "has_role", "backed",
  "invested_in", "consulting_client", "prefers", "likes", "dislikes",
  "uses", "follows", "subscribes_to",
]);

// Predicates that imply the OBJECT is a person
const PERSON_AS_OBJECT = new Set([
  "founder", "cofounder", "co_founder", "partner", "works_with",
  "contacted", "replied", "investor", "recipient", "manages",
  "collaborates_with", "reports_to", "consulting_client",
  "target_audience",
]);

// Predicates that imply the OBJECT is technology
const TECH_AS_OBJECT = new Set([
  "uses", "running_on", "deployed_on", "depends_on", "integrates_with",
  "connects_to", "configured_with", "runs_on",
]);

// Predicates that imply the SUBJECT is technology/infrastructure
const TECH_AS_SUBJECT = new Set([
  "running_on", "deployed_on", "runs_on", "depends_on",
  "integrates_with", "connects_to",
]);

// =====================================================================
// ENTITY TYPE CLASSIFIER
// All keys are lowercase with spaces → underscores (matches `lname`).
// =====================================================================

// Explicit known people (verified real humans)
const PERSON_NAMES = new Set([
  "andrew_peltekci", "drew", "andrew", "mr_peltekci", "dad", "drews_dad",
  "sister", "family", "__tosh",
  "abdul", "abdul_muhaimin", "abdul_muhaimin_al_nassar", "abhinav_asthana",
  "adam", "adam_gross", "aimee", "alex_maccaw", "alycia_setlin",
  "amir_s", "amir_sheva", "amir_shevat", "amit_kumar_yadav", "amjad_masad",
  "andre", "andy", "ash", "ash_rust", "ashish", "ashish_parmar",
  "avlok_kohli", "ayush_katheriya",
  "ben_tossell", "bobby_tables", "brittany_carter",
  "charles_hudson", "chris", "chris_haywood", "chue",
  "dexter", "david_kimani", "david_ongchoco", "davis_mironga",
  "ed_sim", "eduardo_cruz", "elad_gil", "elizabeth_yin", "erin", "evan_steinberg",
  "fahad_islam", "faraz_khan", "francesco_ciampallari", "franco", "franco_cas",
  "garry_tan", "gary_benerofe", "georgi_sharliyski", "gerardo_aguirre",
  "grant", "greg_irwin", "guillermo_rauch",
  "heather_stoddard", "henry", "ian_mccrystal",
  "james_currier", "jason_calacanis", "joe", "joey", "joey_foldi", "joey_raptis",
  "john_borthwick", "jordan_kretchmer", "joshua", "jozsef_foldi", "justin", "justin_walker",
  "kimberly", "lachy_groom", "leura_craig",
  "mannsullar_bryant", "marcos", "maricela", "mark_fulton", "mathias_biilmann",
  "mayra", "megan_alford", "michael_biilmann", "michael_ulin", "mike_hsieh", "mjjui",
  "paige_craig", "patrick_thompson", "paul_bricault", "phin_barnes",
  "reuven_cohen", "richard_socher", "rob_hayes", "robert_herjavec", "roy_bahat",
  "ryan", "ryan_callaghan", "ryan_hoover",
  "sahil_lavingia", "sam", "sam_lambert", "sannidhya", "sannidhya_sah",
  "sherrise_pond", "shivam_kumar",
  "spencer_kimbal", "spencer_kimball", "stanislav_beliaev", "sumeet_gajri",
  "sumeet_singh", "sunny",
  "thomas_schranz", "tim_hsia", "todd_saunders", "tomas_tunguz", "tomasz_tunguz",
  "tosh_velaga", "tsvetan_karakanov", "turner_novak",
  "vic", "victor", "victor_quinones", "william_hsu",
]);

// Explicit technologies/brands
const TECH_NAMES = new Set([
  "adobe", "anthropic", "apple_card", "apple_platforms", "apple_techie",
  "bot", "cal_com", "calendly", "camoufox", "carbon_ads", "chase",
  "claude", "claude_code", "claude_code_autonomy", "claude_code_plugin", "claude_opus",
  "clawmetry", "clawmetry_fork", "clerk",
  "docker_compose", "docker_mc", "dokploy_root",
  "facebook", "facebook_ads", "facebook_feed", "facebook_marketplace",
  "facebook_messenger", "facebook_reel", "facebook_story",
  "facebook_marketplace_messages", "facebook_marketplace_threads",
  "fb_messenger", "fb_marketplace_automation",
  "github", "github_copilot", "gmail", "gog_gmail", "gog_gmail_search",
  "google_account", "google_ads", "google_analytics", "google_authentication",
  "google_calendar", "google_chrome", "google_payments", "google_play",
  "google_policy", "google_review", "google_security", "google_ads_campaigns",
  "google_ads_rebuild", "grafana", "gstack",
  "hydra", "imac", "instagram", "instagram_feed", "instagram_reel", "instagram_story",
  "linkedin", "linkedin_post", "linkedin_audience",
  "mac_studio", "mac_studio_export_script", "macbook_pro_node",
  "mailgun_domain", "mem0", "meta_pixel", "meta_voice_operations", "mission_control",
  "mv_dashboard", "nemoclaw_fork", "neo4j", "neo4j_graph_accelerator",
  "notion", "openclaw", "openclaw.app", "openclaw_browser", "openclaw_runtime",
  "openclaw_gateway", "openclaw_agent", "openclaw_dokploy", "openclaw_fork",
  "openclaw_demo_command_center", "openclaw_site_health_check",
  "openrouter", "oracle_cloud", "otel", "otel/grafana",
  "pi_mono", "portainer", "react", "react_18", "react_19",
  "reddit", "old_reddit", "rolex", "signal", "signetai_fork", "sqlite",
  "stripe", "stripe_atlas", "stripe_checkout", "stripe_keys", "stripe_test_mode",
  "supabase", "supabase_auth", "supabase_realtime", "tailscale_serve",
  "telegram", "toyota", "twitter", "twitter_account", "twitter_content_am",
  "twitter_user", "twitter_crons", "x/twitter",
  "ubuntu-root", "ubuntu_root", "vercel", "vitest", "whatsapp",
  "you.com", "hubspot",
  "signoz_mcp_server", "silver_price", "gold_price", "gold_pricing",
  "gold_widget", "gold_widget_fix", "price_widget",
  "keychain_access", "keychain_dialog", "keychain_item",
  "dashboard_server", "mv_landing",
  "linux_enduru", "serverless_postgres", "aurora_orchestrator", "aurora_worker",
  "worker_chain",
]);

// Explicit organizations
const ORG_NAMES = new Set([
  "aix_ventures", "amplify_la", "anthemis_group", "banana_capital", "betaworks",
  "belgium_new_york_llc", "comma_capital", "cofounded_llc", "crown_gold_exchange",
  "devry_cyber_security_club", "e-cig_city_upland", "enduru", "enduru_ai",
  "factory", "fabiolus_cucina", "finestar", "first_round", "hustle_fund",
  "kainotomic", "kaino", "kaino_dev", "letsdisagree", "leso_studios",
  "mu_ventures", "nfx", "mv_jewelry_exchange", "outlander_vc",
  "peltekci_agency_inc", "precursor_ventures", "prismetric", "sterling_road",
  "urbane_cafe", "whimsey_labs", "alcoholics_anonymous", "awaken_altadena",
  "cash_for_gold_nova", "tech_company",
]);

// Explicit concept/role nouns (including plurals)
const CONCEPT_NAMES = new Set([
  "agent", "agents", "assistant", "bot", "founder", "founders",
  "investor", "investors", "sellers", "stylists", "estheticians",
  "team", "team_member", "staff", "coworkers", "leads", "roles",
  "decision_maker", "investor_1", "investor_2", "legal_counsel",
  "business_owners", "enterprise_clients", "potential_investors",
  "independent_consultant", "independent_contractors",
  "industry_contacts", "industry_professionals", "seasoned_professional",
  "senior_partner", "senior_solutions_architect",
  "software_engineer", "solutions_architect", "managing_partner",
  "general_partners", "google_engineers", "uber_engineers",
  "facebook_engineers", "spanish_speakers", "dashboard_administrator",
  "nail_techs", "technical_role", "ai_contractor", "cofounded",
  "founder_journey", "content_guardian", "community_agent",
  "content_agent", "outreach_agent", "department_agent", "marketing_agent",
  "main_agent", "department_heads", "mv-marketing_agent", "mv-ops_agent",
  "mv-data_agent", "mv_marketing", "mv-marketing", "mv-data", "mv-ops",
  "mv-product", "agentic_cli", "agentic_era", "coding_agents",
  "aha_moment", "ultimate_brain", "social_media", "premium_subscription",
  "silver_bullion", "gold_jewelry", "estate_jewelry",
]);

// Known locations → Entity (no Location type in the UI)
const LOCATION_NAMES = new Set([
  "moreno_valley", "san_bernardino", "west_covina", "los_angeles",
  "inland_empire", "united_states", "altadena_strong",
  "affordable_housing",
]);

// Brand prefixes → Technology (compound names starting with these)
const TECH_PREFIX_RE = /^(facebook[_-]|instagram[_-]|twitter[_-]|x\/twitter|google[_-]|linkedin[_-]|reddit|apple[_-]|telegram[_-]|whatsapp[_-]|signal[_-]|claude[_-]|mem0|hydra|openclaw|fb[_-]|meta[_-]|notion[_-]|trello[_-]|slack[_-]|discord[_-]|stripe[_-]|supabase[_-]|clerk[_-]|vercel[_-]|neo4j[_-]|docker[_-]|dokploy[_-]|kubernetes[_-]|redis[_-]|gmail[_-]?|github[_-]|gitlab[_-]|gateway[_-]|dashboard[_-]|heartbeat[_-]|cron[_-]|browser[_-]|marketplace[_-]|listing[_-]|listings[_-]|payment[_-]|pricing[_-]|lead[_-]|leads[_-]|website[_-]|webhook[_-]|otel|oauth|jwt[_-]|openrouter|anthropic|rolex|kainotomic[_-]|enduru[_-]|turkules[_-]|tipjars?[_-]?|kaino[_-]|mv[_-]|mv\.|newsfetch[_-]?|remotion[_-]?|platform[_-]|news[_-])/i;

// Organization-like suffixes (e.g. Comma_Capital, Cofounded_LLC)
const ORG_SUFFIX_RE = /_(llc|inc|corp|co|ltd|capital|ventures|group|fund|labs|studios|agency|cafe|exchange|club)$/i;

// Role/concept suffixes (plural people-nouns, org-roles)
const CONCEPT_SUFFIX_RE = /_(agents?|engineers?|owners?|contractors?|partners?|clients?|users?|members?|techs?|technicians?|professionals?|consultants?|architects?|workers?|admins?|team|staff|leads?|roles?|bots?|assistants?|guardians?|administrators?|heads?|stylists?|estheticians?|sellers?|followers?|buyers?|subscribers?)$/i;

// Content/post suffixes → Entity
const CONTENT_SUFFIX_RE = /_(post|posts|reel|reels|story|stories|feed|feeds|ads|ad|campaign|campaigns|draft|drafts|summary|report|reports|note|notes|update|updates|hook|graphic|pitch_deck|tweet_draft|draft_tweet|deck)$/i;

// Technology/system suffixes → Technology
const TECH_SUFFIX_RE = /_(tool|tools|service|system|engine|platform|runtime|gateway|server|client|protocol|api|database|schema|table|sdk|cli|bot|script|wrapper|extractor|manager|controller|dashboard|panel|widget|automation|pipeline|workflow|workflows|sync|cron|crons|jobs|job|backup|export|refresh|monitoring|analytics|calendar|email|chat|messenger|threads|thread|conversations|signaling|validation|verification|execution|health|rebuild|reset|filter|prompt|migration|deployment|installation|configuration|infrastructure|layer|node|nodes|host|oracle|container|containers|repository|repositories|repos)$/i;

// Entity-like suffixes → Entity (generic things)
const ENTITY_SUFFIX_RE = /_(page|pages|slug|fork|forks|pathway|feature|features|tracking|check|checks|plan|plans|board|boards|state|config|wiki|logs|content|catalog|template|rules|endpoint|endpoints|status|request|response|tests|test|review|reviews|account|accounts|chain|cleanup|onboarding|identity|dialog|week|weekend|morning|evening|daily|weekly|monthly|removals|additions|tasks|task|project|projects|error|errors|snapshot|bundle|trust|context|execution|dark_mode|mode|story|stories)$/i;

// Contains a tech brand anywhere in name → Technology (except for explicit persons)
const CONTAINS_BRAND_RE = /\b(gmail|facebook|instagram|twitter|linkedin|reddit|youtube|apple|microsoft|amazon|stripe|supabase|vercel|clerk|notion|trello|slack|discord|telegram|whatsapp|claude|chatgpt|anthropic|openai|docker|kubernetes|redis|mongodb|postgresql|mysql|sqlite|neo4j|grafana|tailscale|dokploy|portainer|github|gitlab|heroku|netlify|aws|azure|gcp|cloudflare|chrome|firefox|safari|edge|bun|deno|node|react|vue|angular|next|nuxt|express|fastify|webpack|vite)\b/i;

// Prefixes that disqualify a compound name from being classified as a Person.
// These are domain/tech/abstract-concept words that appear as the first token in
// compound names but aren't given names.
const NOT_PERSON_PREFIX_RE = /^(access|admin|agent|agentic|agents|ai|aios|all|allocation|api|app|approval|apps|architecture|audit|auth|automated|automation|aurora|backend|backup|batch|begin|behind|best|bi|blacklist|blog|book|browser|budget|builder|bulk|business|cache|campaign|canonical|carson|cash|change|channel|chat|claude|clarifying|client|code|coding|command|companion|consistent|content|context|coworker|critical|cross|crown|cron|dad|daily|dark|dashboard|data|database|deal|deals|debug|decision|decomposition|deep|delivery|demo|department|deploy|design|dev|development|device|docker|dokploy|domain|done|draft|dual|dynamic|e2e|edit|educational|email|empty|end|engaged|engagement|enterprise|environment|error|escalation|established|estate|evening|exec|execution|existing|expertise|external|failure|family|feature|file|filter|final|first|flex|fluff|font|form|full|gateway|get|global|gold|gratisfaction|grid|hacker|headless|heartbeat|high|host|hot|human|important|in|independent|industry|initial|inland|input|installed|internal|interview|investor|issue|jar|jewelry|job|kaino|kainotomic|kevin|keychain|keyword|large|launch|lead|leads|legal|lightweight|linkedin|listing|listings|live|load|loading|local|lock|logs|loose|low|machine|mac|macbook|main|managed|managing|market|marketing|marketplace|mem|memory|messaging|message|meta|migration|milestone|minimal|mission|model|monday|monetization|morning|msam|multi|new|news|newsfetch|node|notes|notion|ok|old|onboarding|op|open|openclaw|operating|ops|oracle|orchestrator|outreach|package|path|payment|payments|pawn|peltekci|performance|performative|personal|phase|pi|pitch|platform|pm|pmax|pocket|port|postgres|potential|pr|preview|previous|price|pricing|primary|priority|privacy|product|production|project|projects|public|pull|purchase|python|qa|queryable|rails|real|recurring|redundant|reimbursement|release|remotion|rendering|reporting|repository|request|resource|response|rest|review|role|route|routing|ryan|sample|sandbox|scheduling|schema|script|search|secret|secondary|security|seo|session|shared|sidebar|signal|sister|site|socket|software|solutions|spanish|spec|specialized|src|ssl|stage|standard|standby|static|statistics|status|stealth|storage|streak|stripe|structured|sub|subscription|success|supabase|support|sustainable|sync|system|tailscale|task|tasks|team|tech|telegram|temp|temporary|test|tests|testing|theme|thursday|tim|time|token|tokenization|tool|top|total|trace|tracking|transaction|trello|trust|tuesday|tweet|twitter|twitter|type|typed|ui|unique|unit|united|update|user|valid|validate|validation|vendor|ver|verify|vercel|vitest|warmth|webhook|website|wednesday|weekly|whatsapp|whimsey|woah|work|workflow|workspace|world|www|x|zero)[_-]/i;

function inferType(name, evidence) {
  const lname = name.toLowerCase().replace(/ /g, "_");

  // 1. Disqualifying syntax → Entity (IDs, paths, URLs)
  if (/^[#0-9]/.test(name)) return "Entity";
  if (/[\/:]/.test(name)) return "Entity";
  if (/\.(ts|tsx|js|mjs|json|md|py|yaml|yml|html|css|sql|env|toml|sh)$/i.test(name)) return "Entity";
  if (/\.(com|net|org|io|ai|dev|app|internal|edu|agency)\b/i.test(lname)) return "Entity";
  if (/^u\//i.test(lname)) return "Entity";

  // 2. Explicit allowlists (highest priority)
  if (PERSON_NAMES.has(lname)) return "Person";
  if (TECH_NAMES.has(lname)) return "Technology";
  if (ORG_NAMES.has(lname)) return "Organization";
  if (CONCEPT_NAMES.has(lname)) return "Concept";
  if (LOCATION_NAMES.has(lname)) return "Entity";

  // 3. Suffix patterns (check specific/long ones before short)
  if (ORG_SUFFIX_RE.test(lname)) return "Organization";
  if (TECH_PREFIX_RE.test(lname)) return "Technology";
  if (CONCEPT_SUFFIX_RE.test(lname)) return "Concept";
  if (CONTENT_SUFFIX_RE.test(lname)) return "Entity";
  if (TECH_SUFFIX_RE.test(lname)) return "Technology";
  if (ENTITY_SUFFIX_RE.test(lname)) return "Entity";

  // 4. Contains known brand token → Technology
  if (CONTAINS_BRAND_RE.test(lname)) return "Technology";

  // 5. "FirstName LastName" pattern → Person
  //    Only fires if the first token isn't a tech/concept prefix.
  if (!NOT_PERSON_PREFIX_RE.test(lname) &&
      /^[A-Z][a-z]{1,15}[_ ][A-Z][a-z]{1,15}$/.test(name)) {
    return "Person";
  }

  // 6. Role-aware vote across ALL triples this entity appears in
  let personScore = 0;
  let techScore = 0;
  let orgScore = 0;
  let conceptScore = 0;

  for (const { predicate, role } of evidence) {
    const lpred = predicate.toLowerCase();

    if (role === "subject") {
      for (const p of PERSON_AS_SUBJECT) { if (lpred.includes(p)) { personScore += 2; break; } }
    }
    if (role === "object") {
      for (const p of PERSON_AS_OBJECT) { if (lpred.includes(p)) { personScore += 2; break; } }
    }
    if (role === "object") {
      for (const p of TECH_AS_OBJECT) { if (lpred.includes(p)) { techScore += 2; break; } }
    }
    if (role === "subject") {
      for (const p of TECH_AS_SUBJECT) { if (lpred.includes(p)) { techScore += 1; break; } }
    }

    if (lpred.includes("founded") || lpred.includes("cofounded") ||
        lpred.includes("belongs_to") || lpred.includes("member_of")) {
      if (role === "object") orgScore += 2;
      else orgScore += 1;
    }

    if (lpred.includes("is_type_of") || lpred.includes("is_a")) {
      conceptScore += 2;
    }
  }

  const max = Math.max(personScore, techScore, orgScore, conceptScore);
  if (max === 0) return "Entity";
  if (conceptScore === max) return "Concept";
  if (personScore === max) return "Person";
  if (orgScore === max) return "Organization";
  if (techScore === max) return "Technology";

  return "Entity";
}

// ── Polling Loop ─────────────────────────────────────────────────────────────

async function refreshGraph() {
  const [msamResult, gooseKG] = await Promise.all([
    fetchMsamTriples(),
    Promise.resolve(parseGooseKG()),
  ]);

  const newGraph = buildGraph(msamResult.triples, gooseKG);

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
  .filter-btn[data-type="Person"] { color: var(--person); border-color: rgba(245,158,11,0.3); background: rgba(245,158,11,0.08); }
  .filter-btn[data-type="Person"] .dot { background: var(--person); }
  .filter-btn[data-type="Organization"] { color: var(--org); border-color: rgba(139,92,246,0.3); background: rgba(139,92,246,0.08); }
  .filter-btn[data-type="Organization"] .dot { background: var(--org); }
  .filter-btn[data-type="Project"] { color: var(--project); border-color: rgba(6,182,212,0.3); background: rgba(6,182,212,0.08); }
  .filter-btn[data-type="Project"] .dot { background: var(--project); }
  .filter-btn[data-type="Technology"] { color: var(--tech); border-color: rgba(16,185,129,0.3); background: rgba(16,185,129,0.08); }
  .filter-btn[data-type="Technology"] .dot { background: var(--tech); }
  .filter-btn[data-type="Concept"] { color: var(--concept); border-color: rgba(236,72,153,0.3); background: rgba(236,72,153,0.08); }
  .filter-btn[data-type="Concept"] .dot { background: var(--concept); }
  .filter-btn[data-type="Entity"] { color: var(--entity); border-color: rgba(148,163,184,0.3); background: rgba(148,163,184,0.08); }
  .filter-btn[data-type="Entity"] .dot { background: var(--entity); }
  .filter-btn[data-type="Configuration"] { color: var(--config); border-color: rgba(249,115,22,0.3); background: rgba(249,115,22,0.08); }
  .filter-btn[data-type="Configuration"] .dot { background: var(--config); }

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
const TYPE_COLORS = {
  Person: '#f59e0b', Organization: '#8b5cf6', Project: '#06b6d4',
  Technology: '#10b981', Configuration: '#f97316', Concept: '#ec4899', Entity: '#94a3b8'
};

let rawEntities = [], rawRelations = [], rawMeta = {};
let nodes = [], links = [];
let simulation, svg, root, linkSel, nodeSel, edgeLabelSel, zoom;
let selectedNodeId = null;
let searchQuery = '';
let activeFilters = new Set(Object.keys(TYPE_COLORS));
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

  // Discover types dynamically
  const types = new Set(entities.map(e => e.entityType));
  types.forEach(t => activeFilters.add(t));

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
function nodeColor(type) { return TYPE_COLORS[type]||'#94a3b8'; }

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
  const wrap=document.getElementById('filter-buttons');
  Object.keys(TYPE_COLORS).forEach(type=>{
    const btn=document.createElement('button');
    btn.className='filter-btn';btn.dataset.type=type;
    btn.innerHTML='<span class="dot"></span>'+type;
    btn.addEventListener('click',()=>{
      if(activeFilters.has(type)){activeFilters.delete(type);btn.classList.add('inactive');}
      else{activeFilters.add(type);btn.classList.remove('inactive');}
      selectedNodeId=null;
      document.getElementById('empty-state').style.display='';
      document.getElementById('node-detail').classList.remove('visible');
      renderGraph([]);runSimulation();updateSidebarCounts();
    });
    wrap.appendChild(btn);
  });
}

function populateSidebar(d){
  document.getElementById('empty-state').style.display='none';
  const detail=document.getElementById('node-detail');
  detail.classList.add('visible');
  const srcBadge=d.source==='goose'?'<span class="source-badge goose">Goose KG</span>'
    :'<span class="source-badge msam">MSAM</span>';
  document.getElementById('detail-badge-wrap').innerHTML=
    '<div class="detail-badge" data-type="'+d.entityType+'"><span class="dot"></span>'+d.entityType+'</div>'+srcBadge;
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
