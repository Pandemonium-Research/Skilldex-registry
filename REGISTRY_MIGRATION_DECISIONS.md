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
