import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { atoms, atomRelations } from "../db/schema.js";
import { cosineSimilarity } from "../core/act-r.js";
import { getConfig } from "../config/index.js";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

export interface ConsolidationStats {
  clustersFound: number;
  abstractionsCreated: number;
  relationsCreated: number;
  sourcesReduced: number;
  errors: number;
}

interface ClusterAtom {
  id: string;
  content: string;
  stream: string | null;
  embedding: number[] | null;
  accessCount: number | null;
}

export async function runConsolidation(
  agentId?: string,
): Promise<ConsolidationStats> {
  const db = getDb();
  const config = getConfig();
  const cCfg = config.consolidation;
  const now = new Date();

  const stats: ConsolidationStats = {
    clustersFound: 0,
    abstractionsCreated: 0,
    relationsCreated: 0,
    sourcesReduced: 0,
    errors: 0,
  };

  const whereClause = agentId
    ? and(
        eq(atoms.state, "active"),
        eq(atoms.isPinned, false),
        eq(atoms.agentId, agentId),
      )
    : and(eq(atoms.state, "active"), eq(atoms.isPinned, false));

  const rows = await db
    .select({
      id: atoms.id,
      content: atoms.content,
      stream: atoms.stream,
      embedding: atoms.embedding,
      accessCount: atoms.accessCount,
      agentId: atoms.agentId,
    })
    .from(atoms)
    .where(whereClause!);

  if (rows.length < cCfg.min_cluster_size) {
    return stats;
  }

  const streamGroups = new Map<string, ClusterAtom[]>();
  for (const row of rows) {
    if (!row.embedding) continue;
    const stream = row.stream ?? "semantic";
    if (!streamGroups.has(stream)) {
      streamGroups.set(stream, []);
    }
    streamGroups.get(stream)!.push(row);
  }

  const clusters: ClusterAtom[][] = [];

  for (const [, group] of streamGroups) {
    if (group.length < cCfg.min_cluster_size) continue;

    const clustered = new Set<string>();

    for (let i = 0; i < group.length; i++) {
      if (clustered.has(group[i].id)) continue;

      const cluster: ClusterAtom[] = [group[i]];
      clustered.add(group[i].id);

      for (let j = i + 1; j < group.length; j++) {
        if (clustered.has(group[j].id)) continue;
        const sim = cosineSimilarity(group[i].embedding!, group[j].embedding!);
        if (sim >= cCfg.similarity_threshold) {
          cluster.push(group[j]);
          clustered.add(group[j].id);
        }
      }

      if (cluster.length >= cCfg.min_cluster_size) {
        clusters.push(cluster);
      }
    }
  }

  stats.clustersFound = clusters.length;

  const maxClusters = cCfg.max_clusters_per_run;
  const toProcess = clusters
    .sort((a, b) => b.length - a.length)
    .slice(0, maxClusters);

  for (const cluster of toProcess) {
    try {
      const synthesisContent = await synthesizeCluster(cluster, config);
      const synId = randomUUID();
      const contentHash = createHash("sha256")
        .update(synthesisContent)
        .digest("hex")
        .slice(0, 16);

      await db.insert(atoms).values({
        id: synId,
        content: synthesisContent,
        contentHash,
        stream: cluster[0].stream as any,
        sourceType: "inference",
        state: "active",
        createdAt: now,
        stability: 2.0,
        retrievability: 1.0,
        encodingConfidence: 0.8,
        agentId: (rows[0] as any).agentId ?? "default",
        metadata: {
          consolidatedFrom: cluster.map((a) => a.id).slice(0, 10),
          clusterSize: cluster.length,
        },
      });

      stats.abstractionsCreated++;

      for (const source of cluster) {
        try {
          await db
            .insert(atomRelations)
            .values({
              sourceId: source.id,
              targetId: synId,
              relationType: "consolidated_into",
              confidence: 1.0,
              createdAt: now,
            })
            .onConflictDoNothing();
          stats.relationsCreated++;
        } catch {
          // relation already exists
        }

        await db
          .update(atoms)
          .set({
            stability: sql`${atoms.stability} * ${cCfg.stability_reduction_factor}`,
          })
          .where(eq(atoms.id, source.id));
        stats.sourcesReduced++;
      }
    } catch (err) {
      stats.errors++;
    }
  }

  return stats;
}

async function synthesizeCluster(
  cluster: ClusterAtom[],
  config: ReturnType<typeof getConfig>,
): Promise<string> {
  const annotation = config.annotation;
  const apiKeyEnv = annotation.api_key_env;
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;

  if (!apiKey) {
    return fallbackSynthesis(cluster);
  }

  const contents = cluster.map((a) => a.content);
  const joined = contents.map((c) => `- ${c}`).join("\n");

  const prompt =
    `Synthesize the following ${cluster.length} related memory atoms into ` +
    `a single concise summary that captures the essential information. ` +
    `Output ONLY the synthesis, no explanations.\n\nAtoms:\n${joined}`;

  try {
    const { request } = await import("undici");
    const resp = await request(annotation.llm_url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: annotation.llm_model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        temperature: 0.3,
      }),
    });

    if (resp.statusCode === 200) {
      const data = (await resp.body.json()) as any;
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    }
  } catch {
    // fall through
  }

  return fallbackSynthesis(cluster);
}

function fallbackSynthesis(cluster: ClusterAtom[]): string {
  const longest = cluster.reduce((a, b) =>
    a.content.length > b.content.length ? a : b,
  );
  return `[Consolidated from ${cluster.length} atoms] ${longest.content}`;
}
