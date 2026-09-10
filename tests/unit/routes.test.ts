import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { healthRoutes } from "../../src/routes/health.js";

describe("Health route", () => {
  const app = new Hono();
  app.route("/health", healthRoutes);
  const ORIGINAL_SHA = process.env.VERCEL_GIT_COMMIT_SHA;

  afterEach(() => {
    if (ORIGINAL_SHA === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = ORIGINAL_SHA;
  });

  it("returns ok status, with no commit outside Vercel", async () => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    const res = await app.request("/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body).toEqual({ status: "ok", version: "1.0.0", commit: null });
  });

  it("reports the deployed commit, so a deploy that lags main is visible", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "fc54e59d0c1ab2345678901234567890abcdef12";
    const body = (await (await app.request("/health")).json()) as any;
    expect(body.commit).toBe("fc54e59d0c1ab2345678901234567890abcdef12");
  });
});

describe("Skills route input validation", () => {
  it("validates search params schema", async () => {
    const { searchSkillsSchema } = await import("../../src/types/skill.js");

    // Valid params
    const valid = searchSkillsSchema.safeParse({
      q: "forensics",
      tier: "verified",
      sort: "score",
      limit: "10",
      offset: "0",
    });
    expect(valid.success).toBe(true);

    // Invalid tier
    const invalidTier = searchSkillsSchema.safeParse({
      tier: "invalid",
    });
    expect(invalidTier.success).toBe(false);

    // Limit out of range. 100 is the inclusive maximum, so 101 is the first invalid
    // value — this previously asserted on "100" and failed.
    const atMax = searchSkillsSchema.safeParse({ limit: "100" });
    expect(atMax.success).toBe(true);

    const bigLimit = searchSkillsSchema.safeParse({
      limit: "101",
    });
    expect(bigLimit.success).toBe(false);
  });

  it("slugifies imported skill names", async () => {
    const { slugifySkillName, createSkillSchema } = await import(
      "../../src/types/skill.js"
    );
    const key = "abcdef0123456789";

    expect(slugifySkillName("Code Review", key)).toBe("code-review");
    expect(slugifySkillName("video_frames", key)).toBe("video-frames");
    expect(slugifySkillName("  Trailing--Dashes  ", key)).toBe("trailing-dashes");

    // Names with no ASCII alphanumerics fall back to the content key rather than
    // producing an empty slug.
    expect(slugifySkillName("GIF搜索器", key)).toBe("gif");
    expect(slugifySkillName("搜索器", key)).toBe("skill-abcdef01");
    expect(slugifySkillName(null, key)).toBe("skill-abcdef01");

    // A caller passing a non-hex key must still get a legal name out.
    expect(slugifySkillName("搜索器", "https://github.com/o/r")).toBe("skill-httpsgit");
    expect(slugifySkillName("搜索器", "///")).toBe("skill");

    // Whatever comes out must satisfy the publish-time name rule.
    for (const raw of ["Code Review", "video_frames", "搜索器", null, "a"]) {
      const slug = slugifySkillName(raw, key);
      const ok = createSkillSchema.safeParse({
        name: slug,
        source_url: "https://github.com/o/r",
      });
      expect(ok.success, `slug ${JSON.stringify(slug)} failed name validation`).toBe(true);
    }
  });

  it("validates create skill schema", async () => {
    const { createSkillSchema } = await import("../../src/types/skill.js");

    // Valid body
    const valid = createSkillSchema.safeParse({
      name: "forensics-agent",
      source_url: "https://github.com/user/forensics-agent",
      tags: ["forensics"],
    });
    expect(valid.success).toBe(true);

    // Invalid name (uppercase)
    const invalidName = createSkillSchema.safeParse({
      name: "Forensics-Agent",
      source_url: "https://github.com/user/forensics-agent",
    });
    expect(invalidName.success).toBe(false);

    // Invalid source_url (not GitHub)
    const invalidUrl = createSkillSchema.safeParse({
      name: "forensics-agent",
      source_url: "https://gitlab.com/user/forensics-agent",
    });
    expect(invalidUrl.success).toBe(false);

    // Missing required fields
    const missing = createSkillSchema.safeParse({});
    expect(missing.success).toBe(false);
  });
});

describe("Rate limiter", () => {
  it("allows requests within limit", async () => {
    const { rateLimit } = await import("../../src/middleware/rateLimit.js");

    const app = new Hono();
    app.use("*", rateLimit({ max: 3, windowMs: 60_000 }));
    app.get("/", (c) => c.json({ ok: true }));

    // First 3 should pass
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/");
      expect(res.status).toBe(200);
    }

    // 4th should be rate limited
    const res = await app.request("/");
    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body.code).toBe("RATE_LIMITED");
  });
});
