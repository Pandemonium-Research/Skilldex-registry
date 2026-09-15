// The rubric is @skilldex/validator, shared with skilldex. This file is the adapter: it takes what
// the registry has — SKILL.md content and a stored file list — and returns what the registry's API
// serves.
//
// It used to be a copy of skilldex's validator, kept in sync by hand, under a note reading:
// "Extract to @skilldex/validator package when drift becomes a real problem (i.e. you have fixed
// the same bug twice)." That threshold was reached. The copy shipped an inverted scoring loop from
// 2026-07-09 to 2026-09-04 — a missing name scored 84 here against skilldex's 73 — and by
// 2026-09-15 it had drifted again in four more places: it kept `#anchor`, `"title"` and a
// command's flags inside a filename, ignored references outside the three bundled folders, scored a
// frontmatter fence with a trailing space as 0, and compared file extensions case-sensitively.
//
// There is nothing left here to drift. The one rule this file still owns is how a diagnostic is
// shaped on the wire.

import {
  validateSkill as validateSkillContent,
  type ValidationDiagnostic as RubricDiagnostic,
} from "@skilldex/validator";
import type { ValidationDiagnostic } from "../types/api.js";

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

/**
 * Score a skill from its content and file list.
 *
 * The rubric reports a `pass` diagnostic for every check that succeeds, which is what
 * `skillpm validate` prints. The API has always carried only what is wrong, so passes are dropped
 * here rather than in the rubric — the CLI needs them.
 */
export function validateSkill(input: ValidatorInput): ValidationResult {
  const result = validateSkillContent({ skillMd: input.skillMd, files: input.files });

  return {
    score: result.score,
    diagnostics: result.diagnostics.filter(isReportable).map(toApiDiagnostic),
  };
}

function isReportable(d: RubricDiagnostic): boolean {
  return d.severity === "error" || d.severity === "warning";
}

function toApiDiagnostic(d: RubricDiagnostic): ValidationDiagnostic {
  return {
    level: d.severity === "error" ? "error" : "warning",
    // The wire format has always used null for "no line", not an absent field.
    line: d.line ?? null,
    message: d.message,
  };
}
