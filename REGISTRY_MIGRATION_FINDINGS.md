# Registry Migration — Findings

Measurements taken while planning the Turso migration and the full GitSkills import.
Decisions that follow from them are in
[REGISTRY_MIGRATION_DECISIONS.md](REGISTRY_MIGRATION_DECISIONS.md); tasks in
[REGISTRY_MIGRATION_BACKLOG.md](REGISTRY_MIGRATION_BACKLOG.md). Corpus analysis from the
earlier ≥ 2-owner plan is in [FINDINGS.md](FINDINGS.md) and is **not** superseded — but see
§2, which corrects one of its figures for the full-corpus case.

All numbers here are reproducible: every query reads the Hugging Face Parquet mirror
directly over HTTP and is listed with the filter that produced it.

---

## 1. Database sizing

Measured against the live Supabase table on 2026-09-06, sampling 1,000 rows.

| Field | Avg bytes |
|---|---:|
| `owner` | 8.3 |
| `name` | 16.4 |
| `source_url` | 115.0 |
| `description` | 186.9 |

**~350 bytes of text per row**, so ~0.56 GB of text at 1.61M rows and ~0.8 GB for the whole
row — which independently matches the 800 MB that [BACKLOG.md](BACKLOG.md) derived by a
different route. With indexes, **~1.5–1.8 GB**.

> **Correction.** An earlier estimate of 4.9 GB was extrapolated from the live table's
> 3.0 KB/row (14 MB across 4,841 rows). That is wrong: at 4,841 rows the seven indexes are
> dominated by fixed minimum allocations, so the per-row figure does not extrapolate. ~83% of
> that 14 MB is index overhead, not data.

**Consequence:** no managed free *Postgres* tier fits — the largest is Aiven at 1 GB. This is
what forced the move to Turso (D1).

---

## 1b. Measured size in Turso — phase 1, 2026-09-06

The first estimate that is measured rather than extrapolated from Postgres. After migrating
the live registry into Turso, `dbstat` gives a per-object breakdown.

**Whole database: 7.3 MB** — against ~18 MB for the same data in Supabase, so SQLite is
roughly **2.5× more compact** here.

| Object | KB |
|---|---:|
| `skills` (table) | 2,828 |
| `seen_source_urls` | 1,828 |
| `skills_fts_data` | 820 |
| `skills_published_at_idx` | 328 |
| `skills_trgm_data` | 280 |
| `sqlite_autoindex_skills_1` (`id` unique) | 236 |
| `sqlite_autoindex_skills_2` (`owner,name` unique) | 188 |
| everything else | ~600 |

`skills` all-in — table plus its FTS, trigram and eight indexes — is **1104 bytes/row**
across 4,838 rows.

### Projection to the full corpus

**1104 B/row × 1,607,680 rows ≈ 1.77 GB.**

That lands inside the earlier 1.5–1.8 GB estimate, which is reassuring given two previous
attempts were wrong. Caveats, stated rather than buried:

- B-tree and FTS posting lists **compress better at scale**, so this is likely an
  over-estimate rather than under.
- Corpus descriptions may be longer or shorter than the live registry's 186.9-byte average.
- `seen_source_urls` (167 B/row) does not grow with the import — only the nightly seeder
  writes there.

### ⚠ The `--from-file` margin is thin

Turso's `turso db create --from-file` caps at **2 GB**. A projection of ~1.77 GB leaves
only about **11%** headroom. Levers if it comes in over:

| Lever | Saving at 1.61M | Cost |
|---|---:|---|
| Drop `skills_published_at_idx` | ~109 MB | loses `?sort=recent` |
| Drop the trigram table | ~93 MB | loses fuzzy name matching (D11) |
| Truncate `description` | up to ~300 MB | degrades search quality |
| `--from-dump` instead | — | different path, limits need checking |

**Measure the built file before uploading.** Do not discover this at upload time.

### Search quality is better, not merely ported

`bm25()` gives real relevance ranking, which the Postgres path never applied — `searchSkills`
narrowed with `textSearch` and then ordered by `install_count`, so relevance never entered the
ordering at all. Verified on live data: `excel spreadsheet` returns `ComposioHQ/excel-automation`,
`mxyhi/minimax-xlsx`, `TerminalSkills/excel-processor` in that order.

Also verified end to end in Turso: trigram fuzzy matching (`kubern` → four `kubernetes-*`
skills), `json_each` tag filtering, boolean round-tripping as 0/1, FTS `integrity-check` on all
three virtual tables, and per-table row counts matching Supabase exactly. The top-5 search
results were **identical** across both backends, which was not assumed — the parity check
prints them rather than asserting equality, because the two tokenise differently.

**Bare-name ambiguity is real in the live data**, which supports D13's approach: `agent-memory`,
`brand-guidelines`, `deep-research`, `prototype` and `tdd` are each held by **three different
owners** in only 4,838 rows.

---

## 1c. The deployed search never matched descriptions — verified

`src/db/skills.ts` called `textSearch("name, description", q)` and migration 001 built a GIN
index over `to_tsvector('english', name || ' ' || description)`. The intent is unambiguous.
The deployment never did it.

**PostgREST silently truncates the column list at the comma.** Counts for `invoices`:

| Filter | Rows |
|---|---:|
| `name=wfts(english).invoices` | **2** |
| `description=wfts(english).invoices` | **25** |
| `'name, description'=wfts(english).invoices` | **2** ← identical to name-only |
| no filter | 4,838 |
| a genuinely non-existent column | **HTTP 400**, `column skills.bogus does not exist` |

Three readings rule out the alternatives: it is not an ignored filter (that returns 4,838),
not an error (bogus columns do 400), and not a description match (that returns 25). It matched
`name` and dropped the rest of the expression without complaint.

### The replacement is a strict superset

Asking Postgres *correctly* — `or=(name.wfts.X, description.wfts.X)` — against the new FTS5
implementation:

| Term | Deployed (broken) | Postgres, asked correctly | libSQL FTS5 |
|---|---:|---:|---:|
| `invoices` | 2 | 25 | **26** |
| `pdf` | 12 | 42 | **55** |
| `kubernetes` | 4 | 40 | **41** |

Set-diffed on `pdf`: **0 results appear only in Postgres.** FTS5 returns everything Postgres
does plus 13 more, and every extra is legitimate — the term appears inside a compound token:

```
sickn33/dsh-deepread        PDFs,
TerminalSkills/canva        PDF/PNG/PPTX/MP4,
sickn33/impress             (ODP/PPTX/PDF),
TerminalSkills/chandra-ocr  PDFs/images,
TerminalSkills/report-generator  PDF/HTML
```

Postgres's default parser classifies `PDF/PNG/PPTX/MP4` as a single file-like token and never
splits it; FTS5's `unicode61` tokenizer splits on the non-alphanumerics. Higher recall, nothing
lost.

**Method note.** The parity check first reported these as failures and the reflex was to make
the new code match the deployment. The deployment is not automatically the reference — it can
be the thing that is wrong. Confirm which side is correct before conforming to it.

### Still open: relevance is computed but unused

`bm25()` is available, but when `q` is present results are ordered by `install_count`, because
that is the default sort inherited from the Postgres code. Ordering a text search by popularity
rather than relevance is questionable now and will be worse across 1.6M rows where
`install_count` is zero almost everywhere. Not changed unilaterally — it is a product decision.

---

## 1d. Phase 3 — per-repo scoping replaces the global preload

The seeder loaded every `source_url` in the registry into one in-memory `Set` on every run.
That is O(corpus): acceptable at 15,767 rows, and at 1.6M it becomes thousands of paginated
round trips plus roughly a gigabyte of heap, nightly, for data that barely changes.

Each repo now asks only what is already known about itself, `source_url LIKE
'https://github.com/{owner}/{repo}/%'`, so cost scales with the repo being scanned.

**Known urls per watched repo**, measured live:

| Repo | Known urls |
|---|---:|
| `sickn33/antigravity-awesome-skills` | 10,218 |
| `TerminalSkills/skills` | 1,955 |
| `alirezarezvani/claude-skills` | 1,463 |
| `ComposioHQ/awesome-claude-skills` | 864 |
| …12 more | ≤ 349 each |

Even the largest repo loads 10,218 urls rather than 1.6M — and that is the worst case in the
current watch list.

**Coverage check: 15,762 of 15,767** known urls fall under some watched repo. The five that do
not are `PhilipStark/book-genesis` entries left over from repointing that repo to
`felipelobomotta-blip/book-genesis-v4`; it is no longer watched, so they can never be
rediscovered. The point of the check was to detect a *systematic* mismatch — if the seeder
built `source_url` differently from what the table holds, every skill would look new and be
re-fetched. Five out of 15,767 is not that.

### The `LIKE` wildcard trap

`_` matches any single character in `LIKE`, and GitHub permits it in owner and repo names. An
unescaped prefix for `acme/my_repo` also matches `acme/myXrepo` — silently treating a different
repo's skills as already known and skipping them permanently. `%` is the same hazard.

`likePrefix` escapes both plus the escape character itself, and lives in `src/db/like.ts`
rather than in the script: importing `seed.ts` to test it would **execute the seeder**, which
is not something a test suite should be able to do by accident.

`skills_source_url_idx` backs the prefix scan. Without it each watched repo would provoke a
full table scan — 17 scans of 1.6M rows per nightly run.

---

## 1e. First seeder run on Turso — and a flaw it exposed

2026-09-06, manual, all 17 repos.

| | Before | After |
|---|---:|---:|
| `skills` | 4,838 | **4,863** (+25) |
| `seen_source_urls` | 10,929 | **10,932** (+3) |
| `felipelobomotta-blip` | 0 | **25** |

`Inserted: 25, Skipped: 9975, Failed: 3`, all 17 repos stamped, and the deployed API served the
new skills immediately. Seeder → Turso → Vercel verified end to end.

### ⚠ `markSeen` on PARSE_FAILED is too aggressive

All three failures were genuine YAML errors, correctly classified:

```
book-genesis-codex   Nested mappings are not allowed in compact mappings (line 2, col 14)
editorial-package    Nested mappings are not allowed in compact mappings (line 2, col 14)
trim-md              Unexpected scalar at node end (line 3, col 28)
```

The first two are the same authoring mistake: an **unquoted `description:` containing a
colon-space**, which YAML reads as a nested mapping. `trim-md` is
`argument-hint: [--dry-run] <paths...>` — a flow sequence with a trailing scalar.

**These are fixable by their authors, and the current code guarantees we never notice.**
Recording a PARSE_FAILED url in `seen_source_urls` blacklists it permanently. The reasoning
was "the same SKILL.md parses the same way tomorrow" — true of the same *bytes*, but the file
can change, and `source_url` carries no content identity.

So the earlier fix traded one flaw for its opposite: before, broken files were re-fetched
forever; now, fixed files are ignored forever. Neither is right.

**The fix is retry-on-change, and it is nearly free.** `discoverSkillPaths` already receives
each blob's `sha` from the tree API and discards it. Recording the failing blob sha alongside
the url means a run can retry precisely when the file has changed — no extra API calls, since
the sha arrives in the discovery response that is already being made.

Also worth noting for its own sake: `editorial-package` scored 100 under
`PhilipStark/book-genesis` and now fails to parse under `felipelobomotta-blip/book-genesis-v4`,
so the file was edited between the two publications and the edit broke it.

### Widening the typecheck found real problems

The seeder's first run crashed on a syntax error that `npm run typecheck` had reported clean —
`tsconfig.json` includes only `src/**/*`, so **`scripts/` and `tests/` were never checked at
all.** A `tsconfig.check.json` covering all three surfaced six errors, one of them a latent
type lie: `scripts/rescore.ts` declared its own `SkillRow` **without `owner`**, while the query
selects it and the update uses `skill.owner` to scope the write. It works only because the rows
are cast.

---

## 2. `(owner, name)` collisions in the full corpus

The measurement that decided the naming rule. Query: `dedup_primary = 1` (one row per
byte-distinct content) `AND frontmatter_valid = 1 AND filename = 'SKILL.md'`, slug derived by
mirroring `slugifySkillName`, across all 31 `artifacts` shards.

| | |
|---|---:|
| Gated rows (one per distinct content) | **1,607,680** |
| Distinct `(owner, slug)` groups | 1,483,995 |
| **Contested groups** (>1 distinct content) | **81,238 — 5.47%** |
| **Rows involved** | **204,923 — 12.75%** |
| Largest single group | **115** distinct contents under one `owner/name` |

> **Correction, and it matters.** This was previously quoted as "2.7% / ~43,000 rows", taken
> from `005_owner_namespace.sql`'s header comment. The real figure for the **full** corpus is
> **204,923 rows — nearly 5× larger**. The likely explanation is that 005 measured the
> ≥ 2-owner slice, which is more curated. **Choosing to import the whole corpus rather than
> that slice is what multiplied this problem**, and the decision should be understood in
> those terms.

### Would `owner/repo/name` fix it? No.

| | |
|---|---:|
| Still contested after adding `repo` | 57,635 groups / **147,249 rows** |
| Share of the problem fixed | **28.1%** |
| Contested groups confined to a single repo | **53,305** |
| Contested groups spanning repos | 27,933 |

Two-thirds of collisions happen **inside one repo**, so adding `repo` to the key cannot touch
them. It would be a breaking addressing change — one migration 005 only just made, and which
the CLI has not yet caught up to — in exchange for 28%.

### Worked example, verified by hand

Both in `alirezarezvani/claude-skills`, same repo:

| Name | A | B |
|---|---|---|
| `run` | 3,794 B — *"chains init → baseline → spawn → eval → merge"* | 2,513 B — *"Run a single experiment iteration"* |
| `handoff` | 2,131 B | 9,960 B — same opening sentence, 4.7× longer |

`run` is **name coincidence** — two unrelated skills with a generic name. `handoff` is a
**drifted duplicate** — one copy edited. Different problems, and no automatic winner in
either.

### How many are genuinely different?

Using `count(DISTINCT description)` within a group as the discriminator — 115 contents sharing
one description are regenerations, not 115 skills.

| | Groups | Share |
|---|---:|---:|
| Share **one description** — regenerations | 42,794 | **52.7%** |
| …and body size within 20 chars — near-certainly trivial | 16,775 | 20.6% |
| **Every content has a distinct description** — genuinely different | 31,806 | **39.2%** |

**About half the collisions are the same skill regenerated; about 40% are genuinely different
skills sharing a name.** This split is what makes the three-case rule in D13 possible: an
arbitrary canonical is harmless for the first group and actively misleading for the second.

### The worst offenders are machine-generated

```
115 contents, 1 repo   David-Li0406/skill-creator
102 contents, 1 repo   David-Li0406/code-review
101 contents, 1 repo   Klotzkette/kaltstart-triage
 95 contents, 1 repo   David-Li0406/cbt
 88 contents, 1 repo   Klotzkette/einstieg-routing
```

`Klotzkette` is already flagged in [BACKLOG.md](BACKLOG.md) as a suspected mass-published
catalog (21,957 entries). These are not 115 different skills, which is why crowning one as
canonical would be worse than reporting ambiguity.

**Practical consequence:** 115 is the maximum group size, so 8 hex characters of `content_key`
is overkill — collision inside a group is negligible — and the 100-character slug cap is never
threatened.

---

## 2b. The naming pass, verified — and what D13 actually saves

**Two different hashes are at work here, and they do different jobs.**

*GitSkills'* hash (`file_sha`, surfaced as `dedup_primary`) decides **how many skills exist**:
it collapses 3,797,117 file occurrences into 1,877,981 byte-distinct contents. Our format gates
then take that to **1,610,957**. That number is a property of the dataset, not of anything we
built.

*Our* content hash (D13) decides **what each of those is called**. It does not add or remove a
single row — it stops rows being lost to name collisions.

| Stage | Count |
|---|---:|
| File occurrences | 3,797,117 |
| Byte-distinct (GitSkills `file_sha`) | 1,877,981 |
| After format gates | **1,610,957** |
| Distinct `(owner, base_slug)` | 1,487,272 |
| **Named by D13** | **1,610,957** — all of them |
| **Lost under `ON CONFLICT DO NOTHING`** | **123,685** |

**123,685 skills — 7.7% of the corpus — would have been silently discarded** by the naming
behaviour that was in place before D13. Not rejected, not logged: dropped by a conflict clause,
exactly as migration 005 was written to prevent, at 3× the scale 005 was sized against.

### Verification

`scripts/corpus/naming.sql` and the §2 collision survey are independent queries. All four
figures agree: 1,610,957 gated rows, 81,238 contested groups, 204,923 rows involved, largest
group 115.

| Case | Rows |
|---|---:|
| uncontested → bare slug | 1,406,034 |
| canonical → keeps bare slug | 42,794 |
| duplicate-suffixed | 56,191 |
| distinct-suffixed | 105,938 |

Invariants over all 1.6M rows: **zero** `(owner, final_slug)` collisions, **zero** slugs over
100 characters, **zero** slugs failing `createSkillSchema`'s kebab rule.

### The bug the invariants caught

The kebab check failed first time, on 12 rows. **Truncating a slug to 100 characters can
reintroduce a trailing hyphen** that the earlier strip removed — every one of the 12 was
exactly 100 characters and ended in `-`. `slugifySkillName` already guards this with
`.slice(0, 100).replace(/-$/, "")`; the SQL did not, and the same applies to the 91-character
truncation used before appending a hash suffix.

Fixed *inside* the base slug rather than afterwards. Stripping after grouping would have let
two previously distinct slugs become equal with the contested check none the wiser — a
correctness bug hiding behind a cosmetic one.

### Environment trap

macOS writes AppleDouble sidecars (`._part-00000.parquet`) onto exFAT volumes, and DuckDB
fails on them with *"No magic bytes found at end of file"*. Glob `part-*.parquet`, not
`*.parquet`.

---

## 3. Dataset source

| | Zenodo | Hugging Face mirror |
|---|---:|---:|
| Size | 44.4 GB (SQLite) | **13.43 GB** (Parquet) |
| `artifacts` | | 31 shards, 6.45 GB, 3,797,117 rows |
| `artifact_siblings` | | 45 shards, 6.96 GB, 7,264,865 rows |
| `repos` | | 1 shard, 0.02 GB, **282,200 rows** |

Same row counts; the mirror is published by `mvaccargiu` — Vaccargiu, one of the dataset's
authors. Parquet is columnar and compressed; the Zenodo file is an uncompressed database
carrying its indexes.

**Columnar access is why the collision measurement took 100 seconds and needed no download at
all** — DuckDB read six small columns over HTTP and never touched `content`, which is ~90% of
the bytes. Worth remembering before anyone waits on a 13 GB transfer to answer a question.

**282,200 repos** is the number the freshness plan needed and [FINDINGS.md](FINDINGS.md) did
not carry: repo-level polling has 282,200 units, not 1.61M.

**Shards are not partitioned by owner** — 29,829 owners appear in both shard 0 and shard 1 —
so any per-owner aggregation must read all 31 shards. A subset would silently undercount.

---

## 4. Live registry state, 2026-09-06

| Table | Rows |
|---|---:|
| `skills` | 4,838 |
| `seen_source_urls` | 10,929 |
| `skillsets` | **0** — nothing populates them |
| `watched_repos` | 17 |
| `publishers` | 1 |
| `spec_versions` | 1 (`1.0`, current) |

All 4,838 skills declare `spec_version` **1.0**; **zero** declare 1.1. If the spec has moved,
the registry has no knowledge of it.

### Provenance of the 4,838 rows — none are hand-published

Measured because D13's incumbency rule depended on the opposite being true.

| | |
|---|---|
| Distinct owners in `skills` | 16 — **all** are watched-repo owners |
| Publishers | 1: `skilldex-official`, the seeder's own |
| Rows with `content_key` | **0** |
| `install_count` maximum | **4** |
| URLs fetched then discarded on name conflict | **10,929** — `sickn33` 8,104, `alirezarezvani` 1,028, `TerminalSkills` 1,013 |

Everything in the registry arrived through `scripts/seed.ts` using the service key, which
bypasses auth entirely — consistent with the publisher-identity bug that makes the
authenticated publish path unusable. So there is no hand-published content to protect, and
the 4,838 kept rows are simply the arbitrary insert-order winners of 15,767 candidates.

**Corpus coverage of the watched repos: 16 of 17.** `sickn33/antigravity-awesome-skills` and
`OpenAEC-Foundation/…` appear under their post-rename names
(`sickn33/agentic-awesome-skills`, `Impertio-Studio/…`). Only `tiandee/awesome-skills-hub` is
absent, and discovery finds **0** `SKILL.md` files in it. Nothing unique would be lost by
rebuilding the watched repos from the corpus.

**Tags are effectively unused today** — sampled over 1,000 rows: average **0.23** tags per
skill, maximum 1, 77% have none, 2 distinct values in the sample. This is why D8 defers the
normalised tag table rather than building it; whether the *imported* corpus carries dense
frontmatter tags is still unmeasured.
