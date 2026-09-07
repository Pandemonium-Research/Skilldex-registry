import { z } from "zod";
import { MAX_OFFSET } from "../db/pagination.js";
import type { SkillsetCoherenceResult } from "../validator/skillset-coherence.js";

// --- Database row type ---

export interface SkillRef {
  name: string;
  source_url: string;
}

export interface SkillsetRow {
  id: string;
  name: string;
  description: string;
  author: string | null;
  source_url: string;
  trust_tier: "verified" | "community";
  score: number | null;
  spec_version: string;
  tags: string[] | null;
  skill_refs: SkillRef[];
  skill_count: number;
  install_count: number;
  published_at: string;
  updated_at: string;
  published_by: string | null;
  // --- Coherence (schema/sqlite/004) ---
  // The second dimension beside `score`: conformance says the skillset is well-formed, coherence
  // says its members agree with each other. null throughout means never checked, which is not the
  // same as checked and found wanting.
  members_checked: number | null;
  members_coherent: number | null;
  coherence: SkillsetCoherenceResult | null;
  /** Derived in SQL from the two counts. Never written — see the migration. */
  coherence_pct: number | null;
}

// --- API response shape ---

/**
 * Coherence as the API reports it.
 *
 * A summary, not the whole result: `searchSkillsets` returns up to 50 of these at a time, and
 * embedding every diagnostic would dominate the payload. The full result — declared conventions
 * and per-member diagnostics — comes back from POST/PATCH /skillsets, where it is what the
 * publisher needs to act on.
 */
export interface SkillsetCoherenceSummary {
  members_checked: number;
  members_coherent: number;
  /** null when no members were checked; there is no coherence to report, which is not zero. */
  pct: number | null;
  pass_count: number;
  warn_count: number;
  error_count: number;
  declared_conventions: number;
}

export interface Skillset {
  name: string;
  description: string;
  author: string | null;
  source_url: string;
  trust_tier: "verified" | "community";
  score: number | null;
  spec_version: string;
  tags: string[];
  skill_count: number;
  install_count: number;
  published_at: string;
  skills: SkillRef[];
  /** null for a skillset published before coherence was recorded. */
  coherence: SkillsetCoherenceSummary | null;
}

// --- Zod schemas ---

export const searchSkillsetsSchema = z.object({
  q: z.string().optional(),
  tier: z.enum(["verified", "community"]).optional(),
  min_score: z.coerce.number().int().min(0).max(100).optional(),
  /** Percentage of members that agree with the skillset's declared conventions. */
  min_coherence: z.coerce.number().int().min(0).max(100).optional(),
  spec_version: z.string().optional(),
  tags: z.string().optional(), // comma-separated
  // No static default: the effective sort depends on whether `q` is present, and that
  // cannot be expressed here. Resolved in the db layer — a text search defaults to
  // relevance, a browse defaults to installs.
  sort: z.enum(["relevance", "installs", "score", "recent", "name", "coherence"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Same cap as skills, so the two endpoints keep one contract.
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).default(0),
});

export type SearchSkillsetsQuery = z.infer<typeof searchSkillsetsSchema>;

export const createSkillsetSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Name must be lowercase alphanumeric with hyphens"),
  source_url: z.string().url().startsWith("https://github.com/"),
  tags: z.array(z.string().min(1).max(50)).max(10).optional(),
});

export type CreateSkillsetBody = z.infer<typeof createSkillsetSchema>;

// --- Helpers ---

export function skillsetRowToApi(row: SkillsetRow): Skillset {
  return {
    name: row.name,
    description: row.description,
    author: row.author,
    source_url: row.source_url,
    trust_tier: row.trust_tier,
    score: row.score,
    spec_version: row.spec_version,
    tags: row.tags ?? [],
    skill_count: row.skill_count,
    install_count: row.install_count,
    published_at: row.published_at,
    skills: row.skill_refs ?? [],
    coherence: coherenceSummary(row),
  };
}

/**
 * Summarise a row's coherence for the API, or null when it was never checked.
 *
 * The counts are read from their own columns rather than from the JSON blob: they are what the
 * generated `coherence_pct` is derived from, so taking them from anywhere else would let a
 * response disagree with what the database would sort by.
 */
function coherenceSummary(row: SkillsetRow): SkillsetCoherenceSummary | null {
  if (row.members_checked === null || row.members_coherent === null) return null;

  return {
    members_checked: row.members_checked,
    members_coherent: row.members_coherent,
    pct: row.coherence_pct,
    pass_count: row.coherence?.passCount ?? 0,
    warn_count: row.coherence?.warnCount ?? 0,
    error_count: row.coherence?.errorCount ?? 0,
    declared_conventions: row.coherence?.declaredConventions.length ?? 0,
  };
}
