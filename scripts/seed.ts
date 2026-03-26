/**
 * Seed script for Skilldex Registry.
 *
 * Seeds the registry with:
 * 1. The skilldex-official publisher account
 * 2. Spec version v1.0 (current)
 * 3. Skills discovered from known repos (verified + community)
 *
 * Usage: npm run seed
 * Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars
 */

import { createClient } from "@supabase/supabase-js";
import { fetchSkillFromGitHub } from "../src/github/fetch.js";
import { validateSkill } from "../src/validator/index.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Repos to scan for SKILL.md files.
// All skills discovered retain their original source_url (attribution back to the repo)
// and author (the repo owner's GitHub handle).
const SEED_REPOS: Array<{
  owner: string;
  repo: string;
  branch?: string;
  trust_tier: "verified" | "community";
  tags?: string[];
}> = [
  {
    owner: "anthropics",
    repo: "skills",
    branch: "main",
    trust_tier: "verified",
    tags: ["official"],
  },
  {
    owner: "ComposioHQ",
    repo: "awesome-claude-skills",
    branch: "main",
    trust_tier: "community",
    tags: ["composio"],
  },
  {
    owner: "sickn33",
    repo: "antigravity-awesome-skills",
    branch: "main",
    trust_tier: "community",
  },
  {
    owner: "alirezarezvani",
    repo: "claude-skills",
    branch: "main",
    trust_tier: "community",
  },
];

// Delay between GitHub API calls to stay within rate limits
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
  branch: string = "main"
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
    console.warn(`  Warning: tree for ${owner}/${repo} is truncated (>100k files)`);
  }

  return data.tree
    .filter((f) => f.type === "blob" && f.path.endsWith("/SKILL.md"))
    .map((f) => {
      const dir = f.path.replace("/SKILL.md", "");
      return `https://github.com/${owner}/${repo}/tree/${branch}/${dir}`;
    });
}

async function seed() {
  console.log("Seeding Skilldex Registry...\n");

  // 1. Seed spec versions
  console.log("Seeding spec versions...");
  const { error: specError } = await supabase.from("spec_versions").upsert(
    [
      {
        version: "1.0",
        released_at: "2026-03-26T00:00:00.000Z",
        changelog_url: null,
        is_current: true,
      },
    ],
    { onConflict: "version" }
  );
  if (specError) {
    console.error("Failed to seed spec versions:", specError.message);
  } else {
    console.log("  ✓ spec_versions seeded (v1.0 = current)");
  }

  // 2. Create the official publisher account
  console.log("\nSeeding official publisher...");
  const { data: publisher, error: pubError } = await supabase
    .from("publishers")
    .upsert(
      [{ github_handle: "skilldex-official", email: null, verified: true }],
      { onConflict: "github_handle" }
    )
    .select("*")
    .single();

  if (pubError || !publisher) {
    console.error("Failed to seed publisher:", pubError?.message);
    return;
  }
  console.log(`  ✓ Publisher: ${publisher.github_handle} (verified)`);

  // 3. Seed skills from each repo
  let totalInserted = 0;
  let totalFailed = 0;

  for (const repo of SEED_REPOS) {
    const branch = repo.branch ?? "main";
    console.log(
      `\nScanning ${repo.owner}/${repo.repo} (${repo.trust_tier})...`
    );

    const skillPaths = await discoverSkillPaths(repo.owner, repo.repo, branch);

    if (skillPaths.length === 0) {
      console.log("  No SKILL.md files found — skipping");
      continue;
    }

    console.log(`  Found ${skillPaths.length} skills`);

    for (const sourceUrl of skillPaths) {
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

        const { error } = await supabase.from("skills").upsert(
          [
            {
              name: metadata.name,
              description: metadata.description || metadata.name,
              // Attribution: original repo owner credited as author.
              // source_url links directly back to the original folder in the source repo.
              author: repo.owner,
              source_url: sourceUrl,
              trust_tier: repo.trust_tier,
              score: validation.score,
              spec_version: metadata.spec_version ?? "1.0",
              tags: [
                ...(repo.tags ?? []),
                ...(metadata as any).tags ?? [],
              ],
              published_by: publisher.id,
            },
          ],
          { onConflict: "name" }
        );

        if (error) {
          console.log(`  ✗ ${metadata.name}: ${error.message}`);
          totalFailed++;
        } else {
          console.log(
            `  ✓ ${metadata.name} (score: ${validation.score}, author: ${repo.owner})`
          );
          totalInserted++;
        }
      } catch (err: any) {
        console.log(`  ✗ Failed: ${sourceUrl} — ${err.message}`);
        totalFailed++;
      }
    }
  }

  console.log(`\nDone! Inserted: ${totalInserted}, Failed: ${totalFailed}`);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
