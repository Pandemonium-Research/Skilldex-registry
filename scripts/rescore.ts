/**
 * Skilldex Registry — force re-validation of all skills already in the registry.
 *
 * Re-fetches each skill's SKILL.md from its source_url and re-runs the
 * validator, updating the stored score (and description/spec_version, which
 * can drift if the upstream skill changed). Run this after a validator
 * scoring-rule update so existing skills reflect the new rubric instead of
 * only being re-scored the next time they're individually re-published.
 *
 * If source_url 404s (e.g. the upstream repo reorganized its directories),
 * falls back to scanning the repo's current tree for a SKILL.md whose
 * frontmatter name matches, and updates source_url to the new location.
 * Skills that can't be found anywhere in the repo are reported at the end
 * for manual review instead of being silently skipped.
 *
 * Progress is checkpointed to disk after every skill, so if the run is
 * interrupted (Ctrl+C, crash, closed terminal) re-running the same command
 * resumes right after the last skill it finished, instead of starting over.
 * Dry runs and real runs checkpoint separately. A full, uninterrupted run
 * clears its checkpoint at the end.
 *
 * Usage:
 *   npm run rescore                  — local (loads .env), resumes automatically
 *   npm run rescore -- --dry-run     — print the changes without writing them
 *   npm run rescore -- --restart     — ignore any checkpoint and start from the top
 *
 * Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional:          GITHUB_TOKEN (raises GitHub API rate limit to 5000/hr)
 */

import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { fetchSkillFromGitHub, findRelocatedSkill, type SkillMetadata } from "../src/github/fetch.js";
import { validateSkill } from "../src/validator/index.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const DRY_RUN = process.argv.includes("--dry-run");
const RESTART = process.argv.includes("--restart");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Delay between GitHub API calls to stay within rate limits.
// 300ms → ~200 req/min, well within the 5000/hr authenticated limit.
const DELAY_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Dry runs and real runs track progress separately so a preview run never
// causes a later real run to skip skills it hasn't actually written yet.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKPOINT_PATH = path.join(
  __dirname,
  DRY_RUN ? ".rescore-checkpoint.dryrun.json" : ".rescore-checkpoint.json"
);

async function loadCheckpoint(): Promise<string | null> {
  if (RESTART) return null;
  try {
    const raw = await readFile(CHECKPOINT_PATH, "utf8");
    const parsed = JSON.parse(raw) as { lastProcessedName?: string };
    return parsed.lastProcessedName ?? null;
  } catch {
    return null;
  }
}

async function saveCheckpoint(name: string): Promise<void> {
  await writeFile(CHECKPOINT_PATH, JSON.stringify({ lastProcessedName: name }), "utf8");
}

async function clearCheckpoint(): Promise<void> {
  try {
    await unlink(CHECKPOINT_PATH);
  } catch {
    // nothing to remove
  }
}

async function rescore() {
  console.log(`Skilldex Registry — rescore all skills${DRY_RUN ? " (dry run)" : ""}\n`);

  const { data: skills, error } = await supabase
    .from("skills")
    .select("name, source_url, score")
    .order("name");

  if (error || !skills) {
    console.error("Failed to load skills:", error?.message);
    return;
  }

  const checkpoint = await loadCheckpoint();
  const toProcess = checkpoint ? skills.filter((s) => s.name > checkpoint) : skills;

  if (checkpoint) {
    console.log(
      `Resuming after "${checkpoint}" — ${skills.length - toProcess.length} already done this run, ${toProcess.length} remaining\n`
    );
  } else {
    console.log(`Loaded ${skills.length} skills\n`);
  }

  let changed = 0;
  let unchanged = 0;
  let relocatedCount = 0;
  let failed = 0;
  const needsReview: string[] = [];

  for (const skill of toProcess) {
    await sleep(DELAY_MS);

    try {
      let metadata: SkillMetadata;
      let resolvedSourceUrl = skill.source_url;

      try {
        metadata = await fetchSkillFromGitHub(skill.source_url);
      } catch (fetchErr: any) {
        console.log(
          `  ? ${skill.name}: ${fetchErr.message} — searching repo for a relocated SKILL.md...`
        );
        const relocated = await findRelocatedSkill(skill.source_url, skill.name);

        if (!relocated) {
          console.log(`  ✗ ${skill.name}: not found anywhere in the repo`);
          needsReview.push(skill.name);
          failed++;
          continue;
        }

        console.log(`  ↻ ${skill.name}: relocated -> ${relocated.sourceUrl}`);
        metadata = relocated.metadata;
        resolvedSourceUrl = relocated.sourceUrl;
        relocatedCount++;
      }

      const validation = validateSkill({
        skillMd: metadata.skillMd,
        files: metadata.files,
      });

      const oldScore = skill.score;
      const newScore = validation.score;
      const urlChanged = resolvedSourceUrl !== skill.source_url;

      if (oldScore === newScore && !urlChanged) {
        console.log(`  = ${skill.name}: ${newScore} (unchanged)`);
        unchanged++;
        continue;
      }

      if (!urlChanged) {
        console.log(`  ~ ${skill.name}: ${oldScore} -> ${newScore}`);
      }
      changed++;

      if (!DRY_RUN) {
        const { error: updateError } = await supabase
          .from("skills")
          .update({
            source_url: resolvedSourceUrl,
            score: newScore,
            description: metadata.description,
            spec_version: metadata.spec_version,
            updated_at: new Date().toISOString(),
          })
          .eq("name", skill.name);

        if (updateError) {
          console.log(`    ✗ Failed to write update: ${updateError.message}`);
          failed++;
        }
      }
    } catch (err: any) {
      console.log(`  ✗ ${skill.name}: ${err.message}`);
      failed++;
    } finally {
      await saveCheckpoint(skill.name);
    }
  }

  console.log(
    `\nDone! Changed: ${changed}, Relocated: ${relocatedCount}, Unchanged: ${unchanged}, Failed: ${failed}${
      DRY_RUN ? "\n(dry run — no changes were written)" : ""
    }`
  );

  if (needsReview.length > 0) {
    console.log(
      `\nNeeds manual review (SKILL.md not found anywhere in the repo — renamed, removed, or repo gone):`
    );
    for (const name of needsReview) {
      console.log(`  - ${name}`);
    }
  }

  // Ran to completion without being interrupted — clear the checkpoint so the
  // next invocation (e.g. after another rubric change) starts fresh.
  await clearCheckpoint();
}

rescore().catch((err) => {
  console.error("Rescore failed:", err);
  process.exit(1);
});
