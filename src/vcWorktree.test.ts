/**
 * Tests for resolveVcWorktreeProjectRoot — worktree-to-project mapping.
 *
 * Fixtures are built by hand rather than with `git`/`jj`, because detection
 * only reads the pointer files those tools write: `.git` as a file
 * (`gitdir: …/worktrees/<name>`) and `.jj/repo` as a file pointing at the
 * shared `<main>/.jj/repo`.
 *
 * Expected behaviour: a linked worktree or non-default jj worktree maps to
 * the main worktree root; everything else (plain dirs, main worktrees,
 * subdirectories, submodules, stale pointers) returns the input unchanged.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveVcWorktreeProjectRoot, findVcRoot, gitMainWorktree, jjMainWorktree } from "./vcWorktree.js";

let tmp: string;

function dir(...parts: string[]): string {
  const p = path.join(tmp, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function file(rel: string, content: string): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

/** Compare through realpath: mkdtemp hands out /var/… while pointers resolve to /private/var/…. */
function same(actual: string, expected: string, message?: string): void {
  assert.equal(fs.realpathSync(actual), fs.realpathSync(expected), message);
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-worktree-"));

  // No version control at all.
  dir("plain");
  dir("plain/src/deep");

  // Git main worktree: `.git` is a directory.
  dir("gitmain/.git");
  dir("gitmain/src/deep");

  // Git linked worktree: `.git` is a file pointing into the common dir.
  dir("gitmain/.git/worktrees/gitwt");
  file("gitwt/.git", `gitdir: ${path.join(tmp, "gitmain", ".git", "worktrees", "gitwt")}\n`);
  dir("gitwt/src/deep");

  // Relative pointer, as git normally writes it.
  dir("gitmain/.git/worktrees/gitwtrel");
  file("gitwtrel/.git", "gitdir: ../gitmain/.git/worktrees/gitwtrel\n");

  // Submodule: also a `.git` file, but into .git/modules — not a worktree.
  dir("gitmain/.git/modules/child");
  file("submod/.git", "gitdir: ../gitmain/.git/modules/child\n");

  // Dangling worktree pointer: main worktree moved or removed.
  file("gitgone/.git", `gitdir: ${path.join(tmp, "deleted", ".git", "worktrees", "gitgone")}\n`);

  // jj main worktree: `.jj/repo` is a directory.
  dir("jjmain/.jj/repo");

  // jj non-default worktree: `.jj/repo` is a file, relative to the `.jj` dir.
  file("jjws1/.jj/repo", "../../jjmain/.jj/repo");
  dir("jjws1/src/deep");

  // Co-located repo seen from a linked worktree (jj + git agree).
  dir("jjmain/.git/worktrees/jjws2");
  file("jjws2/.git", "gitdir: ../jjmain/.git/worktrees/jjws2\n");
  file("jjws2/.jj/repo", "../../jjmain/.jj/repo");

  // Dangling jj pointer: the main worktree is gone.
  file("jjgone/.jj/repo", "../../deleted/.jj/repo");

  // Unparseable pointer: must not throw, must not guess.
  file("jjjunk/.jj/repo", "not-a-path");
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("findVcRoot", () => {
  it("finds the nearest .git or .jj ancestor", () => {
    same(findVcRoot(path.join(tmp, "gitwt", "src", "deep"))!, path.join(tmp, "gitwt"));
    same(findVcRoot(path.join(tmp, "jjmain"))!, path.join(tmp, "jjmain"));
  });

  it("returns null outside version control", () => {
    assert.equal(findVcRoot(path.join(tmp, "plain", "src", "deep")), null);
  });
});

describe("gitMainWorktree", () => {
  it("returns the main worktree for a linked worktree", () => {
    same(gitMainWorktree(path.join(tmp, "gitwt"))!, path.join(tmp, "gitmain"));
  });

  it("returns null for the main worktree", () => {
    assert.equal(gitMainWorktree(path.join(tmp, "gitmain")), null);
  });

  it("ignores a submodule gitdir", () => {
    assert.equal(gitMainWorktree(path.join(tmp, "submod")), null);
  });

  it("returns a path that does not exist for a stale pointer", () => {
    // Existence is the caller's (resolveVcWorktreeProjectRoot's) concern, not this helper's.
    assert.ok(gitMainWorktree(path.join(tmp, "gitgone")));
  });
});

describe("jjMainWorktree", () => {
  it("returns the main worktree for a non-default worktree", () => {
    same(jjMainWorktree(path.join(tmp, "jjws1"))!, path.join(tmp, "jjmain"));
  });

  it("returns null for the main worktree", () => {
    assert.equal(jjMainWorktree(path.join(tmp, "jjmain")), null);
  });

  it("returns null for an unparseable pointer", () => {
    assert.equal(jjMainWorktree(path.join(tmp, "jjjunk")), null);
  });
});

describe("resolveVcWorktreeProjectRoot", () => {
  it("maps a git linked worktree to the main worktree", () => {
    same(resolveVcWorktreeProjectRoot(path.join(tmp, "gitwt")), path.join(tmp, "gitmain"));
  });

  it("maps a subdirectory of a linked worktree to the main worktree", () => {
    same(resolveVcWorktreeProjectRoot(path.join(tmp, "gitwt", "src", "deep")), path.join(tmp, "gitmain"));
  });

  it("resolves a relative gitdir pointer", () => {
    same(resolveVcWorktreeProjectRoot(path.join(tmp, "gitwtrel")), path.join(tmp, "gitmain"));
  });

  it("maps a jj non-default worktree to the main worktree", () => {
    same(resolveVcWorktreeProjectRoot(path.join(tmp, "jjws1")), path.join(tmp, "jjmain"));
  });

  it("maps a subdirectory of a jj worktree to the main worktree", () => {
    same(resolveVcWorktreeProjectRoot(path.join(tmp, "jjws1", "src", "deep")), path.join(tmp, "jjmain"));
  });

  it("maps a co-located linked worktree identically through jj and git", () => {
    same(resolveVcWorktreeProjectRoot(path.join(tmp, "jjws2")), path.join(tmp, "jjmain"));
  });

  it("leaves a plain directory alone", () => {
    same(resolveVcWorktreeProjectRoot(path.join(tmp, "plain", "src", "deep")), path.join(tmp, "plain", "src", "deep"));
  });

  it("leaves the main worktree alone", () => {
    same(resolveVcWorktreeProjectRoot(path.join(tmp, "gitmain")), path.join(tmp, "gitmain"));
    same(resolveVcWorktreeProjectRoot(path.join(tmp, "jjmain")), path.join(tmp, "jjmain"));
  });

  it("leaves a subdirectory of the main worktree alone", () => {
    same(resolveVcWorktreeProjectRoot(path.join(tmp, "gitmain", "src", "deep")), path.join(tmp, "gitmain", "src", "deep"));
  });

  it("leaves a submodule alone", () => {
    same(resolveVcWorktreeProjectRoot(path.join(tmp, "submod")), path.join(tmp, "submod"));
  });

  it("falls back to the input when the pointer target is gone", () => {
    same(resolveVcWorktreeProjectRoot(path.join(tmp, "gitgone")), path.join(tmp, "gitgone"));
    same(resolveVcWorktreeProjectRoot(path.join(tmp, "jjgone")), path.join(tmp, "jjgone"));
  });

  it("falls back to the input for a path that does not exist", () => {
    const missing = path.join(tmp, "nope", "deeper");
    assert.equal(resolveVcWorktreeProjectRoot(missing), missing);
  });
});
