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

  // Fetch SKILLSET.md content
  const skillsetMdPath = `${basePath}SKILLSET.md`;
  const skillsetMdContent = await fetchFileContent(owner, repo, ref, skillsetMdPath, headers);

  if (!skillsetMdContent) {
    throw Object.assign(
      new Error(`Could not fetch SKILLSET.md from ${sourceUrl}`),
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

async function fetchFileContent(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  headers: Record<string, string>
): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
  const response = await fetch(url, { headers });

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
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const response = await fetch(treeUrl, { headers });

  if (!response.ok) return [];

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
