/**
 * Merge the live registry into a freshly built corpus file, live rows winning.
 *
 *   npx tsx scripts/corpus/merge-live.ts [--out build/registry.db]
 *
 * Why this exists. GitSkills' `dedup_primary` keeps one representative per byte-identical
 * content and attributes it to whichever repo the dataset picked — usually not the repo the
 * registry watches. So the corpus contains the *content* of the live registry but not its
 * *attribution*: measured, only 663 of 4,863 live skills exist in the corpus under the same
 * owner. sickn33 alone goes from 2,114 to 16, and Orchestra-Research to zero.
 *
 * Replacing the registry with the corpus would therefore 404 roughly 4,200 skills that
 * currently resolve — every one a url someone may have installed. The live rows are merged in
 * as incumbents instead, which is also what makes the blue/green cutover safe: the new
 * database is a superset of the old one.
 *
 * Conflicts on (owner, name) resolve in favour of the live row, carrying its install_count —
 * the only genuine usage signal in the registry, and what D10 makes the default sort read.
 */
import { createClient } from "@libsql/client";

const args = process.argv.slice(2);
const i = args.indexOf("--out");
const OUT = i >= 0 && args[i + 1] ? args[i + 1] : "build/registry.db";

const live = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const out = createClient({ url: `file:${OUT}` });

/** Page a whole table out of the live registry. Never unranged — that is how the skip-list
 *  came to be truncated in the first place. */
async function readAll(table: string, cols: string): Promise<any[]> {
  const rows: any[] = [];
  for (let off = 0; ; off += 1000) {
    const page = await live.execute({
      sql: `SELECT ${cols} FROM ${table} ORDER BY rowid LIMIT 1000 OFFSET ?`,
      args: [off],
    });
    rows.push(...page.rows);
    if (page.rows.length < 1000) return rows;
  }
}

/** Straight copy of a table the corpus does not produce at all. */
async function copyTable(table: string, cols: string[], orderable = true): Promise<number> {
  const rows = orderable
    ? await readAll(table, cols.join(", "))
    : (await live.execute(`SELECT ${cols.join(", ")} FROM ${table}`)).rows;
  const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(",")})`;
  for (let j = 0; j < rows.length; j += 500) {
    await out.batch(
      rows.slice(j, j + 500).map((r: any) => ({ sql, args: cols.map((c) => r[c]) })),
      "write"
    );
  }
  console.log(`  ${table}: ${rows.length.toLocaleString()}`);
  return rows.length;
}

// The corpus build produces `skills` and nothing else, so every other table starts empty. That
// includes watched_repos — cutting over without this leaves the nightly seeder with nothing to
// scan — and seen_source_urls, without which every settled url is fetched again.
// publishers first: skills.published_by references it.
console.log("copying tables the corpus does not produce:");
await copyTable("publishers", ["id", "github_handle", "email", "verified", "created_at"]);
await copyTable("spec_versions", ["version", "released_at", "changelog_url", "is_current"], false);
await copyTable("watched_repos",
  ["id", "owner", "repo", "branch", "trust_tier", "tags", "enabled", "notes", "added_at", "last_scanned_at"]);
await copyTable("seen_source_urls", ["url", "blob_sha", "created_at"], false);
await copyTable("skillsets",
  ["id", "name", "description", "author", "source_url", "trust_tier", "score", "spec_version",
   "tags", "skill_refs", "install_count", "published_at", "updated_at", "published_by"]);

console.log("\nmerging skills:");
const before = Number((await out.execute("SELECT count(*) n FROM skills")).rows[0].n);

// Paged, because an unranged read of a table this size is exactly the mistake that produced
// the truncated skip-list.
const rows = await readAll("skills",
  `id, name, display_name, owner, description, author, source_url, trust_tier,
   score, spec_version, tags, install_count, content_key, published_at`);
console.log(`  read ${rows.length.toLocaleString()} live skills`);

const SQL = `
INSERT INTO skills (id, name, display_name, owner, description, author, source_url,
                    trust_tier, score, spec_version, tags, install_count, content_key,
                    published_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT (owner, name) DO UPDATE SET
  display_name  = excluded.display_name,
  description   = excluded.description,
  author        = excluded.author,
  source_url    = excluded.source_url,
  trust_tier    = excluded.trust_tier,
  score         = excluded.score,
  spec_version  = excluded.spec_version,
  tags          = excluded.tags,
  install_count = excluded.install_count,
  -- content_key becomes null for a row the registry owns rather than the corpus. The unique
  -- index on it is partial (WHERE content_key IS NOT NULL), so nulls never collide.
  content_key   = excluded.content_key,
  published_at  = excluded.published_at`;

let done = 0;
for (let j = 0; j < rows.length; j += 500) {
  await out.batch(
    rows.slice(j, j + 500).map((r) => ({
      sql: SQL,
      args: [r.id, r.name, r.display_name, r.owner, r.description, r.author, r.source_url,
             r.trust_tier, r.score, r.spec_version, r.tags, r.install_count, r.content_key,
             r.published_at],
    })),
    "write"
  );
  done += Math.min(500, rows.length - j);
}

const after = Number((await out.execute("SELECT count(*) n FROM skills")).rows[0].n);
console.log(`merged ${done.toLocaleString()} live rows: ${before.toLocaleString()} -> ${after.toLocaleString()} (${(after - before).toLocaleString()} new, ${(done - (after - before)).toLocaleString()} overwrote a corpus row)`);

// The FTS tables are external-content and the triggers are live by now, so they tracked these
// writes. Verify rather than assume.
for (const t of ["skills_fts", "skills_trgm"]) {
  await out.execute(`INSERT INTO ${t}(${t}) VALUES('integrity-check')`);
  console.log(`  ${t} integrity OK`);
}
