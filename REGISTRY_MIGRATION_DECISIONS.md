# Registry Migration — Decisions

Why the registry is moving off Supabase/Postgres to Turso/SQLite, and the design calls made
along the way. Task tracking lives in [REGISTRY_MIGRATION_BACKLOG.md](REGISTRY_MIGRATION_BACKLOG.md);
corpus measurements in [FINDINGS.md](FINDINGS.md); import state in [IMPORT_STATUS.md](IMPORT_STATUS.md).

Each decision records what would reverse it. Nothing here is permanent — the corpus can be
rebuilt from the dataset DOI at any time.

**Status, 2026-09-06: cut over.** The registry serves 1,615,322 skills from
`skilldex-registry-v2`. `skilldex-registry` (4,863 rows) is retained as the rollback target and
must not be deleted. Verification in
[REGISTRY_MIGRATION_FINDINGS.md](REGISTRY_MIGRATION_FINDINGS.md) §13.

**Status, 2026-09-15: blocked.** Turso blocked the account for exceeding the Free plan's 500M monthly
row reads, and every database-backed endpoint failed. Cause and measured costs in
[REGISTRY_MIGRATION_FINDINGS.md](REGISTRY_MIGRATION_FINDINGS.md) §16; fixes D25–D29.

**Status, 2026-09-17: fixed on a branch, not deployed.** D25–D29 are on `fix/quota-query-costs`,
verified against a local copy of the corpus. The plan is to move the database to a temporary Turso
account until the 2026-10-01 reset (REGISTRY_MIGRATION_BACKLOG.md Phase 10).

**Status, 2026-09-17, later: moving to a temporary account (D30).** Export from the blocked account is
itself blocked, so the temporary database is built from the 2026-09-06 corpus file and loses what
production wrote between the cutover and the block. D26 gained a sixth fix (search with a broad
filter).

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

> **Superseded 2026-09-17 by D28 — `skills_trgm` is dropped in migration 005.** The regression this
> guarded against could not happen, because fuzzy name matching was never served on either stack. On
> Supabase, `skills_name_trgm_idx` (`gin_trgm_ops`) existed in the schema but no query used it: search
> was `textSearch("name, description", q)`, which is full-text, and no commit in `src/` or `api/` ever
> used `ilike`, `similarity()` or a trigram operator. On Turso, no commit ever queried `skills_trgm`;
> it was only built, rebuilt and integrity-checked by scripts, and the migration's API parity check
> compared full-text queries only. No client — CLI, site or MCP server — offers substring or
> typo-tolerant search. What the table did cost was real: 115 MB, not the ~50 MB estimated above, and
> a row on every insert, update and delete. Building typo-tolerant name search is a new feature that
> starts by recreating this table (D28).

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

## D20 — The nightly sync watches the corpus by polling, and prioritises by evidence

Decided 2026-09-07. The plan is [REGISTRY_SEED_PLAN.md](REGISTRY_SEED_PLAN.md).

The registry holds skills from **220,607 repositories** (FINDINGS §14); the seeder watches 17. One
REST call per repository is ~44 hours per pass, so the existing design cannot run nightly.

1. **No webhooks for the corpus — polling is the only mechanism, not a preference.** GitHub delivers
   push events only to a webhook a repository admin created or an App an admin installed, and
   watching a repository does not notify on push. We administer none of 158,915 owners. A GitHub App
   is worth building for deliberate *publishers* — as a publishing feature, not corpus freshness.
2. **Detection and fetch are separate.** Detection — did the repository move — by a GraphQL sweep
   aliasing ~100 `repository` lookups per query, ~2,207 queries for the corpus (estimated). Fetch —
   what moved — by `/compare/{old}...{new}`, which returns changed paths and reports deletions.
3. **Priority comes from measured properties, never provenance.** Observed change rate, demand and
   recency, in one function over every repository. The 17 in `watched_repos` are the small corpus
   that happened to be on hand before the import, **not a curated set**, and must not become a
   permanent tier. Their hand-assigned `trust_tier` and `tags` are metadata labelling and do not
   leak into crawl priority. This is the same error as defaulting search to those rows (FINDINGS §9,
   the revision on D16), caught a second time.
4. **A separate freshness ledger** (`repo_heads`); `watched_repos` stays the editorial layer.
5. **Phase 8 lands first.** A `source_url` mismatch would make the first sweep treat the whole
   corpus as new, and each insert fires the FTS5 triggers across two tables.

Two numbers gate the design and neither is measured: the daily change rate, and the real GraphQL
point cost of a batched query. The 1-point-per-query figure is inferred from GitHub's formula, not
read as stated.

**What would reverse this.** GitHub offering push notification for public repositories one does not
administer; or the cost probe showing per-alias charging, which moves detection to GH Archive.

---

## D21 — The rollback database stays, and is migrated before any repoint

Decided 2026-09-07. The procedure is [CAUTION.md](CAUTION.md).

`skilldex-registry-v2` is live; `skilldex-registry` is kept as the rollback and must not be deleted.
But migration 004 (skillset coherence) was applied to v2 on 2026-09-07 and never to the rollback, so
repointing at it no longer yields a working API. The failure is partial — plain skillset listing
degrades to nulls while publish, `sort=coherence` and `min_coherence` return 500 — so a smoke test
can pass.

**Decision.** A rollback migrates the old database first, then repoints both `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN` (tokens are per database). `migrate --dry-run` against it lists whatever is
missing, so the procedure stays correct as migrations accumulate.

**Recommended, not adopted:** apply schema-only migrations to both databases while the rollback is
still a rollback. 004 took 5 seconds.

**What would reverse this.** Retiring the rollback database once confidence in v2 is established.

---

## D22 — `rescore.ts` writes to Turso, and covers curated rows only

Decided 2026-09-15.

`rescore.ts` is the only way to re-score a row already in the registry, and since the 2026-09-06
cutover (§13 in [REGISTRY_MIGRATION_FINDINGS.md](REGISTRY_MIGRATION_FINDINGS.md)) it had been writing
to Supabase. The registry has served from Turso since that date, so every run updated a database
nothing reads: the tool that exists to repair score drift was itself the reason the drift could not
be repaired. Ported to `getDb()`.

**Scope is curated rows** — `source <> 'imported'` — with `--include-imported` as a deliberate
opt-in. Imported rows are 1,610,459 of 1,615,322, each already scored at import time by
`scripts/corpus/build.ts`. Re-scoring one costs a GitHub round trip, and at the script's own 300ms
pacing the corpus would take about 5.6 days; worse, every UPDATE fires `skills_au` and rewrites both
FTS5 tables for that row, which is what the note at the foot of `schema/sqlite/002_source_and_stats.sql`
warns against. The repair path for imported rows is a rebuild and swap, not this script.

**A resume bug fixed with it.** The loader ordered by `(owner, name)` while the checkpoint stored the
name alone. Names are unique only within an owner, and 41.5% of bare names collide, so on resume
every later owner's skills sorting before the checkpoint name were filtered out as already-done and
silently skipped. The checkpoint now carries `(name, owner)`, and the query orders and pages by that
pair — keyset, not OFFSET, since `--include-imported` walks a 1.6M-row table. A checkpoint file
without the owner half is ignored rather than trusted.

**Not fixed here.** The nightly seeder still never re-scores an existing row — `INSERT ... ON CONFLICT
(owner, name) DO NOTHING` — so an edited skill keeps its first score until someone runs this script.
Whether the seeder should re-score when `blob_sha` changes is open; see [BACKLOG.md](BACKLOG.md).

**Untested.** The script self-executes on import, so the checkpoint comparison has no unit test. It
would need the run guarded behind an entry-point check first.

**What would reverse it.** Nothing about the target. The curated-only default moves if the corpus
ever gains a re-score path that does not go through GitHub.

---

## D23 — The two validators converge on one set of semantics, pinned by the conformance corpus

Decided 2026-09-15.

`src/validator/index.ts` says of itself that it "mirrors skilldex's src/core/validator.ts as of
skillpm v1.1.2". The CLI is at 1.5.0, and the two had drifted in four places. A skill's score
therefore depended on which surface scored it — the registry's stored number, or what the author saw
from `skillpm validate`.

Each difference is settled on its merits rather than by declaring one side canonical. Two went the
registry's way, two the CLI's:

| Check | Was | Now | Which side moved |
|---|---|---|---|
| Referenced files (7) | Registry kept `#anchor`, `"title"` and ` --flag` in the path and looked only inside `scripts/`, `references/`, `assets/`. skilldex reported any link target as a file, so `[image](raw_image)` was a broken reference | One `normaliseReference` in both: strip the anchor, the title and anything after whitespace; ignore URLs, other schemes and bare anchors; treat a target with neither a directory part nor an extension as not a reference; `../` leaves the skill and is reported missing | Both |
| Allowed subdirs (4) | skilldex counted `.git` and `.github` as unknown subdirectories | Dot-directories are not part of the skill | skilldex |
| Bundled files (2) | skilldex looked only at the top level of a bundled folder | Every depth, as the registry always did | skilldex |
| Extension case | Registry compared case-sensitively, so `references/Setup.PY` passed | Lowercased before comparison | Registry |
| Frontmatter fence | Registry required `---` exactly and scored `--- ` as 0 | A trailing space is a legal marker | Registry |

**Scores move.** A skill with an anchored, titled or command-shaped reference gains up to 7. A skill
referencing a file outside its own folder loses 7 where the registry had not been looking. A skill
whose fence carries a trailing space goes from 0 to whatever it deserves. A skill at a repository
root gains up to 4 from `skillpm validate`, and one hiding a script deeper in `references/`, or
spelling its extension in capitals, loses 2.

**Stored scores do not move with it.** Nothing re-scores on deploy: imported rows keep the numbers
`build.ts` gave them, and curated rows keep theirs until `rescore.ts` runs (D22). Until then the
registry serves scores computed under the old semantics — which is a smaller gap than it sounds,
since the corpus was never scored by the CLI at all, but it does mean the fix and the data land at
different times.

**What kept them apart is now covered.** The shared conformance corpus
(`tests/conformance-corpus/manifest.json`, generated from skilldex's fixtures) had anchored, titled
and inline-code cases, but every one pointed at a *missing* file — where both validators agreed, so
the divergence was invisible. Ten fixtures now cover those shapes pointing at files that exist, plus
the dot-directory, nested and uppercase-extension cases and the trailing-space fence. Reverted
against this file, four of them fail here.

**The structural fix followed immediately** — see D24. The convergence had to land first: extracting
a shared module while the two copies disagreed would have meant choosing a winner for each of these
five rows inside a large file move, unreviewably. With them agreed and the corpus pinning them, the
extraction moved no score at all.

**What would reverse it.** A published rubric change. The corpus is regenerated from skilldex and
re-vendored here, and both suites move together.

---

## D24 — The rubric leaves both repositories for `@skilldex/validator`

Decided 2026-09-15, immediately after D23.

`src/validator/index.ts` carried this note from the day it was written: *"Extract to
@skilldex/validator package when drift becomes a real problem (i.e. you have fixed the same bug
twice)."* The same bug has now been fixed twice — the inverted count-down loop (2026-07-09 to
2026-09-04) and the five differences in D23 — so the condition it named is met.

**What moved.** The eleven scored checks, the weights, the breakdown and the reference, structure and
frontmatter rules are now `@skilldex/validator`, a pure function over `{ skillMd, files }`. Pure
because that is the only shape both callers can supply: this registry scores rows whose files it
knows only as a stored list and has no filesystem to walk.

**What stayed.** This file is now an adapter, and owns exactly one rule — how a diagnostic is shaped
on the wire. The rubric reports a `pass` for every check that succeeds, which is what
`skillpm validate` prints; the API has only ever carried what is wrong, so passes are dropped here
rather than in the rubric, where the CLI needs them. skilldex keeps the other adapter: find the
folder, read SKILL.md, list the files.

**It changed no score.** The conformance manifest regenerated byte-identical, and all 41 corpus cases
pass on this side. Three of this repository's own unit tests did change, and all three were asserting
the old copy's wording or severity rather than its arithmetic: two matched message text that the
shared rubric phrases differently, and one expected a short description to be reported as an `error`.
It is a `warning` now, as `skillpm validate` has reported it since 1.5.0 — the specification sets no
word minimum. The score is unchanged either way, since points are awarded on pass, and `publish` does
not gate on level, so nothing that was accepted is now rejected or the reverse.

**Deployment order, which is not optional.** This repository's Vercel build installs from npm, so it
cannot deploy until `@skilldex/validator` is published. Publish, then `npm install` here, then merge,
then deploy.

**The skillset rubric went with it, and it was not as clean as it looked.** `skillset.ts` was
assumed to be drift-free because the conformance corpus pins it. Reading the two side by side to
extract them found two differences the corpus could not see, both the same ones the skill validator
had: this copy required the frontmatter fence to be exactly `---`, where a trailing space is a legal
document marker, and it reported a short description as an `error` where `skillpm validate` reports a
`warning`. The corpus missed them because no fixture opens with `--- ` and severity does not move a
score. Settled the same way as on the skill side.

**Coherence moved too, and cost nothing.** `skillset-coherence.ts` was a 702-line port carrying a
header about having been "diffed function-by-function and run against every real skillset to confirm
identical output". It had already abstracted its I/O behind `CoherenceSource`, so the checks never
knew whether bytes came from a working tree or a fetched blob — which is exactly why it could become
the shared implementation unchanged. The 31 lines left here re-export it;
`src/routes/skillsets-publish.ts` still supplies the GitHub-backed source, so the trust-boundary
argument for computing coherence server-side is untouched.

**What the move cost in total.** Roughly 2,800 lines of rules held in two copies became 1,711 lines
in one, plus about 455 lines of adapters across both repositories. In this one: 368 → 61 for skills,
201 → 70 for skillsets, 702 → 31 for coherence.

**What would reverse it.** Nothing foreseeable. The failure mode it removes is the one that has
already happened twice.

---

## D25 — Nothing runs against production except production traffic

Decided 2026-09-17.

Between 2026-09-06 and 09-13 the registry read ~500M rows and the account was blocked (FINDINGS §16).
The heaviest days were working days: acceptance testing on v2 while the listing still read 6.46M rows
per request, CLI development, and experiments issuing hundreds of cold searches. The query shapes made
each request expensive; running development against production turned that into a bill.

**Decision.** Tests, fixes, measurements, experiments and one-off scripts run against a local copy of
the corpus, served by `sqld` on loopback, with the API pointed at it explicitly. npm scripts that load
`.env` are for real administration only, because `.env` holds the production credentials. Experiments
that fan out queries — E4a, E4b — point the CLI at a local registry through `SKILLDEX_REGISTRY_URL`.
The recipe is in LOCAL_REGISTRY.md.

**Why `sqld`, not a `file:` URL.** The API uses `@libsql/client/web`, which speaks HTTP only. And `sqld`
reports rows read and written per statement with the accounting Turso bills, so a change's cost is
measured before it ships — every number in D26–D29 came from it.

**What it does not cover.** Latency: a local run has no network hop and no contention, so E4c's latency
figures stay production-only. And data written to production after the cutover, which the local copy
lacks.

**What would reverse it.** A plan so large that a test run is noise. Even then, measuring cost locally
is worth keeping.

---

## D26 — A query shape is judged by the rows it scans, not how long it takes

Decided 2026-09-17.

At per-row pricing a query can be quick and ruinous. Five shapes each scanned between 48K and 3.2M
rows per request (FINDINGS §16). Each fix below returns identical results. That was checked against
the SQL it replaced: on fixtures in tests/unit/query-costs.test.ts, and through the real API across 36
request shapes on the full corpus.

1. **Tag filter.** `EXISTS (… json_each(s.tags) …)` walked the table: 3,229,704 rows. Only curated rows
   carry tags — `build.ts` inserts every imported row with `tags` NULL, and `refreshTagCounts` already
   relies on that — so the filter now adds `s.source <> 'imported'`, and the curated partial indexes
   serve it (D19's conjunct). Two sorts have no curated index in their order, `score` and `name`. For
   those the ordering is written `+s.score` / `+s.name`: the unary plus keeps the full-table indexes out
   of the plan, so SQLite reads the curated index and sorts at most ~4,863 rows. 8,786–14,086 rows
   read now.
   ⚠ This encodes an invariant. An importer that writes tags on imported rows would have them
   silently excluded from tag filters.
2. **`tier=community`.** 99.7% of the table, so `skills_trust_tier_idx` was the worst access path
   available: fetch every community row, then sort. `+s.trust_tier = ?` walks the sort index instead
   and stops at the page — 3,240,634 → 1,024. `verified` keeps the index.
3. **`spec_version`.** Nothing indexed it, so a version matching nothing scanned the table twice
   (3,230,646). Migration 005 adds `skills_spec_version_other_idx`, a partial index holding only the
   rows off 1.0, and any other version carries the predicate as a conjunct: 4–5 rows. Rejected:
   validating against `spec_versions`, which lists only 1.0 while one skill is on 2.1 and would be
   hidden; a full index, which is 1.6M entries to find a handful.
4. **Relevance search.** Scoring every match and sorting outside FTS5 read up to 879,555 rows. With no
   other predicate the subquery now orders by FTS5's own `rank` (bm25 with default weights, the same
   function) under the LIMIT, so only the page is joined: 1,064. Rejected: a rowid tiebreak inside the
   subquery, which takes FTS5 off that path (589,744); capping how many matches get ranked, which
   changes results.
5. **Search within the curated tier.** A search with a tag, or with `source=seeded`/`published`,
   started from every FTS5 match and joined each to `skills` before the curated filter threw
   nearly all of them away: `q=skill&tags=terminal` read 1,159,590 rows. It now starts from the
   curated partial index, with `CROSS JOIN` pinning the order, and probes FTS5 by rowid for each row
   — 14,094, identical pages and totals across 22 shapes. Its cost is bounded by the size of the
   curated tier (~4,863 rows) rather than by how much the term matches, so a term that matches
   nothing now reads ~12K rows instead of a handful: accepted, as a fixed ceiling beats a cost that
   grows with the term.
6. **Search with a broad filter.** `tier=community` keeps all but 7 rows and `source=imported` 99.7%,
   so filtering after ranking discarded almost nothing, and the whole cost was ranking every match:
   `q=skill&tier=community` read 871,547 rows. Such a search now ranks a window inside FTS5 — twice
   the rows the page needs — filters it, and falls back to ranking every match only if the window
   comes up short. It cannot come back wrong, only short: FTS5 yields the window in the full
   ranking's (rank, rowid) order, so the window's surviving rows are a prefix of all surviving rows.
   A page of limit + 1 rows is therefore right, and so is a shorter one when the exact count says
   nothing follows it. A capped count cannot say that, so a short page under one reruns. On the
   corpus a curated row almost never ranks that high (at most 14 in the top 2,002 across 30 terms), so
   the fallback is a safety net: ~2K rows read, most of it the capped count, with identical pages and
   counts in 249 of 249 SQL comparisons (48 forced to fall back) and 49 of 49 API responses. Rejected:
   sizing the window from `skills_verified`/`skills_curated`, which is exact without a fallback but
   ties the query to the stats table. A filter that narrows — `tier=verified`, `owner`, `min_score`,
   `spec_version` — and any explicit sort still rank every match (BACKLOG.md).
7. **How it stays fixed.** The tests assert query plans, not timings. With no `sqlite_stat1` — neither
   the test database nor production has one — SQLite plans against the same default size estimates
   whatever a table holds, so a fixture gets production's access path.

**What would reverse it.** Running `ANALYZE` on production: plans could change, and the plan tests
must be re-run with statistics present. A normalised tags table (D8) would retire fix 1. Fix 6 depends
on its filters staying broad: if verified or curated rows came to dominate the top of the ranking,
the window would fall back often, still correct but paying for the window and the full ranking.

---

## D27 — The count cap and the deepest offset drop from 10,000 to 1,000

Decided 2026-09-17, by Pranav.

The capped count is the floor on what any filtered listing or search reads: stopping at 10,001 reads
10,001 rows. Once D26 fixed the shapes, that floor was most of what a typical request cost — a
relevance search read ~10,062 rows at a 10,000 cap and 1,064 at 1,000.

`MAX_OFFSET` must equal the cap (`src/db/pagination.ts`), so no listing or search pages past 1,000
either. What changes for clients: a total above 1,000 reads `"total": 1000, "total_relation": "gte"`,
rendered "1,000+"; `offset` above 1,000 is a 400. Skilldex-web takes `max_offset` from the response.
skilldex-cli now reads `total_relation` and prints "Found 1,000+ skills", and its MCP search tool
passes the relation through (not yet released).

**What would reverse it.** A plan where 10K rows per request is noise, or a real need for deep paging —
which is better met by cursors or an export than by a larger offset.

---

## D28 — FTS is rewritten only when indexed text changes, and `skills_trgm` goes (migration 005)

Decided 2026-09-17.

`skills_au` fired on every UPDATE, so an install or a rescore deleted and re-inserted the row in both
FTS5 tables: 6–7 rows written for a one-column change. It is now `AFTER UPDATE OF name, description`,
the two columns FTS indexes, and an install writes 2–3.

`skills_trgm` was built for substring and typo-tolerant name matching (D11), and nothing ever queried
it (Phase 9 already recorded it as unreachable). D11's reason for keeping it — that dropping it would
silently lose fuzzy matching — does not hold: that matching was never served, on Supabase or on Turso
(see the note on D11). It held 115 MB and added a row to every insert,
update and delete, so it is dropped. Rebuilding it from `skills` is possible if that feature is built;
measure its write cost first.

005 also adds `skills_curated_name_idx`, which `rescore.ts`'s curated walk needed (4,747,852 → 14,863
rows read), and the spec-version index from D26.

**Applied to a file, never to the hosted database.** Applying 005 read 3,235,804 rows, the two
`CREATE INDEX` scans, and freed 115 MB that only `VACUUM` returns. The corpus database is prepared
locally and created with `turso db create --from-file` (CAUTION.md §5).

**The corpus build had to learn trigger order.** `build.ts` deferred every `CREATE TRIGGER` until the
rows were loaded. With 005 the triggers are a sequence — created in 001, dropped and re-created in
005 — and replaying only the CREATEs fails on the second `skills_au`. `isTriggerDdl` defers `DROP
TRIGGER` too and runs both in migration order; a test pins that the end state matches applying every
statement in order.

**What would reverse it.** Building typo-tolerant name search.

---

## D29 — `refreshStats` derives the imported count and recounts owners weekly

Decided 2026-09-17.

Two of the six headline figures were full scans, run by the seeder every night: `skills_imported`
(1,615,322 rows) and `count(DISTINCT owner)` (1,615,322 rows).

**Decision.** `skills_imported = skills_total - skills_curated`, which is exact because `source` is
CHECK-constrained to three values. `owners_total` is recounted only when the stored value is older than
seven days; scripts that build a local file pass `ownersMaxAgeMs: 0`. A refresh now reads 8,836 rows
instead of 3,239,480. At a nightly cadence that is ~97M rows a month down to ~7M, nearly all of it the
weekly owner count.

A skipped owner count keeps its old `updated_at`, and `/v1/stats` reports the stalest key, so the
response says honestly that one figure may be a week old.

**What would reverse it.** An owner count people rely on day to day, or one maintained incrementally
on publish and delete.

---

## D30 — Serve from a temporary Turso account until the reset, built from the 2026-09-06 file

Decided 2026-09-17, by Pranav.

The original account stays blocked until quotas reset on 2026-10-01. The plan was to export
`skilldex-registry-v2` and upload it to a new account, but an export is a read, and it is refused:
`turso db export` fails with "SQL read operations are forbidden".

**Decision.** Serve from a new account's `skilldex-registry-v2`, in a group in `aws-us-east-1`, the
region the original was in. It is created with `--from-file` from `build/registry.db`, the file the
original was created from on 2026-09-06, brought to the current schema locally:
`prepare-corpus-db.ts`, `migrate.ts` (004 and 005), then `VACUUM`. The result is 1,771,839,488 bytes,
under the 2 GB `--from-file` limit; `quick_check` and both FTS integrity checks pass, and its row
counts match the cutover pre-flight (FINDINGS §13, §17).

**What it loses.** Everything production wrote between the cutover and the block, which the file never
had:

- the three official skillsets, published 2026-09-09 — republish them from Skilldex-skillset;
- nine days of install counts;
- publisher rows from GitHub sign-ins — those people sign in again;
- any skill published, delisting recorded or repo added in that window. **Delistings matter most**: a
  missing one puts back content someone asked to have removed. Confirm none was recorded before the
  temporary database serves traffic.

**Order.** Deploy the D26–D29 code first; creating the database costs no reads, but pointing the
old query shapes at a fresh quota burns it the same way. Then swap `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN` together in Vercel and redeploy.

**Moving back is a merge, not a swap.** After the reset the original database holds the 2026-09-06 to
09-15 writes and the temporary one holds everything written since the move; neither contains the
other. Export both, merge the small tables locally — publishers, skillsets, published skills,
delistings, and install counts as deltas over the 2026-09-06 file — upload the result with
`--from-file`, and delete neither database until that is verified. The usage alarm and longer edge
caching (BACKLOG.md) are applied after the move back.

**What would reverse it.** Upgrading the original account instead. Turso's block message points at
upgrading, and the Developer plan ($4.99 a month, 2.5B reads) would keep every row and need no move.

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
