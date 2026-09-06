import { Hono } from "hono";
import { searchSkillsetsSchema, skillsetRowToApi } from "../types/skillset.js";
import { searchSkillsets, getSkillsetByName } from "../db/skillsets.js";
import { CACHE_DETAIL } from "../middleware/cache.js";
import { MAX_OFFSET } from "../db/pagination.js";
import { invalidParams } from "./shared.js";

export const skillsetsRoutes = new Hono();

// GET /skillsets — list and search skillsets
skillsetsRoutes.get("/", async (c) => {
  const raw = Object.fromEntries(new URL(c.req.url).searchParams);
  const parsed = searchSkillsetsSchema.safeParse(raw);

  if (!parsed.success) return invalidParams(c, parsed.error);

  const { skillsets, total, total_relation, has_more } = await searchSkillsets(parsed.data);

  return c.json({
    skillsets: skillsets.map(skillsetRowToApi),
    total,
    total_relation,
    has_more,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    max_offset: MAX_OFFSET,
  });
});

// GET /skillsets/:name — get a single skillset by name
skillsetsRoutes.get("/:name", async (c) => {
  const name = c.req.param("name");
  const skillset = await getSkillsetByName(name);

  if (!skillset) {
    return c.json({ error: "Skillset not found", code: "NOT_FOUND" }, 404);
  }

  // See routes/skills.ts — success path only, so a 404 is never cached at the edge.
  c.header("Cache-Control", CACHE_DETAIL);
  return c.json(skillsetRowToApi(skillset));
});
