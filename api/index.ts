// Vercel entrypoint.
//
// No POST to this registry had ever succeeded. `skills.published_by` was non-null zero times and
// `skillsets` was empty for the life of the deployment — every one of the 1.6M rows arrived through
// the GitHub Actions seeder writing straight to the database, so nothing exercised a write and the
// outage stayed invisible until someone tried to publish a skillset.
//
// The cause is in @hono/node-server/vercel's newRequestFromIncoming, which fills the body from the
// first of three branches that applies:
//
//   1. `incoming.rawBody` when it is a Buffer
//   2. a lazily-wrapped stream, when the adapter marked the request for it
//   3. otherwise `Readable.toWeb(incoming)` — the raw stream
//
// Vercel's Node runtime parses the request body itself and hands the function the result on
// `req.body`, which consumes the underlying stream. Branch 3 therefore handed Hono a stream that
// never emits, `await c.req.json()` waited forever, and the platform killed the function at 300
// seconds. Every GET was fine; every POST timed out, including one sent with Content-Length: 0 —
// nothing to read, and it still hung, which is what ruled out the body's contents, the GitHub
// fetches and the database in turn.
//
// The fix is to take branch 1: hand the adapter back the bytes Vercel already read. Swapping to
// hono/vercel — `(app) => (req) => app.fetch(req)` — looks tidier and would break everything: it
// expects a Web Request, and the fact that GETs work through this adapter is proof that Vercel
// passes Node objects here. There is no preview environment for this project (only `main` is
// deployed), so the entrypoint has to be safe on the first attempt rather than verifiable before.
//
// This change cannot regress a GET: the restore is skipped entirely unless a parsed body is
// present, which it never is for GET or HEAD.

import type { IncomingMessage, ServerResponse } from "node:http";
import { handle } from "@hono/node-server/vercel";
import app from "../src/app.js";

export const config = { runtime: "nodejs" };

const inner = handle(app);

/** What Vercel's Node runtime actually hands us, beyond a plain IncomingMessage. */
type VercelIncoming = IncomingMessage & { body?: unknown; rawBody?: unknown };

/**
 * Re-expose Vercel's already-parsed body as `rawBody` so the adapter takes its Buffer branch.
 *
 * Returns a short description of what happened, which is logged: if a POST still fails after this,
 * the log says which case it hit, and one deploy answers the question either way. There is no
 * preview to experiment on, so the diagnostic is the substitute.
 */
function restoreRawBody(req: VercelIncoming): string {
  if (Buffer.isBuffer(req.rawBody)) return "rawBody already present — adapter needs no help";
  if (req.body === undefined || req.body === null) return "no parsed body — stream left untouched";

  const raw = Buffer.isBuffer(req.body)
    ? req.body
    : typeof req.body === "string"
      ? Buffer.from(req.body)
      : Buffer.from(JSON.stringify(req.body));

  // configurable so a retry on a reused request object can overwrite it rather than throw.
  Object.defineProperty(req, "rawBody", { value: raw, configurable: true, enumerable: false });
  return `restored ${raw.byteLength}B onto rawBody from req.body (${typeof req.body})`;
}

export default function handler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const method = req.method ?? "GET";

  if (method !== "GET" && method !== "HEAD") {
    console.log(`[entry] ${method} ${req.url} — ${restoreRawBody(req as VercelIncoming)}`);
  }

  return inner(req, res);
}
