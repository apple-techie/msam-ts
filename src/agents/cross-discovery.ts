import pg from "pg";

export interface CrossDiscoveryConfig {
  enabled: boolean;
  groups: Array<{ name: string; agents: string[] }>;
  bridges: Array<{ from: string; to: string; mode: "entities-only" | "full" | "off" }>;
}

export interface SharedEntity {
  entity: string;
  agents: string[];
  groups: string[];
}

export interface CrossAgentTriple {
  subject: string;
  predicate: string;
  object: string;
  sourceAgents: string[];
  bridgeName: string;
  confidence: number;
}

export interface DiscoveryResult {
  sharedEntities: SharedEntity[];
  crossTriples: CrossAgentTriple[];
  groupStats: Record<string, number>;
}

function findGroupForAgent(agentId: string, config: CrossDiscoveryConfig): string | null {
  for (const group of config.groups) {
    if (group.agents.includes(agentId)) return group.name;
  }
  return null;
}

function findBridge(
  groupA: string,
  groupB: string,
  config: CrossDiscoveryConfig,
): { from: string; to: string; mode: "entities-only" | "full" | "off" } | null {
  for (const bridge of config.bridges) {
    if (
      (bridge.from === groupA && bridge.to === groupB) ||
      (bridge.from === groupB && bridge.to === groupA)
    ) {
      return bridge;
    }
  }
  return null;
}

export function getVisibleAgents(agentId: string, config: CrossDiscoveryConfig): string[] {
  if (!config.enabled) return [agentId];

  const group = findGroupForAgent(agentId, config);
  if (!group) return [agentId];

  const myGroup = config.groups.find((g) => g.name === group)!;
  const visible = new Set<string>(myGroup.agents);

  for (const bridge of config.bridges) {
    if (bridge.mode === "off") continue;

    let targetGroupName: string | null = null;
    if (bridge.from === group) targetGroupName = bridge.to;
    else if (bridge.to === group) targetGroupName = bridge.from;
    if (!targetGroupName) continue;

    const targetGroup = config.groups.find((g) => g.name === targetGroupName);
    if (targetGroup) {
      for (const a of targetGroup.agents) visible.add(a);
    }
  }

  return Array.from(visible);
}

export function getDiscoveryMode(
  agentA: string,
  agentB: string,
  config: CrossDiscoveryConfig,
): "full" | "entities-only" | "off" {
  if (!config.enabled) return "off";
  if (agentA === agentB) return "full";

  const groupA = findGroupForAgent(agentA, config);
  const groupB = findGroupForAgent(agentB, config);

  if (!groupA || !groupB) return "off";
  if (groupA === groupB) return "full";

  const bridge = findBridge(groupA, groupB, config);
  if (!bridge) return "off";
  return bridge.mode;
}

export async function discoverSharedEntities(
  dbUrl: string,
  config: CrossDiscoveryConfig,
): Promise<SharedEntity[]> {
  if (!config.enabled || config.groups.length === 0) return [];

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const allAgents = new Set<string>();
    for (const group of config.groups) {
      for (const a of group.agents) allAgents.add(a);
    }

    if (allAgents.size === 0) return [];

    const agentList = Array.from(allAgents);
    const placeholders = agentList.map((_, i) => `$${i + 1}`).join(", ");

    const subjectResult = await client.query(
      `SELECT t.subject AS entity, a.agent_id
       FROM triples t
       JOIN atoms a ON t.atom_id = a.id
       WHERE a.agent_id IN (${placeholders})
         AND (t.state IS NULL OR t.state = 'active')
         AND a.state = 'active'
       GROUP BY t.subject, a.agent_id`,
      agentList,
    );

    const objectResult = await client.query(
      `SELECT t.object AS entity, a.agent_id
       FROM triples t
       JOIN atoms a ON t.atom_id = a.id
       WHERE a.agent_id IN (${placeholders})
         AND (t.state IS NULL OR t.state = 'active')
         AND a.state = 'active'
       GROUP BY t.object, a.agent_id`,
      agentList,
    );

    const entityAgentMap = new Map<string, Set<string>>();

    for (const row of [...subjectResult.rows, ...objectResult.rows]) {
      const entity = row.entity as string;
      const agentId = row.agent_id as string;
      if (!entityAgentMap.has(entity)) entityAgentMap.set(entity, new Set());
      entityAgentMap.get(entity)!.add(agentId);
    }

    const shared: SharedEntity[] = [];

    for (const [entity, agentSet] of entityAgentMap) {
      if (agentSet.size < 2) continue;

      const agents = Array.from(agentSet);
      const groups = new Set<string>();
      for (const a of agents) {
        const g = findGroupForAgent(a, config);
        if (g) groups.add(g);
      }

      const groupList = Array.from(groups);
      if (groupList.length === 0) continue;

      if (groupList.length === 1) {
        shared.push({ entity, agents, groups: groupList });
        continue;
      }

      let anyVisible = false;
      for (let i = 0; i < groupList.length && !anyVisible; i++) {
        for (let j = i + 1; j < groupList.length && !anyVisible; j++) {
          const bridge = findBridge(groupList[i], groupList[j], config);
          if (bridge && bridge.mode !== "off") anyVisible = true;
        }
      }

      if (anyVisible) {
        shared.push({ entity, agents, groups: groupList });
      }
    }

    return shared;
  } finally {
    await client.end();
  }
}

interface TripleRow {
  subject: string;
  predicate: string;
  object: string;
  agent_id: string;
  confidence: number;
}

export async function synthesizeCrossAgentTriples(
  dbUrl: string,
  config: CrossDiscoveryConfig,
): Promise<CrossAgentTriple[]> {
  if (!config.enabled) return [];

  const fullBridges = config.bridges.filter((b) => b.mode === "full");
  if (fullBridges.length === 0) return [];

  const sharedEntities = await discoverSharedEntities(dbUrl, config);
  if (sharedEntities.length === 0) return [];

  const crossGroupEntities = sharedEntities.filter((e) => e.groups.length > 1);
  if (crossGroupEntities.length === 0) return [];

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const crossTriples: CrossAgentTriple[] = [];

    for (const sharedEntity of crossGroupEntities) {
      const bridgedGroupPairs: Array<{ groupA: string; groupB: string; bridgeName: string }> = [];
      for (let i = 0; i < sharedEntity.groups.length; i++) {
        for (let j = i + 1; j < sharedEntity.groups.length; j++) {
          const bridge = findBridge(sharedEntity.groups[i], sharedEntity.groups[j], config);
          if (bridge && bridge.mode === "full") {
            bridgedGroupPairs.push({
              groupA: sharedEntity.groups[i],
              groupB: sharedEntity.groups[j],
              bridgeName: `${bridge.from}->${bridge.to}`,
            });
          }
        }
      }

      if (bridgedGroupPairs.length === 0) continue;

      const result = await client.query<TripleRow>(
        `SELECT t.subject, t.predicate, t.object, a.agent_id, t.confidence
         FROM triples t
         JOIN atoms a ON t.atom_id = a.id
         WHERE (t.subject = $1 OR t.object = $1)
           AND (t.state IS NULL OR t.state = 'active')
           AND a.state = 'active'`,
        [sharedEntity.entity],
      );

      for (const pair of bridgedGroupPairs) {
        const groupADef = config.groups.find((g) => g.name === pair.groupA);
        const groupBDef = config.groups.find((g) => g.name === pair.groupB);
        if (!groupADef || !groupBDef) continue;

        const groupAAgents = new Set(groupADef.agents);
        const groupBAgents = new Set(groupBDef.agents);

        const triplesA = result.rows.filter((r) => groupAAgents.has(r.agent_id));
        const triplesB = result.rows.filter((r) => groupBAgents.has(r.agent_id));

        for (const tA of triplesA) {
          for (const tB of triplesB) {
            if (tA.predicate === tB.predicate) continue;

            const otherA = tA.subject === sharedEntity.entity ? tA.object : tA.subject;
            const otherB = tB.subject === sharedEntity.entity ? tB.object : tB.subject;

            if (otherA === otherB) continue;

            crossTriples.push({
              subject: otherA,
              predicate: `relates_to_via_${sharedEntity.entity}`,
              object: otherB,
              sourceAgents: [tA.agent_id, tB.agent_id],
              bridgeName: pair.bridgeName,
              confidence: Math.min(tA.confidence, tB.confidence) * 0.7,
            });
          }
        }
      }
    }

    const seen = new Set<string>();
    const deduplicated: CrossAgentTriple[] = [];
    for (const t of crossTriples) {
      const key = `${t.subject}|${t.predicate}|${t.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduplicated.push(t);
    }

    return deduplicated;
  } finally {
    await client.end();
  }
}

export async function runCrossAgentDiscovery(
  dbUrl: string,
  config: CrossDiscoveryConfig,
): Promise<DiscoveryResult> {
  if (!config.enabled) {
    return { sharedEntities: [], crossTriples: [], groupStats: {} };
  }

  const sharedEntities = await discoverSharedEntities(dbUrl, config);
  const crossTriples = await synthesizeCrossAgentTriples(dbUrl, config);

  const groupStats: Record<string, number> = {};
  for (const group of config.groups) {
    groupStats[group.name] = sharedEntities.filter((e) =>
      e.groups.includes(group.name),
    ).length;
  }

  return { sharedEntities, crossTriples, groupStats };
}
