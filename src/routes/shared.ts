import type { Context } from "hono";
import type { ZodError } from "zod";
import { MAX_OFFSET } from "../db/pagination.js";

/**
 * Shape a failed query-parameter parse.
 *
 * The previous behaviour returned a flat `INVALID_PARAMS` for every zod failure, which gave a
 * client no way to tell "offset too deep" — retryable by refining the search — from "tier must
 * be verified|community", which is a bug in the caller. Deep offsets are now the common case
 * worth naming, since the cap is new and existing clients have never seen it.
 *
 * Still 400: a malformed query parameter, matching the existing convention.
 */
export function invalidParams(c: Context, error: ZodError) {
  const offsetIssue = error.issues.find((i) => i.path[0] === "offset");

  if (offsetIssue) {
    return c.json(
      {
        error: `offset must not exceed ${MAX_OFFSET}; refine your query to reach deeper results`,
        code: "OFFSET_TOO_LARGE",
        max_offset: MAX_OFFSET,
      },
      400
    );
  }

  return c.json(
    {
      error: "Invalid query parameters",
      code: "INVALID_PARAMS",
      // Costs nothing and makes every other validation failure debuggable.
      details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    },
    400
  );
}
