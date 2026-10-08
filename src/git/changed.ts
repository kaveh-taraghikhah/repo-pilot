import { getCurrentBranch } from "./branch.ts";
import { collectDiffSince } from "./diff.ts";
import { GitError, isGitRepo, runGit } from "./exec.ts";
import { collectStatus, type GitFileChange } from "./status.ts";

export interface CollectChangedOptions {
  cwd: string;
  since?: string;
}

export interface ChangedSnapshot {
  branch: string;
  since: string | null;
  files: GitFileChange[];
}

function isGitBufferOverflow(err: unknown): boolean {
  return err instanceof GitError && /ENOBUFS|maxBuffer/i.test(err.message);
}

export function collectChangedFiles(options: CollectChangedOptions): ChangedSnapshot {
  const { cwd, since } = options;

  if (!isGitRepo(cwd)) {
    throw new GitError("Not a Git repository");
  }

  const branch = getCurrentBranch(cwd);
  const byPath = new Map<string, GitFileChange>();

  if (since) {
    try {
      for (const file of collectDiffSince(cwd, since, runGit)) {
        byPath.set(file.path, file);
      }
    } catch (err) {
      // maxBuffer: degrade to working-tree status only rather than aborting impact.
      if (!isGitBufferOverflow(err)) throw err;
    }
  }

  // Always union working-tree dirty files so local edits are not missed
  try {
    for (const file of collectStatus(cwd, runGit)) {
      byPath.set(file.path, file);
    }
  } catch (err) {
    if (!isGitBufferOverflow(err)) throw err;
    // Keep any since-delta we already collected; empty is preferable to abort.
  }

  const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));

  return {
    branch,
    since: since ?? null,
    files,
  };
}
