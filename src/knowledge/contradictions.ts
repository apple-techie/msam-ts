import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { triples, atoms } from "../db/schema.js";
import { cosineSimilarity } from "../core/act-r.js";
import { UNIQUE_PREDICATES, MULTI_PREDICATES } from "./triples.js";
import type { Triple } from "../core/types.js";

// ─── Contradiction Types ─────────────────────────────────────────

export type ContradictionType =
  | "negation"
  | "temporal_supersession"
  | "value_conflict"
  | "semantic_opposition";

export interface Contradiction {
  tripleA: { id: string; content: string; createdAt: string };
  tripleB: { id: string; content: string; createdAt: string };
  type: ContradictionType;
  confidence: number;
  explanation: string;
}

// ─── Antonym Pairs ───────────────────────────────────────────────

const ANTONYM_PAIRS: [string, string][] = [
  ["love", "hate"], ["start", "stop"], ["begin", "end"],
  ["join", "leave"], ["accept", "reject"], ["agree", "disagree"],
  ["allow", "forbid"], ["approve", "disapprove"], ["arrive", "depart"],
  ["attach", "detach"], ["build", "destroy"], ["buy", "sell"],
  ["connect", "disconnect"], ["create", "destroy"], ["enable", "disable"],
  ["enter", "exit"], ["expand", "contract"], ["gain", "lose"],
  ["give", "take"], ["happy", "sad"], ["help", "hinder"],
  ["hire", "fire"], ["include", "exclude"], ["increase", "decrease"],
  ["install", "uninstall"], ["like", "dislike"], ["open", "close"],
  ["pass", "fail"], ["positive", "negative"], ["promote", "demote"],
  ["push", "pull"], ["raise", "lower"], ["remember", "forget"],
  ["rise", "fall"], ["safe", "dangerous"], ["save", "spend"],
  ["show", "hide"], ["success", "failure"], ["support", "oppose"],
  ["true", "false"], ["trust", "distrust"], ["win", "lose"],
];

const ANTONYM_SET = new Set<string>();
for (const [a, b] of ANTONYM_PAIRS) {
  ANTONYM_SET.add(`${a.toLowerCase()}:${b.toLowerCase()}`);
  ANTONYM_SET.add(`${b.toLowerCase()}:${a.toLowerCase()}`);
}

// ─── Negation Pattern ────────────────────────────────────────────

const NEGATION_PATTERN = /\b(not|no longer|don't|doesn't|isn't|wasn't|weren't|aren't|stopped|quit|never|can't|won't|couldn't|wouldn't|shouldn't|haven't|hasn't|hadn't|didn't|cannot|nor|neither)\b/i;

const DATE_PATTERN = /\d{4}-\d{2}-\d{2}/g;

const RELATIVE_TIME_WORDS = /\b(now|currently|recently|today|yesterday|formerly|previously|used to|no longer|anymore|at this point)\b/i;

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can",
  "had", "her", "was", "one", "our", "out", "has", "his", "how",
  "its", "may", "who", "did", "get", "got", "him", "let", "say",
  "she", "too", "use", "that", "this", "with", "have", "from",
  "they", "been", "said", "each", "which", "their", "will",
  "other", "about", "many", "then", "them", "these", "some",
  "would", "make", "like", "into", "could", "time", "very",
  "when", "what", "your", "just", "know", "take", "people",
  "come", "than", "does", "doesn", "isn", "wasn", "don",
  "didn", "won", "can", "couldn", "wouldn", "shouldn",
]);

// ─── Detection Helpers ───────────────────────────────────────────

export function detectNegation(textA: string, textB: string): boolean {
  const negA = NEGATION_PATTERN.test(textA);
  const negB = NEGATION_PATTERN.test(textB);
  if (negA === negB) return false;

  const wordsA = new Set(
    (textA.toLowerCase().match(/\b[a-zA-Z]{3,}\b/g) ?? []).filter((w) => !STOP_WORDS.has(w)),
  );
  const wordsB = new Set(
    (textB.toLowerCase().match(/\b[a-zA-Z]{3,}\b/g) ?? []).filter((w) => !STOP_WORDS.has(w)),
  );

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap >= 2;
}

export function detectTemporalSupersession(
  atomA: { content: string; createdAt: string },
  atomB: { content: string; createdAt: string },
): boolean {
  const datesA = atomA.content.match(DATE_PATTERN) ?? [];
  const datesB = atomB.content.match(DATE_PATTERN) ?? [];
  const temporalA = RELATIVE_TIME_WORDS.test(atomA.content);
  const temporalB = RELATIVE_TIME_WORDS.test(atomB.content);

  if (datesA.length > 0 && datesB.length > 0) {
    const latestA = datesA.sort().pop()!;
    const latestB = datesB.sort().pop()!;
    if (latestA !== latestB) return true;
  }

  if (temporalA !== temporalB) return true;

  if (atomA.createdAt && atomB.createdAt) {
    try {
      const dtA = new Date(atomA.createdAt).getTime();
      const dtB = new Date(atomB.createdAt).getTime();
      if (Math.abs(dtA - dtB) > 86400_000) return true;
    } catch {
      // invalid date
    }
  }

  return false;
}

export function detectValueConflict(textA: string, textB: string): boolean {
  const pattern = /\b(is|are|was|were|lives?\s+in|works?\s+at|works?\s+for|located\s+in|moved\s+to|based\s+in|uses?|prefers?|weighs?|costs?|earns?|makes?|has|have|had)\s+(.+?)(?:\.|,|;|$)/gi;

  const matchesA: Array<[string, string]> = [];
  const matchesB: Array<[string, string]> = [];

  let m: RegExpExecArray | null;
  const patA = new RegExp(pattern.source, pattern.flags);
  while ((m = patA.exec(textA)) !== null) {
    matchesA.push([m[1].trim().toLowerCase(), m[2].trim().toLowerCase()]);
  }
  const patB = new RegExp(pattern.source, pattern.flags);
  while ((m = patB.exec(textB)) !== null) {
    matchesB.push([m[1].trim().toLowerCase(), m[2].trim().toLowerCase()]);
  }

  if (!matchesA.length || !matchesB.length) return false;

  for (const [verbA, valA] of matchesA) {
    for (const [verbB, valB] of matchesB) {
      if (verbA === verbB && valA && valB && valA !== valB) return true;
    }
  }
  return false;
}

export function detectAntonyms(textA: string, textB: string): boolean {
  const wordsA = new Set((textA.toLowerCase().match(/\b[a-zA-Z]+\b/g) ?? []));
  const wordsB = new Set((textB.toLowerCase().match(/\b[a-zA-Z]+\b/g) ?? []));

  for (const wa of wordsA) {
    for (const wb of wordsB) {
      if (ANTONYM_SET.has(`${wa}:${wb}`)) return true;
    }
  }
  return false;
}

// ─── Contradiction Scoring ───────────────────────────────────────

function scoreContradiction(
  type: ContradictionType,
  similarity: number,
): number {
  const typeWeights: Record<ContradictionType, number> = {
    negation: 0.9,
    value_conflict: 0.85,
    temporal_supersession: 0.7,
    semantic_opposition: 0.75,
  };
  const baseWeight = typeWeights[type];
  return Math.round(Math.min(baseWeight * similarity + 0.1, 1.0) * 100) / 100;
}

// ─── Public API ──────────────────────────────────────────────────

export async function detectContradictions(agentId?: string): Promise<Contradiction[]> {
  const db = getDb();

  const rows = await db
    .select({
      id: atoms.id,
      content: atoms.content,
      embedding: atoms.embedding,
      topics: atoms.topics,
      createdAt: atoms.createdAt,
      arousal: atoms.arousal,
      valence: atoms.valence,
    })
    .from(atoms)
    .where(
      and(
        eq(atoms.state, "active"),
        sql`${atoms.embedding} IS NOT NULL`,
      ),
    );

  if (!rows.length) return [];

  // Build topic groups
  const topicGroups = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const topicsRaw = rows[i].topics;
    let topics: string[] = [];
    if (Array.isArray(topicsRaw)) {
      topics = topicsRaw as string[];
    }
    if (!topics.length) {
      const group = topicGroups.get("__no_topic__") ?? [];
      group.push(i);
      topicGroups.set("__no_topic__", group);
    } else {
      for (const t of topics) {
        const key = t.trim().toLowerCase();
        const group = topicGroups.get(key) ?? [];
        group.push(i);
        topicGroups.set(key, group);
      }
    }
  }

  const seenPairs = new Set<string>();
  const contradictions: Contradiction[] = [];
  const threshold = 0.85;

  for (const indices of topicGroups.values()) {
    if (indices.length < 2) continue;

    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        const atomA = rows[indices[i]];
        const atomB = rows[indices[j]];

        const pairKey = [atomA.id, atomB.id].sort().join(":");
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        if (!atomA.embedding || !atomB.embedding) continue;
        const sim = cosineSimilarity(atomA.embedding, atomB.embedding);
        if (sim < threshold) continue;

        const textA = atomA.content;
        const textB = atomB.content;
        const aCreated = atomA.createdAt?.toISOString() ?? "";
        const bCreated = atomB.createdAt?.toISOString() ?? "";

        let type: ContradictionType | null = null;
        let explanation = "";

        if (detectNegation(textA, textB)) {
          type = "negation";
          explanation = "One atom negates the other; consider merging or retiring the outdated one.";
        } else if (
          detectTemporalSupersession(
            { content: textA, createdAt: aCreated },
            { content: textB, createdAt: bCreated },
          )
        ) {
          type = "temporal_supersession";
          explanation = "Newer atom may supersede older; consider retiring the older atom.";
        } else if (detectValueConflict(textA, textB)) {
          type = "value_conflict";
          explanation = "Atoms assign different values to the same property; verify which is correct.";
        } else if (detectAntonyms(textA, textB)) {
          type = "semantic_opposition";
          explanation = "Atoms contain semantically opposite terms; review for accuracy.";
        }

        if (type) {
          contradictions.push({
            tripleA: { id: atomA.id, content: textA, createdAt: aCreated },
            tripleB: { id: atomB.id, content: textB, createdAt: bCreated },
            type,
            confidence: scoreContradiction(type, sim),
            explanation,
          });
        }
      }
    }
  }

  return contradictions;
}

export async function checkBeforeStore(content: string, topK = 5): Promise<Contradiction[]> {
  const db = getDb();

  const rows = await db
    .select({
      id: atoms.id,
      content: atoms.content,
      embedding: atoms.embedding,
      createdAt: atoms.createdAt,
    })
    .from(atoms)
    .where(
      and(
        eq(atoms.state, "active"),
        sql`${atoms.embedding} IS NOT NULL`,
      ),
    );

  if (!rows.length) return [];

  // Embed the new content for similarity comparison
  let queryVec: number[];
  try {
    const { createEmbeddingProvider } = await import("../providers/embedding-provider.js");
    const { getConfig } = await import("../config/index.js");
    const cfg = getConfig();
    const provider = createEmbeddingProvider({
      provider: cfg.embedding.provider as "nvidia-nim" | "openai" | "onnx" | "local",
      model: cfg.embedding.model,
      apiKey: cfg.embedding.api_key ?? process.env[cfg.embedding.api_key_env] ?? undefined,
      baseUrl: cfg.embedding.url,
      dimensions: cfg.embedding.dimensions,
    });
    queryVec = await provider.embedSingle(content);
  } catch {
    return [];
  }

  // Score all atoms by similarity and take top K
  const scored = rows
    .filter((r) => r.embedding)
    .map((r) => ({
      row: r,
      sim: cosineSimilarity(queryVec, r.embedding!),
    }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, topK);

  const nowIso = new Date().toISOString();
  const contradictions: Contradiction[] = [];

  for (const { row: existing, sim } of scored) {
    const existingCreated = existing.createdAt?.toISOString() ?? "";
    let type: ContradictionType | null = null;
    let explanation = "";

    if (detectNegation(content, existing.content)) {
      type = "negation";
      explanation = "New content negates an existing atom; consider updating instead of adding.";
    } else if (
      detectTemporalSupersession(
        { content, createdAt: nowIso },
        { content: existing.content, createdAt: existingCreated },
      )
    ) {
      type = "temporal_supersession";
      explanation = "New content may supersede existing atom; consider retiring the older one.";
    } else if (detectValueConflict(content, existing.content)) {
      type = "value_conflict";
      explanation = "New content assigns a different value than existing atom; verify correctness.";
    } else if (detectAntonyms(content, existing.content)) {
      type = "semantic_opposition";
      explanation = "New content uses opposite terms from existing atom; review for accuracy.";
    }

    if (type) {
      contradictions.push({
        tripleA: { id: "__pending__", content, createdAt: nowIso },
        tripleB: {
          id: existing.id,
          content: existing.content,
          createdAt: existingCreated,
        },
        type,
        confidence: scoreContradiction(type, sim),
        explanation,
      });
    }
  }

  return contradictions;
}
