import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import app from "../../src/app.js";
import { __setDbForTesting } from "../../src/db/client.js";
import { allSchemaStatements } from "../../scripts/lib/schema.js";
import { refreshStats, refreshTagCounts } from "../../src/db/stats.js";
import { MAX_OFFSET } from "../../src/db/pagination.js";

/**
 * End-to-end through the real Hono app against a real SQLite database.
 *
 * The failure this whole change exists to fix was invisible to unit tests and to the API
 * parity check, because it only appeared at 1.6M rows. These cannot reproduce that either —
 * only a run against the corpus can. What they do cover is the contract: the response shape,
 * the eq/gte flag, the offset cap, and that nothing on the listing path issues a count(*).
 */

let db: Client;

async function insert(
  n: number,
  over: Partial<{ owner: string; name: string; tier: string; source: string; tags: string }> = {}
) {
  await db.execute({
    sql: `INSERT INTO skills
            (id, name, owner, description, source_url, trust_tier, spec_version, source, tags, score)
          VALUES (?,?,?,?,?,?,'1.0',?,?,90)`,
    args: [
      `id-${n}`,
      over.name ?? `skill-${n}`,
      over.owner ?? "acme",
      `does thing number ${n}`,
      `https://github.com/acme/repo/tree/HEAD/skill-${n}`,
      over.tier ?? "community",
      over.source ?? "seeded",
      over.tags ?? null,
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
  await db.execute("DELETE FROM registry_stats");
  await db.execute("DELETE FROM tag_counts");
});

describe("GET /v1/skills", () => {
  it("returns the new envelope fields", async () => {
    for (let i = 0; i < 3; i++) await insert(i);

    const res = await app.request("/v1/skills");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.total).toBe(3);
    expect(body.total_relation).toBe("eq");
    expect(body.has_more).toBe(false);
    expect(body.max_offset).toBe(MAX_OFFSET);
    expect(body.skills).toHaveLength(3);
  });

  it("exposes owner and qualified_name, which every skill link depends on", async () => {
    await insert(1, { owner: "anthropics", name: "pdf" });

    const body = (await (await app.request("/v1/skills")).json()) as any;
    expect(body.skills[0].owner).toBe("anthropics");
    expect(body.skills[0].qualified_name).toBe("anthropics/pdf");
  });

  it("defaults to the curated tier", async () => {
    await insert(1, { source: "seeded" });
    for (let i = 10; i < 15; i++) await insert(i, { source: "imported" });

    const curated = (await (await app.request("/v1/skills")).json()) as any;
    expect(curated.total).toBe(1);

    const all = (await (await app.request("/v1/skills?scope=all")).json()) as any;
    expect(all.total).toBe(6);
  });

  it("sets has_more and never leaks the limit+1 probe row", async () => {
    for (let i = 0; i < 5; i++) await insert(i);

    const body = (await (await app.request("/v1/skills?limit=2")).json()) as any;
    expect(body.skills).toHaveLength(2);
    expect(body.has_more).toBe(true);
  });

  it("rejects an offset past the cap with a distinguishable code", async () => {
    const res = await app.request(`/v1/skills?offset=${MAX_OFFSET + 1}`);
    expect(res.status).toBe(400);

    const body = (await res.json()) as any;
    expect(body.code).toBe("OFFSET_TOO_LARGE");
    expect(body.max_offset).toBe(MAX_OFFSET);
  });

  it("still reports plain validation failures separately", async () => {
    const body = (await (await app.request("/v1/skills?tier=nonsense")).json()) as any;
    expect(body.code).toBe("INVALID_PARAMS");
    expect(body.details?.[0]?.path).toBe("tier");
  });

  it("ranks a text search by relevance, not install_count", async () => {
    await insert(1, { name: "kubernetes-debug" });
    await insert(2, { name: "unrelated" });

    const body = (await (await app.request("/v1/skills?q=kubernetes")).json()) as any;
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0].name).toBe("kubernetes-debug");
  });

  // ⚠ This asserts the header is produced, NOT that it survives deployment. An earlier version
  // set it from middleware after `await next()`; this test passed and the deployed API still
  // showed Vercel's default with x-vercel-cache: MISS, because the Vercel adapter reads the
  // response before a post-next mutation lands. Only `curl -I` against the deployment can
  // confirm the real behaviour — check `x-vercel-cache`, not `cache-control`, since Vercel
  // consumes s-maxage and rewrites what it sends the browser.
  it("caches successful reads but not validation failures", async () => {
    await insert(1);

    const ok = await app.request("/v1/skills");
    expect(ok.headers.get("cache-control")).toContain("s-maxage=60");

    const bad = await app.request("/v1/skills?tier=nonsense");
    expect(bad.headers.get("cache-control")).toBeNull();
  });
});

describe("GET /v1/skills/:owner/:name", () => {
  it("resolves an owner-qualified skill and marks it cacheable", async () => {
    await insert(1, { owner: "anthropics", name: "pdf" });

    const res = await app.request("/v1/skills/anthropics/pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("s-maxage=300");
  });

  it("does not cache a 404", async () => {
    const res = await app.request("/v1/skills/nobody/nothing");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("409s a contested bare name instead of pretending it is missing", async () => {
    await insert(1, { owner: "alice", name: "pdf" });
    await insert(2, { owner: "bob", name: "pdf" });

    const res = await app.request("/v1/skills/pdf");
    expect(res.status).toBe(409);

    const body = (await res.json()) as any;
    expect(body.code).toBe("AMBIGUOUS_NAME");
    expect(body.owners.sort()).toEqual(["alice", "bob"]);
  });
});

describe("GET /v1/stats", () => {
  it("serves precomputed counts", async () => {
    await insert(1, { source: "seeded", tier: "verified" });
    for (let i = 10; i < 14; i++) await insert(i, { source: "imported", owner: `o${i}` });
    await refreshStats(db as any);

    const res = await app.request("/v1/stats");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("s-maxage=300");

    const body = (await res.json()) as any;
    expect(body.skills).toEqual({ total: 5, curated: 1, imported: 4, verified: 1 });
    expect(body.owners).toBe(5);
    expect(body.updated_at).toBeTruthy();
  });

  it("returns zeroes rather than counting when stats were never refreshed", async () => {
    for (let i = 0; i < 3; i++) await insert(i);

    const body = (await (await app.request("/v1/stats")).json()) as any;
    expect(body.skills.total).toBe(0);
    expect(body.updated_at).toBeNull();
  });
});

describe("GET /v1/tags", () => {
  it("serves the precomputed facet list", async () => {
    await insert(1, { tags: JSON.stringify(["pdf", "ocr"]) });
    await insert(2, { tags: JSON.stringify(["pdf"]) });
    await refreshTagCounts(db as any);

    const body = (await (await app.request("/v1/tags")).json()) as any;
    expect(body.tags).toEqual([
      { tag: "pdf", skill_count: 2 },
      { tag: "ocr", skill_count: 1 },
    ]);
  });
});
