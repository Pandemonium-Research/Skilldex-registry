-- D13 naming: decide what every imported skill is called, before anything is written.
--
-- Deterministic and order-independent by construction. Re-running over the same corpus
-- produces identical names, which matters because these become URLs.
--
--   uncontested                        -> bare slug
--   contested, one shared description  -> lowest file_sha keeps the bare slug, rest suffixed
--   contested, descriptions differ     -> every member suffixed, bare name left ambiguous
--
-- See REGISTRY_MIGRATION_DECISIONS.md D13 and FINDINGS §2.

CREATE OR REPLACE TABLE gated AS
SELECT
  split_part(repo_full_name, '/', 1) AS owner,
  repo_full_name,
  path,
  file_sha,
  name        AS display_name,
  description,
  -- Mirrors slugifySkillName in src/types/skill.ts, including its fallback: a name with no
  -- ASCII alphanumerics slugifies to nothing and becomes skill-<first 8 of the content key>.
  CASE
    WHEN slug <> '' THEN slug
    ELSE 'skill-' || substr(lower(regexp_replace(file_sha, '[^a-zA-Z0-9]', '', 'g')), 1, 8)
  END AS slug
FROM (
  SELECT *,
    -- The trailing regexp_replace is not redundant: truncating to 100 can *reintroduce* a
    -- trailing hyphen, which would make the slug fail createSkillSchema. slugifySkillName
    -- does the same thing with .slice(0, 100).replace(/-$/, "").
    regexp_replace(
      substr(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(lower(coalesce(name, '')), '[\s_]+', '-', 'g'),
            '[^a-z0-9-]', '', 'g'),
          '-+', '-', 'g'),
        '^-|-$', '', 'g'),
      1, 100),
    '-+$', '', 'g') AS slug
  FROM read_parquet(getvariable('artifact_glob'))
  WHERE dedup_primary = 1
    AND frontmatter_valid = 1
    AND filename = 'SKILL.md'
);

-- One row per (owner, slug) group, carrying the two facts D13 branches on.
CREATE OR REPLACE TABLE groups AS
SELECT owner, slug,
       count(DISTINCT file_sha)    AS contents,
       count(DISTINCT description) AS descs,
       min(file_sha)               AS canonical_sha
FROM gated
GROUP BY 1, 2;

-- The final name for every distinct content.
CREATE OR REPLACE TABLE naming AS
SELECT
  g.owner,
  g.repo_full_name,
  g.path,
  g.file_sha,
  g.display_name,
  g.description,
  g.slug AS base_slug,
  CASE
    WHEN grp.contents = 1 THEN g.slug
    WHEN grp.descs = 1 AND g.file_sha = grp.canonical_sha THEN g.slug
    -- 91 + '-' + 8 keeps the result inside the 100-character limit; the trailing-hyphen
    -- strip is needed again because truncating to 91 can reintroduce one.
    ELSE regexp_replace(substr(g.slug, 1, 91), '-+$', '', 'g')
         || '-' || substr(lower(g.file_sha), 1, 8)
  END AS final_slug,
  CASE
    WHEN grp.contents = 1 THEN 'uncontested'
    WHEN grp.descs = 1 AND g.file_sha = grp.canonical_sha THEN 'canonical'
    WHEN grp.descs = 1 THEN 'duplicate-suffixed'
    ELSE 'distinct-suffixed'
  END AS naming_case
FROM gated g
JOIN groups grp USING (owner, slug);
