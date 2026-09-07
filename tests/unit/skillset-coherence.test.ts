// Coherence checking, registry side.
//
// The parsing logic here is a port of skilldex's src/core/skillset-coherence.ts and was verified
// against it function-by-function and by running both implementations over every real skillset.
// What is NEW in this repo is the I/O layer: skilldex reads a working tree, the registry reads a
// GitHub tree listing plus fetched blobs, behind CoherenceSource. These tests concentrate on that
// seam — existence as a set lookup, depth-1 asset discovery, sorted asset order, and what happens
// when a fetch comes back empty — and then cover the parsers that the seam feeds.

import { describe, it, expect } from "vitest";
import {
  checkSkillsetCoherence,
  parseDeclaredConventions,
  extractAssetReferences,
  parseMarkdownTables,
  type CoherenceSource,
} from "../../src/validator/skillset-coherence.js";

/** A CoherenceSource over an in-memory file map — the shape GitHub's tree API hands us. */
function source(files: Record<string, string>): CoherenceSource {
  return {
    listFiles: () => Object.keys(files),
    async readFile(rel: string) {
      return Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null;
    },
  };
}

const lines = (...l: string[]) => l.join("\n");

const CONVENTIONS = lines(
  "# Commit conventions",
  "",
  "```yaml skilldex-conventions",
  "commit-types:",
  "  feat: Added",
  "  fix: Fixed",
  "```",
  ""
);

const AGREEING_MEMBER = lines(
  "Follow `../assets/conv.md`.",
  "",
  "| Type | Changelog section |",
  "| --- | --- |",
  "| `feat` | Added |",
  "| `fix` | Fixed |",
  ""
);

describe("checkSkillsetCoherence — the I/O seam", () => {
  it("reports nothing when a skillset declares no shared assets", async () => {
    const result = await checkSkillsetCoherence(
      source({ "SKILLSET.md": "", "a/SKILL.md": "# a\n" }),
      ["a"]
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.membersChecked).toBe(1);
    expect(result.membersCoherent).toBe(1);
  });

  it("passes a member that references a shared asset which exists", async () => {
    const result = await checkSkillsetCoherence(
      source({
        "SKILLSET.md": "",
        "assets/conv.md": "# conventions\n",
        "a/SKILL.md": "See `../assets/conv.md`.\n",
      }),
      ["a"]
    );

    expect(result.errorCount).toBe(0);
    expect(result.warnCount).toBe(0);
    expect(result.passCount).toBe(2); // referenced + resolvable
    expect(result.membersCoherent).toBe(1);
  });

  it("errors on a reference to a file the skillset does not contain", async () => {
    const result = await checkSkillsetCoherence(
      source({
        "SKILLSET.md": "",
        "assets/conv.md": "x",
        "a/SKILL.md": "See `../assets/missing.md`.\n",
      }),
      ["a"]
    );

    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].check).toBe("shared-asset-resolvable");
    expect(errors[0].assetFile).toBe("../assets/missing.md");
    expect(result.membersCoherent).toBe(0);
  });

  it("warns when a member reaches for no shared asset at all", async () => {
    const result = await checkSkillsetCoherence(
      source({ "SKILLSET.md": "", "assets/conv.md": "x", "a/SKILL.md": "nothing here\n" }),
      ["a"]
    );

    expect(result.warnCount).toBe(1);
    expect(result.diagnostics[0].check).toBe("shared-asset-referenced");
    expect(result.membersCoherent).toBe(0);
  });

  it("treats only depth-1 .md files as shared assets", async () => {
    // A nested file is not a shared asset, so there is no convention guarantee to be outside of
    // and the member must not be warned about ignoring one. Mirrors the CLI's readdir + isFile,
    // which never descends.
    const result = await checkSkillsetCoherence(
      source({
        "SKILLSET.md": "",
        "assets/nested/deep.md": "x",
        "assets/logo.png": "x",
        "a/SKILL.md": "nothing here\n",
      }),
      ["a"]
    );

    expect(result.diagnostics).toEqual([]);
  });

  it("does not mistake a directory named like a markdown file for a shared asset", async () => {
    // The extension check alone would accept "assets/notes.md/attachment.txt", whose second
    // segment is a directory that merely happens to end in .md. Only the depth check rejects
    // it — a shared asset is a file directly under assets/, never a path leading through one.
    const result = await checkSkillsetCoherence(
      source({
        "SKILLSET.md": "",
        "assets/notes.md/attachment.txt": "x",
        "a/SKILL.md": "nothing here\n",
      }),
      ["a"]
    );

    expect(result.diagnostics).toEqual([]);
  });

  it("reads shared assets in sorted order regardless of how the tree lists them", async () => {
    // GitHub's tree order is not something we control; the CLI's readdir order is unordered by
    // contract. Sorting makes which asset reports first reproducible.
    const conv = (name: string) =>
      lines("```yaml skilldex-conventions", `${name}:`, "  k: v", "  j: w", "```", "");

    const result = await checkSkillsetCoherence(
      source({
        "SKILLSET.md": "",
        "assets/zebra.md": conv("zebra-rule"),
        "assets/alpha.md": conv("alpha-rule"),
        "a/SKILL.md": "See `../assets/alpha.md`.\n",
      }),
      ["a"]
    );

    expect(result.declaredConventions.map((c) => c.assetFile)).toEqual([
      "assets/alpha.md",
      "assets/zebra.md",
    ]);
  });

  it("skips a member whose SKILL.md cannot be fetched rather than judging it", async () => {
    // Deliberate parity with the CLI: a member listed but unreadable is not evidence of
    // incoherence, so it is left in the coherent set. On the CLI that only happens if the file
    // vanishes mid-scan; here it also covers a failed fetch, so the publish route checks that
    // every member was actually retrieved before trusting the totals.
    const result = await checkSkillsetCoherence(
      {
        listFiles: () => ["SKILLSET.md", "assets/c.md", "a/SKILL.md", "b/SKILL.md"],
        async readFile(rel: string) {
          if (rel === "a/SKILL.md") return null; // fetch failed
          if (rel === "b/SKILL.md") return "See `../assets/c.md`.\n";
          return "x";
        },
      },
      ["a", "b"]
    );

    expect(result.membersChecked).toBe(2);
    expect(result.membersCoherent).toBe(2);
    expect(result.diagnostics.every((d) => d.member === "b")).toBe(true);
  });

  it("counts only clean members as coherent", async () => {
    const result = await checkSkillsetCoherence(
      source({
        "SKILLSET.md": "",
        "assets/conv.md": "x",
        "good/SKILL.md": "See `../assets/conv.md`.\n",
        "bad/SKILL.md": "See `../assets/gone.md`.\n",
      }),
      ["good", "bad"]
    );

    expect(result.membersChecked).toBe(2);
    expect(result.membersCoherent).toBe(1);
  });
});

describe("checkSkillsetCoherence — agreement with declared conventions", () => {
  const files = (member: string) => ({
    "SKILLSET.md": "",
    "assets/conv.md": CONVENTIONS,
    "a/SKILL.md": member,
  });

  it("passes a member that restates a convention consistently", async () => {
    const result = await checkSkillsetCoherence(source(files(AGREEING_MEMBER)), ["a"]);

    expect(result.errorCount).toBe(0);
    expect(result.warnCount).toBe(0);
    const agreement = result.diagnostics.find((d) => d.check === "shared-asset-agreement");
    expect(agreement?.severity).toBe("pass");
    expect(agreement?.conventionName).toBe("commit-types");
    expect(result.membersCoherent).toBe(1);
  });

  it("errors on a member that restates a convention and contradicts it", async () => {
    const contradicting = lines(
      "Follow `../assets/conv.md`.",
      "",
      "| Type | Changelog section |",
      "| --- | --- |",
      "| `feat` | Fixed |",
      "| `fix` | Added |",
      ""
    );

    const result = await checkSkillsetCoherence(source(files(contradicting)), ["a"]);

    const errors = result.diagnostics.filter((d) => d.check === "shared-asset-agreement");
    expect(errors).toHaveLength(2);
    expect(errors.every((d) => d.severity === "error")).toBe(true);
    expect(errors[0].key).toBe("feat");
    expect(errors[0].declaredValue).toBe("Added");
    expect(errors[0].memberValue).toBe("Fixed");
    expect(errors[0].assetFile).toBe("assets/conv.md");
    expect(result.membersCoherent).toBe(0);
  });

  it("warns rather than errors when a value matches nothing the declaration uses", async () => {
    // "Removed" is not a contradiction of "Added" — it is a word the convention never defines,
    // so agreement is unverifiable rather than violated.
    const unverifiable = lines(
      "Follow `../assets/conv.md`.",
      "",
      "| Type | Changelog section |",
      "| --- | --- |",
      "| `feat` | Removed |",
      "| `fix` | Fixed |",
      ""
    );

    const result = await checkSkillsetCoherence(source(files(unverifiable)), ["a"]);

    const agreement = result.diagnostics.filter((d) => d.check === "shared-asset-agreement");
    expect(agreement).toHaveLength(1);
    expect(agreement[0].severity).toBe("warning");
    expect(agreement[0].key).toBe("feat");
    expect(result.errorCount).toBe(0);
  });

  it("flags a convention that is restated but never declared", async () => {
    const asset = lines(
      "# Types",
      "",
      "| Type | Section |",
      "| --- | --- |",
      "| `feat` | Added |",
      "| `fix` | Fixed |",
      ""
    );

    const result = await checkSkillsetCoherence(
      source({ "SKILLSET.md": "", "assets/conv.md": asset, "a/SKILL.md": AGREEING_MEMBER }),
      ["a"]
    );

    const undeclared = result.diagnostics.filter((d) => d.check === "undeclared-convention");
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0].severity).toBe("warning");
    expect(undeclared[0].assetFile).toBe("assets/conv.md");
  });

  it("does not look for undeclared conventions once any are declared", async () => {
    const result = await checkSkillsetCoherence(source(files(AGREEING_MEMBER)), ["a"]);
    expect(result.diagnostics.some((d) => d.check === "undeclared-convention")).toBe(false);
  });
});

describe("parseDeclaredConventions", () => {
  it("extracts a mapping from a tagged fence", () => {
    const found = parseDeclaredConventions(CONVENTIONS, "assets/conv.md");

    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("commit-types");
    expect(found[0].assetFile).toBe("assets/conv.md");
    expect(found[0].line).toBe(3);
    expect(found[0].mapping).toEqual({ feat: "Added", fix: "Fixed" });
  });

  it("ignores a fence without the conventions info tag", () => {
    const plain = lines("```yaml", "commit-types:", "  feat: Added", "```");
    expect(parseDeclaredConventions(plain, "assets/conv.md")).toEqual([]);
  });

  it("ignores a mapping whose values are not scalars", () => {
    const nested = lines(
      "```yaml skilldex-conventions",
      "commit-types:",
      "  feat:",
      "    label: Added",
      "```"
    );
    expect(parseDeclaredConventions(nested, "assets/conv.md")).toEqual([]);
  });

  it("accepts tilde fences", () => {
    const tilde = lines("~~~yaml skilldex-conventions", "rule:", "  a: b", "  c: d", "~~~");
    expect(parseDeclaredConventions(tilde, "assets/conv.md")).toHaveLength(1);
  });

  it("skips a fence that is never closed", () => {
    const unclosed = lines("```yaml skilldex-conventions", "rule:", "  a: b");
    expect(parseDeclaredConventions(unclosed, "assets/conv.md")).toEqual([]);
  });
});

describe("extractAssetReferences", () => {
  it("marks ../ references as skillset-level and bare ones as member-local", () => {
    const refs = extractAssetReferences(
      lines("Use `../assets/shared.md` and `references/local.md`.")
    );

    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ rawPath: "../assets/shared.md", isSkillsetLevel: true, line: 1 });
    expect(refs[1]).toMatchObject({ rawPath: "references/local.md", isSkillsetLevel: false });
  });

  it("deduplicates repeated references but keeps the first line", () => {
    const refs = extractAssetReferences(
      lines("See `../assets/a.md`.", "", "Again: `../assets/a.md`.")
    );

    expect(refs).toHaveLength(1);
    expect(refs[0].line).toBe(1);
  });

  it("ignores paths outside assets/ and references/", () => {
    expect(extractAssetReferences("Run `scripts/build.sh` now.")).toEqual([]);
  });
});

describe("parseMarkdownTables", () => {
  it("parses a header and its body rows", () => {
    const tables = parseMarkdownTables(
      lines("intro", "| A | B |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |", "outro")
    );

    expect(tables).toHaveLength(1);
    expect(tables[0].line).toBe(2);
    expect(tables[0].header).toEqual(["A", "B"]);
    expect(tables[0].rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("requires a separator row", () => {
    expect(parseMarkdownTables(lines("| A | B |", "| 1 | 2 |"))).toEqual([]);
  });

  it("ignores a table with a header but no body", () => {
    expect(parseMarkdownTables(lines("| A | B |", "| --- | --- |"))).toEqual([]);
  });
});
