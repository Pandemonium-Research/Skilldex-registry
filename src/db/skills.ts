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
 * Each token is stripped to word characters and wrapped as an FTS5 string literal, then
 * ANDed — matching websearch's default of "all terms must appear". Returns null when nothing
 * survives, and callers treat that as "no text filter" rather than "match nothing", so a
 * query of only punctuation lists results instead of returning an empty page.
 */
export function toFtsQuery(q: string): string | null {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ""))
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
  const fts = params.q ? toFtsQuery(params.q) : null;
  const ftsArgs: InArgs = fts ? [fts] : []; // bound first: FROM precedes every WHERE placeholder
  const fromPage = fts
    ? "skills s JOIN (SELECT rowid AS seq, bm25(skills_fts) AS rank" +
      " FROM skills_fts WHERE skills_fts MATCH ?) m ON m.seq = s.seq"
    : "skills s";
  const fromCount = fts
    ? "skills s JOIN (SELECT rowid AS seq" +
      " FROM skills_fts WHERE skills_fts MATCH ?) m ON m.seq = s.seq"
    : "skills s";

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
  }

  if (params.tier) {
    where.push("s.trust_tier = ?");
    whereArgs.push(params.tier);
  }

  if (params.min_score !== undefined) {
    where.push("s.score >= ?");
    whereArgs.push(params.min_score);
  }

  if (params.spec_version) {
    where.push("s.spec_version = ?");
    whereArgs.push(params.spec_version);
  }

  if (params.owner) {
    where.push("s.owner = ?");
    whereArgs.push(params.owner);
  }

  if (params.tags) {
    const tagList = params.tags.split(",").map((t) => t.trim()).filter(Boolean);
    if (tagList.length) {
      // Postgres used `tags && array[...]` over a GIN index. SQLite has no array type, so
      // this walks the JSON. It is a scan; see D8 for why the normalised table is deferred.
      where.push(
        `EXISTS (SELECT 1 FROM json_each(s.tags) WHERE value IN (${tagList
          .map(() => "?")
          .join(", ")}))`
      );
      whereArgs.push(...tagList);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderSql = SORT_MAP[resolveSort(params.sort, Boolean(fts))] ?? SORT_MAP.installs;

  // limit + 1 so has_more is exact without a second query. Sliced immediately by takePage, so
  // no caller can observe the extra row.
  const pageStmt = {
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
