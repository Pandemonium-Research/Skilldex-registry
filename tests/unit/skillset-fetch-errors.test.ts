// What a failed GitHub read tells the publisher.
//
// Both fetches in this module used to collapse every non-OK response to a falsy value —
// fetchFileContent returned null, fetchDirectoryListing returned []. The publisher saw
// "Could not fetch SKILLSET.md from <url>" whatever had happened, so a wrong path, a revoked
// token, an org policy and a rate limit were one indistinguishable message.
//
// That cost a real diagnosis. Publishing the official skillsets failed with exactly that line
// while the URL was correct and the file was fetchable anonymously; GitHub had answered 403 with
// "the 'Pandemonium-Research' organization forbids access via a fine-grained personal access
// tokens if the token's lifetime is greater than 366 days", naming the fix and linking the
// setting, and the fetcher discarded all of it.
//
// These tests pin the status and GitHub's own message into the error, and pin the two contracts
// that constrain how far the change may go: readFile must still resolve to null, and a failed
// listing must refuse rather than publish a skillset with no members.

import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchSkillsetFromGitHub } from "../../src/github/fetch-skillset.js";

const SOURCE_URL = "https://github.com/acme/sets/tree/main/devset";

const SKILLSET_MD = [
  "---",
  "name: devset",
  'description: "A skillset used to exercise the error reporting on the fetcher."',
  'spec_version: "1.0"',
  "---",
  "",
  "# devset",
].join("\n");

/** The 403 GitHub actually returned when an org policy rejected the registry's token. */
const ORG_POLICY_403 =
  "The 'Pandemonium-Research' organization forbids access via a fine-grained personal access " +
  "tokens if the token's lifetime is greater than 366 days.";

interface StubOptions {
  /** Status for the contents endpoint; 200 serves the file. */
  contentsStatus?: number;
  /** Status for the git/trees endpoint; 200 serves the listing. */
  treeStatus?: number;
  /** GitHub's `message` on an error response, or null to send a non-JSON body. */
  message?: string | null;
}

function stubGitHub(opts: StubOptions = {}) {
  const { contentsStatus = 200, treeStatus = 200, message = ORG_POLICY_403 } = opts;

  const errorBody = (status: number) =>
    message === null
      ? new Response("<html>upstream is having a day</html>", { status })
      : new Response(JSON.stringify({ message, documentation_url: "https://docs.github.com" }), {
          status,
        });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);

      if (u.includes("/git/trees/")) {
        if (treeStatus !== 200) return errorBody(treeStatus);
        return new Response(
          JSON.stringify({
            tree: [
              { path: "devset/SKILLSET.md", type: "blob" },
              { path: "devset/a/SKILL.md", type: "blob" },
            ],
          }),
          { status: 200 }
        );
      }

      if (contentsStatus !== 200) return errorBody(contentsStatus);
      return new Response(
        JSON.stringify({
          content: Buffer.from(SKILLSET_MD).toString("base64"),
          encoding: "base64",
        }),
        { status: 200 }
      );
    })
  );
}

/**
 * Run a fetch that is expected to fail and hand back the error the publisher would see.
 *
 * Fails loudly if the call resolves instead: a test that read its assertions off a successful
 * fetch would pass by inspecting nothing.
 */
async function failureOf(): Promise<Error & { code?: string; status?: number }> {
  try {
    await fetchSkillsetFromGitHub(SOURCE_URL);
  } catch (e) {
    return e as Error & { code?: string; status?: number };
  }
  throw new Error("expected fetchSkillsetFromGitHub to reject, but it resolved");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what a failed GitHub read reports", () => {
  it("carries GitHub's status and message when SKILLSET.md cannot be read", async () => {
    stubGitHub({ contentsStatus: 403 });

    // The route interpolates err.message straight into its 422 body, so whatever lands here is
    // what the publisher reads in their terminal.
    await expect(fetchSkillsetFromGitHub(SOURCE_URL)).rejects.toThrow(/403/);
    await expect(fetchSkillsetFromGitHub(SOURCE_URL)).rejects.toThrow(/forbids access/);
    await expect(fetchSkillsetFromGitHub(SOURCE_URL)).rejects.toThrow(/366 days/);
  });

  it("distinguishes a missing path from a refused one", async () => {
    // The whole point of the change: these two produced identical text before, and they call for
    // opposite responses — fix the URL, or fix the token.
    stubGitHub({ contentsStatus: 404, message: "Not Found" });
    const missing = await failureOf();

    vi.unstubAllGlobals();
    stubGitHub({ contentsStatus: 403 });
    const refused = await failureOf();

    expect(missing.message).toContain("404");
    expect(refused.message).toContain("403");
    expect(missing.message).not.toBe(refused.message);
  });

  it("exposes the status on the error for callers that branch on it", async () => {
    stubGitHub({ contentsStatus: 429, message: "API rate limit exceeded" });

    const err = (await fetchSkillsetFromGitHub(SOURCE_URL).catch((e) => e)) as Error & {
      code?: string;
      status?: number;
    };

    expect(err.status).toBe(429);
    // code is unchanged so existing handling still applies.
    expect(err.code).toBe("FETCH_FAILED");
  });

  it("still reports the status when the error body is not JSON", async () => {
    // A gateway error page instead of the API's JSON must not make the error path itself throw,
    // which would replace a diagnosable failure with a parse error from a different module.
    stubGitHub({ contentsStatus: 502, message: null });

    await expect(fetchSkillsetFromGitHub(SOURCE_URL)).rejects.toThrow(/502/);
  });

  it("refuses the publish when the file listing fails", async () => {
    // The dangerous half. Members are discovered from this listing, so [] is not an error
    // downstream — it is a skillset that appears to have none, and it would validate, score and
    // publish with coherence 0/0 off a request that never succeeded.
    stubGitHub({ treeStatus: 403 });

    await expect(fetchSkillsetFromGitHub(SOURCE_URL)).rejects.toThrow(/403/);
  });

  it("leaves readFile resolving to null for an unreadable member", async () => {
    // The constraint on the change. Coherence reads every member in a loop with no try/catch and
    // treats null as "skip", so making these HTTP failures throw must not reach it.
    let served = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/git/trees/")) {
          return new Response(
            JSON.stringify({ tree: [{ path: "devset/SKILLSET.md", type: "blob" }] }),
            { status: 200 }
          );
        }
        // SKILLSET.md succeeds; every other blob is refused.
        if (u.includes("SKILLSET.md") && served++ === 0) {
          return new Response(
            JSON.stringify({
              content: Buffer.from(SKILLSET_MD).toString("base64"),
              encoding: "base64",
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ message: ORG_POLICY_403 }), { status: 403 });
      })
    );

    const md = await fetchSkillsetFromGitHub(SOURCE_URL);

    await expect(md.readFile("a/SKILL.md")).resolves.toBeNull();
  });
});
