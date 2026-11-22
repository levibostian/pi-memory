/**
 * Map a worktree directory back to the project it belongs to.
 *
 * A git linked worktree (`git worktree add`) and a jj non-default worktree
 * (`jj workspace add`) are fully separate directories that share one
 * repository. Memory keyed on the literal cwd would treat each of them as its
 * own project, so settings, `localPath`, and the project slug would diverge.
 * `resolveVcWorktreeProjectRoot` returns the main worktree root instead, which then
 * stands in for the cwd everywhere project identity is derived.
 *
 * Detection reads the on-disk indirection both tools already write, so it
 * needs no subprocess and no network:
 *
 * - git linked worktree: `.git` is a *file* holding
 *   `gitdir: <common>/worktrees/<name>`. The main worktree is the parent of
 *   the common dir. A submodule also has a `.git` file, but it points into
 *   `.git/modules/<name>`, so it is left alone.
 * - jj non-default worktree: `.jj/repo` is a *file* holding a path (usually
 *   relative to the `.jj` dir) to the shared `<main>/.jj/repo`. The main
 *   worktree is the grandparent of that path.
 *
 * Design guardrail: this module only answers "which directory identifies the
 * project". It never reads settings, opens the store, or writes anything, and
 * every failure path returns the input unchanged — a stale or unreadable
 * pointer must degrade to today's behaviour, never break session startup.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Nearest ancestor containing `.jj` or `.git`. Both are checked because a
 * co-located repo has both; either one is enough to identify the worktree
 * root, which is what the pointers are relative to.
 */
export function findVcRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".jj")) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Main worktree root when `root` is a git linked worktree, else null.
 * `root` must be a worktree root (see `findVcRoot`).
 */
export function gitMainWorktree(root: string): string | null {
  const dotGit = join(root, ".git");
  try {
    // A directory means this *is* the main worktree.
    if (!statSync(dotGit).isFile()) return null;
    const content = readFileSync(dotGit, "utf-8");
    const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(content);
    if (!match) return null;
    // A relative gitdir is relative to the directory holding the `.git` file.
    const gitdir = resolve(root, match[1]!);
    const worktreeMatch = /^(.*)[/\\]worktrees[/\\][^/\\]+$/.exec(gitdir);
    if (!worktreeMatch) return null; // submodule or another indirection: not ours
    const common = worktreeMatch[1]!;
    // `git init --separate-git-dir` puts the common dir elsewhere; the parent
    // of such a dir is not the project, so leave it alone.
    return basename(common) === ".git" ? dirname(common) : null;
  } catch {
    return null;
  }
}

/**
 * Main worktree root when `root` is a jj non-default worktree, else null.
 * `root` must be a worktree root (see `findVcRoot`).
 */
export function jjMainWorktree(root: string): string | null {
  const jjDir = join(root, ".jj");
  if (!existsSync(jjDir)) return null;
  const pointer = join(jjDir, "repo");
  try {
    // A directory means this *is* the main worktree.
    if (statSync(pointer).isDirectory()) return null;
    const raw = readFileSync(pointer, "utf-8").trim();
    if (!raw) return null;
    const shared = resolve(jjDir, raw); // expected: <main>/.jj/repo
    const sharedJjDir = dirname(shared);
    if (basename(shared) !== "repo" || basename(sharedJjDir) !== ".jj") return null;
    return dirname(sharedJjDir);
  } catch {
    return null;
  }
}

/**
 * Project directory for `cwd`: the main worktree root when `cwd` sits inside a
 * git linked worktree or a jj non-default worktree, otherwise `cwd` itself.
 *
 * Plain directories, subdirectories of a main worktree, and submodules are
 * returned unchanged, so this is additive for anyone not using worktrees.
 */
export function resolveVcWorktreeProjectRoot(cwd: string): string {
  try {
    const root = findVcRoot(cwd);
    if (!root) return cwd;
    const main = jjMainWorktree(root) ?? gitMainWorktree(root);
    if (!main || !existsSync(main)) return cwd; // no worktree, or stale pointer
    const realRoot = safeRealpath(root);
    const realMain = safeRealpath(main);
    // Resolve symlinks on both sides: a pointer may hand back the canonical
    // path (`/private/var/...`) while the cwd arrived as `/var/...`.
    if (realMain === realRoot) return cwd;
    return realMain;
  } catch {
    return cwd;
  }
}
