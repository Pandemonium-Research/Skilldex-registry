import { getDb } from "./client.js";
import { toSkillRow, jsonOrNull } from "./rows.js";
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
  installs: "s.install_count DESC, s.seq ASC",
  score: "s.score DESC, s.seq ASC",
  recent: "s.published_at DESC, s.seq ASC",
  name: "s.name ASC, s.seq ASC",
};

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

export async function searchSkills(
  params: SearchSkillsQuery
): Promise<{ skills: SkillRow[]; total: number }> {
  const db = getDb();
  const where: string[] = [];
  const args: InArgs = [];

  // Full-text search over name + description.
  let from = "skills s";
  const fts = params.q ? toFtsQuery(params.q) : null;
  if (fts) {
    from = "skills s JOIN skills_fts f ON f.rowid = s.seq";
    where.push("skills_fts MATCH ?");
    args.push(fts);
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
      // Postgres used `tags && array[...]` over a GIN index. SQLite has no array type, so
      // this walks the JSON. It is a scan; see D8 for why the normalised table is deferred.
      where.push(
        `EXISTS (SELECT 1 FROM json_each(s.tags) WHERE value IN (${tagList
          .map(() => "?")
          .join(", ")}))`
      );
      args.push(...tagList);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderSql = SORT_MAP[params.sort] ?? SORT_MAP.installs;

  // count(*) OVER () returns the unpaginated total alongside the page, so the whole search
  // is one round trip rather than a query plus a count.
  const result = await db.execute({
    sql: `SELECT s.*, count(*) OVER () AS __total
          FROM ${from} ${whereSql}
          ORDER BY ${orderSql}
          LIMIT ? OFFSET ?`,
    args: [...args, params.limit, params.offset],
  });

  return {
    skills: result.rows.map(toSkillRow),
    total: result.rows.length ? Number(result.rows[0].__total) : 0,
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
