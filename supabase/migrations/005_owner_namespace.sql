-- Migration: owner/name namespace
--
-- Prerequisite for importing the GitSkills corpus (see FINDINGS.md). skills.name was
-- globally UNIQUE, but across the corpus 41.5% of candidate skills collide on bare name
-- (`skill-creator` alone is claimed by 433 distinct skills), so a bulk import would
-- silently discard two fifths of it with the winner decided by insert order. Scoping
-- uniqueness to (owner, name) drops collisions to 2.7%.
--
-- Nothing else changes. Search behaviour, ranking and trust tiers are untouched.
--
-- Run the whole file as one unit. Postgres DDL is transactional, and the danger of a
-- partial apply is specific: if UNIQUE (name) is dropped but UNIQUE (owner, name) then
-- fails, the table is left with no uniqueness on name at all. Run scripts/preflight-005.ts
-- first — it checks, read-only, for the two things that can make this fail.

BEGIN;

-- --- skills: owner namespace ------------------------------------------------

ALTER TABLE skills ADD COLUMN IF NOT EXISTS owner        text;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS display_name text;

-- Backfill. Rows written by scripts/seed.ts set author to the GitHub repo owner, so
-- they convert directly. Rows from POST /skills use `metadata.author ?? github_handle`
-- (src/routes/publish.ts), which may be a person's name rather than an account, so
-- prefer the owner segment of source_url and fall back to author.
UPDATE skills
SET owner = COALESCE(
      NULLIF(split_part(regexp_replace(source_url, '^https?://github\.com/', ''), '/', 1), ''),
      author
    )
WHERE owner IS NULL;

-- `name` is the URL slug; display_name preserves the authored name it was derived from.
-- 6.7% of imported names are not kebab-case (`video_frames`, `Code Review`, `GIF搜索器`),
-- so without this the authored form is destroyed by slugification.
UPDATE skills SET display_name = name WHERE display_name IS NULL;

-- Anything still null has neither a GitHub source_url nor an author and cannot be
-- namespaced; surface it rather than silently dropping it.
DO $$
DECLARE orphans integer;
BEGIN
  SELECT count(*) INTO orphans FROM skills WHERE owner IS NULL OR owner = '';
  IF orphans > 0 THEN
    RAISE EXCEPTION 'Cannot set skills.owner NOT NULL: % row(s) have no derivable owner. '
                    'Inspect: SELECT id, name, author, source_url FROM skills '
                    'WHERE owner IS NULL OR owner = %L;', orphans, '';
  END IF;
END $$;

ALTER TABLE skills ALTER COLUMN owner SET NOT NULL;

-- The global name constraint is created unnamed by 001 (text NOT NULL UNIQUE), so
-- Postgres names it skills_name_key. Drop defensively in case it was named otherwise.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'skills'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (name)'
  LOOP
    EXECUTE format('ALTER TABLE skills DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE skills ADD CONSTRAINT skills_owner_name_key UNIQUE (owner, name);

-- --- skills: byte-dedup identity ---------------------------------------------

-- content_key is the SHA of the SKILL.md bytes, taken from the GitSkills dataset's own
-- file_sha grouping. No normalization: two rows share a key only if their contents are
-- byte-identical. One registry entry per distinct content, and re-import is idempotent.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS content_key text;
CREATE UNIQUE INDEX IF NOT EXISTS skills_content_key_key
  ON skills (content_key) WHERE content_key IS NOT NULL;

-- Bare-name lookup for CLI builds predating the owner namespace (getSkillByBareName).
-- Dropping UNIQUE (name) took its btree with it. 001 also creates skills_name_trgm_idx,
-- but that is GIN/gin_trgm_ops for fuzzy matching and does not serve equality.
CREATE INDEX IF NOT EXISTS skills_name_lookup_idx ON skills (name);

COMMIT;
