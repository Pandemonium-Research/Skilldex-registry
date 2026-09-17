import { getDb } from "./client.js";
import { toSkillRow, jsonOrNull } from "./rows.js";
import {
  boundedCountSql,
  countLimitArg,
  interpretCount,
  takePage,
  type TotalRelation,
} from "./pagination.js";
import { READ_STAT_SQL } from "./stats.js";
import type { SkillRow } from "../types/skill.js";
import type { SearchSkillsQuery } from "../types/skill.js";
import type { InArgs } from "@libsql/client";

/**
 * `seq` is a stable secondary sort on every ordering.
 *
 * Postgres ordered by a single column, so rows tied on it came back in whatever order the
 * planner chose — which meant LIMIT/OFFSET paging could repeat or skip a row between pages.
 * With `install_count` zero across an imported corpus, nearly everything is tied, so this
 * stops being theoretical.
 */
const SORT_MAP: Record<string, string> = {
  // bm25 returns negative scores, best first, so ASC is most-relevant-first.
  // m.seq, not s.seq — identical by the join condition, but ordering on the subquery
  // alone lets SQLite sort before touching the table.
  relevance: "m.rank ASC, m.seq ASC",
  installs: "s.install_count DESC, s.seq ASC",
  score: "s.score DESC, s.seq ASC",
  recent: "s.published_at DESC, s.seq ASC",
  name: "s.name ASC, s.seq ASC",
};

/**
 * Orderings for a predicate already confined to the curated tier (D26).
 *
 * `installs` and `recent` have curated partial indexes in exactly those orders, so they stay as they
 * are. `score` and `name` do not, and left alone SQLite walks the full-table index in that order and
 * filters — reading most of 1.6M rows to find ~4,863 curated ones (485,611 rows for a tag filter by
 * score). The unary `+` makes the ordering an expression no index can satisfy, so the planner reads
 * the curated partial index and sorts those few thousand rows instead. A column behind `+` keeps its
 * collation, so the order itself does not change.
 */
const CURATED_SORT_MAP: Record<string, string> = {
  ...SORT_MAP,
  score: "+s.score DESC, s.seq ASC",
  name: "+s.name ASC, s.seq ASC",
};

/**
 * Which ordering applies when the caller did not ask for one.
 *
 * A text search sorted by popularity is not a search — it answers "what is popular among
 * things that matched" rather than "what matches best". The Postgres path did exactly that:
 * it narrowed with textSearch and then ordered by install_count, so relevance never entered
 * the ordering. With install_count zero across an imported corpus it degenerates completely.
 *
 * `relevance` is only meaningful when the FTS table is joined, so it is not reachable without
 * a query — asking for it explicitly without `q` falls back to `installs`.
 */
export function resolveSort(requested: string | undefined, hasQuery: boolean): string {
  if (requested && requested !== "relevance") return requested;
  if (hasQuery) return "relevance";
  return "installs";
}

/**
 * Turn free user text into an FTS5 MATCH expression.
 *
 * This is not optional politeness: FTS5 raises a syntax error on bare `"`, `*`, `(`, `-`,
 * `OR`, `NEAR` and friends, so passing a search box straight through would turn
 * `size 10" pipe` into a 500. Postgres `websearch_to_tsquery` swallowed all of that.
 *
 * The query is split on *runs of non-word characters*, and each surviving run of word
 * characters is wrapped as an FTS5 string literal, then ANDed — matching websearch's default
 * of "all terms must appear". Returns null when nothing survives, and callers treat that as
 * "no text filter" rather than "match nothing", so a query of only punctuation lists results
 * instead of returning an empty page.
 *
 * Splitting rather than deleting is the whole point, and it was the bug. This used to split on
 * whitespace and then strip non-word characters *inside* each token, which glued hyphenated
 * words together: `skillset-creator` became the single term `skillsetcreator`. FTS5's tokenizer
 * splits on the hyphen when it builds the index, so that glued token is in no index and the
 * published `skillset-creator` skillset could not be found by its own name — while
 * `skillset creator`, with a space, found it at once.
 *
 * kebab-case is mandated for skill names, so this made the registry unable to find a skill by
 * the exact format the specification requires. It also failed quietly rather than loudly:
 * `conventional-commit` returned the 15 documents containing the literal glued token instead of
 * the 8,122 matching the two words, which reads as a working search returning a narrow result.
 *
 * Splitting also makes the terms safe by construction — a run of `[\p{L}\p{N}_]` cannot contain
 * any character FTS5 treats as syntax, so the stripping step this replaced is not needed.
 */
export function toFtsQuery(q: string): string | null {
  const terms = q
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .map((t) => `"${t}"`);

  return terms.length ? terms.join(" AND ") : null;
}

export interface SearchSkillsResult {
  skills: SkillRow[];
  /** Exact when `total_relation` is "eq"; a lower bound when "gte". */
  total: number;
  total_relation: TotalRelation;
  has_more: boolean;
}

export async function searchSkills(params: SearchSkillsQuery): Promise<SearchSkillsResult> {
  const db = getDb();
  const where: string[] = [];
  const whereArgs: InArgs = [];
  // True once the predicate excludes imported rows. That is what lets the curated partial indexes
  // serve a query (D19), and it selects CURATED_SORT_MAP below.
  let curatedOnly = false;

  const fts = params.q ? toFtsQuery(params.q) : null;
  const ftsArgs: InArgs = fts ? [fts] : []; // bound first: FROM precedes every WHERE placeholder

  // Provenance filter. Unset by default: the whole registry is searchable, which is the point
  // of having imported it.
  //
  // ⚠ The redundant-looking `source <> 'imported'` is load-bearing. The partial indexes are
  // declared WHERE source <> 'imported', and SQLite matches partial indexes *syntactically* —
  // `source = 'seeded'` on its own does not qualify, so the planner falls back to SCAN skills.
  // Measured on the 1.6M corpus: 87,047ms without the conjunct, 1,152ms with it, same rows.
  // 'imported' is excluded because it is 99.7% of the table; there the bounded count hits its
  // cap almost immediately and the page query is served by the install_count index (266ms).
  if (params.source) {
    where.push(
      params.source === "imported" ? "s.source = ?" : "s.source <> 'imported' AND s.source = ?"
    );
    whereArgs.push(params.source);
    curatedOnly = params.source !== "imported";
  }

  if (params.tier) {
    // `community` is 99.7% of the table, which makes skills_trust_tier_idx the worst access path
    // there is for it: SQLite fetched every community row through the index and then sorted them
    // all to return one page. The unary `+` keeps that index out of the plan, so the sort index is
    // walked instead and the scan stops at limit + 1 — 3,240,632 rows read became 10,024, same
    // page and count (D26). `verified` is 7 rows, where the index is exactly right.
    where.push(params.tier === "community" ? "+s.trust_tier = ?" : "s.trust_tier = ?");
    whereArgs.push(params.tier);
  }

  if (params.min_score !== undefined) {
    where.push("s.score >= ?");
    whereArgs.push(params.min_score);
  }

  if (params.spec_version) {
    // Nothing indexes spec_version across the table: all but a handful of rows are on 1.0, so a full
    // index would be 1.6M entries to find a few. A version matching nothing therefore walked the
    // whole table for the page and again for the count — 3,230,644 rows read (D26).
    // skills_spec_version_other_idx (005) holds only the rows off 1.0, and SQLite uses a partial index
    // only when the query repeats its predicate, so any other version carries it as a conjunct
    // (D19). 1.0 itself needs no index: nearly every row matches, so the page and the capped count
    // both stop almost at once.
    where.push(
      params.spec_version === "1.0"
        ? "s.spec_version = ?"
        : "s.spec_version <> '1.0' AND s.spec_version = ?"
    );
    whereArgs.push(params.spec_version);
  }

  if (params.owner) {
    where.push("s.owner = ?");
    whereArgs.push(params.owner);
  }

  if (params.tags) {
    const tagList = params.tags.split(",").map((t) => t.trim()).filter(Boolean);
    if (tagList.length) {
      // Only curated rows carry tags: build.ts inserts every imported row with tags NULL, and
      // refreshTagCounts aggregates the curated tier alone for the same reason. Saying so in the
      // predicate lets the curated partial indexes serve the filter instead of json_each walking
      // all 1.6M rows — 3,229,702 rows read became 8,784 for sort=installs, same page and count
      // (D26). Skipped when the provenance filter above already carries the conjunct.
      if (!curatedOnly) {
        where.push("s.source <> 'imported'");
        curatedOnly = true;
      }
      // Postgres used `tags && array[...]` over a GIN index. SQLite has no array type, so
      // this walks the JSON — of curated rows only, now. See D8 for why the normalised table
      // is deferred.
      where.push(
        `EXISTS (SELECT 1 FROM json_each(s.tags) WHERE value IN (${tagList
          .map(() => "?")
          .join(", ")}))`
      );
      whereArgs.push(...tagList);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sort = resolveSort(params.sort, Boolean(fts));
  const orderSql = (curatedOnly ? CURATED_SORT_MAP : SORT_MAP)[sort] ?? SORT_MAP.installs;

  // Full-text search over name + description.
  //
  // Two FROM clauses, because the page needs a rank and the count does not. bm25() is an FTS5
  // auxiliary function evaluated per matched row, so dropping it from the count subquery
  // avoids scoring the entire match set purely to count it.
  //
  // The rank stays inside an FTS-only subquery: `m` is then an ordinary relation the outer
  // query can filter and order freely. This was originally needed because bm25() is rejected
  // ("unable to use function bm25 in the requested context") alongside a window function.
  // The window function is gone, but the subquery stays — the payoff from removing it is
  // unmeasured and the failure mode is a 500 on every search.
  const fromPage = fts
    ? "skills s JOIN (SELECT rowid AS seq, bm25(skills_fts) AS rank" +
      " FROM skills_fts WHERE skills_fts MATCH ?) m ON m.seq = s.seq"
    : "skills s";
  const fromCount = fts
    ? "skills s JOIN (SELECT rowid AS seq" +
      " FROM skills_fts WHERE skills_fts MATCH ?) m ON m.seq = s.seq"
    : "skills s";

  // A search ranked by relevance with nothing else narrowing it ranks *inside* FTS5 (D26).
  //
  // FTS5's `rank` column is bm25() with default weights — the same function fromPage calls — and
  // FTS5 can order by it under a LIMIT within the virtual table, so only the page's rows leave FTS5
  // and are joined. Scoring every match and sorting outside read 879,553 rows for `skill`; this
  // reads the page plus the capped count. Pages were identical in 30 of 30 comparisons across
  // queries, limits and offsets (FINDINGS §16).
  //
  // ⚠ Never add a rowid tiebreak inside the subquery: it takes FTS5 off that path (589,744 rows for
  // `skill`). FTS5 already yields rank ties in rowid order; the outer ORDER BY re-sorts only the
  // page, so its seq tiebreak costs nothing.
  //
  // Any other predicate needs every match ranked before it filters, so those keep fromPage.
  const rankInsideFts = Boolean(fts) && where.length === 0 && sort === "relevance";

  // limit + 1 so has_more is exact without a second query. Sliced immediately by takePage, so
  // no caller can observe the extra row.
  const pageStmt = rankInsideFts
    ? {
        sql: `SELECT s.* FROM skills s JOIN (SELECT rowid AS seq, rank FROM skills_fts
                WHERE skills_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?) m ON m.seq = s.seq
              ORDER BY m.rank ASC, m.seq ASC`,
        args: [fts as string, params.limit + 1, params.offset],
      }
    : {
        sql: `SELECT s.* FROM ${fromPage} ${whereSql}
          ORDER BY ${orderSql}
          LIMIT ? OFFSET ?`,
        args: [...ftsArgs, ...whereArgs, params.limit + 1, params.offset],
      };

  // Derived from the predicate that was actually built, not by re-reading params. Testing
  // `params.tier || params.q || ...` drifts the first time someone adds a filter.
  const unfiltered = where.length === 0 && !fts;

  if (unfiltered) {
    try {
      const [pageRes, statRes] = await db.batch(
        [pageStmt, { sql: READ_STAT_SQL, args: ["skills_total"] }],
        "read"
      );
      if (statRes.rows.length) {
        const { page, has_more } = takePage(pageRes.rows, params.limit);
        return {
          skills: page.map(toSkillRow),
          total: Number(statRes.rows[0].value),
          total_relation: "eq",
          has_more,
        };
      }
      // Row absent — a fresh database whose stats have never been refreshed. Fall through to
      // the bounded count. Deliberately NOT count(*): that reintroduces the >90s timeout in
      // precisely the case this design exists to prevent, on the hottest path in the API.
    } catch {
      // registry_stats missing entirely — migration 002 not applied. Degrade to the bounded
      // count rather than 500 the listing.
    }
  }

  // One HTTP round trip, not two. Latency here is dominated by the Turso round trip (the query
  // itself is single-digit milliseconds), so issuing the page and the count separately would
  // double the cost of every search. batch() sends both in one request, which preserves the
  // property the original count(*) OVER () comment was written to defend.
  // With a text query and no other predicate, the count never needs the skills table at all —
  // counting FTS matches directly skips one rowid lookup per match (1,535ms -> 709ms measured
  // on `kubernetes`, 6,819 matches).
  const ftsOnlyCount = Boolean(fts) && where.length === 0;
  const countStmt = ftsOnlyCount
    ? {
        sql: boundedCountSql("skills_fts", "WHERE skills_fts MATCH ?"),
        args: [fts as string, countLimitArg()],
      }
    : {
        sql: boundedCountSql(fromCount, whereSql),
        args: [...ftsArgs, ...whereArgs, countLimitArg()],
      };

  const [pageRes, countRes] = await db.batch([pageStmt, countStmt], "read");

  const { page, has_more } = takePage(pageRes.rows, params.limit);
  return {
    skills: page.map(toSkillRow),
    ...interpretCount(Number(countRes.rows[0].n)),
    has_more,
  };
}

export async function getSkill(owner: string, name: string): Promise<SkillRow | null> {
  const db = getDb();
  const r = await db.execute({
    sql: "SELECT * FROM skills WHERE owner = ? AND name = ? LIMIT 1",
    args: [owner, name],
  });
  return r.rows.length ? toSkillRow(r.rows[0]) : null;
}

/**
 * Resolve a bare, unqualified name for CLI builds that predate the owner namespace.
 *
 * Names are only unique within an owner now, so this reports ambiguity rather than
 * picking a winner — silently resolving to whichever row came back first is how you
 * ship a skill nobody asked for.
 */
export async function getSkillByBareName(
  name: string
): Promise<{ skill: SkillRow | null; ambiguous: boolean; owners: string[] }> {
  const db = getDb();
  const r = await db.execute({
    sql: "SELECT * FROM skills WHERE name = ? LIMIT 11",
    args: [name],
  });

  const rows = r.rows.map(toSkillRow);
  if (rows.length === 0) return { skill: null, ambiguous: false, owners: [] };
  if (rows.length === 1) return { skill: rows[0], ambiguous: false, owners: [rows[0].owner] };
  return { skill: null, ambiguous: true, owners: rows.slice(0, 10).map((r) => r.owner) };
}

export async function incrementInstallCount(
  owner: string,
  name: string
): Promise<SkillRow | null> {
  const db = getDb();
  // Single statement, so two concurrent installs cannot both read the same count and write
  // back the same value — the read-then-write the Postgres version did could lose one.
  const r = await db.execute({
    sql: `UPDATE skills SET install_count = install_count + 1
          WHERE owner = ? AND name = ? RETURNING *`,
    args: [owner, name],
  });
  return r.rows.length ? toSkillRow(r.rows[0]) : null;
}

export async function createSkill(
  skill: Omit<SkillRow, "id" | "install_count" | "published_at" | "updated_at">
): Promise<SkillRow> {
  const db = getDb();
  const id = crypto.randomUUID();

  try {
    const r = await db.execute({
      sql: `INSERT INTO skills
              (id, name, display_name, owner, description, author, source_url,
               trust_tier, score, spec_version, tags, content_key, published_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            RETURNING *`,
      args: [
        id,
        skill.name,
        skill.display_name,
        skill.owner,
        skill.description,
        skill.author,
        skill.source_url,
        skill.trust_tier,
        skill.score,
        skill.spec_version,
        jsonOrNull(skill.tags),
        skill.content_key,
        skill.published_by,
      ],
    });
    return toSkillRow(r.rows[0]);
  } catch (err: any) {
    // Postgres raised 23505; SQLite says "UNIQUE constraint failed". Callers branch on
    // code === "CONFLICT", so the mapping has to happen here or a duplicate name 500s.
    if (/UNIQUE constraint failed/i.test(err?.message ?? "")) {
      throw Object.assign(new Error("Skill name already exists"), { code: "CONFLICT" });
    }
    throw err;
  }
}

export async function updateSkill(
  owner: string,
  name: string,
  updates: Partial<Pick<SkillRow, "description" | "score" | "spec_version" | "tags" | "source_url">>
): Promise<SkillRow | null> {
  const db = getDb();

  const sets: string[] = [];
  const args: InArgs = [];
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    args.push(k === "tags" ? jsonOrNull(v as string[] | null) : (v as any));
  }
  sets.push("updated_at = ?");
  args.push(new Date().toISOString());

  const r = await db.execute({
    sql: `UPDATE skills SET ${sets.join(", ")} WHERE owner = ? AND name = ? RETURNING *`,
    args: [...args, owner, name],
  });

  return r.rows.length ? toSkillRow(r.rows[0]) : null;
}

export async function deleteSkill(owner: string, name: string): Promise<boolean> {
  const db = getDb();
  const r = await db.execute({
    sql: "DELETE FROM skills WHERE owner = ? AND name = ?",
    args: [owner, name],
  });
  return r.rowsAffected > 0;
}
