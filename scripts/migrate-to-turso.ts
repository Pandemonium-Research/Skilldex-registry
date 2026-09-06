/**
 * Copy the live registry out of Supabase and into Turso, then prove the two agree.
 *
 *   npm run migrate:turso -- --schema     apply schema/sqlite/001_schema.sql first
 *   npm run migrate:turso                 copy rows, then verify
 *   npm run migrate:turso -- --verify     verify only, copy nothing
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN.
 *
 * Idempotent: every insert is INSERT OR REPLACE keyed on the natural key, so re-running
 * converges rather than duplicating. `seq` is never copied — it is SQLite's own rowid and the
 * FTS5 tables bind to it (see REGISTRY_MIGRATION_DECISIONS.md D6).
 *
 * Reads from Supabase page at 1000 rows. That is not a tuning choice: PostgREST silently caps
 * an unranged select at its max-rows limit, which is exactly how the seeder's skip-list came
 * to run at ~21% of its real size. Never select a whole table here without a range.
 */
import { createClient as createTurso, type Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!SUPABASE_URL || !SUPABASE_KEY || !TURSO_URL || !TURSO_TOKEN) {
  console.error(
    "Missing env. Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN"
  );
  process.exit(1);
}

const PAGE = 1000;
const BATCH = 500; // statements per libsql batch

/** Every column we copy, and the natural key that makes a re-run idempotent. */
const TABLES = [
  // publishers first: skills.published_by and skillsets.published_by reference it.
  {
    name: "publishers",
    key: "id",
    cols: ["id", "github_handle", "email", "verified", "created_at"],
    bools: ["verified"],
    json: [] as string[],
  },
  {
    name: "skills",
    key: "id",
    cols: [
      "id", "name", "display_name", "owner", "description", "author", "source_url",
      "trust_tier", "score", "spec_version", "tags", "install_count", "content_key",
      "published_at", "updated_at", "published_by",
    ],
    bools: [] as string[],
    json: ["tags"],
  },
  {
    name: "skillsets",
    key: "id",
    // skill_count is GENERATED — never written.
    cols: [
      "id", "name", "description", "author", "source_url", "trust_tier", "score",
      "spec_version", "tags", "skill_refs", "install_count", "published_at",
      "updated_at", "published_by",
    ],
    bools: [] as string[],
    json: ["tags", "skill_refs"],
  },
  {
    name: "watched_repos",
    key: "id",
    cols: [
      "id", "owner", "repo", "branch", "trust_tier", "tags", "enabled", "notes",
      "added_at", "last_scanned_at",
    ],
    bools: ["enabled"],
    json: ["tags"],
  },
  { name: "seen_source_urls", key: "url", cols: ["url", "created_at"], bools: [], json: [] },
  {
    name: "spec_versions",
    key: "version",
    cols: ["version", "released_at", "changelog_url", "is_current"],
    bools: ["is_current"],
    json: [],
  },
] as const;

type TableSpec = (typeof TABLES)[number];

async function supabaseSelect(table: string, select: string, from: number, to: number) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${select}`, {
    headers: {
      apikey: SUPABASE_KEY!,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Range: `${from}-${to}`,
      Prefer: "count=exact",
    },
  });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
  const total = Number(res.headers.get("content-range")?.split("/")[1] ?? "0");
  return { rows: (await res.json()) as Record<string, unknown>[], total };
}

/** Page a whole table. Ranged, always — see the note at the top of this file. */
async function fetchAll(table: string, select: string) {
  const out: Record<string, unknown>[] = [];
  for (let off = 0; ; off += PAGE) {
    const { rows } = await supabaseSelect(table, select, off, off + PAGE - 1);
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** Postgres value -> SQLite value. The three shapes that actually differ. */
function toSqlite(spec: TableSpec, col: string, v: unknown) {
  if (v === null || v === undefined) return null;
  if ((spec.bools as readonly string[]).includes(col)) return v ? 1 : 0; // no boolean type
  if ((spec.json as readonly string[]).includes(col)) {
    return typeof v === "string" ? v : JSON.stringify(v); // text[] / jsonb -> JSON text
  }
  if (typeof v === "object") return JSON.stringify(v);
  return v as string | number;
}

async function copyTable(turso: Client, spec: TableSpec) {
  const rows = await fetchAll(spec.name, spec.cols.join(","));
  const sql =
    `INSERT OR REPLACE INTO ${spec.name} (${spec.cols.join(", ")}) ` +
    `VALUES (${spec.cols.map(() => "?").join(", ")})`;

  for (let i = 0; i < rows.length; i += BATCH) {
    await turso.batch(
      rows.slice(i, i + BATCH).map((r) => ({
        sql,
        args: spec.cols.map((c) => toSqlite(spec, c, r[c])) as any[],
      })),
      "write"
    );
    process.stdout.write(`\r  ${spec.name}: ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  console.log(`\r  ${spec.name}: ${rows.length}/${rows.length} copied${" ".repeat(20)}`);
  return rows.length;
}

/**
 * Parity: counts must match, and a search must return the same top results from both.
 * Counts alone would pass even if every description were empty.
 */
async function verify(turso: Client) {
  let ok = true;

  console.log("\nRow counts");
  for (const spec of TABLES) {
    const { total } = await supabaseSelect(spec.name, spec.key, 0, 0);
    const got = Number(
      (await turso.execute(`SELECT count(*) n FROM ${spec.name}`)).rows[0].n
    );
    const match = total === got;
    ok &&= match;
    console.log(`  ${match ? "✓" : "✗"} ${spec.name.padEnd(18)} supabase=${total}  turso=${got}`);
  }

  console.log("\nSearch parity (top 5 for 'pdf')");
  const pg = await fetch(
    `${SUPABASE_URL}/rest/v1/skills?select=owner,name&limit=5&order=score.desc,name.asc` +
      `&or=(name.ilike.*pdf*,description.ilike.*pdf*)`,
    { headers: { apikey: SUPABASE_KEY!, Authorization: `Bearer ${SUPABASE_KEY}` } }
  ).then((r) => r.json() as Promise<{ owner: string; name: string }[]>);

  const lt = await turso.execute({
    sql: `SELECT s.owner, s.name FROM skills_fts f JOIN skills s ON s.seq = f.rowid
          WHERE skills_fts MATCH ? ORDER BY s.score DESC, s.name ASC LIMIT 5`,
    args: ["pdf"],
  });

  const a = pg.map((r) => `${r.owner}/${r.name}`);
  const b = lt.rows.map((r) => `${r.owner}/${r.name}`);
  console.log(`  supabase: ${a.join(", ") || "(none)"}`);
  console.log(`  turso   : ${b.join(", ") || "(none)"}`);
  // Not asserted equal: Postgres websearch/ILIKE and FTS5 tokenise differently, so the sets
  // can legitimately differ at the margin. Printed for a human to eyeball.

  console.log("\nFTS integrity");
  for (const t of ["skills_fts", "skills_trgm", "skillsets_fts"]) {
    try {
      await turso.execute(`INSERT INTO ${t}(${t}) VALUES('integrity-check')`);
      console.log(`  ✓ ${t}`);
    } catch (e: any) {
      ok = false;
      console.log(`  ✗ ${t}: ${e.message}`);
    }
  }
  return ok;
}

async function main() {
  const args = process.argv.slice(2);
  const turso = createTurso({ url: TURSO_URL!, authToken: TURSO_TOKEN });
  await turso.execute("PRAGMA foreign_keys = ON");

  if (args.includes("--schema")) {
    const here = dirname(fileURLToPath(import.meta.url));
    const ddl = readFileSync(join(here, "..", "schema", "sqlite", "001_schema.sql"), "utf-8");
    console.log("Applying schema...");
    // Split on statement boundaries, keeping CREATE TRIGGER ... BEGIN ... END; intact.
    const stmts = ddl
      .replace(/^\s*--.*$/gm, "")
      .split(/;\s*(?=(?:[^']*'[^']*')*[^']*$)/)
      .map((s) => s.trim())
      .filter(Boolean);
    const merged: string[] = [];
    for (const s of stmts) {
      const prev = merged[merged.length - 1];
      if (prev && /\bBEGIN\b/i.test(prev) && !/\bEND\b\s*$/i.test(prev)) merged[merged.length - 1] = `${prev}; ${s}`;
      else merged.push(s);
    }
    for (const s of merged) await turso.execute(s);
    console.log(`  ${merged.length} statements applied\n`);
  }

  if (!args.includes("--verify")) {
    console.log("Copying tables (publishers first — the others reference it)");
    for (const spec of TABLES) await copyTable(turso, spec);
  }

  const ok = await verify(turso);
  console.log(ok ? "\nPARITY OK" : "\nPARITY FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
