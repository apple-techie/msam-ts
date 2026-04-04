import type { Atom, Triple } from "../core/types.js";

// ─── Entity Role Type ────────────────────────────────────────────

export type EntityRole =
  | "user"
  | "agent"
  | "system"
  | "relationship"
  | "unknown";

// ─── Entity Pattern Definitions ──────────────────────────────────

interface EntityPatternConfig {
  titleSignals: string[];
  contentSignals: RegExp[];
  negativeSignals: RegExp[];
}

const ENTITY_PATTERNS: Record<string, EntityPatternConfig> = {
  user: {
    titleSignals: ["Things Agent Knows", "Schedule", "Preferences"],
    contentSignals: [
      /\b(user|User)\b/,
      /\b(profession|career|hobby|preference)\b/,
    ],
    negativeSignals: [/^(Who Agent Is|Core Traits|Agent Identity)/],
  },
  agent: {
    titleSignals: ["Agent Identity", "Core Traits", "Values"],
    contentSignals: [
      /\b(agent|Agent)\b.*\b(is|was|has|thinks)\b/,
      /\b(personality|identity|voice|traits)\b/,
    ],
    negativeSignals: [/^Things Agent Knows/],
  },
  system: {
    titleSignals: ["Infrastructure", "Configuration"],
    contentSignals: [
      /\b(MSAM|retrieval|atoms|embedding|pipeline)\b/i,
      /\b(server|gateway|config|infrastructure)\b/i,
      /\b(model routing|sub-agent|worker)\b/i,
    ],
    negativeSignals: [],
  },
  relationship: {
    titleSignals: ["Shared References"],
    contentSignals: [/\b(partner|together|trust|relationship|bond)\b/i],
    negativeSignals: [],
  },
};

// ─── Query Intent Patterns ───────────────────────────────────────

const QUERY_INTENT_PATTERNS: Record<string, RegExp[]> = {
  user: [
    /\b(user|User)\b.*\b(profession|job|career|work|birthday|age|schedule)\b/,
    /\b(user|User)\b.*\b(is|like|prefer|watch)\b/,
    /\bwho is (the user|User)\b/,
    /\b(user's|User's)\b/,
    /\bwhat does (the user|User)\b/,
  ],
  agent: [
    /\b(agent|Agent)\b.*\b(personalit|trait|identity|voice|value)\b/,
    /\bwho is (the agent|Agent)\b/,
    /\b(agent's|Agent's)\b.*\b(personalit|trait|identity)\b/,
    /\bwhat is (the agent|Agent)\b/,
  ],
  agent_internal: [
    /\b(emotional|emotion|feelings|mood|boundar)\b/,
    /\b(agent's?) (state|mood|feelings)\b/,
  ],
  system: [
    /\b(MSAM|memory system|retrieval|pipeline)\b/,
    /\b(server|system|infrastructure|config)\b/,
    /\bhow does .* work\b/,
  ],
  temporal: [
    /\b(today|yesterday|recent|latest|this week|last week|earlier|just now)\b/,
    /\bwhat happened\b/,
  ],
};

// ─── Classification ──────────────────────────────────────────────

export function classifyAboutEntity(content: string): { entity: EntityRole; confidence: number } {
  const firstLine = content.split("\n")[0].trim();
  const scores: Record<string, number> = {};

  for (const [entity, patterns] of Object.entries(ENTITY_PATTERNS)) {
    let score = 0;

    // Title signal match (strong)
    for (const titleSig of patterns.titleSignals) {
      if (firstLine.toLowerCase().includes(titleSig.toLowerCase())) {
        score += 3.0;
        break;
      }
    }

    // Negative signal (disqualify)
    let negated = false;
    for (const neg of patterns.negativeSignals) {
      if (neg.test(firstLine)) {
        score -= 5.0;
        negated = true;
        break;
      }
    }

    if (!negated) {
      for (const sig of patterns.contentSignals) {
        const matches = content.match(new RegExp(sig.source, sig.flags + "g"));
        if (matches) {
          score += Math.min(matches.length * 0.5, 2.0);
        }
      }
    }

    scores[entity] = score;
  }

  const entries = Object.entries(scores);
  entries.sort((a, b) => b[1] - a[1]);
  const best = entries[0];
  const secondBest = entries[1];

  if (best[1] <= 0) return { entity: "unknown", confidence: 0 };

  const gap = best[1] - (secondBest?.[1] ?? 0);
  const confidence = Math.min(gap / 5.0 + 0.5, 1.0);

  return {
    entity: best[0] as EntityRole,
    confidence: Math.round(confidence * 100) / 100,
  };
}

export function classifyQueryIntent(query: string): { entity: string; confidence: number } {
  const scores: Record<string, number> = {};
  for (const [entity, patterns] of Object.entries(QUERY_INTENT_PATTERNS)) {
    let score = 0;
    for (const pat of patterns) {
      if (pat.test(query)) score += 1.0;
    }
    scores[entity] = score;
  }

  const entries = Object.entries(scores);
  entries.sort((a, b) => b[1] - a[1]);
  const best = entries[0];
  if (best[1] <= 0) return { entity: "unknown", confidence: 0 };

  const total = Object.values(scores).reduce((s, v) => s + v, 0);
  return {
    entity: best[0],
    confidence: total > 0 ? Math.round((best[1] / total) * 100) / 100 : 0,
  };
}

// ─── Public API ──────────────────────────────────────────────────

export function classifyEntityRole(entity: string, predicates: string[]): EntityRole {
  const lower = entity.toLowerCase();
  if (lower === "user") return "user";
  if (lower === "agent") return "agent";

  const techPreds = ["uses_tool", "depends_on", "integrates_with", "connects_to", "configured_with", "deployed_on", "runs_on"];
  const personPreds = ["has_role", "works_with", "reports_to", "manages", "collaborates_with"];
  const prefPreds = ["prefers", "likes", "dislikes", "follows", "subscribes_to"];

  let techScore = 0;
  let personScore = 0;
  let prefScore = 0;

  for (const p of predicates) {
    if (techPreds.includes(p)) techScore++;
    if (personPreds.includes(p)) personScore++;
    if (prefPreds.includes(p)) prefScore++;
  }

  if (techScore > personScore && techScore > prefScore) return "system";
  if (personScore > 0) return "user";
  return "unknown";
}

export function scoreByEntityRole(atom: Atom, queryEntities: string[]): number {
  const { entity: atomEntity, confidence } = classifyAboutEntity(atom.content);
  if (!queryEntities.length) return 1.0;

  let bestMultiplier = 1.0;
  for (const qEntity of queryEntities) {
    const multiplier = entityScoreAdjustment(atomEntity, qEntity, confidence);
    if (Math.abs(multiplier - 1.0) > Math.abs(bestMultiplier - 1.0)) {
      bestMultiplier = multiplier;
    }
  }
  return bestMultiplier;
}

function entityScoreAdjustment(atomEntity: string, queryEntity: string, confidence: number): number {
  if (queryEntity === "unknown" || atomEntity === "unknown") return 1.0;
  if (queryEntity === "temporal" || queryEntity === "agent_internal") return 1.0;

  if (atomEntity === queryEntity) return 1.0 + 0.8 * confidence;

  const related = new Set([
    "user:relationship",
    "relationship:user",
    "agent:relationship",
    "relationship:agent",
    "user:agent",
    "agent:user",
  ]);

  if (related.has(`${atomEntity}:${queryEntity}`)) {
    return 1.0 - 0.15 * confidence;
  }

  return 1.0 - 0.5 * confidence;
}
