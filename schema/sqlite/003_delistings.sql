-- 003 — opt-out / takedown tombstones.
--
-- Phase 7 of the migration, and the gate on the imported corpus becoming publicly searchable:
-- the corpus spans accounts that never opted in, so there has to be a way out that actually
-- works before it goes live.
--
-- The design point is that a delisting is NOT a flag on `skills`. Rows matching a tombstone are
-- DELETED. `REGISTRY_MIGRATION_BACKLOG.md` puts it as "an inert flag is worse than none": a
-- `delisted` column has to be remembered by searchSkills, searchSkillsets, getSkill,
-- getSkillByBareName, incrementInstallCount, refreshStats and everything written afterwards,
-- and one missed filter is a silent leak of content someone asked to have removed.
--
-- Deleting the row means search, install and every future query honour it for free, because
-- there is nothing to honour. This table is what stops it coming back.

CREATE TABLE delistings (
  -- 'owner' — every skill by a GitHub account:      value = "majiayu000"
  -- 'repo'  — every skill from one repository:      value = "acme/skills"
  -- 'skill' — one skill:                            value = "acme/pdf-extractor"
  scope        TEXT NOT NULL CHECK (scope IN ('owner', 'repo', 'skill')),
  value        TEXT NOT NULL,

  reason       TEXT,
  -- Who asked. Free text: a GitHub handle, an email, a ticket reference.
  requested_by TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- How many rows the purge removed when this was applied. Recorded for audit — after the
  -- delete there is no other trace that anything was here.
  removed      INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (scope, value)
) WITHOUT ROWID;

-- ⚠ NEVER purge this table on a re-import, a rebuild, or a schema reset. It is the only thing
-- standing between a takedown request and the next corpus build putting the content straight
-- back. `scripts/corpus/build.ts` and `scripts/seed.ts` both consult it before inserting, and
-- `scripts/corpus/merge-live.ts` carries it across into a freshly built database.
