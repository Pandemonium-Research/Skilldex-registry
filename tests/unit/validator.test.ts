import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { validateSkill } from "../../src/validator/index.js";

const fixturesDir = join(import.meta.dirname, "..", "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

// The weights this validator awards, mirrored from src/validator/index.ts. Duplicated
// deliberately: if someone edits a weight there, the arithmetic below stops matching and
// these tests fail loudly, which is the point.
const W = {
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

const PERFECT = 100;

describe("validateSkill — scoring", () => {
  // Every assertion here is an EXACT score, never `toBeLessThan(100)`. A loose bound is
  // what allowed the 2026-07-09 regression (d15aa6c) to ship and survive: a missing name
  // scored 84 instead of 73, and `expect(score).toBeLessThan(100)` passed happily. If you
  // add a check, add its exact expected total here too.

  it("awards a perfect score to a valid skill", () => {
    const result = validateSkill({
      skillMd: readFixture("valid-skill.md"),
      files: ["scripts/analyze.sh", "references/guide.md"],
    });

    expect(result.score).toBe(PERFECT);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("scores 0 when frontmatter is missing, and reports only that", () => {
    const result = validateSkill({
      skillMd: readFixture("no-frontmatter-skill.md"),
      files: [],
    });

    expect(result.score).toBe(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].level).toBe("error");
    expect(result.diagnostics[0].message).toContain("frontmatter");
  });

  it("charges only descriptionLength for a short description", () => {
    const result = validateSkill({
      skillMd: readFixture("short-description-skill.md"),
      files: [],
    });

    expect(result.score).toBe(PERFECT - W.descriptionLength); // 94
    const descDiag = result.diagnostics.find((d) => d.message.includes("words"));
    expect(descDiag).toBeDefined();
    expect(descDiag!.level).toBe("error");
  });

  it("charges only nameFormat for a non-kebab-case name", () => {
    const skillMd = readFixture("valid-skill.md").replace(
      "name: forensics-agent",
      "name: ForensicsAgent"
    );
    const result = validateSkill({ skillMd, files: [] });

    expect(result.score).toBe(PERFECT - W.nameFormat); // 89
    const nameDiag = result.diagnostics.find((d) => d.message.includes("kebab-case"));
    expect(nameDiag).toBeDefined();
    expect(nameDiag!.level).toBe("error");
  });

  it("charges only nameFormat for a reserved word in the name", () => {
    const skillMd = readFixture("valid-skill.md").replace(
      "name: forensics-agent",
      "name: claude-forensics"
    );
    const result = validateSkill({ skillMd, files: [] });

    expect(result.score).toBe(PERFECT - W.nameFormat); // 89
    const nameDiag = result.diagnostics.find((d) => d.message.includes("reserved word"));
    expect(nameDiag).toBeDefined();
    expect(nameDiag!.level).toBe("error");
  });

  it("charges only descriptionFormat for XML angle brackets", () => {
    const skillMd = readFixture("valid-skill.md").replace(
      "description: A comprehensive skill for digital forensics",
      "description: A <comprehensive> skill for digital forensics"
    );
    const result = validateSkill({ skillMd, files: [] });

    expect(result.score).toBe(PERFECT - W.descriptionFormat); // 89
    const descDiag = result.diagnostics.find((d) => d.message.includes("angle brackets"));
    expect(descDiag).toBeDefined();
    expect(descDiag!.level).toBe("error");
  });

  it("charges 2 points per unknown subdirectory", () => {
    const result = validateSkill({
      skillMd: readFixture("valid-skill.md"),
      files: ["bin/run.sh", "scripts/analyze.sh"],
    });

    expect(result.score).toBe(PERFECT - 2); // 98 — one unknown dir
    const dirDiag = result.diagnostics.find((d) => d.message.includes("Unknown subdirectory"));
    expect(dirDiag).toBeDefined();
    expect(dirDiag!.level).toBe("warning");
  });

  it("floors the subdirectory penalty at its weight rather than going negative", () => {
    const result = validateSkill({
      skillMd: readFixture("valid-skill.md"),
      files: ["bin/a", "lib/b", "tmp/c", "var/d"],
    });

    // 4 unknown dirs x 2 = 8, capped at the 4-point weight.
    expect(result.score).toBe(PERFECT - W.allowedSubdirs); // 96
  });

  it("charges referencedResourcesExist for a broken reference", () => {
    const skillMd =
      readFixture("valid-skill.md") + "\n\nSee [template](assets/template.docx) for details.";
    const result = validateSkill({ skillMd, files: ["scripts/analyze.sh"] });

    expect(result.score).toBe(PERFECT - W.referencedResourcesExist); // 93
    const refDiag = result.diagnostics.find((d) => d.message.includes("not found"));
    expect(refDiag).toBeDefined();
    expect(refDiag!.level).toBe("error");
  });

  it("charges bundledResourcesCorrect once, however many files are misplaced", () => {
    const result = validateSkill({
      skillMd: readFixture("valid-skill.md"),
      files: ["references/run.sh", "scripts/notes.md"],
    });

    expect(result.score).toBe(PERFECT - W.bundledResourcesCorrect); // 98 — not 2x
    const misplaced = result.diagnostics.filter((d) => d.message.includes("found in"));
    expect(misplaced).toHaveLength(2);
    expect(misplaced.every((d) => d.level === "warning")).toBe(true);
  });

  it("charges noReadme for a README.md in the skill folder", () => {
    const result = validateSkill({
      skillMd: readFixture("valid-skill.md"),
      files: ["README.md", "scripts/analyze.sh"],
    });

    expect(result.score).toBe(PERFECT - W.noReadme); // 96
    const readmeDiag = result.diagnostics.find((d) => d.message.includes("README.md"));
    expect(readmeDiag).toBeDefined();
    expect(readmeDiag!.level).toBe("warning");
  });

  it("keeps full lineCount credit inside the 400-500 warning band", () => {
    const skillMd = readFixture("valid-skill.md") + "\n".repeat(420);
    const result = validateSkill({ skillMd, files: [] });

    expect(result.score).toBe(PERFECT); // warns, costs nothing
    const lineDiag = result.diagnostics.find((d) => d.message.includes("warning threshold"));
    expect(lineDiag).toBeDefined();
    expect(lineDiag!.level).toBe("warning");
  });

  it("charges lineCount past the 500-line hard limit", () => {
    const skillMd = readFixture("valid-skill.md") + "\n".repeat(520);
    const result = validateSkill({ skillMd, files: [] });

    expect(result.score).toBe(PERFECT - W.lineCount); // 93
  });

  // A SKILL.md authored on Windows is byte-for-byte the same document with CRLF line
  // endings. The frontmatter matcher used to require a bare \n, so these scored 0 —
  // "missing frontmatter" — despite the YAML being perfectly well formed.
  // The CRLF variant is built here rather than committed as a fixture: git's autocrlf
  // normalisation would quietly rewrite a fixture file and the test would stop testing
  // anything.
  it("scores a CRLF skill exactly as it scores the same skill with LF", () => {
    const lf = readFixture("valid-skill.md");
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(crlf).toContain("---\r\n"); // guard: the variant really is CRLF

    const files = ["scripts/analyze.sh", "references/guide.md"];
    const lfResult = validateSkill({ skillMd: lf, files });
    const crlfResult = validateSkill({ skillMd: crlf, files });

    expect(crlfResult.score).toBe(lfResult.score);
    expect(crlfResult.diagnostics).toEqual(lfResult.diagnostics);
    expect(crlfResult.score).toBe(100);
  });
});

describe("validateSkill — a missing field forfeits its dependent checks", () => {
  // The regression these exist to prevent. nameFormat is only reachable when a name is
  // present, and descriptionLength/descriptionFormat only when a description is. A field
  // that is ABSENT must therefore cost strictly more than one that is merely MALFORMED.
  //
  // The count-down implementation shipped between d15aa6c (2026-07-09) and 2026-09-04 got
  // this backwards: it deducted the parent weight and then skipped the else, never
  // charging the dependent checks. Missing name scored 84 (should be 73); missing
  // description 84 (should be 67); both 68 (should be 40).

  it("forfeits namePresent AND nameFormat when name is missing", () => {
    const result = validateSkill({
      skillMd: readFixture("missing-name-skill.md"),
      files: [],
    });

    expect(result.score).toBe(PERFECT - W.namePresent - W.nameFormat); // 73, not 84
    expect(result.diagnostics.find((d) => d.message.includes("name"))).toBeDefined();
  });

  it("forfeits descriptionPresent AND length AND format when description is missing", () => {
    const result = validateSkill({
      skillMd: readFixture("missing-description-skill.md"),
      files: [],
    });

    expect(result.score).toBe(
      PERFECT - W.descriptionPresent - W.descriptionLength - W.descriptionFormat
    ); // 67, not 84
    expect(result.diagnostics.find((d) => d.message.includes("description"))).toBeDefined();
  });

  it("forfeits both groups when name and description are missing", () => {
    const result = validateSkill({
      skillMd: readFixture("missing-name-and-description-skill.md"),
      files: [],
    });

    expect(result.score).toBe(40); // not 68
  });

  it("penalises a missing field more heavily than a malformed one", () => {
    const missing = validateSkill({
      skillMd: readFixture("missing-name-skill.md"),
      files: [],
    }).score;
    const malformed = validateSkill({
      skillMd: readFixture("valid-skill.md").replace(
        "name: forensics-agent",
        "name: ForensicsAgent"
      ),
      files: [],
    }).score;

    expect(missing).toBeLessThan(malformed);
  });
});

describe("validateSkill — invariants", () => {
  it("never returns a score outside 0-100", () => {
    const wrecked = `---\ndescription: Short.\nspec_version: "1.0"\n---\n` + "\n".repeat(510);
    const result = validateSkill({
      skillMd: wrecked,
      files: ["bin/x", "lib/y", "tmp/z", "var/w", "opt/v", "README.md", "references/a.sh"],
    });

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("awards exactly 100 to a clean skill, so the weights sum to 100", () => {
    // If any weight is edited without rebalancing the rest, this is the tripwire.
    const result = validateSkill({
      skillMd: readFixture("valid-skill.md"),
      files: [],
    });
    expect(result.score).toBe(100);
  });
});
