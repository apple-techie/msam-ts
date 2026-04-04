import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AgentInfo {
  id: string;
  atoms: number;
  triples: number;
  gateway: string;
}

export const GATEWAY_MAP: Record<string, string> = {
  enduru: "Enduru (ubuntu-root + mac-studio)",
  "enduru-botchat": "Enduru (ubuntu-root + mac-studio)",
  "enduru-group": "Enduru (ubuntu-root + mac-studio)",
  "enduru-kainotomic": "Enduru (ubuntu-root + mac-studio)",
  dexter: "Enduru (ubuntu-root + mac-studio)",
  main: "Enduru (ubuntu-root)",
  turkules: "Turkules (vm-1)",
  "mv-ops": "Turkules (vm-1)",
  "mv-data": "Turkules (vm-1)",
  "mv-marketing": "Turkules (vm-1)",
  "mv-product": "Turkules (vm-1)",
};

export const GATEWAY_ORDER: Record<string, number> = {
  "Enduru (ubuntu-root + mac-studio)": 0,
  "Enduru (ubuntu-root)": 1,
  "Turkules (vm-1)": 2,
};

export const EXCLUDE_AGENTS = new Set([
  "andrew",
  "kevin",
  "default",
  "orchestrator",
  "aurora",
  "aurora-worker",
  "justin",
]);

export async function exportAgentTriples(
  dbUrl: string,
  outputPath: string,
): Promise<{ agents: number; triples: number }> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const agentsResult = await client.query<{
      agent_id: string;
      atom_count: number;
    }>(
      `SELECT agent_id, COUNT(*)::int AS atom_count
       FROM atoms
       WHERE agent_id IS NOT NULL AND state = 'active'
       GROUP BY agent_id
       ORDER BY agent_id`,
    );

    const triplesResult = await client.query<{
      agent_id: string;
      triple_count: number;
    }>(
      `SELECT a.agent_id, COUNT(t.id)::int AS triple_count
       FROM triples t
       JOIN atoms a ON t.atom_id = a.id
       WHERE a.agent_id IS NOT NULL AND (t.state IS NULL OR t.state = 'active')
       GROUP BY a.agent_id`,
    );

    const tripleCounts = new Map<string, number>();
    for (const row of triplesResult.rows) {
      tripleCounts.set(row.agent_id, row.triple_count);
    }

    const agentList: AgentInfo[] = [];
    for (const row of agentsResult.rows) {
      if (EXCLUDE_AGENTS.has(row.agent_id)) continue;
      const gateway = GATEWAY_MAP[row.agent_id];
      if (!gateway) continue;
      agentList.push({
        id: row.agent_id,
        atoms: row.atom_count,
        triples: tripleCounts.get(row.agent_id) ?? 0,
        gateway,
      });
    }

    agentList.sort(
      (a, b) =>
        (GATEWAY_ORDER[a.gateway] ?? 99) - (GATEWAY_ORDER[b.gateway] ?? 99) ||
        a.id.localeCompare(b.id),
    );

    const agentTriples: Record<string, Array<Record<string, unknown>>> = {};
    for (const agent of agentList) {
      const res = await client.query(
        `SELECT t.subject, t.predicate, t.object, t.confidence
         FROM triples t
         JOIN atoms a ON t.atom_id = a.id
         WHERE a.agent_id = $1 AND (t.state IS NULL OR t.state = 'active')
         ORDER BY t.confidence DESC`,
        [agent.id],
      );
      if (res.rows.length > 0) {
        agentTriples[agent.id] = res.rows;
      }
    }

    const result = {
      agents: agentList,
      agent_triples: agentTriples,
      exported_at: new Date().toISOString(),
    };

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(result));

    const totalTriples = Object.values(agentTriples).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );

    return { agents: agentList.length, triples: totalTriples };
  } finally {
    await client.end();
  }
}

export async function getAgentsByGateway(
  dbUrl: string,
): Promise<Record<string, AgentInfo[]>> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const agentsResult = await client.query<{
      agent_id: string;
      atom_count: number;
    }>(
      `SELECT agent_id, COUNT(*)::int AS atom_count
       FROM atoms
       WHERE agent_id IS NOT NULL AND state = 'active'
       GROUP BY agent_id
       ORDER BY agent_id`,
    );

    const triplesResult = await client.query<{
      agent_id: string;
      triple_count: number;
    }>(
      `SELECT a.agent_id, COUNT(t.id)::int AS triple_count
       FROM triples t
       JOIN atoms a ON t.atom_id = a.id
       WHERE a.agent_id IS NOT NULL AND (t.state IS NULL OR t.state = 'active')
       GROUP BY a.agent_id`,
    );

    const tripleCounts = new Map<string, number>();
    for (const row of triplesResult.rows) {
      tripleCounts.set(row.agent_id, row.triple_count);
    }

    const grouped: Record<string, AgentInfo[]> = {};
    for (const row of agentsResult.rows) {
      if (EXCLUDE_AGENTS.has(row.agent_id)) continue;
      const gateway = GATEWAY_MAP[row.agent_id];
      if (!gateway) continue;
      const info: AgentInfo = {
        id: row.agent_id,
        atoms: row.atom_count,
        triples: tripleCounts.get(row.agent_id) ?? 0,
        gateway,
      };
      if (!grouped[gateway]) grouped[gateway] = [];
      grouped[gateway].push(info);
    }

    return grouped;
  } finally {
    await client.end();
  }
}
