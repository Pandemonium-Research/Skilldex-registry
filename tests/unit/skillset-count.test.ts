// Keeping `skillsets_total` true after a publish.
//
// The count is precomputed because `count(*)` over the 1.6M-row skills table took >90s on a
// request path. Nothing about that reasoning applies to `skillsets`, but the key was written only
// by the nightly seeder, so between runs it was simply wrong — and with the seeder paused,
// permanently so.
//
// It is not merely a headline figure. searchSkillsets reads it as the pagination `total` for any
// unfiltered listing and labels it `total_relation: "eq"`, so a stale value is an exact-looking
// lie. Publishing the three official skillsets left /v1/skillsets returning three rows above a
// total of 0, which any UI renders as "0 skillsets" over a list of three.
//
// These tests run against the real schema, because what is being asserted is a row in
// registry_stats and the listing that reads it — neither of which a mocked db layer would have.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createClient, type Client } from "@libsql/client";
import { allSchemaStatements } from "../../scripts/lib/schema.js";
import { __setDbForTesting } from "../../src/db/client.js";
import { readStats, refreshSkillsetCount } from "../../src/db/stats.js";
import { searchSkillsets } from "../../src/db/skillsets.js";
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

const MEMBER = lines("Follow `../assets/conv.md`.", "");

function metadata(name: string): SkillsetMetadata {
  const blobs: Record<string, string> = {
    "assets/conv.md": "# conventions\n",
    "a/SKILL.md": MEMBER,
  };
  return {
    name,
    description: DESCRIPTION,
    spec_version: "1.0",
    author: "testuser",
    skillsetMd: SKILLSET_MD.replace("name: devset", `name: ${name}`),
    files: Object.keys(blobs),
    skillRefs: [{ name: "a", source_url: `https://github.com/testuser/sets/tree/main/${name}/a` }],
    embeddedSkillNames: ["a"],
    async readFile(p: string) {
      return Object.prototype.hasOwnProperty.call(blobs, p) ? blobs[p] : null;
    },
  };
}

let db: Client;

beforeEach(async () => {
  db = createClient({ url: ":memory:" });
  for (const stmt of allSchemaStatements()) await db.execute(stmt);
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

async function app() {
  const { skillsetsPublishRoutes } = await import("../../src/routes/skillsets-publish.js");
  const a = new Hono();
  a.route("/skillsets", skillsetsPublishRoutes);
  return a;
}

async function publish(name: string) {
  fetchSkillsetFromGitHub.mockResolvedValue(metadata(name));
  return (await app()).request("/skillsets", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify({
      name,
      source_url: `https://github.com/testuser/sets/tree/main/${name}`,
    }),
  });
}

async function unpublish(name: string) {
  return (await app()).request(`/skillsets/${name}`, {
    method: "DELETE",
    headers: { authorization: "Bearer test" },
  });
}

const storedCount = async () => {
  const r = await db.execute("SELECT value FROM registry_stats WHERE key = 'skillsets_total'");
  return r.rows.length ? Number(r.rows[0].value) : null;
};

describe("skillsets_total after a write", () => {
  it("is written on publish, where nothing wrote it before", async () => {
    expect(await storedCount()).toBeNull();

    expect((await publish("devset")).status).toBe(201);

    expect(await storedCount()).toBe(1);
  });

  it("is what the unfiltered listing reports as its total", async () => {
    // The reason this matters. searchSkillsets trusts the stat for an unfiltered page and calls
    // the result exact, so the bug surfaced as three rows above a total of 0.
    await publish("devset");
    await publish("otherset");

    const page = await searchSkillsets({ limit: 20, offset: 0 } as any);

    expect(page.skillsets).toHaveLength(2);
    expect(page.total).toBe(2);
    expect(page.total_relation).toBe("eq");
  });

  it("comes back down on delete", async () => {
    await publish("devset");
    await publish("otherset");
    expect(await storedCount()).toBe(2);

    expect((await unpublish("devset")).status).toBe(200);

    expect(await storedCount()).toBe(1);
  });

  it("recounts rather than increments, so a drifted value heals", async () => {
    // The argument for a recount. Something wrote a wrong number — a missed call site, a manual
    // edit, a delete that bypassed the API — and the next publish must correct it, not add to it.
    await db.execute(
      "INSERT OR REPLACE INTO registry_stats (key, value, updated_at) VALUES ('skillsets_total', 47, '2020-01-01T00:00:00.000Z')"
    );

    await publish("devset");

    expect(await storedCount()).toBe(1);
  });

  it("does not fail the publish when the count cannot be written", async () => {
    // The row is committed before the stat is touched, so a stats failure must not report a
    // publish that succeeded as a 500. Dropping the table reproduces a real case: migration 002
    // never applied to this database.
    await db.execute("DROP TABLE registry_stats");

    const res = await publish("devset");

    expect(res.status).toBe(201);
    const rows = await db.execute("SELECT name FROM skillsets");
    expect(rows.rows).toHaveLength(1);
  });
});

describe("how stale /v1/stats admits to being", () => {
  it("reports the oldest timestamp, not the newest", async () => {
    // updated_at exists so a reader can judge these numbers. Once a publish freshens one key on
    // its own, taking the newest would let a single publish present nightly skills counts as if
    // they had just been recomputed — backwards for a field whose purpose is showing staleness.
    await db.batch(
      [
        {
          sql: "INSERT OR REPLACE INTO registry_stats (key, value, updated_at) VALUES (?, ?, ?)",
          args: ["skills_total", 1615322, "2026-09-06T17:43:35.882Z"],
        },
        {
          sql: "INSERT OR REPLACE INTO registry_stats (key, value, updated_at) VALUES (?, ?, ?)",
          args: ["skillsets_total", 3, "2026-09-09T10:00:00.000Z"],
        },
      ],
      "write"
    );

    const stats = await readStats();

    expect(stats.updated_at).toBe("2026-09-06T17:43:35.882Z");
    expect(stats.values.skills_total).toBe(1615322);
    expect(stats.values.skillsets_total).toBe(3);
  });

  it("is refreshed by refreshSkillsetCount without touching the other keys", async () => {
    // Only skillsets_total may be rewritten here: refreshStats() also recomputes
    // count(DISTINCT owner), which is minutes at corpus scale and must never run on a request.
    await db.execute(
      "INSERT OR REPLACE INTO registry_stats (key, value, updated_at) VALUES ('skills_total', 1615322, '2026-09-06T17:43:35.882Z')"
    );

    await refreshSkillsetCount();

    const r = await db.execute("SELECT key, value, updated_at FROM registry_stats ORDER BY key");
    const byKey = Object.fromEntries(r.rows.map((row) => [String(row.key), row]));

    expect(Number(byKey.skills_total.value)).toBe(1615322);
    expect(String(byKey.skills_total.updated_at)).toBe("2026-09-06T17:43:35.882Z");
    expect(Number(byKey.skillsets_total.value)).toBe(0);
  });
});
