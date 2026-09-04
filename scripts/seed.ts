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

import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { fetchSkillFromGitHub } from "../src/github/fetch.js";
import { validateSkill } from "../src/validator/index.js";
import { slugifySkillName } from "../src/types/skill.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

/** Page through one column, defeating PostgREST's max-rows cap.
 *  A short page means the end of the table; a full page always implies another request. */
async function fetchAllColumn(table: string, column: string): Promise<string[]> {
  const PAGE = 1000;
  const values: string[] = [];

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(column)
      .range(from, from + PAGE - 1);

    if (error) {
      // Preloading is an optimisation, not a correctness requirement: failing here costs
      // GitHub quota, it does not corrupt the run. Say so loudly and carry on.
      console.error(`Failed to preload ${table}.${column}: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;

    // Dynamic table/column names defeat the client's row typing; the shape is known here.
    values.push(...data.map((row) => (row as unknown as Record<string, string>)[column]));
    if (data.length < PAGE) break;
  }

  return values;
}

async function seed() {
  console.log("Skilldex Registry — skill sync\n");

  // 1. Ensure spec version exists
  const { error: specError } = await supabase.from("spec_versions").upsert(
    [{ version: "1.0", released_at: "2026-03-26T00:00:00.000Z", is_current: true }],
    { onConflict: "version" }
  );
  if (specError) console.warn("spec_versions upsert:", specError.message);
  else console.log("✓ spec_versions ready");

  // 2. Ensure official publisher exists
  const { data: publisher, error: pubError } = await supabase
    .from("publishers")
    .upsert(
      [{ github_handle: "skilldex-official", email: null, verified: true }],
      { onConflict: "github_handle" }
    )
    .select("*")
    .single();

  if (pubError || !publisher) {
    console.error("Failed to ensure publisher:", pubError?.message);
    return;
  }
  console.log(`✓ Publisher ready: ${publisher.github_handle}\n`);

  // 3. Load watched repos from DB (single source of truth)
  const { data: watchedRepos, error: reposError } = await supabase
    .from("watched_repos")
    .select("*")
    .eq("enabled", true)
    .order("added_at");

  if (reposError || !watchedRepos) {
    console.error("Failed to load watched_repos:", reposError?.message);
    return;
  }
  console.log(`Loaded ${watchedRepos.length} watched repos from DB`);

  // 4. Pre-load all existing source_urls to avoid redundant GitHub API calls.
  //    Includes skills already inserted AND urls previously seen but skipped
  //    due to name conflicts — prevents re-fetching them every run.
  //
  //    This MUST paginate. An unranged select is capped by PostgREST's max-rows, which
  //    silently truncates the set: everything above the cap looks new, is re-fetched from
  //    GitHub on every run, and inflates every "N new" figure the run reports. Writes stay
  //    no-ops under ignoreDuplicates, so the only symptoms are wasted API quota and
  //    misleading counts — which is why it went unnoticed.
  const [existingSourceUrls, seenSourceUrls] = await Promise.all([
    fetchAllColumn("skills", "source_url"),
    fetchAllColumn("seen_source_urls", "url"),
  ]);

  const existingUrls = new Set([...existingSourceUrls, ...seenSourceUrls]);
  console.log(`${existingUrls.size} skills already in registry\n`);

  // 5. Process each repo
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const watched of watchedRepos) {
    const { owner, repo, branch, trust_tier, tags } = watched;
    console.log(`Scanning ${owner}/${repo} [${trust_tier}]...`);

    const allPaths = await discoverSkillPaths(owner, repo, branch ?? "main");
    const newPaths = allPaths.filter((p) => !existingUrls.has(p));

    console.log(
      `  ${allPaths.length} skills found, ${newPaths.length} new`
    );

    if (newPaths.length === 0) {
      // Update last_scanned_at even when nothing is new
      await supabase
        .from("watched_repos")
        .update({ last_scanned_at: new Date().toISOString() })
        .eq("id", watched.id);
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

        const { data: inserted, error } = await supabase
          .from("skills")
          .upsert(
            [
              {
                name: slug,
                display_name: metadata.name,
                owner,
                description: metadata.description || metadata.name,
                author: owner,
                source_url: sourceUrl,
                trust_tier,
                score: validation.score,
                spec_version: metadata.spec_version ?? "1.0",
                tags: [...(tags ?? []), ...((metadata as any).tags ?? [])],
                published_by: publisher.id,
              },
            ],
            { onConflict: "owner,name", ignoreDuplicates: true }
          )
          .select("name");

        if (error) {
          console.log(`  ✗ ${metadata.name}: ${error.message}`);
          totalFailed++;
        } else if (!inserted || inserted.length === 0) {
          console.log(`  ~ ${metadata.name} (name conflict, skipped)`);
          totalSkipped++;
          // Persist so future runs don't re-fetch this url
          await supabase
            .from("seen_source_urls")
            .upsert([{ url: sourceUrl }], { onConflict: "url", ignoreDuplicates: true });
          existingUrls.add(sourceUrl);
        } else {
          console.log(`  ✓ ${metadata.name} (score: ${validation.score})`);
          totalInserted++;
          existingUrls.add(sourceUrl); // keep local set in sync
        }
      } catch (err: any) {
        console.log(`  ✗ ${sourceUrl}: ${err.message}`);
        totalFailed++;
      }
    }

    // Mark repo as scanned
    await supabase
      .from("watched_repos")
      .update({ last_scanned_at: new Date().toISOString() })
      .eq("id", watched.id);
  }

  console.log(
    `\nDone! Inserted: ${totalInserted}, Skipped: ${totalSkipped}, Failed: ${totalFailed}`
  );
}

seed().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
