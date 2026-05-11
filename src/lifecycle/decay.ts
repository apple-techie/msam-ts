import { eq, and, inArray, lt, gte, sql, or } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { atoms, accessLog, forgettingLog } from "../db/schema.js";
import { calculateRetrievability } from "../core/act-r.js";
import { getConfig } from "../config/index.js";

export interface DecayStats {
  processed: number;
  transitioned: number;
  protected: number;
  errors: number;
  faded: number;
  dormanted: number;
  reactivated: number;
  confidenceDecayed: number;
}

export async function runDecayCycle(agentId?: string): Promise<DecayStats> {
  const db = getDb();
  const config = getConfig();
  const decay = config.decay;
  const now = new Date();

  const stats: DecayStats = {
    processed: 0,
    transitioned: 0,
    protected: 0,
    errors: 0,
    faded: 0,
    dormanted: 0,
    reactivated: 0,
    confidenceDecayed: 0,
  };

  try {
    const protectionCutoff = new Date(
      now.getTime() - decay.protection_days * 86_400_000,
    );

    const recentlyAccessedRows = await db
      .selectDistinct({ atomId: accessLog.atomId })
      .from(accessLog)
      .where(gte(accessLog.accessedAt, protectionCutoff));

    const recentlyAccessedIds = new Set(recentlyAccessedRows.map((r) => r.atomId));

    const pinnedRows = await db
      .select({ id: atoms.id })
      .from(atoms)
      .where(eq(atoms.isPinned, true));

    const pinnedIds = new Set(pinnedRows.map((r) => r.id));

    const recentAtomRows = await db
      .select({ id: atoms.id })
      .from(atoms)
      .where(gte(atoms.lastAccessedAt, protectionCutoff));

    for (const r of recentAtomRows) {
      recentlyAccessedIds.add(r.id);
    }

    const protectedIds = new Set([...recentlyAccessedIds, ...pinnedIds]);
    stats.protected = protectedIds.size;

    const agentFilter = agentId ? eq(atoms.agentId, agentId) : undefined;
    const stateFilter = or(eq(atoms.state, "active"), eq(atoms.state, "fading"));
    const whereClause = agentFilter ? and(stateFilter, agentFilter) : stateFilter;

    const activeAtoms = await db
      .select({
        id: atoms.id,
        state: atoms.state,
        stability: atoms.stability,
        createdAt: atoms.createdAt,
        accessCount: atoms.accessCount,
        encodingConfidence: atoms.encodingConfidence,
        lastAccessedAt: atoms.lastAccessedAt,
      })
      .from(atoms)
      .where(whereClause!);

    for (const atom of activeAtoms) {
      stats.processed++;
      try {
        const elapsedMs = now.getTime() - atom.createdAt.getTime();
        const elapsedSec = Math.max(elapsedMs / 1000, 0.01);
        const stability = Math.max(atom.stability ?? 1.0, 0.01);
        const R = calculateRetrievability(stability, elapsedSec);

        await db
          .update(atoms)
          .set({ retrievability: R })
          .where(eq(atoms.id, atom.id));

        if (protectedIds.has(atom.id)) {
          continue;
        }

        let newState: string | null = null;

        if (atom.state === "active" && R < decay.active_to_fading_threshold) {
          newState = "fading";
          stats.faded++;
        } else if (atom.state === "fading" && R < decay.fading_to_dormant_threshold) {
          newState = "dormant";
          stats.dormanted++;
        } else if (
          atom.state === "fading" &&
          R >= (decay as any).reactivation_threshold &&
          (atom.accessCount ?? 0) >= (decay as any).reactivation_min_access
        ) {
          newState = "active";
          stats.reactivated++;
        }

        if (newState) {
          await db
            .update(atoms)
            .set({ state: newState as any })
            .where(eq(atoms.id, atom.id));

          await db.insert(forgettingLog).values({
            atomId: atom.id,
            previousState: atom.state!,
            newState,
            reason: `retrievability ${R.toFixed(4)} triggered ${atom.state}->${newState}`,
            factors: { retrievability: Math.round(R * 10000) / 10000 },
            timestamp: now,
          });

          stats.transitioned++;
        }
      } catch (err) {
        stats.errors++;
      }
    }

    const graceCutoff = new Date(
      now.getTime() - decay.confidence_decay_grace_days * 86_400_000,
    );

    const decayCandidates = await db
      .select({ id: atoms.id, encodingConfidence: atoms.encodingConfidence })
      .from(atoms)
      .where(
        and(
          or(eq(atoms.state, "active"), eq(atoms.state, "fading")),
          eq(atoms.isPinned, false),
          lt(atoms.lastAccessedAt, graceCutoff),
          agentFilter,
        ),
      );

    for (const atom of decayCandidates) {
      const currentConf = atom.encodingConfidence ?? 0.7;
      const newConf = Math.max(currentConf - decay.confidence_decay_rate, decay.confidence_floor);
      if (newConf < currentConf) {
        await db
          .update(atoms)
          .set({ encodingConfidence: newConf })
          .where(eq(atoms.id, atom.id));
        stats.confidenceDecayed++;
      }
    }
  } catch (err) {
    stats.errors++;
  }

  return stats;
}
