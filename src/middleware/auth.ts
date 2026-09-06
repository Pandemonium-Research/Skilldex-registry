import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";
import type { JWTPayload } from "hono/utils/jwt/types";
import { getPublisherByGithubHandle } from "../db/publishers.js";
import type { PublisherRow } from "../types/publisher.js";

// Extend Hono context with publisher
declare module "hono" {
  interface ContextVariableMap {
    publisher: PublisherRow;
  }
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid authorization header", code: "UNAUTHORIZED" }, 401);
  }

  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error("Missing AUTH_JWT_SECRET environment variable");

  let payload: JWTPayload;
  try {
    // The algorithm is explicit so a token signed with a different one is rejected rather
    // than trusted — "alg: none" style confusion is exactly what that guards against.
    payload = await verify(authHeader.slice(7), secret, "HS256");
  } catch {
    return c.json({ error: "Invalid or expired token", code: "UNAUTHORIZED" }, 401);
  }

  const handle = typeof payload.sub === "string" ? payload.sub : null;
  if (!handle) {
    return c.json({ error: "Invalid or expired token", code: "UNAUTHORIZED" }, 401);
  }

  // Keyed on github_handle, which is UNIQUE and is what the session subject carries. The
  // previous version looked up publishers.id using the Supabase auth user id — values that
  // are never equal, so this branch always 401'd.
  const publisher = await getPublisherByGithubHandle(handle);

  if (!publisher) {
    return c.json({ error: "Publisher account not found", code: "UNAUTHORIZED" }, 401);
  }

  c.set("publisher", publisher);
  await next();
};
