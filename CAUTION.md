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

**005 (`query_and_write_costs`) exists and is applied to neither.** For a corpus-sized database it is
applied to a locally prepared file, which is then uploaded (§5). The rollback database holds 4,863
rows, so applying 005 to it in place is cheap.

**Since 2026-09-09 v2 also holds data the rollback lacks** — the three official skillsets, with
coherence 4/4, 3/3 and 2/2. A rollback loses them as well as breaking the paths below.

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

**The exception is a migration that indexes or rewrites the 1.6M-row `skills` table**, 005 included.
Turso bills a read for every existing row a `CREATE INDEX` scans, so on v2 such a migration is built
into a local file and uploaded, never run in place (§5).

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

- **Nothing runs against production Turso except production traffic.** Tests, fixes, measurements,
  experiments and one-off scripts run against a local copy of the corpus (D25). Several npm scripts
  load `.env` — `dev`, `seed`, `rescore`, `migrate`, `add-repo`, `refresh-stats`, `delist`,
  `parity:api` — and `.env` holds the production URL and token, so running one "locally" runs it
  against production. The local recipe is in [LOCAL_REGISTRY.md](LOCAL_REGISTRY.md).
- **The free plan blocks the whole account at any limit, not just the database that crossed it.**
  On 2026-09-15 a read-quota overrun made every statement on every database in the org fail with
  `BLOCKED`, and the registry went down (FINDINGS §16). Quotas reset on the 1st of the calendar
  month, and the block landed about two days after the limit was actually crossed.
- **While production runs on the temporary account (D30), two databases each hold writes the other
  lacks.** The original account's `skilldex-registry-v2` has everything written from 2026-09-06 to
  09-15; the temporary one, built from the 2026-09-06 file, has everything written since the move.
  Moving back after the 2026-10-01 reset is a merge, not a key swap, and neither database is deleted
  until the merged file is verified. The rollback database `skilldex-registry` sits on the original
  account and is blocked with it, so until the reset there is no rollback target.
- **Migration 005 is applied to a local file and uploaded, never run on the hosted database.** Its
  two `CREATE INDEX` statements read every row of `skills` — 3,235,804 rows read when applied
  locally — and dropping `skills_trgm` frees 115 MB that only a `VACUUM` gives back. Build the file
  locally (`prepare-corpus-db.ts`, then `migrate.ts --url file:…`, then `VACUUM`) and create the
  database from it (D28).
- **Copy a corpus-sized database as a file, never row by row.** `turso db create --from-file` bills
  no row writes. Replaying rows would: each skill insert writes 11 rows once the FTS triggers
  fire, so 1.6M of them is ~17.8M rows written — well past the free plan's 10M a month.
- **Every Vercel deploy starts with an empty CDN cache.** The cache key includes the deployment URL,
  so after each deploy the first request for every distinct URL reaches the database. Batch
  deploys; do not redeploy repeatedly to test something.
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
