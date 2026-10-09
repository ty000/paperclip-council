import { describe, expect, it } from "vitest";
import { canonicalRepository } from "../src/repository-occupation.js";

describe("canonical repository identity", () => {
  it.each(["Owner/Repo", "https://github.com/OWNER/repo.git", "git@github.com:owner/REPO.git", "ssh://git@github.com/owner/repo.git", "https://github.com/owner/repo/"])("maps %s to the same exclusive target", value => {
    expect(canonicalRepository(value)).toBe("github.com/owner/repo");
  });
  it.each(["owner", "owner/repo/tree/main", "../repo", "owner/..", "https://gitlab.com/owner/repo", "https://secret@github.com/owner/repo", "https://github.com/owner/repo?token=synthetic", "file:///workspace/repo"])("refuses ambiguous or unsupported target %s", value => {
    expect(() => canonicalRepository(value)).toThrow();
  });
});
