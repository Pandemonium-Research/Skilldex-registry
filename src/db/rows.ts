/**
 * SQLite row -> domain row.
 *
 * Every difference between what Postgres returned through PostgREST and what SQLite returns
 * is handled here, in one place, rather than scattered across query functions:
 *
 *   - `tags` and `skill_refs` are JSON text, not arrays
 *   - booleans are 0/1, since SQLite has no boolean type
 *   - `seq` exists only to anchor the FTS5 index and must never reach an API response
 *
 * Timestamps need no conversion: they are stored as the same ISO-8601 strings PostgREST
 * already emitted.
 */
import type { Row } from "@libsql/client";
import type { SkillRow } from "../types/skill.js";
import type { SkillsetRow } from "../types/skillset.js";
import type { SkillsetCoherenceResult } from "../validator/skillset-coherence.js";
import type { PublisherRow } from "../types/publisher.js";

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}

function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function bool(v: unknown): boolean {
  return v === 1 || v === 1n || v === true || v === "1";
}

/**
 * Parse a JSON array column back to a JS array.
 *
 * Returns null for a null column so `tags: string[] | null` keeps its meaning — the API layer
 * turns null into [], and collapsing the two here would hide "no tags recorded" behind
 * "tags recorded as empty". Malformed JSON yields null rather than throwing: a bad row should
 * not take down a search that happens to include it.
 */
function jsonArray<T>(v: unknown): T[] | null {
  if (v == null) return null;
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

/**
 * Parse a JSON object column. Arrays are rejected along with malformed text, for the same reason
 * jsonArray rejects objects: a column whose shape has drifted should read as absent rather than
 * hand a caller something it will destructure incorrectly.
 */
function jsonObject<T>(v: unknown): T | null {
  if (v == null) return null;
  try {
    const parsed = JSON.parse(String(v));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export function toSkillRow(r: Row): SkillRow {
  return {
    id: str(r.id),
    name: str(r.name),
    display_name: strOrNull(r.display_name),
    owner: str(r.owner),
    description: str(r.description),
    author: strOrNull(r.author),
    source_url: str(r.source_url),
    trust_tier: str(r.trust_tier) as SkillRow["trust_tier"],
    score: numOrNull(r.score),
    spec_version: str(r.spec_version),
    tags: jsonArray<string>(r.tags),
    install_count: Number(r.install_count ?? 0),
    content_key: strOrNull(r.content_key),
    published_at: str(r.published_at),
    updated_at: str(r.updated_at),
    published_by: strOrNull(r.published_by),
  };
}

export function toSkillsetRow(r: Row): SkillsetRow {
  return {
    id: str(r.id),
    name: str(r.name),
    description: str(r.description),
    author: strOrNull(r.author),
    source_url: str(r.source_url),
    trust_tier: str(r.trust_tier) as SkillsetRow["trust_tier"],
    score: numOrNull(r.score),
    spec_version: str(r.spec_version),
    tags: jsonArray<string>(r.tags),
    skill_refs: jsonArray<SkillsetRow["skill_refs"][number]>(r.skill_refs) ?? [],
    skill_count: Number(r.skill_count ?? 0),
    install_count: Number(r.install_count ?? 0),
    published_at: str(r.published_at),
    updated_at: str(r.updated_at),
    published_by: strOrNull(r.published_by),
    members_checked: numOrNull(r.members_checked),
    members_coherent: numOrNull(r.members_coherent),
    coherence: jsonObject<SkillsetCoherenceResult>(r.coherence),
    coherence_pct: numOrNull(r.coherence_pct),
  };
}

export function toPublisherRow(r: Row): PublisherRow {
  return {
    id: str(r.id),
    github_handle: str(r.github_handle),
    email: strOrNull(r.email),
    verified: bool(r.verified),
    created_at: str(r.created_at),
  };
}

/** JSON for a nullable array column. Keeps null distinct from []. */
export function jsonOrNull(v: unknown[] | null | undefined): string | null {
  return v == null ? null : JSON.stringify(v);
}

export function toSpecVersion(r: Row): {
  version: string;
  released_at: string | null;
  changelog_url: string | null;
  is_current: boolean;
} {
  return {
    version: str(r.version),
    released_at: strOrNull(r.released_at),
    changelog_url: strOrNull(r.changelog_url),
    is_current: bool(r.is_current),
  };
}
