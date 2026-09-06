import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchSkillFromGitHub } from "../../src/github/fetch.js";

const OWNER = "acme";
const REPO = "skills";
const SUBPATH = "skills/windows-authored";
const SOURCE_URL = `https://github.com/${OWNER}/${REPO}/tree/main/${SUBPATH}`;

const FRONTMATTER = [
  "---",
  "name: windows-authored",
  "description: A skill whose SKILL.md was written on Windows and therefore uses CRLF line endings throughout.",
  'spec_version: "1.0"',
  "author: testuser",
  "---",
  "",
  "# Windows Authored",
  "",
  "Body text.",
];

/** Build the same document with the requested line ending. */
function skillMd(eol: "\n" | "\r\n"): string {
  return FRONTMATTER.join(eol);
}

/** Stand in for the two GitHub endpoints fetchSkillFromGitHub calls, in either order. */
function stubGitHub(content: string) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/contents/")) {
        return new Response(
          JSON.stringify({
            content: Buffer.from(content, "utf-8").toString("base64"),
            encoding: "base64",
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          tree: [
            { path: `${SUBPATH}/SKILL.md`, type: "blob" },
            { path: `${SUBPATH}/scripts/run.sh`, type: "blob" },
          ],
        }),
        { status: 200 }
      );
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSkillFromGitHub", () => {
  it("parses frontmatter from a LF SKILL.md", async () => {
    stubGitHub(skillMd("\n"));

    const meta = await fetchSkillFromGitHub(SOURCE_URL);

    expect(meta.name).toBe("windows-authored");
    expect(meta.spec_version).toBe("1.0");
    expect(meta.files).toEqual(["scripts/run.sh"]);
  });

  // The regression: a CRLF document is the same skill, but the frontmatter matcher
  // required a bare \n, so this threw PARSE_FAILED. In the live registry that silently
  // cost real skills — and because a failure was never recorded as seen, the seeder
  // re-fetched each of them on every nightly run, forever.
  it("parses frontmatter from a CRLF SKILL.md identically", async () => {
    stubGitHub(skillMd("\r\n"));

    const meta = await fetchSkillFromGitHub(SOURCE_URL);

    expect(meta.name).toBe("windows-authored");
    expect(meta.description).toContain("CRLF line endings");
    expect(meta.spec_version).toBe("1.0");
  });

  it("still rejects a SKILL.md with no frontmatter at all", async () => {
    stubGitHub("# Just a heading\r\n\r\nNo frontmatter here.\r\n");

    await expect(fetchSkillFromGitHub(SOURCE_URL)).rejects.toMatchObject({
      code: "PARSE_FAILED",
    });
  });

  it("reports FETCH_FAILED — not PARSE_FAILED — when SKILL.md cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));

    // The distinction is load-bearing: the seeder permanently skips PARSE_FAILED urls
    // but retries everything else, so a transient read must not be classed as a parse error.
    await expect(fetchSkillFromGitHub(SOURCE_URL)).rejects.toMatchObject({
      code: "FETCH_FAILED",
    });
  });
});
