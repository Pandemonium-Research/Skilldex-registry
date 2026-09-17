-- 005 — cut what reads and writes cost at corpus scale (D26, D28).
--
-- Turso bills every row a statement scans and every row it writes. At 1.6M rows the registry used
-- its 500M monthly reads in nine days and the account was blocked (FINDINGS §16). This migration is
-- the schema half of the fix; the query half is in src/db/skills.ts and src/db/stats.ts.
--
-- ⚠ APPLY TO A LOCAL COPY AND UPLOAD WITH `turso db create --from-file`. Do not run it against a
-- hosted corpus-sized database: Turso bills one read per existing row for every CREATE INDEX (about
-- 1.62M each here), and dropping skills_trgm rewrites pages across the file. See CAUTION.md §5.
--
-- WRITES — FTS is rewritten only when the text it indexes changes.
--
-- skills_au fired on every UPDATE, so an install (`install_count + 1`) or a rescore deleted and
-- re-inserted the row in both FTS5 tables: 6–7 rows written for a one-column change. Scoped to the
-- two indexed columns, the same install writes 2–3.
--
-- skills_trgm is dropped. It was built for substring and typo-tolerant name matching (D11) and is
-- queried by nothing — REGISTRY_MIGRATION_BACKLOG.md Phase 9 already recorded it as unreachable. It
-- held 115 MB of the 1.9 GB file and added a row to every insert, update and delete. Rebuild it from
-- `skills` if that feature is ever built.

DROP TRIGGER IF EXISTS skills_ai;
DROP TRIGGER IF EXISTS skills_ad;
DROP TRIGGER IF EXISTS skills_au;

DROP TABLE IF EXISTS skills_trgm;

CREATE TRIGGER skills_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts (rowid, name, description) VALUES (new.seq, new.name, new.description);
END;

CREATE TRIGGER skills_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts (skills_fts, rowid, name, description)
    VALUES ('delete', old.seq, old.name, old.description);
END;

CREATE TRIGGER skills_au AFTER UPDATE OF name, description ON skills BEGIN
  INSERT INTO skills_fts (skills_fts, rowid, name, description)
    VALUES ('delete', old.seq, old.name, old.description);
  INSERT INTO skills_fts (rowid, name, description) VALUES (new.seq, new.name, new.description);
END;

-- READS — two partial indexes, each a few thousand entries or fewer.
--
-- rescore.ts pages the curated tier by (name, owner). Without an index in that order it walked the
-- name index across all 1.6M rows to find ~4,863: 4,747,852 rows read per run, 14,863 with this.
CREATE INDEX IF NOT EXISTS skills_curated_name_idx ON skills (name, owner)
  WHERE source <> 'imported';

-- All but a handful of rows are on spec 1.0, so this holds only the exceptions. A filter for any
-- other version repeats the predicate as a conjunct (D19) and reads the matches, instead of walking
-- the table twice to find none — 3,230,644 rows read for a version nobody uses.
CREATE INDEX IF NOT EXISTS skills_spec_version_other_idx ON skills (spec_version)
  WHERE spec_version <> '1.0';
