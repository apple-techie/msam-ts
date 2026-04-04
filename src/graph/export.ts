import {
  exportAgentTriples,
  GATEWAY_MAP,
  GATEWAY_ORDER,
  EXCLUDE_AGENTS,
} from "../agents/registry.js";
import {
  runCrossAgentDiscovery,
  type CrossDiscoveryConfig,
  type DiscoveryResult,
} from "../agents/cross-discovery.js";

export { GATEWAY_MAP, GATEWAY_ORDER, EXCLUDE_AGENTS };

export async function exportForKgViewer(
  outputPath: string,
): Promise<{ agents: number; triples: number }> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  return exportAgentTriples(dbUrl, outputPath);
}

export async function exportForKgViewerWithDiscovery(
  outputPath: string,
  crossDiscoveryConfig: CrossDiscoveryConfig,
): Promise<{ agents: number; triples: number; crossEdges: number }> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const base = await exportAgentTriples(dbUrl, outputPath);

  if (!crossDiscoveryConfig.enabled) {
    return { ...base, crossEdges: 0 };
  }

  const discovery = await runCrossAgentDiscovery(dbUrl, crossDiscoveryConfig);

  const { readFileSync, writeFileSync } = await import("node:fs");
  const existing = JSON.parse(readFileSync(outputPath, "utf-8"));

  existing.cross_discovery = {
    shared_entities: discovery.sharedEntities,
    cross_triples: discovery.crossTriples,
    group_stats: discovery.groupStats,
  };

  writeFileSync(outputPath, JSON.stringify(existing));

  return {
    ...base,
    crossEdges: discovery.crossTriples.length,
  };
}

export async function exportGroupView(
  outputPath: string,
  groupName: string,
  crossDiscoveryConfig: CrossDiscoveryConfig,
): Promise<{ agents: number; triples: number; crossEdges: number }> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const group = crossDiscoveryConfig.groups.find((g) => g.name === groupName);
  if (!group) {
    throw new Error(`Group "${groupName}" not found in cross-discovery config`);
  }

  const pg = await import("pg");
  const client = new pg.default.Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const agentPlaceholders = group.agents.map((_, i) => `$${i + 1}`).join(", ");

    const triplesResult = await client.query(
      `SELECT t.subject, t.predicate, t.object, t.confidence, a.agent_id
       FROM triples t
       JOIN atoms a ON t.atom_id = a.id
       WHERE a.agent_id IN (${agentPlaceholders})
         AND (t.state IS NULL OR t.state = 'active')
         AND a.state = 'active'
       ORDER BY a.agent_id, t.confidence DESC`,
      group.agents,
    );

    const agentTriples: Record<string, Array<Record<string, unknown>>> = {};
    for (const row of triplesResult.rows) {
      const agentId = row.agent_id as string;
      if (!agentTriples[agentId]) agentTriples[agentId] = [];
      agentTriples[agentId].push({
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        confidence: row.confidence,
      });
    }

    let crossTriples: unknown[] = [];
    if (crossDiscoveryConfig.enabled) {
      const discovery = await runCrossAgentDiscovery(dbUrl, crossDiscoveryConfig);
      crossTriples = discovery.crossTriples.filter((t) =>
        t.sourceAgents.some((a) => group.agents.includes(a)),
      );
    }

    const result = {
      group: groupName,
      agents: group.agents,
      agent_triples: agentTriples,
      cross_triples: crossTriples,
      exported_at: new Date().toISOString(),
    };

    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(result));

    const totalTriples = Object.values(agentTriples).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );

    return {
      agents: Object.keys(agentTriples).length,
      triples: totalTriples,
      crossEdges: crossTriples.length,
    };
  } finally {
    await client.end();
  }
}
