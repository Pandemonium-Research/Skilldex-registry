/**
 * Skilldex Registry — skill sync script.
 *
 * Reads watched_repos from Supabase, discovers SKILL.md files in each repo,
 * and inserts only net-new skills (existing source_urls are skipped without
 * making any GitHub API calls).
 *
 * Usage:
 *   npm run seed      — local (loads .env)
 *   npm run seed:ci   — CI (reads env vars from environment)
 *
 * Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional:          GITHUB_TOKEN (raises GitHub API rate limit to 5000/hr)
 */

import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../src/db/client.js";
import { likePrefix } from "../src/db/like.js";
import { fetchSkillFromGitHub } from "../src/github/fetch.js";
import { validateSkill } from "../src/validator/index.js";
import { slugifySkillName } from "../src/types/skill.js";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!process.env.TURSO_DATABASE_URL) {
  console.error("Missing TURSO_DATABASE_URL");
  process.exit(1);
}

const db = getDb();

// Delay between GitHub API calls to stay within rate limits.
// 300ms → ~200 req/min, well within the 5000/hr authenticated limit.
const DELAY_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "skilldex-registry-seed",
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

async function discoverSkillPaths(
  owner: string,
  repo: string,
  branch: string
): Promise<string[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  const res = await fetch(url, { headers: githubHeaders() });

  if (!res.ok) {
    console.warn(`  Could not fetch tree for ${owner}/${repo}: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as {
    tree: Array<{ path: string; type: string }>;
    truncated?: boolean;
  };

  if (data.truncated) {
    console.warn(`  Warning: tree for ${owner}/${repo} is truncated`);
  }

  return data.tree
    .filter((f) => f.type === "blob" && f.path.endsWith("/SKILL.md"))
    .map((f) => {
      const dir = f.path.replace("/SKILL.md", "");
      return `https://github.com/${owner}/${repo}/tree/${branch}/${dir}`;
    });
}

/**
 * Urls already settled for ONE repo — inserted skills plus urls seen and deliberately skipped.
 *
 * This replaces a preload of *every* url in the registry into one in-memory Set. That was
 * O(corpus) on every run: fine at a few thousand rows, but at 1.6M skills it is thousands of
 * round trips and roughly a gigabyte of heap, every night, for data that barely changes. The
 * per-repo form scales with the repo being scanned instead.
 *
 * A failure here costs GitHub quota rather than correctness — a url wrongly believed new is
 * re-fetched and then written as a no-op — so it is reported and the scan continues.
 */
async function knownUrlsForRepo(owner: string, repo: string): Promise<Set<string>> {
  const prefix = likePrefix(`https://github.com/${owner}/${repo}/`);
  try {
    const [inserted, seen] = await Promise.all([
      db.execute({
        sql: "SELECT source_url AS u FROM skills WHERE source_url LIKE ? ESCAPE '\\'",
        args: [prefix],
      }),
      db.execute({
        sql: "SELECT url AS u FROM seen_source_urls WHERE url LIKE ? ESCAPE '\\'",
        args: [prefix],
      }),
    ]);
    return new Set([...inserted.rows, ...seen.rows].map((r) => String(r.u)));
  } catch (err: any) {
    console.error(`  Could not load known urls for ${owner}/${repo}: ${err.message}`);
    return new Set();
  }
}

/** Stamp a watched repo as scanned, whether or not it produced anything. */
async function markScanned(id: string): Promise<void> {
  await db.execute({
    sql: "UPDATE watched_repos SET last_scanned_at = ? WHERE id = ?",
    args: [new Date().toISOString(), id],
  });
}

async function seed() {
  console.log("Skilldex Registry — skill sync\n");

  // 1. Ensure spec version exists
  try {
    await db.execute({
      sql: `INSERT INTO spec_versions (version, released_at, is_current) VALUES (?, ?, 1)
            ON CONFLICT (version) DO UPDATE SET released_at = excluded.released_at`,
      args: ["1.0", "2026-03-26T00:00:00.000Z"],
    });
    console.log("✓ spec_versions ready");
  } catch (err: any) {
    console.warn("spec_versions upsert:", err.message);
  }

  // 2. Ensure official publisher exists
  const pub = await db.execute({
    sql: `INSERT INTO publishers (id, github_handle, email, verified) VALUES (?, ?, NULL, 1)
          ON CONFLICT (github_handle) DO UPDATE SET verified = 1
          RETURNING *`,
    args: [randomUUID(), "skilldex-official"],
  });

  if (pub.rows.length === 0) {
    console.error("Failed to ensure publisher");
    return;
  }
  const publisher = { id: String(pub.rows[0].id), github_handle: String(pub.rows[0].github_handle) };
  console.log(`✓ Publisher ready: ${publisher.github_handle}\n`);

  // 3. Load watched repos from DB (single source of truth)
  const reposResult = await db.execute(
    "SELECT * FROM watched_repos WHERE enabled = 1 ORDER BY added_at"
  );
  const watchedRepos = reposResult.rows;
  console.log(`Loaded ${watchedRepos.length} watched repos from DB`);

  // 4. Known urls are loaded per repo, inside the loop below — see knownUrlsForRepo.
  //    There is deliberately no global preload any more.

  /**
   * Record a url this run has settled, so no future run fetches it again.
   *
   * Only *deterministic* outcomes belong here: a name conflict, or a SKILL.md that will
   * fail in exactly the same way every time. Transient failures — a timeout, a 5xx, a
   * rate limit, a database error — must never be recorded, or one bad night would drop a
   * real skill from the registry permanently.
   */
  const markSeen = async (url: string, known: Set<string>) => {
    await db.execute({
      sql: "INSERT OR IGNORE INTO seen_source_urls (url) VALUES (?)",
      args: [url],
    });
    known.add(url); // keep the local set in step so this run skips it too
  };

  // 5. Process each repo
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const watched of watchedRepos) {
    const owner = String(watched.owner);
    const repo = String(watched.repo);
    const branch = watched.branch == null ? "main" : String(watched.branch);
    const trust_tier = String(watched.trust_tier);
    const tags: string[] = (() => {
      try {
        const t = watched.tags == null ? [] : JSON.parse(String(watched.tags));
        return Array.isArray(t) ? t : [];
      } catch {
        return [];
      }
    })();
    const watchedId = String(watched.id);

    console.log(`Scanning ${owner}/${repo} [${trust_tier}]...`);

    // Scoped to this repo, not the whole registry — see knownUrlsForRepo.
    const known = await knownUrlsForRepo(owner, repo);
    const allPaths = await discoverSkillPaths(owner, repo, branch);
    const newPaths = allPaths.filter((p) => !known.has(p));

    console.log(
      `  ${allPaths.length} skills found, ${newPaths.length} new (${known.size} already known here)`
    );

    if (newPaths.length === 0) {
      // Update last_scanned_at even when nothing is new
      await markScanned(watchedId);
      totalSkipped += allPaths.length;
      continue;
    }

    for (const sourceUrl of newPaths) {
      await sleep(DELAY_MS);

      try {
        const metadata = await fetchSkillFromGitHub(sourceUrl);

        if (!metadata.name) {
          console.log(`  ✗ Skipped (no name): ${sourceUrl}`);
          totalFailed++;
          await markSeen(sourceUrl, known); // parsed, and has no name; it will not grow one
          continue;
        }

        const validation = validateSkill({
          skillMd: metadata.skillMd,
          files: metadata.files,
        });

        // Names are unique per owner, not globally, so the same skill name published
        // by two different repo owners no longer collides.
        // The fallback key must be hex, not the URL itself — slugifySkillName takes its
        // first 8 characters verbatim, and "https://" is not a legal name.
        const slug = slugifySkillName(
          metadata.name,
          createHash("sha256").update(sourceUrl).digest("hex")
        );

        const inserted = await db.execute({
          sql: `INSERT INTO skills
                  (id, name, display_name, owner, description, author, source_url,
                   trust_tier, score, spec_version, tags, published_by)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT (owner, name) DO NOTHING
                RETURNING name`,
          args: [
            randomUUID(),
            slug,
            metadata.name,
            owner,
            metadata.description || metadata.name,
            owner,
            sourceUrl,
            trust_tier,
            validation.score,
            metadata.spec_version ?? "1.0",
            JSON.stringify([...tags, ...((metadata as any).tags ?? [])]),
            publisher.id,
          ],
        });

        if (inserted.rows.length === 0) {
          console.log(`  ~ ${metadata.name} (name conflict, skipped)`);
          totalSkipped++;
          await markSeen(sourceUrl, known);
        } else {
          console.log(`  ✓ ${metadata.name} (score: ${validation.score})`);
          totalInserted++;
          known.add(sourceUrl); // keep local set in sync
        }
      } catch (err: any) {
        console.log(`  ✗ ${sourceUrl}: ${err.message}`);
        totalFailed++;
        // PARSE_FAILED is a property of the file, not of this run: the same SKILL.md
        // parses the same way tomorrow. Every other error (FETCH_FAILED, aborts, 5xx)
        // may well succeed next time, so those are deliberately left to be retried.
        if (err?.code === "PARSE_FAILED") await markSeen(sourceUrl, known);
      }
    }

    // Mark repo as scanned
    await markScanned(watchedId);
  }

  console.log(
    `\nDone! Inserted: ${totalInserted}, Skipped: ${totalSkipped}, Failed: ${totalFailed}`
  );
}

seed().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
