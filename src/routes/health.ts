import { Hono } from "hono";

export const healthRoutes = new Hono();

/**
 * `version` is the registry package's, and it does not move: the registry is deployed, not
 * released. What identifies a deployment is its commit. Vercel exposes it at runtime, and it
 * answers "which build is live?" — the question a deploy that lags `main` makes urgent, and one
 * this endpoint could not answer. Null outside Vercel.
 */
healthRoutes.get("/", (c) => {
  return c.json({
    status: "ok",
    version: "1.0.0",
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  });
});
