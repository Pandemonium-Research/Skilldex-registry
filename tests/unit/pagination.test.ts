import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { __setDbForTesting } from "../../src/db/client.js";
import { allSchemaStatements } from "../../scripts/lib/schema.js";
import { searchSkills } from "../../src/db/skills.js";
import { refreshStats, refreshTagCounts, readTagCounts } from "../../src/db/stats.js";
import {
  interpretCount,
  takePage,
  __setCountCapForTesting,
  MAX_OFFSET,
  DEFAULT_COUNT_CAP,
} from "../../src/db/pagination.js";
import { searchSkillsSchema } from "../../src/types/skill.js";

let db: Client;

/** Minimal valid row. `source` defaults to 'seeded', i.e. the curated tier. */
async function insertSkill(
  n: number,
  over: Partial<{ owner: string; tier: string; source: string; tags: string; installs: number }> = {}
) {
  await db.execute({
    sql: `INSERT INTO skills
            (id, name, owner, description, source_url, trust_tier, spec_version,
             source, tags, install_count, score)
          VALUES (?,?,?,?,?,?,'1.0',?,?,?,80)`,
    args: [
      `id-${n}`,
      `skill-${n}`,
      over.owner ?? "acme",
      `description for skill ${n}`,
      `https://github.com/acme/repo/tree/HEAD/skill-${n}`,
      over.tier ?? "community",
      over.source ?? "seeded",
      over.tags ?? null,
      over.installs ?? 0,
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

const query = (over: Record<string, unknown> = {}) => searchSkillsSchema.parse(over);

describe("interpretCount", () => {
  it("reports an exact total below the cap", () => {
    const restore = __setCountCapForTesting(5);
    expect(interpretCount(3)).toEqual({ total: 3, total_relation: "eq" });
    restore();
  });

  it("reports the cap exactly as eq, not gte", () => {
    // cap+1 is what the bounded count returns when there is more; cap itself is exact.
    const restore = __setCountCapForTesting(5);
    expect(interpretCount(5)).toEqual({ total: 5, total_relation: "eq" });
    restore();
  });

  it("clamps to the cap and reports gte when the count overflows", () => {
    const restore = __setCountCapForTesting(5);
    expect(interpretCount(6)).toEqual({ total: 5, total_relation: "gte" });
    restore();
  });
});

describe("takePage", () => {
  it("has_more is false when exactly `limit` rows come back", () => {
    expect(takePage([1, 2, 3], 3)).toEqual({ page: [1, 2, 3], has_more: false });
  });

  it("has_more is true at limit + 1, and the extra row is not exposed", () => {
    expect(takePage([1, 2, 3, 4], 3)).toEqual({ page: [1, 2, 3], has_more: true });
  });
});

describe("offset cap", () => {
  it("MAX_OFFSET equals the count cap — otherwise the API contradicts itself", () => {
    expect(MAX_OFFSET).toBe(DEFAULT_COUNT_CAP);
  });

  it("rejects an offset past the cap", () => {
    const r = searchSkillsSchema.safeParse({ offset: String(MAX_OFFSET + 1) });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path[0]).toBe("offset");
  });

  it("accepts the cap itself", () => {
    expect(searchSkillsSchema.safeParse({ offset: String(MAX_OFFSET) }).success).toBe(true);
  });
});

describe("searchSkills — counting", () => {
  it("returns an exact small total for a filtered query", async () => {
    for (let i = 0; i < 5; i++) await insertSkill(i, { tier: "verified" });
    for (let i = 5; i < 20; i++) await insertSkill(i, { tier: "community" });

    const r = await searchSkills(query({ tier: "verified" }));
    expect(r.total).toBe(5);
    expect(r.total_relation).toBe("eq");
    expect(r.skills).toHaveLength(5);
    expect(r.has_more).toBe(false);
  });

  it("flips to gte once matches exceed the cap", async () => {
    for (let i = 0; i < 8; i++) await insertSkill(i);
    const restore = __setCountCapForTesting(5);
    try {
      const r = await searchSkills(query({ limit: "3" }));
      expect(r.total).toBe(5);
      expect(r.total_relation).toBe("gte");
      expect(r.skills).toHaveLength(3);
      expect(r.has_more).toBe(true);
    } finally {
      restore();
    }
  });

  it("sets has_more exactly at the page boundary", async () => {
    for (let i = 0; i < 4; i++) await insertSkill(i);

    expect((await searchSkills(query({ limit: "4" }))).has_more).toBe(false);
    expect((await searchSkills(query({ limit: "3" }))).has_more).toBe(true);
  });
});

describe("searchSkills — provenance filter", () => {
  beforeEach(async () => {
    for (let i = 0; i < 3; i++) await insertSkill(i, { source: "seeded" });
    for (let i = 10; i < 20; i++) await insertSkill(i, { source: "imported" });
  });

  it("searches the whole registry by default", async () => {
    // Not the seeded tier. Defaulting to it would hide 99.7% of the registry from search,
    // which is the opposite of why the corpus was imported.
    const r = await searchSkills(query({}));
    expect(r.total).toBe(13);
    expect(r.total_relation).toBe("eq");
  });

  it("source=seeded narrows to the watched repos", async () => {
    const r = await searchSkills(query({ source: "seeded" }));
    expect(r.total).toBe(3);
  });

  it("source=imported narrows to the corpus", async () => {
    const r = await searchSkills(query({ source: "imported" }));
    expect(r.total).toBe(10);
  });

  it("an unfiltered search reads the precomputed stat rather than counting", async () => {
    await refreshStats(db as any);
    // A deliberately wrong stat proves the value came from registry_stats and not a count.
    await db.execute({
      sql: "UPDATE registry_stats SET value = ? WHERE key = 'skills_total'",
      args: [999_999],
    });

    const r = await searchSkills(query({}));
    expect(r.total).toBe(999_999);
    expect(r.total_relation).toBe("eq");
  });

  it("falls back to a bounded count when the stat row is missing", async () => {
    // No refreshStats() — registry_stats is empty. Must degrade to the real count, never to
    // count(*), and never throw.
    const r = await searchSkills(query({}));
    expect(r.total).toBe(13);
    expect(r.total_relation).toBe("eq");
  });
});

describe("stats", () => {
  it("computes each tier separately", async () => {
    for (let i = 0; i < 3; i++) await insertSkill(i, { source: "seeded", tier: "verified" });
    for (let i = 10; i < 17; i++) await insertSkill(i, { source: "imported", owner: `o${i}` });

    const s = await refreshStats(db as any);
    expect(s.skills_total).toBe(10);
    expect(s.skills_curated).toBe(3);
    expect(s.skills_imported).toBe(7);
    expect(s.skills_verified).toBe(3);
    expect(s.owners_total).toBe(8); // "acme" + o10..o16
  });

  it("aggregates tags from the curated tier only", async () => {
    await insertSkill(1, { source: "seeded", tags: JSON.stringify(["pdf", "data"]) });
    await insertSkill(2, { source: "seeded", tags: JSON.stringify(["pdf"]) });
    await insertSkill(3, { source: "imported", tags: JSON.stringify(["ignored"]) });

    await refreshTagCounts(db as any);
    const tags = await readTagCounts(db as any);

    expect(tags).toEqual([
      { tag: "pdf", skill_count: 2 },
      { tag: "data", skill_count: 1 },
    ]);
  });
});
