import { Hono } from "hono";
import { readStats, readTagCounts } from "../db/stats.js";
import { CACHE_STATS } from "../middleware/cache.js";

export const statsRoutes = new Hono();

/**
 * GET /v1/stats — headline counts for the registry.
 *
 * Every value is a primary-key lookup against `registry_stats`, so this is O(1) regardless of
 * corpus size. It is hit on essentially every page load of the site, which is why there is no
 * count(*) fallback anywhere in this path: a misconfiguration would otherwise turn into a
 * site-wide 90s hang rather than a visibly-zero headline.
 *
 * `updated_at` is surfaced so staleness is observable — the numbers are refreshed by the
 * nightly seeder, so they lag by at most one cycle.
 */
statsRoutes.get("/", async (c) => {
  let stats;
  try {
    stats = await readStats();
  } catch {
    // registry_stats missing — migration 002 has not been applied to this database.
    stats = { values: {}, updated_at: null };
  }

  const v = stats.values;
  c.header("Cache-Control", CACHE_STATS);
  return c.json({
    skills: {
      total: v.skills_total ?? 0,
      curated: v.skills_curated ?? 0,
      imported: v.skills_imported ?? 0,
      verified: v.skills_verified ?? 0,
    },
    skillsets: { total: v.skillsets_total ?? 0 },
    owners: v.owners_total ?? 0,
    updated_at: stats.updated_at,
  });
});

/**
 * GET /v1/tags — distinct tags with skill counts, for the browse-by-tag surface.
 *
 * A straight read of `tag_counts`. Computing this live means `json_each` over every row, which
 * is a full scan while tags remain a JSON column (D8).
 */
export const tagsRoutes = new Hono();

tagsRoutes.get("/", async (c) => {
  try {
    const tags = await readTagCounts();
    c.header("Cache-Control", CACHE_STATS);
    return c.json({ tags });
  } catch {
    return c.json({ tags: [] });
  }
});
