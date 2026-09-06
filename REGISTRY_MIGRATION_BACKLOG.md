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
| **2** | Rewrite `src/db/*`; replace Supabase Auth | 2–3d | ✅ **done and deployed** |
| **3** | Port `seed.ts` to Turso **and** kill the global preload | 1d | ✅ done |
| **4** | Import the corpus | 2d | 🟡 built, merged, uploaded — **not cut over** |
| **4b** | Counting fix, curated split, browse redesign | 2d | ✅ **done and deployed** |
| **5** | Freshness #1+2 — repo SHA polling, compare diffs | 1.5d | ⬜ |
| **6** | Freshness #4+5 — verify-on-read, priority queue | 1d | ⬜ |
| **7** | Opt-out / takedown path | 1d | ✅ **done** — was the gate on the corpus going live |
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
- [x] Switch Vercel env vars at cutover; **leave `SUPABASE_*` in place** so rollback is one
      variable, not a scramble. Note: setting env vars does **not** trigger a rebuild — the
      first attempt served the old build until an explicit redeploy
- [x] Deployed 2026-09-06 and verified live: `q=pdf` returns 55 ordered by relevance,
      `q=invoices` 26, ambiguous names 409, unauthenticated `/auth/me` 401
- [x] ⚠ **Do not deploy the Turso-backed API while the nightly seeder still writes to
      Supabase.** Resolved by disabling the nightly workflow for the transition — the seeder
      must be ported (phase 3 below) before it is re-enabled. `src/` is fully ported, but `scripts/seed.ts`, `rescore.ts` and
      `add-repo.ts` still use `@supabase/supabase-js`. Deploying now would split the brain:
      the seeder inserts into Supabase and the API reads Turso, so new skills would never
      appear. Either disable the nightly workflow for the transition, or hold the deploy
      until phase 8 ports the seeder
- [ ] Update `.github/workflows/nightly-seed.yml` to pass the Turso vars

---

## Phase 3 — Kill the global preload

- [x] Replace `fetchAllColumn` in `scripts/seed.ts` with a per-repo scoped query
- [x] Port `seed.ts` off `@supabase/supabase-js` — absorbed from phase 8, because fixing the
      preload against PostgREST would have been throwaway work and the API is now on Turso
- [x] `skills_source_url_idx` added so the prefix scan uses an index instead of a table scan
- [x] `.github/workflows/nightly-seed.yml` passes `TURSO_*` instead of `SUPABASE_*`
- [x] Verified against live data: per-repo scoping accounts for 15,762 of 15,767 known urls.
      The 5 remaining belong to `PhilipStark/book-genesis`, which was repointed today and is
      no longer watched, so they can never be rediscovered
- [x] First manual run against Turso, 2026-09-06: 17/17 repos, inserted 25, skipped 9,975,
      failed 3, and the deployed API served the new skills immediately
- [x] Widen the typecheck to cover `scripts/` and `tests/` — `tsconfig.json` includes only
      `src/**/*`, which is why a syntax error in `seed.ts` passed `npm run typecheck` and only
      appeared when the seeder ran. Six errors surfaced, including `rescore.ts` declaring a
      `SkillRow` without `owner` while using `skill.owner`
- [x] ⚠ **Retry-on-change for parse failures.** `seen_source_urls.blob_sha` records the sha
      of the SKILL.md that was settled, taken from the tree response discovery already makes.
      A url is refetched precisely when its contents change, so an author who fixes their YAML
      is noticed — without the permanent blacklist the previous fix created
- [x] Baseline adoption for rows predating the column: discovery knows the current sha, so
      5,604 unversioned rows were given one with no GitHub requests. Idempotent — a second run
      adopts nothing. The remaining 5,328 are paths that no longer exist upstream
- [ ] Re-enable the nightly workflow

**Why this is before the import.** Today the seeder loads *every* known URL into an in-memory
`Set` on every run. At 1.61M skills plus seen URLs that is ~3,200 paginated round trips and
roughly 1 GB of heap, every night, for data that barely changes. With real SQL the query
scales with the repo being scanned instead of with the corpus. This is the same bug class as
the truncated preload already fixed in `d375723` — latent rather than absent.

---

## Phase 4 — Import the corpus 🟡

**Built, merged and uploaded to `skilldex-registry-v2`; nothing points at it.** Cutover is
gated on phase 7, and the corpus database still needs `source` — either a rebuild (which now
applies 002 automatically and sets `source` at INSERT time) or the default-flip patch
documented at the foot of `schema/sqlite/002_source_and_stats.sql`.


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
- [x] `source_url` uses `tree/HEAD` (D14) — the dataset carries no default branch, and `main`
      would 404 for every master-default repo
- [ ] **After cutover only**, switch `seed.ts` from `tree/{branch}` to `tree/HEAD`. Doing it
      before would orphan all 15,767 existing urls at once and re-fetch the entire watch list
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

## Phase 4b — Counting, the curated split, and the browse redesign ✅

Unplanned. Timing real queries against the 1.6M build exposed a blocker that had to be fixed
before cutover, and fixing it properly meant rethinking what the browse page shows. Decisions
D15–D17; measurements in FINDINGS §5–§8; background in
[COUNTING_AT_SCALE.md](COUNTING_AT_SCALE.md) and
[REGISTRY_BROWSE_REDESIGN_PLAN.md](REGISTRY_BROWSE_REDESIGN_PLAN.md).

**API** — `3dd1030`, `978ada5`, `7ef421b`

- [x] Replace `count(*) OVER ()` in `searchSkills` **and** `searchSkillsets` — the skillsets
      copy had the identical defect and had never been measured
- [x] `src/db/pagination.ts` — `COUNT_CAP`, `MAX_OFFSET`, bounded count, `eq`/`gte`, `takePage`.
      Only the pieces that must never diverge are shared; the SQL stays in each file
- [x] Page + count in one `db.batch()`, so the fix stays one HTTP round trip
- [x] Drop `bm25()` from the count subquery — the count needs no rank
- [x] `has_more` from a `limit + 1` fetch
- [x] Migration `002_source_and_stats.sql`: `source` column, two partial indexes,
      `registry_stats`, `tag_counts`
- [x] `scripts/migrate.ts` — the first real migration runner. Records 001 as already-in-effect
      by detecting the `skills` table rather than trusting a flag
- [x] `scripts/lib/schema.ts`; `build.ts` now applies **every** schema file, so a fresh
      `--from-file` database cannot ship an older schema than production
- [x] `GET /v1/stats` and `GET /v1/tags`, both O(1) table reads
- [x] `scripts/refresh-stats.ts`, wired into `seed.ts` and `merge-live.ts`
- [x] `offset` capped at `MAX_OFFSET`, with a distinguishable `OFFSET_TOO_LARGE`
- [x] Cache-Control on GET reads — **in handlers, not middleware** (FINDINGS §7)
- [x] `merge-live.ts` writes `source` on both insert and conflict paths
- [x] Tests 71 → 102, against a real SQLite fixture through the Hono app. `COUNT_CAP` is
      injectable so the `gte` branch is covered; it is otherwise production-only

**Web** — `c0f8dee`

- [x] Stop sending `sort=installs` on every search — this alone made bm25 reachable from the
      site for the first time; "Best match" added to the dropdown
- [x] `/registry/[owner]/[name]`; `[name]` **renamed** to `[owner]` (coexisting is a build
      error) and repurposed as a resolver that redirects or disambiguates
- [x] `resolveBareName` distinguishes 409 from 404 — contested names were rendering as "not
      found" for ~41.5% of corpus names
- [x] Curated landing (four strips) / results split; "Load more" via a Route Handler
- [x] Scope toggle; `total_relation` rendered as "10,000+"
- [x] `loading.tsx` / `error.tsx` / `not-found.tsx` — there were none, so an outage rendered as
      "No skills published yet. Be the first!"
- [x] `RegistrySkill` gains `owner` / `display_name` / `qualified_name`

**Deployment** — migration applied to the live database, stats populated, API verified
(FINDINGS §8).

- [ ] **Redeploy the registry once more** to pick up `7ef421b` (the cache-header fix). Nothing
      is broken without it; the read routes simply are not edge-cached yet.

### Left undone, deliberately

- [ ] **Install command stays the bare name.** The CLI does `encodeURIComponent(name)`, so a
      qualified name becomes `owner%2Fname` and may match the legacy single-segment route.
      Whether Vercel normalises `%2F` first is untested. Changing the URL scheme and changing
      the install command are independent; only the first is done. Gate the second on an
      end-to-end test against the deployed API with `skilldex-cli@1.2.0`
- [ ] **Sitemap.** A per-skill sitemap would have to page the API, and every request past
      offset 10,000 is now refused by the cap this same work introduced. It needs a bulk-export
      endpoint first. A static `sitemap.ts`/`robots.ts` is cheap and still absent
- [ ] **`skills_trgm`** is built, integrity-checked, and still queried by nothing
- [ ] `src/app/registry/skillsets/page.tsx` is a stale fork of the browse page. It inherits the
      count fix for free; its UI was not redesigned

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

## Phase 7 — Opt-out / takedown ✅

Decision D18. The `delisted` flag was rejected in favour of deleting the row — see the
reasoning there, which is this section's own "inert flag" warning taken seriously.

- [x] ~~`delisted` flag honoured by both search and install~~ — **rows are deleted instead**, so
      search, install, detail and stats honour a takedown without any of them being changed.
      Tested negatively: after a delisting the ordinary endpoints return nothing, and none of
      them knows delistings exist
- [x] Documented request route — [OPT_OUT.md](OPT_OUT.md), written for the person asking rather
      than for us: what we need, what happens, and explicitly what it does *not* do (it does not
      touch their GitHub repo, and it cannot reach the independently-published GitSkills dataset)
- [x] Granularity: **all three** — owner, repo, skill. Owner is the request that actually
      arrives; repo matches how the corpus is shaped; skill covers the single-file case
- [x] Re-import cannot resurrect. `scripts/seed.ts` and `scripts/corpus/build.ts` consult the
      tombstones before inserting, `merge-live.ts` copies them into a built database, and
      `POST /v1/skills` refuses to publish into a delisted namespace
- [x] Migration `003_delistings.sql`, applied to the live database
- [x] `scripts/delist.ts` with `preview` / `add` / `list` / `remove`; `add` refreshes the counts
- [x] 12 tests, including that a repo-scope rule for `acme/my_repo` does **not** also remove
      `acme/myXrepo` — `_` is a LIKE wildcard, and a LIKE-based matcher would have

**Still open before the corpus goes live:** nothing in this phase. The remaining gate is
freshness (phases 5–6) and the seeder realignment in phase 8.

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
