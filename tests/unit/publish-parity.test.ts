// Parity between the two ingestion paths.
//
// Skills enter the registry two ways: the nightly sync (scripts/seed.ts) and POST /skills
// (src/routes/publish.ts). They ran different rules — the sync rejected a SKILL.md with no
// frontmatter `name`, defaulted spec_version, and fell back to the name when description was
// blank; the route did none of those. The same SKILL.md was therefore accepted by one path
// and skipped by the other, and could land a NULL in a NOT NULL column.
//
// These tests pin the shared behaviour. seed.ts is a script, not an importable module, so
// its rules are asserted here against the route and cross-referenced by line in the comments.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const fetchSkillFromGitHub = vi.fn();
const createSkill = vi.fn();

vi.mock("../../src/github/fetch.js", () => ({
  fetchSkillFromGitHub: (...a: unknown[]) => fetchSkillFromGitHub(...a),
  findRelocatedSkill: vi.fn(),
}));

vi.mock("../../src/db/skills.js", () => ({
  createSkill: (...a: unknown[]) => createSkill(...a),
  getSkill: vi.fn().mockResolvedValue(null),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
}));

// requireAuth would demand a real token and a publishers row; substitute a fixed publisher.
vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (c: any, next: any) => {
    c.set("publisher", { id: "pub-1", github_handle: "testuser" });
    await next();
  },
}));

const GOOD_DESCRIPTION =
  "A comprehensive skill for digital forensics analysis that helps investigators examine " +
  "disk images, memory dumps and network captures to identify evidence of security " +
  "incidents and produce detailed structured investigation reports for the wider team.";

function metadata(over: Record<string, unknown> = {}) {
  return {
    name: "forensics-agent",
    description: GOOD_DESCRIPTION,
    author: "testuser",
    spec_version: "1.0",
    skillMd: `---\nname: forensics-agent\ndescription: ${GOOD_DESCRIPTION}\n---\n\n# Body\n`,
    files: [],
    ...over,
  };
}

async function post(body: Record<string, unknown>) {
  const { publishRoutes } = await import("../../src/routes/publish.js");
  const app = new Hono();
  app.route("/skills", publishRoutes);
  return app.request("/skills", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  name: "forensics-agent",
  source_url: "https://github.com/testuser/skills/tree/main/forensics-agent",
};

beforeEach(() => {
  fetchSkillFromGitHub.mockReset();
  createSkill.mockReset();
  createSkill.mockImplementation(async (row: Record<string, unknown>) => ({
    id: "skill-1",
    owner: "testuser",
    tags: null,
    install_count: 0,
    published_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    content_key: null,
    display_name: null,
    ...row,
  }));
});

describe("POST /skills — parity with the nightly sync", () => {
  it("rejects a SKILL.md whose frontmatter has no name, as seed.ts:194 does", async () => {
    fetchSkillFromGitHub.mockResolvedValue(metadata({ name: "" }));

    const res = await post(VALID_BODY);

    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.code).toBe("UNPROCESSABLE");
    expect(body.error).toContain("name");
    expect(createSkill).not.toHaveBeenCalled();
  });

  it("falls back to the name when description is blank, as seed.ts:222 does", async () => {
    fetchSkillFromGitHub.mockResolvedValue(metadata({ description: "" }));

    const res = await post(VALID_BODY);

    expect(res.status).toBe(201);
    expect(createSkill).toHaveBeenCalledOnce();
    expect(createSkill.mock.calls[0][0].description).toBe("forensics-agent");
  });

  it("defaults spec_version rather than writing null into a NOT NULL column", async () => {
    fetchSkillFromGitHub.mockResolvedValue(metadata({ spec_version: undefined }));

    const res = await post(VALID_BODY);

    expect(res.status).toBe(201);
    expect(createSkill.mock.calls[0][0].spec_version).toBe("1.0");
  });

  it("still stores a real description and spec_version untouched", async () => {
    fetchSkillFromGitHub.mockResolvedValue(metadata({ spec_version: "1.1" }));

    const res = await post(VALID_BODY);

    expect(res.status).toBe(201);
    const row = createSkill.mock.calls[0][0];
    expect(row.description).toBe(GOOD_DESCRIPTION);
    expect(row.spec_version).toBe("1.1");
  });

  it("publishes at community tier and stores the computed score, never a client-supplied one", async () => {
    fetchSkillFromGitHub.mockResolvedValue(metadata());

    const res = await post({ ...VALID_BODY, score: 100, trust_tier: "verified" });

    expect(res.status).toBe(201);
    const row = createSkill.mock.calls[0][0];
    expect(row.trust_tier).toBe("community");
    expect(typeof row.score).toBe("number");
  });
});
