# Registry Migration — Backlog

Task tracking for the move off Supabase/Postgres to Turso/SQLite and the full GitSkills
import. Rationale for every design call is in
[REGISTRY_MIGRATION_DECISIONS.md](REGISTRY_MIGRATION_DECISIONS.md); the measurements behind
them are in [REGISTRY_MIGRATION_FINDINGS.md](REGISTRY_MIGRATION_FINDINGS.md).

Phase 3 deliberately precedes phase 4: it is what makes the import survivable rather than
something to clean up afterwards.

Effort figures are estimates, not commitments.

---

## Status

| Phase | Work | Effort | Status |
|---|---|---:|---|
| **0** | Provision Turso, verify connectivity | 0.5d | ✅ done |
| **1** | Schema + migrate live rows + parity check | 1d | ✅ done |
| **2** | Rewrite `src/db/*`; replace Supabase Auth | 2–3d | ⬜ |
| **3** | Freshness #3 — kill the global preload | 0.5d | ⬜ |
| **4** | Import the corpus | 2d | ⬜ |
| **5** | Freshness #1+2 — repo SHA polling, compare diffs | 1.5d | ⬜ |
| **6** | Freshness #4+5 — verify-on-read, priority queue | 1d | ⬜ |
| **7** | Opt-out / takedown path | 1d | ⬜ |
| **8** | Realign the nightly seeder with the imported corpus | 1–1.5d | ⬜ |

---

## Phase 0 — Provisioning ✅

- [x] Turso account on the free `starter` plan — no card
- [x] Group `default` primary in `aws-us-east-1`, matching Vercel's `iad1`
- [x] Database `skilldex-registry`, `--size-limit 4gb` as a guard against a runaway import
- [x] `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` in local `.env` and GitHub Actions secrets
- [x] Verified: SQLite 3.47.0, `ENABLE_FTS5` present, database empty
- [ ] Add both vars to `.env.example` (committed file, it is the setup contract)

---

## Phase 1 — Schema and parity ✅

> **These rows are a rehearsal, not the final data.** They will be discarded when phase 4
> builds the real database. The point is to exercise the whole path — schema, type
> conversion, FTS triggers, parity — at 4,838 rows, where a mistake costs seconds instead of
> a 1.6M-row rebuild. It also unblocks phase 2, which needs something to develop against.

- [x] `schema/sqlite/001_schema.sql` — six tables, FTS5 external content, trigram table,
      triggers, indexes
- [x] `scripts/migrate-to-turso.ts` — copy the live rows out of Supabase
- [x] Parity check — 27 schema statements applied; all six tables match
      (4,838 skills, 10,929 seen urls, 17 watched repos); top-5 search **identical** across
      both backends; FTS `integrity-check` passes on all three virtual tables
- [x] `json_each` confirmed working on real data
- [x] Measured size: **7.3 MB**, and `skills` all-in is **1,104 B/row** — see
      [REGISTRY_MIGRATION_FINDINGS.md](REGISTRY_MIGRATION_FINDINGS.md) §1b

**Note.** `watched_repos` seed rows must NOT be re-inserted from `002_watched_repos.sql`.
That file's `INSERT` is stale: it lists four repos on `main`, but production now has 17 rows,
`ComposioHQ` is on `master`, and `PhilipStark/book-genesis` has been repointed to
`felipelobomotta-blip/book-genesis-v4`. Copy the live rows, do not re-seed.

---

## Phase 2 — Data layer and auth

- [ ] `src/db/client.ts` → `@libsql/client/web` (HTTP; no connection pool to exhaust from
      serverless — an advantage over Postgres in this deployment)
- [ ] Rewrite `src/db/skills.ts` (7 functions), `skillsets.ts`, `publishers.ts`
- [ ] `searchSkills`: Postgres `textSearch` → FTS5 `MATCH` with `bm25()` ranking
- [ ] Default sort → `score` (D10)
- [ ] Replace the three Supabase Auth calls with direct GitHub OAuth + self-issued JWT
- [ ] **Fix the publisher identity bug while here** — `upsertPublisher` never sets
      `publishers.id`, so `getPublisherById(user.id)` can never match. Key on
      `github_handle`, which is already `UNIQUE`
- [ ] Check whether a GitHub OAuth app already exists — `GITHUB_CLIENT_ID` /
      `GITHUB_CLIENT_SECRET` are already in `.env.example`, so this may be half-configured
- [ ] Switch Vercel env vars at cutover; **leave `SUPABASE_*` in place** so rollback is one
      variable, not a scramble
- [ ] ⚠ **Do not deploy the Turso-backed API while the nightly seeder still writes to
      Supabase.** `src/` is fully ported, but `scripts/seed.ts`, `rescore.ts` and
      `add-repo.ts` still use `@supabase/supabase-js`. Deploying now would split the brain:
      the seeder inserts into Supabase and the API reads Turso, so new skills would never
      appear. Either disable the nightly workflow for the transition, or hold the deploy
      until phase 8 ports the seeder
- [ ] Update `.github/workflows/nightly-seed.yml` to pass the Turso vars

---

## Phase 3 — Kill the global preload

- [ ] Replace `fetchAllColumn` in `scripts/seed.ts` with a per-repo anti-join

**Why this is before the import.** Today the seeder loads *every* known URL into an in-memory
`Set` on every run. At 1.61M skills plus seen URLs that is ~3,200 paginated round trips and
roughly 1 GB of heap, every night, for data that barely changes. With real SQL the query
scales with the repo being scanned instead of with the corpus. This is the same bug class as
the truncated preload already fixed in `d375723` — latent rather than absent.

---

## Phase 4 — Import the corpus

- [ ] `scripts/build-corpus.ts` — DuckDB over the Parquet mirror → one local SQLite file
- [ ] Apply the format gates: `frontmatter_valid = 1` and filename = `SKILL.md`
      (1,877,981 → 1,610,957). Both are required by the Agent Skills spec and already
      enforced by `seed.ts`
- [ ] Backfill `score` with `validateSkill` — CPU only, no network
- [ ] **Collision rule — settled, see D13.** Measured: **204,923 rows (12.75%)** collide on
      `(owner, slug)`, not the ~43,000 previously assumed from 005's header. Implement the
      three cases:
    - [ ] uncontested → bare `owner/name`
    - [ ] contested, one shared description → lowest `file_sha` keeps the bare name, rest get
          `owner/name-<hash8>`
    - [ ] contested, descriptions differ → all get `owner/name-<hash8>`; bare name reports
          ambiguity
    - [ ] hand-published rows (`content_key IS NULL`) are never displaced — forward-looking
          policy; **vacuous for this import**, since none of the 4,838 live rows are
          hand-published (D13 revision)
    - [ ] do **not** grandfather the 4,838 live rows. They are insert-order winners of 15,767
          candidates, and 10,929 siblings were silently dropped. Re-derive them from the
          corpus, which covers 16/17 watched repos (the 17th has no skills)
    - [ ] carry `install_count` over, matched on `source_url` — the only real signal in the
          old rows, and D10 makes it the default sort's input
    - [ ] extend `slugifySkillName` with the suffix form, truncating the base to 91 chars
    - [ ] unit-test determinism: the same input twice must produce identical slugs, and the
          result must not depend on row order
- [ ] **Measure tag density** and decide D8's side table with data
- [ ] **Store `repo` as a real column.** Independent of the naming rule, which rejected
      `owner/repo/name`: phase 5 polls `head_sha` per repo, and the repo is currently only
      recoverable by string-parsing `source_url`. That fragility is how the stale-owner
      problem on the renamed repos arose
- [ ] Build FTS5 by `'rebuild'` *after* the bulk load, then create the triggers
- [ ] **Build into a fresh local file, then upload — blue/green.** `turso db create
      --from-file` *creates* a database; it cannot merge into the one already holding the
      live rows, so an upload on top would replace them. The order is: migrate the live rows
      into the build file **first** (D13's incumbency rule needs them present), add the
      corpus, then `turso db create skilldex-registry-v2 --from-file` and switch
      `TURSO_DATABASE_URL`. Cutover is one variable and the old database stays for rollback.
      `@libsql/client` accepts `file:` URLs, so `migrate-to-turso.ts` can target the build
      file with no change beyond the URL
- [ ] **Measure the built file before uploading.** Projection from phase 1's real numbers is
      **~1.77 GB against a 2 GB `--from-file` ceiling — only ~11% headroom.** Levers if it
      comes in over: drop `skills_published_at_idx` (~109 MB, loses `?sort=recent`), drop the
      trigram table (~93 MB, loses fuzzy matching), or fall back to `--from-dump`. Do not
      discover this at upload time
- [ ] Rejected alternative: inserting 1.6M rows into the live database. It fits the write
      budget (16% of 10M/month) but is 3,200+ round trips and non-atomic — a failure leaves a
      half-imported registry
- [ ] Re-verify the deployed API against the new database

---

## Phase 5 — Repo-level freshness

- [ ] `watched_repos.head_sha` (or a new `repos` table for the imported corpus)
- [ ] Conditional requests: `GET /repos/{o}/{r}/commits/{branch}` with `If-None-Match`.
      **A 304 does not count against the GitHub rate limit** — this is what converts a
      quota-bound sweep into a wall-clock-bound one
- [ ] On a moved SHA, `GET /compare/{old}...{new}` — process only changed paths, and handle
      deletions, which gives the dead-link reaper for free
- [ ] Sizing: the corpus spans **282,200 repos**, not 1.61M skills. That is the unit count
      that makes a regular sweep feasible at all

---

## Phase 6 — Long-tail freshness

- [ ] Verify `source_url` on install/view and write the result back. 86.6% of the corpus is
      single-owner and most rows will never be installed, so the hot set stays fresh for free
      and the cold set costs nothing until someone wants it
- [ ] Priority queue, oldest-checked-first, weighted by installs/score
- [ ] Failure counter, so one transient 404 cannot de-list a live skill

---

## Phase 7 — Opt-out / takedown

- [ ] `delisted` flag honoured by both search and install — an inert flag is worse than none
- [ ] Documented request route
- [ ] Decide the granularity: per-skill, per-repo or per-owner
- [ ] Guarantee a re-import cannot resurrect a de-listed entry

**Gate.** [BACKLOG.md](BACKLOG.md) places this *before* the imported corpus becomes publicly
searchable. The corpus spans accounts that never opted in, and importing the full set rather
than the ≥ 2-owner slice widens that from 23,081 owners to every account in the dataset.
Freshness and consent are separate gates on the same milestone.

---

## Phase 8 — Realign the nightly seeder

**Runs after the import, not before.** Until the corpus lands, the seeder's world is 17
watched repos; afterwards it is 17 repos inside a 1.6M-row registry, and several of its
assumptions stop holding.

- [ ] Port `scripts/seed.ts` off `supabase-js` — phase 2 covers `src/db/*`, but the seeder
      talks to the database directly and is not included in that
- [ ] **Apply the same D13 naming rule.** The seeder currently calls `slugifySkillName` with a
      *source-url* hash as its fallback key; the importer uses the *content* hash. If the two
      disagree, a nightly run can insert a second row for a skill the import already has
- [ ] **Reconcile `source_url` construction.** The seeder builds
      `https://github.com/{owner}/{repo}/tree/{branch}/{dir}`; the importer derives its URL
      from `repo_full_name` + `path`. **If these differ by even a trailing slash or a branch
      name, every already-imported skill in the 17 watched repos looks new and gets
      re-inserted.** Verify byte-equality on a sample before the first nightly run after
      import
- [ ] Decide what happens when a watched repo's skill is already present with a `content_key`:
      update in place, or leave the imported row alone
- [ ] Re-check `markSeen` semantics at scale — deterministic failures recorded, transient ones
      retried (already correct, but the volume changes)
- [ ] Confirm the phase 3 anti-join still bounds the run once the table is 1.6M rows

**Do not skip the source_url check.** It is the single most likely way to silently double-count
the corpus.

---

## Not scheduled

- **GH Archive event stream.** Querying the public GitHub event firehose for pushes touching
  `SKILL.md` paths would track the whole of GitHub without polling anyone. Only worth it if
  the corpus grows past what phases 5–6 can enumerate.
- **Semantic search / pgvector.** Carried over from [BACKLOG.md](BACKLOG.md); a separate
  problem from ranking, and it now needs a non-Postgres answer.
