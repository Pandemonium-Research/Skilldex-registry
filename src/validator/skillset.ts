import { parse as parseYaml } from "yaml";
import type { ValidationDiagnostic } from "../types/api.js";

const MIN_DESCRIPTION_WORDS = 30;

// Scoring weights, summing to 100 and matching skilldex's
// src/core/skillset-validator.ts table entry for entry.
//
// Score ACCUMULATES from 0: a check adds its weight only when it passes. See the
// note in ./index.ts — descriptionLength is nested inside the `else` of
// descriptionPresent, so under a count-down scheme a *missing* description would
// cost less than a *short* one. Keep this accumulating.
const WEIGHTS = {
  frontmatterParseable: 25,
  namePresent: 10,
  descriptionPresent: 10,
  descriptionLength: 10,
  hasSkills: 20,
  allowedSubdirs: 10,
  validSourceUrls: 15,
} as const;

export interface SkillsetValidatorInput {
  skillsetMd: string;
  files: string[];
  embeddedSkillNames: string[];
  remoteSkillRefs: Array<{ name: string; source_url: string }>;
}

export interface SkillsetValidationResult {
  score: number;
  diagnostics: ValidationDiagnostic[];
}

export function validateSkillset(input: SkillsetValidatorInput): SkillsetValidationResult {
  const diagnostics: ValidationDiagnostic[] = [];
  let score = 0;

  // --- Check 1: YAML frontmatter parseable (25 points) ---
  const frontmatter = extractFrontmatter(input.skillsetMd);
  if (!frontmatter) {
    diagnostics.push({
      level: "error",
      line: 1,
      message: "YAML frontmatter is missing or unparseable",
    });
    return { score: 0, diagnostics };
  }

  const parsed = parseFrontmatter(frontmatter);
  if (!parsed) {
    diagnostics.push({
      level: "error",
      line: 1,
      message: "YAML frontmatter could not be parsed",
    });
    return { score: 0, diagnostics };
  }

  score += WEIGHTS.frontmatterParseable;

  // --- Check 2: `name` field present (10 points) ---
  if (!parsed.name || typeof parsed.name !== "string" || parsed.name.trim() === "") {
    diagnostics.push({
      level: "error",
      line: null,
      message: 'Required field "name" is missing or empty',
    });
  } else {
    score += WEIGHTS.namePresent;
  }

  // --- Check 3: `description` field present (10 points) ---
  if (!parsed.description || typeof parsed.description !== "string" || parsed.description.trim() === "") {
    diagnostics.push({
      level: "error",
      line: null,
      message: 'Required field "description" is missing or empty',
    });
    // descriptionLength is forfeited with it — there is no description to measure.
  } else {
    score += WEIGHTS.descriptionPresent;

    // --- Check 4: description length >= 30 words (10 points) ---
    const wordCount = parsed.description.trim().split(/\s+/).length;
    if (wordCount < MIN_DESCRIPTION_WORDS) {
      diagnostics.push({
        level: "error",
        line: null,
        message: `description too short (${wordCount} words, recommended ${MIN_DESCRIPTION_WORDS}+)`,
      });
    } else {
      score += WEIGHTS.descriptionLength;
    }
  }

  // --- Check 5: at least 1 skill (20 points) ---
  const totalSkills = input.embeddedSkillNames.length + input.remoteSkillRefs.length;
  if (totalSkills === 0) {
    diagnostics.push({
      level: "error",
      line: null,
      message: "Skillset must contain at least one embedded skill or remote skill reference",
    });
  } else {
    score += WEIGHTS.hasSkills;
  }

  // --- Check 6: no unknown top-level dirs (10 points) ---
  const embeddedSet = new Set(input.embeddedSkillNames);
  const unknownDirs = getUnknownDirs(input.files, embeddedSet);
  // Partial credit: 3 points per unknown dir, floored at 0 rather than going negative.
  score += Math.max(0, WEIGHTS.allowedSubdirs - Math.min(WEIGHTS.allowedSubdirs, unknownDirs.length * 3));
  for (const dir of unknownDirs) {
    diagnostics.push({
      level: "warning",
      line: null,
      message: `Unknown subdirectory "${dir}" — only embedded skill dirs (with SKILL.md) and assets/ are allowed`,
    });
  }

  // --- Check 7: remote source_url fields are valid GitHub URLs (15 points) ---
  // No remote refs means nothing can be invalid, so the check passes on an empty set.
  const invalidRefs = input.remoteSkillRefs.filter((s) => !isValidGitHubUrl(s.source_url));
  if (invalidRefs.length > 0) {
    for (const ref of invalidRefs) {
      diagnostics.push({
        level: "error",
        line: null,
        message: `Remote skill "${ref.name}" has invalid source_url: "${ref.source_url}" — must be a GitHub URL`,
      });
    }
  } else {
    score += WEIGHTS.validSourceUrls;
  }

  score = Math.min(100, Math.max(0, Math.round(score)));

  return { score, diagnostics };
}

// --- Helpers ---

function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

function parseFrontmatter(frontmatter: string): Record<string, any> | null {
  try {
    const result = parseYaml(frontmatter);
    if (typeof result !== "object" || result === null) return null;
    return result as Record<string, any>;
  } catch {
    return null;
  }
}

function getUnknownDirs(files: string[], embeddedSet: Set<string>): string[] {
  const topLevelDirs = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    if (parts.length >= 2) {
      topLevelDirs.add(parts[0]);
    }
  }

  const unknown: string[] = [];
  for (const dir of topLevelDirs) {
    if (dir === "assets") continue;
    if (embeddedSet.has(dir)) continue;
    unknown.push(dir);
  }
  return unknown;
}

function isValidGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "github.com" && parsed.protocol === "https:";
  } catch {
    return false;
  }
}
