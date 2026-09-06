/**
 * Run the D13 naming pass over the corpus and check its invariants — without writing anything.
 *
 *   npx tsx scripts/corpus/check-naming.ts [--data <dir>]
 *
 * Naming decides URLs, so it is verified on its own before a build consumes it. The three
 * things that must hold: (owner, final_slug) is unique, no slug exceeds 100 characters, and
 * the contested counts match the independent measurement in REGISTRY_MIGRATION_FINDINGS §2.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dataDir =
  args[args.indexOf("--data") + 1] && args.includes("--data")
    ? args[args.indexOf("--data") + 1]
    : "/Volumes/Extreme SSD/gitskills/data";

const here = dirname(fileURLToPath(import.meta.url));
const inst = await DuckDBInstance.create(":memory:");
const con = await inst.connect();
// `part-*` not `*`: macOS writes AppleDouble sidecars (._part-00000.parquet) onto exFAT
// volumes, and DuckDB fails on them with "No magic bytes found at end of file".
await con.run(`SET variable artifact_glob = '${dataDir}/artifacts/part-*.parquet'`);

const t0 = Date.now();
for (const stmt of readFileSync(join(here, "naming.sql"), "utf-8").split(/;\s*\n(?=CREATE)/)) {
  if (stmt.trim()) await con.run(stmt);
}
console.log(`naming pass over ${dataDir}: ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

const q = async (sql: string) => (await con.runAndReadAll(sql)).getRowObjects();
const show = async (label: string, sql: string) => {
  console.log(label);
  console.table(await q(sql));
};

await show("rows and groups", `SELECT (SELECT count(*) FROM gated) AS gated_rows,
                                      (SELECT count(*) FROM groups) AS groups,
                                      (SELECT count(*) FROM naming) AS named`);
await show("D13 case distribution",
  `SELECT naming_case, count(*) AS rows FROM naming GROUP BY 1 ORDER BY 2 DESC`);
await show("contested (FINDINGS §2 expects 81,238 groups / 204,923 rows / max 115)",
  `SELECT count(*) AS contested_groups, sum(contents) AS rows_involved, max(contents) AS largest
   FROM groups WHERE contents > 1`);
await show("INVARIANT: (owner, final_slug) unique — must be 0",
  `SELECT count(*) AS colliding_pairs FROM (
     SELECT owner, final_slug FROM naming GROUP BY 1,2 HAVING count(*) > 1)`);
await show("INVARIANT: slug <= 100 chars — must be 0",
  `SELECT count(*) AS over_100 FROM naming WHERE length(final_slug) > 100`);
await show("INVARIANT: slug matches createSkillSchema's kebab rule — must be 0",
  `SELECT count(*) AS malformed FROM naming
   WHERE NOT regexp_matches(final_slug, '^[a-z0-9]+(-[a-z0-9]+)*$')`);
await show("sample of each contested case",
  `SELECT naming_case, owner, base_slug, final_slug FROM naming
   WHERE naming_case <> 'uncontested' ORDER BY base_slug LIMIT 8`);
