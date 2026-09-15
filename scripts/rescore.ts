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
 * Scope: curated rows only (source <> 'imported'). The imported corpus is scored at import
 * time by scripts/corpus/build.ts from the dataset's own file lists, and re-scoring it here
 * would mean a GitHub round trip per row plus an UPDATE that fires skills_au and rewrites
 * both FTS5 tables for each one (see the note at the foot of
 * schema/sqlite/002_source_and_stats.sql). Rebuild and swap instead. --include-imported
 * exists for a deliberate, narrow repair, never a bulk pass.
 *
 * Required env vars: TURSO_DATABASE_URL
 * Optional:          TURSO_AUTH_TOKEN, GITHUB_TOKEN (raises GitHub API rate limit to 5000/hr)
 */

import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../src/db/client.js";
import { fetchSkillFromGitHub, findRelocatedSkill, type SkillMetadata } from "../src/github/fetch.js";
import { validateSkill } from "../src/validator/index.js";

if (!process.env.TURSO_DATABASE_URL) {
  console.error("Missing TURSO_DATABASE_URL");
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
const INCLUDE_IMPORTED = process.argv.includes("--include-imported");

if (RANGE_FROM && RANGE_TO && RANGE_FROM >= RANGE_TO) {
  console.error(`--from (${RANGE_FROM}) must sort before --to (${RANGE_TO})`);
  process.exit(1);
}

const db = getDb();

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

/** Where a run stopped. Both halves, for the reason loadAllSkills explains. */
interface Checkpoint {
  lastProcessedName: string;
  lastProcessedOwner: string;
}

async function loadCheckpoint(): Promise<Checkpoint | null> {
  if (RESTART) return null;
  try {
    const raw = await readFile(CHECKPOINT_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<Checkpoint>;
    // A checkpoint written before the owner half existed cannot say where the run stopped,
    // because names repeat across owners. Start over rather than skip work.
    if (!parsed.lastProcessedName || !parsed.lastProcessedOwner) return null;
    return {
      lastProcessedName: parsed.lastProcessedName,
      lastProcessedOwner: parsed.lastProcessedOwner,
    };
  } catch {
    return null;
  }
}

async function saveCheckpoint(name: string, owner: string): Promise<void> {
  await writeFile(
    CHECKPOINT_PATH,
    JSON.stringify({ lastProcessedName: name, lastProcessedOwner: owner }),
    "utf8"
  );
}

async function clearCheckpoint(): Promise<void> {
  try {
    await unlink(CHECKPOINT_PATH);
  } catch {
    // nothing to remove
  }
}

interface SkillRow {
  // `owner` is selected by loadAllSkills and used to scope the update below. It was missing
  // from this interface and nothing complained, because scripts/ was outside the typecheck.
  owner: string;
  name: string;
  source_url: string;
  score: number | null;
}

// Keyset pagination, not OFFSET: with --include-imported this walks a 1.6M-row table, and a
// growing OFFSET rescans everything it skips.
//
// Ordered by (name, owner), which is also what the checkpoint stores. Ordering by owner while
// checkpointing on the name alone — what this did before — silently skipped work on resume:
// once owner "a" finished at name "zebra", every later owner's skills sorting before "zebra"
// looked already-done and were filtered out.
async function loadAllSkills(): Promise<SkillRow[]> {
  const PAGE_SIZE = 1000;
  const skills: SkillRow[] = [];
  let afterName = "";
  let afterOwner = "";

  while (true) {
    const result = await db.execute({
      sql: `SELECT owner, name, source_url, score
              FROM skills
             WHERE (name > ? OR (name = ? AND owner > ?))
               ${INCLUDE_IMPORTED ? "" : "AND source <> 'imported'"}
             ORDER BY name, owner
             LIMIT ?`,
      args: [afterName, afterName, afterOwner, PAGE_SIZE],
    });

    const page: SkillRow[] = result.rows.map((r) => ({
      owner: String(r.owner),
      name: String(r.name),
      source_url: String(r.source_url),
      score: r.score === null ? null : Number(r.score),
    }));
    if (page.length === 0) break;

    skills.push(...page);
    if (page.length < PAGE_SIZE) break;
    afterName = page[page.length - 1].name;
    afterOwner = page[page.length - 1].owner;
  }

  return skills;
}

async function rescore() {
  const rangeLabel = RANGE_FROM || RANGE_TO ? ` [${RANGE_FROM ?? "start"}, ${RANGE_TO ?? "end"})` : "";
  console.log(`Skilldex Registry — rescore skills${DRY_RUN ? " (dry run)" : ""}${rangeLabel}`);
  console.log(
    INCLUDE_IMPORTED
      ? "scope: every row, imported included — one GitHub fetch each, and every write rewrites\n" +
          "       both FTS5 tables. Narrow it with --from/--to; rebuild and swap for bulk work.\n"
      : "scope: curated rows (source <> 'imported')\n"
  );

  const allSkills = await loadAllSkills();
  const skills = allSkills.filter((s) => {
    if (RANGE_FROM && s.name < RANGE_FROM) return false;
    if (RANGE_TO && s.name >= RANGE_TO) return false;
    return true;
  });

  const checkpoint = await loadCheckpoint();
  const toProcess = checkpoint
    ? skills.filter(
        (s) =>
          s.name > checkpoint.lastProcessedName ||
          (s.name === checkpoint.lastProcessedName && s.owner > checkpoint.lastProcessedOwner)
      )
    : skills;

  if (checkpoint) {
    console.log(
      `Resuming after "${checkpoint.lastProcessedOwner}/${checkpoint.lastProcessedName}" — ${skills.length - toProcess.length} already done this run, ${toProcess.length} remaining\n`
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
        try {
          await db.execute({
            // Scope by owner too: names are only unique within an owner, so filtering
            // on name alone would rewrite every same-named skill in the registry.
            sql: `UPDATE skills
                     SET source_url = ?,
                         score = ?,
                         description = ?,
                         spec_version = ?,
                         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                   WHERE owner = ? AND name = ?`,
            args: [
              resolvedSourceUrl,
              newScore,
              metadata.description,
              metadata.spec_version,
              skill.owner,
              skill.name,
            ],
          });
        } catch (updateError: any) {
          console.log(`    ✗ Failed to write update: ${updateError.message}`);
          failed++;
        }
      }
    } catch (err: any) {
      console.log(`  ✗ ${skill.name}: ${err.message}`);
      failed++;
    } finally {
      await saveCheckpoint(skill.name, skill.owner);
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
