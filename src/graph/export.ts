import {
  exportAgentTriples,
  GATEWAY_MAP,
  GATEWAY_ORDER,
  EXCLUDE_AGENTS,
} from "../agents/registry.js";

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
