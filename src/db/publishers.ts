import { getDb } from "./client.js";
import { toPublisherRow } from "./rows.js";
import type { PublisherRow } from "../types/publisher.js";

export async function getPublisherById(id: string): Promise<PublisherRow | null> {
  const db = getDb();
  const r = await db.execute({
    sql: "SELECT * FROM publishers WHERE id = ? LIMIT 1",
    args: [id],
  });
  return r.rows.length ? toPublisherRow(r.rows[0]) : null;
}

export async function getPublisherByGithubHandle(
  handle: string
): Promise<PublisherRow | null> {
  const db = getDb();
  const r = await db.execute({
    sql: "SELECT * FROM publishers WHERE github_handle = ? LIMIT 1",
    args: [handle],
  });
  return r.rows.length ? toPublisherRow(r.rows[0]) : null;
}

/**
 * Upsert by github_handle, which is the real identity.
 *
 * The Postgres version let `id` default on every call while `requireAuth` looked publishers
 * up by the *Supabase auth* user id — two different UUIDs that could never match, so every
 * authenticated request failed. Identity now keys on the handle, and `id` is generated once
 * on first sight and preserved on conflict.
 */
export async function upsertPublisher(
  githubHandle: string,
  email: string | null
): Promise<PublisherRow> {
  const db = getDb();
  const r = await db.execute({
    sql: `INSERT INTO publishers (id, github_handle, email)
          VALUES (?, ?, ?)
          ON CONFLICT (github_handle) DO UPDATE SET email = excluded.email
          RETURNING *`,
    args: [crypto.randomUUID(), githubHandle, email],
  });
  return toPublisherRow(r.rows[0]);
}
