import { parse as parseYaml } from "yaml";
import type { SkillRef } from "../types/skillset.js";

export interface SkillsetMetadata {
  name: string;
  description: string;
  spec_version: string;
  author?: string;
  skillsetMd: string;
  files: string[];
  skillRefs: SkillRef[];        // all skills: embedded + remote refs from frontmatter
  embeddedSkillNames: string[]; // discovered from directory listing
  /**
   * Reads any file in the skillset by skillset-relative POSIX path ("assets/x.md",
   * "member/SKILL.md"), or null when it is absent or could not be fetched.
   *
   * `files` above is a listing, not content, and coherence checking needs the bytes of every
   * member's SKILL.md and every shared asset. This closes over the already-resolved repo
   * coordinates so callers need not re-parse the URL, and memoizes per path because the coherence
   * checks read each shared asset twice — once collecting declared conventions, once looking for
   * undeclared ones.
   */
  readFile(relPath: string): Promise<string | null>;
}

/**
 * Fetch SKILLSET.md and file list from a GitHub repository URL.
 * Expects a URL like: https://github.com/user/repo or https://github.com/user/repo/tree/branch/subpath
 */
export async function fetchSkillsetFromGitHub(sourceUrl: string): Promise<SkillsetMetadata> {
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

  // Memoized blob reader over these coordinates. The promise is cached rather than its result so
  // concurrent reads of the same path share one request. `.catch` keeps the contract callers rely
  // on — null for unreadable, never a rejection — and it now absorbs two kinds of failure: a
  // transport error thrown by fetch, and the HTTP errors fetchFileContent raises so the SKILLSET.md
  // read can report them. Coherence walks members in a loop with no try/catch and treats null as
  // "skip", so a rejection here would abort a publish that should have been refused with a 422.
  const blobs = new Map<string, Promise<string | null>>();
  const readFile = (relPath: string): Promise<string | null> => {
    let pending = blobs.get(relPath);
    if (!pending) {
      pending = fetchFileContent(owner, repo, ref, `${basePath}${relPath}`, headers).catch(
        () => null
      );
      blobs.set(relPath, pending);
    }
    return pending;
  };

  // Fetch SKILLSET.md content
  const skillsetMdPath = `${basePath}SKILLSET.md`;
  const skillsetMdContent = await fetchFileContent(owner, repo, ref, skillsetMdPath, headers);

  // Reached only when GitHub answered 200 with something that is not base64 file content — a
  // directory at that path, say. Every HTTP failure has already thrown with its status and
  // GitHub's own explanation, which is what the publisher actually needs to see.
  if (!skillsetMdContent) {
    throw Object.assign(
      new Error(`SKILLSET.md at ${sourceUrl} is not a readable file`),
      { code: "FETCH_FAILED" }
    );
  }

  // Fetch recursive file listing
  const files = await fetchDirectoryListing(owner, repo, ref, basePath, headers);

  // Parse frontmatter
  const frontmatterStr = extractFrontmatter(skillsetMdContent);
  if (!frontmatterStr) {
    throw Object.assign(
      new Error("SKILLSET.md is missing YAML frontmatter"),
      { code: "PARSE_FAILED" }
    );
  }

  const parsed = parseYaml(frontmatterStr) as Record<string, any>;

  // Discover embedded skill names: depth-1 subdirs that have SKILL.md
  const embeddedSkillNames = discoverEmbeddedSkills(files);

  // Remote refs from frontmatter `skills` field
  const frontmatterRemoteRefs: SkillRef[] = Array.isArray(parsed.skills)
    ? (parsed.skills as any[])
        .filter((s) => s && typeof s.name === "string" && typeof s.source_url === "string")
        .map((s) => ({ name: String(s.name), source_url: String(s.source_url) }))
    : [];

  // Combined skill_refs: embedded skills get a relative source_url, remote refs use their own
  const embeddedRefs: SkillRef[] = embeddedSkillNames.map((name) => ({
    name,
    source_url: `${sourceUrl.replace(/\/$/, "")}/${name}`,
  }));

  const skillRefs: SkillRef[] = [...embeddedRefs, ...frontmatterRemoteRefs];

  return {
    name: parsed.name ?? "",
    description: parsed.description ?? "",
    spec_version: parsed.spec_version ?? "1.0",
    author: parsed.author,
    skillsetMd: skillsetMdContent,
    files,
    skillRefs,
    embeddedSkillNames,
    readFile,
  };
}

// --- Internal helpers ---

function parseGitHubUrl(url: string): {
  owner: string;
  repo: string;
  branch?: string;
  subpath?: string;
} {
  const cleaned = url.replace(/\.git$/, "").replace(/\/$/, "");
  const urlObj = new URL(cleaned);
  const parts = urlObj.pathname.split("/").filter(Boolean);

  if (parts.length < 2) {
    throw new Error(`Invalid GitHub URL: ${url}`);
  }

  const owner = parts[0];
  const repo = parts[1];

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

/**
 * Ceiling on a single GitHub call, because these run inside a request.
 *
 * A publish makes one call per member plus one per shared asset, and a bare fetch has no timeout
 * of its own: one stalled connection would hold the function until the platform killed it, turning
 * a transient network fault into a five-minute occupancy and an unexplained 504. With a ceiling the
 * same fault surfaces as the 422 the route already knows how to report.
 *
 * Deliberately no rate-limit retry, unlike src/github/fetch.ts — that one backs off with sleeps,
 * which is right for the seeder and wrong for anything a caller is waiting on.
 */
const FETCH_TIMEOUT_MS = 8000;

/**
 * Read GitHub's own explanation out of an error response.
 *
 * Every non-OK reply from the REST API carries a `message`, and it is usually the whole diagnosis:
 * a 403 for an org policy names the policy and links the setting to change. Returns undefined
 * rather than throwing for a body that is not the expected JSON — an error path must not be able
 * to fail on its way to being reported.
 */
async function readGitHubMessage(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === "string" && body.message ? body.message : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn a non-OK GitHub response into an error that says what went wrong.
 *
 * The status alone separates the cases a publisher can act on — 404 is a wrong path, 403 a
 * permission or policy refusal, 429 a rate limit — and they are indistinguishable once collapsed
 * to "could not fetch". `code` stays FETCH_FAILED so existing handling is unchanged; `status` is
 * added for callers that want to branch on it.
 */
async function githubFailure(response: Response, what: string) {
  const detail = await readGitHubMessage(response);
  return Object.assign(
    new Error(`GitHub returned ${response.status} for ${what}${detail ? `: ${detail}` : ""}`),
    { code: "FETCH_FAILED" as const, status: response.status }
  );
}

/**
 * Fetch one file's contents.
 *
 * Throws on a non-OK response rather than returning null, so the reason survives to the caller.
 * `readFile` maps that back to null to keep its own contract; the SKILLSET.md read lets it
 * propagate, because a publish that cannot read the manifest should say why.
 *
 * null is still returned for a 200 whose payload is not base64 content, which is a malformed
 * success rather than a failure and has no status to report.
 */
async function fetchFileContent(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  headers: Record<string, string>
): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) throw await githubFailure(response, path);

  const data = (await response.json()) as { content?: string; encoding?: string };

  if (data.content && data.encoding === "base64") {
    return Buffer.from(data.content, "base64").toString("utf-8");
  }

  return null;
}

/**
 * List every file in the skillset.
 *
 * Also throws on a non-OK response, and the reason to is stronger than for a single file: members
 * are discovered from this listing, so an empty one is not an error anywhere downstream. It is a
 * skillset that appears to have no members — it would validate, score, publish with zero members
 * and report coherence 0/0, all from a request that failed. Refusing is the only safe reading,
 * since a genuinely empty repository cannot produce a publishable skillset either.
 */
async function fetchDirectoryListing(
  owner: string,
  repo: string,
  ref: string,
  basePath: string,
  headers: Record<string, string>
): Promise<string[]> {
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const response = await fetch(treeUrl, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) throw await githubFailure(response, `the file listing for ${ref}`);

  const data = (await response.json()) as {
    tree: Array<{ path: string; type: string }>;
  };

  const prefix = basePath.replace(/\/$/, "");
  return data.tree
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
    .filter((path) => path !== "SKILLSET.md");
}

function extractFrontmatter(content: string): string | null {
  // \r? on both delimiters — see the note in ../validator/skillset.ts. A Windows-authored
  // SKILLSET.md would otherwise be rejected here with UNPROCESSABLE before it ever reached
  // the validator.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}

/**
 * Discover embedded skill names from the file listing.
 * An embedded skill is a depth-1 subdirectory that contains SKILL.md.
 */
function discoverEmbeddedSkills(files: string[]): string[] {
  const skills = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    // depth-1 subdir with SKILL.md: e.g. "memory-forensics/SKILL.md"
    if (parts.length === 2 && parts[1] === "SKILL.md") {
      skills.add(parts[0]);
    }
  }
  return Array.from(skills);
}
