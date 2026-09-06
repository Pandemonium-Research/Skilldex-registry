// NOTE: This validator is duplicated in skilldex and skilldex-registry.
// Keep both in sync manually. Extract to @skilldex/validator package
// when drift becomes a real problem (i.e. you have fixed the same bug twice).
//
// Mirrors skilldex's src/core/validator.ts as of skillpm v1.1.2
// (spec MUST-rule checks + spec-derived conformance weights).

import { parse as parseYaml } from "yaml";
import type { ValidationDiagnostic } from "../types/api.js";

const MAX_LINES = 500;
const WARN_LINES = 400;
const MIN_DESCRIPTION_WORDS = 30;
const MAX_DESCRIPTION_CHARS = 1024;
const ALLOWED_SUBDIRS = new Set(["scripts", "references", "assets"]);
// name must be kebab-case: lowercase letters/digits separated by single hyphens
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// "claude" and "anthropic" are reserved and cannot appear in a skill name
const RESERVED_NAME_WORDS = ["claude", "anthropic"];

// File extensions that are misplaced if found in the wrong directory
const SCRIPT_EXTENSIONS = new Set([".sh", ".py", ".js", ".ts", ".rb"]);
const DOC_EXTENSIONS = new Set([".md", ".txt", ".pdf"]);

// Scoring weights — derived from a 2-axis spec rubric (mandate x failure impact),
// normalized to 100. These sum to exactly 100 and match skilldex's table entry for
// entry.
//
// Score ACCUMULATES from 0: a check adds its weight only when it passes. Do not
// rewrite this as "start at 100, subtract on failure". The two are NOT equivalent,
// because several checks are nested inside the `else` of a prerequisite —
// nameFormat only runs when a name exists; descriptionLength and descriptionFormat
// only when a description exists. Accumulating, a missing prerequisite forfeits its
// dependent weights automatically. Subtracting, those deductions are simply never
// reached, so a *missing* field costs less than a *malformed* one.
//
// That inversion is the bug this file shipped from 2026-07-09 (d15aa6c, which
// copied skilldex's weights and branch shape into a count-down loop) until
// 2026-09-04: a missing name scored 84 here against skilldex's 73, and a missing
// description 84 against 67.
const WEIGHTS = {
  frontmatterParseable: 16,
  namePresent: 16,
  nameFormat: 11,
  descriptionPresent: 16,
  descriptionLength: 6,
  descriptionFormat: 11,
  lineCount: 7,
  allowedSubdirs: 4,
  noReadme: 4,
  referencedResourcesExist: 7,
  bundledResourcesCorrect: 2,
} as const;

export interface ValidatorInput {
  /** The raw SKILL.md content */
  skillMd: string;
  /** List of files in the skill directory (relative paths) */
  files: string[];
}

export interface ValidationResult {
  score: number;
  diagnostics: ValidationDiagnostic[];
}

export function validateSkill(input: ValidatorInput): ValidationResult {
  const diagnostics: ValidationDiagnostic[] = [];
  let score = 0;

  const lines = input.skillMd.split("\n");

  // --- Check: YAML frontmatter parseable (fatal on failure) ---
  const frontmatter = extractFrontmatter(input.skillMd);
  if (!frontmatter) {
    diagnostics.push({
      level: "error",
      line: 1,
      message: "YAML frontmatter is missing or unparseable",
    });
    // Fatal — blocks all other frontmatter-dependent checks
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

  // --- Check: `name` field present (16 pts) ---
  const nameValue = parsed.name == null ? "" : String(parsed.name).trim();
  if (nameValue === "") {
    diagnostics.push({
      level: "error",
      line: 1,
      message: "Missing required field: name",
    });
    // nameFormat is forfeited with it — there is no name to check the format of.
  } else {
    score += WEIGHTS.namePresent;

    // --- Check: `name` format — kebab-case + not reserved (11 pts) ---
    const nameErrors: string[] = [];
    if (!KEBAB_CASE.test(nameValue)) {
      nameErrors.push(
        `name "${nameValue}" is not kebab-case — use lowercase letters, digits, and hyphens only`
      );
    }
    const reserved = RESERVED_NAME_WORDS.find((w) => nameValue.toLowerCase().includes(w));
    if (reserved) {
      nameErrors.push(
        `name contains reserved word "${reserved}" — "claude" and "anthropic" are reserved`
      );
    }
    if (nameErrors.length > 0) {
      for (const message of nameErrors) {
        diagnostics.push({ level: "error", line: 1, message });
      }
    } else {
      score += WEIGHTS.nameFormat;
    }
  }

  // --- Check: `description` field present (16 pts) ---
  const descValue = parsed.description == null ? "" : String(parsed.description).trim();
  if (descValue === "") {
    diagnostics.push({
      level: "error",
      line: 1,
      message: "Missing required field: description",
    });
    // descriptionLength and descriptionFormat are forfeited with it — there is no
    // description to measure or format-check.
  } else {
    score += WEIGHTS.descriptionPresent;

    // --- Check: description length >= 30 words (6 pts) ---
    const wordCount = descValue.split(/\s+/).length;
    if (wordCount < MIN_DESCRIPTION_WORDS) {
      diagnostics.push({
        level: "error",
        line: 1,
        message: `Description is ${wordCount} words (minimum ${MIN_DESCRIPTION_WORDS})`,
      });
    } else {
      score += WEIGHTS.descriptionLength;
    }

    // --- Check: description format — char limit + no XML tags (11 pts) ---
    const descErrors: string[] = [];
    if (descValue.length > MAX_DESCRIPTION_CHARS) {
      descErrors.push(
        `Description exceeds ${MAX_DESCRIPTION_CHARS} characters (current: ${descValue.length})`
      );
    }
    if (/[<>]/.test(descValue)) {
      descErrors.push(
        "Description contains XML angle brackets (< >) — not allowed in frontmatter"
      );
    }
    if (descErrors.length > 0) {
      for (const message of descErrors) {
        diagnostics.push({ level: "error", line: 1, message });
      }
    } else {
      score += WEIGHTS.descriptionFormat;
    }
  }

  // --- Check: SKILL.md under 500 lines (7 pts, lost only past the hard limit) ---
  if (lines.length > MAX_LINES) {
    diagnostics.push({
      level: "error",
      line: MAX_LINES,
      message: `SKILL.md is ${lines.length} lines (maximum ${MAX_LINES})`,
    });
  } else if (lines.length > WARN_LINES) {
    // The 400-500 band warns but keeps full credit, matching skilldex.
    score += WEIGHTS.lineCount;
    diagnostics.push({
      level: "warning",
      line: WARN_LINES,
      message: `SKILL.md is ${lines.length} lines (warning threshold ${WARN_LINES})`,
    });
  } else {
    score += WEIGHTS.lineCount;
  }

  // --- Check: only allowed subdirectories (4 pts) + no README.md (4 pts) ---
  const dirs = new Set<string>();
  let hasReadme = false;
  for (const file of input.files) {
    const parts = file.split("/");
    if (parts.length > 1) {
      dirs.add(parts[0]);
    } else if (file.toLowerCase() === "readme.md") {
      hasReadme = true;
    }
  }

  let unknownDirCount = 0;
  for (const dir of dirs) {
    if (!ALLOWED_SUBDIRS.has(dir) && !dir.startsWith(".")) {
      diagnostics.push({
        level: "warning",
        line: null,
        message: `Unknown subdirectory: ${dir}/ (allowed: ${[...ALLOWED_SUBDIRS].join(", ")})`,
      });
      unknownDirCount++;
    }
  }
  // Partial credit: 2 points per unknown dir, floored at 0 rather than going negative.
  score += Math.max(0, WEIGHTS.allowedSubdirs - unknownDirCount * 2);

  if (hasReadme) {
    diagnostics.push({
      level: "warning",
      line: null,
      message:
        "README.md should not be inside the skill folder — put docs in SKILL.md or references/",
    });
  } else {
    score += WEIGHTS.noReadme;
  }

  // --- Check: all referenced resources exist (7 pts) ---
  const references = extractReferences(input.skillMd);
  const fileSet = new Set(input.files);
  let hasBrokenRef = false;
  for (const ref of references) {
    if (!fileSet.has(ref)) {
      diagnostics.push({
        level: "error",
        line: null,
        message: `References ${ref} but file not found`,
      });
      hasBrokenRef = true;
    }
  }
  if (!hasBrokenRef) {
    score += WEIGHTS.referencedResourcesExist;
  }

  // --- Check: bundled resources in correct subdirs (2 pts) ---
  let hasMisplacedFile = false;
  for (const file of input.files) {
    const parts = file.split("/");
    if (parts.length < 2) continue;
    const dir = parts[0];
    const ext = getExtension(file);

    if (dir === "references" && SCRIPT_EXTENSIONS.has(ext)) {
      diagnostics.push({
        level: "warning",
        line: null,
        message: `Script file ${file} found in references/ (should be in scripts/)`,
      });
      hasMisplacedFile = true;
    }

    if (dir === "scripts" && DOC_EXTENSIONS.has(ext)) {
      diagnostics.push({
        level: "warning",
        line: null,
        message: `Document file ${file} found in scripts/ (should be in references/)`,
      });
      hasMisplacedFile = true;
    }
  }
  if (!hasMisplacedFile) {
    score += WEIGHTS.bundledResourcesCorrect;
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    diagnostics,
  };
}

// --- Helpers ---

function extractFrontmatter(content: string): string | null {
  // \r? on both delimiters: a SKILL.md authored on Windows opens with "---\r\n", which a
  // bare \n pattern does not match. Such files were reported as having no frontmatter at
  // all — the fetcher threw PARSE_FAILED and the validator scored them 0 — even though the
  // YAML itself is well-formed and the parser handles CRLF without complaint.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}

function parseFrontmatter(yaml: string): Record<string, any> | null {
  try {
    return parseYaml(yaml) as Record<string, any>;
  } catch {
    return null;
  }
}

function extractReferences(content: string): string[] {
  const refs: string[] = [];
  // Match markdown-style references to local files
  const patterns = [
    /\[.*?\]\(((?:scripts|references|assets)\/[^\)]+)\)/g,
    /`((?:scripts|references|assets)\/[^`]+)`/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      refs.push(match[1]);
    }
  }
  return [...new Set(refs)];
}

function getExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex) : "";
}
