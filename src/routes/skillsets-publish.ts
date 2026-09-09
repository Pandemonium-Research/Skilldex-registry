import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";
import { createSkillsetSchema, skillsetRowToApi } from "../types/skillset.js";
import {
  createSkillset,
  getSkillsetByName,
  updateSkillset,
  deleteSkillset,
} from "../db/skillsets.js";
import { refreshSkillsetCount } from "../db/stats.js";
import { fetchSkillsetFromGitHub, type SkillsetMetadata } from "../github/fetch-skillset.js";
import { validateSkillset, SKILLSET_SPEC_VERSION } from "../validator/skillset.js";
import {
  checkSkillsetCoherence,
  type SkillsetCoherenceResult,
} from "../validator/skillset-coherence.js";

export const skillsetsPublishRoutes = new Hono();

/**
 * Upper bound on members whose SKILL.md this route will fetch.
 *
 * Coherence costs one request per member plus one per shared asset. Official skillsets carry two
 * to four members, so this is far above anything real; it exists so a skillset with thousands of
 * directories cannot turn one publish into an unbounded fan-out inside a serverless function.
 * Exceeded, the publish is refused rather than scored on a subset — checking 50 of 500 members
 * and reporting the ratio as if it covered the skillset would be worse than declining.
 */
const MAX_COHERENCE_MEMBERS = 50;

type CoherenceOutcome =
  | { ok: true; coherence: SkillsetCoherenceResult }
  | { ok: false; reason: string };

/**
 * Compute coherence for a fetched skillset, or explain why it could not be.
 *
 * The prefetch is the point. checkSkillsetCoherence treats a member it cannot read as "nothing to
 * check" and leaves it in the coherent set — right for skilldex, where that only happens if a
 * file vanishes mid-scan, but on a registry the same path covers a failed GitHub request, and a
 * transient error silently *inflating* the ratio is the worst possible failure mode for a number
 * people sort by. Fetching every member up front turns that into an explicit refusal.
 *
 * It is also what makes this affordable: the check reads members in a loop, and readFile memoizes,
 * so priming the cache in parallel collapses N sequential round trips into one.
 */
async function computeCoherence(metadata: SkillsetMetadata): Promise<CoherenceOutcome> {
  const members = metadata.embeddedSkillNames;

  if (members.length > MAX_COHERENCE_MEMBERS) {
    return {
      ok: false,
      reason:
        `Skillset has ${members.length} embedded skills, above the ${MAX_COHERENCE_MEMBERS} ` +
        `this registry will check for coherence`,
    };
  }

  const missing = (
    await Promise.all(
      members.map(async (m) => ((await metadata.readFile(`${m}/SKILL.md`)) === null ? m : null))
    )
  ).filter((m): m is string => m !== null);

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Could not fetch SKILL.md for: ${missing.join(", ")}`,
    };
  }

  return {
    ok: true,
    coherence: await checkSkillsetCoherence(
      { readFile: metadata.readFile, listFiles: () => metadata.files },
      members
    ),
  };
}

/**
 * Bring `skillsets_total` back in line after a row was added or removed.
 *
 * Needed because the nightly seeder is the only other writer of that key, so between runs — and
 * entirely, while the seeder is paused — a publish would otherwise leave the listing reporting a
 * total it labels exact and that is wrong. PATCH does not call this: it never changes the count.
 *
 * Failure is logged, never propagated. The row is already committed by the time this runs, so a
 * stats error surfacing as a 500 would tell publishers their publish failed when it succeeded.
 * The recount is idempotent, so the next publish repairs whatever this call missed.
 */
async function syncSkillsetCount(after: string): Promise<void> {
  try {
    await refreshSkillsetCount();
  } catch (err) {
    console.error(`[stats] skillsets_total not refreshed after ${after}:`, err);
  }
}

// POST /skillsets — submit a new skillset to the registry
skillsetsPublishRoutes.post("/", requireAuth, async (c) => {
  const body = await c.req.json();
  const parsed = createSkillsetSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid request body", code: "INVALID_BODY" },
      400
    );
  }

  // Check if name is taken
  const existing = await getSkillsetByName(parsed.data.name);
  if (existing) {
    return c.json(
      { error: "Skillset name already exists", code: "CONFLICT" },
      409
    );
  }

  // Fetch SKILLSET.md from source_url
  let metadata;
  try {
    metadata = await fetchSkillsetFromGitHub(parsed.data.source_url);
  } catch (err: any) {
    return c.json(
      {
        error: `Could not fetch or parse SKILLSET.md from source_url: ${err.message}`,
        code: "UNPROCESSABLE",
      },
      422
    );
  }

  // Validate and score
  const validation = validateSkillset({
    skillsetMd: metadata.skillsetMd,
    files: metadata.files,
    embeddedSkillNames: metadata.embeddedSkillNames,
    remoteSkillRefs: metadata.skillRefs.filter(
      (r) => !metadata.embeddedSkillNames.includes(r.name)
    ),
  });

  const outcome = await computeCoherence(metadata);
  if (!outcome.ok) {
    return c.json({ error: outcome.reason, code: "UNPROCESSABLE" }, 422);
  }

  const publisher = c.get("publisher");

  // Store in database
  const skillset = await createSkillset({
    name: parsed.data.name,
    // `|| metadata.name` matches the skill path and scripts/seed.ts.
    description: metadata.description || metadata.name || parsed.data.name,
    author: metadata.author ?? publisher.github_handle,
    source_url: parsed.data.source_url,
    trust_tier: "community",
    score: validation.score,
    // What this registry validated against, not what the frontmatter claimed — see the constant.
    spec_version: SKILLSET_SPEC_VERSION,
    tags: parsed.data.tags ?? null,
    skill_refs: metadata.skillRefs,
    published_by: publisher.id,
    members_checked: outcome.coherence.membersChecked,
    members_coherent: outcome.coherence.membersCoherent,
    coherence: outcome.coherence,
  });

  await syncSkillsetCount("publish");

  return c.json(
    {
      skillset: skillsetRowToApi(skillset),
      diagnostics: validation.diagnostics,
      // The full result, not the summary the DTO carries: this is the response the publisher
      // acts on, so it needs the per-member diagnostics and the conventions they were judged
      // against, not just the tallies.
      coherence: outcome.coherence,
    },
    201
  );
});

// PATCH /skillsets/:name — update an existing skillset (re-fetch and re-score)
skillsetsPublishRoutes.patch("/:name", requireAuth, async (c) => {
  const name = c.req.param("name");
  const publisher = c.get("publisher");

  const existing = await getSkillsetByName(name);
  if (!existing) {
    return c.json({ error: "Skillset not found", code: "NOT_FOUND" }, 404);
  }

  if (existing.published_by !== publisher.id) {
    return c.json(
      { error: "You are not the publisher of this skillset", code: "FORBIDDEN" },
      403
    );
  }

  let metadata;
  try {
    metadata = await fetchSkillsetFromGitHub(existing.source_url);
  } catch (err: any) {
    return c.json(
      {
        error: `Could not fetch or parse SKILLSET.md: ${err.message}`,
        code: "UNPROCESSABLE",
      },
      422
    );
  }

  const validation = validateSkillset({
    skillsetMd: metadata.skillsetMd,
    files: metadata.files,
    embeddedSkillNames: metadata.embeddedSkillNames,
    remoteSkillRefs: metadata.skillRefs.filter(
      (r) => !metadata.embeddedSkillNames.includes(r.name)
    ),
  });

  // Coherence is recomputed here for the same reason the score is: a PATCH re-fetches the
  // source, so a stored ratio describing an older tree would outlive the tree it described.
  const outcome = await computeCoherence(metadata);
  if (!outcome.ok) {
    return c.json({ error: outcome.reason, code: "UNPROCESSABLE" }, 422);
  }

  // Same fallback and default as the POST path — a re-fetch must not blank a description
  // or null a NOT NULL column that the original insert populated.
  const updated = await updateSkillset(name, {
    description: metadata.description || metadata.name || existing.description,
    score: validation.score,
    spec_version: SKILLSET_SPEC_VERSION,
    skill_refs: metadata.skillRefs,
    members_checked: outcome.coherence.membersChecked,
    members_coherent: outcome.coherence.membersCoherent,
    coherence: outcome.coherence,
  });

  return c.json({
    skillset: skillsetRowToApi(updated!),
    diagnostics: validation.diagnostics,
    coherence: outcome.coherence,
  });
});

// DELETE /skillsets/:name — remove a skillset from the registry
skillsetsPublishRoutes.delete("/:name", requireAuth, async (c) => {
  const name = c.req.param("name");
  const publisher = c.get("publisher");

  const existing = await getSkillsetByName(name);
  if (!existing) {
    return c.json({ error: "Skillset not found", code: "NOT_FOUND" }, 404);
  }

  if (existing.published_by !== publisher.id) {
    return c.json(
      { error: "You are not the publisher of this skillset", code: "FORBIDDEN" },
      403
    );
  }

  await deleteSkillset(name);
  await syncSkillsetCount("delete");

  return c.json({ success: true });
});
