import { parse as parseYaml } from "yaml";

export interface SkillMetadata {
  name: string;
  description: string;
  spec_version: string;
  author?: string;
  skillMd: string;
  files: string[];
}

/**
 * Fetch SKILL.md and file list from a GitHub repository URL.
 * Expects a URL like: https://github.com/user/repo or https://github.com/user/repo/tree/branch/subpath
 */
export async function fetchSkillFromGitHub(sourceUrl: string): Promise<SkillMetadata> {
  const { owner, repo, branch, subpath } = parseGitHubUrl(sourceUrl);
  const token = process.env.GITHUB_TOKEN;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "skilldex-registry",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const ref = branch || "main";
  const basePath = subpath ? `${subpath}/` : "";

  // Fetch SKILL.md content
  const skillMdPath = `${basePath}SKILL.md`;
  const skillMdContent = await fetchFileContent(owner, repo, ref, skillMdPath, headers);

  if (!skillMdContent) {
    throw Object.assign(
      new Error(`Could not fetch SKILL.md from ${sourceUrl}`),
      { code: "FETCH_FAILED" }
    );
  }

  // Fetch file listing from the directory
  const files = await fetchDirectoryListing(owner, repo, ref, basePath, headers);

  // Parse frontmatter
  const frontmatter = extractFrontmatter(skillMdContent);
  if (!frontmatter) {
    throw Object.assign(
      new Error("SKILL.md is missing YAML frontmatter"),
      { code: "PARSE_FAILED" }
    );
  }

  const parsed = parseYaml(frontmatter) as Record<string, any>;

  return {
    name: parsed.name ?? "",
    description: parsed.description ?? "",
    spec_version: parsed.spec_version ?? "1.0",
    author: parsed.author,
    skillMd: skillMdContent,
    files,
  };
}

export interface RelocatedSkill {
  sourceUrl: string;
  metadata: SkillMetadata;
}

/**
 * Recover from a source_url that 404s because the repo was reorganized
 * (directory renamed/moved). Scans every SKILL.md in the repo's current
 * tree and returns the one whose frontmatter `name` matches expectedName,
 * along with the corrected source_url. Returns null if no match is found
 * (skill genuinely removed, renamed to a different `name`, or repo gone).
 */
export async function findRelocatedSkill(
  sourceUrl: string,
  expectedName: string
): Promise<RelocatedSkill | null> {
  const { owner, repo, branch } = parseGitHubUrl(sourceUrl);
  const ref = branch || "main";
  const token = process.env.GITHUB_TOKEN;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "skilldex-registry",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const response = await fetchWithTimeout(treeUrl, headers);
  if (!response.ok) return null;

  const data = (await response.json()) as {
    tree: Array<{ path: string; type: string }>;
  };

  const skillDirs = data.tree
    .filter((entry) => entry.type === "blob" && entry.path.endsWith("SKILL.md"))
    .map((entry) => (entry.path === "SKILL.md" ? "" : entry.path.slice(0, -"/SKILL.md".length)));

  // We already have the full tree in memory — check each candidate's SKILL.md
  // content directly instead of calling fetchSkillFromGitHub, which would
  // re-fetch this same recursive tree again for every single candidate.
  // Bounded by a wall-clock budget (not just skillDirs.length) so a repo with
  // many skill folders — or one where requests are consistently slow —
  // can't stall the whole rescore run; we just give up and report "not found".
  const searchStart = Date.now();
  for (const dir of skillDirs) {
    if (Date.now() - searchStart > RELOCATION_SEARCH_BUDGET_MS) break;

    const candidateUrl = dir
      ? `https://github.com/${owner}/${repo}/tree/${ref}/${dir}`
      : `https://github.com/${owner}/${repo}`;
    const skillMdPath = dir ? `${dir}/SKILL.md` : "SKILL.md";

    try {
      const content = await fetchFileContent(owner, repo, ref, skillMdPath, headers);
      if (!content) continue;

      const frontmatter = extractFrontmatter(content);
      if (!frontmatter) continue;

      const parsed = parseYaml(frontmatter) as Record<string, any>;
      if (parsed.name !== expectedName) continue;

      return {
        sourceUrl: candidateUrl,
        metadata: {
          name: parsed.name ?? "",
          description: parsed.description ?? "",
          spec_version: parsed.spec_version ?? "1.0",
          author: parsed.author,
          skillMd: content,
          files: filesFromTree(data.tree, dir),
        },
      };
    } catch {
      // This candidate timed out or failed to fetch — not a match, keep looking
    }
  }

  return null;
}

// --- Internal helpers ---

// Guards against a stalled GitHub response hanging the whole process forever
// (plain fetch() has no default timeout).
const FETCH_TIMEOUT_MS = 15_000;

// Total wall-clock budget for a single findRelocatedSkill search. Caps worst-case
// time on repos with many skill folders instead of scaling with candidate count.
const RELOCATION_SEARCH_BUDGET_MS = 30_000;

// A rate-limited response looks just like a 404 unless we check for it
// explicitly — without this, a caller near quota exhaustion would treat every
// remaining request as "not found" and, worse, kick off the (also rate
// limited) relocation search for each one instead of just waiting it out.
const MAX_RATE_LIMIT_RETRIES = 2;
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;
const MAX_RATE_LIMIT_WAIT_MS = 65 * 60_000; // primary limit resets hourly; never wait longer than that
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRateLimitResponse(response: Response): boolean {
  if (response.status !== 403 && response.status !== 429) return false;
  return response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
}

function rateLimitWaitMs(response: Response): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000 + 1000, MAX_RATE_LIMIT_WAIT_MS);
  }

  const resetAt = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(resetAt) && resetAt > 0) {
    const waitMs = resetAt * 1000 - Date.now() + 1000; // +1s buffer past reset
    if (waitMs > 0) return Math.min(waitMs, MAX_RATE_LIMIT_WAIT_MS);
  }

  return DEFAULT_RATE_LIMIT_WAIT_MS;
}

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  attempt = 0
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (isRateLimitResponse(response) && attempt < MAX_RATE_LIMIT_RETRIES) {
    const waitMs = rateLimitWaitMs(response);
    console.warn(
      `  ⏸ GitHub API rate limit hit — waiting ${Math.ceil(waitMs / 1000)}s for it to reset...`
    );
    await sleep(waitMs);
    return fetchWithTimeout(url, headers, attempt + 1);
  }

  return response;
}

function parseGitHubUrl(url: string): {
  owner: string;
  repo: string;
  branch?: string;
  subpath?: string;
} {
  // Remove trailing slashes and .git
  const cleaned = url.replace(/\.git$/, "").replace(/\/$/, "");
  const urlObj = new URL(cleaned);
  const parts = urlObj.pathname.split("/").filter(Boolean);

  if (parts.length < 2) {
    throw new Error(`Invalid GitHub URL: ${url}`);
  }

  const owner = parts[0];
  const repo = parts[1];

  // https://github.com/owner/repo/tree/branch/subpath
  if (parts[2] === "tree" && parts.length >= 4) {
    return {
      owner,
      repo,
      branch: parts[3],
      subpath: parts.length > 4 ? parts.slice(4).join("/") : undefined,
    };
  }

  return { owner, repo };
}

async function fetchFileContent(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  headers: Record<string, string>
): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
  const response = await fetchWithTimeout(url, headers);

  if (!response.ok) return null;

  const data = (await response.json()) as { content?: string; encoding?: string };

  if (data.content && data.encoding === "base64") {
    return Buffer.from(data.content, "base64").toString("utf-8");
  }

  return null;
}

async function fetchDirectoryListing(
  owner: string,
  repo: string,
  ref: string,
  basePath: string,
  headers: Record<string, string>
): Promise<string[]> {
  // Use the Git Trees API for recursive listing
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const response = await fetchWithTimeout(treeUrl, headers);

  if (!response.ok) return [];

  const data = (await response.json()) as {
    tree: Array<{ path: string; type: string }>;
  };

  return filesFromTree(data.tree, basePath);
}

// Given an already-fetched recursive repo tree, list files under basePath
// relative to it (excluding SKILL.md itself). Shared by fetchDirectoryListing
// and findRelocatedSkill so a repo's tree only ever needs to be fetched once.
function filesFromTree(
  tree: Array<{ path: string; type: string }>,
  basePath: string
): string[] {
  const prefix = basePath.replace(/\/$/, "");
  return tree
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path)
    .filter((path) => {
      if (!prefix) return true;
      return path.startsWith(prefix + "/");
    })
    .map((path) => {
      if (!prefix) return path;
      return path.slice(prefix.length + 1);
    })
    .filter((path) => path !== "SKILL.md"); // exclude SKILL.md itself from file list
}

function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}
