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
 * To split the work across multiple terminals, give each one a disjoint
 * --from/--to name range (each range gets its own checkpoint file, so they
 * don't interfere). Note this only helps throughput if each terminal uses a
 * different GITHUB_TOKEN — terminals sharing one token share one 5000/hr
 * quota, so running ranges in parallel spends that quota faster rather than
 * raising it.
 *
 * Usage:
 *   npm run rescore                          — local (loads .env), resumes automatically
 *   npm run rescore -- --dry-run             — print the changes without writing them
 *   npm run rescore -- --restart             — ignore any checkpoint and start from the top
 *   npm run rescore -- --from=m --to=z       — only process skills with m <= name < z
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

function getArg(flag: string): string | undefined {
  const prefix = `${flag}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const DRY_RUN = process.argv.includes("--dry-run");
const RESTART = process.argv.includes("--restart");
const RANGE_FROM = getArg("--from"); // inclusive
const RANGE_TO = getArg("--to"); // exclusive

if (RANGE_FROM && RANGE_TO && RANGE_FROM >= RANGE_TO) {
  console.error(`--from (${RANGE_FROM}) must sort before --to (${RANGE_TO})`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Delay between GitHub API calls to stay within rate limits.
// 300ms → ~200 req/min, well within the 5000/hr authenticated limit.
const DELAY_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Dry runs, real runs, and each --from/--to range track progress separately,
// so parallel terminals (and a preview run) never clobber each other's
// checkpoint or cause a real run to skip skills it hasn't actually written.
function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rangeSuffix =
  RANGE_FROM || RANGE_TO
    ? `.${sanitizeForFilename(RANGE_FROM ?? "start")}-${sanitizeForFilename(RANGE_TO ?? "end")}`
    : "";
const CHECKPOINT_PATH = path.join(
  __dirname,
  `.rescore-checkpoint${DRY_RUN ? ".dryrun" : ""}${rangeSuffix}.json`
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

interface SkillRow {
  name: string;
  source_url: string;
  score: number | null;
}

// PostgREST caps rows-per-request (commonly 1000) regardless of how many
// actually match, so a plain .select() silently truncates on a table this
// size. Page through with .range() until a page comes back short.
async function loadAllSkills(): Promise<SkillRow[]> {
  const PAGE_SIZE = 1000;
  const skills: SkillRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("skills")
      .select("name, source_url, score")
      .order("name")
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to load skills: ${error.message}`);
    }
    if (!data || data.length === 0) break;

    skills.push(...(data as SkillRow[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return skills;
}

async function rescore() {
  const rangeLabel = RANGE_FROM || RANGE_TO ? ` [${RANGE_FROM ?? "start"}, ${RANGE_TO ?? "end"})` : "";
  console.log(`Skilldex Registry — rescore all skills${DRY_RUN ? " (dry run)" : ""}${rangeLabel}\n`);

  const allSkills = await loadAllSkills();
  const skills = allSkills.filter((s) => {
    if (RANGE_FROM && s.name < RANGE_FROM) return false;
    if (RANGE_TO && s.name >= RANGE_TO) return false;
    return true;
  });

  const checkpoint = await loadCheckpoint();
  const toProcess = checkpoint ? skills.filter((s) => s.name > checkpoint) : skills;

  if (checkpoint) {
    console.log(
      `Resuming after "${checkpoint}" — ${skills.length - toProcess.length} already done this run, ${toProcess.length} remaining\n`
    );
  } else {
    console.log(
      `Loaded ${allSkills.length} skills${rangeLabel ? `, ${skills.length} in range` : ""}\n`
    );
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
