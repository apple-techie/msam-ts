import { eq, and, lt, gte, sql, or } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import {
  atoms,
  accessLog,
  atomRelations,
  forgettingLog,
} from "../db/schema.js";
import { getConfig } from "../config/index.js";

export interface ForgettingSignal {
  atomId: string;
  signal: "low_activation" | "redundancy" | "staleness" | "contradiction";
  score: number;
  details: Record<string, unknown>;
}

export interface ForgettingResult {
  candidates: ForgettingCandidate[];
  forgotten: number;
  signals: Record<string, number>;
  dryRun: boolean;
}

export interface ForgettingCandidate {
  atomId: string;
  signals: string[];
  signalCount: number;
  combinedScore: number;
}

export async function runForgetting(params?: {
  dryRun?: boolean;
  auto?: boolean;
}): Promise<ForgettingResult> {
  const dryRun = params?.dryRun ?? true;
  const db = getDb();
  const config = getConfig();
  const decay = config.decay;

  const allSignals: ForgettingSignal[] = [];

  const [overRetrieved, superseded, contradicted, lowConfidence] =
    await Promise.all([
      detectOverRetrieved(
        db,
        decay.forgetting_min_retrievals,
        decay.forgetting_contribution_threshold,
      ),
      detectSuperseded(db),
      detectContradicted(db),
      detectLowConfidence(
        db,
        decay.forgetting_confidence_floor,
        decay.forgetting_grace_days,
      ),
    ]);

  allSignals.push(...overRetrieved, ...superseded, ...contradicted, ...lowConfidence);

  const signalCounts: Record<string, number> = {
    low_activation: overRetrieved.length,
    redundancy: superseded.length,
    staleness: lowConfidence.length,
    contradiction: contradicted.length,
  };

  const atomMap = new Map<
    string,
    { signals: Set<string>; totalScore: number }
  >();

  for (const sig of allSignals) {
    if (!atomMap.has(sig.atomId)) {
      atomMap.set(sig.atomId, { signals: new Set(), totalScore: 0 });
    }
    const entry = atomMap.get(sig.atomId)!;
    entry.signals.add(sig.signal);
    entry.totalScore += sig.score;
  }

  const candidates: ForgettingCandidate[] = Array.from(atomMap.entries())
    .map(([atomId, info]) => ({
      atomId,
      signals: Array.from(info.signals).sort(),
      signalCount: info.signals.size,
      combinedScore: info.totalScore,
    }))
    .sort((a, b) => b.signalCount - a.signalCount || b.combinedScore - a.combinedScore);

  let forgotten = 0;

  if (!dryRun) {
    const mode = decay.intentional_forgetting_mode;
    if (mode === "auto" || params?.auto) {
      const now = new Date();

      for (const candidate of candidates) {
        const row = await db
          .select({ state: atoms.state })
          .from(atoms)
          .where(eq(atoms.id, candidate.atomId))
          .limit(1);

        if (!row.length || !["active", "fading"].includes(row[0].state!)) {
          continue;
        }

        const previousState = row[0].state!;
        const newState =
          candidate.signalCount > 1 || candidate.signals.includes("contradiction")
            ? "tombstone"
            : "dormant";

        await db
          .update(atoms)
          .set({ state: newState as any })
          .where(eq(atoms.id, candidate.atomId));

        await db.insert(forgettingLog).values({
          atomId: candidate.atomId,
          previousState,
          newState,
          reason: `intentional_forgetting: ${candidate.signals.join(", ")}`,
          factors: {
            signals: candidate.signals,
            triggered_by: "forgetting_engine",
          },
          timestamp: now,
        });

        forgotten++;
      }
    }
  }

  return {
    candidates,
    forgotten,
    signals: signalCounts,
    dryRun,
  };
}

async function detectOverRetrieved(
  db: ReturnType<typeof getDb>,
  minRetrievals: number,
  maxContributionRate: number,
): Promise<ForgettingSignal[]> {
  const rows = await db.execute(sql`
    SELECT
      al.atom_id,
      COUNT(*) AS total,
      SUM(CASE WHEN al.contributed = 1 THEN 1 ELSE 0 END) AS contributed
    FROM access_log al
    JOIN atoms a ON a.id = al.atom_id
    WHERE a.state IN ('active', 'fading')
      AND a.is_pinned = false
    GROUP BY al.atom_id
    HAVING COUNT(*) >= ${minRetrievals}
  `);

  const signals: ForgettingSignal[] = [];
  for (const row of rows.rows as any[]) {
    const total = Number(row.total);
    const contributed = Number(row.contributed);
    const rate = total > 0 ? contributed / total : 0;
    if (rate < maxContributionRate) {
      signals.push({
        atomId: row.atom_id,
        signal: "low_activation",
        score: 1 - rate,
        details: { totalRetrievals: total, contributed, contributionRate: rate },
      });
    }
  }
  return signals;
}

async function detectSuperseded(
  db: ReturnType<typeof getDb>,
): Promise<ForgettingSignal[]> {
  const rows = await db.execute(sql`
    SELECT
      ar.target_id AS atom_id,
      ar.source_id AS superseded_by
    FROM atom_relations ar
    JOIN atoms target ON target.id = ar.target_id
    JOIN atoms source ON source.id = ar.source_id
    WHERE ar.relation_type = 'supersedes'
      AND target.state IN ('active', 'fading')
      AND target.is_pinned = false
      AND source.state = 'active'
  `);

  return (rows.rows as any[]).map((row) => ({
    atomId: row.atom_id,
    signal: "redundancy" as const,
    score: 1.0,
    details: { supersededBy: row.superseded_by },
  }));
}

async function detectContradicted(
  db: ReturnType<typeof getDb>,
): Promise<ForgettingSignal[]> {
  const rows = await db.execute(sql`
    SELECT
      ar.target_id AS atom_id,
      ar.source_id AS contradicts_with
    FROM atom_relations ar
    JOIN atoms target ON target.id = ar.target_id
    JOIN atoms source ON source.id = ar.source_id
    WHERE ar.relation_type = 'contradicts'
      AND target.state IN ('active', 'fading')
      AND target.is_pinned = false
      AND source.state = 'active'
      AND COALESCE(target.encoding_confidence, 0.7) <= COALESCE(source.encoding_confidence, 0.7)
  `);

  return (rows.rows as any[]).map((row) => ({
    atomId: row.atom_id,
    signal: "contradiction" as const,
    score: 1.0,
    details: { contradictsWith: row.contradicts_with },
  }));
}

async function detectLowConfidence(
  db: ReturnType<typeof getDb>,
  floor: number,
  graceDays: number,
): Promise<ForgettingSignal[]> {
  const cutoff = new Date(Date.now() - graceDays * 86_400_000);

  const rows = await db
    .select({
      id: atoms.id,
      encodingConfidence: atoms.encodingConfidence,
      lastAccessedAt: atoms.lastAccessedAt,
      createdAt: atoms.createdAt,
    })
    .from(atoms)
    .where(
      and(
        or(eq(atoms.state, "active"), eq(atoms.state, "fading")),
        eq(atoms.isPinned, false),
        lt(atoms.encodingConfidence, floor),
      ),
    );

  const now = Date.now();
  return rows
    .filter((r) => {
      const lastTouch = r.lastAccessedAt ?? r.createdAt;
      return lastTouch.getTime() < cutoff.getTime();
    })
    .map((r) => {
      const lastTouch = r.lastAccessedAt ?? r.createdAt;
      const daysSince = (now - lastTouch.getTime()) / 86_400_000;
      return {
        atomId: r.id,
        signal: "staleness" as const,
        score: 1 - (r.encodingConfidence ?? 0),
        details: {
          encodingConfidence: r.encodingConfidence,
          daysSinceAccess: Math.round(daysSince * 10) / 10,
        },
      };
    });
}
