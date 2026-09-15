// The skillset rubric is @skilldex/validator, shared with skilldex. This file is the adapter: it
// takes what the registry has — SKILLSET.md, a tree listing, and the members and remote references
// it parsed while fetching — and returns what the registry's API serves.
//
// It was a hand-maintained copy, and it had drifted from skilldex in the two ways the skill
// validator beside it had: it required the frontmatter fence to be exactly `---`, where a trailing
// space is a legal document marker, and it reported a short description as an error where
// `skillpm validate` reports a warning. Both are settled in the shared rubric.

import {
  SKILLSET_SPEC_VERSION as SPEC_VERSION,
  validateSkillset as validateSkillsetContent,
  type RemoteSkillRef,
  type ValidationDiagnostic as RubricDiagnostic,
} from "@skilldex/validator";
import type { ValidationDiagnostic } from "../types/api.js";

/**
 * The skillset spec this validator implements.
 *
 * 1.1 IS the coherence revision: skilldex bumped it in the same commit that added skillset
 * coherence. The registry could only honestly claim 1.0 until it computed coherence too, which it
 * now does (src/validator/skillset-coherence.ts), so both sides say 1.1.
 *
 * Note this is what the validator *implements*, not what a skillset's frontmatter *claims* —
 * storing an author's claim instead would record something no validation ever checked.
 */
export const SKILLSET_SPEC_VERSION = SPEC_VERSION;

export interface SkillsetValidatorInput {
  skillsetMd: string;
  files: string[];
  embeddedSkillNames: string[];
  remoteSkillRefs: RemoteSkillRef[];
}

export interface SkillsetValidationResult {
  score: number;
  diagnostics: ValidationDiagnostic[];
}

export function validateSkillset(input: SkillsetValidatorInput): SkillsetValidationResult {
  const result = validateSkillsetContent({
    skillsetMd: input.skillsetMd,
    files: input.files,
    // Both are passed rather than derived: the fetcher already established which directories hold a
    // SKILL.md, and re-deriving them from the listing here would be a second opinion about the same
    // question.
    embeddedSkillNames: input.embeddedSkillNames,
    remoteSkillRefs: input.remoteSkillRefs,
  });

  return {
    score: result.score,
    // The rubric reports a `pass` for every check that succeeds, which is what `skillpm validate`
    // prints. The API has only ever carried what is wrong.
    diagnostics: result.diagnostics
      .filter((d) => d.severity === "error" || d.severity === "warning")
      .map(toApiDiagnostic),
  };
}

function toApiDiagnostic(d: RubricDiagnostic): ValidationDiagnostic {
  return {
    level: d.severity === "error" ? "error" : "warning",
    // The wire format has always used null for "no line", not an absent field.
    line: d.line ?? null,
    message: d.message,
  };
}
