import { getDb } from "./client.js";
import { toSkillsetRow, jsonOrNull } from "./rows.js";
import { toFtsQuery, resolveSort } from "./skills.js";
import {
  boundedCountSql,
  countLimitArg,
  interpretCount,
  takePage,
  type TotalRelation,
} from "./pagination.js";
import { READ_STAT_SQL } from "./stats.js";
import type { SkillsetRow } from "../types/skillset.js";
import type { SearchSkillsetsQuery } from "../types/skillset.js";
import type { InArgs } from "@libsql/client";

/** `seq` breaks ties so LIMIT/OFFSET paging is stable — see the note in skills.ts. */
const SORT_MAP: Record<string, string> = {
  relevance: "m.rank ASC, m.seq ASC",
  installs: "s.install_count DESC, s.seq ASC",
  score: "s.score DESC, s.seq ASC",
  recent: "s.published_at DESC, s.seq ASC",
  name: "s.name ASC, s.seq ASC",
  // A skillset never checked for coherence has coherence_pct NULL, and SQLite sorts NULLs last
  // under DESC — so "most coherent first" puts unmeasured skillsets behind measured ones rather
  // than ahead of them, which is the honest order for a ranking built on the column.
  coherence: "s.coherence_pct DESC, s.seq ASC",
};

export interface SearchSkillsetsResult {
  skillsets: SkillsetRow[];
  total: number;
  total_relation: TotalRelation;
  has_more: boolean;
}

/**
 * Mirrors searchSkills. There is no `scope` here: skillsets have no imported corpus, so the
 * whole table is curated and there is nothing to narrow to.
 *
 * The count(*) OVER () this replaces was never measured — the skillsets table is small enough
 * that it was never a problem. Changing it is defensive, keeping the two endpoints on one
 * contract, rather than corrective.
 */
export async function searchSkillsets(
  params: SearchSkillsetsQuery
): Promise<SearchSkillsetsResult> {
  const db = getDb();
  const where: string[] = [];
  const whereArgs: InArgs = [];

  // Two FROM clauses: the page needs bm25, the count does not. See db/skills.ts.
  const fts = params.q ? toFtsQuery(params.q) : null;
  const ftsArgs: InArgs = fts ? [fts] : []; // bound first: FROM precedes every WHERE placeholder
  const fromPage = fts
    ? "skillsets s JOIN (SELECT rowid AS seq, bm25(skillsets_fts) AS rank" +
      " FROM skillsets_fts WHERE skillsets_fts MATCH ?) m ON m.seq = s.seq"
    : "skillsets s";
  const fromCount = fts
    ? "skillsets s JOIN (SELECT rowid AS seq" +
      " FROM skillsets_fts WHERE skillsets_fts MATCH ?) m ON m.seq = s.seq"
    : "skillsets s";

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

  // Unmeasured skillsets are excluded by the NULL comparison rather than treated as 0 — asking
  // for "at least 50% coherent" should not return things nobody has checked.
  if (params.min_coherence !== undefined) {
    where.push("s.coherence_pct >= ?");
    whereArgs.push(params.min_coherence);
  }

  if (params.tags) {
    const tagList = params.tags.split(",").map((t) => t.trim()).filter(Boolean);
    if (tagList.length) {
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

  const pageStmt = {
    sql: `SELECT s.* FROM ${fromPage} ${whereSql}
          ORDER BY ${orderSql}
          LIMIT ? OFFSET ?`,
    args: [...ftsArgs, ...whereArgs, params.limit + 1, params.offset],
  };

  const unfiltered = where.length === 0 && !fts;

  if (unfiltered) {
    try {
      const [pageRes, statRes] = await db.batch(
        [pageStmt, { sql: READ_STAT_SQL, args: ["skillsets_total"] }],
        "read"
      );
      if (statRes.rows.length) {
        const { page, has_more } = takePage(pageRes.rows, params.limit);
        return {
          skillsets: page.map(toSkillsetRow),
          total: Number(statRes.rows[0].value),
          total_relation: "eq",
          has_more,
        };
      }
    } catch {
      // registry_stats absent or unpopulated — degrade to the bounded count, never count(*).
    }
  }

  const [pageRes, countRes] = await db.batch(
    [
      pageStmt,
      {
        sql: boundedCountSql(fromCount, whereSql),
        args: [...ftsArgs, ...whereArgs, countLimitArg()],
      },
    ],
    "read"
  );

  const { page, has_more } = takePage(pageRes.rows, params.limit);
  return {
    skillsets: page.map(toSkillsetRow),
    ...interpretCount(Number(countRes.rows[0].n)),
    has_more,
  };
}

export async function getSkillsetByName(name: string): Promise<SkillsetRow | null> {
  const db = getDb();
  const r = await db.execute({
    sql: "SELECT * FROM skillsets WHERE name = ? LIMIT 1",
    args: [name],
  });
  return r.rows.length ? toSkillsetRow(r.rows[0]) : null;
}

export async function incrementSkillsetInstallCount(name: string): Promise<SkillsetRow | null> {
  const db = getDb();
  const r = await db.execute({
    sql: "UPDATE skillsets SET install_count = install_count + 1 WHERE name = ? RETURNING *",
    args: [name],
  });
  return r.rows.length ? toSkillsetRow(r.rows[0]) : null;
}

export async function createSkillset(
  skillset: Omit<
    SkillsetRow,
    "id" | "skill_count" | "install_count" | "published_at" | "updated_at" | "coherence_pct"
  >
): Promise<SkillsetRow> {
  const db = getDb();
  const id = crypto.randomUUID();

  try {
    // skill_count and coherence_pct are generated columns and must not be written.
    const r = await db.execute({
      sql: `INSERT INTO skillsets
              (id, name, description, author, source_url, trust_tier, score,
               spec_version, tags, skill_refs, published_by,
               members_checked, members_coherent, coherence)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            RETURNING *`,
      args: [
        id,
        skillset.name,
        skillset.description,
        skillset.author,
        skillset.source_url,
        skillset.trust_tier,
        skillset.score,
        skillset.spec_version,
        jsonOrNull(skillset.tags),
        JSON.stringify(skillset.skill_refs ?? []),
        skillset.published_by,
        skillset.members_checked,
        skillset.members_coherent,
        skillset.coherence === null ? null : JSON.stringify(skillset.coherence),
      ],
    });
    return toSkillsetRow(r.rows[0]);
  } catch (err: any) {
    if (/UNIQUE constraint failed/i.test(err?.message ?? "")) {
      throw Object.assign(new Error("Skillset name already exists"), { code: "CONFLICT" });
    }
    throw err;
  }
}

export async function updateSkillset(
  name: string,
  updates: Partial<
    Pick<
      SkillsetRow,
      | "description"
      | "score"
      | "spec_version"
      | "tags"
      | "source_url"
      | "skill_refs"
      | "members_checked"
      | "members_coherent"
      | "coherence"
    >
  >
): Promise<SkillsetRow | null> {
  const db = getDb();

  const sets: string[] = [];
  const args: InArgs = [];
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    if (k === "tags") args.push(jsonOrNull(v as string[] | null));
    else if (k === "skill_refs") args.push(JSON.stringify(v));
    // An object column, so it needs serialising like the two above — but null must stay null
    // rather than becoming the string "null", which json_valid() would happily accept.
    else if (k === "coherence") args.push(v === null ? null : JSON.stringify(v));
    else args.push(v as any);
  }
  sets.push("updated_at = ?");
  args.push(new Date().toISOString());

  const r = await db.execute({
    sql: `UPDATE skillsets SET ${sets.join(", ")} WHERE name = ? RETURNING *`,
    args: [...args, name],
  });

  return r.rows.length ? toSkillsetRow(r.rows[0]) : null;
}

export async function deleteSkillset(name: string): Promise<boolean> {
  const db = getDb();
  const r = await db.execute({ sql: "DELETE FROM skillsets WHERE name = ?", args: [name] });
  return r.rowsAffected > 0;
}
