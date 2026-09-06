import { z } from "zod";
import { MAX_OFFSET } from "../db/pagination.js";

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
}

// --- API response shape ---

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
}

// --- Zod schemas ---

export const searchSkillsetsSchema = z.object({
  q: z.string().optional(),
  tier: z.enum(["verified", "community"]).optional(),
  min_score: z.coerce.number().int().min(0).max(100).optional(),
  spec_version: z.string().optional(),
  tags: z.string().optional(), // comma-separated
  // No static default: the effective sort depends on whether `q` is present, and that
  // cannot be expressed here. Resolved in the db layer — a text search defaults to
  // relevance, a browse defaults to installs.
  sort: z.enum(["relevance", "installs", "score", "recent", "name"]).optional(),
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
  };
}
