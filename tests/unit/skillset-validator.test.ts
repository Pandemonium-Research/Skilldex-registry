import { describe, it, expect } from "vitest";
import { validateSkillset, type SkillsetValidatorInput } from "../../src/validator/skillset.js";

// Mirrored from src/validator/skillset.ts. Duplicated on purpose: edit a weight there
// without rebalancing and the arithmetic below fails loudly.
const W = {
  frontmatterParseable: 25,
  namePresent: 10,
  descriptionPresent: 10,
  descriptionLength: 10,
  hasSkills: 20,
  allowedSubdirs: 10,
  validSourceUrls: 15,
} as const;

const PERFECT = 100;

// 33 words — comfortably over the 30-word floor, so length never silently confounds a
// test that is trying to isolate some other failure.
const GOOD_DESCRIPTION =
  "A bundle of complementary skills for digital forensics work that share commit conventions " +
  "and changelog formatting rules so their outputs agree with one another across the whole " +
  "investigation workflow for the wider team.";

function skillsetMd(opts: { name?: string | null; description?: string | null } = {}): string {
  const name = opts.name === undefined ? "forensics-suite" : opts.name;
  const description = opts.description === undefined ? GOOD_DESCRIPTION : opts.description;
  return (
    "---\n" +
    (name ? `name: ${name}\n` : "") +
    (description ? `description: ${description}\n` : "") +
    "---\n\n# Forensics Suite\n"
  );
}

function input(over: Partial<SkillsetValidatorInput> = {}): SkillsetValidatorInput {
  return {
    skillsetMd: skillsetMd(),
    files: ["disk-imaging/SKILL.md"],
    embeddedSkillNames: ["disk-imaging"],
    remoteSkillRefs: [],
    ...over,
  };
}

describe("validateSkillset — scoring", () => {
  it("guards the fixture itself: GOOD_DESCRIPTION clears the 30-word floor", () => {
    // Without this, shortening the constant would quietly cost every test 10 points and
    // look like a scoring bug. This exact trap cost a debugging cycle on 2026-09-04.
    expect(GOOD_DESCRIPTION.trim().split(/\s+/).length).toBeGreaterThanOrEqual(30);
  });

  it("awards a perfect score to a well-formed skillset", () => {
    expect(validateSkillset(input()).score).toBe(PERFECT);
  });

  it("scores 0 when frontmatter is missing", () => {
    const result = validateSkillset(input({ skillsetMd: "# No frontmatter here\n" }));
    expect(result.score).toBe(0);
    expect(result.diagnostics[0].level).toBe("error");
  });

  it("charges namePresent when name is missing", () => {
    const result = validateSkillset(input({ skillsetMd: skillsetMd({ name: null }) }));
    expect(result.score).toBe(PERFECT - W.namePresent); // 90
    expect(result.diagnostics.find((d) => d.message.includes("name"))).toBeDefined();
  });

  it("charges only descriptionLength for a short description", () => {
    const result = validateSkillset(
      input({ skillsetMd: skillsetMd({ description: "Too short." }) })
    );
    expect(result.score).toBe(PERFECT - W.descriptionLength); // 90
  });

  it("charges hasSkills for a skillset with no members", () => {
    const result = validateSkillset(
      input({ files: [], embeddedSkillNames: [], remoteSkillRefs: [] })
    );
    expect(result.score).toBe(PERFECT - W.hasSkills); // 80
  });

  it("charges validSourceUrls for a non-GitHub remote ref", () => {
    const result = validateSkillset(
      input({ remoteSkillRefs: [{ name: "x", source_url: "http://evil.test/x" }] })
    );
    expect(result.score).toBe(PERFECT - W.validSourceUrls); // 85
    expect(result.diagnostics.find((d) => d.message.includes("source_url"))).toBeDefined();
  });

  it("keeps full credit when there are no remote refs to validate", () => {
    expect(validateSkillset(input({ remoteSkillRefs: [] })).score).toBe(PERFECT);
  });

  it("charges 3 points per unknown subdirectory", () => {
    const result = validateSkillset(
      input({ files: ["disk-imaging/SKILL.md", "weird/f.txt"] })
    );
    expect(result.score).toBe(PERFECT - 3); // 97
    expect(result.diagnostics.find((d) => d.message.includes("Unknown subdirectory"))).toBeDefined();
  });

  it("floors the subdirectory penalty at its weight rather than going negative", () => {
    const result = validateSkillset(
      input({
        files: ["disk-imaging/SKILL.md", "a/f", "b/f", "c/f", "d/f", "e/f"],
      })
    );
    // 5 unknown dirs x 3 = 15, capped at the 10-point weight.
    expect(result.score).toBe(PERFECT - W.allowedSubdirs); // 90
  });

  it("treats assets/ as an allowed directory", () => {
    const result = validateSkillset(
      input({ files: ["disk-imaging/SKILL.md", "assets/commit-conventions.md"] })
    );
    expect(result.score).toBe(PERFECT);
  });

  // The skill path got this fix in 5739c69, which corrected two of the four copies of
  // extractFrontmatter but not the skillset pair — so a Windows-authored SKILLSET.md was
  // still reported as having no frontmatter and scored 0. Built in memory rather than as a
  // fixture: git's autocrlf would rewrite a committed file and the test would stop testing.
  it("scores a CRLF skillset exactly as it scores the same skillset with LF", () => {
    const lf = skillsetMd();
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(crlf).toContain("---\r\n"); // guard: the variant really is CRLF

    const lfResult = validateSkillset(input({ skillsetMd: lf }));
    const crlfResult = validateSkillset(input({ skillsetMd: crlf }));

    expect(crlfResult.score).toBe(lfResult.score);
    expect(crlfResult.diagnostics).toEqual(lfResult.diagnostics);
    expect(crlfResult.score).toBe(PERFECT);
  });
});

describe("validateSkillset — a missing field forfeits its dependent checks", () => {
  // Same regression guarded in validator.test.ts. descriptionLength is only reachable
  // when a description exists, so an ABSENT description must cost strictly more than a
  // merely SHORT one. The count-down implementation had these equal at 10 points.

  it("forfeits descriptionPresent AND descriptionLength when description is missing", () => {
    const result = validateSkillset(input({ skillsetMd: skillsetMd({ description: null }) }));
    expect(result.score).toBe(PERFECT - W.descriptionPresent - W.descriptionLength); // 80, not 90
  });

  it("penalises a missing description more heavily than a short one", () => {
    const missing = validateSkillset(
      input({ skillsetMd: skillsetMd({ description: null }) })
    ).score;
    const short = validateSkillset(
      input({ skillsetMd: skillsetMd({ description: "Too short." }) })
    ).score;

    expect(missing).toBeLessThan(short); // 80 < 90
  });
});

describe("validateSkillset — invariants", () => {
  it("never returns a score outside 0-100", () => {
    const result = validateSkillset({
      skillsetMd: skillsetMd({ name: null, description: null }),
      files: ["a/f", "b/f", "c/f", "d/f", "e/f", "f/f"],
      embeddedSkillNames: [],
      remoteSkillRefs: [{ name: "x", source_url: "not-a-url" }],
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
