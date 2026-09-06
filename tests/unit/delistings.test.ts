import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import app from "../../src/app.js";
import { __setDbForTesting } from "../../src/db/client.js";
import { allSchemaStatements } from "../../scripts/lib/schema.js";
import {
  DelistMatcher,
  applyDelisting,
  countMatching,
  listDelistings,
  loadDelistings,
  removeDelisting,
} from "../../src/db/delistings.js";

/**
 * Phase 7 — opt-out / takedown.
 *
 * The requirement these protect is "an inert flag is worse than none". Because a delisting
 * deletes the row rather than flagging it, the strongest evidence is negative: after a
 * takedown, the ordinary read paths must return nothing without anyone having taught them
 * about delistings.
 */

let db: Client;

async function insert(
  n: number,
  over: Partial<{ owner: string; name: string; repo: string }> = {}
) {
  const owner = over.owner ?? "acme";
  const repo = over.repo ?? "skills";
  await db.execute({
    sql: `INSERT INTO skills
            (id, name, owner, description, source_url, trust_tier, spec_version, source, score)
          VALUES (?,?,?,?,?,'community','1.0','imported',80)`,
    args: [
      `id-${n}`,
      over.name ?? `skill-${n}`,
      owner,
      `skill ${n}`,
      `https://github.com/${owner}/${repo}/tree/HEAD/skill-${n}`,
    ],
  });
}

beforeAll(async () => {
  db = createClient({ url: ":memory:" });
  for (const s of allSchemaStatements()) await db.execute(s);
  __setDbForTesting(db as any);
});

afterAll(() => {
  __setDbForTesting(null);
  db.close();
});

beforeEach(async () => {
  await db.execute("DELETE FROM skills");
  await db.execute("DELETE FROM delistings");
  await db.execute("DELETE FROM registry_stats");
});

describe("DelistMatcher", () => {
  it("matches each scope", () => {
    const m = new DelistMatcher([
      { scope: "owner", value: "evil" },
      { scope: "repo", value: "acme/private" },
      { scope: "skill", value: "acme/secret" },
    ]);

    expect(m.matches({ owner: "evil", name: "anything" })).toBe(true);
    expect(m.matches({ owner: "acme", repo: "acme/private", name: "x" })).toBe(true);
    expect(m.matches({ owner: "acme", name: "secret" })).toBe(true);
    expect(m.matches({ owner: "acme", repo: "acme/public", name: "fine" })).toBe(false);
  });

  it("is case-insensitive — GitHub treats Acme and acme as one account", () => {
    const m = new DelistMatcher([{ scope: "owner", value: "Evil" }]);
    expect(m.matches({ owner: "evil", name: "x" })).toBe(true);
    expect(m.matches({ owner: "EVIL", name: "x" })).toBe(true);
  });

  it("an empty matcher matches nothing", () => {
    expect(new DelistMatcher().matches({ owner: "anyone", name: "any" })).toBe(false);
  });
});

describe("applyDelisting", () => {
  it("owner scope removes every skill by that owner", async () => {
    for (let i = 0; i < 5; i++) await insert(i, { owner: "evil" });
    for (let i = 10; i < 13; i++) await insert(i, { owner: "innocent" });

    expect(await countMatching("owner", "evil", db)).toBe(5);
    const removed = await applyDelisting({ scope: "owner", value: "evil" }, db);

    expect(removed).toBe(5);
    expect(await countMatching("owner", "evil", db)).toBe(0);
    expect(await countMatching("owner", "innocent", db)).toBe(3);
  });

  it("repo scope matches on source_url without LIKE wildcards", async () => {
    // `_` is a LIKE single-character wildcard. A LIKE-based matcher would let a takedown for
    // "acme/my_repo" also delete "acme/myXrepo".
    await insert(1, { owner: "acme", repo: "my_repo" });
    await insert(2, { owner: "acme", repo: "myXrepo" });

    const removed = await applyDelisting({ scope: "repo", value: "acme/my_repo" }, db);
    expect(removed).toBe(1);

    const left = await db.execute("SELECT source_url FROM skills");
    expect(String(left.rows[0].source_url)).toContain("myXrepo");
  });

  it("skill scope removes exactly one", async () => {
    await insert(1, { owner: "acme", name: "keep" });
    await insert(2, { owner: "acme", name: "remove" });

    expect(await applyDelisting({ scope: "skill", value: "acme/remove" }, db)).toBe(1);
    const left = await db.execute("SELECT name FROM skills");
    expect(left.rows.map((r) => String(r.name))).toEqual(["keep"]);
  });

  it("records who asked and how many rows went", async () => {
    for (let i = 0; i < 4; i++) await insert(i, { owner: "evil" });
    await applyDelisting(
      { scope: "owner", value: "evil", reason: "author request", requested_by: "@evil" },
      db
    );

    const [d] = await listDelistings(db);
    expect(d).toMatchObject({
      scope: "owner",
      value: "evil",
      reason: "author request",
      requested_by: "@evil",
      removed: 4,
    });
  });

  it("is idempotent", async () => {
    for (let i = 0; i < 3; i++) await insert(i, { owner: "evil" });
    expect(await applyDelisting({ scope: "owner", value: "evil" }, db)).toBe(3);
    expect(await applyDelisting({ scope: "owner", value: "evil" }, db)).toBe(0);
    expect((await listDelistings(db)).length).toBe(1);
  });
});

describe("the read paths honour it without knowing about it", () => {
  it("a delisted skill disappears from search, detail and install", async () => {
    await insert(1, { owner: "evil", name: "gone" });
    await insert(2, { owner: "good", name: "stays" });

    expect((await (await app.request("/v1/skills")).json() as any).total).toBe(2);

    await applyDelisting({ scope: "owner", value: "evil" }, db);

    const search = (await (await app.request("/v1/skills")).json()) as any;
    expect(search.total).toBe(1);
    expect(search.skills.map((s: any) => s.owner)).toEqual(["good"]);

    expect((await app.request("/v1/skills/evil/gone")).status).toBe(404);
    expect((await app.request("/v1/skills/evil/gone/install")).status).toBe(404);
  });

  it("survives a re-seed: loadDelistings still reports the rule", async () => {
    await insert(1, { owner: "evil" });
    await applyDelisting({ scope: "owner", value: "evil" }, db);

    // What scripts/seed.ts and scripts/corpus/build.ts consult before inserting anything.
    const matcher = await loadDelistings(db);
    expect(matcher.size).toBe(1);
    expect(matcher.matches({ owner: "evil", name: "anything-at-all" })).toBe(true);
  });
});

describe("removeDelisting", () => {
  it("lifts the rule but does not restore the rows", async () => {
    for (let i = 0; i < 3; i++) await insert(i, { owner: "evil" });
    await applyDelisting({ scope: "owner", value: "evil" }, db);

    expect(await removeDelisting("owner", "evil", db)).toBe(true);
    expect((await listDelistings(db)).length).toBe(0);
    // Gone is gone — they come back only from source, on the next seed or corpus build.
    expect(await countMatching("owner", "evil", db)).toBe(0);
  });

  it("reports when there was nothing to lift", async () => {
    expect(await removeDelisting("owner", "nobody", db)).toBe(false);
  });
});
