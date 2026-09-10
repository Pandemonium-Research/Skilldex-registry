# Nightly Seeding at Corpus Scale — Plan

How the nightly sync changes now that the registry holds the imported corpus rather than a
few thousand rows from a short watch list.

Supersedes and expands phases 5, 6 and 8 of
[REGISTRY_MIGRATION_BACKLOG.md](REGISTRY_MIGRATION_BACKLOG.md). Rationale for the existing
schema is in [REGISTRY_MIGRATION_DECISIONS.md](REGISTRY_MIGRATION_DECISIONS.md); measurements
are in [REGISTRY_MIGRATION_FINDINGS.md](REGISTRY_MIGRATION_FINDINGS.md).

Status: **plan only.** Nothing here is implemented. Effort figures are estimates.

---

## 1. The problem in one number

`scripts/seed.ts` reads `watched_repos WHERE enabled = 1` — **17 rows** — and makes one
`git/trees?recursive=1` call each. On a quiet night that is 17 requests, which is why nobody
has had to think about it.

The registry now contains skills from **220,607 distinct repositories**.

| | |
|---|---|
| Skills | 1,615,322 |
| Distinct owners | 158,915 |
| **Distinct repos** | **220,607** |

Measured against `build/registry.db` (the built artifact that became `skilldex-registry-v2`)
by extracting `owner/repo` from `source_url`; all 1,615,322 rows are `https://github.com/…`,
none skipped.

> ⚠ Backlog phase 5 says **282,200 repos**. That figure was taken from the raw GitSkills
> dataset, before dedup, delistings and name-collision resolution. **220,607** is what the
> registry actually holds and therefore what it has to keep fresh. The two numbers are not in
> conflict; they count different things.

Scaling the current design to that set:

| Approach at 220,607 repos | GitHub quota | Time per full pass | Sees deletions |
|---|---|---|---|
| REST, one call per repo | 220,607 req | **~44 hrs** at 5,000/hr | yes |
| GraphQL batched head-oid | ~2,207 pts (est.) | **~1 hr** | yes |
| GH Archive via BigQuery | **zero** | ~1 hr lag, continuous | no |

A naive sweep cannot complete daily. That is the whole reason this document exists.

---

## 2. Webhooks are not available, and this is not a preference

The obvious instinct is to stop polling and be notified instead. GitHub does not permit it
for repositories we do not administer:

- A **repository webhook** can only be created by the repository owner or someone with admin
  access.
- A **GitHub App** receives events only for repositories where an admin has installed it.
- **Watching** a repository does not help — watch notifications cover issues, pull requests,
  discussions and releases, **not pushes**.

We have no relationship with 158,915 GitHub accounts and no route to acquiring one. For
third-party repositories, polling is not the inefficient option, it is the only option.

A GitHub App is still worth building **for people who deliberately publish to Skilldex** —
opt-in, push-driven, no polling. That is a publishing feature with zero coverage on day one,
and it is not a freshness mechanism for the corpus. Tracked separately; out of scope here.

---

## 3. Split detection from fetching

The 44-hour figure conflates two jobs that have very different costs:

1. **Detection** — has anything in this repo changed? One cheap probe per repo, 220,607 of
   them, every cycle.
2. **Fetch** — what changed, and does it affect a `SKILL.md`? Expensive, but only for the
   repos detection flagged.

Detection is the number that looks impossible. It is also the one with cheap answers.

---

## 4. Detection

### Option A — GraphQL batched head-oid sweep  ← recommended

GraphQL allows aliasing many root lookups into one request:

```graphql
r0: repository(owner:"a", name:"b") { defaultBranchRef { target { oid } } }
r1: repository(owner:"c", name:"d") { defaultBranchRef { target { oid } } }
```

Store the head oid per repo; compare on the next sweep.

| | |
|---|---|
| Repos | 220,607 |
| Aliases per query | ~100 |
| Queries per full sweep | ~2,207 |
| Estimated primary cost | ~2,207 of 5,000 pts/hr |
| Secondary limit | 2,000 pts/min → pace over ≥2 min |

The primary rate limit costs a query by its **connections**, and these are plain node lookups
with no connections, so each batch should cost the 1-point minimum. **That is inferred from
the documented formula, not read as a stated fact — see §9, it must be probed before anyone
relies on it.**

GraphQL and REST have separate primary buckets, so detection does not compete with the fetch
tier below.

Why this one first:

- Deletions and privatisations come free — the alias returns null. Dead links are the most
  user-visible form of rot in a 1.6M registry.
- Renames surface the same way.
- No infrastructure outside the existing stack.

Failure mode to handle: a batch containing one bad repo returns a **partial** response —
`data` with nulls plus an `errors` array — rather than failing wholesale. Treat per alias.

### Option B — GH Archive

Every public GitHub event, dumped hourly to
`https://data.gharchive.org/YYYY-MM-DD-HH.json.gz`, and mirrored as the `githubarchive`
BigQuery public dataset (1 TB/month free tier). Push a 220,607-row table of our repos into
BigQuery, join against `PushEvent`, get back only what moved.

This is the closest thing to a real push notification for repos we do not own, and it costs
**no GitHub quota at all**. Two limits decide against it as the first move:

- **PushEvent payloads carry commit shas, not changed paths.** It tells you a repo moved,
  never that a `SKILL.md` moved. The fetch tier is unchanged either way.
- **It cannot see deletions.** A repo going private or being deleted emits no event.

Revisit if sub-day freshness becomes a goal, or if the GraphQL sweep proves too slow. It
pairs well with Option A rather than replacing it: GH Archive for fast-path change
detection, a slower full GraphQL sweep for deletions.

Scan-size estimate for the BigQuery path (`type` and `repo.name` are narrow columns, so daily
queries should sit far inside the free tier) is **unverified**.

### Option C — REST conditional requests

`GET /repos/{owner}/{repo}/commits/{branch}` with `If-None-Match`. **A 304 does not count
against the primary rate limit** when properly authenticated, which converts a quota-bound
sweep into a wall-clock-bound one.

Still one request per repo, so 220,607 round trips per pass — bounded by latency and
concurrency rather than quota. Worth keeping for the small watch list, not for the corpus.

---

## 5. Fetch

For each repo whose head oid moved:

```
GET /repos/{owner}/{repo}/compare/{old_oid}...{new_oid}
```

Returns changed file paths directly — no tree diffing on our side, and **deletions come back
explicitly**, which is the dead-link reaper for free. Filter to `*/SKILL.md`, fetch only
those blobs.

This is strictly better than re-fetching `git/trees?recursive=1` and diffing, which is what
the current seeder does. That remains correct for a repo seen for the first time, where there
is no base oid to compare against.

Caveats:

- `/compare` truncates at 300 files in the diff. On overflow, fall back to a full tree fetch.
- A repo whose default branch was force-pushed or rebased can produce a diverged comparison.
  Fall back to a full tree fetch there too.

Fetch-tier sizing, as a function of the **daily change rate `C`** (unknown — see §9):

| `C` | Repos to compare | Time at 5,000 req/hr |
|---|---|---|
| 1% | 2,206 | ~27 min |
| 3% | 6,618 | ~80 min |
| 5% | 11,030 | ~2.2 hrs |

Plus one blob fetch per changed `SKILL.md`.

---

## 6. Scheduling: priority from evidence, not provenance

**Do not tier by how a repo entered the registry.** The 17 repos in `watched_repos` are not a
curated set — they are the small corpus that happened to be on hand before the import, and
promoting them to a permanent nightly tier hard-codes an accident of discovery order into the
scheduler forever. (This is the same error as defaulting search to those rows; see
[REGISTRY_MIGRATION_FINDINGS.md](REGISTRY_MIGRATION_FINDINGS.md) §9 and the revision on D16.)

Score every one of the 220,607 with the same function, from measured properties:

- **Observed change rate** — moved in 6 of the last 8 checks ⇒ check often. Self-correcting,
  and it *discovers* which repos are active instead of assuming.
- **Demand** — install counts, detail-page fetches. Value-weighted.
- **Recency of last change** — recently-pushed repos are likelier to be pushed again.

Each repo carries a `next_check_at`; repos that keep coming back unchanged back off toward a
monthly floor. This is standard adaptive-recrawl practice, and it converts "220,607 repos
nightly" into **a fixed daily request budget spent where change is actually likely**.

The active repos among the original 17 will surface near the top on their own, because they
genuinely change — derived, not assumed. If one goes dormant it drops out by itself.

What *is* specific to those 17: someone hand-assigned `trust_tier` and `tags` to their
skills. That is metadata labelling. It says nothing about how often a repo changes and must
not leak into crawl priority.

---

## 7. Schema

`watched_repos` is the wrong home. Its columns — `trust_tier`, `tags`, `notes`, `enabled` —
are editorial, hand-maintained, and meaningful for 17 rows. Corpus repos have none of that;
they are derived mechanically from `source_url`.

A separate freshness ledger, roughly:

```sql
CREATE TABLE repo_heads (
  repo                  TEXT PRIMARY KEY,      -- "owner/name"
  head_oid              TEXT,
  etag                  TEXT,
  last_checked_at       TEXT,
  last_changed_at       TEXT,
  next_check_at         TEXT NOT NULL,
  consecutive_unchanged INTEGER NOT NULL DEFAULT 0,
  failure_count         INTEGER NOT NULL DEFAULT 0,
  state                 TEXT NOT NULL DEFAULT 'active'
                          CHECK (state IN ('active','gone','private','error'))
) WITHOUT ROWID;

CREATE INDEX repo_heads_due_idx ON repo_heads (next_check_at);
```

`watched_repos` stays exactly as it is, as the curation layer.

Notes:

- `next_check_at` makes a sweep **resumable by construction**, which matters because a full
  pass will not fit in one GitHub Actions job.
- `failure_count` exists so one transient 404 cannot de-list a live skill (carried over from
  backlog phase 6).
- Seeding this table is a one-off derivation from `source_url` over 1.6M rows.

---

## 8. Budget and runtime

- **`${{ github.token }}` at 1,000 req/hr is no longer sufficient.** Needs the `GH_PAT`
  secret the workflow comment already anticipates, or a GitHub App (up to 12,500 req/hr).
- **GitHub Actions caps a job at 6 hours.** The sweep must be chunked and resumable; §7 gives
  that for free. Alternatively schedule several shorter runs per day, each draining whatever
  is due.
- `DELAY_MS = 300` in the current seeder is a fixed 200 req/min pace. Replace with rate-limit
  header feedback (`x-ratelimit-remaining`, `x-ratelimit-reset`) and retry on secondary-limit
  responses.

---

## 9. Measure before building

Two numbers decide the shape of everything above, and neither is known:

1. **Daily change rate `C`.** Drives the whole fetch budget (§5). Measurable by sampling
   ~1,000 corpus repos through the GraphQL API — a handful of requests. `SKILL.md` repos skew
   young, so `C` may run well above a random GitHub sample.
2. **Actual GraphQL point cost per batched query.** One probe returning
   `rateLimit { cost remaining }` settles it. If the cost is per-alias rather than per-query,
   Option A gets ~100× more expensive and the recommendation flips to GH Archive.

Both are cheap. Neither should be assumed.

---

## 10. Prerequisite: the first sweep is the dangerous one

**Phase 8 (`source_url` reconciliation) must land first.** The seeder builds
`tree/{branch}`; the importer builds `tree/HEAD` (D14). A mismatch of one path segment makes
every imported watched-repo skill look new.

*Updated 2026-09-10:* there is a third producer. `skillpm publish` (since `Skilldex@b10d05d`) writes
`<remote>/tree/<branch>/<subpath>`, correct through symlinked paths since `skilldex-cli@1.4.3`. Two of
three producers use `tree/{branch}`; the importer's `tree/HEAD` is the odd one out, which bears on
which form Phase 8 standardises on.

At corpus scale that is not a cosmetic bug. Each insert or update fires the FTS5 triggers
across two tables — the corpus build deferred those triggers deliberately, because 1.6M
firings dominate every other cost. A first sweep that believes the whole corpus is new would
be the same event, unplanned, against production.

Ordering is therefore fixed:

1. Phase 8 — reconcile `source_url`, and `seed.ts` → `tree/HEAD` (D14)
2. Probe the two numbers in §9
3. Build `repo_heads` and the detection sweep
4. Re-enable the nightly workflow

**GitHub repo secrets still point at the old database, deliberately.** They stay there until
step 1 lands.

---

## 11. Naming cleanup to fold in

The word "curated" is load-bearing in ~25 places for a set that was never curated, including
a **public API field**. It keeps re-teaching the wrong idea to anyone reading the code:

| Site | Current | Should be |
|---|---|---|
| `src/db/stats.ts` | `skills_curated` stat key | `skills_seeded` |
| `src/routes/stats.ts:32` | `/v1/stats` → `curated:` | `seeded:` |
| `schema/sqlite/002_*.sql` | `skills_curated_installs_idx` | `skills_seeded_installs_idx` |
| `schema/sqlite/002_*.sql` | `skills_curated_recent_idx` | `skills_seeded_recent_idx` |

Plus stale comments asserting behaviour that was already reverted — notably
`Skilldex-web/src/app/registry/[owner]/[name]/page.tsx:150`, "default scope is the curated
tier", which is no longer true.

The `/v1/stats` field is the only one with a consumer. Ship `seeded` alongside `curated` for
one release, or take it as a breaking change while our own site is the only caller.

---

## 12. Task list

| # | Work | Effort | Status |
|---|---|---:|---|
| 1 | Phase 8 — `source_url` reconciliation, `seed.ts` → `tree/HEAD` | 1–1.5d | ⬜ **blocking** |
| 2 | Probe: daily change rate `C` over ~1,000 sampled repos | 0.25d | ⬜ |
| 3 | Probe: GraphQL `rateLimit { cost }` for a 100-alias batch | 0.1d | ⬜ |
| 4 | `repo_heads` migration + one-off derivation from `source_url` | 0.5d | ⬜ |
| 5 | GraphQL detection sweep, resumable, rate-limit aware | 1d | ⬜ |
| 6 | Fetch tier via `/compare`, with tree fallback | 1d | ⬜ |
| 7 | Adaptive scheduler — scoring, backoff, `next_check_at` | 0.5d | ⬜ |
| 8 | Dead-link reaper from null aliases and `/compare` deletions | 0.5d | ⬜ |
| 9 | `GH_PAT` or GitHub App; retire `${{ github.token }}` | 0.25d | ⬜ |
| 10 | `curated` → `seeded` rename, incl. `/v1/stats` field | 0.5d | ⬜ |
| 11 | Re-enable the nightly workflow, repoint GitHub secrets | 0.1d | ⬜ |

Items 2 and 3 are cheap and gate the design. Do them before item 4.
