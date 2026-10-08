import { GitError, isGitRepo, runGit } from "./exec.ts";

function isGitBufferOverflow(err: unknown): boolean {
  return err instanceof GitError && /ENOBUFS|maxBuffer/i.test(err.message);
}

/** Validate a `--since` git ref before using it in changed/impact. */
export function assertValidSinceRef(
  root: string,
  since: string | undefined,
): void {
  if (!since) return;
  if (!isGitRepo(root)) {
    throw new Error(`--since requires a Git repository (got ${since})`);
  }
  try {
    runGit(root, ["rev-parse", "--verify", `${since}^{commit}`]);
  } catch (err) {
    if (isGitBufferOverflow(err)) {
      throw new Error(
        `Unable to validate --since ${since}: git output exceeded buffer limit`,
      );
    }
    throw new Error(`Invalid --since ref: ${since}`);
  }
}
