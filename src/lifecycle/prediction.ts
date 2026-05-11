import { eq, and, sql, gte, or } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { atoms, temporalPatterns, coRetrieval } from "../db/schema.js";
import { getConfig } from "../config/index.js";

export interface PredictionResult {
  predicted: PredictedAtom[];
  strategy: string;
  confidence: number;
}

export interface PredictedAtom {
  id: string;
  content: string;
  score: number;
  predictedBy: string;
}

type TimeBucket = "morning" | "afternoon" | "evening" | "night";

const TIME_BUCKETS: Record<TimeBucket, [number, number]> = {
  morning: [6, 11],
  afternoon: [12, 16],
  evening: [17, 21],
  night: [22, 5],
};

function getCurrentBucket(hour: number): TimeBucket {
  if (hour >= 6 && hour <= 11) return "morning";
  if (hour >= 12 && hour <= 16) return "afternoon";
  if (hour >= 17 && hour <= 21) return "evening";
  return "night";
}

function bucketHourRanges(
  bucket: TimeBucket,
): Array<[number, number]> {
  const [start, end] = TIME_BUCKETS[bucket];
  if (start <= end) return [[start, end]];
  return [[start, 23], [0, end]];
}

export async function predictiveRetrieve(
  agentId: string,
  params?: { warm?: boolean },
): Promise<PredictionResult> {
  const db = getDb();
  const config = getConfig();
  const pCfg = config.prediction;

  if (!pCfg.enabled) {
    return { predicted: [], strategy: "disabled", confidence: 0 };
  }

  const now = new Date();
  const hour = now.getUTCHours();
  const dow = now.getUTCDay();

  const [temporal, coret, momentum] = await Promise.all([
    temporalStrategy(db, agentId, hour, dow, pCfg),
    coRetrievalStrategy(db, agentId, pCfg),
    topicMomentumStrategy(db, agentId, pCfg),
  ]);

  const merged = mergeCandidates(
    [temporal, coret, momentum],
    [pCfg.temporal_weight, pCfg.coretrieval_weight, pCfg.momentum_weight],
  );

  const filtered = merged.filter((c) => c.score >= pCfg.min_confidence);
  const topK = filtered.slice(0, pCfg.max_predicted_atoms);

  const dominantStrategy =
    topK.length > 0
      ? topK[0].predictedBy
      : "none";

  const avgConfidence =
    topK.length > 0
      ? topK.reduce((sum, c) => sum + c.score, 0) / topK.length
      : 0;

  return {
    predicted: topK,
    strategy: dominantStrategy,
    confidence: Math.round(avgConfidence * 1000) / 1000,
  };
}

async function temporalStrategy(
  db: ReturnType<typeof getDb>,
  agentId: string,
  hour: number,
  dow: number,
  pCfg: ReturnType<typeof getConfig>["prediction"],
): Promise<PredictedAtom[]> {
  const window = pCfg.temporal_window_hours;
  const minCount = pCfg.min_pattern_count;
  const hourMin = ((hour - window) % 24 + 24) % 24;
  const hourMax = (hour + window) % 24;

  let hourClause: ReturnType<typeof sql>;
  if (hourMin <= hourMax) {
    hourClause = sql`tp.hour_of_day BETWEEN ${hourMin} AND ${hourMax}`;
  } else {
    hourClause = sql`(tp.hour_of_day >= ${hourMin} OR tp.hour_of_day <= ${hourMax})`;
  }

  const rows = await db.execute(sql`
    SELECT tp.atom_id, SUM(tp.retrieval_count) AS total_count, a.content
    FROM temporal_patterns tp
    JOIN atoms a ON a.id = tp.atom_id
    WHERE ${hourClause}
      AND (tp.day_of_week = ${dow} OR tp.day_of_week IS NULL)
      AND tp.retrieval_count >= ${minCount}
      AND a.state IN ('active', 'fading')
      AND a.agent_id = ${agentId}
    GROUP BY tp.atom_id, a.content
    ORDER BY total_count DESC
    LIMIT 20
  `);

  const candidates = (rows.rows as any[]).map((r) => ({
    id: r.atom_id as string,
    content: ((r.content as string) ?? "").slice(0, 100),
    score: Number(r.total_count),
    predictedBy: "temporal",
  }));

  return normalize(candidates);
}

async function coRetrievalStrategy(
  db: ReturnType<typeof getDb>,
  agentId: string,
  pCfg: ReturnType<typeof getConfig>["prediction"],
): Promise<PredictedAtom[]> {
  const threshold = pCfg.co_retrieval_threshold;

  const recentAccess = await db.execute(sql`
    SELECT DISTINCT al.atom_id
    FROM access_log al
    JOIN atoms a ON a.id = al.atom_id
    WHERE a.agent_id = ${agentId}
      AND al.accessed_at > NOW() - INTERVAL '24 hours'
    ORDER BY al.accessed_at DESC
    LIMIT 5
  `);

  const seedIds = (recentAccess.rows as any[]).map((r) => r.atom_id as string);
  if (seedIds.length === 0) return [];

  const candidates = new Map<string, PredictedAtom>();

  for (const seedId of seedIds) {
    const partners = await db.execute(sql`
      SELECT
        CASE WHEN atom_a = ${seedId} THEN atom_b ELSE atom_a END AS partner,
        co_count
      FROM co_retrieval
      WHERE (atom_a = ${seedId} OR atom_b = ${seedId})
        AND co_count >= ${threshold}
      ORDER BY co_count DESC
      LIMIT 10
    `);

    for (const row of partners.rows as any[]) {
      const partnerId = row.partner as string;
      if (seedIds.includes(partnerId)) continue;

      const existing = candidates.get(partnerId);
      if (existing) {
        existing.score += Number(row.co_count);
      } else {
        const atomRow = await db
          .select({ content: atoms.content })
          .from(atoms)
          .where(
            and(
              eq(atoms.id, partnerId),
              or(eq(atoms.state, "active"), eq(atoms.state, "fading")),
            ),
          )
          .limit(1);

        if (atomRow.length) {
          candidates.set(partnerId, {
            id: partnerId,
            content: atomRow[0].content.slice(0, 100),
            score: Number(row.co_count),
            predictedBy: "co_retrieval",
          });
        }
      }
    }
  }

  return normalize(Array.from(candidates.values()));
}

async function topicMomentumStrategy(
  db: ReturnType<typeof getDb>,
  agentId: string,
  pCfg: ReturnType<typeof getConfig>["prediction"],
): Promise<PredictedAtom[]> {
  const recentAtoms = await db.execute(sql`
    SELECT topics
    FROM atoms
    WHERE agent_id = ${agentId}
      AND state = 'active'
      AND topics IS NOT NULL
      AND last_accessed_at > NOW() - INTERVAL '48 hours'
    ORDER BY last_accessed_at DESC
    LIMIT 10
  `);

  const recentTopics = new Set<string>();
  for (const row of recentAtoms.rows as any[]) {
    const topics = row.topics;
    if (Array.isArray(topics)) {
      for (const t of topics) {
        if (typeof t === "string") recentTopics.add(t.toLowerCase());
      }
    }
  }

  if (recentTopics.size === 0) return [];

  const allAtoms = await db
    .select({ id: atoms.id, content: atoms.content, topics: atoms.topics })
    .from(atoms)
    .where(
      and(
        eq(atoms.state, "active"),
        eq(atoms.agentId, agentId),
        sql`topics IS NOT NULL AND topics != '[]'::jsonb`,
      ),
    );

  const candidates: PredictedAtom[] = [];

  for (const atom of allAtoms) {
    const atomTopics = atom.topics as string[] | null;
    if (!atomTopics || !Array.isArray(atomTopics)) continue;

    const atomTopicSet = new Set(
      atomTopics.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase()),
    );

    let score = 0;
    for (const t of atomTopicSet) {
      if (recentTopics.has(t)) score += 1.0;
    }

    if (score > 0) {
      candidates.push({
        id: atom.id,
        content: atom.content.slice(0, 100),
        score,
        predictedBy: "topic_momentum",
      });
    }
  }

  return normalize(candidates);
}

function normalize(candidates: PredictedAtom[]): PredictedAtom[] {
  if (candidates.length === 0) return candidates;
  const maxScore = Math.max(...candidates.map((c) => c.score));
  if (maxScore > 0) {
    for (const c of candidates) {
      c.score = c.score / maxScore;
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function mergeCandidates(
  lists: PredictedAtom[][],
  weights: number[],
): PredictedAtom[] {
  const merged = new Map<string, PredictedAtom>();

  for (let i = 0; i < lists.length; i++) {
    const weight = weights[i] ?? 1.0;
    for (const c of lists[i]) {
      const existing = merged.get(c.id);
      if (existing) {
        existing.score += c.score * weight;
        if (!existing.predictedBy.includes(c.predictedBy)) {
          existing.predictedBy += `+${c.predictedBy}`;
        }
      } else {
        merged.set(c.id, {
          ...c,
          score: c.score * weight,
        });
      }
    }
  }

  const result = Array.from(merged.values());
  result.sort((a, b) => b.score - a.score);
  return result;
}
