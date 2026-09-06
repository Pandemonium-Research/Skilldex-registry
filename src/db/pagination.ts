/**
 * Bounded counting and page slicing, shared by searchSkills and searchSkillsets.
 *
 * `searchSkills` and `searchSkillsets` are near-duplicates, and that copy-paste is exactly why
 * `count(*) OVER ()` was wrong in both. Only the pieces that must be identical forever live
 * here — the cap and the eq/gte rule. WHERE-building, SORT_MAP and FROM construction stay in
 * each file, where a reader can see the SQL they produce.
 *
 * Full rationale in COUNTING_AT_SCALE.md; the short version is that ranked retrieval can
 * terminate early and counting cannot, so an exact total forfeits every top-k optimisation.
 * Elasticsearch caps at 10,000 and reports `hits.total.relation`; this is the same contract.
 */

/** The cap the API ships with. Changing this changes the public contract. */
export const DEFAULT_COUNT_CAP = 10_000;

/**
 * Deepest reachable offset.
 *
 * MUST equal the count cap. Otherwise the API contradicts itself: it reports
 * `total: 10000, total_relation: "gte"` while still serving `offset=15000`, promising results
 * it has already said it will not count.
 */
export const MAX_OFFSET = DEFAULT_COUNT_CAP;

let countCap = DEFAULT_COUNT_CAP;

export function getCountCap(): number {
  return countCap;
}

/**
 * Override the cap so tests can exercise the `gte` branch.
 *
 * Without this the branch is only reachable by inserting 10,001 fixture rows, so it would ship
 * untested — and it is the branch that only ever fires in production. Returns a restore
 * function; call it in afterEach.
 */
export function __setCountCapForTesting(n: number): () => void {
  const prev = countCap;
  countCap = n;
  return () => {
    countCap = prev;
  };
}

export type TotalRelation = "eq" | "gte";

/**
 * Count matching rows, stopping at the cap.
 *
 * The inner LIMIT is what makes this cheap: the scan stops after cap+1 rows instead of walking
 * every match. Bind cap+1 as the final argument, after the FROM and WHERE placeholders.
 *
 * `from` should be built WITHOUT bm25() — the count does not need a rank, and evaluating the
 * auxiliary function over the whole match set is the dominant cost of an FTS search.
 */
export function boundedCountSql(from: string, whereSql: string): string {
  return `SELECT count(*) AS n FROM (SELECT 1 FROM ${from} ${whereSql} LIMIT ?)`;
}

/** The argument to bind for `boundedCountSql`'s LIMIT. */
export function countLimitArg(): number {
  return getCountCap() + 1;
}

/**
 * Turn a bounded count into a total plus its relation.
 *
 * cap+1 rows means "at least cap" and nothing more precise; anything less is exact. Reporting
 * cap+1 itself would be a number no caller asked about, so it clamps to the cap.
 */
export function interpretCount(n: number): { total: number; total_relation: TotalRelation } {
  const cap = getCountCap();
  return n > cap ? { total: cap, total_relation: "gte" } : { total: n, total_relation: "eq" };
}

/**
 * Slice a `limit + 1` fetch back to `limit`, reporting whether more exists.
 *
 * Free, exact at any N, and independent of the total — which is what pagination actually needs.
 * Keep the +1 local to the SQL and call this immediately, so no downstream code can observe
 * the extra row.
 */
export function takePage<T>(rows: T[], limit: number): { page: T[]; has_more: boolean } {
  const has_more = rows.length > limit;
  return { page: has_more ? rows.slice(0, limit) : rows, has_more };
}
