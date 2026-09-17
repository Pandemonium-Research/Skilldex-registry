import type { ErrorHandler } from "hono";

export const errorHandler: ErrorHandler = (err, c) => {
  console.error(`[Error] ${err.message}`);

  const code = (err as any).code;

  // Turso refuses every statement once an account exceeds a plan quota, with LibsqlError code
  // BLOCKED — the whole registry went down this way on 2026-09-15 (FINDINGS §16). Say that it is
  // an outage rather than a server bug, and never let the response be cached.
  if (code === "BLOCKED" || /^BLOCKED\b/.test(err.message)) {
    c.header("Cache-Control", "no-store");
    return c.json(
      { error: "Registry database temporarily unavailable", code: "DB_UNAVAILABLE" },
      503
    );
  }

  if (code === "CONFLICT") {
    return c.json({ error: err.message, code: "CONFLICT" }, 409);
  }

  return c.json(
    { error: "Internal server error", code: "INTERNAL_ERROR" },
    500
  );
};
