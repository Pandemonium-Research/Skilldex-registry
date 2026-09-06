/**
 * Build the imported registry as a local SQLite file, ready for `turso db create --from-file`.
 *
 *   npx tsx scripts/corpus/build.ts [--shards N] [--out PATH] [--data DIR]
 *
 * Two passes, because naming is global and scoring is per row:
 *
 *   1. naming.sql over every shard decides the final slug for all 1.6M skills (D13). It must
 *      see the whole corpus — shards are not partitioned by owner, so a subset would call a
 *      contested name uncontested.
 *   2. Each shard is then scored with validateSkill and written out.
 *
 * `--shards N` limits pass 2 only; pass 1 always reads everything, so names never depend on
 * how much of the corpus a particular run happened to write.
 *
 * The output is a fresh file, never the live database: `--from-file` creates a database rather
 * than merging into one, so the cutover is blue/green (D-notes in the migration backlog).
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { createClient } from "@libsql/client";
import { readFileSync, mkdirSync, existsSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { validateSkill } from "../../src/validator/index.js";
import { allSchemaStatements } from "../lib/schema.js";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DATA = flag("data", "/Volumes/Extreme SSD/gitskills/data");
const OUT = flag("out", "build/registry.db");
const SHARD_LIMIT = Number(flag("shards", "0")) || Infinity;
const here = dirname(fileURLToPath(import.meta.url));
const BATCH = 1000;

mkdirSync(dirname(OUT), { recursive: true });
for (const f of [OUT, `${OUT}-journal`, `${OUT}-wal`, `${OUT}-shm`]) if (existsSync(f)) rmSync(f);

// --- output database -------------------------------------------------------
// Schema WITHOUT the FTS triggers: they are created after the bulk load, and the index is
// built once with 'rebuild'. Firing three triggers per row across 1.6M rows would dominate.
// Every migration, not just 001 — a corpus DB is created from nothing, so it needs the full
// end state. Naming one file here is how a fresh --from-file database silently ships an older
// schema than production.
const statements = allSchemaStatements();
const out = createClient({ url: `file:${OUT}` });
for (const s of statements) {
  if (/^CREATE TRIGGER/i.test(s)) continue;
  await out.execute(s);
}
console.log(`schema applied to ${OUT} (${statements.length} statements, triggers deferred)\n`);

// --- pass 1: naming --------------------------------------------------------
const duckPath = join(dirname(OUT), "corpus-build.duckdb");
if (existsSync(duckPath)) rmSync(duckPath);
const duck = await (await DuckDBInstance.create(duckPath)).connect();
await duck.run(`SET variable artifact_glob = '${DATA}/artifacts/part-*.parquet'`);

let t = Date.now();
for (const s of readFileSync(join(here, "naming.sql"), "utf-8").split(/;\s*\n(?=CREATE)/)) {
  if (s.trim()) await duck.run(s);
}
const named = Number((await duck.runAndReadAll("SELECT count(*) n FROM naming")).getRowObjects()[0].n);
console.log(`pass 1 — named ${named.toLocaleString()} skills in ${((Date.now() - t) / 1000).toFixed(0)}s`);

// Sibling file lists, aggregated once. validateSkill scores "referenced resources exist" and
// "bundled resources in correct subdirs" from this, so omitting it would make every score wrong.
t = Date.now();
await duck.run(`
  CREATE OR REPLACE TABLE siblings AS
  SELECT repo_full_name, artifact_path, list(entry_name) AS files
  FROM read_parquet('${DATA}/artifact_siblings/part-*.parquet')
  WHERE entry_type = 'file'
  GROUP BY 1, 2`);
const sibs = Number((await duck.runAndReadAll("SELECT count(*) n FROM siblings")).getRowObjects()[0].n);
console.log(`pass 1 — aggregated sibling lists for ${sibs.toLocaleString()} skills in ${((Date.now() - t) / 1000).toFixed(0)}s\n`);

// --- pass 2: score and write ----------------------------------------------
const shards = Array.from({ length: 31 }, (_, i) => i).slice(0, SHARD_LIMIT);
let written = 0;
let scored0 = 0;
const started = Date.now();

for (const shard of shards) {
  const file = `${DATA}/artifacts/part-${String(shard).padStart(5, "0")}.parquet`;
  if (!existsSync(file)) continue;
  const t0 = Date.now();

  const reader = await duck.runAndReadAll(`
    SELECT a.repo_full_name, a.path, a.file_sha, a.content, a.description,
           n.final_slug, n.display_name, s.files
    FROM read_parquet('${file}') a
    JOIN naming n ON n.file_sha = a.file_sha AND n.repo_full_name = a.repo_full_name
                 AND n.path = a.path
    LEFT JOIN siblings s ON s.repo_full_name = a.repo_full_name AND s.artifact_path = a.path
    WHERE a.dedup_primary = 1 AND a.frontmatter_valid = 1 AND a.filename = 'SKILL.md'`);

  const rows = reader.getRowObjects() as any[];
  let batch: { sql: string; args: any[] }[] = [];

  for (const r of rows) {
    const files: string[] = Array.isArray(r.files) ? r.files.map(String) : [];
    const { score } = validateSkill({ skillMd: String(r.content ?? ""), files });
    if (score === 0) scored0++;

    const dir = String(r.path).replace(/\/?SKILL\.md$/, "");
    const owner = String(r.repo_full_name).split("/")[0];
    // tree/HEAD, not a branch name — the dataset has no default_branch and `main` would 404
    // for every master-default repo. See D14.
    const sourceUrl = dir
      ? `https://github.com/${r.repo_full_name}/tree/HEAD/${dir}`
      : `https://github.com/${r.repo_full_name}`;

    batch.push({
      // `source` is set here, at INSERT time, rather than by a later UPDATE. Relabelling
      // 1.6M rows afterwards would fire skills_au per row and rewrite both FTS5 tables —
      // see the note at the foot of schema/sqlite/002_source_and_stats.sql.
      sql: `INSERT INTO skills (id, name, display_name, owner, description, author, source_url,
                                trust_tier, score, spec_version, tags, content_key, source)
            VALUES (?,?,?,?,?,?,?,'community',?,'1.0',NULL,?,'imported')
            ON CONFLICT (owner, name) DO NOTHING`,
      args: [randomUUID(), String(r.final_slug), r.display_name == null ? null : String(r.display_name),
             owner, String(r.description ?? r.display_name ?? r.final_slug), owner, sourceUrl,
             score, String(r.file_sha)],
    });

    if (batch.length >= BATCH) { await out.batch(batch, "write"); written += batch.length; batch = []; }
  }
  if (batch.length) { await out.batch(batch, "write"); written += batch.length; }

  const secs = (Date.now() - t0) / 1000;
  console.log(`  shard ${String(shard).padStart(2)}: ${rows.length.toLocaleString().padStart(9)} rows in ${secs.toFixed(0)}s` +
              `  (total ${written.toLocaleString()})`);
}

// --- finish: FTS, triggers, compact ---------------------------------------
console.log("\nbuilding FTS indexes...");
t = Date.now();
await out.execute("INSERT INTO skills_fts(skills_fts) VALUES('rebuild')");
await out.execute("INSERT INTO skills_trgm(skills_trgm) VALUES('rebuild')");
for (const s of statements) if (/^CREATE TRIGGER/i.test(s)) await out.execute(s);
await out.execute("INSERT INTO skills_fts(skills_fts) VALUES('integrity-check')");
await out.execute("INSERT INTO skills_trgm(skills_trgm) VALUES('integrity-check')");
console.log(`  done in ${((Date.now() - t) / 1000).toFixed(0)}s`);

const size = statSync(OUT).size;
console.log(`\nwritten ${written.toLocaleString()} skills in ${((Date.now() - started) / 60000).toFixed(1)} min`);
console.log(`score 0 (unparseable/invalid): ${scored0.toLocaleString()}`);
console.log(`file size: ${(size / 1e9).toFixed(2)} GB  — --from-file ceiling is 2 GB`);

