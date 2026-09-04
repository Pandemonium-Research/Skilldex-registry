# GitSkills Import — Status and Next Steps

Working state of the effort to seed the registry from the
[GitSkills dataset](https://doi.org/10.5281/zenodo.21875637). Corpus measurements live
in [FINDINGS.md](FINDINGS.md); deferred work in [BACKLOG.md](BACKLOG.md). This file is
the "where are we / what's next" record.

Last updated: **2026-08-25**

---

## 1. Where things stand

### Done

| | |
|---|---|
| Corpus analysis | Complete — [FINDINGS.md](FINDINGS.md) |
| Dedup basis chosen | Byte-exact, using the dataset's own `file_sha`. No script needed |
| Migration 005 | **Applied to production** |
| Registry API owner-scoping | Written, typechecks, 18/18 tests pass — **not deployed** |
| Preflight tooling | [`scripts/preflight-005.ts`](scripts/preflight-005.ts), `npm run preflight:005` |
| Rejected approaches | `cluster_skills.py` and `dedupe_skills.py` deleted |

### Not done

| | |
|---|---|
| Bare-name resolution rule | Designed, not implemented — §3 below |
| Importer (`scripts/import-gitskills.ts`) | Not written — §4 |
| Deploy of the owner-scoped API | Not done — see the warning in §2 |
| CLI update | Untouched, by instruction. Separate repo |
| Opt-out / takedown path | Not built — [BACKLOG.md](BACKLOG.md) |

---

## 2. Live registry state

Measured 2026-08-25, after migration 005.

```
rows                    3,191
distinct owners            16
null/empty owner            0
duplicate (owner,name)      0
display_name populated  3,191
content_key set             0     <- nothing imported yet
publishers                  1     <- skilldex-official, owns all 3,191 rows
trust_tier            community=3,186   verified=5
```

**Skills per owner**

| Owner | Skills | | Owner | Skills |
|---|---:|---|---|---:|
| `sickn33` | 1,431 | | `agent-sh` | 31 |
| `TerminalSkills` | 932 | | `ailabs-393` | 22 |
| `alirezarezvani` | 355 | | `diegomarino` | 18 |
| `tobihagemann` | 95 | | `machina-sports` | 18 |
| `Orchestra-Research` | 87 | | `arpitg1304` | 10 |
| `OpenAEC-Foundation` | 73 | | `PhilipStark` | 5 |
| `mxyhi` | 69 | | `anthropics` | 5 |
| `softaworks` | 39 | | `tiandee` | 1 |

**The five verified skills** — all Anthropic, all bare-name candidates:
`anthropics/pdf`, `anthropics/docx`, `anthropics/pptx`, `anthropics/xlsx`,
`anthropics/template-skill`.

### ⚠ Working tree is ahead of the deployment

Migration 005 is live but the Vercel app at `skilldex-registry.vercel.app` still runs
pre-migration code. Reads are fine — nothing was removed — but **`POST /skills` will
fail**, because it inserts without an `owner` and the column is `NOT NULL`. Deploy the
owner-scoped API, or confirm nothing is publishing, before leaving this state for long.

### Unverified

Migration 005's column additions and data were verified directly. The **constraint
swap was not** — PostgREST cannot read `pg_constraint`. Worth one confirmation in the
SQL editor:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'skills'::regclass AND contype = 'u';
```

Expect `skills_owner_name_key UNIQUE (owner, name)` present and no `UNIQUE (name)`.

---

## 3. Bare-name resolution — designed, to implement

### The problem

Until 005, `skills.name` was globally unique, so `GET /skills/pdf` had exactly one
answer and `skillpm install pdf` worked. Uniqueness is now `(owner, name)`, which is
what makes the import possible — but a bare name is no longer a unique address.

Measured blast radius against the 215,504 import candidates:

```
existing names gaining >=1 imported claimant   2,996  (93.9% of the registry)
  gaining exactly 1                              534
  gaining >= 10                                  747
```

Worst affected: `skill-creator` (443 incoming), `code-review` (326),
`frontend-design` (302), `impeccable` (187), `review` (174), `pdf` (129), `docx` (116),
`pptx` (112), `xlsx` (101). Four of those are verified Anthropic skills — without a
rule, the official skills become unreachable by bare name, buried under community
copies of themselves.

### The decision

**Bare names resolve to official skills only. Everything else requires `owner/name`.**

The discriminator is `trust_tier = 'verified'`, which
[SKILLDEX_REGISTRY_SPEC.md](SKILLDEX_REGISTRY_SPEC.md) line 103 defines as *"reserved
for Anthropic's own published skills. This is a hard boundary — do not build promotion
logic."* The importer always writes `community`, so **no imported skill can ever claim
a bare name**. That is enforced by policy, not by convention.

Rejected alternatives, and why:

- **`published_by IS NOT NULL`** — useless. All 3,191 rows have it set, all to the same
  publisher. Nothing was ever hand-published through `POST /skills`.
- **`content_key IS NULL`** — works, and preserves all 3,191 current lookups, but makes
  bare-name behaviour depend on provenance rather than status.
- **Resolve bare names whenever unambiguous** — rejected as unpredictable: whether
  `skillpm install foo` works would depend on whether a stranger later imports a skill
  also called `foo`. Time-varying behaviour is worse than a strict rule.

### Accepted cost

**3,186 currently-working bare-name installs stop resolving** — every community skill
in the registry, not only imported ones. Only the five Anthropic skills keep bare names.
This is deliberate: the break is cheapest now, while the registry is small.

### The rule

For `GET /skills/:name` and `GET /skills/:name/install`:

1. Match `name` where `trust_tier = 'verified'`. Exactly one → resolve.
2. Anything else → `409` with suggestions.

### Response shape

```json
{
  "error": "\"pdf\" is not an official skill name. Install it as owner/name.",
  "code": "QUALIFIED_NAME_REQUIRED",
  "name": "pdf",
  "total_matches": 129,
  "suggestions": [
    { "qualified_name": "alice/pdf", "owner": "alice",
      "score": 94, "trust_tier": "community",
      "description": "Extract text and tables from PDFs" }
  ]
}
```

Top 3 exact-name matches ordered by `score DESC NULLS LAST`. **Rank by `score`, not
`install_count`** — installs are 0 across the entire imported corpus, so that ordering
would be arbitrary, whereas the importer gives every row a real conformance score.

### Files to change

| File | Change |
|---|---|
| [`src/db/skills.ts`](src/db/skills.ts) | `getSkillByBareName` → `resolveOfficialName(name)` + `suggestSkillsByName(name, limit)` |
| [`src/routes/skills.ts`](src/routes/skills.ts) | Legacy `GET /:name` returns the new shape |
| [`src/routes/install.ts`](src/routes/install.ts) | Legacy `GET /:name/install` likewise |
| [`src/types/api.ts`](src/types/api.ts) | Add the error/suggestion types |

`searchSkills` is **not** touched. The existing `skills_name_lookup_idx` btree on
`(name)` already serves both queries.

### Out of scope

- **The CLI prompt.** "Did you mean `anthropics/pdf`?" with a selection prompt belongs
  in the `Skilldex` repo. The API only supplies the data.
- **Typo suggestions.** A bare name matching nothing stays a 404. Routing that through
  `searchSkills(q=name, limit=3)` so `pdff` suggests `anthropics/pdf` is possible and
  would use search rather than change it — undecided.

---

## 4. The importer — not written

Target: **215,504 skills**, being the entries appearing under ≥ 2 distinct GitHub
accounts, out of 1,610,957 gated byte-distinct contents, out of 3,797,117 file
occurrences.

Gate (mirrors what registry discovery already does):

```sql
dedup_primary = 1
AND content IS NOT NULL AND content <> ''
AND filename = 'SKILL.md'
AND frontmatter_valid = 1
```

Then group by `file_sha`, count distinct `split_part(repo_full_name, '/', 1)`, keep
`>= 2`. Note the owner count must be taken over **all** rows sharing a `file_sha`, not
only `dedup_primary = 1` rows — counting representatives only was a real bug during
analysis and understated the result by 3.5x (FINDINGS §6).

### Decisions still open

1. **Which carrier becomes the row.** A skill held by 32 owners has 32 candidate repos,
   and the choice sets `owner` and `source_url`. Suggested: earliest `first_commit_at`,
   with `location_class` as tiebreak.
2. **Intra-owner name collisions (2.7%).** Same owner, same slug, different content.
   Suggested: deterministic suffix from `content_key`.
3. **Whether to compute `score` for all 215,504.** Offline — `validateSkill` needs only
   `{skillMd, files}`, both in the parquet — but it is 215K validator runs plus reading
   `artifact_siblings`. **Skipping it leaves every imported row at `score: null`**,
   which breaks `?sort=score` and removes the ranking the §3 suggestions depend on.
   Treat as required.

### Invariants the importer must hold

- `content_key` is non-null on every imported row. §3's provenance distinction and the
  unique index both depend on it.
- `trust_tier` is always `community`. Spec line 103.
- `name` is slugified via `slugifySkillName`; the authored form goes in `display_name`.
- Upsert on `content_key` so re-running is idempotent.

---

## 5. Data locations

| Path | What |
|---|---|
| `D:/gitskills/data/{artifacts,repos,artifact_siblings,mining_runs}/*.parquet` | The corpus, 13.43 GB. `artifacts` + `repos` (6.47 GB) covers the import |
| `D:/gitskills/existing_names.csv` | The 3,191 current registry names, used for the collision analysis |
| `D:/gitskills/skill_entries.sqlite` | **Superseded** — 0.97 GB output of the rejected normalized dedup. Safe to delete |
| `D:/gitskills/skill_clusters.sqlite` | **Superseded** — 0.5 GB output of the rejected near-dup clustering. Safe to delete |

`artifacts` columns: `repo_full_name`, `path`, `filename`, `location_class`, `file_sha`,
`discovered_at`, `content`, `content_fetched`, `frontmatter_valid`, `name`,
`description`, `body_chars`, `history_fetched`, `composition_fetched`, `dedup_primary`,
`first_commit_at`, `last_commit_at`, `commit_count`, `sibling_count`, `sibling_bytes`,
`has_scripts`, `has_references`, `content_sha_ok`, `composition_truncated`,
`first_commit_author`, `first_commit_author_type`, `first_commit_message`,
`last_commit_author`, `last_commit_author_type`, `last_commit_message`.

---

## 6. Suggested order of work

1. **Deploy the owner-scoped API** — closes the gap in §2 that currently breaks publishing.
2. **Implement §3**, the bare-name rule. Small, and it must land before any import.
3. **Write the importer**, resolving the three decisions in §4.
4. **Dry run** at `--limit 500` against a Supabase branch; run it twice to prove
   idempotency.
5. **Decide on the opt-out path** ([BACKLOG.md](BACKLOG.md)) — FINDINGS §7 argues it
   should exist before 215K unsubmitted skills become publicly searchable.
6. **Full import**, then update the CLI.
