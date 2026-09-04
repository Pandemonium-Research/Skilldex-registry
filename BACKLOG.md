# Backlog

Deferred work — captured so it isn't lost, not scheduled for the initial GitSkills
import. See [FINDINGS.md](FINDINGS.md) for the corpus measurements these items are
sized against, and [IMPORT_STATUS.md](IMPORT_STATUS.md) for what is actually built so
far and what comes next.

---

## Result ordering after a bulk import

**Status:** unresolved, and it lands the moment the import does.

**The problem.** [`src/db/skills.ts`](src/db/skills.ts) narrows with `textSearch` then
orders by `install_count`, which defaults to `installs` in `searchSkillsSchema`. Every
imported skill starts at zero installs, so among keyword matches the order is
effectively arbitrary — and imported rows will outnumber hand-published ones by orders
of magnitude.

**Why deferred.** Search behaviour was deliberately left unchanged in this round, and
the schema carries no popularity signal to sort on — redistribution counts were
considered and dropped (see below).

**What already mitigates it.** The importer backfills `score` from `validateSkill`, so
imported rows are not uniformly blank. `SORT_MAP` and the `sort` enum already accept
`score`, so `?sort=score` works today with no code change. It ranks spec conformance
rather than popularity, but it is a live, recomputable number. Only the *default*
remains `installs`.

**Why not redistribution count.** An earlier revision added `distinct_owners` /
`distinct_repos` / `occurrences` columns and a `skill_sources` table to derive them.
All were dropped:

- It is a **frozen snapshot** of GitHub as of July 2026, written once at import and
  never refreshed. `install_count` at least grows with real use.
- It is **biased in both directions** — byte equality undercounts it when a copy is
  edited (FINDINGS §5), while scaffolding tools and monorepo vendoring inflate it
  (FINDINGS §2). Not a bound either way.
- `skill_sources` needed **1,771,984 rows to maintain three integers** on 215,504
  skills — roughly 750 MB with indexes, against a 500 MB free tier that the ≥ 2
  threshold exists to fit inside.

**Recovering it is cheap if wanted.** `content_key` is the dataset's `file_sha`, so
re-deriving is one DuckDB query against the corpus joined back on that column. The
dataset has a Zenodo DOI; nothing about this decision is permanent.

**When to pick up.** Before or immediately after the first import becomes publicly
searchable.

---

## Full-corpus import (beyond ≥ 2 owners)

**Status:** deferred. The initial import lists only entries appearing under **≥ 2
distinct owners** — 215,504 of 1,610,957 candidates.

**Goal:** List the remaining 1,395,453 single-owner entries.

**Why deferred.**

- *Storage.* 1.61M rows of metadata is roughly 800 MB before the FTS GIN and `pg_trgm`
  indexes, well past the 500 MB Supabase free tier. The ≥ 2 slice is on the order of
  110 MB plus indexes. This is a paid-tier decision, not an engineering one.
- *Signal.* A single-owner entry has no evidence anyone but its author holds a copy.
  That is **not** evidence it is unused — most software is uncopied — but it does mean
  nothing distinguishes it from the other 1.39M, and conformance `score` alone will not
  keep that many rows from swamping results.

**When to pick up.** When either (a) real searches demonstrably miss skills excluded by
the threshold, or (b) a ranking signal exists that orders single-owner entries
meaningfully — repo stars, recency, conformance score, or real install telemetry.

**Sizing.** No re-analysis needed; the threshold is a `WHERE` clause. The work is
Supabase tier plus whatever ranking makes the extra rows tolerable.

---

## Semantic search (embeddings + pgvector)

**Status:** deferred. Search is keyword (Postgres FTS + `pg_trgm`).

**Goal:** Match queries against descriptions semantically, so `spreadsheet` finds a
skill named `xlsx` described as "read and write Excel workbooks".

**Why deferred.** The vocabulary-mismatch gap is real but narrow, and closing it costs
an external embedding provider, an API key inside the serverless request path, and
vector storage. Trigram matching already covers near-miss spelling. Note this is a
*separate* problem from result ordering (above) — embeddings would not fix an all-zero
sort column, and score ordering would not fix vocabulary mismatch.

**When to pick up.** When real query logs show misses that are genuinely semantic.

**Sizing.** Additive: enable `pgvector`, add a column, backfill, add a sort mode.
Anthropic has no first-party embeddings endpoint and recommends Voyage AI;
`voyage-4-lite` at 256 dimensions (Matryoshka truncation) covers the corpus inside
Voyage's 200M free-token tier — 1.61M descriptions is ~90M tokens. Cost is not the
obstacle; the request-path dependency is. `voyage-4-nano` is open-weight (Apache-2.0)
if the vendor dependency is the blocker.

---

## Dead `source_url` reaper

**Status:** not built.

**Goal:** Detect and de-list entries whose GitHub source has moved, been renamed, or
been deleted.

**Why it matters more after an import.** The registry stores metadata only and the CLI
fetches from `source_url` at install time, so a stale row fails at `skillpm install` —
visibly, at the moment of use, which is worse than the skill not being listed. The
watched-repo sync re-scans a small set frequently; an imported corpus is two orders of
magnitude larger, was collected in July 2026, and is never revisited.

**When to pick up.** Before or shortly after the first bulk import goes live.

**Sizing.** A periodic job issuing conditional `HEAD`/`GET` against `source_url`, with a
failure counter so one transient 404 does not de-list a live skill. Rate is the
constraint: 215K URLs at GitHub's authenticated 5,000/hr is ~43 hours per full sweep,
so it wants to be incremental (oldest-checked first) rather than a full pass.

---

## Opt-out / takedown path

**Status:** not built. No `delisted` column ships either — an inert flag with nothing
honouring it is worse than none.

**Goal:** Let an author remove their skill without a maintainer doing it by hand.

**Why it matters.** Imported entries were never submitted; the corpus spans ~195,841
accounts who did not opt in. Metadata-only linking is defensible, but consent rather
than copyright is the exposure. npm, PyPI and Homebrew are all submission-based.

**When to pick up.** Before the imported corpus is publicly searchable.

**Sizing.** A `delisted` flag honoured by search and install, plus a documented request
route. The harder half is deciding whether de-listing is per-skill, per-repo or
per-owner, and guaranteeing a re-import cannot resurrect a de-listed entry.

---

## Characterise the mass-published catalogs

**Status:** open question, not investigated.

**Goal:** Determine what accounts like `Klotzkette` (21,957 entries) and `zwright8`
(8,170) actually published, and whether it is machine-generated.

**Why it matters.** The ≥ 2 owner threshold excludes most of them but not all —
`FDU-INS` has 343 entries surviving with up to 32 owners (FINDINGS §2). If that content
is being replicated by some mechanism rather than chosen, the redistribution metric is
measuring the mechanism, not interest.

**Sizing.** Small: sample and read a few dozen SKILL.md files from each account.
