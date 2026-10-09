import { describe, expect, it } from "vitest";
import { checkScope, globToRegExp, matchesAny } from "../src/scope.ts";

const rules = { editable: ["source/filters/routing/**", "source/common/*.cc", "README.md"], protected: ["bench/**", "**/*_test.cc"], max_files: 3, max_lines: 100 };

describe("globs", () => {
  it("matches ** across directories and * within one", () => {
    expect(globToRegExp("src/**").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("**/*_test.cc").test("x_test.cc")).toBe(true);
    expect(globToRegExp("**/*_test.cc").test("a/b/x_test.cc")).toBe(true);
    expect(globToRegExp("a?c").test("abc")).toBe(true);
    expect(globToRegExp("a.c").test("abc")).toBe(false);
  });
  it("treats wildcard-free patterns and trailing slashes as directory prefixes", () => {
    expect(matchesAny("bench/run.sh", ["bench"])).toBe(true);
    expect(matchesAny("bench/run.sh", ["bench/"])).toBe(true);
    expect(matchesAny("benchmark/run.sh", ["bench"])).toBe(false);
  });
});

describe("checkScope", () => {
  it("accepts editable changes within limits", () => {
    expect(checkScope(rules, { changedPaths: ["source/filters/routing/a.cc", "source/common/m.cc"], linesAdded: 10, linesDeleted: 5 })).toEqual({ ok: true });
  });
  it("rejects protected paths even when they also match editable", () => {
    const r = checkScope(rules, { changedPaths: ["source/filters/routing/a_test.cc"], linesAdded: 1, linesDeleted: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons[0]).toContain("protected paths changed: source/filters/routing/a_test.cc");
  });
  it("rejects paths outside the editable scope and traversal", () => {
    const r = checkScope(rules, { changedPaths: ["source/common/sub/x.cc", "../etc/passwd"], linesAdded: 1, linesDeleted: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toContain("outside editable scope: source/common/sub/x.cc, ../etc/passwd");
  });
  it("enforces file and line limits and refuses empty diffs", () => {
    const many = checkScope(rules, { changedPaths: ["README.md", "source/common/a.cc", "source/common/b.cc", "source/common/c.cc"], linesAdded: 90, linesDeleted: 20 });
    expect(many.ok).toBe(false);
    if (!many.ok) {
      expect(many.reasons.join()).toContain("4 files changed, limit is 3");
      expect(many.reasons.join()).toContain("110 lines changed, limit is 100");
    }
    const empty = checkScope(rules, { changedPaths: [], linesAdded: 0, linesDeleted: 0 });
    expect(empty.ok).toBe(false);
  });
});
