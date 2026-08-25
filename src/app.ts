import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoutes } from "./routes/health.js";
import { skillsRoutes } from "./routes/skills.js";
import { installRoutes } from "./routes/install.js";
import { publishRoutes } from "./routes/publish.js";
import { authRoutes } from "./routes/auth.js";
import { specRoutes } from "./routes/spec.js";
import { skillsetsRoutes } from "./routes/skillsets.js";
import { skillsetsInstallRoutes } from "./routes/skillsets-install.js";
import { skillsetsPublishRoutes } from "./routes/skillsets-publish.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { rateLimit } from "./middleware/rateLimit.js";

const app = new Hono();

app.use("*", cors());
app.onError(errorHandler);

const v1 = new Hono();

v1.route("/health", healthRoutes);

v1.use("/skills", rateLimit({ max: 100, windowMs: 60_000 }));
// Both shapes: /skills/:name/install (legacy) and /skills/:owner/:name/install.
v1.use("/skills/*/install", rateLimit({ max: 500, windowMs: 60_000 }));
v1.use("/skills/*/*/install", rateLimit({ max: 500, windowMs: 60_000 }));

// installRoutes MUST be mounted before skillsRoutes. The legacy install path
// /skills/:name/install has the same segment count as /skills/:owner/:name, so if
// skills matched first, `GET /skills/foo/install` would resolve as owner=foo,
// name=install and the legacy install route would be unreachable.
v1.route("/skills", installRoutes);
v1.route("/skills", skillsRoutes);
v1.route("/skills", publishRoutes);
v1.route("/auth", authRoutes);
v1.route("/spec-versions", specRoutes);

v1.use("/skillsets", rateLimit({ max: 100, windowMs: 60_000 }));
v1.use("/skillsets/*/install", rateLimit({ max: 500, windowMs: 60_000 }));

v1.route("/skillsets", skillsetsRoutes);
v1.route("/skillsets", skillsetsInstallRoutes);
v1.route("/skillsets", skillsetsPublishRoutes);

app.route("/v1", v1);

export default app;
