/**
 * Opt-out / takedown administration.
 *
 * Phase 7. Records a tombstone and removes everything it covers. The tombstone is permanent and
 * is consulted by the seeder and the corpus build, so a re-import cannot bring the content
 * back — see schema/sqlite/003_delistings.sql.
 *
 *   npm run delist -- list
 *   npm run delist -- preview owner majiayu000
 *   npm run delist -- add owner majiayu000 --reason "author request" --by "@majiayu000"
 *   npm run delist -- add repo  acme/skills
 *   npm run delist -- add skill acme/pdf-extractor
 *   npm run delist -- remove owner majiayu000
 *
 * `preview` is not optional politeness: an owner-scope delisting on a bulk uploader removes
 * tens of thousands of rows, and the rows are gone afterwards. Always look first.
 */
import { createClient } from "@libsql/client";
import {
  applyDelisting,
  countMatching,
  listDelistings,
  removeDelisting,
  type DelistScope,
} from "../src/db/delistings.js";
import { refreshStats } from "../src/db/stats.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
};

const url = flag("url") ?? process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error("no database: pass --url or set TURSO_DATABASE_URL");
  process.exit(1);
}

const db = createClient({
  url,
  authToken: url.startsWith("file:") ? undefined : process.env.TURSO_AUTH_TOKEN,
});

const SCOPES: DelistScope[] = ["owner", "repo", "skill"];

function usage(): never {
  console.error(
    "usage:\n" +
      "  delist list\n" +
      "  delist preview <owner|repo|skill> <value>\n" +
      "  delist add     <owner|repo|skill> <value> [--reason R] [--by WHO]\n" +
      "  delist remove  <owner|repo|skill> <value>"
  );
  process.exit(1);
}

function parseTarget(): { scope: DelistScope; value: string } {
  const scope = argv[1] as DelistScope;
  const value = argv[2];
  if (!SCOPES.includes(scope) || !value) usage();
  if (scope === "repo" && value.split("/").length !== 2) {
    console.error(`repo scope expects "owner/repo", got "${value}"`);
    process.exit(1);
  }
  if (scope === "skill" && value.split("/").length < 2) {
    console.error(`skill scope expects "owner/name", got "${value}"`);
    process.exit(1);
  }
  return { scope, value };
}

if (cmd === "list") {
  const rows = await listDelistings(db);
  if (rows.length === 0) {
    console.log("no delistings");
  } else {
    for (const d of rows) {
      console.log(
        `${d.scope.padEnd(5)} ${d.value.padEnd(40)} ${String(d.removed).padStart(7)} removed  ` +
          `${d.created_at.slice(0, 10)}  ${d.requested_by ?? "-"}  ${d.reason ?? ""}`
      );
    }
  }
} else if (cmd === "preview") {
  const { scope, value } = parseTarget();
  const n = await countMatching(scope, value, db);
  console.log(`${scope} "${value}" currently matches ${n.toLocaleString()} skill(s)`);
  if (n > 0) console.log("these rows will be DELETED and cannot be restored from the registry");
} else if (cmd === "add") {
  const { scope, value } = parseTarget();
  const before = await countMatching(scope, value, db);
  console.log(`${scope} "${value}" matches ${before.toLocaleString()} skill(s) — applying…`);

  const removed = await applyDelisting(
    { scope, value, reason: flag("reason"), requested_by: flag("by") },
    db
  );
  console.log(`removed ${removed.toLocaleString()} skill(s); tombstone recorded`);

  const stats = await refreshStats(db);
  console.log(`stats refreshed: ${stats.skills_total.toLocaleString()} skills remain`);
} else if (cmd === "remove") {
  const { scope, value } = parseTarget();
  const ok = await removeDelisting(scope, value, db);
  console.log(
    ok
      ? `tombstone lifted. The rows are still gone — they return on the next seed or corpus\n` +
          `build, from source. Install counts do not come back.`
      : "no such delisting"
  );
} else {
  usage();
}
