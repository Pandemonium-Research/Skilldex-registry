// The readFile accessor on SkillsetMetadata.
//
// Coherence checking needs the bytes of every member's SKILL.md and every shared asset, which the
// two calls fetchSkillsetFromGitHub makes do not retrieve. readFile closes over the resolved repo
// coordinates to supply them, and its contract is what the checker is written against:
//
//   - null for anything unreadable, never a rejection — the checker treats null as "skip", and a
//     thrown transport error would instead abort the whole publish
//   - one request per path however many times it is read — collectDeclaredConventions and
//     checkUndeclaredConventions both walk every shared asset, so without this each one costs
//     twice what it should

import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchSkillsetFromGitHub } from "../../src/github/fetch-skillset.js";

const SOURCE_URL = "https://github.com/acme/sets/tree/main/devset";

const SKILLSET_MD = [
  "---",
  "name: devset",
  'description: "A skillset used to exercise the file accessor on the fetcher."',
  'spec_version: "1.0"',
  "---",
  "",
  "# devset",
].join("\n");

/** Stub the contents + trees endpoints, recording every URL requested. */
function stubGitHub(blobs: Record<string, string>, opts: { throwOn?: string } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);

      if (opts.throwOn && u.includes(opts.throwOn)) {
        throw new TypeError("fetch failed");
      }

      if (u.includes("/git/trees/")) {
        return new Response(
          JSON.stringify({
            tree: [
              { path: "devset/SKILLSET.md", type: "blob" },
              ...Object.keys(blobs).map((p) => ({ path: `devset/${p}`, type: "blob" })),
            ],
          }),
          { status: 200 }
        );
      }

      const m = u.match(/\/contents\/devset\/(.+)\?/);
      const rel = m ? decodeURIComponent(m[1]) : "";
      const content = rel === "SKILLSET.md" ? SKILLSET_MD : blobs[rel];
      if (content === undefined) return new Response("Not Found", { status: 404 });

      return new Response(
        JSON.stringify({ content: Buffer.from(content).toString("base64"), encoding: "base64" }),
        { status: 200 }
      );
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SkillsetMetadata.readFile", () => {
  it("returns the content of a file in the skillset", async () => {
    stubGitHub({ "a/SKILL.md": "# member a\n" });

    const md = await fetchSkillsetFromGitHub(SOURCE_URL);

    expect(await md.readFile("a/SKILL.md")).toBe("# member a\n");
  });

  it("issues one request per path no matter how often it is read", async () => {
    const calls = stubGitHub({ "assets/conv.md": "# conventions\n" });

    const md = await fetchSkillsetFromGitHub(SOURCE_URL);
    const before = calls.length;

    await md.readFile("assets/conv.md");
    await md.readFile("assets/conv.md");
    await md.readFile("assets/conv.md");

    const added = calls.slice(before).filter((u) => u.includes("conv.md"));
    expect(added).toHaveLength(1);
  });

  it("shares one request between concurrent reads of the same path", async () => {
    // The promise is cached, not its result, so a second read arriving before the first resolves
    // joins it instead of starting a duplicate request.
    const calls = stubGitHub({ "assets/conv.md": "# conventions\n" });

    const md = await fetchSkillsetFromGitHub(SOURCE_URL);
    const before = calls.length;

    const [x, y] = await Promise.all([
      md.readFile("assets/conv.md"),
      md.readFile("assets/conv.md"),
    ]);

    expect(x).toBe(y);
    expect(calls.slice(before).filter((u) => u.includes("conv.md"))).toHaveLength(1);
  });

  it("returns null for a path the repository does not have", async () => {
    stubGitHub({ "a/SKILL.md": "# a\n" });

    const md = await fetchSkillsetFromGitHub(SOURCE_URL);

    expect(await md.readFile("b/SKILL.md")).toBeNull();
  });

  it("returns null rather than rejecting when the request itself fails", async () => {
    // fetchFileContent only maps an HTTP error to null; a transport failure throws out of fetch.
    // Coherence reads members in a loop with no try/catch, so a rejection here would abort a
    // publish that should have been refused with a diagnosable 422.
    stubGitHub({ "a/SKILL.md": "# a\n" }, { throwOn: "/contents/devset/a/SKILL.md" });

    const md = await fetchSkillsetFromGitHub(SOURCE_URL);

    await expect(md.readFile("a/SKILL.md")).resolves.toBeNull();
  });
});
