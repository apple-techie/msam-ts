-- Functional case-insensitive indexes powering graphTraverse / graphPath.
-- Must match the lower() expression used in src/knowledge/triples.ts.

CREATE INDEX IF NOT EXISTS idx_triples_subject_lower ON triples (lower(subject));
CREATE INDEX IF NOT EXISTS idx_triples_object_lower  ON triples (lower(object));

-- Partial index limits bloat: we only ever query active rows.
CREATE INDEX IF NOT EXISTS idx_triples_active_subject_lower
  ON triples (lower(subject)) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_triples_active_object_lower
  ON triples (lower(object))  WHERE state = 'active';

ANALYZE triples;
