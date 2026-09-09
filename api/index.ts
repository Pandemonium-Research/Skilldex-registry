// Vercel entrypoint.
//
// Uses hono/vercel — the Web-standard adapter, `(app) => (req) => app.fetch(req)` — rather than
// @hono/node-server/vercel, which rebuilds a Request from Node's IncomingMessage.
//
// That rebuild is why no POST to this registry had ever succeeded. The node-server adapter takes
// the body from `incoming.rawBody` when Vercel supplies it and otherwise falls through to
// `Readable.toWeb(incoming)`. Vercel's Node runtime consumes the incoming stream itself, so that
// fallback yields a stream which never emits: `await c.req.json()` waited forever and the platform
// killed the function at 300 seconds. Every GET was fine and every POST timed out, including one
// carrying Content-Length: 0 — there was nothing to read and it still hung.
//
// It went unnoticed because skills reach the database through the GitHub Actions seeder rather
// than the API: `skills.published_by` was non-null zero times and `skillsets` was empty for the
// entire life of the deployment, so nothing ever exercised a write.
//
// Passing the Request straight through removes the reconstruction, and with it the failure.

import { handle } from "hono/vercel";
import app from "../src/app.js";

export const config = { runtime: "nodejs" };

export default handle(app);
