import { Hono } from "hono";
import { searchSkillsSchema, skillRowToApi } from "../types/skill.js";
import { searchSkills, getSkill, getSkillByBareName } from "../db/skills.js";
import { CACHE_DETAIL, CACHE_LIST } from "../middleware/cache.js";
import { MAX_OFFSET } from "../db/pagination.js";
import { invalidParams } from "./shared.js";

export const skillsRoutes = new Hono();

// GET /skills — list and search skills
skillsRoutes.get("/", async (c) => {
  const raw = Object.fromEntries(new URL(c.req.url).searchParams);
  const parsed = searchSkillsSchema.safeParse(raw);

  if (!parsed.success) return invalidParams(c, parsed.error);

  const { skills, total, total_relation, has_more } = await searchSkills(parsed.data);

  // On the success path only, so a 400 above is never cached at the edge.
  c.header("Cache-Control", CACHE_LIST);
  return c.json({
    skills: skills.map(skillRowToApi),
    total,
    // "eq" — exact. "gte" — at least this many; the count stopped at the cap. Render it as
    // "10,000+", never as a bare 10000. Same contract as Elasticsearch's hits.total.relation.
    total_relation,
    has_more,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    // One source of truth for when a client should stop paginating, so the cap is not
    // duplicated in every consumer.
    max_offset: MAX_OFFSET,
  });
});

// GET /skills/:owner/:name — get a single skill.
// Registered before the bare-name route: Hono matches on segment count, so the two
// cannot collide, but keeping the specific one first makes the intent obvious.
skillsRoutes.get("/:owner/:name", async (c) => {
  const skill = await getSkill(c.req.param("owner"), c.req.param("name"));

  if (!skill) {
    return c.json({ error: "Skill not found", code: "NOT_FOUND" }, 404);
  }

  // Set here rather than by middleware: a "/skills/*" mount would also capture
  // /skills/:name/install, which increments install_count and must never be cached.
  // Only the success path gets a header, so a 404 is never pinned at the edge.
  c.header("Cache-Control", CACHE_DETAIL);
  return c.json(skillRowToApi(skill));
});

// GET /skills/:name — legacy unqualified lookup, for CLI builds predating the owner
// namespace. Resolves only when exactly one owner claims the name; 409 otherwise,
// since guessing which of several same-named skills the caller meant is how you
// install something nobody asked for. Retire once the CLI ships owner-scoped paths.
skillsRoutes.get("/:name", async (c) => {
  const name = c.req.param("name");
  const { skill, ambiguous, owners } = await getSkillByBareName(name);

  if (ambiguous) {
    return c.json(
      {
        error: `Skill name "${name}" is claimed by multiple owners; use /skills/{owner}/${name}`,
        code: "AMBIGUOUS_NAME",
        owners,
      },
      409
    );
  }

  if (!skill) {
    return c.json({ error: "Skill not found", code: "NOT_FOUND" }, 404);
  }

  // Success only. The 409 above stays uncached deliberately: ambiguity is data-dependent and
  // flips the moment a second owner claims the name.
  c.header("Cache-Control", CACHE_DETAIL);
  return c.json(skillRowToApi(skill));
});
