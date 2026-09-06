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
 * Attach a Cache-Control header to successful reads.
 *
 * Deliberately narrow: only GET, only 200. Anything else — a 404, a 409 AMBIGUOUS_NAME, a 429,
 * a 500 — is left uncached, so a transient failure cannot be pinned at the edge for the length
 * of the TTL.
 *
 * Mount on exact paths only. `v1.use("/skills/*", ...)` would also match
 * `/skills/:name/install`, which increments install_count and must never be cached.
 */
export function cache(policy: string): MiddlewareHandler {
  return async (c, next) => {
    await next();

    if (c.req.method !== "GET") return;
    if (c.res.status !== 200) return;

    c.header("Cache-Control", policy);
  };
}

/**
 * Explicitly forbid caching.
 *
 * Applied unconditionally — including to error responses — because the routes that need it are
 * the ones where a cached response is actively harmful: `/auth/*` carries tokens, and the
 * install endpoints are GETs that increment `install_count`, so an edge-cached response would
 * silently stop counting installs.
 *
 * Vercel does not cache a response with no Cache-Control, so this is belt-and-braces rather
 * than a fix for present behaviour. It is here so that adding a broad cache rule later cannot
 * quietly capture these routes.
 */
export function noStore(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  };
}
