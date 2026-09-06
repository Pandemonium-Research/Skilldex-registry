import type { MiddlewareHandler } from "hono";

/**
 * Cache-Control policies for the read endpoints.
 *
 * `max-age=0, s-maxage=N` gives the browser a revalidate while letting the Vercel CDN serve
 * from the edge — one header, two behaviours, with no need for CDN-Cache-Control.
 *
 * Why this lives in Hono and not vercel.json: vercel.json matches on request path, but
 * vercel.json rewrites *every* path to /api/index, so a rule for `/v1/skills` would apply to
 * `POST /v1/skills` (publish) as well as the GET. It also cannot condition on response status,
 * and a 500 cached at the edge for 60s is a self-inflicted outage.
 *
 * NOTE: `src/app.ts` uses bare `cors()`, which emits `Access-Control-Allow-Origin: *`. That is
 * origin-independent, so shared caching is safe. If anyone changes it to
 * `cors({ origin: [...] })`, responses become origin-dependent and every one of these needs
 * `Vary: Origin` or the CDN can serve a response to the wrong origin.
 */

/** Search and list endpoints. Short edge TTL — the corpus changes nightly at most. */
export const CACHE_LIST = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

/** Individual skill/skillset lookups. A given skill changes very rarely. */
export const CACHE_DETAIL = "public, max-age=0, s-maxage=300, stale-while-revalidate=86400";

/** Headline counts. Refreshed by the nightly seeder, so staleness is bounded anyway. */
export const CACHE_STATS = "public, max-age=60, s-maxage=300, stale-while-revalidate=3600";

/** Spec versions change on release cadence, i.e. almost never. */
export const CACHE_STATIC = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

/**
 * ⚠ Set these headers INSIDE a route handler, on the success path, e.g.
 *
 *     c.header("Cache-Control", CACHE_LIST);
 *     return c.json(body);
 *
 * NOT from middleware after `await next()`. That form works under Hono's in-process
 * `app.request()` — a test asserting it will pass — but the header is lost by the Vercel
 * adapter, which reads the response before the post-next mutation lands. Measured on the
 * deployed API: a middleware-set policy produced Vercel's default
 * `public, max-age=0, must-revalidate` with `x-vercel-cache: MISS` on every request, while the
 * identical policy set inside a handler produced `x-vercel-cache: HIT`.
 *
 * Setting it on the success return also gates it for free: a 404, a 409 AMBIGUOUS_NAME or a
 * 400 never reaches the line, so a transient failure cannot be pinned at the edge for the
 * length of the TTL.
 *
 * Vercel strips `s-maxage` from what it sends the browser and reports `public, max-age=0`,
 * having consumed the directive for edge caching. `x-vercel-cache`, not `cache-control`, is
 * what tells you whether it worked.
 */

/**
 * Explicitly forbid caching.
 *
 * Set BEFORE `next()`, which is why this one can stay middleware — no status gate is wanted
 * here, and headers set before the handler runs survive the adapter (the rate limiter relies
 * on the same thing).
 *
 * A response with no Cache-Control is not edge-cached by Vercel anyway, so this is
 * belt-and-braces: it exists so that adding a broad cache rule later cannot quietly capture
 * `/auth/*` (which carries tokens) or the install endpoints (GETs that increment
 * install_count, where an edge hit would silently stop counting installs).
 */
export function noStore(): MiddlewareHandler {
  return async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  };
}
