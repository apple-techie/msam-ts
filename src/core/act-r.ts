import type {
  ActivationConfig,
  ActivationParams,
  AtomState,
  DecayConfig,
} from "./types.js";
import { DEFAULT_ACTIVATION_CONFIG, DEFAULT_DECAY_CONFIG } from "./types.js";

const HOURS_PER_WEEK = 168;

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0.0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const norm = Math.sqrt(normA) * Math.sqrt(normB);
  return norm > 0 ? dot / norm : 0.0;
}

export function sigmoidBoost(
  x: number,
  midpoint: number = DEFAULT_ACTIVATION_CONFIG.sigmoidMidpoint,
  steepness: number = DEFAULT_ACTIVATION_CONFIG.sigmoidSteepness,
): number {
  return 1.0 / (1.0 + Math.exp(-steepness * (x - midpoint)));
}

export function calculateBaseLevelActivation(
  accessCount: number,
  ageHours: number,
  cap: number = DEFAULT_ACTIVATION_CONFIG.baseActivationCap,
): number {
  const frequency = Math.min(Math.log(accessCount + 1), cap);
  const recency = 0.5 * Math.log(Math.max(ageHours, 0.01) + 1);
  return frequency - recency;
}

export function calculateSpreadingActivation(
  sourceActivations: number[],
  weights: number[],
): number {
  if (sourceActivations.length !== weights.length) {
    throw new Error("sourceActivations and weights must have equal length");
  }
  let total = 0;
  for (let i = 0; i < sourceActivations.length; i++) {
    total += sourceActivations[i] * weights[i];
  }
  return total;
}

export function calculateRetrievability(
  stability: number,
  elapsedSeconds: number,
): number {
  const ageHours = Math.max(elapsedSeconds / 3600, 0.01);
  const s = Math.max(stability, 0.01);
  return Math.exp(-ageHours / (s * HOURS_PER_WEEK));
}

export function calculateStability(
  currentStability: number,
  boostFactor: number = DEFAULT_DECAY_CONFIG.stabilityBoostFactor,
  maxStability: number = DEFAULT_DECAY_CONFIG.maxStability,
): number {
  return Math.min(currentStability * boostFactor, maxStability);
}

export function calculateActivation(params: ActivationParams): number {
  const cfg = { ...DEFAULT_ACTIVATION_CONFIG, ...params.config };

  const now = new Date();
  const ageHours = Math.max(
    (now.getTime() - params.createdAt.getTime()) / 3_600_000,
    0.01,
  );

  const base = calculateBaseLevelActivation(
    params.accessCount,
    ageHours,
    cfg.baseActivationCap,
  );

  let similarity: number;
  if (params.querySimilarity < cfg.similarityThreshold) {
    similarity = 0.0;
  } else {
    similarity =
      sigmoidBoost(params.querySimilarity, cfg.sigmoidMidpoint, cfg.sigmoidSteepness) *
      cfg.spreadWeight;
  }

  let annotationBoost: number;
  if (params.mode === "companion") {
    annotationBoost = params.arousal * 0.8 + Math.abs(params.valence) * 0.4;
  } else {
    annotationBoost = params.encodingConfidence * 0.3 - params.arousal * 0.1;
  }

  const retrievability = Math.exp(-ageHours / (Math.max(params.stability, 0.01) * HOURS_PER_WEEK));
  const stabilityFactor = retrievability * 0.3;

  if (params.provisional) {
    annotationBoost -= 0.2;
  }

  let outcomeBonus = 0.0;
  if (params.outcomeCount >= cfg.minOutcomesForEffect) {
    const normalized =
      Math.max(-5.0, Math.min(5.0, params.outcomeScore)) /
      Math.max(params.outcomeCount, 1);
    outcomeBonus = cfg.outcomeWeight * normalized;
  }

  return base + similarity + annotationBoost + stabilityFactor + outcomeBonus;
}

export function shouldTransitionState(
  retrievability: number,
  currentState: AtomState,
  accessCount: number,
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
): AtomState | null {
  if (currentState === "active" && retrievability < config.activeToFadingThreshold) {
    return "fading";
  }

  if (currentState === "fading") {
    if (retrievability < config.fadingToDormantThreshold) {
      return "dormant";
    }
    if (
      retrievability >= config.reactivationThreshold &&
      accessCount >= config.reactivationMinAccess
    ) {
      return "active";
    }
  }

  return null;
}

export function classifyConfidenceTier(
  maxSimilarity: number,
  topScore: number,
  simHigh: number = 0.45,
  simMedium: number = 0.30,
  simLow: number = 0.15,
  scoreHigh: number = 40.0,
  scoreMedium: number = 10.0,
): "high" | "medium" | "low" | "none" {
  const hasSemanticSignal = maxSimilarity >= 0.20;

  if (maxSimilarity >= simHigh || (hasSemanticSignal && topScore >= scoreHigh)) {
    return "high";
  }
  if (maxSimilarity >= simMedium || (hasSemanticSignal && topScore >= scoreMedium)) {
    return "medium";
  }
  if (maxSimilarity >= simLow) {
    return "low";
  }
  return "none";
}
