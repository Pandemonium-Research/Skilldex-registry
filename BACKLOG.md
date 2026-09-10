# Backlog

Deferred work — captured so it isn't lost, not scheduled for the initial GitSkills
import. See [FINDINGS.md](FINDINGS.md) for the corpus measurements these items are
sized against, and [IMPORT_STATUS.md](IMPORT_STATUS.md) for what is actually built so
far and what comes next.

---

## Result ordering after a bulk import

**Status:** ~~unresolved~~ **decided 2026-09-06** — the default sort becomes `score`
(REGISTRY_MIGRATION_DECISIONS.md D10). At full-corpus scale the hand-published skills are
0.3% of the table, so leaving `installs` as the default would bury them under 1.6M ties. The
analysis below is why `score` was the available answer.

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

> **Superseded 2026-09-06.** Pranav decided to import the **whole** corpus, not the ≥ 2-owner
> slice. See [REGISTRY_MIGRATION_DECISIONS.md](REGISTRY_MIGRATION_DECISIONS.md) and
> [REGISTRY_MIGRATION_BACKLOG.md](REGISTRY_MIGRATION_BACKLOG.md). The storage objection below
> was answered by moving off Supabase to Turso (D1); the *signal* objection stands and is now
> handled by making `score` the default sort (D10). The section is kept because its reasoning
> is still the record of why the threshold was proposed.
>
> One consequence measured after that decision: name collisions are **204,923 rows (12.75%)**
> across the full corpus, not the 2.7% quoted from 005's header — see
> [REGISTRY_MIGRATION_FINDINGS.md](REGISTRY_MIGRATION_FINDINGS.md) §2. Importing everything
> rather than the slice is what multiplied it, and D13 is the rule that handles it.

**Status:** ~~deferred~~ **adopted**. The original entry follows.

The initial import was to list only entries appearing under **≥ 2
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

---

## Pre-warm the popular query vocabulary

**Status:** open, sized, not started. Raised 2026-09-10 from the CLI-side suggest work.

**The problem.** Cold search is slow enough to shape what can be built on it. Measured against
production on 2026-09-10 (`Skilldex-EMNLP/experiments/E4_search_suggest/probe_registry_behaviour.py`,
read-only):

| Query | matches | cold | warm |
|---|---|---|---|
| `terraform` | 4,471 | 3.3s | 0.12s |
| `express` | 9,050 | 7.2s | 0.11s |
| `typescript` | 10,000 (capped) | 11.3s | 0.12s |
| `python` | 10,000 (capped) | 21.0s | 0.12s |

Warm is roughly 100× faster. `vercel.json` caps a function at 30s, and queries near that ceiling —
`test`, `the`, `write`, `a` — return 504 outright.

**Why this is tractable where general search latency is not.** Solving cold FTS across 1.6M rows is
the hard, open problem (see *Semantic search* above). But `skillpm suggest` does not issue general
queries. It issues **dependency names**, derived from the project's manifests, and dependency names
across projects are heavily power-law distributed: `express`, `react`, `vitest`, `commander`,
`yaml`, `zod`. A few hundred names cover most projects.

**The lever.** A scheduled job that issues the top few hundred package names **at the exact limit
the client uses** would make the median suggest run fast without touching the query path. The limit
matters and is the easy thing to get wrong: the cache key is the precise `(q, limit)` pair, so
warming `express` at limit 20 does nothing for a client asking at limit 10. The CLI pins
`RESULTS_PER_QUERY = 10` (`Skilldex/src/core/suggest-retrieval.ts`) specifically so this is
warmable; any job must use the same number and change with it.

**What it does not fix.** A completed response caches; a **504 does not**. A query near the ceiling
can fail repeatedly, leaving the cache as cold as before — measured for `test`, which 504'd on two
consecutive attempts at one cache key and cached fine at another once a request finished. So a
warming job needs retries and cannot guarantee coverage of the slowest terms.

**Sizing.** Small: a list of package names, one scheduled function, no schema change.

**When to pick up.** Before `skillpm suggest` is promoted as a headline feature — it is the
difference between a ~15s command and a ~1s one for most users.

---

## Ranking ignores the trust tier

**Status:** open, measured 2026-09-10. Distinct from *Result ordering after a bulk import* above,
which concerns the default sort when **no** query is present; this is about relevance ranking when
one **is**.

**The problem.** The registry maintains a `verified` tier and text-query ranking makes no use of
it. Measured across five ordinary queries, top 15 each:

| Query | verified in top 15 | `?tier=verified` total |
|---|---|---|
| `vitest` | 0 | 0 |
| `terraform` | 0 | 0 |
| `express` | 0 | 0 |
| `typescript` | 0 | 0 (504'd at 30.4s on an earlier run) |
| `python` | 0 | 1 — a spreadsheet skill |

Earlier, for `q=pdf`: `anthropics/pdf` is **not in the top 100**, and zero verified skills appear
there, while `anthropics/pdf` and `anthropics/docx` both exist and are verified. At pool scale, a
fan-out of eight dependency-name queries returned **64 distinct candidates, none verified**.

**Why filtering is not the workaround.** `?tier=verified` returns nothing for four of five queries
while still paying to scan the same corpus — 21.8s for `python`. Surfacing verified separately in a
UI is therefore not available either: there is nothing to surface.

**What this blocks.** Any consumer that wants to prefer trustworthy results is preferring among a
set that contains none. The CLI's own candidate ranking carries a verified preference that is, in
practice, a no-op.

**Sizing.** Unknown until the intent is decided — a tier boost in the ORDER BY is small; deciding
what the tier should *mean* against a 1.6M-row imported corpus is not.
