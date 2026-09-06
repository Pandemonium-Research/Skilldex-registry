import { getDb } from "./client.js";
import { toSkillsetRow, jsonOrNull } from "./rows.js";
import { toFtsQuery, resolveSort } from "./skills.js";
import type { SkillsetRow } from "../types/skillset.js";
import type { SearchSkillsetsQuery } from "../types/skillset.js";
import type { InArgs } from "@libsql/client";

/** `seq` breaks ties so LIMIT/OFFSET paging is stable — see the note in skills.ts. */
const SORT_MAP: Record<string, string> = {
  relevance: "m.rank ASC, s.seq ASC",
  installs: "s.install_count DESC, s.seq ASC",
  score: "s.score DESC, s.seq ASC",
  recent: "s.published_at DESC, s.seq ASC",
  name: "s.name ASC, s.seq ASC",
};

export async function searchSkillsets(
  params: SearchSkillsetsQuery
): Promise<{ skillsets: SkillsetRow[]; total: number }> {
  const db = getDb();
  const where: string[] = [];
  const args: InArgs = [];

  let from = "skillsets s";
  const fts = params.q ? toFtsQuery(params.q) : null;
  if (fts) {
    // The rank is computed inside an FTS-only subquery. bm25() is an FTS5 auxiliary function
    // and is rejected ("unable to use function bm25 in the requested context") when the outer
    // query also carries a window function, so it cannot simply be joined and sorted on.
    // `m` is then an ordinary relation the outer query can filter, count and order freely.
    from =
      "skillsets s JOIN (SELECT rowid AS seq, bm25(skillsets_fts) AS rank" +
      " FROM skillsets_fts WHERE skillsets_fts MATCH ?) m ON m.seq = s.seq";
    args.push(fts); // bound first: it sits in FROM, ahead of every WHERE placeholder
  }

  if (params.tier) {
    where.push("s.trust_tier = ?");
    args.push(params.tier);
  }

  if (params.min_score !== undefined) {
    where.push("s.score >= ?");
    args.push(params.min_score);
  }

  if (params.spec_version) {
    where.push("s.spec_version = ?");
    args.push(params.spec_version);
  }

  if (params.tags) {
    const tagList = params.tags.split(",").map((t) => t.trim()).filter(Boolean);
    if (tagList.length) {
      where.push(
        `EXISTS (SELECT 1 FROM json_each(s.tags) WHERE value IN (${tagList
          .map(() => "?")
          .join(", ")}))`
      );
      args.push(...tagList);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderSql = SORT_MAP[resolveSort(params.sort, Boolean(fts))] ?? SORT_MAP.installs;

  const result = await db.execute({
    sql: `SELECT s.*, count(*) OVER () AS __total
          FROM ${from} ${whereSql}
          ORDER BY ${orderSql}
          LIMIT ? OFFSET ?`,
    args: [...args, params.limit, params.offset],
  });

  return {
    skillsets: result.rows.map(toSkillsetRow),
    total: result.rows.length ? Number(result.rows[0].__total) : 0,
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
  skillset: Omit<SkillsetRow, "id" | "skill_count" | "install_count" | "published_at" | "updated_at">
): Promise<SkillsetRow> {
  const db = getDb();
  const id = crypto.randomUUID();

  try {
    // skill_count is a generated column and must not be written.
    const r = await db.execute({
      sql: `INSERT INTO skillsets
              (id, name, description, author, source_url, trust_tier, score,
               spec_version, tags, skill_refs, published_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
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
  updates: Partial<Pick<SkillsetRow, "description" | "score" | "spec_version" | "tags" | "source_url" | "skill_refs">>
): Promise<SkillsetRow | null> {
  const db = getDb();

  const sets: string[] = [];
  const args: InArgs = [];
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    if (k === "tags") args.push(jsonOrNull(v as string[] | null));
    else if (k === "skill_refs") args.push(JSON.stringify(v));
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
