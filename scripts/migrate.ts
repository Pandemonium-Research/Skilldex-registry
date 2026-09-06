/**
 * Apply pending schema migrations.
 *
 * Until now there was no migration infrastructure: 001 was applied once, by hand, to create the
 * live database. 002 is the first real migration, which makes this the cheapest it will ever be
 * to build — one table, no data movement.
 *
 * Usage:
 *   npm run migrate              # against TURSO_DATABASE_URL
 *   npm run migrate -- --dry-run # print what would run, touch nothing
 *   tsx scripts/migrate.ts --url file:build/registry.db
 *
 * Migrations are recorded in `schema_migrations` and never re-run. 001 is marked as applied
 * without executing when the `skills` table already exists — the live database was created from
 * it before this runner existed, and replaying it would fail on the first CREATE TABLE.
 */
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { schemaFiles, splitSql } from "./lib/schema.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
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

await db.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY, applied_at TEXT NOT NULL
) WITHOUT ROWID`);

const appliedRows = await db.execute("SELECT version FROM schema_migrations");
const applied = new Set(appliedRows.rows.map((r) => String(r.version)));

// The live database predates this runner, so 001 is already in effect but unrecorded.
// Detect that by its result rather than by trusting a flag.
if (!applied.has("001")) {
  const existing = await db.execute(
    "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='skills'"
  );
  if (Number(existing.rows[0].n) > 0) {
    console.log("001  already in effect (skills exists) — recording without executing");
    if (!dryRun) {
      await db.execute({
        sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        args: ["001", new Date().toISOString()],
      });
    }
    applied.add("001");
  }
}

let ran = 0;
for (const { version, path } of schemaFiles()) {
  if (applied.has(version)) {
    console.log(`${version}  already applied`);
    continue;
  }

  const statements = splitSql(readFileSync(path, "utf-8"));
  console.log(`${version}  applying ${statements.length} statement(s)${dryRun ? " [dry run]" : ""}`);

  if (dryRun) {
    for (const s of statements) console.log(`      ${s.split("\n")[0].slice(0, 90)}…`);
    continue;
  }

  // Deliberately not wrapped in a transaction. libSQL over HTTP does not give us a durable
  // interactive transaction, and SQLite DDL is individually atomic anyway. A migration that
  // fails halfway leaves the applied statements in place and is NOT recorded, so re-running
  // re-attempts the whole file — which is why every statement here should be idempotent-safe
  // or the failure investigated by hand.
  for (const s of statements) {
    try {
      await db.execute(s);
    } catch (err: any) {
      console.error(`\n${version} FAILED on:\n${s}\n\n${err?.message ?? err}`);
      process.exit(1);
    }
  }

  await db.execute({
    sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    args: [version, new Date().toISOString()],
  });
  ran++;
}

console.log(ran === 0 ? "\nnothing to do — schema is current" : `\napplied ${ran} migration(s)`);
