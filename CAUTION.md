# CAUTION — read before rolling back the database

Operational hazards that are not obvious from the code. Written to be read in a hurry.

---

## 1. The rollback database is behind on schema

`skilldex-registry-v2` is live. `skilldex-registry` is the rollback and **must not be
deleted** — but it is no longer a drop-in replacement, because migrations have been applied
to v2 that it never received.

| | `skilldex-registry` (rollback) | `skilldex-registry-v2` (**live**) |
|---|---|---|
| Skills | 4,863 | 1,615,322 |
| Migrations | 001, 002, 003 | 001, 002, 003, **004** |
| Status | cold standby, untouched | serving production |

**004 (`skillset_coherence`) was applied to v2 on 2026-09-07 and has never been applied to
the rollback database.**

Repointing the environment variables at the old database *without migrating it first* gives
you a running API on a schema that is missing columns the code requires.

### What actually breaks

Not everything — which is what makes it dangerous. Listing skillsets degrades quietly to
nulls, so a smoke test can look fine while these are broken:

| Path | Failure |
|---|---|
| `POST /v1/skillsets` | 500 — the INSERT names `members_checked`, `members_coherent`, `coherence` (`src/db/skillsets.ts`) |
| `GET /v1/skillsets?sort=coherence` | 500 — `ORDER BY s.coherence_pct` |
| `GET /v1/skillsets?min_coherence=…` | 500 — `WHERE s.coherence_pct >= ?` |
| `GET /v1/skillsets` (plain) | survives — `SELECT s.*` simply returns fewer columns and `toSkillsetRow` nulls them |

---

## 2. Rollback procedure, in this order

**Migrate first, then repoint.** The reverse leaves a window where production is pointed at
an unmigrated database — the same ordering mistake as pushing code before applying a
migration.

```bash
# 1. Mint a token for the OLD database. Turso tokens are scoped per database:
#    the v2 token will 401 against skilldex-registry, and vice versa.
turso db tokens create skilldex-registry

# 2. Point a shell at the old database and check what it is missing.
#    --dry-run writes nothing and prints exactly which migrations would run.
TURSO_DATABASE_URL=libsql://skilldex-registry-pandemoniumresearch.aws-us-east-1.turso.io \
TURSO_AUTH_TOKEN=<the token from step 1> \
  npx tsx scripts/migrate.ts --dry-run

# 3. Apply them.
#    (drop --dry-run; same two env vars)

# 4. Verify by RE-READING, not by the absence of an error — see §4.

# 5. Only now change TURSO_DATABASE_URL *and* TURSO_AUTH_TOKEN in Vercel, and redeploy.
```

⚠ **Both variables change, always.** Moving only the URL 401s every request, because the
token belongs to the other database.

⚠ **Rolling back loses the corpus.** The old database holds 4,863 skills, not 1,615,322.
Every imported skill's URL 404s until you roll forward again. This is a availability
decision, not a free undo.

---

## 3. The general rule, so this page does not go stale

**Every migration applied to v2 widens the gap.** The specific hazard today is 004; the
durable rule is:

> The rollback database is only usable after `npm run migrate` has been run against it.
> Never assume its schema matches production.

Step 2 above is self-verifying — `--dry-run` reports whatever is actually missing, so it
stays correct as migrations accumulate without anyone remembering to update this table.

The cheapest fix is to stop the divergence: **apply new migrations to both databases** while
the rollback is still a rollback. That costs seconds for a schema-only migration like 004 and
removes this whole section as a concern.

---

## 4. Verify DDL by re-reading, never by the absence of an error

On the 1.9 GB database, `ALTER TABLE ADD COLUMN` exceeded the HTTP client's timeout and
*appeared* to fail. It had in fact succeeded, taking 4m38s. A `pragma_table_info` check run
immediately afterwards still reported the column missing.

- Use the Turso CLI for DDL against `skills` (1.6M rows). Migration 004 touches only
  `skillsets`, which is empty, and completed in 5 seconds.
- After any migration, re-read the schema.
- **`pragma_table_info` omits generated columns.** `coherence_pct` is `VIRTUAL` and will not
  appear there — use `pragma_table_xinfo`, where it shows with `hidden = 2`. Checking the
  wrong pragma will tell you a successful migration failed.

```
migrations : 001, 002, 003, 004
columns    : members_checked, members_coherent, coherence  (table_info)
             coherence_pct                                  (table_xinfo, hidden=2)
index      : idx_skillsets_coherence_pct
```

That is the verified state of v2 as of 2026-09-07.

---

## 5. Other standing cautions

- **Never purge the `delistings` table.** It is the only thing preventing the next corpus
  build from re-importing content someone asked to have removed. See
  [OPT_OUT.md](OPT_OUT.md).
- **GitHub Actions secrets still point at the old database, deliberately.** They stay there
  until the `source_url` reconciliation lands, because the seeder builds `tree/{branch}` and
  the importer builds `tree/HEAD` — a mismatch makes every imported watched-repo skill look
  new. See [REGISTRY_SEED_PLAN.md](REGISTRY_SEED_PLAN.md) §10.
- **`scripts/migrate.ts` is not transactional.** A migration that fails halfway leaves its
  applied statements in place and is *not* recorded, so re-running replays the whole file —
  and `ALTER TABLE ADD COLUMN` is not idempotent. A partial failure needs fixing by hand.
- **`scripts/preflight-005.ts` is dead.** It targets Supabase and the old Postgres migration
  numbering; it has nothing to do with `schema/sqlite/00N_`.

---

Related: [REGISTRY_MIGRATION_FINDINGS.md](REGISTRY_MIGRATION_FINDINGS.md) §13 (cutover),
[REGISTRY_MIGRATION_DECISIONS.md](REGISTRY_MIGRATION_DECISIONS.md),
[REGISTRY_SEED_PLAN.md](REGISTRY_SEED_PLAN.md).
