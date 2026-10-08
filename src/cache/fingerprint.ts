import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { VERSION } from "../version.ts";
import { CACHE_SCHEMA_VERSION } from "./types.ts";

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function hashFile(absolutePath: string): Promise<string> {
  const buf = await readFile(absolutePath);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * CLI version + schema so tool upgrades invalidate the incremental cache.
 * Always uses the bundled VERSION (same source as `repopilot --version`).
 */
export function toolCacheIdentity(): string {
  return `repopilot:${VERSION}:schema${CACHE_SCHEMA_VERSION}`;
}

/**
 * Project-level fingerprint. Changes when the tool version/schema, tsconfig
 * (including `extends`), package.json, or the set of source relative paths
 * change — so upgrades, renames, and path-mapping edits invalidate the cache.
 */
export async function projectFingerprint(
  root: string,
  sourceRelativePaths: string[] = [],
): Promise<string> {
  const parts: string[] = [toolCacheIdentity()];

  parts.push(...(await hashTsconfigChain(root)));

  try {
    const text = await readFile(join(root, "package.json"), "utf8");
    parts.push(`package.json:${hashText(text)}`);
  } catch {
    parts.push("package.json:missing");
  }

  if (sourceRelativePaths.length > 0) {
    const sorted = [...sourceRelativePaths].map((p) => p.replaceAll("\\", "/")).sort();
    parts.push(`sources:${hashText(sorted.join("\n"))}`);
  }

  return hashText(parts.join("|"));
}

async function hashTsconfigChain(root: string): Promise<string[]> {
  const rootConfig = join(root, "tsconfig.json");
  if (!existsSync(rootConfig)) {
    return ["tsconfig.json:missing"];
  }

  const parts: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [rootConfig];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const abs = resolve(current);
    if (seen.has(abs)) continue;
    seen.add(abs);

    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch {
      parts.push(`${abs}:missing`);
      continue;
    }

    parts.push(`${abs}:${hashText(text)}`);

    for (const spec of readExtendsList(text)) {
      const resolved = resolveExtendsPath(dirname(abs), spec);
      if (resolved) {
        queue.push(resolved);
      } else {
        // Package-style extends: fingerprint the literal so a string change busts cache.
        parts.push(`extends:${spec}`);
      }
    }
  }

  return parts;
}

/**
 * Strip JSONC comments and trailing commas without touching string contents.
 * Handles line comments, block comments, and trailing commas before `}` / `]`.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i]!;

    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        const ch = text[i]!;
        out += ch;
        i++;
        if (ch === "\\") {
          if (i < n) {
            out += text[i]!;
            i++;
          }
          continue;
        }
        if (ch === '"') break;
      }
      continue;
    }

    if (c === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
      continue;
    }

    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i + 1 < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      continue;
    }

    // Trailing comma before } or ]
    if (c === ",") {
      let j = i + 1;
      while (j < n && /[ \t\r\n]/.test(text[j]!)) j++;
      if (j < n && (text[j] === "}" || text[j] === "]")) {
        i++;
        continue;
      }
    }

    out += c;
    i++;
  }

  return out;
}

export function readExtendsList(text: string): string[] {
  const stripped = stripJsonc(text);
  try {
    const json = JSON.parse(stripped) as { extends?: string | string[] };
    if (typeof json.extends === "string") return [json.extends];
    if (Array.isArray(json.extends)) {
      return json.extends.filter((s): s is string => typeof s === "string");
    }
  } catch {
    // Fall through to regex
  }

  const stringMatch = stripped.match(/"extends"\s*:\s*"([^"]+)"/);
  if (stringMatch?.[1]) return [stringMatch[1]];

  const arrayMatch = stripped.match(/"extends"\s*:\s*\[([^\]]*)\]/);
  if (arrayMatch?.[1]) {
    return [...arrayMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  }

  return [];
}

function resolveExtendsPath(fromDir: string, spec: string): string | null {
  if (spec.startsWith(".") || isAbsolute(spec)) {
    const base = resolve(fromDir, spec);
    if (existsSync(base)) return base;
    if (!base.endsWith(".json") && existsSync(`${base}.json`)) return `${base}.json`;
    return base;
  }
  return resolvePackageTsconfig(fromDir, spec);
}

/** Resolve package-style extends (`@tsconfig/node18`, `some-preset/tsconfig`) via node_modules. */
function resolvePackageTsconfig(fromDir: string, spec: string): string | null {
  let dir = fromDir;
  for (;;) {
    const nm = join(dir, "node_modules");
    const candidates = [
      join(nm, `${spec}.json`),
      join(nm, spec, "tsconfig.json"),
      join(nm, spec),
    ];
    for (const candidate of candidates) {
      const resolved = existingTsconfigFile(candidate);
      if (resolved) return resolved;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function existingTsconfigFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const st = statSync(path);
    if (st.isFile()) return path;
    if (st.isDirectory()) {
      const nested = join(path, "tsconfig.json");
      if (existsSync(nested) && statSync(nested).isFile()) return nested;
      const pkgPath = join(path, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
            tsconfig?: unknown;
          };
          if (typeof pkg.tsconfig === "string") {
            const target = resolve(path, pkg.tsconfig);
            if (existsSync(target) && statSync(target).isFile()) return target;
          }
        } catch {
          // ignore malformed package.json
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}
