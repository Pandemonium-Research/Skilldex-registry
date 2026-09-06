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

/** A discovered SKILL.md: where it lives, and the sha of its current contents. */
interface DiscoveredSkill {
  url: string;
  /** Blob sha from the tree response. Content identity, free — no extra request. */
  sha: string;
}

async function discoverSkillPaths(
  owner: string,
  repo: string,
  branch: string
): Promise<DiscoveredSkill[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  const res = await fetch(url, { headers: githubHeaders() });

  if (!res.ok) {
    console.warn(`  Could not fetch tree for ${owner}/${repo}: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as {
    tree: Array<{ path: string; type: string; sha: string }>;
    truncated?: boolean;
  };

  if (data.truncated) {
    console.warn(`  Warning: tree for ${owner}/${repo} is truncated`);
  }

  return data.tree
    .filter((f) => f.type === "blob" && f.path.endsWith("/SKILL.md"))
    .map((f) => {
      const dir = f.path.replace("/SKILL.md", "");
      return {
        url: `https://github.com/${owner}/${repo}/tree/${branch}/${dir}`,
        sha: f.sha,
      };
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
type KnownUrls = Map<string, { ingested: boolean; sha: string | null }>;

async function knownUrlsForRepo(owner: string, repo: string): Promise<KnownUrls> {
  const rawPrefix = `https://github.com/${owner}/${repo}/`;
  const known: KnownUrls = new Map();
  try {
    const [inserted, seen] = await Promise.all([
      // Selected by owner, then filtered to this repo in JS. The obvious query — source_url
      // LIKE prefix — needs an index on source_url, and at 1.6M rows that index costs 159 MB
      // against a 2 GB --from-file ceiling. Owner is already indexed as the leading column of
      // the (owner, name) unique constraint, and the largest watched owner holds a few hundred
      // rows, so the filter is free.
      db.execute({ sql: "SELECT source_url AS u FROM skills WHERE owner = ?", args: [owner] }),
      // A range, not LIKE. url is this table's primary key, but SQLite cannot use a
      // BINARY-collated index for LIKE — LIKE is case-insensitive by default, so the plan
      // came out as SCAN. Comparing against the prefix and its upper bound is an index seek,
      // and it sidesteps wildcard escaping entirely.
      db.execute({
        sql: "SELECT url AS u, blob_sha AS s FROM seen_source_urls WHERE url >= ? AND url < ?",
        args: [rawPrefix, `${rawPrefix}\uffff`],
      }),
    ]);
    for (const r of inserted.rows) {
      const u = String(r.u);
      if (!u.startsWith(rawPrefix)) continue; // same owner, different repo
      known.set(u, { ingested: true, sha: null });
    }
    for (const r of seen.rows) {
      if (known.has(String(r.u))) continue; // an ingested skill wins over a stale seen row
      known.set(String(r.u), { ingested: false, sha: r.s == null ? null : String(r.s) });
    }
    return known;
  } catch (err: any) {
    console.error(`  Could not load known urls for ${owner}/${repo}: ${err.message}`);
    return known;
  }
}

/**
 * Should this discovered skill be fetched?
 *
 * Already ingested: no. Settled with the *same* contents: no. Settled with **different**
 * contents: yes — the file has been edited since we gave up on it, and the edit may be the
 * fix. That case is why `blob_sha` exists: recording a parse failure without it blacklists a
 * url permanently, so an author who corrects their YAML is never noticed.
 *
 * Rows recorded before `blob_sha` existed carry null. Those are skipped *and* adopted — see
 * adoptBaselineShas — so they gain a baseline without being re-fetched, and retry-on-change
 * starts applying to them from the next run onwards.
 */
function shouldFetch(found: DiscoveredSkill, known: KnownUrls): boolean {
  const prior = known.get(found.url);
  if (!prior) return true;
  if (prior.ingested) return false;
  if (prior.sha === null) return false;
  return prior.sha !== found.sha;
}

/**
 * Give settled-but-shaless rows a baseline, without fetching anything.
 *
 * Rows recorded before `blob_sha` existed cannot be compared, so they would be skipped
 * forever — the very blacklisting this column exists to end. Discovery already knows the
 * current sha of every path, so adopting it costs a database write and no GitHub request.
 *
 * Adoption deliberately treats *today's* contents as the settled state: a file that was fixed
 * before this ran is not re-examined, which is exactly the behaviour that already applied.
 * From the next edit onwards it is.
 */
async function adoptBaselineShas(found: DiscoveredSkill[], known: KnownUrls): Promise<void> {
  const adopt = found.filter((f) => {
    const prior = known.get(f.url);
    return prior && !prior.ingested && prior.sha === null;
  });
  if (adopt.length === 0) return;

  const CHUNK = 500;
  for (let i = 0; i < adopt.length; i += CHUNK) {
    await db.batch(
      adopt.slice(i, i + CHUNK).map((f) => ({
        sql: "UPDATE seen_source_urls SET blob_sha = ? WHERE url = ? AND blob_sha IS NULL",
        args: [f.sha, f.url],
      })),
      "write"
    );
  }
  for (const f of adopt) known.set(f.url, { ingested: false, sha: f.sha });
  console.log(`  adopted a baseline sha for ${adopt.length} previously unversioned url(s)`);
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
  const markSeen = async (url: string, sha: string, known: KnownUrls) => {
    // DO UPDATE, not OR IGNORE: a url retried after an edit and still broken must record its
    // *new* sha, or it would be retried on every subsequent run.
    await db.execute({
      sql: `INSERT INTO seen_source_urls (url, blob_sha) VALUES (?, ?)
            ON CONFLICT (url) DO UPDATE SET blob_sha = excluded.blob_sha`,
      args: [url, sha],
    });
    known.set(url, { ingested: false, sha }); // keep the local map in step
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
    await adoptBaselineShas(allPaths, known);
    const newPaths = allPaths.filter((p) => shouldFetch(p, known));
    const changed = newPaths.filter((p) => known.has(p.url)).length;

    console.log(
      `  ${allPaths.length} skills found, ${newPaths.length} to fetch` +
        `${changed ? ` (${changed} changed since last settled)` : ""}` +
        ` (${known.size} already known here)`
    );

    if (newPaths.length === 0) {
      // Update last_scanned_at even when nothing is new
      await markScanned(watchedId);
      totalSkipped += allPaths.length;
      continue;
    }

    for (const { url: sourceUrl, sha: blobSha } of newPaths) {
      await sleep(DELAY_MS);

      try {
        const metadata = await fetchSkillFromGitHub(sourceUrl);

        if (!metadata.name) {
          console.log(`  ✗ Skipped (no name): ${sourceUrl}`);
          totalFailed++;
          await markSeen(sourceUrl, blobSha, known); // parsed, and has no name today
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
          await markSeen(sourceUrl, blobSha, known);
        } else {
          console.log(`  ✓ ${metadata.name} (score: ${validation.score})`);
          totalInserted++;
          known.set(sourceUrl, { ingested: true, sha: blobSha }); // keep local map in sync
        }
      } catch (err: any) {
        console.log(`  ✗ ${sourceUrl}: ${err.message}`);
        totalFailed++;
        // PARSE_FAILED is a property of the file, not of this run: the same SKILL.md
        // parses the same way tomorrow. Every other error (FETCH_FAILED, aborts, 5xx)
        // may well succeed next time, so those are deliberately left to be retried.
        if (err?.code === "PARSE_FAILED") await markSeen(sourceUrl, blobSha, known);
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
