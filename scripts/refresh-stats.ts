/**
 * Recompute the precomputed counts.
 *
 * `scripts/seed.ts` does this at the end of every nightly run, and the corpus scripts do it
 * after building. This exists for the cases in between: right after a migration, after a
 * manual edit, or any time the headline numbers need to be correct before the next seed.
 *
 * Safe to run at any time — it only reads `skills`/`skillsets` and rewrites two small tables.
 * At corpus scale the COUNT(DISTINCT owner) is a full index scan and takes a while; that is
 * exactly why it is precomputed rather than served from a request.
 *
 *   npm run refresh-stats
 *   tsx scripts/refresh-stats.ts --url file:build/registry.db
 */
import { createClient } from "@libsql/client";
import { refreshStats, refreshTagCounts } from "../src/db/stats.js";

const args = process.argv.slice(2);
const urlFlag = args.indexOf("--url");
const url = urlFlag >= 0 ? args[urlFlag + 1] : process.env.TURSO_DATABASE_URL;

if (!url) {
  console.error("no database: pass --url or set TURSO_DATABASE_URL");
  process.exit(1);
}

const db = createClient({
  url,
  authToken: url.startsWith("file:") ? undefined : process.env.TURSO_AUTH_TOKEN,
});

const started = Date.now();
const stats = await refreshStats(db);
const tags = await refreshTagCounts(db);

console.log(`skills      ${stats.skills_total.toLocaleString()}`);
console.log(`  curated   ${stats.skills_curated.toLocaleString()}`);
console.log(`  imported  ${stats.skills_imported.toLocaleString()}`);
console.log(`  verified  ${stats.skills_verified.toLocaleString()}`);
console.log(`skillsets   ${stats.skillsets_total.toLocaleString()}`);
console.log(`owners      ${stats.owners_total.toLocaleString()}`);
console.log(`tags        ${tags.toLocaleString()} distinct`);
console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
