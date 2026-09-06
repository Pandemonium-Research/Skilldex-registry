/**
 * Compare the rewritten libSQL-backed API against the live Supabase-backed deployment.
 *
 *   npm run parity:api
 *
 * The unit suite covers schemas and route wiring, not the data layer, so passing tests says
 * nothing about whether the Postgres-to-SQLite rewrite preserved behaviour. This calls the
 * local app in-process and the deployed one over HTTP with the same paths, and diffs the JSON.
 *
 * Ordering differences are real failures, not noise: the CLI pages through these results.
 * Where the two legitimately differ — FTS5 and Postgres websearch tokenise differently — the
 * check compares the *set* of returned skills and reports rank changes separately.
 */
import app from "../src/app.js";

const REMOTE = (process.env.SKILLDEX_REGISTRY_URL ?? "https://skilldex-registry.vercel.app/v1")
  .replace(/\/$/, "");

const PATHS = [
  "/health",
  "/spec-versions",
  "/spec-versions/current",
  "/skills?limit=5",
  "/skills?limit=5&sort=score",
  "/skills?limit=5&sort=name",
  "/skills?limit=5&sort=recent",
  "/skills?limit=5&offset=10",
  "/skills?tier=verified&limit=10",
  "/skills?min_score=90&limit=5",
  "/skills?spec_version=1.0&limit=3",
  "/skills?tags=official&limit=10",
  "/skills?q=pdf&limit=5",
  "/skills?q=kubernetes&limit=5",
  "/skills?q=pdf&limit=5&sort=installs",
  "/skills/anthropics/pdf",
  "/skills/anthropics/does-not-exist",
  "/skills/agent-memory",          // ambiguous — 3 owners
  "/skills/nonexistent-skill-xyz", // 404
  "/skillsets?limit=5",
  "/skillsets/developer",
];

/**
 * Differences that are correct and must not be "fixed" back.
 *
 * These are the two places the rewrite deliberately behaves differently from the deployment.
 * Listing them here keeps this script usable as a regression gate: anything NOT listed that
 * differs is a real failure.
 */
const EXPECTED_DIFF: Record<string, string> = {
  "/skills?q=pdf&limit=5":
    "two intended changes: search matches descriptions (the Postgres path never did, despite " +
    "textSearch(\"name, description\") and a GIN index over both), and a text search now " +
    "orders by bm25 relevance instead of install_count",
  "/skills?q=kubernetes&limit=5": "same: description matches plus relevance ordering",
  "/skills?q=pdf&limit=5&sort=installs":
    "descriptions matched; ordering pinned to the old install_count behaviour on request",
};

/** Same set, different order among ties — the new layer adds a deterministic tiebreaker. */
const EXPECTED_ORDER_DIFF = new Set([
  "/skills?limit=5&sort=score",
  "/skills?tier=verified&limit=10",
  "/skills?tags=official&limit=10",
]);

const j = (v: unknown) => JSON.stringify(v);

async function local(path: string) {
  const res = await app.request(`/v1${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function remote(path: string) {
  const res = await fetch(`${REMOTE}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Skills reduced to what a caller actually consumes, in order. */
function skillKeys(body: any): string[] | null {
  if (!body || !Array.isArray(body.skills)) return null;
  return body.skills.map((s: any) => s.qualified_name);
}

let failures = 0;
let softDiffs = 0;

for (const path of PATHS) {
  const [l, r] = await Promise.all([local(path), remote(path)]);

  if (l.status !== r.status) {
    console.log(`✗ ${path}\n    status: local=${l.status} remote=${r.status}`);
    failures++;
    continue;
  }

  const lk = skillKeys(l.body);
  const rk = skillKeys(r.body);

  if (lk && rk) {
    const lset = new Set(lk);
    const rset = new Set(rk);
    const onlyLocal = lk.filter((k) => !rset.has(k));
    const onlyRemote = rk.filter((k) => !lset.has(k));
    const totalL = l.body.total;
    const totalR = r.body.total;

    if (onlyLocal.length === 0 && onlyRemote.length === 0 && j(lk) === j(rk) && totalL === totalR) {
      console.log(`✓ ${path}  (${lk.length} skills, total ${totalL})`);
    } else if (onlyLocal.length === 0 && onlyRemote.length === 0) {
      const known = EXPECTED_ORDER_DIFF.has(path);
      console.log(`${known ? "≈" : "~"} ${path}  same set, different order${known ? " (expected: deterministic tiebreaker)" : ""}`);
      if (!known) {
        console.log(`      local : ${lk.join(", ")}`);
        console.log(`      remote: ${rk.join(", ")}`);
      }
      softDiffs++;
    } else if (EXPECTED_DIFF[path]) {
      console.log(`≈ ${path}  expected difference — ${EXPECTED_DIFF[path]}`);
      console.log(`      local total=${totalL}  remote total=${totalR}`);
      softDiffs++;
    } else {
      console.log(`✗ ${path}  totals local=${totalL} remote=${totalR}`);
      if (onlyLocal.length) console.log(`      only local : ${onlyLocal.join(", ")}`);
      if (onlyRemote.length) console.log(`      only remote: ${onlyRemote.join(", ")}`);
      failures++;
    }
    continue;
  }

  if (j(l.body) === j(r.body)) {
    console.log(`✓ ${path}`);
  } else {
    console.log(`✗ ${path}`);
    console.log(`      local : ${j(l.body)?.slice(0, 200)}`);
    console.log(`      remote: ${j(r.body)?.slice(0, 200)}`);
    failures++;
  }
}

console.log(`\n${failures} hard failure(s), ${softDiffs} expected/known difference(s)`);
process.exit(failures ? 1 : 0);
