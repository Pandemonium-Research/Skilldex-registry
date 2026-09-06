import { describe, it, expect } from "vitest";
import { likePrefix } from "../../src/db/like.js";

describe("likePrefix", () => {
  it("leaves an ordinary prefix alone", () => {
    expect(likePrefix("https://github.com/acme/skills/")).toBe(
      "https://github.com/acme/skills/%"
    );
  });

  // The bug this exists to prevent: `_` is a single-character wildcard, so an unescaped
  // prefix for acme/my_repo would also match acme/myXrepo — silently treating a different
  // repo's skills as already known, and skipping them forever.
  it("escapes underscores, which GitHub allows in repo names", () => {
    expect(likePrefix("https://github.com/acme/my_repo/")).toBe(
      "https://github.com/acme/my\\_repo/%"
    );
  });

  it("escapes percent signs", () => {
    expect(likePrefix("a/b%c/")).toBe("a/b\\%c/%");
  });

  it("escapes the escape character itself, and does not double it", () => {
    expect(likePrefix("a\\b")).toBe("a\\\\b%");
  });

  it("escapes several wildcards in one value", () => {
    expect(likePrefix("x_y%z_")).toBe("x\\_y\\%z\\_%");
  });
});
