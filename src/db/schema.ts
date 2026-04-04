import {
  pgTable,
  text,
  integer,
  real,
  boolean,
  serial,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  customType,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// pgvector serialization helpers (exported for testing)
export function vectorToDriver(value: number[]): string {
  return `[${value.join(",")}]`;
}

export function vectorFromDriver(value: unknown): number[] {
  const str = String(value);
  return str
    .replace(/[\[\]]/g, "")
    .split(",")
    .map(Number);
}

// pgvector custom type
export const vector = customType<{
  data: number[];
  driverValue: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  toDriver: vectorToDriver,
  fromDriver: vectorFromDriver,
});

// ─── atoms ───

export const atoms = pgTable(
  "atoms",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").default(1),
    profile: text("profile", {
      enum: ["lightweight", "standard", "full"],
    }).default("standard"),
    stream: text("stream", {
      enum: ["working", "episodic", "semantic", "procedural"],
    }).default("semantic"),

    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    accessCount: integer("access_count").default(0),

    stability: real("stability").default(1.0),
    retrievability: real("retrievability").default(1.0),

    arousal: real("arousal").default(0.5),
    valence: real("valence").default(0.0),
    topics: jsonb("topics").default([]),
    encodingConfidence: real("encoding_confidence").default(0.7),
    provisional: boolean("provisional").default(false),
    sourceType: text("source_type").default("conversation"),

    state: text("state", {
      enum: ["active", "fading", "dormant", "tombstone"],
    }).default("active"),

    embedding: vector("embedding", { dimensions: 1536 }),

    metadata: jsonb("metadata").default({}),

    agentId: text("agent_id").default("default"),

    embeddingProvider: text("embedding_provider"),

    isPinned: boolean("is_pinned").default(false),
    sessionId: text("session_id"),
    workingExpiresAt: real("working_expires_at"),

    outcomeScore: real("outcome_score").default(0.0),
    outcomeCount: integer("outcome_count").default(0),
    lastOutcomeAt: timestamp("last_outcome_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_atoms_stream").on(t.stream),
    index("idx_atoms_state").on(t.state),
    index("idx_atoms_topics").on(t.topics),
    index("idx_atoms_created").on(t.createdAt),
    index("idx_atoms_agent").on(t.agentId),
    uniqueIndex("idx_atoms_dedup")
      .on(t.contentHash, t.agentId)
      .where(sql`state IN ('active', 'fading')`),
  ],
);

export type Atom = typeof atoms.$inferSelect;
export type NewAtom = typeof atoms.$inferInsert;

// ─── atom_topics ───

export const atomTopics = pgTable(
  "atom_topics",
  {
    atomId: text("atom_id")
      .notNull()
      .references(() => atoms.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.atomId, t.topic] }),
    index("idx_atom_topics_topic").on(t.topic),
  ],
);

export type AtomTopic = typeof atomTopics.$inferSelect;

// ─── access_log ───

export const accessLog = pgTable(
  "access_log",
  {
    id: serial("id").primaryKey(),
    atomId: text("atom_id")
      .notNull()
      .references(() => atoms.id, { onDelete: "cascade" }),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull(),
    activationScore: real("activation_score"),
    retrievalMode: text("retrieval_mode"),
    contributed: integer("contributed").default(-1),
  },
  (t) => [index("idx_access_log_atom").on(t.atomId)],
);

export type AccessLogEntry = typeof accessLog.$inferSelect;

// ─── corrections ───

export const corrections = pgTable("corrections", {
  id: text("id").primaryKey(),
  originalAtomId: text("original_atom_id")
    .notNull()
    .references(() => atoms.id, { onDelete: "cascade" }),
  correctionContent: text("correction_content").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export type Correction = typeof corrections.$inferSelect;

// ─── schema_version ───

export const schemaVersion = pgTable("schema_version", {
  version: integer("version").notNull(),
});

// ─── co_retrieval ───

export const coRetrieval = pgTable(
  "co_retrieval",
  {
    id: serial("id").primaryKey(),
    atomA: text("atom_a").notNull(),
    atomB: text("atom_b").notNull(),
    coCount: integer("co_count").default(1),
    lastCoRetrieval: timestamp("last_co_retrieval", {
      withTimezone: true,
    }).notNull(),
    sessionId: text("session_id"),
  },
  (t) => [
    uniqueIndex("uq_co_retrieval_pair").on(t.atomA, t.atomB),
    index("idx_co_ret_a").on(t.atomA),
    index("idx_co_ret_b").on(t.atomB),
  ],
);

export type CoRetrieval = typeof coRetrieval.$inferSelect;

// ─── negative_knowledge ───

export const negativeKnowledge = pgTable(
  "negative_knowledge",
  {
    id: serial("id").primaryKey(),
    query: text("query").notNull(),
    domain: text("domain"),
    result: text("result").default("empty"),
    searchedAt: timestamp("searched_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (t) => [index("idx_neg_query").on(t.query)],
);

export type NegativeKnowledge = typeof negativeKnowledge.$inferSelect;

// ─── provenance ───

export const provenance = pgTable(
  "provenance",
  {
    id: serial("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    parentType: text("parent_type"),
    parentId: text("parent_id"),
    action: text("action").notNull(),
    source: text("source"),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").default({}),
  },
  (t) => [
    index("idx_prov_entity").on(t.entityType, t.entityId),
    index("idx_prov_parent").on(t.parentType, t.parentId),
  ],
);

export type Provenance = typeof provenance.$inferSelect;

// ─── forgetting_log ───

export const forgettingLog = pgTable(
  "forgetting_log",
  {
    id: serial("id").primaryKey(),
    atomId: text("atom_id").notNull(),
    previousState: text("previous_state").notNull(),
    newState: text("new_state").notNull(),
    reason: text("reason").notNull(),
    factors: jsonb("factors").default({}),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("idx_forget_atom").on(t.atomId),
    index("idx_forget_ts").on(t.timestamp),
  ],
);

export type ForgettingLogEntry = typeof forgettingLog.$inferSelect;

// ─── atom_versions ───

export const atomVersions = pgTable(
  "atom_versions",
  {
    id: serial("id").primaryKey(),
    atomId: text("atom_id").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    changedBy: text("changed_by"),
    changeReason: text("change_reason"),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").default({}),
  },
  (t) => [
    index("idx_versions_atom").on(t.atomId),
    uniqueIndex("idx_versions_unique").on(t.atomId, t.version),
  ],
);

export type AtomVersion = typeof atomVersions.$inferSelect;

// ─── atom_relations ───

export const atomRelations = pgTable(
  "atom_relations",
  {
    id: serial("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    targetId: text("target_id").notNull(),
    relationType: text("relation_type").notNull(),
    confidence: real("confidence").default(0.8),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").default({}),
  },
  (t) => [
    uniqueIndex("uq_atom_relations").on(
      t.sourceId,
      t.targetId,
      t.relationType,
    ),
    index("idx_rel_source").on(t.sourceId),
    index("idx_rel_target").on(t.targetId),
    index("idx_rel_type").on(t.relationType),
  ],
);

export type AtomRelation = typeof atomRelations.$inferSelect;

// ─── retrieval_outcomes ───

export const retrievalOutcomes = pgTable(
  "retrieval_outcomes",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id"),
    atomIds: text("atom_ids").notNull(),
    query: text("query"),
    feedback: text("feedback", {
      enum: ["positive", "negative", "neutral", "silence"],
    }),
    feedbackAt: timestamp("feedback_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_outcomes_session").on(t.sessionId),
    index("idx_outcomes_feedback").on(t.feedback),
  ],
);

export type RetrievalOutcome = typeof retrievalOutcomes.$inferSelect;

// ─── temporal_patterns ───

export const temporalPatterns = pgTable(
  "temporal_patterns",
  {
    id: serial("id").primaryKey(),
    atomId: text("atom_id").notNull(),
    hourOfDay: integer("hour_of_day"),
    dayOfWeek: integer("day_of_week"),
    retrievalCount: integer("retrieval_count").default(1),
    lastRetrievedAt: timestamp("last_retrieved_at", {
      withTimezone: true,
    }).defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_temporal_patterns").on(
      t.atomId,
      t.hourOfDay,
      t.dayOfWeek,
    ),
    index("idx_temporal_atom").on(t.atomId),
    index("idx_temporal_time").on(t.hourOfDay, t.dayOfWeek),
  ],
);

export type TemporalPattern = typeof temporalPatterns.$inferSelect;

// ─── triples ───

export const triples = pgTable(
  "triples",
  {
    id: text("id").primaryKey(),
    atomId: text("atom_id")
      .notNull()
      .references(() => atoms.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    predicate: text("predicate").notNull(),
    object: text("object").notNull(),
    confidence: real("confidence").default(1.0),
    state: text("state", { enum: ["active", "tombstone"] }).default("active"),
    embedding: vector("embedding", { dimensions: 1536 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("idx_triples_subject").on(t.subject),
    index("idx_triples_predicate").on(t.predicate),
    index("idx_triples_object").on(t.object),
    index("idx_triples_atom").on(t.atomId),
    index("idx_triples_state").on(t.state),
  ],
);

export type Triple = typeof triples.$inferSelect;

// ─── sentence_embeddings ───

export const sentenceEmbeddings = pgTable(
  "sentence_embeddings",
  {
    atomId: text("atom_id").notNull(),
    sentenceIdx: integer("sentence_idx").notNull(),
    sentence: text("sentence").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    tokenCount: integer("token_count"),
  },
  (t) => [
    primaryKey({ columns: [t.atomId, t.sentenceIdx] }),
    index("idx_sentence_atom").on(t.atomId),
  ],
);

export type SentenceEmbedding = typeof sentenceEmbeddings.$inferSelect;

// ─── retrieval_feedback ───

export const retrievalFeedback = pgTable(
  "retrieval_feedback",
  {
    id: serial("id").primaryKey(),
    query: text("query").notNull(),
    atomId: text("atom_id").notNull(),
    retrievedRank: integer("retrieved_rank"),
    wasUsed: boolean("was_used"),
    similarity: real("similarity"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idx_feedback_atom").on(t.atomId)],
);

export type RetrievalFeedback = typeof retrievalFeedback.$inferSelect;

// ─── agents ───

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  metadata: jsonb("metadata"),
});

export type Agent = typeof agents.$inferSelect;

// ─── Drizzle relations ───

export const atomsRelations = relations(atoms, ({ many }) => ({
  topics: many(atomTopics),
  accessLogs: many(accessLog),
  corrections: many(corrections),
  triples: many(triples),
}));

export const atomTopicsRelations = relations(atomTopics, ({ one }) => ({
  atom: one(atoms, {
    fields: [atomTopics.atomId],
    references: [atoms.id],
  }),
}));

export const accessLogRelations = relations(accessLog, ({ one }) => ({
  atom: one(atoms, {
    fields: [accessLog.atomId],
    references: [atoms.id],
  }),
}));

export const correctionsRelations = relations(corrections, ({ one }) => ({
  atom: one(atoms, {
    fields: [corrections.originalAtomId],
    references: [atoms.id],
  }),
}));

export const triplesRelations = relations(triples, ({ one }) => ({
  atom: one(atoms, {
    fields: [triples.atomId],
    references: [atoms.id],
  }),
}));
