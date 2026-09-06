# Registry Browse Redesign — Implementation Plan

Written 2026-09-06. Spans `Skilldex-registry` (API) and `Skilldex-web` (site).

Companion to `COUNTING_AT_SCALE.md`, which explains *why* the counting problem exists. This
file is *what to build*.

---

## Context

The registry is moving from 4,863 skills to 1,615,322. The browse page was built for the small
number and breaks at the large one in three separate ways:

1. **It times out.** `count(*) OVER ()` forces a full scan; the default listing took >90s.
2. **Its ordering is meaningless.** Every sort dimension is degenerate on the imported corpus.
3. **Its URLs are wrong.** `/registry/[name]` assumes globally unique names; 41.5% now collide.

None of this is migration damage — it is a page designed for a catalogue now pointed at a
search index.

**Decision: ship against the live 4,863-row database now.** Nothing here is gated behind
cutover or Phase 7. The page must be correct at 4,863 today and correct at 1.6M later.

---

## The measurements this design rests on

Taken from `build/registry.db` (the merged 1,615,322-row corpus), 2026-09-06.

### Query plans (`EXPLAIN QUERY PLAN`)

| Query | Plan |
|---|---|
| Listing **with** `count(*) OVER ()` | `SCAN s` + `USE TEMP B-TREE FOR ORDER BY` |
| Listing **without** it | `SCAN s USING INDEX skills_install_count_idx` |
| Bounded count | `SCAN s USING COVERING INDEX skills_score_idx` |
| `tier=` filter + sort | `SEARCH USING skills_trust_tier_idx` + `USE TEMP B-TREE FOR ORDER BY` |

**The index is used correctly** once the window function is gone. `COUNTING_AT_SCALE.md` §5
speculated a DESC/rowid tiebreak mismatch was preventing it — that was wrong; SQLite resolves
`install_count DESC, seq ASC` from the index with no sort step. That section needs correcting.

### Local timings (no network)

| Query | Time |
|---|---|
| Listing, `LIMIT 20` | **8 ms** |
| Listing, `OFFSET 10000` | **1 ms** |
| Bounded count, cap 10,001 | **2 ms** |

The remote 2.9s is therefore **Turso HTTP round-trip and cold remote page cache, not query
cost**. Two consequences: response caching is worth more than query tuning, and offset-based
load-more is viable to the 10k cap.

### Signal distribution — the finding that shapes the whole page

| Dimension | Whole corpus | Curated tier (`content_key IS NULL`) |
|---|---|---|
| Rows | 1,615,322 | **4,863** |
| `trust_tier='verified'` | 7 | **7 — all of them** |
| `install_count > 0` | 33 | **33 — all of them** |
| Tagged | 2,106 (0.13%) | **2,106 — all of them (43% of tier)** |
| Distinct `published_at` days | 51 | **51 — all of them** |
| Distinct owners | 158,915 | **17** (the watched repos) |
| `score` 90–100 | 1,345,829 (83%) | — |

**The imported corpus contributes zero signal on every orderable dimension.** 99.7% share one
`published_at` day (the import). 83% score 90–100. Top owners are bulk uploaders
(`majiayu000` 31,523; `David-Li0406` 27,006).

Everything worth browsing is in the 4,863. Everything else is reachable by search.

---

## Design

**Two tiers.** Curated (4,863 — browsable, exactly countable, real ordering) and the full index
(1.6M — reachable by search). The landing page browses the curated tier; search spans either.

This solves the timeout structurally rather than by capping: the default view filters to a
4,863-row set that is fast *and* exactly countable. The bounded count only ever applies to
full-index searches.

---

## Phase A — API (`Skilldex-registry`)

### A1. Schema migration — `schema/sqlite/002_source_and_stats.sql` (new)

The schema header states that changes now need numbered migrations. This is 002.

```sql
ALTER TABLE skills ADD COLUMN source TEXT NOT NULL DEFAULT 'seeded'
  CHECK (source IN ('seeded', 'imported', 'published'));

CREATE INDEX skills_curated_installs_idx ON skills (install_count DESC) WHERE source <> 'imported';
CREATE INDEX skills_curated_recent_idx   ON skills (published_at  DESC) WHERE source <> 'imported';

CREATE TABLE registry_stats (
  key TEXT PRIMARY KEY, value INTEGER NOT NULL, updated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE tag_counts (
  tag TEXT PRIMARY KEY, count INTEGER NOT NULL, updated_at TEXT NOT NULL
) WITHOUT ROWID;
```

⚠ **Do not run `UPDATE skills SET source='imported'` against the 1.6M database.** `skills_au`
fires per row and rewrites two FTS5 tables — 1.6M trigger firings. Avoid it entirely:

- **Live DB (4,863 rows):** every row has `content_key IS NULL`, so the `'seeded'` default is
  already correct. **No UPDATE needed at all.**
- **Corpus build:** set `source = 'imported'` in `scripts/corpus/build.ts` at build time,
  before the FTS triggers are created. Zero cost.

Partial indexes cover ~4.8k entries each — negligible against the 2 GB ceiling.

### A2. Counting — `src/db/skills.ts`, `src/db/skillsets.ts`

Implement `COUNTING_AT_SCALE.md` §4. Remove `count(*) OVER ()` from both (`skills.ts:118-124`,
`skillsets.ts:67-73` — the skillsets copy has never been measured and has the same defect).

| Case | `total` source | `total_relation` |
|---|---|---|
| No `q`, no filters, curated scope | `registry_stats` | `eq` |
| Filtered / scoped, <10k matches | bounded count | `eq` |
| Filtered / scoped, ≥10k matches | bounded count at cap | `gte` |

Add `has_more` from a `limit + 1` fetch — free, exact, and what load-more actually needs.

Add `has_more` from a `limit + 1` fetch — free, exact, and what load-more actually needs.
Keep the `+1` local to the SQL and slice immediately so no downstream code sees the extra row.

**Keep it to one HTTP round trip.** Since latency is round-trip dominated (8 ms query vs 2.9 s
response), naively replacing one query with two *doubles* the cost of every search. Use
`db.batch([pageStmt, countStmt], "read")` — libSQL sends a batch as a single HTTP request. This
preserves the one-round-trip property the original `count(*) OVER ()` comment was written to
defend, making the change strictly better rather than a trade.

**Drop `bm25` from the count subquery.** The page query needs the rank; the count does not.
`SELECT rowid AS seq FROM skills_fts WHERE skills_fts MATCH ?` avoids evaluating the auxiliary
function over the whole match set. Free, and it targets the dominant cost of the 6.4 s search.

⚠ **If the `registry_stats` row is missing, fall back to the bounded count — never to
`count(*)`.** A missing row happens in tests, fresh dev DBs and misconfigured deploys.
`SELECT count(*) FROM skills` reintroduces the exact 90 s timeout in the exact case this design
exists to prevent. Degrading to "10,000+" is wrong but bounded and survivable.

**Derive "unfiltered" from the predicate, not the params:** `where.length === 0 && !fts`, placed
after the `where` array is built. Re-reading `params.tier || params.q || …` drifts the first
time someone adds a filter.

The two functions are near-duplicates but differ in table, sort map and FTS table. **Extract
only the dangerous parts** into `src/db/pagination.ts` — `COUNT_CAP`, `MAX_OFFSET`,
`boundedCountSql()`, `interpretCount()`, `takePage()`. Leave the WHERE-building, SORT_MAP and
FROM construction in each file. The reason this bug exists in both is copy-paste; the pieces
that must be identical forever are the cap and the `eq`/`gte` rule, and only those.

**Do not restructure the FTS join.** With the window function gone, `ORDER BY bm25(...)` on a
direct join *might* now be legal. The payoff is unknown and the failure mode is a 500 on every
search. Keep the subquery; log it as a measurable follow-up.

### A3. `scope` parameter — `src/types/skill.ts`

Add to `searchSkillsSchema`:

```ts
scope: z.enum(["curated", "all"]).default("curated"),
offset: z.coerce.number().int().min(0).max(10000).default(0),   // was uncapped
```

`scope=curated` → `WHERE source <> 'imported'`. **Default `curated`** so every existing caller
— including published `skilldex-cli@1.2.0` — keeps getting the fast, meaningful set.

⚠ **`MAX_OFFSET` must equal `COUNT_CAP`.** Otherwise the API contradicts itself: it reports
`total: 10000, relation: "gte"` while still serving `offset=15000`. One constant each, both in
`src/db/pagination.ts`.

The route currently returns a flat `INVALID_PARAMS` for any zod failure, giving the client no
way to distinguish "offset too deep" (retryable by refining) from a genuine bug. Inspect
`parsed.error.issues` and when `path[0] === "offset"` return `code: "OFFSET_TOO_LARGE"` with
`max_offset`, still 400. Adding `details: parsed.error.issues` to the generic branch costs
nothing and makes every other validation failure debuggable.

⚠ **This is the only non-additive change in the plan.** Grep `Skilldex/src` for offset
accumulation before shipping — exposure looks nil, but verify rather than assume.

### A4. `GET /v1/stats` — `src/routes/stats.ts` (new)

```jsonc
{
  "skills":    { "total": 1615322, "curated": 4863, "imported": 1610459 },
  "skillsets": { "total": 12 },
  "owners": 158915,
  "verified": 7,
  "updated_at": "2026-09-06T20:30:00Z"
}
```

Every value read from `registry_stats` — O(1), no aggregation at request time. `COUNT(DISTINCT
owner)` is 237 ms locally and far worse remote; it must be precomputed.

Populated by `scripts/refresh-stats.ts` (new), invoked at the end of each nightly seed run and
once by the corpus build. Staleness is bounded by the seeder cadence, which is fine for a
headline figure.

### A5. Tag facets — same script

`json_each` over 1.6M is a full scan (1.5s locally, D8 defers the normalised table). But all
2,106 tagged rows are curated, so `refresh-stats.ts` aggregates tags **over the curated tier
only** and writes `tag_counts`. Served as `GET /v1/tags` — a straight table read.

### A6. Cache headers — `src/middleware/cache.ts` (new)

There are **no cache headers anywhere** today and `vercel.json` is a bare rewrite, so this must
come from Hono. Given that latency is dominated by round-trip, this is the highest
value-per-line change in the plan.

| Route | Header |
|---|---|
| `/v1/stats`, `/v1/tags` | `public, s-maxage=3600, stale-while-revalidate=86400` |
| `/v1/skills`, `/v1/skillsets` (GET) | `public, s-maxage=60, stale-while-revalidate=300` |
| `/v1/skills/:owner/:name` | `public, s-maxage=300, stale-while-revalidate=3600` |
| `/v1/spec-versions` | `public, s-maxage=3600` |

Mutating routes and `/v1/auth/*` must stay `no-store` — apply per-route, never `app.use("*")`.

⚠ **Gate on `method === "GET" && res.status === 200`.** A 500 cached at the edge for 60 s is a
self-inflicted outage. This is also why the headers come from Hono rather than `vercel.json`:
`vercel.json` matches on request path, but everything rewrites to `/api/index`, so a rule for
`/v1/skills` would apply to `POST /v1/skills` too — and it cannot condition on status at all.

Note beside `src/app.ts:17`: bare `cors()` emits `Access-Control-Allow-Origin: *`, which is
origin-independent and safe to share-cache. The moment anyone changes it to
`cors({ origin: [...] })`, responses become origin-dependent and need `Vary: Origin`.

---

## Phase B — Web (`Skilldex-web`)

### B1. Fix the relevance bug first — `src/app/registry/page.tsx:35`

```ts
sort: searchParams.sort || 'installs'      // always sends installs, killing bm25
```

This overrides the backend's `resolveSort`, so **every text search on the site is ranked by
install_count** — which is 0 for all but 33 rows. The phase-2 relevance work is unreachable
from the web. Send `sort` only when explicitly chosen.

Then add `relevance` to the `SearchBar` dropdown (`src/components/registry/SearchBar.tsx`),
where it is currently absent.

**This is a two-line fix with the largest user-visible effect in the plan. Ship it first,
independently of everything else.**

### B2. `src/lib/registry.ts`

Add `getStats()`, `getTags()`, `getSkillByOwner(owner, name)`; thread `scope` through
`SearchOptions`; return `has_more` / `total_relation`.

Stop swallowing every non-OK response into an empty result — at minimum distinguish 409
`AMBIGUOUS_NAME` from 404, since that is what currently breaks detail pages. Keep
`next: { revalidate: 60 }`; raise it for stats.

⚠ **`src/types/registry.ts` has no `owner` field.** `RegistrySkill` omits `owner`,
`display_name` and `qualified_name`, all of which `skillRowToApi` already returns. Every
owner-qualified link depends on adding these three. Pure type change, no API work — **but it
must land before anything that links to `/registry/[owner]/[name]`.**

### B3. The landing page — `src/app/registry/page.tsx`

Two states.

**No query** → four curated sections, each scoped to `scope=curated` where every signal
actually lives:

| Section | Query | Rows behind it |
|---|---|---|
| Official | `tier=verified&scope=curated` | 7 |
| Most installed | `sort=installs&scope=curated` | 33 with real installs |
| Recently added | `sort=recent&scope=curated` | 4,863 over 51 days |
| Browse by tag | `GET /v1/tags` | 2,106 tagged (43% of tier) |

Header carries the headline from `/v1/stats`: **`4,863 curated · 1,615,322 indexed`**.

**With a query or filter** → result list plus load-more, and a scope toggle
(`Curated · All skills`) that switches `scope`.

Render `total_relation: "gte"` as **`10,000+`**, never a bare `10001`.

### B4. Load-more — `src/app/api/registry/skills/route.ts` (new)

`REGISTRY_URL` is server-only (no `NEXT_PUBLIC_` prefix), so the browser cannot call the
registry directly. Use a **Next Route Handler** as a thin proxy, not a Server Action — actions
are POSTs and are not CDN-cacheable, and this is cacheable read traffic.

The page (server component) renders page 1. A new client component
`src/components/registry/LoadMore.tsx` holds the appended pages and calls the route handler
with the same params plus a rising `offset`, stopping when `has_more` is false or the 10k cap
is hit. Push the offset into the URL via `history.replaceState` so the view stays shareable.

Only the second and later pages are client-fetched — first paint stays server-rendered.

⚠ **Pass `key={queryKey}` to the client component**, where
`queryKey = JSON.stringify({q, tier, sort, scope})`. Without it, changing a filter re-renders
the server component with fresh `initialItems`, but React preserves the client component's
state — so rows accumulated under the *previous* query stay on screen and the new first page is
ignored, because `useState`'s initialiser only runs on mount. This is the most common failure
in App Router load-more implementations. Comment it; it looks removable and is not.

The button's enabled condition is `hasMore && nextOffset <= maxOffset`, reading `max_offset`
from the API rather than duplicating the constant. When it trips, show "Showing the first
10,000 results — refine your search to see more", and handle a defensive `OFFSET_TOO_LARGE`
response the same way.

### B5. Detail routes

⚠ **`[name]` and `[owner]` cannot coexist.** Next.js throws a build-time error — *"You cannot
use different slug names for the same dynamic path"* — when two differently-named dynamic
slugs occupy the same segment position. `registry/[name]/page.tsx` and
`registry/[owner]/[name]/page.tsx` both sit at position 2. This is a hard build failure, not a
precedence question, so the existing directory must be **renamed, not kept**.

- **Rename** `src/app/registry/[name]/` → `src/app/registry/[owner]/`. The segment serves two
  purposes (legacy bare name, and owner); document that at the top of the file.
- **`[owner]/page.tsx`** — the resolver. Needs `resolveBareName(name)` in `src/lib/registry.ts`
  returning a discriminated union so the 409 is **not** swallowed:
  `{status:'ok'|'ambiguous'|'not_found'|'error'}`.
  - `ok` → `redirect()` to `/registry/{owner}/{name}`. **307, not `permanentRedirect()`** — a
    name that resolves uniquely today becomes ambiguous the moment a second owner claims it,
    and a browser-cached 308 would be permanently wrong with no way to recall it.
  - `ambiguous` → disambiguation list. `error` → throw, so `error.tsx` renders.
- **New `[owner]/[name]/page.tsx`** — the canonical detail page, calling
  `GET /v1/skills/:owner/:name`, which never 409s. No `generateStaticParams` (1.6M pages).
- **Leave the install command as `skillpm install {name}`.** The CLI does
  `encodeURIComponent(name)` (`Skilldex/src/registry/sources/registry.ts:102`), so a qualified
  name becomes `owner%2Fname` and may match the *legacy* route and 404. Whether Vercel
  normalises `%2F` before the function sees it is untested. **Changing the URL scheme and
  changing the install command are independent; only the first is in scope.**
- Static beats dynamic, so `/registry/skillsets` and `/registry/skillsets/[name]` are
  unaffected. The only casualty is an owner literally named `skillsets`. Acceptable.
- **Recommended additive API change:** the 409 body returns only `owners: string[]`, capped at
  10 by `LIMIT 11` with no truncation signal. Add `skills: Skill[]` and `truncated: boolean` in
  `src/routes/skills.ts` so the disambiguation page can show descriptions and scores from one
  fetch instead of a bare list of handles.
- Update every internal link building `/registry/{name}`, including
  `src/app/registry/skillsets/[name]/page.tsx` and `src/components/landing/RegistryPreview.tsx`.

### B6. Deliberately minimal component work

Three near-identical row variants exist (`SkillCard`, `SkillsetCard`,
`RegistryPreview.SkillRow`) and `Badge` is duplicated inline in the list cards. **Collapse only
the badge duplication**, and add a `compact` prop to `SkillCard` for the curated strips. Leave
the rest. This is a browse redesign, not a design-system rewrite.

Add the missing `loading.tsx` and `error.tsx` under `src/app/registry/` — with the corpus live,
a slow or failed API call currently renders as "No skills published yet".

---

## Sequencing

```
B1  relevance fix ─────────────────────────────► ships alone, today
A6  cache headers ─────────────────────────────► ships alone, independent
A1  migration ──► A2 counting ──► A3 scope ──┐
                 A4 stats ──► A5 tags ───────┴──► B2 ──► B3 ──► B4
                                                    └──► B5 (independent of B3/B4)
```

- **B1 and A6 are independent and should ship immediately** — a two-line correctness fix and a
  middleware file, neither depending on the migration.
- **A1 blocks everything else in Phase A.**
- **B5 is independent of the landing work** and can land in parallel.
- Nothing here blocks, or is blocked by, cutover or Phase 7.

---

## Verification

1. **Query plans.** Re-run `EXPLAIN QUERY PLAN` on the rewritten listing against
   `build/registry.db`; assert no `USE TEMP B-TREE FOR ORDER BY` on the curated default.
2. **Scale timing.** Run the new `searchSkills` against `skilldex-registry-v2` and confirm the
   default listing responds. This is the acceptance test — it is the query that timed out.
3. **Parity.** Extend `scripts/verify-api-parity.ts` to cover `total_relation` and `has_more`.
   Note it cannot catch scale-only faults; step 2 is what does.
4. **Count correctness.** For a filter with a known small answer (`tier=verified` → 7), assert
   `total = 7` and `total_relation = "eq"` — the cap must not round small answers up.
5. **Client compatibility.** `skilldex-cli@1.2.0` against the new API: `skillpm search`,
   `install`, `list` must be unaffected by the added fields and the `scope` default.
6. **Ambiguity path.** A contested name must render the disambiguation page, not a 404.
7. **Cache.** `curl -I` each GET route and check `Cache-Control`; confirm auth routes are
   `no-store`, and that a non-200 is never given a cacheable header.
8. **Load-more reset.** Change a filter after loading three pages; assert the list resets to
   the new query's first page. This is the `key` bug in B4 and it is the highest-value web test.
9. **`gte` path.** Make `COUNT_CAP` injectable (module-level `let` with a test setter) so a
   fixture can set it to 5 and assert the relation flips. At 10,001 the branch is untestable —
   and it is the branch that only ever fires in production.

---

## One claim considered and rejected

A design pass argued the 2.9 s listing is caused by 1,610,459 rows tied at `install_count = 0`,
forcing SQLite to materialise and sort the whole table because `skills_install_count_idx` covers
only `(install_count DESC)` and cannot resolve `seq ASC` within the tie group.

**Measurement contradicts it.** `EXPLAIN QUERY PLAN` returns `SCAN s USING INDEX
skills_install_count_idx` with **no** `USE TEMP B-TREE FOR ORDER BY`, and the query runs in 8 ms
locally — impossible if 1.6M rows were being sorted. SQLite stores rowid ascending within equal
index keys, and `seq` *is* the rowid, so the index order already satisfies
`install_count DESC, seq ASC`.

Consequence: **do not add a composite `(install_count DESC, seq ASC)` index.** It would buy
nothing and cost bytes against a 2 GB ceiling from which 192 MB was already cut.

The *semantic* half of that argument does stand on its own, and is measured in the table above:
`sort=recent` is meaningless post-import because 99.7% of rows share one `published_at`. If the
GitSkills dataset carries a commit or first-seen date, stamping it in `scripts/corpus/build.ts`
would make "Recently added" genuinely useful — and that must happen *before* the corpus build,
since a rebuild is expensive.

---

## Out of scope

- **Cutover** to `skilldex-registry-v2`, and **Phase 7** (opt-out). Independent of this work.
- **Phase 8** seeder realignment — but note `refresh-stats.ts` must be wired into the nightly
  run when that happens, or the headline count silently freezes.
- **Per-skill sitemaps.** Beyond the 50k-per-file limit, generating one would have to page the
  API — and **every request past offset 10,000 would be rejected by the cap this very plan
  introduces.** It would need a bulk-export endpoint, which is a project. A static
  `sitemap.ts`/`robots.ts` for the ~10 real pages plus docs is cheap and worth doing; neither
  exists today. Prefer `robots: { index: false }` on `score === 0` and disambiguation pages
  over mass thin content.
- **`skills_trgm`.** Built, integrity-checked, and never queried by any API code. Exposing
  typo-tolerant search is a real opportunity and a separate change.
- **Skillsets tab.** `src/app/registry/skillsets/page.tsx` is a stale fork of the browse page.
  It inherits A2's count fix for free; its UI is not redesigned here.
