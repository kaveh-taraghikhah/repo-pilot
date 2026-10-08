import { spawnSync } from "node:child_process";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

export function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new GitError("git is not installed or not on PATH");
    }
    if (err.code === "ENOBUFS" || /maxBuffer/i.test(err.message)) {
      throw new GitError(`git output exceeded maxBuffer: ${err.message}`);
    }
    throw new GitError(err.message);
  }

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new GitError(stderr || `git ${args.join(" ")} failed`);
  }

  return (result.stdout ?? "").replace(/\n$/, "");
}

export function isGitRepo(cwd: string): boolean {
  try {
    runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}
