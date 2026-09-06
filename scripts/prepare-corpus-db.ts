/**
 * Bring an already-built corpus database up to the current schema.
 *
 *   npx tsx scripts/prepare-corpus-db.ts --url libsql://… --token …
 *   npx tsx scripts/prepare-corpus-db.ts --url file:build/registry.db
 *
 * `skilldex-registry-v2` was built before migrations 002 and 003 existed, so it has none of
 * `skills.source`, `registry_stats`, `tag_counts` or `delistings`. A rebuild would fix that —
 * build.ts now applies every migration — but that is ~48 minutes and needs the dataset mounted.
 * This patches the existing artifact instead.
 *
 * ⚠ It is NOT `npm run migrate`. Migration 002 defaults `source` to 'seeded', which is right for
 * the live registry where every row came from the seeder. On a corpus database that would mark
 * all 1.6M rows seeded and then need an UPDATE over the corpus to correct it — 1.6M firings of
 * `skills_au`, each rewriting two FTS5 tables.
 *
 * So the default is flipped and only the small side is updated: 'imported' for everything, then
 * 'seeded' for the ~4,863 rows merge-live.ts brought over from the live registry, which are
 * exactly the rows with a null content_key. Same end state, ~4.8k trigger firings instead of
 * 1.6M.
 *
 * Idempotent: every step checks first, so a re-run after a failure is safe.
 */
import { createClient } from "@libsql/client";
import { refreshStats, refreshTagCounts } from "../src/db/stats.js";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};

const url = flag("url");
if (!url) {
  console.error("required: --url <libsql://… | file:…>   [--token <auth token>]");
  process.exit(1);
}

const db = createClient({
  url,
  authToken: url.startsWith("file:") ? undefined : flag("token") ?? process.env.TURSO_AUTH_TOKEN,
});

const has = async (sql: string, args: any[] = []) =>
  Number((await db.execute({ sql, args })).rows[0].n) > 0;

const hasColumn = (t: string, c: string) =>
  has(`SELECT count(*) AS n FROM pragma_table_info('${t}') WHERE name = ?`, [c]);
const hasTable = (t: string) =>
  has("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name = ?", [t]);

console.log(`preparing ${url.replace(/\/\/[^@]*@/, "//")}\n`);

// --- source column ----------------------------------------------------------
if (await hasColumn("skills", "source")) {
  console.log("source        already present");
} else {
  console.log("source        adding (DEFAULT 'imported' — flipped, see the header)");
  await db.execute(
    `ALTER TABLE skills ADD COLUMN source TEXT NOT NULL DEFAULT 'imported'
       CHECK (source IN ('seeded', 'imported', 'published'))`
  );
  // Only the rows merge-live.ts carried over from the live registry. content_key is null for
  // exactly those: the corpus always sets it to the file sha.
  const r = await db.execute(
    "UPDATE skills SET source = 'seeded' WHERE content_key IS NULL"
  );
  console.log(`              relabelled ${r.rowsAffected.toLocaleString()} seeded row(s)`);
}

// --- partial indexes --------------------------------------------------------
for (const [name, ddl] of [
  [
    "skills_curated_installs_idx",
    "CREATE INDEX IF NOT EXISTS skills_curated_installs_idx ON skills (install_count DESC) WHERE source <> 'imported'",
  ],
  [
    "skills_curated_recent_idx",
    "CREATE INDEX IF NOT EXISTS skills_curated_recent_idx ON skills (published_at DESC) WHERE source <> 'imported'",
  ],
] as const) {
  await db.execute(ddl);
  console.log(`${name.padEnd(13)} ok`);
}

// --- tables from 002 and 003 ------------------------------------------------
for (const [name, ddl] of [
  [
    "registry_stats",
    `CREATE TABLE IF NOT EXISTS registry_stats (
       key TEXT PRIMARY KEY, value INTEGER NOT NULL, updated_at TEXT NOT NULL
     ) WITHOUT ROWID`,
  ],
  [
    "tag_counts",
    `CREATE TABLE IF NOT EXISTS tag_counts (
       tag TEXT PRIMARY KEY, skill_count INTEGER NOT NULL, updated_at TEXT NOT NULL
     ) WITHOUT ROWID`,
  ],
  [
    "delistings",
    `CREATE TABLE IF NOT EXISTS delistings (
       scope TEXT NOT NULL CHECK (scope IN ('owner', 'repo', 'skill')),
       value TEXT NOT NULL,
       reason TEXT,
       requested_by TEXT,
       created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
       removed INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (scope, value)
     ) WITHOUT ROWID`,
  ],
] as const) {
  const existed = await hasTable(name);
  await db.execute(ddl);
  console.log(`${name.padEnd(13)} ${existed ? "already present" : "created"}`);
}

// --- record the migrations so `npm run migrate` does not replay them ---------
await db.execute(
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     version TEXT PRIMARY KEY, applied_at TEXT NOT NULL
   ) WITHOUT ROWID`
);
const now = new Date().toISOString();
for (const v of ["001", "002", "003"]) {
  await db.execute({
    sql: "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    args: [v, now],
  });
}
console.log("migrations    001, 002, 003 recorded as applied");

// --- counts -----------------------------------------------------------------
console.log("\nrefreshing stats (COUNT(DISTINCT owner) over the corpus — this takes a while)…");
const t = Date.now();
const stats = await refreshStats(db);
const tags = await refreshTagCounts(db);

console.log(`\nskills      ${stats.skills_total.toLocaleString()}`);
console.log(`  seeded    ${stats.skills_curated.toLocaleString()}`);
console.log(`  imported  ${stats.skills_imported.toLocaleString()}`);
console.log(`  verified  ${stats.skills_verified.toLocaleString()}`);
console.log(`skillsets   ${stats.skillsets_total.toLocaleString()}`);
console.log(`owners      ${stats.owners_total.toLocaleString()}`);
console.log(`tags        ${tags.toLocaleString()} distinct`);
console.log(`\ndone in ${((Date.now() - t) / 1000).toFixed(0)}s`);
