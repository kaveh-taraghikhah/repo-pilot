import { normalizeGitPath, type GitFileChange } from "./status.ts";

/**
 * Parse `git diff --name-status` output.
 * Lines look like: `M\tpath`, `A\tpath`, `D\tpath`, `R100\told\tnew`
 */
export function parseNameStatus(stdout: string): GitFileChange[] {
  const files: GitFileChange[] = [];
  const lines = stdout.split(/\r?\n/).filter(Boolean);

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const code = parts[0] ?? "M";
    const status = code.charAt(0) || "M";
    const path =
      status === "R" || status === "C"
        ? parts[parts.length - 1]
        : parts[1];
    if (!path) continue;
    // Rename removes the source; copy does not.
    if (status === "R" && parts.length >= 3 && parts[1]) {
      files.push({
        path: normalizeGitPath(parts[1]),
        status: "D",
      });
    }
    files.push({
      path: normalizeGitPath(path),
      status,
    });
  }

  return files;
}

export function collectDiffSince(
  cwd: string,
  since: string,
  runGitFn: (cwd: string, args: string[]) => string,
): GitFileChange[] {
  const out = runGitFn(cwd, ["diff", "--name-status", `${since}...HEAD`]);
  return parseNameStatus(out);
}
