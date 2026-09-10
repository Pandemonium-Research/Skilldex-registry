// Turning user text into an FTS5 MATCH expression.
//
// The defect: `toFtsQuery` split on whitespace and then *deleted* every non-word character
// inside each token, so `skillset-creator` became the single glued term `skillsetcreator` —
// a token that appears in no index, because FTS5's tokenizer splits on the hyphen when it
// indexes too. The published `skillset-creator` skillset was unfindable by its own name,
// while `skillset creator` with a space found it immediately.
//
// That matters more than one awkward name: kebab-case is *mandated* for skill names, so the
// registry could not find a skill by the exact format the specification requires.
//
// The dangerous half is that it did not fail loudly. `conventional-commit` returned 15
// results — documents literally containing the glued token — instead of the 8,122 matching
// the two words. A small, plausible, wrong answer is worse than an error.
//
// Splitting on non-word runs rather than deleting them is also what makes the terms safe by
// construction: a term produced by splitting on `[^\p{L}\p{N}_]+` cannot contain the `"`, `*`,
// `(`, `-`, `OR` or `NEAR` that FTS5 raises a syntax error on.

import { describe, it, expect } from "vitest";
import { toFtsQuery } from "../../src/db/skills.js";

describe("toFtsQuery", () => {
  it("splits a hyphenated name into its words instead of gluing them", () => {
    // The bug, stated directly. Asserted as the full expression rather than via a helper so
    // the expectation cannot drift with the implementation.
    expect(toFtsQuery("skillset-creator")).toBe('"skillset" AND "creator"');
  });

  it("treats a hyphen and a space as the same separator", () => {
    // The equivalence that was broken: these two returned 0 and 1 results respectively
    // against the live registry, for the same two words.
    expect(toFtsQuery("skillset-creator")).toBe(toFtsQuery("skillset creator"));
  });

  it("never emits the glued token that matched nothing", () => {
    expect(toFtsQuery("conventional-commit")).not.toContain("conventionalcommit");
  });

  it("splits on every non-word run, not just hyphens", () => {
    expect(toFtsQuery("node.js")).toBe('"node" AND "js"');
    expect(toFtsQuery("a/b:c")).toBe('"a" AND "b" AND "c"');
    expect(toFtsQuery("read_me")).toBe('"read_me"'); // underscore is a word character
  });

  it("collapses runs of separators rather than emitting empty terms", () => {
    expect(toFtsQuery("git --  commit")).toBe('"git" AND "commit"');
    expect(toFtsQuery("  leading and trailing  ")).toBe(
      '"leading" AND "and" AND "trailing"'
    );
  });

  it("still strips the FTS5 syntax characters that used to cause 500s", () => {
    // The original reason this function exists: a bare quote in a search box became a
    // syntax error and a 500. Every term must come out as a plain quoted word.
    const q = toFtsQuery('size 10" pipe');
    expect(q).toBe('"size" AND "10" AND "pipe"');
    for (const raw of ['a"b', "a*b", "a(b)c", "a OR b", "x NEAR y"]) {
      const out = toFtsQuery(raw)!;
      // Nothing but quoted word-characters and the AND joiner survives.
      expect(out).toMatch(/^"[\p{L}\p{N}_]+"( AND "[\p{L}\p{N}_]+")*$/u);
    }
  });

  it("returns null when nothing survives, so callers list instead of matching nothing", () => {
    // Callers treat null as "no text filter". A query of pure punctuation therefore lists
    // results rather than returning an empty page.
    expect(toFtsQuery("---")).toBeNull();
    expect(toFtsQuery("   ")).toBeNull();
    expect(toFtsQuery("")).toBeNull();
  });

  it("keeps unicode letters and digits", () => {
    expect(toFtsQuery("café-münchen")).toBe('"café" AND "münchen"');
    expect(toFtsQuery("日本語")).toBe('"日本語"');
  });
});
