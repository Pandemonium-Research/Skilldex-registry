import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import { upsertPublisher } from "../db/publishers.js";
import { requireAuth } from "../middleware/auth.js";

export const authRoutes = new Hono();

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_USER = "https://api.github.com/user";

/** Sessions last a week; the OAuth `state` round trip lasts ten minutes. */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;

/** hono/jwt requires the algorithm on verify; keep sign and verify in step. */
const JWT_ALG = "HS256" as const;

function secret(): string {
  const s = process.env.AUTH_JWT_SECRET;
  if (!s) throw new Error("Missing AUTH_JWT_SECRET environment variable");
  return s;
}

function oauthApp(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET");
  }
  return { clientId, clientSecret };
}

// GET /auth/github — start the GitHub OAuth flow
authRoutes.get("/github", async (c) => {
  const { clientId } = oauthApp();

  // `state` is a short-lived signed token rather than a server-side session: it gives CSRF
  // protection without anything to store, which matters on serverless where there is no
  // shared memory between the two requests of this flow.
  const state = await sign(
    { nonce: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS },
    secret(),
    JWT_ALG
  );

  const url = new URL(GITHUB_AUTHORIZE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${getBaseUrl(c)}/v1/auth/github/callback`);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);

  return c.redirect(url.toString());
});

// GET /auth/github/callback — exchange the code and issue our own session token
authRoutes.get("/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code) {
    return c.json({ error: "Missing authorization code", code: "INVALID_CALLBACK" }, 400);
  }

  try {
    if (!state) throw new Error("missing state");
    await verify(state, secret(), JWT_ALG);
  } catch {
    return c.json({ error: "Invalid or expired OAuth state", code: "INVALID_CALLBACK" }, 400);
  }

  const { clientId, clientSecret } = oauthApp();

  const tokenRes = await fetch(GITHUB_TOKEN, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${getBaseUrl(c)}/v1/auth/github/callback`,
    }),
  });

  const token = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenRes.ok || !token.access_token) {
    return c.json({ error: "Failed to exchange code for token", code: "AUTH_ERROR" }, 400);
  }

  const userRes = await fetch(GITHUB_USER, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "skilldex-registry",
    },
  });

  if (!userRes.ok) {
    return c.json({ error: "Failed to read GitHub profile", code: "AUTH_ERROR" }, 400);
  }

  const user = (await userRes.json()) as { login?: string; email?: string | null };
  if (!user.login) {
    return c.json({ error: "GitHub profile has no login", code: "AUTH_ERROR" }, 400);
  }

  const publisher = await upsertPublisher(user.login, user.email ?? null);

  // The session subject is the GitHub handle, which is what publishers are keyed on. The
  // previous flow issued a Supabase token whose user id was compared against publishers.id —
  // two unrelated UUIDs, so every authenticated request failed.
  const sessionToken = await sign(
    {
      sub: publisher.github_handle,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    },
    secret(),
    JWT_ALG
  );

  return c.json({
    token: sessionToken,
    publisher: {
      github_handle: publisher.github_handle,
      verified: publisher.verified,
    },
  });
});

// GET /auth/me — get current authenticated publisher
authRoutes.get("/me", requireAuth, async (c) => {
  const publisher = c.get("publisher");

  return c.json({
    github_handle: publisher.github_handle,
    verified: publisher.verified,
  });
});

// --- Helpers ---

function getBaseUrl(c: any): string {
  const proto = c.req.header("x-forwarded-proto") || "http";
  const host = c.req.header("host") || "localhost:3000";
  return `${proto}://${host}`;
}
