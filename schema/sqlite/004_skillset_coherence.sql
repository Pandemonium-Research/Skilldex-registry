-- 004 — skillset coherence, stored alongside conformance.
--
-- `skillsets.score` is structural conformance: is this skillset well-formed. It cannot express
-- agreement *between* members, which is the property skillsets exist to provide — conventions
-- live in one shared asset so independently authored members cannot drift apart. Coherence is
-- that second dimension, computed by src/validator/skillset-coherence.ts at publish time.
--
-- The two are deliberately NOT combined into one number. Folding coherence into `score` would
-- let a high aggregate hide a contradiction, which is the exact failure the split exists to
-- surface. skilldex's validator makes the same choice, in the same words.
--
-- WHY THERE IS NO coherence_score COLUMN
-- The validators do not produce a 0-100 coherence figure and inventing one here would be a
-- number no implementation agrees on. What they produce is a ratio — how many members were
-- checked, and how many came through with no warning and no error — plus the diagnostics behind
-- it. Both halves are stored: the counts so the result is sortable and filterable, the JSON so
-- the API can explain *why* a skillset scored what it did rather than only that it did.
--
-- No backfill: `skillsets` is empty at the time this is applied, so every column is NULL-able
-- and rows published from here carry values. A NULL means "never checked", which is honestly
-- different from "checked and found incoherent" (that is 0).

ALTER TABLE skillsets ADD COLUMN members_checked INTEGER
  CHECK (members_checked IS NULL OR members_checked >= 0);

ALTER TABLE skillsets ADD COLUMN members_coherent INTEGER
  CHECK (members_coherent IS NULL OR members_coherent >= 0);

-- The full SkillsetCoherenceResult: declaredConventions, diagnostics, and the pass/warn/error
-- tallies. Shaped by the validator, not by this schema, so a new check type does not need a
-- migration to become visible in the API.
ALTER TABLE skillsets ADD COLUMN coherence TEXT
  CHECK (coherence IS NULL OR json_valid(coherence));

-- Sortable, filterable percentage derived from the counts, so ORDER BY and a min-coherence
-- filter need no application arithmetic and cannot disagree with the stored counts.
--
-- VIRTUAL, not STORED: SQLite refuses `ALTER TABLE ... ADD COLUMN ... STORED` outright once the
-- table exists ("cannot add a STORED column"), and a virtual column is still indexable and
-- orderable. The expression is integer division on two small integers, so computing it per row
-- costs nothing worth measuring.
--
-- NULL when nothing was checked — a skillset with no embedded members has no coherence to
-- report, which is not the same as scoring zero. Integer division truncates: 2 of 3 reads 66.
ALTER TABLE skillsets ADD COLUMN coherence_pct INTEGER
  GENERATED ALWAYS AS (
    CASE WHEN members_checked > 0
      THEN (members_coherent * 100) / members_checked
      ELSE NULL
    END
  ) VIRTUAL;

CREATE INDEX IF NOT EXISTS idx_skillsets_coherence_pct ON skillsets (coherence_pct);

-- NOTE ON spec_version: skillsets published from here declare "1.1", the revision that adds
-- coherence. The column default stays "1.0" because changing a default in SQLite means
-- rebuilding the table, and nothing relies on it — every insert path sets spec_version
-- explicitly (src/routes/skillsets-publish.ts).
