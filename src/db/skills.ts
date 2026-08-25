import { getSupabase } from "./client.js";
import type { SkillRow } from "../types/skill.js";
import type { SearchSkillsQuery } from "../types/skill.js";

const SORT_MAP: Record<string, { column: string; ascending: boolean }> = {
  installs: { column: "install_count", ascending: false },
  score: { column: "score", ascending: false },
  recent: { column: "published_at", ascending: false },
  name: { column: "name", ascending: true },
};

export async function searchSkills(
  params: SearchSkillsQuery
): Promise<{ skills: SkillRow[]; total: number }> {
  const supabase = getSupabase();

  let query = supabase.from("skills").select("*", { count: "exact" });

  // Full-text search
  if (params.q) {
    query = query.textSearch("name, description", params.q, {
      type: "websearch",
      config: "english",
    });
  }

  // Filters
  if (params.tier) {
    query = query.eq("trust_tier", params.tier);
  }

  if (params.min_score !== undefined) {
    query = query.gte("score", params.min_score);
  }

  if (params.spec_version) {
    query = query.eq("spec_version", params.spec_version);
  }

  if (params.tags) {
    const tagList = params.tags.split(",").map((t) => t.trim());
    query = query.overlaps("tags", tagList);
  }

  // Sort
  const sort = SORT_MAP[params.sort] ?? SORT_MAP.installs;
  query = query.order(sort.column, { ascending: sort.ascending });

  // Pagination
  query = query.range(params.offset, params.offset + params.limit - 1);

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`Database query failed: ${error.message}`);
  }

  return {
    skills: (data ?? []) as SkillRow[],
    total: count ?? 0,
  };
}

export async function getSkill(owner: string, name: string): Promise<SkillRow | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("skills")
    .select("*")
    .eq("owner", owner)
    .eq("name", name)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // not found
    throw new Error(`Database query failed: ${error.message}`);
  }

  return data as SkillRow;
}

/**
 * Resolve a bare, unqualified name for CLI builds that predate the owner namespace.
 *
 * Names are only unique within an owner now, so this reports ambiguity rather than
 * picking a winner — silently resolving to whichever row came back first is how you
 * ship a skill nobody asked for.
 */
export async function getSkillByBareName(
  name: string
): Promise<{ skill: SkillRow | null; ambiguous: boolean; owners: string[] }> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("skills")
    .select("*")
    .eq("name", name)
    .limit(11);

  if (error) {
    throw new Error(`Database query failed: ${error.message}`);
  }

  const rows = (data ?? []) as SkillRow[];
  if (rows.length === 0) return { skill: null, ambiguous: false, owners: [] };
  if (rows.length === 1) return { skill: rows[0], ambiguous: false, owners: [rows[0].owner] };
  return { skill: null, ambiguous: true, owners: rows.slice(0, 10).map((r) => r.owner) };
}

export async function incrementInstallCount(
  owner: string,
  name: string
): Promise<SkillRow | null> {
  const supabase = getSupabase();

  const skill = await getSkill(owner, name);
  if (!skill) return null;

  const { data, error } = await supabase
    .from("skills")
    .update({ install_count: skill.install_count + 1 })
    .eq("owner", owner)
    .eq("name", name)
    .select("*")
    .single();

  if (error) {
    throw new Error(`Failed to increment install count: ${error.message}`);
  }

  return data as SkillRow;
}

export async function createSkill(
  skill: Omit<SkillRow, "id" | "install_count" | "published_at" | "updated_at">
): Promise<SkillRow> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("skills")
    .insert(skill)
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw Object.assign(new Error("Skill name already exists"), { code: "CONFLICT" });
    }
    throw new Error(`Failed to create skill: ${error.message}`);
  }

  return data as SkillRow;
}

export async function updateSkill(
  owner: string,
  name: string,
  updates: Partial<Pick<SkillRow, "description" | "score" | "spec_version" | "tags" | "source_url">>
): Promise<SkillRow | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("skills")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("owner", owner)
    .eq("name", name)
    .select("*")
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw new Error(`Failed to update skill: ${error.message}`);
  }

  return data as SkillRow;
}

export async function deleteSkill(owner: string, name: string): Promise<boolean> {
  const supabase = getSupabase();

  const { error, count } = await supabase
    .from("skills")
    .delete({ count: "exact" })
    .eq("owner", owner)
    .eq("name", name);

  if (error) {
    throw new Error(`Failed to delete skill: ${error.message}`);
  }

  return (count ?? 0) > 0;
}
