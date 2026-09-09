import type { Client } from "@libsql/client";
import { getDb } from "./client.js";

/**
 * Precomputed aggregate counts.
 *
 * Every number here is one that must never be computed on a request path. `count(*)` over the
 * 1.6M-row corpus took >90s and timed the listing endpoint out entirely; COUNT(DISTINCT owner)
 * is worse still, because 001 deliberately cut `skills_owner_idx` to stay under Turso's 2 GB
 * `--from-file` ceiling. All of them are fine in a nightly batch.
 *
 * Staleness is bounded by the seeder cadence, which is the right trade for a headline figure —
 * and `updated_at` is surfaced by /v1/stats so the staleness is observable rather than silent.
 */

export const STAT_KEYS = [
  "skills_total",
  "skills_curated",
  "skills_imported",
  "skills_verified",
  "skillsets_total",
  "owners_total",
] as const;

export type StatKey = (typeof STAT_KEYS)[number];

/** Single-key lookup, exported so searchSkills can batch it alongside the page query. */
export const READ_STAT_SQL = "SELECT value FROM registry_stats WHERE key = ?";

export interface RegistryStats {
  values: Partial<Record<StatKey, number>>;
  updated_at: string | null;
}

/**
 * Read every stat, reporting the age of the *stalest* one.
 *
 * `updated_at` exists so callers can judge how much to trust these numbers, which makes the oldest
 * timestamp the only honest answer: a reader wants "nothing here is older than this".
 *
 * It used to take the newest, which was equivalent while refreshStats() was the only writer and
 * stamped every key together. refreshSkillsetCount() breaks that — it freshens one key on each
 * publish — and under the newest rule a single publish would drag `updated_at` to now and present
 * skills counts from the last nightly run as though they had just been recomputed. That is exactly
 * backwards for a field whose stated purpose is making staleness observable.
 */
export async function readStats(client?: Client): Promise<RegistryStats> {
  const db = client ?? getDb();
  const r = await db.execute("SELECT key, value, updated_at FROM registry_stats");

  const values: Partial<Record<StatKey, number>> = {};
  let updated_at: string | null = null;

  for (const row of r.rows) {
    values[String(row.key) as StatKey] = Number(row.value);
    const at = row.updated_at === null ? null : String(row.updated_at);
    if (at && (!updated_at || at < updated_at)) updated_at = at;
  }

  return { values, updated_at };
}

/**
 * Recompute every stat and write it.
 *
 * Called from scripts/seed.ts (after each nightly run), scripts/corpus/build.ts, and
 * scripts/corpus/merge-live.ts. That last one is load-bearing: the merge changes the row count
 * after the build has already written it.
 *
 * Deliberately one shared function rather than three call sites computing their own numbers —
 * if they disagree, the headline count flickers between runs.
 *
 * ⚠ Not a trigger. 001's bulk-import path loads rows with the FTS triggers dropped precisely
 * because 1.6M trigger firings dominate; adding a stats trigger would reintroduce that cost on
 * every write.
 */
export async function refreshStats(client?: Client): Promise<Record<string, number>> {
  const db = client ?? getDb();

  const [total, curated, imported, verified, skillsets, owners] = await db.batch(
    [
      "SELECT count(*) AS n FROM skills",
      "SELECT count(*) AS n FROM skills WHERE source <> 'imported'",
      "SELECT count(*) AS n FROM skills WHERE source = 'imported'",
      "SELECT count(*) AS n FROM skills WHERE trust_tier = 'verified'",
      "SELECT count(*) AS n FROM skillsets",
      // Full index scan over the leading column of sqlite_autoindex_skills_2. Minutes at
      // corpus scale — which is the entire reason this is precomputed.
      "SELECT count(DISTINCT owner) AS n FROM skills",
    ],
    "read"
  );

  const n = (r: { rows: any[] }) => Number(r.rows[0].n);
  const computed: Record<StatKey, number> = {
    skills_total: n(total),
    skills_curated: n(curated),
    skills_imported: n(imported),
    skills_verified: n(verified),
    skillsets_total: n(skillsets),
    owners_total: n(owners),
  };

  const now = new Date().toISOString();
  await db.batch(
    STAT_KEYS.map((key) => ({
      sql: "INSERT OR REPLACE INTO registry_stats (key, value, updated_at) VALUES (?, ?, ?)",
      args: [key, computed[key], now],
    })),
    "write"
  );

  return computed;
}

/**
 * Recount just `skillsets_total` and write it.
 *
 * `skillsets_total` is not only a headline figure: searchSkillsets uses it as the pagination
 * `total` for any unfiltered listing, and labels that `total_relation: "eq"`. A stale value is
 * therefore an exact-looking lie — with the nightly seeder paused, publishing the three official
 * skillsets left the endpoint returning three rows above a total of 0.
 *
 * A recount rather than an increment, for two reasons. It is idempotent, so a missed call site, a
 * failed write, or a row deleted straight from the database heals on the next publish, where an
 * increment would drift permanently. And it is affordable: the >90s `count(*)` that made all of
 * this precomputed is a property of the 1.6M-row `skills` table, not of `skillsets`, which is
 * small by construction — a skillset is hand-authored and published one at a time, not imported
 * in bulk.
 *
 * Only this one key is touched. refreshStats() recomputes everything including
 * `count(DISTINCT owner)`, which is minutes at corpus scale and has no business on a request path.
 */
export async function refreshSkillsetCount(client?: Client): Promise<number> {
  const db = client ?? getDb();
  const r = await db.execute("SELECT count(*) AS n FROM skillsets");
  const n = Number(r.rows[0].n);

  await db.execute({
    sql: "INSERT OR REPLACE INTO registry_stats (key, value, updated_at) VALUES (?, ?, ?)",
    args: ["skillsets_total", n, new Date().toISOString()],
  });

  return n;
}

/**
 * Refresh tag facet counts from the curated tier only.
 *
 * Every tagged row in the merged corpus is curated (2,106 of them, all with `source <>
 * 'imported'`), so restricting the aggregate loses nothing and avoids a `json_each` walk over
 * 1.6M rows — which is a full scan by construction while tags remain a JSON column (D8).
 */
export async function refreshTagCounts(client?: Client): Promise<number> {
  const db = client ?? getDb();
  const now = new Date().toISOString();

  const r = await db.execute(`
    SELECT value AS tag, count(*) AS n
    FROM skills s, json_each(s.tags)
    WHERE s.source <> 'imported' AND s.tags IS NOT NULL
    GROUP BY value
  `);

  await db.execute("DELETE FROM tag_counts");
  if (r.rows.length) {
    await db.batch(
      r.rows.map((row) => ({
        sql: "INSERT OR REPLACE INTO tag_counts (tag, skill_count, updated_at) VALUES (?, ?, ?)",
        args: [String(row.tag), Number(row.n), now],
      })),
      "write"
    );
  }

  return r.rows.length;
}

export async function readTagCounts(
  client?: Client
): Promise<{ tag: string; skill_count: number }[]> {
  const db = client ?? getDb();
  const r = await db.execute(
    "SELECT tag, skill_count FROM tag_counts ORDER BY skill_count DESC, tag ASC"
  );
  return r.rows.map((row) => ({ tag: String(row.tag), skill_count: Number(row.skill_count) }));
}
