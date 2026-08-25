import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";
import { createSkillSchema, skillRowToApi } from "../types/skill.js";
import { createSkill, getSkill, updateSkill, deleteSkill } from "../db/skills.js";
import { fetchSkillFromGitHub, findRelocatedSkill } from "../github/fetch.js";
import { validateSkill } from "../validator/index.js";

export const publishRoutes = new Hono();

// POST /skills — submit a new skill to the registry
publishRoutes.post("/", requireAuth, async (c) => {
  const body = await c.req.json();
  const parsed = createSkillSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid request body", code: "INVALID_BODY" },
      400
    );
  }

  const publisher = c.get("publisher");

  // The publisher owns their namespace. Taking `owner` from the authenticated handle
  // rather than the request body is what stops anyone publishing into someone else's.
  const owner = publisher.github_handle;

  // Names are unique per owner, so a clash only matters within this namespace.
  const existing = await getSkill(owner, parsed.data.name);
  if (existing) {
    return c.json(
      {
        error: `You already have a skill named "${parsed.data.name}"`,
        code: "CONFLICT",
      },
      409
    );
  }

  // Fetch SKILL.md from source_url
  let metadata;
  try {
    metadata = await fetchSkillFromGitHub(parsed.data.source_url);
  } catch (err: any) {
    return c.json(
      {
        error: `Could not fetch or parse SKILL.md from source_url: ${err.message}`,
        code: "UNPROCESSABLE",
      },
      422
    );
  }

  // Validate and score
  const validation = validateSkill({
    skillMd: metadata.skillMd,
    files: metadata.files,
  });

  // Store in database
  const skill = await createSkill({
    name: parsed.data.name,
    display_name: metadata.name ?? parsed.data.name,
    owner,
    description: metadata.description,
    author: metadata.author ?? publisher.github_handle,
    source_url: parsed.data.source_url,
    trust_tier: "community", // always community on submission
    score: validation.score,
    spec_version: metadata.spec_version,
    tags: parsed.data.tags ?? null,
    published_by: publisher.id,
    // Only imported rows carry a content_key; this skill's bytes were never hashed.
    content_key: null,
  });

  return c.json(
    {
      skill: skillRowToApi(skill),
      diagnostics: validation.diagnostics,
    },
    201
  );
});

// PATCH /skills/:owner/:name — update an existing skill (re-fetch and re-score)
publishRoutes.patch("/:owner/:name", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const publisher = c.get("publisher");

  const existing = await getSkill(owner, name);
  if (!existing) {
    return c.json({ error: "Skill not found", code: "NOT_FOUND" }, 404);
  }

  if (existing.published_by !== publisher.id) {
    return c.json(
      { error: "You are not the publisher of this skill", code: "FORBIDDEN" },
      403
    );
  }

  // Re-fetch and re-validate. If source_url 404s (e.g. the repo reorganized
  // its directories since we last fetched), fall back to scanning the repo
  // for a SKILL.md whose frontmatter name still matches.
  let metadata;
  let resolvedSourceUrl = existing.source_url;
  try {
    metadata = await fetchSkillFromGitHub(existing.source_url);
  } catch (err: any) {
    const relocated = await findRelocatedSkill(existing.source_url, name);
    if (!relocated) {
      return c.json(
        {
          error: `Could not fetch or parse SKILL.md: ${err.message}`,
          code: "UNPROCESSABLE",
        },
        422
      );
    }
    metadata = relocated.metadata;
    resolvedSourceUrl = relocated.sourceUrl;
  }

  const validation = validateSkill({
    skillMd: metadata.skillMd,
    files: metadata.files,
  });

  const updated = await updateSkill(owner, name, {
    source_url: resolvedSourceUrl,
    description: metadata.description,
    score: validation.score,
    spec_version: metadata.spec_version,
  });

  return c.json({
    skill: skillRowToApi(updated!),
    diagnostics: validation.diagnostics,
  });
});

// DELETE /skills/:owner/:name — remove a skill from the registry
publishRoutes.delete("/:owner/:name", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const publisher = c.get("publisher");

  const existing = await getSkill(owner, name);
  if (!existing) {
    return c.json({ error: "Skill not found", code: "NOT_FOUND" }, 404);
  }

  if (existing.published_by !== publisher.id) {
    return c.json(
      { error: "You are not the publisher of this skill", code: "FORBIDDEN" },
      403
    );
  }

  await deleteSkill(owner, name);

  return c.json({ success: true });
});
