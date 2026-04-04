import { getConfigValue } from "../config/index.js";
import type { RetrievalMode } from "../core/types.js";
import type { ScoredAtom, RetrievalDb } from "./strategies.js";
import { rewriteQuery, expandQuery } from "./strategies.js";

export interface BeamSearchParams {
  query: string;
  originalQuery: string;
  mode: RetrievalMode;
  topK: number;
  beamWidth: number;
  queryEmbedding: number[];
  db: RetrievalDb;
  embed: (text: string) => Promise<number[]>;
}

export async function beamSearchRetrieve(params: BeamSearchParams): Promise<ScoredAtom[]> {
  const { query, mode, topK, db, embed } = params;
  const allResults = new Map<string, ScoredAtom>();
  const beamCounts = new Map<string, number>();

  function mergeBeam(results: ScoredAtom[], label: string) {
    for (const item of results) {
      const id = item.atom.id;
      beamCounts.set(id, (beamCounts.get(id) ?? 0) + 1);

      const existing = allResults.get(id);
      if (!existing || item.combinedScore > existing.combinedScore) {
        allResults.set(id, { ...item, beam: label });
      }
    }
  }

  // Beam 1: Original query
  const beam1 = await db.hybridRetrieve(params.queryEmbedding, mode, topK);
  mergeBeam(beam1, "original");

  // Beam 2: Rewritten query
  const rewritten = rewriteQuery(query);
  if (rewritten !== query) {
    const rewrittenEmb = await embed(rewritten);
    const beam2 = await db.hybridRetrieve(rewrittenEmb, mode, topK);
    mergeBeam(beam2, "rewritten");
  }

  // Beam 3: Expanded query
  if (getConfigValue("retrieval_v2", "enable_query_expansion", true)) {
    const expanded = await expandQuery(query, db);
    if (expanded !== query) {
      const expandedEmb = await embed(expanded);
      const beam3 = await db.hybridRetrieve(expandedEmb, mode, topK);
      mergeBeam(beam3, "expanded");
    }
  }

  // Multi-beam bonus
  for (const [id, item] of allResults) {
    const count = beamCounts.get(id) ?? 1;
    if (count > 1) {
      item.combinedScore *= 1 + 0.2 * count;
      item.multiBeam = count;
    }
  }

  const results = [...allResults.values()];
  results.sort((a, b) => b.combinedScore - a.combinedScore);
  return results.slice(0, topK);
}
