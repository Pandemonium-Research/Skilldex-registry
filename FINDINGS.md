# GitSkills Corpus Analysis — Findings

Measurements against the full [GitSkills dataset](https://doi.org/10.5281/zenodo.21875637)
(Destefanis, Graziotin, Vaccargiu & Ortu, MSR '27), taken to decide whether Skilldex
should seed its registry from it.

Run date: 2026-08-25. Deferred work is in [BACKLOG.md](BACKLOG.md); build state and next
steps are in [IMPORT_STATUS.md](IMPORT_STATUS.md).

**Provenance of numbers.** The dataset publishes exactly one dedup figure — 1,877,981
byte-distinct contents. Everything else below is our own measurement over the corpus,
and is labelled as such. Nothing here is quoted from the paper's findings.

---

## Headline

Deduplication is the dataset's own byte-exact grouping — no normalization, no
similarity threshold. After quality gates that mirror what the registry's discovery
already does, that leaves **1,610,957 candidate skills**.

Of those, **215,504 (13.4%) appear under more than one GitHub account**. That is the
proposed import target.

---

## 1. The funnel

| Stage | Count | Δ |
|---|---:|---:|
| File occurrences in dataset | 3,797,117 | |
| Byte-distinct contents (the dataset's figure) | 1,877,981 | −50.5% |
| **Survived quality gates** | **1,610,957** | −14.2% |

There is no further dedup step. Two skills are the same entry only if their bytes are
identical, which is the dataset's `file_sha` grouping used as-is.

### Why no normalization

An earlier version of this analysis normalized before hashing — line endings, case,
markdown punctuation, whitespace runs, and the front-matter `name` — then hashed body
plus description. That collapsed a further 147,409 entries (to 1,463,548).

It was dropped. Normalization decides that some textual differences don't matter, and
that decision is not safely automatable in prose: lowercasing merges `API` with `api`,
stripping `#` merges a heading with body text of the same words, stripping `*` merges
emphasis with plain. Those are presentational most of the time, which is not the same
as always. Byte equality needs no such judgement and cannot merge two things that
differ. The 9% of entries it costs is a cheap price.

An earlier attempt at near-duplicate clustering (MinHash + LSH at Jaccard ≥ 0.85) was
also rejected — see §5.

---

## 2. Redistribution — how widely a skill is copied

**What is measured:** how many distinct GitHub accounts hold a file with this exact
content hash, in a public repo, on its default branch.

**What is not measured: use.** A skill written by one team, used daily in their own
repo, and never copied scores exactly 1. That is uncopied, not unused — most software
is uncopied. This metric says nothing about whether a skill works, is loaded by an
agent, or is valued by anyone. Treat it as *redistribution breadth* only.

| Redistribution | Entries | Share |
|---|---:|---:|
| ≥ 50 owners | 3,671 | 0.23% |
| ≥ 10 owners | 23,363 | 1.45% |
| ≥ 5 owners | 51,435 | 3.19% |
| **≥ 2 owners** | **215,504** | **13.38%** |
| 1 owner | 1,395,453 | 86.62% |

The ≥ 2 slice spans **23,081 distinct canonical owners**.

### Known confounds

Copy count is a weak proxy even for redistribution, and we have not controlled for:

- **Scaffolding tools** that emit an identical file into every user's project. This
  looks like independent adoption and is not.
- **Template repositories** cloned rather than forked.
- **Monorepo vendoring**, where one organisation's many repos each carry a copy.

One point in its favour: GitHub code search indexes forks only when they have more
stars than the parent, so ordinary forks do not inflate the count.

### Mass-published catalogs

Some accounts publish thousands of near-identical skills. Whether these are
machine-generated is **unknown** — we observed the pattern, not its cause. (The paper
lists this as an open question: RQ 1d asks how many skills agents themselves create.)

The ≥ 2 owner threshold removes most but not all of them:

| Owner | Entries | Surviving ≥ 2 owners | Max owners |
|---|---:|---:|---:|
| `Klotzkette` | 21,957 | 1 | 2 |
| `zwright8` | 8,170 | 0 | 1 |
| `membranedev` | 3,038 | 48 | 2 |
| `salmandev` | 1,246 | 0 | 1 |
| `firebitsbr` | 1,007 | 0 | 1 |
| `lionelsimai` | 411 | 0 | 1 |
| `FDU-INS` | 460 | **343** | 32 |

`FDU-INS` is the counterexample: 343 of its entries appear under two or more accounts,
one under 32. Either that content is genuinely being copied, or something systematic is
replicating it. The threshold alone does not settle it, so **a bulk import should not
assume catalogs are fully excluded.**

---

## 3. Namespace collision

Over the 215,504 candidate entries:

| Key | Distinct | Collision rate |
|---|---:|---:|
| bare `name` | 126,138 | **41.5%** |
| `owner/name` | 209,647 | 2.7% |

These entries have distinct content by construction, so a name collision means
**different skills sharing one name** — not duplicates. Most contested: `skill-creator`
(433 distinct skills), `code-review` (314), `frontend-design` (299), `impeccable` (187).

The current schema declares `name text NOT NULL UNIQUE`
([`001_initial_schema.sql`](supabase/migrations/001_initial_schema.sql)) and
[`scripts/seed.ts`](scripts/seed.ts) inserts with `ignoreDuplicates: true`, so a bulk
import would silently discard 41.5% of the candidates with the winner decided by insert
order. **An `owner/name` namespace is a prerequisite.** It leaves 2.7% still colliding
within a single owner, which needs a deterministic tiebreak.

Separately, **14,511 candidate names (6.7%)** fail the kebab-case rule in
`createSkillSchema`, so imported names need slugification or a relaxed rule.

---

## 4. Corpus composition

### Quality gates (of 1,877,981 representatives)

| Reason dropped | Count | Share |
|---|---:|---:|
| `frontmatter_valid = 0` | 252,280 | 13.4% |
| filename ≠ `SKILL.md` | 35,381 | 1.9% |
| **total** (conditions overlap) | **267,024** | **14.2%** |

Both gates are required by the format, not invented here. The Agent Skills
specification states a skill "is a folder containing a `SKILL.md` file", marking that
filename **Required**; front matter carries the `name` and `description` an agent
matches against. The registry already enforces both — [`seed.ts:68`](scripts/seed.ts#L68)
filters tree entries to `/SKILL.md`, [`fetch.ts:49`](src/github/fetch.ts#L49) rejects
unparseable front matter. GitSkills contains other files only because it was assembled
from a filename code-search rather than a tree scan.

### Location class

| Class | Count | Share |
|---|---:|---:|
| `skills-dir` | 1,037,938 | 55.3% |
| `other` | 566,322 | 30.2% |
| `canonical` | 273,721 | 14.6% |

### License posture (of 1,610,957 gated skills)

| Category | Count | Share |
|---|---:|---:|
| **No license at all** (all rights reserved) | **782,454** | **48.6%** |
| Permissive (MIT 516,332 · Apache-2.0 145,304 · …) | 672,083 | 41.7% |
| Copyleft (GPL/AGPL/LGPL) | 41,383 | 2.6% |
| NOASSERTION / other | 115,037 | 7.1% |

Nearly half carries no license. The registry stores **metadata only** — `source_url`
points at GitHub and the CLI fetches from there — so indexing and linking stays
defensible. This does hard-block ever caching or mirroring skill content.

### Source data licensing

GitSkills is **CC-BY-4.0** on Zenodo and Hugging Face: commercial use and
redistribution permitted, attribution required. The Hugging Face card notes `content`
fields "remain subject to the license of their origin repository."

---

## 5. Rejected: near-duplicate clustering

An earlier pass merged skills whose normalized bodies were ≥ 0.85 Jaccard similar
(MinHash + LSH + greedy centroid clustering), reaching 1,274,159 entries. Rejected for
three reasons:

- **The threshold encodes a judgement silently.** 0.85 is not defensible to a publisher
  whose skill disappeared into someone else's entry.
- **It keyed on the body alone, so it merged skills with unrelated descriptions.**
  Sampling 3,000 of the 33,320 affected clusters: median worst-pair description word
  Jaccard **0.458**, with ~17,300 clusters containing a pair below 0.5. The description
  is what an agent matches a task against, so those skills fire in different situations.
- **In one case it was actively harmful:** `Brand Guidelines` was a clean group of 283
  accounts that clustering buried under 1,851 unrelated variants.

Both superseded implementations (`scripts/cluster_skills.py` for near-dup clustering,
`scripts/dedupe_skills.py` for normalized dedup) have been deleted. Neither is needed:
GitSkills publishes `file_sha` per artifact, so byte dedup is a `GROUP BY` in the
importer rather than a pipeline.

### What byte dedup costs

Rejecting clustering means accepting that byte equality **undercounts redistribution**.
Change one word and the SHA changes: a skill copied into 100 repos where 30 people
tweaked a line scores 70, not 100, and the 30 variants become singletons the ≥ 2 gate
discards. The clustering pass absorbed **189,389 entries** as ≥ 0.85 similar to another
— that is the scale of what byte equality splits apart.

The error runs both ways, so the count is not a bound in either direction: edits
undercount it, while scaffolding tools and monorepo vendoring (§2) inflate it. This is
the accepted price of never merging two things that differ.

---

## 6. Corrections and calibration

Errors made during this analysis, recorded so the numbers above are read with
appropriate caution.

**A metric bug.** An earlier redistribution count of 61,246 at ≥ 2 owners was wrong. It
counted distinct owners only among representative rows, so a skill vendored
byte-identically into 500 repos scored as one owner. Correct figure: **215,504**.

**An overclaim.** An earlier draft said 95.8% of skills "have never been picked up by
anyone but their author," which conflates copying with use. Corrected in §2.

**Sample extrapolations.** Projections made from the 0.69% GitSkills sample before the
full corpus was processed:

| Quantity | Estimate | Measured | Verdict |
|---|---:|---:|---|
| Near-dup collapse (Chao1) | 2.77x | 1.26x | badly over |
| Name collision (Chao1) | 91% | 41.5% | badly over |
| `code-review` competitors | ~5,345 | 314 | badly over |
| Gate attrition (per-row) | 13.9% | 14.2% | close |
| No-license share (per-row) | 51.8% | 48.6% | close |
| Canonical location share (per-row) | 13.6% | 14.6% | close |

**Per-row properties extrapolate reliably from a uniform sample; distinct-count and
richness estimates do not.** The sample also cannot measure near-duplicate collapse at
all — it draws distinct content groups, so P(both members of a near-dup pair sampled)
≈ 4.8×10⁻⁵.

---

## 7. Implications for the registry

1. **Fix the namespace first.** `owner/name`, not global `UNIQUE(name)`, plus a
   deterministic tiebreak for the residual 2.7%. Prerequisite for import; a blocker for
   organic growth regardless.
2. **Import the ≥ 2 owner slice** — 215,504 entries. See [BACKLOG.md](BACKLOG.md) for
   why not the full 1.61M.
3. **Slugify imported names** — 6.7% fail the current rule.
4. **Do not assume catalogs are excluded** by the redistribution threshold (§2).
5. **Consent, not copyright, is the exposure.** These skills were never submitted.
   Metadata-only linking is defensible; an opt-out path should exist before the corpus
   is publicly searchable.

---

## 8. Open questions we cannot answer from this data

- **Who wrote these skills and why.** No taxonomy of skill purpose exists (the paper's
  RQ 1b). We can see structure and spread, not intent.
- **Whether mass-published catalogs are machine-generated** (RQ 1d).
- **Whether any skill actually works**, or is ever loaded by an agent. Redistribution is
  not quality and not usage.
- **Link liveness.** Collected July 2026; some `source_url`s will 404, and a dead link
  fails visibly at `skillpm install`.
- **Conformance scores.** Computable offline — `validateSkill` needs only
  `{skillMd, files}`, both present in the dataset — but not yet computed.
