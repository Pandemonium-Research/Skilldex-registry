import { Hono } from "hono";
import { getDb } from "../db/client.js";
import { toSpecVersion } from "../db/rows.js";
import type { SpecVersion } from "../types/api.js";

export const specRoutes = new Hono();

// GET /spec-versions — list all spec versions
specRoutes.get("/", async (c) => {
  const db = getDb();
  const r = await db.execute("SELECT * FROM spec_versions ORDER BY released_at DESC");
  return c.json({ versions: r.rows.map(toSpecVersion) as SpecVersion[] });
});

// GET /spec-versions/current — get the current spec version
specRoutes.get("/current", async (c) => {
  const db = getDb();
  // is_current is 0/1 here; SQLite has no boolean type.
  const r = await db.execute("SELECT * FROM spec_versions WHERE is_current = 1 LIMIT 1");

  if (r.rows.length === 0) {
    return c.json({ error: "No current spec version set", code: "NOT_FOUND" }, 404);
  }

  return c.json(toSpecVersion(r.rows[0]) as SpecVersion);
});
