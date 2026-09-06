/**
 * Build a safe LIKE prefix pattern.
 *
 * `_` matches any single character in LIKE and `%` matches any run, so an unescaped prefix for
 * `acme/my_repo` would also match `acme/myXrepo` — quietly treating another repo's skills as
 * already known and skipping them. GitHub permits both characters in owner and repo names.
 *
 * Pair with `ESCAPE '\'` in the SQL; the escape character itself is escaped first so it is not
 * doubled by the later replacements.
 */
export function likePrefix(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
}
