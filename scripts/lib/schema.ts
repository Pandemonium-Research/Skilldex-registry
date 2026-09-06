import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(here, "..", "..", "schema", "sqlite");

/**
 * Split DDL into statements, keeping `CREATE TRIGGER ... BEGIN ... END;` intact.
 *
 * Lifted verbatim out of scripts/corpus/build.ts so the corpus build and the migration runner
 * cannot drift. The lookahead avoids splitting on a `;` inside a string literal.
 */
export function splitSql(sql: string): string[] {
  const parts = sql
    .replace(/^\s*--.*$/gm, "")
    .split(/;\s*(?=(?:[^']*'[^']*')*[^']*$)/)
    .map((s) => s.trim())
    .filter(Boolean);

  const merged: string[] = [];
  for (const s of parts) {
    const prev = merged[merged.length - 1];
    if (prev && /\bBEGIN\b/i.test(prev) && !/\bEND\b\s*$/i.test(prev)) {
      merged[merged.length - 1] = `${prev}; ${s}`;
    } else {
      merged.push(s);
    }
  }
  return merged;
}

/** Every migration file, in lexical order — which is numeric order given the NNN_ prefix. */
export function schemaFiles(): { version: string; path: string }[] {
  return readdirSync(SCHEMA_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: f.slice(0, 3), path: join(SCHEMA_DIR, f) }));
}

/**
 * Every statement across every migration, in order.
 *
 * Used by the corpus build, which creates a database from nothing and therefore needs the full
 * end state rather than an incremental diff. Reading the directory instead of naming
 * 001_schema.sql is the durable fix: otherwise every future migration has to be remembered
 * twice, and a fresh `--from-file` database silently ships an older schema than production.
 */
export function allSchemaStatements(): string[] {
  return schemaFiles().flatMap(({ path }) => splitSql(readFileSync(path, "utf-8")));
}
