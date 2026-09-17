import { serve } from "@hono/node-server";
import app from "./app.js";

const port = Number(process.env.PORT) || 3000;

// Loopback unless told otherwise. This entry point is local development only — Vercel serves
// api/index.ts — and a local run usually points at a copy of the corpus with a throwaway JWT secret,
// which nobody else on the network should be able to reach (LOCAL_REGISTRY.md).
const hostname = process.env.HOST ?? "127.0.0.1";

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Skilldex Registry running on http://${info.address}:${info.port}`);
});
