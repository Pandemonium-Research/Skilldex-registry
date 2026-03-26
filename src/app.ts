import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoutes } from "./routes/health.js";
import { skillsRoutes } from "./routes/skills.js";
import { installRoutes } from "./routes/install.js";
import { publishRoutes } from "./routes/publish.js";
import { authRoutes } from "./routes/auth.js";
import { specRoutes } from "./routes/spec.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { rateLimit } from "./middleware/rateLimit.js";

const app = new Hono();

app.use("*", cors());
app.onError(errorHandler);

const v1 = new Hono();

v1.route("/health", healthRoutes);

v1.use("/skills", rateLimit({ max: 100, windowMs: 60_000 }));
v1.use("/skills/*/install", rateLimit({ max: 500, windowMs: 60_000 }));

v1.route("/skills", skillsRoutes);
v1.route("/skills", installRoutes);
v1.route("/skills", publishRoutes);
v1.route("/auth", authRoutes);
v1.route("/spec-versions", specRoutes);

app.route("/v1", v1);

export default app;
