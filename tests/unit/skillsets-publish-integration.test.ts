// POST /skillsets against a real database.
//
// Every other test of this path stops at a boundary. The route tests mock the db layer, so they
// prove the right values are passed but not that a table exists to receive them. The schema tests
// run real SQL, but never through the route. Between those two sits the join nobody exercises:
// route -> validator -> coherence -> createSkillset -> SQL -> row mapper -> API DTO.
//
// That gap is where a wrong column name, a JSON value the CHECK rejects, or a generated column
// read back as a string would survive both suites and fail on the first real publish. Here the
// only things stubbed are the network and the auth check; the database is real, built from the
// migration files themselves.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createClient, type Client } from "@libsql/client";
import { allSchemaStatements } from "../../scripts/lib/schema.js";
import { __setDbForTesting } from "../../src/db/client.js";
import type { SkillsetMetadata } from "../../src/github/fetch-skillset.js";

const fetchSkillsetFromGitHub = vi.fn();

vi.mock("../../src/github/fetch-skillset.js", () => ({
  fetchSkillsetFromGitHub: (...a: unknown[]) => fetchSkillsetFromGitHub(...a),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (c: any, next: any) => {
    c.set("publisher", { id: "pub-1", github_handle: "testuser" });
    await next();
  },
}));

const lines = (...l: string[]) => l.join("\n");

const DESCRIPTION =
  "A development workflow skillset bundling commit and changelog skills that share one declared " +
  "set of commit conventions, so every member agrees on what a commit type means and which " +
  "changelog section it belongs in when the tools are used together.";

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

const CONTRADICTS = AGREES.replace("| `feat` | Added |", "| `feat` | Fixed |");

function metadata(blobs: Record<string, string>): SkillsetMetadata {
  const members = Object.keys(blobs)
    .filter((p) => p.endsWith("/SKILL.md"))
    .map((p) => p.split("/")[0]);

  return {
    name: "devset",
    description: DESCRIPTION,
    spec_version: "1.0",
    author: "testuser",
    skillsetMd: SKILLSET_MD,
    // Production strips SKILLSET.md from the listing; mirror that rather than the corpus shape.
    files: Object.keys(blobs),
    skillRefs: members.map((m) => ({
      name: m,
      source_url: `https://github.com/testuser/sets/tree/main/devset/${m}`,
    })),
    embeddedSkillNames: members,
    async readFile(p: string) {
      return Object.prototype.hasOwnProperty.call(blobs, p) ? blobs[p] : null;
    },
  };
}

const COHERENT = {
  "assets/conv.md": CONVENTIONS,
  "a/SKILL.md": AGREES,
  "b/SKILL.md": AGREES,
};

let db: Client;

beforeEach(async () => {
  db = createClient({ url: ":memory:" });
  for (const stmt of allSchemaStatements()) await db.execute(stmt);
  // published_by is a real foreign key; give it something to point at.
  await db.execute({
    sql: "INSERT INTO publishers (id, github_handle) VALUES (?, ?)",
    args: ["pub-1", "testuser"],
  });
  __setDbForTesting(db);
  fetchSkillsetFromGitHub.mockReset();
});

afterEach(() => {
  __setDbForTesting(null);
});

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

const BODY = {
  name: "devset",
  source_url: "https://github.com/testuser/sets/tree/main/devset",
};

describe("publishing a skillset end to end", () => {
  it("writes coherence through the real schema and reads it back", async () => {
    fetchSkillsetFromGitHub.mockResolvedValue(metadata(COHERENT));

    const res = await post(BODY);
    expect(res.status).toBe(201);

    // What the database actually holds, including the generated column the app never writes.
    const row = await db.execute("SELECT * FROM skillsets WHERE name = 'devset'");
    expect(row.rows).toHaveLength(1);
    expect(Number(row.rows[0].members_checked)).toBe(2);
    expect(Number(row.rows[0].members_coherent)).toBe(2);
    expect(Number(row.rows[0].coherence_pct)).toBe(100);
    expect(String(row.rows[0].spec_version)).toBe("1.1");
    expect(JSON.parse(String(row.rows[0].coherence)).declaredConventions).toHaveLength(1);

    // And what a client sees, back through the row mapper and the DTO.
    const body = (await res.json()) as any;
    expect(body.skillset.coherence).toMatchObject({
      members_checked: 2,
      members_coherent: 2,
      pct: 100,
      error_count: 0,
      declared_conventions: 1,
    });
  });

  it("survives the round trip through getSkillsetByName, not just the insert", async () => {
    // The insert returns its own row; a later read goes through toSkillsetRow on a fresh SELECT,
    // which is where a JSON column parsed wrongly or a numeric read as text would show up.
    fetchSkillsetFromGitHub.mockResolvedValue(metadata({ ...COHERENT, "b/SKILL.md": CONTRADICTS }));
    await post(BODY);

    const { getSkillsetByName } = await import("../../src/db/skillsets.js");
    const stored = await getSkillsetByName("devset");

    expect(stored?.members_checked).toBe(2);
    expect(stored?.members_coherent).toBe(1);
    expect(stored?.coherence_pct).toBe(50);
    expect(typeof stored?.coherence).toBe("object");
    expect(stored?.coherence?.errorCount).toBeGreaterThan(0);
    // The contradiction is preserved in full, not flattened to a count.
    expect(stored?.coherence?.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("is sortable and filterable by coherence once stored", async () => {
    fetchSkillsetFromGitHub.mockResolvedValue(metadata({ ...COHERENT, "b/SKILL.md": CONTRADICTS }));
    await post(BODY);

    fetchSkillsetFromGitHub.mockResolvedValue(metadata(COHERENT));
    await post({ ...BODY, name: "cleanset" });

    const { searchSkillsets } = await import("../../src/db/skillsets.js");

    const ranked = await searchSkillsets({ sort: "coherence", limit: 20, offset: 0 } as any);
    expect(ranked.skillsets.map((s) => s.name)).toEqual(["cleanset", "devset"]);

    const filtered = await searchSkillsets({ min_coherence: 75, limit: 20, offset: 0 } as any);
    expect(filtered.skillsets.map((s) => s.name)).toEqual(["cleanset"]);
  });

  it("updates coherence in place when the source is re-fetched", async () => {
    // updateSkillset builds its SET clause by iterating the keys it is handed, so a column named
    // there but absent from the schema fails only at execute time — and only on PATCH, which the
    // POST path above would never reach.
    fetchSkillsetFromGitHub.mockResolvedValue(metadata(COHERENT));
    await post(BODY);

    const { skillsetsPublishRoutes } = await import("../../src/routes/skillsets-publish.js");
    const app = new Hono();
    app.route("/skillsets", skillsetsPublishRoutes);

    // The members have since drifted apart in the source repository.
    fetchSkillsetFromGitHub.mockResolvedValue(metadata({ ...COHERENT, "b/SKILL.md": CONTRADICTS }));
    const res = await app.request("/skillsets/devset", {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: "{}",
    });

    expect(res.status).toBe(200);

    const row = await db.execute("SELECT * FROM skillsets WHERE name = 'devset'");
    expect(Number(row.rows[0].members_coherent)).toBe(1);
    expect(Number(row.rows[0].coherence_pct)).toBe(50);
    expect(JSON.parse(String(row.rows[0].coherence)).errorCount).toBeGreaterThan(0);
  });

  it("writes nothing when a member cannot be fetched", async () => {
    const md = metadata({ "assets/conv.md": CONVENTIONS, "a/SKILL.md": AGREES });
    md.embeddedSkillNames = ["a", "b"];
    fetchSkillsetFromGitHub.mockResolvedValue(md);

    const res = await post(BODY);

    expect(res.status).toBe(422);
    const rows = await db.execute("SELECT count(*) AS n FROM skillsets");
    expect(Number(rows.rows[0].n)).toBe(0);
  });
});
