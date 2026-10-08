export interface GitFileChange {
  path: string;
  /** Single-letter-ish status: M, A, D, ?, R, etc. */
  status: string;
}

/**
 * Parse `git status --porcelain=v1` output.
 * Handles rename lines: `R  old -> new` / `R100\told\tnew`
 */
export function parsePorcelain(stdout: string): GitFileChange[] {
  const files: GitFileChange[] = [];
  const lines = stdout.split(/\r?\n/).filter(Boolean);

  for (const line of lines) {
    if (line.length < 4) continue;

    const xy = line.slice(0, 2);
    const rest = line.slice(3);

    // Untracked
    if (xy === "??") {
      files.push({ path: normalizePath(rest), status: "?" });
      continue;
    }

    // Rename / copy with tab-separated paths (porcelain)
    if (rest.includes("\t") && (xy.includes("R") || xy.includes("C"))) {
      const parts = rest.split("\t");
      const from = parts.length >= 2 ? parts[parts.length - 2] : undefined;
      const to = parts[parts.length - 1] ?? rest;
      // Rename removes the source; copy does not.
      if (from && xy.includes("R")) {
        files.push({ path: normalizePath(from), status: "D" });
      }
      files.push({ path: normalizePath(to), status: primaryStatus(xy) });
      continue;
    }

    // Rename with " -> "
    if (rest.includes(" -> ")) {
      const [from, to] = rest.split(" -> ");
      if (from && xy.includes("R")) {
        files.push({ path: normalizePath(from), status: "D" });
      }
      files.push({
        path: normalizePath(to ?? rest),
        status: primaryStatus(xy),
      });
      continue;
    }

    files.push({ path: normalizePath(rest), status: primaryStatus(xy) });
  }

  return files;
}

function primaryStatus(xy: string): string {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";
  if (x === "?" && y === "?") return "?";
  if (y !== " " && y !== "?") return y;
  if (x !== " " && x !== "?") return x;
  return "M";
}

/** Decode git porcelain/quoted paths (C-style octal escapes). */
export function normalizeGitPath(path: string): string {
  let p = path;
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    p = unquoteCStyle(p.slice(1, -1));
  }
  return p.replaceAll("\\", "/");
}

function normalizePath(path: string): string {
  return normalizeGitPath(path);
}

/** Decode git's C-style quoted path escapes (`\303\251`, `\\`, `\"`, …). */
function unquoteCStyle(input: string): string {
  let out = "";
  const utf8Bytes: number[] = [];
  const flushBytes = (): void => {
    if (utf8Bytes.length === 0) return;
    out += Buffer.from(utf8Bytes).toString("utf8");
    utf8Bytes.length = 0;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch !== "\\") {
      flushBytes();
      out += ch;
      continue;
    }
    const next = input[i + 1];
    if (next === undefined) {
      flushBytes();
      out += "\\";
      break;
    }
    if (next === "\\" || next === '"' || next === "'") {
      flushBytes();
      out += next;
      i += 1;
      continue;
    }
    if (next === "n") {
      flushBytes();
      out += "\n";
      i += 1;
      continue;
    }
    if (next === "t") {
      flushBytes();
      out += "\t";
      i += 1;
      continue;
    }
    if (next === "r") {
      flushBytes();
      out += "\r";
      i += 1;
      continue;
    }
    if (next >= "0" && next <= "7") {
      let oct = next;
      i += 1;
      for (let k = 0; k < 2; k++) {
        const d = input[i + 1];
        if (d === undefined || d < "0" || d > "7") break;
        i += 1;
        oct += d;
      }
      utf8Bytes.push(Number.parseInt(oct, 8));
      continue;
    }
    flushBytes();
    out += next;
    i += 1;
  }
  flushBytes();
  return out;
}

export function collectStatus(cwd: string, runGitFn: (cwd: string, args: string[]) => string): GitFileChange[] {
  const out = runGitFn(cwd, ["status", "--porcelain=v1"]);
  return parsePorcelain(out);
}
