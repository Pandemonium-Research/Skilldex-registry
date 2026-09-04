import type { Skill } from "./skill.js";

export interface ApiError {
  error: string;
  code: string;
}

export interface PaginatedResponse<T> {
  skills: T[];
  total: number;
  limit: number;
  offset: number;
}

export type SkillsListResponse = PaginatedResponse<Skill>;

export interface InstallResponse {
  name: string;
  owner: string;
  /** "owner/name" — safe to echo back even when the caller used a bare name. */
  qualified_name: string;
  source_url: string;
  score: number | null;
  spec_version: string;
  trust_tier: "verified" | "community";
}

export interface ValidationDiagnostic {
  level: "error" | "warning" | "info";
  line: number | null;
  message: string;
}

export interface PublishResponse {
  skill: Skill;
  diagnostics: ValidationDiagnostic[];
}

export interface AuthResponse {
  token: string;
  publisher: {
    github_handle: string;
    verified: boolean;
  };
}

export interface SpecVersion {
  version: string;
  released_at: string | null;
  changelog_url: string | null;
  is_current: boolean;
}
