import type { Client } from "@libsql/client";
import { getDb } from "./client.js";

/**
 * Opt-out / takedown enforcement.
 *
 * See schema/sqlite/003_delistings.sql for why this deletes rows rather than flagging them.
 * The short version: a flag has to be remembered by every read path that exists now and every
 * one written later, and one missed filter silently republishes content someone asked to have
 * removed. A deleted row needs no cooperation from anybody.
 *
 * This module is therefore used in exactly two places — the purge, and the ingest guard. There
 * is deliberately nothing here for `searchSkills` to call.
 */

export type DelistScope = "owner" | "repo" | "skill";

export interface Delisting {
  scope: DelistScope;
  value: string;
  reason: string | null;
  requested_by: string | null;
  created_at: string;
  removed: number;
}

/** Identifies a skill for the ingest check. `repo` is "owner/repo" as GitHub spells it. */
export interface SkillIdentity {
  owner: string;
  repo?: string | null;
  name: string;
}

/**
 * In-memory matcher.
 *
 * Both ingest paths test every candidate row — 1.6M of them on a corpus build — so this cannot
 * be a query per row. The tombstone list is small by nature, so it loads once and matches in
 * constant time.
 */
export class DelistMatcher {
  private owners = new Set<string>();
  private repos = new Set<string>();
  private skills = new Set<string>();

  constructor(rows: Pick<Delisting, "scope" | "value">[] = []) {
    for (const { scope, value } of rows) {
      const v = value.toLowerCase();
      if (scope === "owner") this.owners.add(v);
      else if (scope === "repo") this.repos.add(v);
      else this.skills.add(v);
    }
  }

  get size(): number {
    return this.owners.size + this.repos.size + this.skills.size;
  }

  /**
   * Case-insensitive throughout: GitHub treats `Acme` and `acme` as the same account, and a
   * takedown that only covered the exact casing someone typed would be trivially defeated.
   */
  matches({ owner, repo, name }: SkillIdentity): boolean {
    if (this.owners.has(owner.toLowerCase())) return true;
    if (repo && this.repos.has(repo.toLowerCase())) return true;
    return this.skills.has(`${owner}/${name}`.toLowerCase());
  }
}

export async function loadDelistings(client?: Client): Promise<DelistMatcher> {
  try {
    // getDb() is inside the try deliberately: it throws when TURSO_DATABASE_URL is unset, and
    // this function's contract is that it degrades to an empty matcher rather than taking the
    // caller down with it.
    const db = client ?? getDb();
    const r = await db.execute("SELECT scope, value FROM delistings");
    return new DelistMatcher(
      r.rows.map((row) => ({ scope: String(row.scope) as DelistScope, value: String(row.value) }))
    );
  } catch {
    // Table absent (migration 003 not applied) or no database configured. An empty matcher is
    // the safe degradation for reads and for a local build; the purge path below fails loudly
    // instead.
    //
    // Note this fails *open* for the publish guard — a namespace stays publishable while the
    // rule cannot be read. That is narrow in practice: if the database is unreachable, the
    // insert two statements later fails anyway. The alternative, refusing every publish
    // whenever the tombstone table is unreadable, turns a missing migration into a total
    // outage of the publish path.
    return new DelistMatcher();
  }
}

export async function listDelistings(client?: Client): Promise<Delisting[]> {
  const db = client ?? getDb();
  const r = await db.execute(
    "SELECT scope, value, reason, requested_by, created_at, removed FROM delistings ORDER BY created_at DESC"
  );
  return r.rows.map((row) => ({
    scope: String(row.scope) as DelistScope,
    value: String(row.value),
    reason: row.reason === null ? null : String(row.reason),
    requested_by: row.requested_by === null ? null : String(row.requested_by),
    created_at: String(row.created_at),
    removed: Number(row.removed),
  }));
}

/**
 * The SQL that selects rows matching one tombstone.
 *
 * `repo` deliberately uses a prefix comparison rather than LIKE. Repository names may contain
 * `_`, which is a LIKE single-character wildcard — `foo_bar` would also match `fooXbar` and
 * take down an unrelated repo. Comparing a substring of the same length is exact and needs no
 * ESCAPE clause. It is a full scan either way; `skills_source_url_idx` was cut in 001 and this
 * is a rare admin operation, so that is the right trade.
 */
function matchClause(scope: DelistScope, value: string): { sql: string; args: any[] } {
  if (scope === "owner") {
    return { sql: "owner = ? COLLATE NOCASE", args: [value] };
  }
  if (scope === "skill") {
    const [owner, ...rest] = value.split("/");
    return {
      sql: "owner = ? COLLATE NOCASE AND name = ? COLLATE NOCASE",
      args: [owner, rest.join("/")],
    };
  }
  const prefix = `https://github.com/${value}/`;
  return { sql: "substr(source_url, 1, ?) = ?", args: [prefix.length, prefix] };
}

export async function countMatching(
  scope: DelistScope,
  value: string,
  client?: Client
): Promise<number> {
  const db = client ?? getDb();
  const { sql, args } = matchClause(scope, value);
  const r = await db.execute({ sql: `SELECT count(*) AS n FROM skills WHERE ${sql}`, args });
  return Number(r.rows[0].n);
}

/**
 * Record a tombstone and remove everything it covers.
 *
 * Tombstone first, deliberately. If the delete fails halfway the tombstone still stands, so a
 * retry finishes the job and no ingest can refill what was already removed. The reverse order
 * would leave a window where rows are gone but nothing stops the next seed re-adding them.
 */
export async function applyDelisting(
  entry: { scope: DelistScope; value: string; reason?: string; requested_by?: string },
  client?: Client
): Promise<number> {
  const db = client ?? getDb();
  const { sql, args } = matchClause(entry.scope, entry.value);

  await db.execute({
    sql: `INSERT INTO delistings (scope, value, reason, requested_by)
          VALUES (?,?,?,?)
          ON CONFLICT (scope, value) DO UPDATE SET
            reason = excluded.reason, requested_by = excluded.requested_by`,
    args: [entry.scope, entry.value, entry.reason ?? null, entry.requested_by ?? null],
  });

  const res = await db.execute({ sql: `DELETE FROM skills WHERE ${sql}`, args });
  const removed = res.rowsAffected;

  await db.execute({
    sql: "UPDATE delistings SET removed = removed + ? WHERE scope = ? AND value = ?",
    args: [removed, entry.scope, entry.value],
  });

  return removed;
}

/**
 * Lift a delisting.
 *
 * Only removes the tombstone — it cannot restore the rows, which are gone. The content returns
 * on the next seed or corpus build, from source. Install counts do not: that history was
 * deleted with the row, and is the acknowledged cost of the strong guarantee.
 */
export async function removeDelisting(
  scope: DelistScope,
  value: string,
  client?: Client
): Promise<boolean> {
  const db = client ?? getDb();
  const r = await db.execute({
    sql: "DELETE FROM delistings WHERE scope = ? AND value = ?",
    args: [scope, value],
  });
  return r.rowsAffected > 0;
}
