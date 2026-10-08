import { runGit } from "./exec.ts";

export function getCurrentBranch(cwd: string): string {
  const name = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  return name || "HEAD";
}
