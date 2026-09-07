// The INSERT in src/db/skillsets.ts against the schema in schema/sqlite/.
//
// Route tests mock the database layer, so they prove the route passes the right values but not
// that the column list receiving them exists. That gap is exactly where a migration and its
// writer drift apart, and the failure is invisible until a real publish: SQLite rejects an
// unknown column at execute time, and rejects a write to a generated one.
//
// This builds the real schema in memory from the migration files and runs the real statement
// against it, so adding a column to the INSERT without adding it to a migration fails here.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { allSchemaStatements } from "../../scripts/lib/schema.js";

const SRC = path.join(import.meta.dirname, "..", "..", "src", "db", "skillsets.ts");

/** The column list from the INSERT INTO skillsets statement, as actually written in the source. */
function insertedColumns(): string[] {
  const src = readFileSync(SRC, "utf8");
  const m = src.match(/INSERT INTO skillsets\s*\(([^)]*)\)/);
  if (!m) throw new Error("could not find the INSERT INTO skillsets statement");
  return m[1]
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

async function schemaDb() {
  const db = createClient({ url: ":memory:" });
  for (const stmt of allSchemaStatements()) {
    await db.execute(stmt);
  }
  return db;
}

describe("skillsets INSERT matches the migrated schema", () => {
  it("writes only columns the schema actually has", async () => {
    const db = await schemaDb();
    const info = await db.execute("PRAGMA table_xinfo(skillsets)");
    const known = new Set(info.rows.map((r) => String(r.name)));

    for (const col of insertedColumns()) {
      expect(known, `INSERT names a column the schema lacks: ${col}`).toContain(col);
    }
  });

  it("never writes a generated column", async () => {
    // table_xinfo reports hidden=2 for a VIRTUAL generated column and 3 for a STORED one;
    // table_info omits virtual ones entirely, which is why xinfo is used here.
    const db = await schemaDb();
    const info = await db.execute("PRAGMA table_xinfo(skillsets)");
    const generated = new Set(
      info.rows.filter((r) => Number(r.hidden) >= 2).map((r) => String(r.name))
    );

    // Guard the guard: if these stop being generated, the assertion below proves nothing.
    expect(generated).toContain("skill_count");
    expect(generated).toContain("coherence_pct");

    for (const col of insertedColumns()) {
      expect(generated, `INSERT writes a generated column: ${col}`).not.toContain(col);
    }
  });

  it("accepts a row carrying coherence, and derives the percentage from the counts", async () => {
    const db = await schemaDb();

    await db.execute({
      sql: `INSERT INTO skillsets
              (id, name, description, author, source_url, trust_tier, score,
               spec_version, tags, skill_refs, published_by,
               members_checked, members_coherent, coherence)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        "ss-1",
        "devset",
        "d",
        "testuser",
        "https://github.com/t/r",
        "community",
        100,
        "1.1",
        null,
        "[]",
        null,
        4,
        3,
        JSON.stringify({ passCount: 6, warnCount: 1, errorCount: 0, declaredConventions: [] }),
      ],
    });

    const r = await db.execute("SELECT members_checked, coherence_pct, spec_version FROM skillsets");
    expect(Number(r.rows[0].members_checked)).toBe(4);
    expect(Number(r.rows[0].coherence_pct)).toBe(75); // 3/4, truncated
    expect(String(r.rows[0].spec_version)).toBe("1.1");
  });

  it("reports no coherence rather than zero when nothing was checked", async () => {
    const db = await schemaDb();

    await db.execute({
      sql: `INSERT INTO skillsets (id, name, description, source_url, skill_refs,
              members_checked, members_coherent) VALUES (?,?,?,?,?,?,?)`,
      args: ["ss-2", "empty", "d", "https://github.com/t/r", "[]", 0, 0],
    });

    const r = await db.execute("SELECT coherence_pct FROM skillsets WHERE name = 'empty'");
    expect(r.rows[0].coherence_pct).toBeNull();
  });

  it("orders by coherence with unmeasured skillsets last, not first", async () => {
    // The point of the NULL: "most coherent first" must not be led by skillsets nobody checked.
    const db = await schemaDb();
    const rows: Array<[string, number | null, number | null]> = [
      ["half", 4, 2],
      ["perfect", 3, 3],
      ["unmeasured", null, null],
      ["none-checked", 0, 0],
    ];
    for (const [name, checked, coherent] of rows) {
      await db.execute({
        sql: `INSERT INTO skillsets (id, name, description, source_url, skill_refs,
                members_checked, members_coherent) VALUES (?,?,?,?,?,?,?)`,
        args: [name, name, "d", "https://github.com/t/r", "[]", checked, coherent],
      });
    }

    const r = await db.execute("SELECT name FROM skillsets ORDER BY coherence_pct DESC, seq ASC");
    expect(r.rows.map((x) => String(x.name))).toEqual([
      "perfect", // 100
      "half", // 50
      "unmeasured", // NULL — never checked
      "none-checked", // NULL — no members to check
    ]);
  });

  it("excludes unmeasured skillsets from a minimum-coherence filter", async () => {
    const db = await schemaDb();
    for (const [name, checked, coherent] of [
      ["good", 2, 2],
      ["unmeasured", null, null],
    ] as Array<[string, number | null, number | null]>) {
      await db.execute({
        sql: `INSERT INTO skillsets (id, name, description, source_url, skill_refs,
                members_checked, members_coherent) VALUES (?,?,?,?,?,?,?)`,
        args: [name, name, "d", "https://github.com/t/r", "[]", checked, coherent],
      });
    }

    const r = await db.execute("SELECT name FROM skillsets WHERE coherence_pct >= 50");
    expect(r.rows.map((x) => String(x.name))).toEqual(["good"]);
  });

  it("offers every sort the API accepts, and no others", async () => {
    // A sort named in the zod enum with no SQL behind it falls through to the installs default,
    // so the request succeeds and quietly ignores what was asked for.
    const { searchSkillsetsSchema } = await import("../../src/types/skillset.js");
    const src = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "db", "skillsets.ts"), "utf8");
    const map = src.match(/const SORT_MAP: Record<string, string> = \{([\s\S]*?)\n\};/);
    if (!map) throw new Error("could not find SORT_MAP");

    const implemented = [...map[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
    const accepted = [...(searchSkillsetsSchema.shape.sort as any)._def.innerType._def.values].sort();

    expect(implemented).toEqual(accepted);
  });

  it("refuses coherence that is not valid JSON", async () => {
    const db = await schemaDb();

    await expect(
      db.execute({
        sql: `INSERT INTO skillsets (id, name, description, source_url, skill_refs, coherence)
              VALUES (?,?,?,?,?,?)`,
        args: ["ss-3", "bad", "d", "https://github.com/t/r", "[]", "not json"],
      })
    ).rejects.toThrow(/CHECK constraint/i);
  });
});
