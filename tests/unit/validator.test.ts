import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { validateSkill } from "../../src/validator/index.js";

const fixturesDir = join(import.meta.dirname, "..", "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

describe("validateSkill", () => {
  it("gives a perfect score to a valid skill", () => {
    const result = validateSkill({
      skillMd: readFixture("valid-skill.md"),
      files: ["scripts/analyze.sh", "references/guide.md"],
    });

    expect(result.score).toBe(100);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("returns score 0 for missing frontmatter", () => {
    const result = validateSkill({
      skillMd: readFixture("no-frontmatter-skill.md"),
      files: [],
    });

    expect(result.score).toBe(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].level).toBe("error");
    expect(result.diagnostics[0].message).toContain("frontmatter");
  });

  it("deducts points for short description", () => {
    const result = validateSkill({
      skillMd: readFixture("short-description-skill.md"),
      files: [],
    });

    expect(result.score).toBeLessThan(100);
    const descDiag = result.diagnostics.find((d) =>
      d.message.includes("words")
    );
    expect(descDiag).toBeDefined();
    expect(descDiag!.level).toBe("error");
  });

  it("deducts points for missing name field", () => {
    const result = validateSkill({
      skillMd: readFixture("missing-name-skill.md"),
      files: [],
    });

    expect(result.score).toBeLessThan(100);
    const nameDiag = result.diagnostics.find((d) =>
      d.message.includes("name")
    );
    expect(nameDiag).toBeDefined();
  });

  it("warns about unknown subdirectories", () => {
    const result = validateSkill({
      skillMd: readFixture("valid-skill.md"),
      files: ["bin/run.sh", "scripts/analyze.sh"],
    });

    const dirDiag = result.diagnostics.find((d) =>
      d.message.includes("Unknown subdirectory")
    );
    expect(dirDiag).toBeDefined();
    expect(dirDiag!.level).toBe("warning");
  });

  it("flags broken resource references", () => {
    const skillMd = readFixture("valid-skill.md") +
      "\n\nSee [template](assets/template.docx) for details.";

    const result = validateSkill({
      skillMd,
      files: ["scripts/analyze.sh"],
    });

    const refDiag = result.diagnostics.find((d) =>
      d.message.includes("not found")
    );
    expect(refDiag).toBeDefined();
    expect(refDiag!.level).toBe("error");
  });

  it("warns about misplaced files", () => {
    const result = validateSkill({
      skillMd: readFixture("valid-skill.md"),
      files: ["references/run.sh", "scripts/notes.md"],
    });

    const misplaced = result.diagnostics.filter((d) =>
      d.message.includes("found in")
    );
    expect(misplaced).toHaveLength(2);
    expect(misplaced.every((d) => d.level === "warning")).toBe(true);
  });

  it("deducts points for a non-kebab-case name", () => {
    const skillMd = readFixture("valid-skill.md").replace(
      "name: forensics-agent",
      "name: ForensicsAgent"
    );
    const result = validateSkill({ skillMd, files: [] });

    expect(result.score).toBeLessThan(100);
    const nameDiag = result.diagnostics.find((d) =>
      d.message.includes("kebab-case")
    );
    expect(nameDiag).toBeDefined();
    expect(nameDiag!.level).toBe("error");
  });

  it("deducts points for a reserved word in the name", () => {
    const skillMd = readFixture("valid-skill.md").replace(
      "name: forensics-agent",
      "name: claude-forensics"
    );
    const result = validateSkill({ skillMd, files: [] });

    expect(result.score).toBeLessThan(100);
    const nameDiag = result.diagnostics.find((d) =>
      d.message.includes("reserved word")
    );
    expect(nameDiag).toBeDefined();
    expect(nameDiag!.level).toBe("error");
  });

  it("deducts points for a description with XML angle brackets", () => {
    const skillMd = readFixture("valid-skill.md").replace(
      "description: A comprehensive skill for digital forensics",
      "description: A <comprehensive> skill for digital forensics"
    );
    const result = validateSkill({ skillMd, files: [] });

    expect(result.score).toBeLessThan(100);
    const descDiag = result.diagnostics.find((d) =>
      d.message.includes("angle brackets")
    );
    expect(descDiag).toBeDefined();
    expect(descDiag!.level).toBe("error");
  });

  it("warns about a README.md inside the skill folder", () => {
    const result = validateSkill({
      skillMd: readFixture("valid-skill.md"),
      files: ["README.md", "scripts/analyze.sh"],
    });

    expect(result.score).toBeLessThan(100);
    const readmeDiag = result.diagnostics.find((d) =>
      d.message.includes("README.md")
    );
    expect(readmeDiag).toBeDefined();
    expect(readmeDiag!.level).toBe("warning");
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

  it("caps score at 0 minimum", () => {
    // Skill with many issues
    const skillMd = `---
description: Short.
spec_version: "1.0"
---
` + "\n".repeat(510);

    const result = validateSkill({
      skillMd,
      files: ["bin/x", "lib/y", "tmp/z"],
    });

    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
