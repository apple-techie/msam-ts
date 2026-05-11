/**
 * Entity Resolver — normalizes entity names to canonical forms before triple storage.
 *
 * Three-stage normalization:
 * 1. Clean artifacts (numbered list prefixes, quotes, backticks, URLs)
 * 2. Alias resolution (User -> Person_One, etc.)
 * 3. Format normalization (Title_Case, strip special chars)
 *
 * BUILTIN_ALIASES below is an example map — supplement or replace it via config
 * for your deployment.
 */

import { getConfig } from "../config/index.js";

// ─── Built-in aliases (supplemented by config) ─────────────────

const BUILTIN_ALIASES: Record<string, string> = {
  // People
  user: "Person_One",
  User: "Person_One",
  "@person_one": "Person_One",
  "@PersonOne": "Person_One",
  PersonOne: "Person_One",

  // Agents / Systems
  "system-alpha": "System_Alpha",
  "gateway-one": "Gateway_One",
  "gateway-two": "Gateway_Two",

  // Projects
  Project_One_Inc: "Project_One",
  Project_Two_Long: "Project_Two",
  MV: "Project_Three",

  // Infra
  "host-a": "Host_A",
  "host-b": "Host_B",
  "host-c": "Host_C",

  // Synonyms
  GenericEngine: "Generic_Engine",
  "generic engine": "Generic_Engine",
};

// ─── Artifact Patterns ──────────────────────────────────────────

// Matches numbered list prefix artifacts like "1._(", "12._(", "4. ", etc.
const NUMBERED_PREFIX = /^\d+\.[_\s]*\(?/;

// Matches backtick-wrapped entities
const BACKTICK_WRAP = /^`(.+)`$/;

// Matches URL-like entities
const URL_PATTERN = /^https?:\/\//;

// Matches entities that are just file paths
const FILE_PATH_PATTERN = /^[\/~].*\//;

// ─── Public API ─────────────────────────────────────────────────

let _mergedAliases: Map<string, string> | null = null;

function getAliasMap(): Map<string, string> {
  if (_mergedAliases) return _mergedAliases;

  _mergedAliases = new Map<string, string>();

  // Load built-in aliases
  for (const [k, v] of Object.entries(BUILTIN_ALIASES)) {
    _mergedAliases.set(k.toLowerCase(), v);
  }

  // Override/extend with config aliases
  try {
    const config = getConfig();
    const configAliases = config.entity_resolution?.aliases ?? {};
    for (const [k, v] of Object.entries(configAliases)) {
      if (k !== "user_nick" && k !== "agent_nick") {
        _mergedAliases.set(k.toLowerCase(), v);
      }
    }
  } catch {
    // Config not loaded yet — use builtins only
  }

  return _mergedAliases;
}

/** Reset cached alias map (for config reload or testing) */
export function resetAliasCache(): void {
  _mergedAliases = null;
}

/**
 * Clean artifact noise from an entity name.
 * Removes numbered list prefixes, backticks, trailing parens, etc.
 */
function cleanArtifacts(entity: string): string {
  let cleaned = entity.trim();

  // Remove numbered list prefix: "1._(Person_One" -> "Person_One"
  cleaned = cleaned.replace(NUMBERED_PREFIX, "");

  // Remove backtick wrapping
  const btMatch = cleaned.match(BACKTICK_WRAP);
  if (btMatch) cleaned = btMatch[1];

  // Remove leading/trailing parens, quotes
  cleaned = cleaned.replace(/^[("'\s]+|[)"'\s]+$/g, "");

  // Remove trailing underscores or hyphens
  cleaned = cleaned.replace(/[_-]+$/, "");

  return cleaned.trim();
}

/**
 * Normalize entity format to Title_Case with underscores.
 */
function normalizeFormat(entity: string): string {
  // Replace spaces and hyphens with underscores
  let normalized = entity.replace(/[\s-]+/g, "_");

  // Remove characters that aren't alphanumeric, underscore, or period
  normalized = normalized.replace(/[^a-zA-Z0-9_.]/g, "");

  // Collapse multiple underscores
  normalized = normalized.replace(/_+/g, "_");

  // Remove leading/trailing underscores
  normalized = normalized.replace(/^_+|_+$/g, "");

  return normalized;
}

/**
 * Check if an entity should be skipped entirely (not useful for knowledge graph).
 */
function shouldSkip(entity: string): boolean {
  if (entity.length < 2) return true;
  if (URL_PATTERN.test(entity)) return true;
  if (FILE_PATH_PATTERN.test(entity)) return true;

  // Skip pure numbers
  if (/^\d+$/.test(entity)) return true;

  // Skip boolean-like
  const lower = entity.toLowerCase();
  if (["true", "false", "yes", "no", "none", "null", "undefined"].includes(lower)) return true;

  // Skip generic words that aren't useful entities
  if (["the", "this", "that", "it", "they", "we", "he", "she"].includes(lower)) return true;

  return false;
}

/**
 * Resolve an entity name to its canonical form.
 *
 * Pipeline: clean artifacts -> skip check -> alias lookup -> format normalize
 *
 * Returns null if the entity should be skipped.
 */
export function resolveEntity(raw: string): string | null {
  const cleaned = cleanArtifacts(raw);
  if (shouldSkip(cleaned)) return null;

  // Check alias map (case-insensitive)
  const aliases = getAliasMap();
  const aliased = aliases.get(cleaned.toLowerCase());
  if (aliased) return aliased;

  // No alias found — normalize format
  return normalizeFormat(cleaned);
}

/**
 * Resolve subject and object of a triple. Returns null if either should be skipped.
 */
export function resolveTripleEntities(
  subject: string,
  predicate: string,
  object: string,
): { subject: string; predicate: string; object: string } | null {
  const resolvedSubject = resolveEntity(subject);
  const resolvedObject = resolveEntity(object);

  if (!resolvedSubject || !resolvedObject) return null;

  // Don't store self-referential triples
  if (resolvedSubject === resolvedObject) return null;

  return {
    subject: resolvedSubject,
    predicate,
    object: resolvedObject,
  };
}

/**
 * Add a new alias at runtime. Persists in memory only (not written to config).
 */
export function addAlias(from: string, to: string): void {
  const aliases = getAliasMap();
  aliases.set(from.toLowerCase(), to);
}

/**
 * Get all current aliases (builtin + config).
 */
export function getAllAliases(): Record<string, string> {
  const aliases = getAliasMap();
  const result: Record<string, string> = {};
  for (const [k, v] of aliases) {
    result[k] = v;
  }
  return result;
}
