import { z } from "zod";
import { MAX_OFFSET } from "../db/pagination.js";

// --- Database row type ---

export interface SkillRow {
  id: string;
  /** URL slug, unique within an owner. Not globally unique. */
  name: string;
  /** The skill's authored name, before slugification. */
  display_name: string | null;
  owner: string;
  description: string;
  author: string | null;
  source_url: string;
  trust_tier: "verified" | "community";
  score: number | null;
  spec_version: string;
  tags: string[] | null;
  install_count: number;
  /** SHA of the SKILL.md bytes for imported skills; null for hand-published ones. */
  content_key: string | null;
  published_at: string;
  updated_at: string;
  published_by: string | null;
}

// --- API response shape ---

export interface Skill {
  name: string;
  display_name: string | null;
  owner: string;
  /** "owner/name" — how the CLI addresses a skill. */
  qualified_name: string;
  description: string;
  author: string | null;
  source_url: string;
  trust_tier: "verified" | "community";
  score: number | null;
  spec_version: string;
  tags: string[];
  install_count: number;
  published_at: string;
}

// --- Zod schemas ---

export const searchSkillsSchema = z.object({
  q: z.string().optional(),
  tier: z.enum(["verified", "community"]).optional(),
  min_score: z.coerce.number().int().min(0).max(100).optional(),
  spec_version: z.string().optional(),
  tags: z.string().optional(), // comma-separated
  owner: z.string().optional(),
  // Provenance filter, using the column's own values. Unset means the whole registry.
  //
  // Deliberately NOT defaulted. An earlier revision defaulted this to the seeded tier on the
  // grounds that all the ordering signal lives there — true, but that is an argument about
  // sorting an unfiltered list, not about search. bm25 ranks fine across the full corpus, and
  // defaulting to 0.3% of the registry defeats the point of importing the other 99.7%.
  source: z.enum(["seeded", "imported", "published"]).optional(),
  // No static default: the effective sort depends on whether `q` is present, and that
  // cannot be expressed here. Resolved in the db layer — a text search defaults to
  // relevance, a browse defaults to installs.
  sort: z.enum(["relevance", "installs", "score", "recent", "name"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Capped, and the cap MUST equal the count cap. LIMIT 20 OFFSET 100000 walks 100,000 index
  // entries; deep pages cannot be served regardless of what the count says, so refusing them
  // is more honest than timing out on them.
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).default(0),
});

export type SearchSkillsQuery = z.infer<typeof searchSkillsSchema>;

export const createSkillSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    // Mirrors KEBAB_CASE in src/validator/index.ts. The previous pattern
    // (^[a-z0-9][a-z0-9-]*[a-z0-9]$) required at least two characters, so it rejected
    // single-character names that the validator itself accepts.
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Name must be lowercase alphanumeric with single hyphens between segments"
    ),
  source_url: z.string().url().startsWith("https://github.com/"),
  tags: z.array(z.string().min(1).max(50)).max(10).optional(),
});

export type CreateSkillBody = z.infer<typeof createSkillSchema>;

// --- Helpers ---

/**
 * Reduce an authored skill name to a URL slug matching createSkillSchema's rule.
 *
 * Hand-published skills must already be kebab-case, but 6.7% of imported names are
 * not — `video_frames`, `Code Review`, and non-Latin names like `GIF搜索器`. The
 * authored form is kept in display_name; this produces what goes in the URL.
 *
 * `fallbackKey` (the content_key) is used when a name slugifies to nothing, which
 * happens for names with no ASCII alphanumerics at all. It is expected to be hex, but
 * is sanitized anyway — this function's contract is that its output always passes
 * createSkillSchema, and that must not depend on the caller passing a clean key.
 */
export function slugifySkillName(raw: string | null, fallbackKey: string): string {
  const slug = (raw ?? "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100)
    .replace(/-$/, "");
  if (slug) return slug;

  const key = fallbackKey.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  return key ? `skill-${key}` : "skill";
}

export function skillRowToApi(row: SkillRow): Skill {
  return {
    name: row.name,
    display_name: row.display_name,
    owner: row.owner,
    qualified_name: `${row.owner}/${row.name}`,
    description: row.description,
    author: row.author,
    source_url: row.source_url,
    trust_tier: row.trust_tier,
    score: row.score,
    spec_version: row.spec_version,
    tags: row.tags ?? [],
    install_count: row.install_count,
    published_at: row.published_at,
  };
}
