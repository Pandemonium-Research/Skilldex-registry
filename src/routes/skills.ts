import { Hono } from "hono";
import { searchSkillsSchema, skillRowToApi } from "../types/skill.js";
import { searchSkills, getSkill, getSkillByBareName } from "../db/skills.js";

export const skillsRoutes = new Hono();

// GET /skills — list and search skills
skillsRoutes.get("/", async (c) => {
  const raw = Object.fromEntries(new URL(c.req.url).searchParams);
  const parsed = searchSkillsSchema.safeParse(raw);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid query parameters", code: "INVALID_PARAMS" },
      400
    );
  }

  const { skills, total } = await searchSkills(parsed.data);

  return c.json({
    skills: skills.map(skillRowToApi),
    total,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
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

  return c.json(skillRowToApi(skill));
});
