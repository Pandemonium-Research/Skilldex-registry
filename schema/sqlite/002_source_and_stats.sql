-- 002 — provenance column, precomputed counts, and tag facets.
--
-- 001 was a single authored schema because there was no live database to migrate. There is one
-- now, so from here changes are numbered and additive. Do NOT edit 001: the live database was
-- created from it and scripts/corpus/build.ts reads it, so changing it makes the file a lie
-- about what production runs.
--
-- Motivation is in REGISTRY_BROWSE_REDESIGN_PLAN.md. In short: at 1.6M rows every orderable
-- column in `skills` is degenerate (99.7% share one published_at, 83% score 90-100, 33 rows
-- have any installs, 0.13% carry tags), and *all* of the surviving signal sits in the ~4,863
-- rows that came from watched repos rather than the import. Separating the two is what makes
-- the browse page both fast and meaningful.

-- --- provenance ---------------------------------------------------------------

-- Which pipeline put the row here.
--   'seeded'    — scripts/seed.ts, from a watched repo
--   'imported'  — the GitSkills corpus
--   'published' — POST /v1/skills by an authenticated publisher
--
-- This replaces `content_key IS NULL` as the curated/corpus discriminator. That test happens to
-- be correct today only because seed.ts does not set content_key — an accident of the import,
-- not a stated contract, and silently wrong the first time the seeder changes.
--
-- The 'seeded' default is correct for the live database, where every existing row is curated.
-- See the note at the bottom for applying this to a corpus-sized database, where running the
-- obvious UPDATE would be catastrophic.
ALTER TABLE skills ADD COLUMN source TEXT NOT NULL DEFAULT 'seeded'
  CHECK (source IN ('seeded', 'imported', 'published'));

-- Partial indexes for the curated browse surface. `WHERE source <> 'imported'` matches the
-- predicate the API sends for scope=curated, which is what lets the planner use them —
-- verified as `SCAN skills USING INDEX skills_curated_installs_idx` with no temp B-tree.
--
-- Partial over ~4.8k of 1.6M rows, so these cost kilobytes. That matters: 001 deliberately cut
-- skills_source_url_idx and skills_owner_idx (192 MB together) to stay under Turso's 2 GB
-- `--from-file` ceiling, and that ceiling is still binding.
CREATE INDEX skills_curated_installs_idx ON skills (install_count DESC) WHERE source <> 'imported';
CREATE INDEX skills_curated_recent_idx   ON skills (published_at  DESC) WHERE source <> 'imported';

-- --- precomputed counts --------------------------------------------------------

-- Aggregate counts, maintained out-of-band so no request path ever runs count(*).
--
-- `count(*) OVER ()` on the unfiltered listing took >90s at 1.6M rows and timed the endpoint
-- out entirely; COUNT(DISTINCT owner) is worse, since 001 cut skills_owner_idx. Both are fine
-- in a nightly batch and unacceptable in a request. See COUNTING_AT_SCALE.md.
--
-- Keys: skills_total, skills_curated, skills_imported, skills_verified,
--       skillsets_total, owners_total
CREATE TABLE registry_stats (
  key        TEXT PRIMARY KEY,
  value      INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- --- tag facets ----------------------------------------------------------------

-- Distinct tags with their skill counts, for the "browse by tag" surface.
--
-- Tags live in a JSON column and filtering walks them with json_each (D8 defers the normalised
-- table), which is a full scan by construction. Aggregating that nightly and serving a table
-- read is the cheap half of the problem; this is NOT the deferred skill_tags(tag, skill_id)
-- table, which D8 rejected against measured data and which would add index bytes we do not
-- have. Listing facets and filtering by them are different problems.
--
-- Populated from the curated tier only — all 2,106 tagged rows in the merged corpus are
-- curated, so this loses nothing and avoids a 1.6M-row json_each scan.
CREATE TABLE tag_counts (
  tag         TEXT PRIMARY KEY,
  skill_count INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
) WITHOUT ROWID;

-- --- applying this to a corpus-sized database -----------------------------------
--
-- ⚠ Do NOT run `UPDATE skills SET source='imported' WHERE content_key IS NOT NULL` against the
-- 1.6M-row database. `skills_au` fires per row and rewrites both FTS5 tables — 1.6M trigger
-- firings, for what is logically a bulk relabel.
--
-- Two safe paths, depending on whether the corpus is being rebuilt:
--
--   Rebuilding — scripts/corpus/build.ts sets source='imported' at INSERT time, before the FTS
--   triggers are created. Zero cost. This is the preferred path.
--
--   Patching an existing corpus DB — flip the default and update the small side instead:
--       ALTER TABLE skills ADD COLUMN source TEXT NOT NULL DEFAULT 'imported' CHECK (...);
--       UPDATE skills SET source = 'seeded' WHERE content_key IS NULL;   -- ~4,863 rows
--   Same end state, ~4.8k trigger firings instead of 1.6M.
--
-- ADD COLUMN with a constant default is a schema-only change in SQLite and does not rewrite
-- rows, so the ALTER itself is O(1) at any table size. It is only the UPDATE that must be kept
-- on the small side of the split.
