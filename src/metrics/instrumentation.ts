import client from "prom-client";

const register = new client.Registry();
register.setDefaultLabels({ service: "msam" });

// ─── Gauges ─────────────────────────────────────────────────────

export const atomsTotal = new client.Gauge({
  name: "msam_atoms_total",
  help: "Total number of atoms by state, stream, and agent",
  labelNames: ["state", "stream", "agent_id"] as const,
  registers: [register],
});

export const triplesTotal = new client.Gauge({
  name: "msam_triples_total",
  help: "Total number of active triples",
  registers: [register],
});

// ─── Counters ───────────────────────────────────────────────────

export const atomsStoredTotal = new client.Counter({
  name: "msam_atoms_stored_total",
  help: "Total atoms stored since startup",
  registers: [register],
});

export const retrievalResultsTotal = new client.Counter({
  name: "msam_retrieval_results_total",
  help: "Total retrieval results by confidence tier",
  labelNames: ["confidence_tier"] as const,
  registers: [register],
});

export const decayTransitionsTotal = new client.Counter({
  name: "msam_decay_transitions_total",
  help: "Total decay state transitions",
  labelNames: ["from_state", "to_state"] as const,
  registers: [register],
});

export const apiRequestsTotal = new client.Counter({
  name: "msam_api_requests_total",
  help: "Total API requests",
  labelNames: ["method", "path", "status"] as const,
  registers: [register],
});

// ─── Histograms ─────────────────────────────────────────────────

export const retrievalDuration = new client.Histogram({
  name: "msam_retrieval_duration_seconds",
  help: "Retrieval operation duration in seconds",
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const embeddingDuration = new client.Histogram({
  name: "msam_embedding_duration_seconds",
  help: "Embedding operation duration in seconds",
  labelNames: ["provider"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const apiDuration = new client.Histogram({
  name: "msam_api_duration_seconds",
  help: "API request duration in seconds",
  labelNames: ["method", "path"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

// ─── Helper functions ───────────────────────────────────────────

export function incAtomStored(): void {
  atomsStoredTotal.inc();
}

export function observeRetrievalDuration(seconds: number): void {
  retrievalDuration.observe(seconds);
}

export function incRetrievalResult(tier: string): void {
  retrievalResultsTotal.inc({ confidence_tier: tier });
}

export function incDecayTransition(from: string, to: string): void {
  decayTransitionsTotal.inc({ from_state: from, to_state: to });
}

export function observeEmbeddingDuration(
  provider: string,
  seconds: number,
): void {
  embeddingDuration.observe({ provider }, seconds);
}

export function incApiRequest(
  method: string,
  path: string,
  status: number,
): void {
  apiRequestsTotal.inc({ method, path, status: String(status) });
}

export function observeApiDuration(
  method: string,
  path: string,
  seconds: number,
): void {
  apiDuration.observe({ method, path }, seconds);
}

export function setAtomsGauge(
  state: string,
  stream: string,
  agentId: string,
  value: number,
): void {
  atomsTotal.set({ state, stream, agent_id: agentId }, value);
}

export function setTriplesGauge(value: number): void {
  triplesTotal.set(value);
}

export async function metricsEndpoint(): Promise<string> {
  return register.metrics();
}

export function getRegister(): client.Registry {
  return register;
}
