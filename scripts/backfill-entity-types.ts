/**
 * Backfill subject_type / object_type on existing triples.
 *
 * Uses rule-based classification (allowlists + suffix/prefix patterns).
 * Future triples will be LLM-typed at extraction; this fills in historical rows.
 *
 * Run: `DATABASE_URL=... tsx scripts/backfill-entity-types.ts`
 */
import { Pool } from "pg";

// ─── Classifier (ported from kg-viewer/server.mjs) ────────────────────

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
  "worker_chain", "aurora", "turkules", "system",
  "macos_companion_app", "mc_gateways", "imessage_fda_block",
  "craigslist_listings", "craigslist_account", "r_vibecoding", "kryakrya_it",
  "synced_messages", "sessions_spawn", "firewall_security",
  "signal_export", "signal_keychain", "gateways",
]);

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
  "platform", "campaigns", "content", "seo", "pricing", "ads", "social",
  "outreach", "reporting", "qa", "marketing", "ops", "pm", "prs", "agencies",
  "listings", "accelerator", "warmth", "c_output", "spearmint_rhino_cfo",
  "llc", "agent_runtime", "reddit_user", "ok_activity_4626",
]);

const LOCATION_NAMES = new Set([
  "moreno_valley", "san_bernardino", "west_covina", "los_angeles",
  "inland_empire", "united_states", "altadena_strong", "affordable_housing",
]);

const TECH_PREFIX_RE = /^(facebook[_-]|instagram[_-]|twitter[_-]|x\/twitter|google[_-]|linkedin[_-]|reddit|apple[_-]|telegram[_-]|whatsapp[_-]|signal[_-]|claude[_-]|mem0|hydra|openclaw|fb[_-]|meta[_-]|notion[_-]|trello[_-]|slack[_-]|discord[_-]|stripe[_-]|supabase[_-]|clerk[_-]|vercel[_-]|neo4j[_-]|docker[_-]|dokploy[_-]|kubernetes[_-]|redis[_-]|gmail[_-]?|github[_-]|gitlab[_-]|gateway[_-]|dashboard[_-]|heartbeat[_-]|cron[_-]|browser[_-]|marketplace[_-]|listing[_-]|listings[_-]|payment[_-]|pricing[_-]|lead[_-]|leads[_-]|website[_-]|webhook[_-]|otel|oauth|jwt[_-]|openrouter|anthropic|rolex|kainotomic[_-]|enduru[_-]|turkules[_-]|tipjars?[_-]?|kaino[_-]|mv[_-]|mv\.|newsfetch[_-]?|remotion[_-]?|platform[_-]|news[_-])/i;
const ORG_SUFFIX_RE = /_(llc|inc|corp|co|ltd|capital|ventures|group|fund|labs|studios|agency|cafe|exchange|club)$/i;
const CONCEPT_SUFFIX_RE = /_(agents?|engineers?|owners?|contractors?|partners?|clients?|users?|members?|techs?|technicians?|professionals?|consultants?|architects?|workers?|admins?|team|staff|leads?|roles?|bots?|assistants?|guardians?|administrators?|heads?|stylists?|estheticians?|sellers?|followers?|buyers?|subscribers?)$/i;
const CONTENT_SUFFIX_RE = /_(post|posts|reel|reels|story|stories|feed|feeds|ads|ad|campaign|campaigns|draft|drafts|summary|report|reports|note|notes|update|updates|hook|graphic|pitch_deck|tweet_draft|draft_tweet|deck)$/i;
const TECH_SUFFIX_RE = /_(tool|tools|service|system|engine|platform|runtime|gateway|gateways|server|client|protocol|api|database|schema|table|sdk|cli|bot|script|wrapper|extractor|manager|controller|dashboard|panel|widget|widgets|automation|pipeline|workflow|workflows|sync|cron|crons|jobs|job|backup|export|refresh|monitoring|analytics|calendar|email|chat|messenger|threads|thread|conversations|signaling|validation|verification|execution|health|rebuild|reset|filter|prompt|migration|deployment|installation|configuration|infrastructure|layer|node|nodes|host|oracle|container|containers|repository|repositories|repos|app|apps|block|blocks)$/i;
const ENTITY_SUFFIX_RE = /_(page|pages|slug|fork|forks|pathway|feature|features|tracking|check|checks|plan|plans|board|boards|state|config|wiki|logs|content|catalog|template|rules|endpoint|endpoints|status|request|response|tests|test|review|reviews|account|accounts|chain|cleanup|onboarding|identity|dialog|week|weekend|morning|evening|daily|weekly|monthly|removals|additions|tasks|task|project|projects|error|errors|snapshot|bundle|trust|context|execution|dark_mode|mode|story|stories|pool|space|spawn|renewal|renewals|targets|target|debt|messages|message|security|health)$/i;
const CONTAINS_BRAND_RE = /\b(gmail|facebook|instagram|twitter|linkedin|reddit|youtube|apple|microsoft|amazon|stripe|supabase|vercel|clerk|notion|trello|slack|discord|telegram|whatsapp|claude|chatgpt|anthropic|openai|docker|kubernetes|redis|mongodb|postgresql|mysql|sqlite|neo4j|grafana|tailscale|dokploy|portainer|github|gitlab|heroku|netlify|aws|azure|gcp|cloudflare|chrome|firefox|safari|edge|bun|deno|node|react|vue|angular|next|nuxt|express|fastify|webpack|vite)\b/i;
const NOT_PERSON_PREFIX_RE = /^(access|admin|agent|agentic|agents|ai|aios|all|allocation|api|app|approval|apps|architecture|audit|auth|automated|automation|aurora|backend|backup|batch|begin|behind|best|bi|blacklist|blog|book|browser|budget|builder|bulk|business|cache|campaign|canonical|card|carson|cash|change|channel|chat|claude|clarifying|client|code|coding|command|companion|consistent|content|context|contract|coworker|credit|critical|cross|crown|cron|dad|daily|dark|dashboard|data|database|deal|deals|debug|decision|decomposition|deep|delivery|demo|department|deploy|design|dev|development|device|disk|docker|dokploy|domain|done|draft|dual|dynamic|e2e|edit|educational|email|empty|end|engaged|engagement|enterprise|environment|error|escalation|established|estate|evening|exec|execution|existing|expertise|external|failure|family|feature|file|filter|final|first|fix|flex|fluff|font|form|full|gateway|get|global|gold|gratisfaction|grid|hacker|headless|heartbeat|high|host|hot|human|imessage|important|in|independent|industry|initial|inland|input|installed|internal|interview|investor|issue|jar|jewelry|job|kaino|kainotomic|kevin|keychain|keyword|kryakrya|large|launch|lead|leads|legal|lightweight|linkedin|listing|listings|live|load|loading|local|lock|logs|loose|low|machine|mac|macbook|macos|main|managed|managing|market|marketing|marketplace|mc|mem|memory|messaging|message|meta|migration|milestone|minimal|mission|model|monday|monetization|morning|msam|multi|new|news|newsfetch|node|notes|notion|ok|old|onboarding|op|open|openclaw|operating|ops|oracle|orchestrator|outreach|package|path|payment|payments|pawn|peltekci|performance|performative|personal|phase|pi|pitch|platform|pm|pmax|pocket|port|postgres|potential|pr|preview|previous|price|pricing|primary|priority|privacy|product|production|project|projects|public|pull|purchase|python|qa|queryable|r|rails|real|recurring|redundant|reimbursement|release|remotion|rendering|reporting|repository|request|resource|response|rest|review|role|route|routing|ryan|sample|sandbox|scheduling|schema|script|search|secret|secondary|security|seo|session|sessions|shared|sidebar|signal|sister|site|socket|software|solutions|spanish|spec|specialized|src|ssl|stage|standard|standby|static|statistics|status|stealth|storage|streak|stripe|structured|sub|subscription|success|supabase|support|sustainable|sync|synced|system|tailscale|task|tasks|team|tech|telegram|temp|temporary|test|tests|testing|theme|thursday|tim|time|token|tokenization|tool|top|total|trace|tracking|transaction|trello|trust|tuesday|tweet|twitter|twitter|type|typed|ui|unique|unit|united|unsent|update|user|valid|validate|validation|vendor|ver|verify|vercel|vitest|warmth|webhook|website|wednesday|weekly|whatsapp|whimsey|woah|work|workflow|workspace|world|www|x|zero)[_-]/i;

function classify(name: string): string {
  const lname = name.toLowerCase().replace(/ /g, "_");

  if (/^[#0-9]/.test(name)) return "Entity";
  if (/[\/:]/.test(name)) return "Entity";
  if (/\.(ts|tsx|js|mjs|json|md|py|yaml|yml|html|css|sql|env|toml|sh)$/i.test(name)) return "Entity";
  if (/\.(com|net|org|io|ai|dev|app|internal|edu|agency)\b/i.test(lname)) return "Entity";
  if (/^u\//i.test(lname)) return "Entity";

  if (PERSON_NAMES.has(lname)) return "Person";
  if (TECH_NAMES.has(lname)) return "Technology";
  if (ORG_NAMES.has(lname)) return "Organization";
  if (CONCEPT_NAMES.has(lname)) return "Concept";
  if (LOCATION_NAMES.has(lname)) return "Entity";

  if (ORG_SUFFIX_RE.test(lname)) return "Organization";
  if (TECH_PREFIX_RE.test(lname)) return "Technology";
  if (CONCEPT_SUFFIX_RE.test(lname)) return "Concept";
  if (CONTENT_SUFFIX_RE.test(lname)) return "Entity";
  if (TECH_SUFFIX_RE.test(lname)) return "Technology";
  if (ENTITY_SUFFIX_RE.test(lname)) return "Entity";

  if (CONTAINS_BRAND_RE.test(lname)) return "Technology";

  const blocked = NOT_PERSON_PREFIX_RE.test(lname);
  if (!blocked && /^[A-Z][a-z]{1,15}[_ ][A-Z][a-z]{1,15}$/.test(name)) return "Person";

  return "Entity";
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");

  const pool = new Pool({ connectionString: url });

  // 1. Collect distinct entity names (as subject or object)
  const res = await pool.query<{ name: string }>(
    "SELECT DISTINCT subject AS name FROM triples UNION SELECT DISTINCT object AS name FROM triples",
  );
  const names = res.rows.map((r) => r.name);
  console.log(`Found ${names.length} distinct entities`);

  // 2. Classify each
  const typeMap = new Map<string, string>();
  for (const n of names) typeMap.set(n, classify(n));

  const buckets: Record<string, number> = {};
  for (const t of typeMap.values()) buckets[t] = (buckets[t] ?? 0) + 1;
  console.log("Type distribution:", buckets);

  // 3. Update in batches. Use a single UPDATE per type, parameterized with the name list.
  const byType: Record<string, string[]> = {};
  for (const [n, t] of typeMap) {
    if (!byType[t]) byType[t] = [];
    byType[t].push(n);
  }

  let updated = 0;
  for (const [type, namesOfType] of Object.entries(byType)) {
    const CHUNK = 500;
    for (let i = 0; i < namesOfType.length; i += CHUNK) {
      const slice = namesOfType.slice(i, i + CHUNK);
      const r1 = await pool.query(
        "UPDATE triples SET subject_type = $1 WHERE subject = ANY($2) AND subject_type IS NULL",
        [type, slice],
      );
      const r2 = await pool.query(
        "UPDATE triples SET object_type = $1 WHERE object = ANY($2) AND object_type IS NULL",
        [type, slice],
      );
      updated += (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    }
  }

  console.log(`Updated ${updated} triple columns`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
