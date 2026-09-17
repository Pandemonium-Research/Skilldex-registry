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

/** How long a stored `owners_total` is trusted before refreshStats recounts it (D29). */
export const OWNERS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface RefreshStatsOptions {
  /**
   * Recount owners only when the stored figure is older than this. `0` always recounts — for
   * scripts building a local database file, where the scan costs nothing and counts have moved.
   */
  ownersMaxAgeMs?: number;
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
 * Two of the six figures are no longer scans (D29):
 *
 * - `skills_imported` is `skills_total - skills_curated`. `source` is CHECK-constrained to
 *   seeded/imported/published, so the difference is exact, and counting it directly read every
 *   imported row — 1,615,322 rows per refresh.
 * - `owners_total` is `count(DISTINCT owner)`, a full walk of the (owner, name) index. It is
 *   recounted only when the stored value is older than OWNERS_MAX_AGE_MS: owners arrive slowly,
 *   and a nightly recount was ~48M rows read a month for a headline figure.
 *
 * Together that took a refresh from 3,239,480 rows read to 8,836. A skipped owners count keeps its
 * old `updated_at`, so /v1/stats — which reports the stalest key — says honestly that the figure
 * may be up to a week old.
 *
 * ⚠ Not a trigger. 001's bulk-import path loads rows with the FTS triggers dropped precisely
 * because 1.6M trigger firings dominate; adding a stats trigger would reintroduce that cost on
 * every write.
 */
export async function refreshStats(
  client?: Client,
  options: RefreshStatsOptions = {}
): Promise<Record<string, number>> {
  const db = client ?? getDb();
  const maxAge = options.ownersMaxAgeMs ?? OWNERS_MAX_AGE_MS;

  const [total, curated, verified, skillsets, storedOwners] = await db.batch(
    [
      "SELECT count(*) AS n FROM skills",
      "SELECT count(*) AS n FROM skills WHERE source <> 'imported'",
      "SELECT count(*) AS n FROM skills WHERE trust_tier = 'verified'",
      "SELECT count(*) AS n FROM skillsets",
      "SELECT value, updated_at FROM registry_stats WHERE key = 'owners_total'",
    ],
    "read"
  );

  const n = (r: { rows: any[] }) => Number(r.rows[0].n);
  const now = new Date();
  const stored = storedOwners.rows[0];
  const ownersFresh =
    maxAge > 0 &&
    stored !== undefined &&
    now.getTime() - Date.parse(String(stored.updated_at)) < maxAge;

  // Full index walk over the leading column of sqlite_autoindex_skills_2 when it runs — minutes at
  // corpus scale, which is why it is both precomputed and rationed.
  const owners = ownersFresh
    ? Number(stored.value)
    : n(await db.execute("SELECT count(DISTINCT owner) AS n FROM skills"));

  const computed: Record<StatKey, number> = {
    skills_total: n(total),
    skills_curated: n(curated),
    skills_imported: n(total) - n(curated),
    skills_verified: n(verified),
    skillsets_total: n(skillsets),
    owners_total: owners,
  };

  const stamp = now.toISOString();
  await db.batch(
    STAT_KEYS.filter((key) => !(ownersFresh && key === "owners_total")).map((key) => ({
      sql: "INSERT OR REPLACE INTO registry_stats (key, value, updated_at) VALUES (?, ?, ?)",
      args: [key, computed[key], stamp],
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
