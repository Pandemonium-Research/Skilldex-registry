import { Hono } from "hono";
import { incrementInstallCount, getSkillByBareName } from "../db/skills.js";
import type { InstallResponse } from "../types/api.js";
import type { SkillRow } from "../types/skill.js";

export const installRoutes = new Hono();

function toInstallResponse(skill: SkillRow): InstallResponse {
  return {
    name: skill.name,
    owner: skill.owner,
    qualified_name: `${skill.owner}/${skill.name}`,
    source_url: skill.source_url,
    score: skill.score,
    spec_version: skill.spec_version,
    trust_tier: skill.trust_tier as "verified" | "community",
  };
}

// GET /skills/:owner/:name/install — increment install count and return source URL.
//
// Three segments, not two. `/skills/:name/install` would have the same shape as
// `/skills/:owner/:name`, so a skill literally named "install" would shadow every
// owner's namespace.
installRoutes.get("/:owner/:name/install", async (c) => {
  const skill = await incrementInstallCount(c.req.param("owner"), c.req.param("name"));

  if (!skill) {
    return c.json({ error: "Skill not found", code: "NOT_FOUND" }, 404);
  }

  return c.json(toInstallResponse(skill));
});

// GET /skills/:name/install — legacy unqualified install, for CLI builds predating the
// owner namespace. Resolves only when one owner claims the name (see getSkillByBareName).
installRoutes.get("/:name/install", async (c) => {
  const name = c.req.param("name");
  const { skill, ambiguous, owners } = await getSkillByBareName(name);

  if (ambiguous) {
    return c.json(
      {
        error: `Skill name "${name}" is claimed by multiple owners; use /skills/{owner}/${name}/install`,
        code: "AMBIGUOUS_NAME",
        owners,
      },
      409
    );
  }

  if (!skill) {
    return c.json({ error: "Skill not found", code: "NOT_FOUND" }, 404);
  }

  const counted = await incrementInstallCount(skill.owner, skill.name);
  return c.json(toInstallResponse(counted ?? skill));
});
