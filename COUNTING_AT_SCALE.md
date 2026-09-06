# Result Counting and Pagination at Scale

Written 2026-09-06, during the Turso migration, after `count(*) OVER ()` turned the default
`/v1/skills` listing into a >90s timeout at 1.6M rows.

This is a reference document, not a decision record. Decisions live in
`REGISTRY_MIGRATION_DECISIONS.md`; measurements in `REGISTRY_MIGRATION_FINDINGS.md`. This file
explains *why* the problem exists, what the industry does about it, and where the literature is.

---

## 1. The problem, concretely

`searchSkills` in `src/db/skills.ts` returns a page of results and the unpaginated total in one
round trip:

```sql
SELECT s.*, count(*) OVER () AS __total
FROM skills s
WHERE <filters>
ORDER BY install_count DESC, seq ASC
LIMIT 20 OFFSET 0;
```

Measured against `skilldex-registry-v2` (1,615,322 rows):

| Query | Time |
|---|---|
| Default listing **with** `count(*) OVER ()` | **>90s — timed out** |
| Same query **without** it | 2.9s |
| FTS search (`q=kubernetes`) | 6.4s |
| Bounded count, cap 10,001 | 1.0s |
| Bounded count with a filter (true answer: 7) | 1.7s |

At 4,863 rows — the live registry — every one of these is instant. **This is a scale-only
failure.** No parity check against the old database could have caught it, and no unit test at
realistic fixture sizes would either. It belongs to the same class as the PostgREST
`textSearch("name, description", …)` truncation: correct at small N, wrong at large N, silent
in both cases.

---

## 2. Why it happens

### 2.1 The window function defeats the LIMIT

`count(*) OVER ()` with an empty `OVER()` clause declares a single partition spanning the entire
result set. To emit `__total` on *any* row, the engine must know that partition's size — so it
must materialise every row satisfying the `WHERE` clause before it can return the first one.

`LIMIT 20` cannot be pushed below the window operator. The query stops being "read 20 rows from
an index" and becomes "read 1,610,957 rows, count them, then discard all but 20."

This is not a SQLite quirk. Postgres, MySQL 8 and SQL Server all behave the same way for the
same reason; the pattern is only ever cheap when the result set is small.

### 2.2 Why counting is fundamentally harder than ranking

This is the part worth internalising, because it explains why the entire search industry
converged on the same answer.

**Ranked retrieval admits early termination. Counting does not.**

A top-k query can stop early. Once you hold k candidates and can prove that no unseen document
could score above the current k-th best, you are done — you never touch the rest of the posting
list. This is the whole basis of WAND (Broder et al. 2003), MaxScore (Turtle & Flood 1995) and
Block-Max WAND (Ding & Suel 2011), and it is why a web search engine can answer in 40ms over
billions of documents.

That proof establishes *which* documents are best. It says nothing whatsoever about *how many*
documents match. The moment an API promises an exact total, it forfeits every one of those
optimisations, because the only way to count matches is to enumerate them.

**Elasticsearch changed its default for exactly this reason.** Before 7.0, ES always reported an
exact `hits.total`, which meant it could never skip a posting list. In 7.0 the default became
`track_total_hits: 10000`, and the response shape changed to carry a relation:

```json
"hits": { "total": { "value": 10000, "relation": "gte" } }
```

The count was capped so that Block-Max WAND could be turned on. The cap is not a compromise
forced by weak hardware — it is the price of admission for fast ranked retrieval.

### 2.3 Where this codebase sits

SQLite's FTS5 does **not** implement block-max skipping. `bm25()` is an auxiliary function
evaluated per matched row, and `ORDER BY bm25(...)` therefore materialises every match and sorts
it. (Worth verifying against the FTS5 source before relying on this — see §7.)

If that is right, it explains the measurements precisely:

- The **unfiltered listing** has no FTS involvement. Without the count it is a top-20 index scan
  (2.9s); with the count it becomes a full table scan (>90s). The count is the entire regression.
- The **FTS search** already scans all matches to rank them. Adding the count costs comparatively
  little — so the 6.4s is probably rank-dominated, not count-dominated, and removing the window
  function may not improve it much.

That distinction matters for what to optimise next, and it is measurable.

### 2.4 The related problem: OFFSET is O(offset)

`LIMIT 20 OFFSET 100000` requires walking 100,000 index entries to discard them. No B-tree can
seek to "the 100,000th entry in this order" unless its interior nodes carry subtree cardinalities
(a *counted* or *ranked* B-tree). SQLite's do not.

Deep pagination is therefore linear in the offset regardless of how the count is computed. Any
fix that keeps offset-based paging over 1.6M rows has a slow tail no matter what.

---

## 3. What production systems actually do

Three distinct patterns, used in combination rather than as alternatives.

### 3.1 Capped count with an explicit relation

Report a bounded number *and tell the client it is a bound*.

| System | Field | Signal |
|---|---|---|
| Elasticsearch ≥7.0 | `hits.total.value` | `hits.total.relation`: `"eq"` \| `"gte"` |
| Solr ≥8.6 | `numFound` | `numFoundExact`: boolean |
| Algolia | `nbHits` | `exhaustiveNbHits`: boolean |
| Google Search | "About 10,200,000 results" | the word *About* |

The relation flag is the load-bearing part. A capped count without it is simply a wrong number
served confidently; with it, the API has an honest contract and the client can render
"10,000+" instead of "10001".

### 3.2 Cursor pagination with `has_more` — and no total at all

Stripe, Slack and GitHub's cursor endpoints return `has_more` (Stripe) or a `next_cursor` and
omit the total entirely.

The mechanism is free: request `limit + 1` rows, return `limit`, and `has_more` is whether the
extra row came back. **No second query, exact at any N, and it is what pagination actually
needs.** "Is there another page" and "how many results exist" are different questions, and only
the first is required to paginate.

Keyset (seek) pagination goes further: instead of `OFFSET n`, carry the sort key of the last row
and use `WHERE (sort_key, seq) < (?, ?)`. That turns page N into an index seek rather than a walk,
fixing §2.4. It cannot render a page-number control, only next/previous.

### 3.3 Materialised or estimated counts for the unfiltered case

"How many rows are in this table" is a **statistic**, not a query result. Postgres serves it from
`pg_class.reltuples`, maintained by ANALYZE/autovacuum. MySQL's `SHOW TABLE STATUS` gives an
InnoDB estimate. SQLite has no equivalent, so you maintain the number yourself — a one-row
`registry_stats` table updated by the writer.

For approximate distinct counts over streams, the same role is played by HyperLogLog
(Flajolet et al. 2007), which is what Redis `PFCOUNT`, Presto's `approx_distinct` and
BigQuery's `APPROX_COUNT_DISTINCT` use.

### 3.4 Two more, for completeness

- **Deep-page caps.** GitHub's search API refuses to return beyond 1,000 results. Google stops
  around page 40. Capping reachable offset bounds §2.4 by fiat.
- **Progressive / online counts.** Show a fast estimate that tightens as the scan proceeds — the
  idea behind Online Aggregation (Hellerstein et al. 1997). Rarely worth it for a search API,
  but it is the honest general answer to "cheap now, exact later".

---

## 4. The design for Skilldex

Combine all three. The key realisation is that **the query that times out is not a search**.

`/v1/skills` with no `q` and no filters has a total of `1615322`, which is a property of the
table, not of the query. It should never be computed at request time.

| Case | Source of `total` | Cost | `total_relation` |
|---|---|---|---|
| No `q`, no filters | `registry_stats` row | O(1) | `eq` |
| Filtered, <10k matches | bounded count | ~1–1.7s | `eq` |
| Filtered, ≥10k matches | bounded count | ~1.0s | `gte` |

The unfiltered case — the one that is broken — becomes both **exact and free**. Only genuinely
filtered queries fall back to a bound, and those are almost always far under the cap: the
filtered measurement above returned its true answer of 7.

### 4.1 Bounded count

```sql
SELECT count(*) FROM (SELECT 1 FROM skills WHERE <filters> LIMIT 10001);
```

The inner `LIMIT` lets the scan stop at 10,001 rows. If the result is <10,001 it is the true
count (`eq`); if it equals 10,001, there are at least that many (`gte`).

### 4.2 Statistics table

```sql
CREATE TABLE registry_stats (
  key        TEXT PRIMARY KEY,
  value      INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
```

Written by `seed.ts` at the end of each run and by the corpus build. A trigger on `skills` would
also work but adds a write to every insert — bad for a 1.6M-row bulk import, and the import
already runs without triggers by design (see `schema/sqlite/001_schema.sql`).

Staleness is bounded by the seeder cadence and the number is a headline figure, not an invariant,
so a nightly refresh is sufficient.

### 4.3 `has_more`

Fetch `limit + 1`, return `limit`, set `has_more` from the extra row. Free, exact, and independent
of everything above.

### 4.4 Proposed response shape

```jsonc
{
  "skills": [ /* … */ ],
  "total": 1615322,
  "total_relation": "eq",   // "gte" when capped
  "has_more": true,
  "limit": 20,
  "offset": 0
}
```

Additive: `total` keeps its name and meaning whenever `total_relation` is `"eq"`.

### 4.5 Client impact

`Skilldex-web` paginates on the total — `src/app/registry/page.tsx` computes
`Math.ceil(total / limit)` to build the page-number control, and renders
`{firstItem}–{lastItem} of {total}`.

A capped total caps the control at 501 pages of 20. **That is desirable**, because §2.4 means
those deep pages could not be served anyway. But the UI must render `gte` as `10,000+`, or it
will state a precise wrong number. Same for the CLI's `search-action.ts`, which prints
`Found ${result.total} skills`.

Older clients that ignore `total_relation` degrade to displaying `10001` — wrong, but bounded
and not a crash. Worth weighing against the alternative of never capping, which is a timeout.

---

## 5. What this does not fix

- **The 2.9s unfiltered listing.** The default sort is `install_count DESC, seq ASC` and
  `skills_install_count_idx` exists on `install_count DESC`, so this *should* be a top-20 index
  scan. 2.9s suggests it is not using the index. Needs `EXPLAIN QUERY PLAN` before diagnosing —
  a plausible cause is the planner declining a DESC index whose implicit rowid tiebreak does not
  match the requested `seq ASC`, but that is a guess until measured.
- **The 6.4s FTS search.** See §2.3 — likely rank-dominated. Measure before optimising.
- **Deep offsets.** Only keyset pagination or a hard offset cap addresses this.
- **Tag filtering**, which walks JSON via `json_each` (D8) and is a scan by construction.

---

## 6. The literature

Grouped by thread. Everything below is a real paper; venues and years are from memory and worth
confirming against DBLP before citing anything in writing.

### 6.1 Top-k retrieval and early termination

The core of §2.2 — why ranking is cheap and counting is not.

- **Turtle & Flood**, "Query Evaluation: Strategies and Optimizations", *Information Processing &
  Management* 31(6), 1995. Introduces MaxScore. Still implemented in Lucene.
- **Fagin**, "Combining Fuzzy Information from Multiple Systems", *PODS* 1996. The FA algorithm.
- **Fagin, Lotem & Naor**, "Optimal Aggregation Algorithms for Middleware", *PODS* 2001; extended
  in *JCSS* 66(4), 2003. The Threshold Algorithm (TA) — the foundational instance-optimality
  result for top-k. **Start here.**
- **Broder, Carmel, Herscovici, Soffer & Zien**, "Efficient Query Evaluation using a Two-Level
  Retrieval Process", *CIKM* 2003. WAND.
- **Ding & Suel**, "Faster Top-k Document Retrieval Using Block-Max Indexes", *SIGIR* 2011.
  Block-Max WAND — what Lucene and therefore Elasticsearch actually run, and the direct cause of
  the `track_total_hits` default change.
- **Ilyas, Beskales & Soliman**, "A Survey of Top-k Query Processing Techniques in Relational
  Database Systems", *ACM Computing Surveys* 40(4), 2008. The survey to read second.
- **Mallia, Siedlaczek & Suel**, "An Experimental Study of Index Compression and DAAT Query
  Processing Methods", *ECIR* 2019. Modern empirical comparison of the above.

### 6.2 Cardinality estimation

For §3.3, and for the "estimate instead of cap" branch.

- **Selinger, Astrahan, Chamberlin, Lorie & Price**, "Access Path Selection in a Relational
  Database Management System", *SIGMOD* 1979. Where selectivity estimation begins.
- **Lipton, Naughton & Schneider**, "Practical Selectivity Estimation through Adaptive Sampling",
  *SIGMOD* 1990.
- **Flajolet & Martin**, "Probabilistic Counting Algorithms for Data Base Applications",
  *JCSS* 31(2), 1985. The origin of sketch-based counting.
- **Flajolet, Fusy, Gandouet & Meunier**, "HyperLogLog: The Analysis of a Near-Optimal Cardinality
  Estimation Algorithm", *AofA* 2007.
- **Heule, Nunkesser & Hall**, "HyperLogLog in Practice: Algorithmic Engineering of a State of the
  Art Cardinality Estimation Algorithm", *EDBT* 2013. Google's engineering notes — the practical one.

There is also an active learned-cardinality-estimation literature (neural selectivity models,
c. 2019 onward, plus several sceptical reproducibility papers). I have not verified those
citations and am deliberately not listing titles I am unsure of. Search DBLP for
"learned cardinality estimation" if that branch turns out to matter.

### 6.3 Approximate query processing

For the "cheap now, exact later" branch in §3.4.

- **Hellerstein, Haas & Wang**, "Online Aggregation", *SIGMOD* 1997. Running estimates with
  confidence intervals that tighten as the scan proceeds.
- **Agarwal, Mozafari, Panda, Milner, Madden & Stoica**, "BlinkDB: Queries with Bounded Errors and
  Bounded Response Times on Very Large Data", *EuroSys* 2013.
- **Chaudhuri, Ding & Kandula**, "Approximate Query Processing: No Silver Bullet", *SIGMOD* 2017.
  A deliberately sober assessment of what AQP does and does not deliver. Read alongside BlinkDB.

### 6.4 Estimating result counts in search engines

The "About 10,200,000 results" problem treated as a research question.

- **Anagnostopoulos, Broder & Carmel**, "Sampling Search-Engine Results", *WWW* 2005.
- **Bar-Yossef & Gurevich**, "Random Sampling from a Search Engine's Index", *WWW* 2006; journal
  version in *JACM*, 2008.
- **Broder, Fontoura, Josifovski, Kumar, Motwani, Nabar, Panigrahy, Tomkins & Xu**, "Estimating
  Corpus Size via Queries", *CIKM* 2006.

### 6.5 Practitioner sources

Not papers, but the canonical engineering references.

- **Markus Winand**, *SQL Performance Explained* and use-the-index-luke.com — the definitive
  treatment of offset vs. seek pagination. The chapter on "Paging Through Results" is the single
  most directly applicable thing on this list.
- Elasticsearch documentation on `track_total_hits`, and the 7.0 release notes explaining the
  default change.
- Solr documentation on `numFoundExact` (8.6+).
- Stripe API pagination reference — the cleanest example of a public API that simply declines to
  provide a total.
- SQLite FTS5 documentation, particularly the sections on auxiliary functions and `content=`
  external-content tables.

---

## 7. Open questions to resolve by measurement

1. `EXPLAIN QUERY PLAN` on the unfiltered listing. Is `skills_install_count_idx` used? If not,
   why — the DESC/ASC tiebreak mismatch, or something else?
2. Is the 6.4s FTS search rank-dominated or count-dominated? Run it with and without the window
   function. This determines whether §4 helps search at all, or only the listing.
3. Does FTS5 have *any* early-termination path for `ORDER BY bm25(...)`? §2.3 assumes not.
   Confirm from the FTS5 source, not from inference.
4. What is the actual distribution of result-set sizes across real queries? If 99.9% are under
   10,001, the cap is invisible in practice and the whole question is academic.
5. Does the 10,001 cap want to be configurable per-request, the way `track_total_hits` is?

---

## 8. Summary

The window function was a reasonable optimisation at 4,863 rows and is fatal at 1.6M, because
computing an exact total forces the enumeration that every other part of a search stack is
designed to avoid. The industry answer is not to compute it faster but to stop promising it:
cap the count, label it as a bound, serve the unfiltered case from a maintained statistic, and
paginate on `has_more` rather than on arithmetic over a total.
