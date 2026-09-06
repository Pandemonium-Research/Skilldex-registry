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

export async function readStats(client?: Client): Promise<RegistryStats> {
  const db = client ?? getDb();
  const r = await db.execute("SELECT key, value, updated_at FROM registry_stats");

  const values: Partial<Record<StatKey, number>> = {};
  let updated_at: string | null = null;

  for (const row of r.rows) {
    values[String(row.key) as StatKey] = Number(row.value);
    const at = row.updated_at === null ? null : String(row.updated_at);
    if (at && (!updated_at || at > updated_at)) updated_at = at;
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
