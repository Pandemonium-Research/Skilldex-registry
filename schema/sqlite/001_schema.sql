-- Skilldex registry — SQLite/Turso schema
--
-- A single authored schema, not a port of supabase/migrations/001-005. There is no SQLite
-- database to migrate from, so replaying that history would only re-enact it; the end state is
-- what matters. See REGISTRY_MIGRATION_DECISIONS.md (D4).
--
-- Note this includes `skillsets`, which 004 never applied to Supabase — the cause of the 500s
-- on every /skillsets/* route. A freshly authored schema cannot carry that bug forward.
--
-- From here on, schema changes DO need numbered migrations: there is now a live database.
--
-- Type mapping from the Postgres original:
--   uuid          -> TEXT   (same UUID string the API already returns; D7)
--   timestamptz   -> TEXT   (ISO-8601 UTC, which is what PostgREST serialised anyway)
--   boolean       -> INTEGER 0/1  (the data layer converts; SQLite has no boolean)
--   text[]        -> TEXT   (JSON array, queried with json_each; D8)
--   jsonb         -> TEXT   (JSON)
--
-- Foreign keys are OFF by default in SQLite. The client MUST issue `PRAGMA foreign_keys = ON`
-- per connection or `published_by` is decorative.

PRAGMA foreign_keys = ON;

-- --- publishers --------------------------------------------------------------

CREATE TABLE publishers (
  id            TEXT PRIMARY KEY,
  github_handle TEXT NOT NULL UNIQUE,
  email         TEXT,
  verified      INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- --- skills ------------------------------------------------------------------

CREATE TABLE skills (
  -- seq is an explicit rowid alias. The FTS5 tables below use content='skills' and bind to
  -- the content table's rowid; a table whose only key is TEXT has a *hidden* rowid, and
  -- VACUUM may renumber hidden rowids, silently breaking the index-to-row mapping. Declaring
  -- INTEGER PRIMARY KEY makes the rowid a real, stable column. Never exposed by the API. (D6)
  seq           INTEGER PRIMARY KEY,

  id            TEXT NOT NULL UNIQUE,
  -- URL slug, unique within an owner — not globally. Bare name collides on 41.5% of the
  -- corpus, which is why uniqueness is scoped to (owner, name).
  name          TEXT NOT NULL,
  -- The authored name before slugification. 6.7% of imported names are not kebab-case.
  display_name  TEXT,
  owner         TEXT NOT NULL,
  description   TEXT NOT NULL,
  author        TEXT,
  source_url    TEXT NOT NULL,
  trust_tier    TEXT NOT NULL CHECK (trust_tier IN ('verified', 'community')),
  score         INTEGER CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
  spec_version  TEXT NOT NULL DEFAULT '1.0',
  tags          TEXT CHECK (tags IS NULL OR json_valid(tags)),
  install_count INTEGER NOT NULL DEFAULT 0,
  -- SHA of the SKILL.md bytes for imported skills; null for hand-published ones.
  content_key   TEXT,
  published_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_by  TEXT REFERENCES publishers(id),

  UNIQUE (owner, name)
);

-- One registry entry per distinct content, so re-import is idempotent. Partial, because
-- hand-published rows have no content_key and must not collide with each other on NULL.
CREATE UNIQUE INDEX skills_content_key_key ON skills (content_key)
  WHERE content_key IS NOT NULL;

-- Bare-name lookup for CLI builds predating the owner namespace (getSkillByBareName).
CREATE INDEX skills_name_lookup_idx  ON skills (name);
-- Prefix lookup for the nightly seeder, which asks "what do I already know about THIS repo?"
-- with source_url LIKE 'https://github.com/owner/repo/%'. A BINARY-collated btree serves that
-- prefix scan; without it the seeder would table-scan 1.6M rows once per watched repo.
CREATE INDEX skills_source_url_idx   ON skills (source_url);
CREATE INDEX skills_owner_idx        ON skills (owner);
CREATE INDEX skills_trust_tier_idx   ON skills (trust_tier);
CREATE INDEX skills_install_count_idx ON skills (install_count DESC);
CREATE INDEX skills_score_idx        ON skills (score DESC);
CREATE INDEX skills_published_at_idx ON skills (published_at DESC);

-- --- skills: full-text search ------------------------------------------------

-- content='skills' means FTS5 stores only the inverted index and reads column values back
-- from the table. A standalone table would duplicate name+description — ~203 bytes/row
-- measured, so ~330 MB at 1.61M rows, against a 2 GB `--from-file` ceiling. (D5)
CREATE VIRTUAL TABLE skills_fts USING fts5(
  name,
  description,
  content='skills',
  tokenize='porter unicode61'
);

-- Substring / typo-tolerant matching on name. Replaces pg_trgm, which SQLite has no
-- equivalent for and which spellfix1 would have covered had it been compiled in. (D11)
CREATE VIRTUAL TABLE skills_trgm USING fts5(
  name,
  content='skills',
  tokenize='trigram'
);

-- External content means FTS5 does not see writes to `skills`; these triggers are the
-- entire synchronisation mechanism. Deletes use FTS5's command-row form.
--
-- IMPORTANT for bulk import: create the tables WITHOUT these triggers, load the rows, then
--   INSERT INTO skills_fts(skills_fts)  VALUES('rebuild');
--   INSERT INTO skills_trgm(skills_trgm) VALUES('rebuild');
-- and only then create the triggers. One index build beats 1.61M trigger firings.
--
-- If table and index ever drift, searches silently return wrong or missing rows.
--   INSERT INTO skills_fts(skills_fts) VALUES('integrity-check');   -- detect
--   INSERT INTO skills_fts(skills_fts) VALUES('rebuild');           -- repair
CREATE TRIGGER skills_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts (rowid, name, description) VALUES (new.seq, new.name, new.description);
  INSERT INTO skills_trgm(rowid, name)              VALUES (new.seq, new.name);
END;

CREATE TRIGGER skills_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts (skills_fts,  rowid, name, description)
    VALUES ('delete', old.seq, old.name, old.description);
  INSERT INTO skills_trgm(skills_trgm, rowid, name)
    VALUES ('delete', old.seq, old.name);
END;

CREATE TRIGGER skills_au AFTER UPDATE ON skills BEGIN
  INSERT INTO skills_fts (skills_fts,  rowid, name, description)
    VALUES ('delete', old.seq, old.name, old.description);
  INSERT INTO skills_trgm(skills_trgm, rowid, name)
    VALUES ('delete', old.seq, old.name);
  INSERT INTO skills_fts (rowid, name, description) VALUES (new.seq, new.name, new.description);
  INSERT INTO skills_trgm(rowid, name)              VALUES (new.seq, new.name);
END;

-- --- skillsets ---------------------------------------------------------------

CREATE TABLE skillsets (
  seq           INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  -- Skillsets are addressed by bare name and are globally unique — unlike skills, they were
  -- never owner-namespaced.
  name          TEXT NOT NULL UNIQUE
                  CHECK (name GLOB '[a-z0-9]*' AND name GLOB '*[a-z0-9]'
                         AND name NOT GLOB '*[^a-z0-9-]*'),
  description   TEXT NOT NULL DEFAULT '',
  author        TEXT,
  source_url    TEXT NOT NULL,
  trust_tier    TEXT NOT NULL DEFAULT 'community'
                  CHECK (trust_tier IN ('verified', 'community')),
  score         INTEGER CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
  spec_version  TEXT NOT NULL DEFAULT '1.0',
  tags          TEXT CHECK (tags IS NULL OR json_valid(tags)),
  -- [{ name, source_url }]
  skill_refs    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skill_refs)),
  skill_count   INTEGER GENERATED ALWAYS AS (json_array_length(skill_refs)) STORED,
  install_count INTEGER NOT NULL DEFAULT 0,
  published_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_by  TEXT REFERENCES publishers(id) ON DELETE SET NULL
);

CREATE INDEX skillsets_trust_tier_idx    ON skillsets (trust_tier);
CREATE INDEX skillsets_install_count_idx ON skillsets (install_count DESC);
CREATE INDEX skillsets_score_idx         ON skillsets (score DESC);

CREATE VIRTUAL TABLE skillsets_fts USING fts5(
  name,
  description,
  content='skillsets',
  tokenize='porter unicode61'
);

CREATE TRIGGER skillsets_ai AFTER INSERT ON skillsets BEGIN
  INSERT INTO skillsets_fts(rowid, name, description)
    VALUES (new.seq, new.name, new.description);
END;

CREATE TRIGGER skillsets_ad AFTER DELETE ON skillsets BEGIN
  INSERT INTO skillsets_fts(skillsets_fts, rowid, name, description)
    VALUES ('delete', old.seq, old.name, old.description);
END;

CREATE TRIGGER skillsets_au AFTER UPDATE ON skillsets BEGIN
  INSERT INTO skillsets_fts(skillsets_fts, rowid, name, description)
    VALUES ('delete', old.seq, old.name, old.description);
  INSERT INTO skillsets_fts(rowid, name, description)
    VALUES (new.seq, new.name, new.description);
END;

-- --- watched_repos -----------------------------------------------------------

-- Source of truth for what the nightly sync scans. Rows are edited directly; no code change
-- is needed to add a repo. Deliberately NOT seeded here — 002's INSERT is stale (4 repos, all
-- on 'main'), while production carries 17 rows with corrections that matter. Copy the live
-- rows instead.
CREATE TABLE watched_repos (
  id              TEXT PRIMARY KEY,
  owner           TEXT NOT NULL,
  repo            TEXT NOT NULL,
  branch          TEXT NOT NULL DEFAULT 'main',
  trust_tier      TEXT NOT NULL CHECK (trust_tier IN ('verified', 'community')),
  tags            TEXT CHECK (tags IS NULL OR json_valid(tags)),
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  notes           TEXT,
  added_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_scanned_at TEXT,

  UNIQUE (owner, repo)
);

-- --- seen_source_urls --------------------------------------------------------

-- URLs that were fetched and settled — a name conflict, or a SKILL.md that will fail to parse
-- identically on every future run. Keeps the seeder from re-fetching them forever.
-- Transient failures must NEVER be recorded here; see scripts/seed.ts markSeen().
CREATE TABLE seen_source_urls (
  url        TEXT PRIMARY KEY,
  -- Blob sha of the SKILL.md that was settled here, taken from the tree response that
  -- discovery already makes. Without it a parse failure blacklists the url permanently, so an
  -- author who later fixes their YAML is never noticed; with it, a run retries precisely when
  -- the contents change. Null on rows recorded before this column existed — those keep the old
  -- skip-forever behaviour rather than triggering a re-fetch of everything ever settled.
  blob_sha   TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

-- --- spec_versions -----------------------------------------------------------

CREATE TABLE spec_versions (
  version       TEXT PRIMARY KEY,
  released_at   TEXT,
  changelog_url TEXT,
  is_current    INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1))
) WITHOUT ROWID;

-- At most one current spec version.
CREATE UNIQUE INDEX spec_versions_current_idx ON spec_versions (is_current)
  WHERE is_current = 1;
