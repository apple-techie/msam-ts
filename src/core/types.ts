export type AtomStream = "semantic" | "episodic" | "procedural" | "working";
export type AtomProfile = "lightweight" | "standard" | "full";
export type AtomState = "active" | "fading" | "dormant" | "tombstone";
export type ConfidenceTier = "high" | "medium" | "low" | "none";
export type SourceType = "conversation" | "inference" | "correction" | "external";
export type RetrievalMode = "task" | "companion";

export interface Atom {
  id: string;
  schemaVersion: number;
  profile: AtomProfile;
  stream: AtomStream;
  content: string;
  contentHash: string;
  createdAt: Date;
  lastAccessedAt: Date | null;
  accessCount: number;
  stability: number;
  retrievability: number;
  arousal: number;
  valence: number;
  topics: string[];
  encodingConfidence: number;
  provisional: boolean;
  sourceType: SourceType;
  state: AtomState;
  embedding: number[] | null;
  metadata: Record<string, unknown>;
  agentId: string;
  embeddingProvider: string | null;
  isPinned: boolean;
  sessionId: string | null;
  workingExpiresAt: number | null;
  outcomeScore: number;
  outcomeCount: number;
  lastOutcomeAt: Date | null;
}

export interface Triple {
  id: string;
  atomId: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  state: "active" | "tombstone";
  embedding: number[] | null;
  createdAt: Date;
}

export interface AccessLogEntry {
  id: number;
  atomId: string;
  accessedAt: Date;
  activationScore: number | null;
  retrievalMode: RetrievalMode | null;
  contributed: -1 | 0 | 1;
}

export interface Correction {
  id: string;
  originalAtomId: string;
  correctionContent: string;
  reason: string | null;
  createdAt: Date;
}

export interface ActivationParams {
  accessCount: number;
  createdAt: Date;
  querySimilarity: number;
  mode: RetrievalMode;
  arousal: number;
  valence: number;
  encodingConfidence: number;
  stability: number;
  provisional: boolean;
  outcomeCount: number;
  outcomeScore: number;
  config?: ActivationConfig;
}

export interface ActivationConfig {
  baseActivationCap: number;
  similarityThreshold: number;
  sigmoidMidpoint: number;
  sigmoidSteepness: number;
  spreadWeight: number;
  outcomeWeight: number;
  minOutcomesForEffect: number;
}

export interface DecayConfig {
  activeToFadingThreshold: number;
  fadingToDormantThreshold: number;
  reactivationThreshold: number;
  reactivationMinAccess: number;
  stabilityBoostFactor: number;
  maxStability: number;
  protectionDays: number;
}

export interface RetrievalResult {
  atom: Atom;
  activation: number;
  similarity: number;
  confidenceTier: ConfidenceTier;
  spreadBoost?: number;
}

export const DEFAULT_ACTIVATION_CONFIG: ActivationConfig = {
  baseActivationCap: 3.0,
  similarityThreshold: 0.2,
  sigmoidMidpoint: 0.35,
  sigmoidSteepness: 15.0,
  spreadWeight: 6.0,
  outcomeWeight: 0.15,
  minOutcomesForEffect: 3,
};

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  activeToFadingThreshold: 0.3,
  fadingToDormantThreshold: 0.1,
  reactivationThreshold: 0.5,
  reactivationMinAccess: 2,
  stabilityBoostFactor: 1.1,
  maxStability: 10.0,
  protectionDays: 7,
};
