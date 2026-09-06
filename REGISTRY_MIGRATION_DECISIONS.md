# Registry Migration — Decisions

Why the registry is moving off Supabase/Postgres to Turso/SQLite, and the design calls made
along the way. Task tracking lives in [REGISTRY_MIGRATION_BACKLOG.md](REGISTRY_MIGRATION_BACKLOG.md);
corpus measurements in [FINDINGS.md](FINDINGS.md); import state in [IMPORT_STATUS.md](IMPORT_STATUS.md).

Each decision records what would reverse it. Nothing here is permanent — the corpus can be
rebuilt from the dataset DOI at any time.

---

## D1 — Move to Turso (SQLite), not a managed Postgres

**Decision.** Host the registry on Turso, on the free "starter" plan.

**Why.** The import target is the full GitSkills corpus (see D3 in
[IMPORT_STATUS.md](IMPORT_STATUS.md)), which puts the database at roughly **1.5–1.8 GB**.
No managed free *Postgres* tier is that large. Surveyed 2026-09-06:

| Option | Free storage | Card? | Engine | Blocker |
|---|---:|---|---|---|
| **Turso** | 5 GB | no | SQLite | schema/query rewrite |
| Cloudflare D1 | 5 GB | no | SQLite | **100k row writes/day** |
| Cloudflare R2 | 10 GB | yes | object store | not a database |
| Oracle Always Free | 200 GB | yes | Postgres (self-host) | capacity + ops |
| Neon | 0.5 GB | no | Postgres | too small |
| Supabase | 0.5 GB | no | Postgres | too small |
| Aiven | 1 GB | no | Postgres | too small, idles off |
| Koyeb | 1 GB | no | Postgres | too small |
| Xata | — | — | — | free tier retired in 2026 |

**Why not D1**, the obvious sibling: not storage but **writes**. Its free plan allows 100,000
row writes per day, so a 1.6M-row import would take ~17 days, and Cloudflare began enforcing
the daily limits on 2026-09-01. Turso allows 10M writes/month and 500M reads/month, and its
`--from-file` upload path does not consume the row-write budget at all.

**Why not Oracle**, which has by far the most storage: it keeps Postgres and therefore needs
almost no code change, but it requires a card, you operate the server, and Oracle halved the
Always Free Ampere allocation in 2026 and terminates instances above the new limits.

**What would reverse this.** Paying for Supabase Pro (8 GB) — everything works unchanged. Or
the corpus proving smaller than ~1 GB after measurement, which puts a managed Postgres free
tier back in range.

**Verified 2026-09-06:** connection works, SQLite 3.47.0, `ENABLE_FTS5` compiled in.

---

## D2 — Database region: `aws-us-east-1`

**Decision.** Turso group `default` has its primary in `aws-us-east-1` (Virginia).

**Why.** The database talks to the *Vercel function*, not to the browser. Measured from the
live deployment, `x-vercel-id: bom1::iad1::…` — requests enter at Mumbai's edge but execute in
**`iad1` (Virginia)**. So the database belongs next to `iad1`, not next to the user. Turso's
default put it in Tokyo, which would have crossed the Pacific on every query.

**Gotcha found doing this.** Databases inherit their *group's* primary location;
`turso db create --location` can only pick among locations the group already has, and
`turso group locations add` adds replicas, not a new primary. On the free plan there is a
one-group limit, so the group itself had to be destroyed and recreated.

**What would reverse this.** Moving the Vercel functions to a different region — the two
should always match.

---

## D3 — Move all six tables, not just `skills`

**Decision.** `skills`, `skillsets`, `publishers`, `watched_repos`, `seen_source_urls` and
`spec_versions` all move.

**Why.** The other five are tiny. A split leaves two database clients in the API, two
failure modes, and a rollback story that has to reason about which half is authoritative.

**What would reverse this.** Nothing foreseeable; a split would be a response to a specific
need, not a default.

---

## D4 — One authored schema, not five ported migrations

**Decision.** `schema/sqlite/001_schema.sql` is a single authored file. The Postgres
migrations 001–005 are not ported.

**Why.** There is no existing SQLite database to migrate *from*, so sequential migrations
would only be re-enacting history. The end state is what matters.

**This fixes A2 for free.** `004_skillsets.sql` was never applied to Supabase, which is why
every `/skillsets/*` route returns 500. A freshly authored schema includes those tables by
construction, so the bug cannot survive the move.

**What would reverse this.** Nothing — but note that from here on, schema changes *do* need
numbered migrations, because there will be a live database to evolve.

---

## D5 — FTS5 with `content='skills'` (external content)

**Decision.** The search index is an external-content FTS5 table, not a standalone one.

**Why.** A standalone FTS5 table stores its own copy of every indexed column. `name` +
`description` average ~203 bytes/row (measured over 1,000 live rows), so at 1.61M rows that is
**~330 MB of pure duplication** — against a 5 GB plan and, more pressingly, the **2 GB
`--from-file` ceiling**. External content stores only the inverted index.

**What it costs.** FTS5 no longer sees writes to `skills`, so three triggers keep it in sync
(insert, delete, update — the delete uses FTS5's command-row form).

**The failure mode.** If table and index drift, searches silently return wrong or missing
rows. `INSERT INTO skills_fts(skills_fts) VALUES('integrity-check')` detects it; `'rebuild'`
repairs it. Both belong in a health check.

**It also makes the import much faster:** load rows with the triggers absent, run `'rebuild'`
once, then create the triggers — one index build instead of 1.61M trigger firings.

**What would reverse this.** Storage ceasing to be the binding constraint.

---

## D6 — Explicit `seq INTEGER PRIMARY KEY`

**Decision.** `skills` carries `seq INTEGER PRIMARY KEY` alongside `id TEXT NOT NULL UNIQUE`.

**Why.** This is the sharp edge of D5. External-content FTS5 binds to the content table's
**rowid**. A table whose only key is `id TEXT PRIMARY KEY` still has a hidden rowid — and
`VACUUM` may renumber hidden rowids, which would silently corrupt the mapping between the
index and the rows. Declaring an explicit `INTEGER PRIMARY KEY` makes the rowid an alias of a
real column, so it is stable.

`seq` is never exposed by the API; `id` keeps every response shape byte-identical.

**What would reverse this.** Abandoning external-content FTS5.

---

## D7 — `uuid` → `TEXT`

**Decision.** `id` is `TEXT`, holding the same UUID string the API returns today.

**Why.** SQLite has no UUID type. `BLOB` would be 16 bytes against TEXT's 36 — about 32 MB
saved at 1.61M rows — but it changes what the column contains and every read path that
compares it. Not worth 32 MB out of ~1.5 GB.

**What would reverse this.** Storage pressure at a scale where 32 MB matters.

---

## D8 — `tags text[]` → JSON, with the side table deferred

**Decision.** Tags are a JSON array in a `TEXT` column, queried with `json_each`. No
normalised `skill_tags` table for now.

**Why deferred rather than built.** Measured over 1,000 live rows: **average 0.23 tags per
skill, maximum 1, 77% have none, 2 distinct values in the sample.** Building an indexed side
table for that would be optimising something that barely exists.

**Why it is flagged anyway.** `json_each` filtering is a full scan, which is fine at 4,838
rows and slow at 1.61M. Whether that matters depends on how densely the *imported* corpus
carries frontmatter tags, which is unknown and **measurable from the dataset during the import
phase**. If tags turn out to be common, add
`skill_tags(tag, skill_id) WITHOUT ROWID` — tag-first so lookups are a range scan.

**This is the one place SQLite is genuinely worse than Postgres here**, which had a GIN index
over the array.

**What would reverse this.** The import measurement showing dense tags.

---

## D9 — Partial index and generated column port directly

**Decision.** Keep both.

- `CREATE UNIQUE INDEX … ON skills(content_key) WHERE content_key IS NOT NULL` — SQLite has
  supported partial indexes since 3.8.0.
- `skill_count GENERATED ALWAYS AS (json_array_length(skill_refs)) STORED` — generated columns
  since 3.31. Only the function name changes from `jsonb_array_length`.

---

## D10 — Default search sort becomes `score`

**Decision.** `searchSkillsSchema`'s default sort changes from `installs` to `score`.

**Why.** `install_count` is 0 for every imported row. Leaving `installs` as the default
buries the 4,838 real skills under 1.6M ties in arbitrary order. `score` is a live,
recomputable number that exists for every row, and `?sort=score` already worked — only the
default changes.

**Revision, 2026-09-06 — a text search now defaults to relevance, not popularity.**

`sort` no longer carries a static default. The effective ordering is resolved where the query
is built: **`q` present → `relevance` (bm25); no `q` → `installs`.** An explicit `sort` always
wins, so the old behaviour stays reachable as `?q=…&sort=installs`.

The Postgres path narrowed with `textSearch` and then ordered by `install_count`, so relevance
never entered the ordering at all — it answered "what is popular among things that matched"
rather than "what matches best". Visible on live data: `q=pdf` returned `anthropics/pdf` and
then `dsh-deepread`, `papers-skill`, `puppeteer-skill`, which only mention PDFs in passing.
Ordered by bm25 it returns `pdf-analyzer`, `pdf-merge-split`, `anthropics/pdf`, `ComposioHQ/pdf`,
`minimax-pdf`.

At 1.6M imported rows `install_count` is zero almost everywhere, so popularity ordering would
have degenerated into an arbitrary tiebreak.

**Implementation note.** bm25 is computed in an FTS-only subquery rather than joined and sorted
on directly: it is an FTS5 auxiliary function and SQLite rejects it — *"unable to use function
bm25 in the requested context"* — when the outer query also carries the `count(*) OVER ()` that
returns the unpaginated total. `relevance` is unreachable without a query and falls back to
`installs` if asked for anyway.

**What would reverse this.** Real install telemetry at a volume that makes popularity
meaningful across the corpus.

---

## D11 — `pg_trgm` → FTS5 trigram tokenizer

**Decision.** Replace Postgres trigram fuzzy matching with a second, small FTS5 table over
`name` using `tokenize='trigram'`.

**Why.** SQLite has no `pg_trgm`, and `spellfix1` is not compiled into the Turso build —
checked, it reports only `ENABLE_FTS3,ENABLE_FTS3_PARENTHESIS,ENABLE_FTS5`. The trigram
tokenizer (SQLite ≥ 3.34; Turso is on 3.47) restores substring and typo-tolerant matching for
roughly 50 MB at 1.61M rows.

**Why not just drop it.** Losing fuzzy name matching silently would be a user-visible
regression in the thing the registry exists to do.

---

## D12 — Import from the Hugging Face mirror, cite the Zenodo DOI

**Decision.** Build the corpus from
`huggingface.co/datasets/mvaccargiu/gitskills`, not the Zenodo `.db`.

**Why.** Same data, one third the size — **13.43 GB of Parquet against 44.4 GB of SQLite**,
with identical row counts (3,797,117 artifacts, 282,200 repos). Parquet is columnar and
compressed; the Zenodo file is an uncompressed database carrying its indexes. The mirror is
published by `mvaccargiu` — Vaccargiu, one of the dataset's own authors.

| Table | Shards | Size |
|---|---:|---:|
| `artifacts` | 31 | 6.45 GB |
| `artifact_siblings` | 45 | 6.96 GB |
| `repos` | 1 | 0.02 GB |
| `mining_runs` | 1 | ~0 |

`artifact_siblings` is required, not optional: `validateSkill` scores "referenced resources
exist" and "bundled resources in correct subdirs" from the file list, so omitting it would
make every imported `score` wrong.

**Provenance note for the paper.** Cite the Zenodo DOI (`10.5281/zenodo.21875637`), which is
the citable artifact. The mirror is a convenience for the build.

**Practical note.** Raw Parquet lives on external storage; the **SQLite output is built on the
internal disk**, because exFAT does not implement POSIX file locking and SQLite on it is
unreliable.

---

## D13 — Name collisions resolved by content hash, in three cases

**Decision.** The importer assigns names by this rule. Measurements behind it are in
[REGISTRY_MIGRATION_FINDINGS.md](REGISTRY_MIGRATION_FINDINGS.md) §2.

| Case | Rule |
|---|---|
| **Uncontested** — one distinct content for `(owner, slug)` (~1.40M groups) | bare `owner/name` |
| **Contested, all contents share one description** (42,794 groups) | lowest `file_sha` keeps `owner/name`; the rest become `owner/name-<hash8>` |
| **Contested, descriptions differ** (31,806 groups) | **nobody** keeps the bare name; all become `owner/name-<hash8>`, and bare `owner/name` reports ambiguity |
| **Hand-published rows** (`content_key IS NULL`) | always keep their bare name; an import can never displace one — but see the revision below, this is **vacuous today** |

`<hash8>` is the first 8 hex characters of `content_key`, which is the dataset's `file_sha`.

**Why a hash at all.** 204,923 rows — **12.75% of the corpus** — collide on `(owner, slug)`.
`ON CONFLICT DO NOTHING` keeps one row per group and drops the rest silently: measured,
**123,685 skills (7.7% of the corpus) would vanish**. That is exactly the failure migration 005
exists to prevent, at three times the scale 005 was sized against.

Note the division of labour between the two hashes involved. GitSkills' `file_sha` decides how
many skills *exist* (3,797,117 occurrences → 1,877,981 byte-distinct → 1,610,957 after the
format gates). D13's use of that same hash decides what each one is *called*. It adds and
removes nothing; it only stops rows being lost to naming.

**Why not `owner/repo/name`.** Measured: it resolves **28.1%** and leaves 147,249 rows still
contested, because **53,305 of the 81,238 contested groups are confined to a single repo**. It
would be a breaking addressing change — one the CLI has not even caught up to from 005 — for
less than a third of the problem. Rejected on evidence, not taste.

**Why three cases rather than one.** Because the corpus splits cleanly: **52.7% of contested
groups share a single description** (the same skill regenerated — `Klotzkette` and
`David-Li0406` alone account for groups of 88–115) while **39.2% have a distinct description
per content** (genuinely different skills that happen to share a generic name, like the two
verified `run` skills in `alirezarezvani/claude-skills`). An arbitrary canonical is *harmless*
for the first group and *actively misleading* for the second. One uniform rule would have to
pick which of those two costs to pay everywhere.

**Why "descriptions differ" reports ambiguity rather than picking a winner.** `getSkillByBareName`
already made this call for bare names across owners, and its comment says why: *"silently
resolving to whichever row came back first is how you ship a skill nobody asked for."* D13
applies the same principle one level down.

**Why the canonical is `file_sha`, not score or insert order.** It has to be deterministic and
stable across re-imports, or a rebuild silently reassigns `owner/name` and installed URLs
break. Insert order is not stable. **Score is not stable either** — the scoring function
changed on 2026-09-06 (`7db9620`), and any future change would reshuffle canonicals. `file_sha`
is a property of the bytes and never moves.

**Sizing.** The largest contested group is **115** contents, so 8 hex characters is ample and
the 100-character slug cap is never threatened (the base is truncated to 91 before the suffix).

**What would reverse this.** Nothing cheaply — this becomes a URL contract, and changing it
later renames skills people have installed. If it must change, it needs a redirect table.

### Revision, 2026-09-06 — the live rows are not incumbents

The fourth case was written assuming the 4,838 rows already in the registry were
hand-published and therefore deserved protection. **They are not.** Measured:

| | |
|---|---|
| Skills from a hand-publish | **zero** — all 16 distinct owners are watched-repo owners, the only publisher is `skilldex-official`, and `content_key` is null on every row |
| `install_count` | peaks at **4** |
| URLs already discarded by name collision | **10,929**, all from watched repos (`sickn33` alone: 8,104) |
| Watched repos covered by the corpus | **16 of 17** — two were renamed; `tiandee/awesome-skills-hub` is absent but contains 0 `SKILL.md` |

Every one of those rows came from `scripts/seed.ts` under `ON CONFLICT (owner,name) DO
NOTHING`, which picked winners **by insert order** and silently dropped 10,929 siblings — with
no content hash available to distinguish a duplicate copy from a genuinely different skill.

So grandfathering them would freeze an arbitrary sample as truth and permanently orphan the
rest, while protecting nothing unique: the corpus already covers every watched repo that has
any skills at all.

**Revised:** the incumbency rule stays as *forward-looking* policy — once auth is repaired and
real publishing happens, those skills must never be displaced by an import. But it applies to
nothing today, so **the 4,838 rows are re-derived through D13 like everything else** rather
than grandfathered.

**Carried over regardless:** `install_count`, matched on `source_url`. It is tiny, but it is
the only genuine signal in there and it is what D10 makes the default sort read.

**What this buys.** The 10,929 discarded URLs are reconsidered instead of assumed lost. Many
will dedup away as byte-identical copies, but the genuinely different ones get a hash-suffixed
name rather than silence.

**Credit where due:** this was Pranav's objection, not a review finding. The original rule
would have shipped.

---

## D14 — Imported `source_url` uses `tree/HEAD`, not a branch name

**Decision.** Imported skills get
`https://github.com/{repo_full_name}/tree/HEAD/{dir}` — or the repo root when the SKILL.md is
at the top level.

**Why not a branch name.** The GitSkills `repos` table has **no `default_branch` column**
(`full_name, owner, stars, forks, is_fork, language, license, description, created_at,
pushed_at, metadata_fetched`). Baking in `main` would 404 for every master-default repo, which
is not hypothetical: `ComposioHQ/awesome-claude-skills` is master-default and contributed zero
skills for its entire life because `watched_repos.branch` said `main`. Discovering the real
branch would cost one API call per repo — 282,200 of them.

**`HEAD` resolves server-side.** Verified against that same repo:

| Request | Result |
|---|---|
| contents API `?ref=HEAD` | **200** |
| contents API `?ref=main` | **404** |
| `github.com/…/tree/HEAD` | **200** |
| `fetchSkillFromGitHub` on real dataset paths | **works** — name and file list returned |

It is also more durable than a branch name: a repo that renames its default branch keeps
working, where a stored `main` or `master` silently rots. The dead-link reaper has less to do.

**⚠ The trap this creates, and the order that avoids it.** `scripts/seed.ts` builds
`tree/{branch}/{dir}`, so the same skill has two spellings depending on which code wrote it. If
the seeder ran against a HEAD-based registry it would consider every skill new and re-fetch the
lot — the exact double-count hazard already recorded for phase 8.

The sequence must therefore be:

1. Import writes HEAD-based urls into the freshly built database.
2. Cut over to that database.
3. **Only then** switch `seed.ts` to HEAD.

Doing (3) first, against the current registry's 15,767 `tree/main` urls, would orphan all of
them at once. Once the seeder is on HEAD, `watched_repos.branch` stops being load-bearing for
url construction — and the tree API accepts `HEAD` too, so the ComposioHQ failure mode
disappears entirely.

**What would reverse this.** GitHub dropping `HEAD` as a ref alias, which would break far more
than this registry.

---

## D15 — `total` becomes a bounded count with an explicit relation

`searchSkills` returned the unpaginated total with `count(*) OVER ()`. At 4,863 rows that was
free. Measured against the 1.6M-row corpus:

| Query | Time |
|---|---|
| Default listing **with** the window function | **>90s — timed out** |
| Same without it | 2.9s |
| Bounded count, cap 10,001 | **1.0s** |

An empty `OVER()` declares one partition spanning the result set, so the engine must
materialise every matching row before it can emit the first — `LIMIT 20` cannot push below it.

The deeper reason it cannot simply be optimised: **ranked retrieval admits early termination
and counting does not.** Once you hold k candidates and can prove nothing unseen beats the
k-th, you stop — that is WAND, MaxScore, block-max. That proof says which documents win, never
how many match. Demanding an exact total forfeits all of it. Elasticsearch made
`track_total_hits: 10000` the default in 7.0 for exactly this reason, so block-max WAND could
be switched on.

**Decision.** Adopt the same contract:

| Case | Source of `total` | `total_relation` |
|---|---|---|
| No filters, no `q` | precomputed `registry_stats` row | `eq` |
| Filtered, < cap | bounded count | `eq` |
| Filtered, ≥ cap | bounded count clamped to cap | `gte` |

`total_relation` is the load-bearing half. A capped count without it is a wrong number served
confidently; with it the API is honest and the client renders "10,000+". Solr's
`numFoundExact` and Algolia's `exhaustiveNbHits` are the same idea.

`has_more` comes from a `limit + 1` fetch — free, exact at any N, and what pagination actually
needs. Page and count go out in one `db.batch()`, so this remains one HTTP round trip; latency
is dominated by the Turso hop (~8 ms query vs ~300 ms response), so two requests would have
been a real regression.

`MAX_OFFSET` is set equal to the cap. Any other value makes the API contradict itself —
reporting `total: 10000, "gte"` while still serving `offset=15000`.

**Never fall back to `count(*)`** when the stats row is missing. That reintroduces the 90s
timeout in precisely the case the design exists to prevent, on the hottest path in the API.
The fallback is the bounded count.

**What would reverse this.** A storage engine that can count matches without enumerating them,
or the corpus shrinking to where an exact count is cheap. Neither is in view.

---

## D16 — A `source` column, and a curated/corpus split

Measured on the merged 1,615,322-row build. Every orderable dimension is degenerate:

| Dimension | Whole corpus | In the curated tier |
|---|---|---|
| Rows | 1,615,322 | **4,863** |
| `trust_tier = 'verified'` | 7 | **7 — all of them** |
| `install_count > 0` | 33 | **33 — all of them** |
| Tagged | 2,106 (0.13%) | **2,106 — all of them** |
| Distinct `published_at` days | 51 | **51 — all of them** |
| Distinct owners | 158,915 | 17 |
| `score` 90–100 | 1,345,829 (83%) | — |

99.7% of rows share one `published_at` — the import timestamp. 83% score 90–100. Only 33 rows
in 1.6M have ever been installed. **The imported corpus contributes no ordering signal at all**,
and "top owners" is actively misleading: `majiayu000` (31,523 skills), `David-Li0406` (27,006)
are bulk uploaders, not highlights.

So sorting the whole corpus is meaningless, and the only non-degenerate ranking is bm25 against
a query.

**Decision.** Add `source TEXT NOT NULL DEFAULT 'seeded' CHECK (source IN ('seeded',
'imported', 'published'))`, exposed as an optional `?source=` filter.

### Revision, 2026-09-06 — the filter must not be defaulted

As first shipped this defaulted to the seeded tier, on the reasoning above. **That was wrong,
and it was live for one deploy.**

The measurement supports "sorting an unfiltered list of 1.6M rows is meaningless". It does not
support "search should be scoped", and those are different operations. bm25 ranks perfectly
well across the whole corpus — relevance is the one signal that is *not* degenerate. Defaulting
the filter meant `/v1/skills?q=…` searched 4,863 of 1,615,322 rows, i.e. 0.3% of the registry,
which defeats the entire point of importing the other 99.7%.

"Curated" was also the wrong word. Those 4,863 rows are not editorially selected; they are
whatever happened to be in the 17 repos on the watch list. The parameter now takes the column's
own values (`seeded` / `imported` / `published`), which are factual, and defaults to unset.

**What this costs.** D15's cheap path no longer applies to the default listing. It does not need
to: an unfiltered listing reads the precomputed total in O(1), and the page itself is a top-20
index walk. The bounded count only binds on a filtered query, which is where it belongs.

**Where the split still earns its keep.** The landing page's category strips — verified, most
installed, recently added — read the whole registry and work anyway, because the rows carrying
signal sort to the top on their own. `source` remains available as a filter, and the partial
indexes still serve a seeded-scoped browse from ~4.8k entries when one is asked for.

**Why a column and not `content_key IS NULL`.** That test is correct today only because
`seed.ts` happens not to set `content_key`. It is an accident of the import, not a stated
contract, and silently wrong the first time the seeder changes.

**What would reverse this.** Real install counts, real publish dates and dense tags across the
corpus — i.e. the imported rows acquiring signal of their own. Stamping a genuine commit date
in `build.ts` would recover `sort=recent` alone.

---

## D17 — The browse page becomes search-first; numbered pagination goes

1.6M skills is 80,766 numbered pages, and `OFFSET` is O(offset), so the deep pages could not
be served at any speed. Capping the control is not enough — a 500-page picker over a corpus
with no ordering signal is a control nobody can use.

**Decision.** Landing state shows four curated strips, all scoped to the curated tier where the
signal is; results state shows a ranked list with a "Load more" button and a
`Curated | All skills` scope toggle. Skill URLs become `/registry/[owner]/[name]`.

Precedent at this scale is consistent: npm (~3M) has no browse-all page at all; Hugging Face
(~1.5M) is search plus facets plus infinite scroll; GitHub's search API caps at 1,000 results.

**Full enumeration is not lost.** Keyset pagination — carrying the last sort key rather than an
offset — walks the whole corpus at constant cost per page. What is given up is *random access
to page N*, which nobody does, not sequential traversal.

**Load more is a Route Handler, not a Server Action.** Actions are POSTs: uncacheable,
serialised, and carrying the action-id protocol for what is an idempotent read. A GET is
cacheable at three layers and testable with `curl`. It also keeps `REGISTRY_URL` server-side.

**Owner-scoped URLs are not optional.** 41.5% of corpus names collide, and the legacy endpoint
answers a contested name with 409 — which the site was collapsing into a 404. Note `[name]`
and `[owner]` cannot coexist at the same segment position in the App Router; that is a build
error, so the directory is renamed rather than added alongside.

**What would reverse this.** Only making the corpus browsable in a way that is genuinely
useful, which requires ordering signal that does not exist.

---

## D18 — Takedown removes the row; it does not flag it

Phase 7, and the gate on the imported corpus becoming publicly searchable. The corpus spans
158,915 GitHub accounts, essentially none of which submitted anything to Skilldex.

The obvious design is `delisted INTEGER NOT NULL DEFAULT 0` plus a filter. The backlog's own
line on it is the argument against: *"an inert flag is worse than none."* A flag has to be
remembered by `searchSkills`, `searchSkillsets`, `getSkill`, `getSkillByBareName`,
`incrementInstallCount`, `refreshStats`, the sitemap, and every read path written afterwards.
One missed filter silently republishes content someone asked to have removed, and nothing fails
loudly when that happens.

**Decision.** A `delistings` table is the authoritative record, and matching rows are **deleted**
from `skills`. Search, install and every future query honour a takedown for free, because there
is nothing left to honour. Three scopes — owner, repo, skill — because "remove everything of
mine" is the request that actually arrives, while repo matches how the corpus is shaped and
skill handles the single-file case.

**The tombstone is what makes it stick.** Deleting rows alone would last exactly until the next
corpus rebuild. `scripts/seed.ts` and `scripts/corpus/build.ts` both consult the table before
inserting, `scripts/corpus/merge-live.ts` copies it into a freshly built database, and
`POST /v1/skills` refuses to publish into a delisted namespace so the rule cannot be undone by
accident.

**Repo matching uses a prefix comparison, not LIKE.** `_` is a LIKE single-character wildcard,
so a takedown for `acme/my_repo` would also match `acme/myXrepo` and remove an unrelated
repository. Comparing a substring of equal length is exact and needs no ESCAPE clause.

**What it costs.** Install counts do not survive a re-listing — the row carrying them was
deleted. That is the acknowledged price of a guarantee that cannot be forgotten, and re-listing
is rare.

**What would reverse this.** A need to restore delisted content with its history intact, which
would mean an archive table rather than a flag — the flag design does not become correct.

---

## D19 — Provenance filters carry the partial index's predicate as a conjunct

`WHERE source = 'seeded'` on the 1.6M corpus took **87 seconds**. The same rows with
`WHERE source <> 'imported' AND source = 'seeded'` take **1.15 seconds**.

The cause is that SQLite matches partial indexes **syntactically**. `skills_curated_installs_idx`
is declared `WHERE source <> 'imported'`; a query asking for `source = 'seeded'` implies that
predicate logically, but the planner does not derive the implication, so the index is not
eligible and it falls back to `SCAN skills`.

**Decision.** The query builder emits `s.source <> 'imported' AND s.source = ?` for any value
other than `'imported'`. The first conjunct exists purely to make the index eligible; the
second narrows to the exact value, which matters because 'seeded' and 'published' are different
things and a query for one must not return the other.

`'imported'` is deliberately excluded from this treatment. It is 99.7% of the table, so there is
no small side to seek: the bounded count reaches its cap within milliseconds and the page query
is served by `skills_install_count_idx` (266ms measured).

The alternative — a plain index on `skills(source)` — was rejected. It would carry an entry per
row for a column with three values, adding tens of megabytes to a database that already sits at
1.89 GB against a 2 GB `--from-file` ceiling, and 001 already cut 192 MB of indexes to fit.

**Why this matters beyond one query.** A filter that is *supposed* to narrow to 0.3% of the
table instead scanning all of it is a denial-of-service vector against our own API, reachable
from a public query parameter. It is invisible below about a million rows.

**What would reverse this.** SQLite gaining implication analysis for partial-index matching, or
the ceiling ceasing to bind so a plain index becomes affordable.

---

## What this migration loses

Recorded honestly, so none of it is discovered later as a surprise.

1. **PostgREST's generated REST layer.** `supabase-js` goes away and `src/db/*` is written
   against `@libsql/client`. This is also a gain: the PostgREST 1000-row cap has already
   caused two bugs here, and real SQL makes the per-repo anti-join straightforward.
2. **Supabase Auth.** Replaced by direct GitHub OAuth plus a self-issued JWT. Note this is a
   *repair*, not a port — `upsertPublisher` never sets `publishers.id`, while `requireAuth`
   looks the publisher up by the Supabase auth user id, so the two never match and every
   authenticated request already fails. Everything in the registry today arrived through
   `seed.ts` using the service key, which bypasses auth entirely.
3. **Array columns with a GIN index** — see D8.
4. **`pg_trgm`** — see D11.
