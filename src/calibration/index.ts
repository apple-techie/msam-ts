import { eq, or } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { atoms } from "../db/schema.js";
import { getConfigValue } from "../config/index.js";

export interface CalibrationResult {
  currentProvider: string;
  targetProvider: string;
  topK: number;
  perQuery: Array<{
    query: string;
    overlapAtK: number;
    kendallTau: number;
    sampleSize: number;
  }>;
  aggregate: {
    meanOverlapAtK: number;
    meanKendallTau: number;
    identityReconstructionScore: number;
    riskLevel: "low" | "medium" | "high";
    recommendation: string;
  };
}

export interface ReEmbedResult {
  targetProvider: string;
  atomsTotal: number;
  atomsUpdated: number;
  dryRun: boolean;
  indexRebuildNeeded: boolean;
}

export interface EmbeddingProvider {
  embed(text: string, inputType?: string): Promise<number[]>;
  batchEmbed(texts: string[], inputType?: string): Promise<number[][]>;
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function kendallTau(rankingA: string[], rankingB: string[]): number {
  const shared = new Set(rankingA.filter((x) => rankingB.includes(x)));
  if (shared.size < 2) return 0;

  const posA = new Map<string, number>();
  const posB = new Map<string, number>();
  rankingA.forEach((item, i) => {
    if (shared.has(item)) posA.set(item, i);
  });
  rankingB.forEach((item, i) => {
    if (shared.has(item)) posB.set(item, i);
  });

  const items = [...shared].sort();
  let concordant = 0;
  let discordant = 0;

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const diffA = posA.get(items[i])! - posA.get(items[j])!;
      const diffB = posB.get(items[i])! - posB.get(items[j])!;
      const product = diffA * diffB;
      if (product > 0) concordant++;
      else if (product < 0) discordant++;
    }
  }

  const n = concordant + discordant;
  return n === 0 ? 0 : (concordant - discordant) / n;
}

function overlapAtK(rankingA: string[], rankingB: string[], k: number): number {
  const topA = new Set(rankingA.slice(0, k));
  const topB = new Set(rankingB.slice(0, k));
  if (topA.size === 0 || topB.size === 0) return 0;
  let overlap = 0;
  for (const item of topA) {
    if (topB.has(item)) overlap++;
  }
  return overlap / k;
}

function rankAtomsByQuery(
  queryEmb: number[],
  atomIds: string[],
  embeddings: number[][],
): string[] {
  const sims = atomIds.map((id, i) => ({
    id,
    sim: cosineSim(queryEmb, embeddings[i]),
  }));
  sims.sort((a, b) => b.sim - a.sim);
  return sims.map((s) => s.id);
}

function getIdentityQueries(): string[] {
  const queries: string[] = [];
  for (const key of [
    "startup_identity_query",
    "startup_user_query",
    "startup_emotional_query",
    "startup_recent_query",
  ] as const) {
    try {
      const q = getConfigValue<string>("context", key);
      if (q) queries.push(q);
    } catch {
      // key not found
    }
  }
  return queries.length > 0
    ? queries
    : ["agent identity core traits personality"];
}

export async function calibrate(
  provider: string,
  options?: {
    currentProvider: EmbeddingProvider;
    targetProvider: EmbeddingProvider;
    queries?: string[];
    topK?: number;
  },
): Promise<CalibrationResult> {
  if (!options?.currentProvider || !options?.targetProvider) {
    throw new Error("Both currentProvider and targetProvider must be supplied");
  }

  const { currentProvider, targetProvider, topK = 10 } = options;
  const currentName = getConfigValue<string>("embedding", "provider", "nvidia-nim");
  const identityQueries = new Set(getIdentityQueries());
  const allQueries = options.queries ?? [...identityQueries];

  const db = getDb();
  const rows = await db
    .select({
      id: atoms.id,
      content: atoms.content,
      embedding: atoms.embedding,
    })
    .from(atoms)
    .where(or(eq(atoms.state, "active"), eq(atoms.state, "fading")));

  const withEmbeddings = rows.filter((r) => r.embedding != null);

  if (withEmbeddings.length === 0) {
    return {
      currentProvider: currentName,
      targetProvider: provider,
      topK,
      perQuery: [],
      aggregate: {
        meanOverlapAtK: 0,
        meanKendallTau: 0,
        identityReconstructionScore: 0,
        riskLevel: "low",
        recommendation: "No atoms to compare.",
      },
    };
  }

  const allAtomIds = withEmbeddings.map((r) => r.id);
  const allContents = withEmbeddings.map((r) => r.content);
  const allCurrentEmbs = withEmbeddings.map((r) => r.embedding!);
  const sampleSize = Math.min(allAtomIds.length, topK * 2);

  const perQuery: CalibrationResult["perQuery"] = [];
  const identityOverlaps: number[] = [];

  for (const query of allQueries) {
    const currentQueryEmb = await currentProvider.embed(query, "query");
    const currentRanking = rankAtomsByQuery(
      currentQueryEmb,
      allAtomIds,
      allCurrentEmbs,
    );

    const sampleIds = currentRanking.slice(0, sampleSize);
    const idToIdx = new Map(allAtomIds.map((id, i) => [id, i]));
    const sampleContents = sampleIds.map((id) => allContents[idToIdx.get(id)!]);

    const targetSampleEmbs = await targetProvider.batchEmbed(
      sampleContents,
      "passage",
    );
    const targetQueryEmb = await targetProvider.embed(query, "query");
    const targetRanking = rankAtomsByQuery(
      targetQueryEmb,
      sampleIds,
      targetSampleEmbs,
    );

    const overlap = overlapAtK(currentRanking, targetRanking, topK);
    const tau = kendallTau(
      currentRanking.slice(0, sampleSize),
      targetRanking,
    );

    perQuery.push({
      query,
      overlapAtK: Math.round(overlap * 10000) / 10000,
      kendallTau: Math.round(tau * 10000) / 10000,
      sampleSize: sampleIds.length,
    });

    if (identityQueries.has(query)) {
      identityOverlaps.push(overlap);
    }
  }

  const meanOverlap = perQuery.length > 0
    ? perQuery.reduce((s, q) => s + q.overlapAtK, 0) / perQuery.length
    : 0;
  const meanTau = perQuery.length > 0
    ? perQuery.reduce((s, q) => s + q.kendallTau, 0) / perQuery.length
    : 0;
  const identityScore = identityOverlaps.length > 0
    ? identityOverlaps.reduce((s, v) => s + v, 0) / identityOverlaps.length
    : 0;

  let riskLevel: "low" | "medium" | "high";
  let recommendation: string;
  if (meanOverlap >= 0.8) {
    riskLevel = "low";
    recommendation = "Safe to switch. Rankings are highly preserved.";
  } else if (meanOverlap >= 0.5) {
    riskLevel = "medium";
    recommendation =
      "Some ranking changes expected. Review identity queries before switching.";
  } else {
    riskLevel = "high";
    recommendation =
      "Significant ranking divergence. Not recommended without manual review.";
  }

  return {
    currentProvider: currentName,
    targetProvider: provider,
    topK,
    perQuery,
    aggregate: {
      meanOverlapAtK: Math.round(meanOverlap * 10000) / 10000,
      meanKendallTau: Math.round(meanTau * 10000) / 10000,
      identityReconstructionScore: Math.round(identityScore * 10000) / 10000,
      riskLevel,
      recommendation,
    },
  };
}

export async function reEmbed(
  provider: string,
  options: {
    targetProvider: EmbeddingProvider;
    batchSize?: number;
    dryRun?: boolean;
  },
): Promise<ReEmbedResult> {
  const { targetProvider, batchSize = 50, dryRun = false } = options;
  const db = getDb();

  const rows = await db
    .select({ id: atoms.id, content: atoms.content })
    .from(atoms)
    .where(or(eq(atoms.state, "active"), eq(atoms.state, "fading")));

  if (dryRun) {
    return {
      targetProvider: provider,
      atomsTotal: rows.length,
      atomsUpdated: 0,
      dryRun: true,
      indexRebuildNeeded: rows.length > 0,
    };
  }

  let updated = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const contents = batch.map((r) => r.content);

    const embeddings = await targetProvider.batchEmbed(contents, "passage");

    for (let j = 0; j < batch.length; j++) {
      await db
        .update(atoms)
        .set({
          embedding: embeddings[j],
          embeddingProvider: provider,
        })
        .where(eq(atoms.id, batch[j].id));
      updated++;
    }
  }

  return {
    targetProvider: provider,
    atomsTotal: rows.length,
    atomsUpdated: updated,
    dryRun: false,
    indexRebuildNeeded: updated > 0,
  };
}
