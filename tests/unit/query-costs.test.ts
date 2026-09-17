import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, type Client, type InStatement } from "@libsql/client";
import app from "../../src/app.js";
import { __setDbForTesting } from "../../src/db/client.js";
import { allSchemaStatements, isTriggerDdl } from "../../scripts/lib/schema.js";
import { searchSkills } from "../../src/db/skills.js";
import { refreshStats } from "../../src/db/stats.js";
import { searchSkillsSchema } from "../../src/types/skill.js";

/**
 * What each query costs, pinned by its plan rather than by a timing.
 *
 * Turso bills every row a statement scans. At 1.6M rows the shapes fixed in D26–D29 cost millions of
 * rows per request and used the account's monthly read quota in nine days (FINDINGS §16). A test
 * database cannot reproduce that volume, but it does not need to: without sqlite_stat1 — which
 * neither this database nor production has — SQLite plans against the same default size estimates
 * whatever a table holds, so the access path chosen here is the one production gets.
 *
 * Every shape change is also checked against the SQL it replaced, on data where the two could
 * disagree, so a cheaper plan cannot quietly return different rows.
 */

let db: Client;
let captured: InStatement[] = [];

/** The real client, recording every statement the code under test sends. */
function recording(inner: Client): Client {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "batch") {
        return (stmts: InStatement[], mode?: any) => {
          captured.push(...stmts);
          return target.batch(stmts, mode);
        };
      }
      if (prop === "execute") {
        return (stmt: InStatement, args?: any) => {
          captured.push(typeof stmt === "string" && args ? { sql: stmt, args } : stmt);
          return (target.execute as any)(stmt, args);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const query = (over: Record<string, unknown> = {}) => searchSkillsSchema.parse(over);

const asStmt = (s: InStatement) => (typeof s === "string" ? { sql: s, args: [] as any[] } : s);

async function planOf(stmt: InStatement): Promise<string> {
  const { sql, args } = asStmt(stmt);
  const r = await db.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args: args as any });
  return r.rows.map((row) => String(row.detail)).join("\n");
}

/** Run a search, returning its result and the page and count statements it issued. */
async function traced(over: Record<string, unknown>) {
  captured = [];
  const result = await searchSkills(query(over));
  const [page, count] = captured;
  return { result, page: asStmt(page), count: count && asStmt(count) };
}

const ids = (r: { skills: { id: string }[] }) => r.skills.map((s) => s.id);

async function referenceIds(sql: string, args: any[]): Promise<string[]> {
  const r = await db.execute({ sql, args });
  return r.rows.map((row) => String(row.id));
}

/** The orderings as they were before D26, spelled out so the comparison does not share code. */
const ORDER: Record<string, string> = {
  installs: "s.install_count DESC, s.seq ASC",
  recent: "s.published_at DESC, s.seq ASC",
  score: "s.score DESC, s.seq ASC",
  name: "s.name ASC, s.seq ASC",
};

async function insert(row: {
  id: string;
  name: string;
  owner: string;
  description: string;
  source: "seeded" | "imported" | "published";
  tier?: "verified" | "community";
  tags?: string[] | null;
  installs?: number;
  score?: number;
  published_at?: string;
  spec_version?: string;
}) {
  await db.execute({
    sql: `INSERT INTO skills (id, name, owner, description, source_url, trust_tier, spec_version,
            source, tags, install_count, score, published_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      row.id,
      row.name,
      row.owner,
      row.description,
      `https://github.com/${row.owner}/repo/tree/HEAD/${row.name}`,
      row.tier ?? "community",
      row.spec_version ?? "1.0",
      row.source,
      row.tags ? JSON.stringify(row.tags) : null,
      row.installs ?? 0,
      row.score ?? 50,
      row.published_at ?? "2026-09-01T00:00:00.000Z",
    ],
  });
}

/**
 * A small corpus shaped like the real one where it matters: imported rows carry no tags, curated
 * rows do, and installs, scores, dates and names repeat so every ordering has ties to break.
 */
async function seedCorpus() {
  const words = ["deploy", "deploy deploy", "deploy the service", "build", "deploy deploy deploy"];
  for (let i = 0; i < 60; i++) {
    await insert({
      id: `imp-${i}`,
      name: `imported-${i}`,
      owner: `bulk-${i % 9}`,
      description: `${words[i % words.length]} tool number ${i % 4}`,
      source: "imported",
      installs: i % 3,
      score: 40 + (i % 5) * 10,
      published_at: `2026-08-${String(1 + (i % 20)).padStart(2, "0")}T00:00:00.000Z`,
      spec_version: i === 17 ? "2.1" : "1.0",
    });
  }
  const tagSets = [["terminal"], ["terminal", "git"], ["docker"], ["git"], ["terminal", "docker"]];
  for (let i = 0; i < 30; i++) {
    await insert({
      id: `cur-${i}`,
      name: `curated-${i}`,
      owner: `team-${i % 4}`,
      description: `${words[(i + 2) % words.length]} helper ${i % 3}`,
      source: i % 10 === 9 ? "published" : "seeded",
      tier: i % 8 === 0 ? "verified" : "community",
      tags: tagSets[i % tagSets.length],
      installs: (i * 7) % 5,
      score: 60 + (i % 4) * 10,
      published_at: `2026-09-${String(1 + (i % 12)).padStart(2, "0")}T00:00:00.000Z`,
    });
  }
}

beforeAll(async () => {
  db = createClient({ url: ":memory:" });
  for (const s of allSchemaStatements()) await db.execute(s);
  __setDbForTesting(recording(db) as any);
});

afterAll(() => {
  __setDbForTesting(null);
  db.close();
});

beforeEach(async () => {
  __setDbForTesting(recording(db) as any);
  await db.execute("DELETE FROM skills");
  await db.execute("DELETE FROM registry_stats");
  await db.execute("DELETE FROM tag_counts");
});

describe("tag filter (D26)", () => {
  it("is served from a curated partial index for every sort, never by walking the table", async () => {
    await seedCorpus();
    for (const sort of ["installs", "recent", "score", "name"]) {
      const { page, count } = await traced({ tags: "terminal", sort });
      const pagePlan = await planOf(page);
      expect(pagePlan, `page plan, sort=${sort}`).toMatch(/skills_curated_/);
      expect(pagePlan, `page plan, sort=${sort}`).not.toMatch(
        /skills_(install_count|published_at|score|name_lookup)_idx/
      );
      expect(await planOf(count!), `count plan, sort=${sort}`).toMatch(/skills_curated_/);
    }
  });

  it("returns the page and count the unscoped filter returned", async () => {
    await seedCorpus();
    for (const sort of ["installs", "recent", "score", "name"]) {
      for (const [limit, offset] of [[5, 0], [5, 5], [20, 0]]) {
        const { result } = await traced({ tags: "terminal", sort, limit, offset });
        const expected = await referenceIds(
          `SELECT s.id FROM skills s
           WHERE EXISTS (SELECT 1 FROM json_each(s.tags) WHERE value IN (?))
           ORDER BY ${ORDER[sort]} LIMIT ? OFFSET ?`,
          ["terminal", limit, offset]
        );
        expect(ids(result), `sort=${sort} limit=${limit} offset=${offset}`).toEqual(expected);
      }
    }
    const all = await db.execute(
      "SELECT count(*) AS n FROM skills s WHERE EXISTS (SELECT 1 FROM json_each(s.tags) WHERE value = 'terminal')"
    );
    expect((await traced({ tags: "terminal" })).result.total).toBe(Number(all.rows[0].n));
  });

  it("combines with a provenance filter without repeating the conjunct", async () => {
    await seedCorpus();
    const { page } = await traced({ tags: "git", source: "seeded" });
    expect(page.sql.match(/source <> 'imported'/g)).toHaveLength(1);
  });
});

describe("community tier (D26)", () => {
  it("walks the sort order instead of the trust_tier index", async () => {
    await seedCorpus();
    for (const sort of ["installs", "recent", "score", "name"]) {
      const { page } = await traced({ tier: "community", sort });
      expect(await planOf(page), `sort=${sort}`).not.toMatch(/skills_trust_tier_idx/);
    }
    // verified is a handful of rows, where the index is the right path and must stay.
    const { page } = await traced({ tier: "verified", sort: "score" });
    expect(await planOf(page)).toMatch(/skills_trust_tier_idx/);
  });

  it("returns the page the indexed filter returned", async () => {
    await seedCorpus();
    for (const sort of ["installs", "recent", "score", "name"]) {
      const { result } = await traced({ tier: "community", sort, limit: 15, offset: 10 });
      const expected = await referenceIds(
        `SELECT s.id FROM skills s WHERE s.trust_tier = 'community' ORDER BY ${ORDER[sort]} LIMIT 15 OFFSET 10`,
        []
      );
      expect(ids(result), `sort=${sort}`).toEqual(expected);
    }
  });
});

describe("spec_version filter (D26)", () => {
  it("reads the partial index for any version other than 1.0", async () => {
    await seedCorpus();
    for (const v of ["2.1", "9.9"]) {
      const { page, count } = await traced({ spec_version: v });
      expect(await planOf(page), `page, ${v}`).toMatch(/skills_spec_version_other_idx/);
      expect(await planOf(count!), `count, ${v}`).toMatch(/skills_spec_version_other_idx/);
    }
    const one = await traced({ spec_version: "2.1" });
    expect(ids(one.result)).toEqual(["imp-17"]);
    expect((await traced({ spec_version: "9.9" })).result.total).toBe(0);
    expect((await traced({ spec_version: "1.0" })).result.total).toBe(89);
  });
});

describe("relevance search (D26)", () => {
  const legacyPage = (fts: string, limit: number, offset: number) =>
    referenceIds(
      `SELECT s.id FROM skills s JOIN (SELECT rowid AS seq, bm25(skills_fts) AS rank FROM skills_fts
         WHERE skills_fts MATCH ?) m ON m.seq = s.seq
       ORDER BY m.rank ASC, m.seq ASC LIMIT ? OFFSET ?`,
      [fts, limit, offset]
    );

  it("ranks inside FTS5 when nothing else narrows the match", async () => {
    await seedCorpus();
    const { page } = await traced({ q: "deploy" });
    expect(page.sql).toMatch(/ORDER BY rank LIMIT \? OFFSET \?/);
    expect(page.sql).not.toMatch(/bm25\(/);
  });

  it("returns the pages that ranking every match returned, ties included", async () => {
    await seedCorpus();
    for (const [limit, offset] of [[20, 0], [20, 20], [7, 3], [100, 0], [10, 60]]) {
      const { result } = await traced({ q: "deploy", limit, offset });
      expect(ids(result), `limit=${limit} offset=${offset}`).toEqual(
        await legacyPage('"deploy"', limit, offset)
      );
    }
  });

  it("keeps ranking every match when another predicate or an explicit sort applies", async () => {
    await seedCorpus();
    const filtered = await traced({ q: "deploy", tier: "community", limit: 10 });
    expect(filtered.page.sql).toMatch(/bm25\(skills_fts\)/);
    expect(filtered.page.sql).not.toMatch(/CROSS JOIN/);
    const sorted = await traced({ q: "deploy", sort: "installs" });
    expect(sorted.page.sql).toMatch(/bm25\(skills_fts\)/);
  });
});

describe("search within the curated tier (D26)", () => {
  const legacy = (fts: string, where: string, args: any[], order: string, limit: number, offset: number) =>
    referenceIds(
      `SELECT s.id FROM skills s JOIN (SELECT rowid AS seq, bm25(skills_fts) AS rank FROM skills_fts
         WHERE skills_fts MATCH ?) m ON m.seq = s.seq
       WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [fts, ...args, limit, offset]
    );

  it("walks the curated partial index and probes FTS5 per row", async () => {
    await seedCorpus();
    for (const over of [{ q: "deploy", tags: "terminal" }, { q: "deploy", source: "seeded" }, { q: "deploy", tags: "git", sort: "installs" }]) {
      const { page, count } = await traced(over);
      expect(page.sql, JSON.stringify(over)).toMatch(/CROSS JOIN skills_fts/);
      for (const [which, stmt] of [["page", page], ["count", count!]] as const) {
        // The curated index must be the outer loop, with FTS5 probed inside it — not the reverse.
        const plan = (await planOf(stmt)).split("\n");
        const outer = plan.findIndex((l) => /SCAN s USING (COVERING )?INDEX skills_curated_/.test(l));
        const probe = plan.findIndex((l) => /skills_fts VIRTUAL TABLE/.test(l));
        expect(outer, `${which} ${JSON.stringify(over)}: ${plan.join(" | ")}`).toBeGreaterThanOrEqual(0);
        expect(probe, `${which} ${JSON.stringify(over)}: ${plan.join(" | ")}`).toBeGreaterThan(outer);
      }
    }
  });

  it("returns the page and count that ranking every match returned", async () => {
    await seedCorpus();
    const tagged = "s.source <> 'imported' AND EXISTS (SELECT 1 FROM json_each(s.tags) WHERE value IN (?))";
    for (const [limit, offset] of [[5, 0], [5, 5], [50, 0]]) {
      const byRank = await traced({ q: "deploy", tags: "terminal", limit, offset });
      expect(ids(byRank.result), `relevance ${limit}/${offset}`).toEqual(
        await legacy('"deploy"', tagged, ["terminal"], "m.rank ASC, m.seq ASC", limit, offset)
      );
      const byInstalls = await traced({ q: "deploy", tags: "terminal", sort: "installs", limit, offset });
      expect(ids(byInstalls.result), `installs ${limit}/${offset}`).toEqual(
        await legacy('"deploy"', tagged, ["terminal"], "s.install_count DESC, s.seq ASC", limit, offset)
      );
      const seeded = await traced({ q: "deploy", source: "seeded", limit, offset });
      expect(ids(seeded.result), `source=seeded ${limit}/${offset}`).toEqual(
        await legacy('"deploy"', "s.source <> 'imported' AND s.source = ?", ["seeded"], "m.rank ASC, m.seq ASC", limit, offset)
      );
    }
    const total = await db.execute({
      sql: `SELECT count(*) AS n FROM skills s JOIN (SELECT rowid AS seq FROM skills_fts WHERE skills_fts MATCH ?) m
            ON m.seq = s.seq WHERE ${tagged}`,
      args: ['"deploy"', "terminal"],
    });
    expect((await traced({ q: "deploy", tags: "terminal" })).result.total).toBe(Number(total.rows[0].n));
  });
});

describe("refreshStats (D29)", () => {
  it("derives skills_imported from total minus curated", async () => {
    await seedCorpus();
    const s = await refreshStats(db);
    const imported = await db.execute("SELECT count(*) AS n FROM skills WHERE source = 'imported'");
    expect(s.skills_imported).toBe(Number(imported.rows[0].n));
    expect(s.skills_total).toBe(s.skills_curated + s.skills_imported);
    expect(captured.some((c) => /source = 'imported'/.test(asStmt(c).sql))).toBe(false);
  });

  it("recounts owners only once the stored figure is stale", async () => {
    await seedCorpus();
    const first = await refreshStats(db);

    await insert({ id: "new-owner", name: "x", owner: "brand-new-owner", description: "d", source: "seeded" });
    captured = [];
    const fresh = await refreshStats(recording(db));
    expect(fresh.owners_total).toBe(first.owners_total);
    expect(captured.some((c) => /count\(DISTINCT owner\)/i.test(asStmt(c).sql))).toBe(false);

    const kept = await db.execute("SELECT updated_at FROM registry_stats WHERE key = 'owners_total'");
    const total = await db.execute("SELECT updated_at FROM registry_stats WHERE key = 'skills_total'");
    expect(String(kept.rows[0].updated_at) <= String(total.rows[0].updated_at)).toBe(true);

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await db.execute({
      sql: "UPDATE registry_stats SET updated_at = ? WHERE key = 'owners_total'",
      args: [eightDaysAgo],
    });
    expect((await refreshStats(db)).owners_total).toBe(first.owners_total + 1);
  });

  it("always recounts owners when asked to", async () => {
    await seedCorpus();
    const first = await refreshStats(db);
    await insert({ id: "forced", name: "x", owner: "forced-owner", description: "d", source: "seeded" });
    expect((await refreshStats(db, { ownersMaxAgeMs: 0 })).owners_total).toBe(first.owners_total + 1);
  });
});

describe("migration 005 (D28)", () => {
  it("drops skills_trgm and scopes the update trigger to the indexed text", async () => {
    const trgm = await db.execute("SELECT name FROM sqlite_master WHERE name LIKE 'skills_trgm%'");
    expect(trgm.rows).toHaveLength(0);
    const au = await db.execute("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'skills_au'");
    expect(String(au.rows[0].sql)).toMatch(/AFTER UPDATE OF name, description ON skills/);
  });

  it("keeps full-text search in step with text edits, and leaves it alone for installs", async () => {
    await insert({ id: "t1", name: "alpha-tool", owner: "o", description: "frobnicate widgets", source: "seeded" });
    await db.execute("UPDATE skills SET install_count = install_count + 1 WHERE id = 't1'");
    await db.execute("INSERT INTO skills_fts(skills_fts) VALUES('integrity-check')");
    expect((await searchSkills(query({ q: "frobnicate" }))).total).toBe(1);

    await db.execute("UPDATE skills SET description = 'defenestrate gadgets' WHERE id = 't1'");
    await db.execute("INSERT INTO skills_fts(skills_fts) VALUES('integrity-check')");
    expect((await searchSkills(query({ q: "frobnicate" }))).total).toBe(0);
    expect((await searchSkills(query({ q: "defenestrate" }))).total).toBe(1);

    await db.execute("DELETE FROM skills WHERE id = 't1'");
    await db.execute("INSERT INTO skills_fts(skills_fts) VALUES('integrity-check')");
    expect((await searchSkills(query({ q: "defenestrate" }))).total).toBe(0);
  });

  it("gives rescore.ts's curated walk its own index", async () => {
    const plan = await planOf({
      sql: `SELECT owner, name, source_url, score FROM skills
            WHERE (name > ? OR (name = ? AND owner > ?)) AND source <> 'imported'
            ORDER BY name, owner LIMIT ?`,
      args: ["", "", "", 1000],
    });
    expect(plan).toMatch(/skills_curated_name_idx/);
  });

  it("reaches the same schema when trigger DDL is deferred, as the corpus build does", async () => {
    const inOrder = createClient({ url: ":memory:" });
    const deferred = createClient({ url: ":memory:" });
    const statements = allSchemaStatements();
    for (const s of statements) await inOrder.execute(s);
    for (const s of statements) if (!isTriggerDdl(s)) await deferred.execute(s);
    for (const s of statements) if (isTriggerDdl(s)) await deferred.execute(s);

    const schema = async (c: Client) =>
      (await c.execute("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")).rows.map(
        (r) => `${r.type}|${r.name}|${r.tbl_name}|${r.sql}`
      );
    expect(await schema(deferred)).toEqual(await schema(inOrder));
    inOrder.close();
    deferred.close();
  });
});

describe("a failing database is an outage, not data", () => {
  const failing = (message: string, code?: string) =>
    ({
      execute: async () => {
        throw Object.assign(new Error(message), code ? { code } : {});
      },
      batch: async () => {
        throw Object.assign(new Error(message), code ? { code } : {});
      },
    }) as any;

  it("answers /v1/stats with an uncached 503 instead of zeros", async () => {
    __setDbForTesting(failing("BLOCKED: Operation was blocked: SQL read operations are forbidden", "BLOCKED"));
    const res = await app.request("/v1/stats");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as any).code).toBe("DB_UNAVAILABLE");
  });

  it("still reports zeros for a database that has not had migration 002", async () => {
    __setDbForTesting(failing("SQLITE_ERROR: no such table: registry_stats"));
    const res = await app.request("/v1/stats");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).skills.total).toBe(0);
  });

  it("answers /v1/tags with an uncached 503", async () => {
    __setDbForTesting(failing("BLOCKED: reads are blocked", "BLOCKED"));
    const res = await app.request("/v1/tags");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("maps BLOCKED on any other route to an uncached 503", async () => {
    __setDbForTesting(failing("BLOCKED: reads are blocked", "BLOCKED"));
    const res = await app.request("/v1/skills?q=anything");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as any).code).toBe("DB_UNAVAILABLE");
  });
});
