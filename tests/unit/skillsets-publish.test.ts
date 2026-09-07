// POST/PATCH /skillsets — coherence storage and the guards around it.
//
// Skillsets enter the registry through this route and nowhere else: there is no skillset seeder,
// unlike skills. That makes it the only place coherence can be established, and the only place a
// wrong answer can get written.
//
// The case worth the most attention is a member whose SKILL.md cannot be fetched.
// checkSkillsetCoherence leaves such a member in the coherent set — correct for skilldex, where
// it means a file vanished mid-scan, but here the same path covers a failed GitHub request. A
// transient error that silently *raises* a number people sort by is the worst failure available,
// so the route fetches every member up front and refuses rather than scoring a partial view.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SkillsetMetadata } from "../../src/github/fetch-skillset.js";

const fetchSkillsetFromGitHub = vi.fn();
const createSkillset = vi.fn();
const getSkillsetByName = vi.fn();
const updateSkillset = vi.fn();

vi.mock("../../src/github/fetch-skillset.js", () => ({
  fetchSkillsetFromGitHub: (...a: unknown[]) => fetchSkillsetFromGitHub(...a),
}));

vi.mock("../../src/db/skillsets.js", () => ({
  createSkillset: (...a: unknown[]) => createSkillset(...a),
  getSkillsetByName: (...a: unknown[]) => getSkillsetByName(...a),
  updateSkillset: (...a: unknown[]) => updateSkillset(...a),
  deleteSkillset: vi.fn(),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (c: any, next: any) => {
    c.set("publisher", { id: "pub-1", github_handle: "testuser" });
    await next();
  },
}));

const lines = (...l: string[]) => l.join("\n");

const DESCRIPTION =
  "A development workflow skillset bundling commit, changelog and pull request skills that all " +
  "share one declared set of commit conventions, so every member of the bundle agrees on what a " +
  "commit type means and which changelog section it belongs in.";

const SKILLSET_MD = lines(
  "---",
  "name: devset",
  `description: "${DESCRIPTION}"`,
  'version: "1.0.0"',
  'spec_version: "1.0"',
  "---",
  "",
  "# devset",
  ""
);

const CONVENTIONS = lines(
  "```yaml skilldex-conventions",
  "commit-type-to-changelog-section:",
  "  feat: Added",
  "  fix: Fixed",
  "```",
  ""
);

const AGREES = lines(
  "Follow `../assets/conv.md`.",
  "",
  "| Type | Changelog section |",
  "| --- | --- |",
  "| `feat` | Added |",
  "| `fix` | Fixed |",
  ""
);

const CONTRADICTS = lines(
  "Follow `../assets/conv.md`.",
  "",
  "| Type | Changelog section |",
  "| --- | --- |",
  "| `feat` | Fixed |",
  "| `fix` | Added |",
  ""
);

/** Metadata as the GitHub fetcher would return it, backed by an in-memory blob map. */
function metadata(blobs: Record<string, string>, over: Partial<SkillsetMetadata> = {}) {
  const members = Object.keys(blobs)
    .filter((p) => p.endsWith("/SKILL.md"))
    .map((p) => p.split("/")[0]);

  const reads: string[] = [];
  const md: SkillsetMetadata = {
    name: "devset",
    description: DESCRIPTION,
    spec_version: "1.0",
    author: "testuser",
    skillsetMd: SKILLSET_MD,
    files: ["SKILLSET.md", ...Object.keys(blobs)],
    skillRefs: members.map((m) => ({ name: m, source_url: `https://github.com/t/r/tree/main/${m}` })),
    embeddedSkillNames: members,
    async readFile(p: string) {
      reads.push(p);
      return Object.prototype.hasOwnProperty.call(blobs, p) ? blobs[p] : null;
    },
    ...over,
  };
  return { md, reads };
}

const COHERENT_BLOBS = {
  "assets/conv.md": CONVENTIONS,
  "a/SKILL.md": AGREES,
  "b/SKILL.md": AGREES,
};

async function post(body: Record<string, unknown>) {
  const { skillsetsPublishRoutes } = await import("../../src/routes/skillsets-publish.js");
  const app = new Hono();
  app.route("/skillsets", skillsetsPublishRoutes);
  return app.request("/skillsets", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify(body),
  });
}

async function patch(name: string) {
  const { skillsetsPublishRoutes } = await import("../../src/routes/skillsets-publish.js");
  const app = new Hono();
  app.route("/skillsets", skillsetsPublishRoutes);
  return app.request(`/skillsets/${name}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: "{}",
  });
}

const VALID_BODY = {
  name: "devset",
  source_url: "https://github.com/testuser/skillsets/tree/main/devset",
};

beforeEach(() => {
  fetchSkillsetFromGitHub.mockReset();
  createSkillset.mockReset();
  getSkillsetByName.mockReset();
  updateSkillset.mockReset();

  getSkillsetByName.mockResolvedValue(null);

  // Stand in for the insert, emulating the generated columns the real table would fill.
  const materialise = (row: Record<string, unknown>) => ({
    id: "ss-1",
    author: null,
    tags: null,
    skill_count: (row.skill_refs as unknown[])?.length ?? 0,
    install_count: 0,
    published_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    published_by: "pub-1",
    ...row,
    coherence_pct:
      Number(row.members_checked) > 0
        ? Math.trunc((Number(row.members_coherent) * 100) / Number(row.members_checked))
        : null,
  });
  createSkillset.mockImplementation(async (row: Record<string, unknown>) => materialise(row));
  updateSkillset.mockImplementation(async (_n: string, row: Record<string, unknown>) =>
    materialise({ name: "devset", source_url: "https://github.com/t/r", trust_tier: "community", ...row })
  );
});

describe("POST /skillsets — coherence", () => {
  it("stores the counts and the full result, and returns the result to the publisher", async () => {
    const { md } = metadata(COHERENT_BLOBS);
    fetchSkillsetFromGitHub.mockResolvedValue(md);

    const res = await post(VALID_BODY);
    expect(res.status).toBe(201);

    const row = createSkillset.mock.calls[0][0];
    expect(row.members_checked).toBe(2);
    expect(row.members_coherent).toBe(2);
    expect(row.coherence.declaredConventions).toHaveLength(1);
    expect(row.coherence.errorCount).toBe(0);

    const body = (await res.json()) as any;
    // The stored summary is what search sorts on; the full result is what the publisher acts on.
    expect(body.skillset.coherence).toEqual({
      members_checked: 2,
      members_coherent: 2,
      pct: 100,
      pass_count: row.coherence.passCount,
      warn_count: 0,
      error_count: 0,
      declared_conventions: 1,
    });
    expect(body.coherence.diagnostics.length).toBeGreaterThan(0);
  });

  it("records a member that contradicts a declared convention as incoherent", async () => {
    const { md } = metadata({ ...COHERENT_BLOBS, "b/SKILL.md": CONTRADICTS });
    fetchSkillsetFromGitHub.mockResolvedValue(md);

    const res = await post(VALID_BODY);
    expect(res.status).toBe(201);

    const row = createSkillset.mock.calls[0][0];
    expect(row.members_checked).toBe(2);
    expect(row.members_coherent).toBe(1);
    expect(row.coherence.errorCount).toBeGreaterThan(0);

    const body = (await res.json()) as any;
    expect(body.skillset.coherence.pct).toBe(50);
  });

  it("stores the spec version this registry validates against, not the frontmatter's claim", async () => {
    const { md } = metadata(COHERENT_BLOBS, { spec_version: "1.0" });
    fetchSkillsetFromGitHub.mockResolvedValue(md);

    await post(VALID_BODY);

    expect(createSkillset.mock.calls[0][0].spec_version).toBe("1.1");
  });

  it("coherence does not move the conformance score", async () => {
    const good = metadata(COHERENT_BLOBS);
    fetchSkillsetFromGitHub.mockResolvedValue(good.md);
    await post(VALID_BODY);
    const clean = createSkillset.mock.calls[0][0].score;

    createSkillset.mockClear();

    const bad = metadata({ ...COHERENT_BLOBS, "b/SKILL.md": CONTRADICTS });
    fetchSkillsetFromGitHub.mockResolvedValue(bad.md);
    await post(VALID_BODY);
    const contradicting = createSkillset.mock.calls[0][0].score;

    expect(contradicting).toBe(clean);
  });

  it("refuses rather than scoring a skillset whose member could not be fetched", async () => {
    // Without the prefetch this publishes happily as 2/2 coherent, because an unreadable member
    // is skipped and never leaves the coherent set.
    const { md } = metadata({ "assets/conv.md": CONVENTIONS, "a/SKILL.md": AGREES });
    md.embeddedSkillNames = ["a", "b"]; // b is listed but its blob is missing
    md.files.push("b/SKILL.md");
    fetchSkillsetFromGitHub.mockResolvedValue(md);

    const res = await post(VALID_BODY);

    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.code).toBe("UNPROCESSABLE");
    expect(body.error).toContain("b");
    expect(createSkillset).not.toHaveBeenCalled();
  });

  it("refuses a skillset with more members than it will check", async () => {
    const { md } = metadata(COHERENT_BLOBS);
    md.embeddedSkillNames = Array.from({ length: 51 }, (_, i) => `m${i}`);
    fetchSkillsetFromGitHub.mockResolvedValue(md);

    const res = await post(VALID_BODY);

    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error).toContain("51");
    expect(createSkillset).not.toHaveBeenCalled();
  });

  it("fetches every member before checking, so the guard sees them all", async () => {
    const { md, reads } = metadata(COHERENT_BLOBS);
    fetchSkillsetFromGitHub.mockResolvedValue(md);

    await post(VALID_BODY);

    expect(reads).toContain("a/SKILL.md");
    expect(reads).toContain("b/SKILL.md");
  });
});

describe("PATCH /skillsets/:name — coherence", () => {
  beforeEach(() => {
    getSkillsetByName.mockResolvedValue({
      id: "ss-1",
      name: "devset",
      description: "old",
      source_url: "https://github.com/testuser/skillsets/tree/main/devset",
      spec_version: "1.0",
      published_by: "pub-1",
      members_checked: 2,
      members_coherent: 2,
      coherence: null,
      coherence_pct: 100,
    });
  });

  it("recomputes coherence rather than leaving a stale ratio behind", async () => {
    const { md } = metadata({ ...COHERENT_BLOBS, "b/SKILL.md": CONTRADICTS });
    fetchSkillsetFromGitHub.mockResolvedValue(md);

    const res = await patch("devset");
    expect(res.status).toBe(200);

    const updates = updateSkillset.mock.calls[0][1];
    expect(updates.members_coherent).toBe(1);
    expect(updates.spec_version).toBe("1.1");
    expect(updates.coherence.errorCount).toBeGreaterThan(0);
  });

  it("refuses a re-check it cannot complete, leaving the stored value untouched", async () => {
    const { md } = metadata({ "assets/conv.md": CONVENTIONS, "a/SKILL.md": AGREES });
    md.embeddedSkillNames = ["a", "b"];
    fetchSkillsetFromGitHub.mockResolvedValue(md);

    const res = await patch("devset");

    expect(res.status).toBe(422);
    expect(updateSkillset).not.toHaveBeenCalled();
  });
});

describe("skillsetRowToApi — coherence summary", () => {
  it("is null for a skillset published before coherence was recorded", async () => {
    const { skillsetRowToApi } = await import("../../src/types/skillset.js");

    const api = skillsetRowToApi({
      id: "x",
      name: "old",
      description: "d",
      author: null,
      source_url: "https://github.com/t/r",
      trust_tier: "community",
      score: 90,
      spec_version: "1.0",
      tags: null,
      skill_refs: [],
      skill_count: 0,
      install_count: 0,
      published_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      published_by: null,
      members_checked: null,
      members_coherent: null,
      coherence: null,
      coherence_pct: null,
    });

    expect(api.coherence).toBeNull();
  });
});
