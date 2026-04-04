import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq, sql, count, and, gte, lte } from "drizzle-orm";
import { getDb } from "./db/connection.js";
import { atoms, triples } from "./db/schema.js";
import { metricsEndpoint } from "./metrics/instrumentation.js";

interface GrafanaQueryTarget {
  target: string;
  type?: string;
}

interface GrafanaQueryBody {
  targets: GrafanaQueryTarget[];
  range?: { from: string; to: string };
  maxDataPoints?: number;
}

const GRAFANA_TARGETS = [
  "system_total_atoms",
  "system_active_atoms",
  "system_fading_atoms",
  "system_dormant_atoms",
  "stream_semantic",
  "stream_episodic",
  "stream_procedural",
  "stream_working",
  "triple_total_count",
  "triple_unique_subjects",
  "triple_unique_predicates",
  "pinned_atom_count",
  "working_memory_count",
  "agent_atom_counts",
] as const;

async function queryTarget(target: string): Promise<number> {
  const db = getDb();

  switch (target) {
    case "system_total_atoms": {
      const [r] = await db.select({ c: count() }).from(atoms);
      return r.c;
    }
    case "system_active_atoms": {
      const [r] = await db
        .select({ c: count() })
        .from(atoms)
        .where(eq(atoms.state, "active"));
      return r.c;
    }
    case "system_fading_atoms": {
      const [r] = await db
        .select({ c: count() })
        .from(atoms)
        .where(eq(atoms.state, "fading"));
      return r.c;
    }
    case "system_dormant_atoms": {
      const [r] = await db
        .select({ c: count() })
        .from(atoms)
        .where(eq(atoms.state, "dormant"));
      return r.c;
    }
    case "stream_semantic": {
      const [r] = await db
        .select({ c: count() })
        .from(atoms)
        .where(and(eq(atoms.stream, "semantic"), eq(atoms.state, "active")));
      return r.c;
    }
    case "stream_episodic": {
      const [r] = await db
        .select({ c: count() })
        .from(atoms)
        .where(and(eq(atoms.stream, "episodic"), eq(atoms.state, "active")));
      return r.c;
    }
    case "stream_procedural": {
      const [r] = await db
        .select({ c: count() })
        .from(atoms)
        .where(and(eq(atoms.stream, "procedural"), eq(atoms.state, "active")));
      return r.c;
    }
    case "stream_working": {
      const [r] = await db
        .select({ c: count() })
        .from(atoms)
        .where(and(eq(atoms.stream, "working"), eq(atoms.state, "active")));
      return r.c;
    }
    case "triple_total_count": {
      const [r] = await db
        .select({ c: count() })
        .from(triples)
        .where(eq(triples.state, "active"));
      return r.c;
    }
    case "triple_unique_subjects": {
      const r = await db.execute(
        sql`SELECT COUNT(DISTINCT subject) AS c FROM triples WHERE state = 'active'`,
      );
      return Number((r.rows[0] as Record<string, unknown>)?.c ?? 0);
    }
    case "triple_unique_predicates": {
      const r = await db.execute(
        sql`SELECT COUNT(DISTINCT predicate) AS c FROM triples WHERE state = 'active'`,
      );
      return Number((r.rows[0] as Record<string, unknown>)?.c ?? 0);
    }
    case "pinned_atom_count": {
      const [r] = await db
        .select({ c: count() })
        .from(atoms)
        .where(eq(atoms.isPinned, true));
      return r.c;
    }
    case "working_memory_count": {
      const [r] = await db
        .select({ c: count() })
        .from(atoms)
        .where(and(eq(atoms.stream, "working"), eq(atoms.state, "active")));
      return r.c;
    }
    default:
      return 0;
  }
}

export async function registerMetricsApi(
  app: FastifyInstance,
): Promise<void> {
  // Grafana connectivity test
  app.get("/grafana/", async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send("ok");
  });

  // Grafana search: return available targets
  app.post(
    "/grafana/search",
    async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.send([...GRAFANA_TARGETS]);
    },
  );

  // Grafana query: return time-series data
  app.post(
    "/grafana/query",
    async (
      req: FastifyRequest<{ Body: GrafanaQueryBody }>,
      reply: FastifyReply,
    ) => {
      const body = req.body;
      const targets = body.targets ?? [];
      const now = Date.now();

      const results: Array<Record<string, unknown>> = [];

      for (const t of targets) {
        const value = await queryTarget(t.target);
        results.push({
          target: t.target,
          datapoints: [[value, now]],
        });
      }

      return reply.send(results);
    },
  );

  // Grafana annotations (stub)
  app.post(
    "/grafana/annotations",
    async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.send([]);
    },
  );

  // Prometheus metrics endpoint
  app.get("/metrics", async (_req: FastifyRequest, reply: FastifyReply) => {
    const text = await metricsEndpoint();
    return reply.type("text/plain; version=0.0.4").send(text);
  });
}
