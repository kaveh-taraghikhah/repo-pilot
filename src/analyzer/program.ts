import ts from "typescript";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { canonicalizePath } from "../path-utils.ts";
import {
  isJavaScriptFile,
  isTypeScriptFile,
  type ScannedFile,
} from "../scanner/scan-files.ts";

export interface ProgramContext {
  root: string;
  program: ts.Program;
  checker: ts.TypeChecker;
  compilerOptions: ts.CompilerOptions;
  configPath: string | null;
}

/** True when `path` is `root` or a file/dir strictly inside it (realpath-aware). */
export function isPathInsideRoot(path: string, root: string): boolean {
  const normalizedPath = canonicalizePath(path).replaceAll("\\", "/");
  const normalizedRoot = canonicalizePath(root).replaceAll("\\", "/");
  if (normalizedPath === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith("/")
    ? normalizedRoot
    : `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix);
}

export function createProgramForRoot(
  root: string,
  /** When provided (including `[]`), restrict rootNames to this allowlist. */
  scannedFiles?: ScannedFile[] | null,
): ProgramContext {
  const canonRoot = canonicalizePath(root);
  const configPath = ts.findConfigFile(canonRoot, ts.sys.fileExists, "tsconfig.json");

  // Map realpath → scanned absolute path so tsconfig symlink paths match scan IDs.
  const scanByReal =
    scannedFiles != null
      ? new Map(
          scannedFiles.map((f) => [
            canonicalizePath(f.absolutePath),
            f.absolutePath,
          ]),
        )
      : null;

  if (configPath) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      throw new Error(
        `Failed to read ${configPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`,
      );
    }

    const configDir = dirname(configPath);
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      configDir,
      undefined,
      configPath,
    );

    const options = {
      ...parsed.options,
      noEmit: true,
    };

    // Honor scan/ignore allowlist; emit canonical (scan) paths as rootNames so
    // the program, imports, and graph share one identity.
    const rootNames = scanByReal
      ? parsed.fileNames
          .map((f) => scanByReal.get(canonicalizePath(f)))
          .filter((f): f is string => Boolean(f))
      : parsed.fileNames;

    const program = ts.createProgram({
      rootNames,
      options,
    });

    return {
      root: canonRoot,
      program,
      checker: program.getTypeChecker(),
      compilerOptions: options,
      configPath: relative(canonRoot, canonicalizePath(configPath)).replaceAll(
        "\\",
        "/",
      ),
    };
  }

  // No tsconfig: `null` means discover all sources (wide impact pass);
  // `[]` stays an empty allowlist; an array uses that allowlist.
  const rootNames =
    scannedFiles != null
      ? scannedFiles
          .filter(
            (f) =>
              isTypeScriptFile(f.extension) || isJavaScriptFile(f.extension),
          )
          .map((f) => f.absolutePath)
      : discoverSourceRootNames(canonRoot);

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.ReactJSX,
    noEmit: true,
    esModuleInterop: true,
    skipLibCheck: true,
    strict: false,
  };

  const program = ts.createProgram({
    rootNames,
    options,
  });

  return {
    root: canonRoot,
    program,
    checker: program.getTypeChecker(),
    compilerOptions: options,
    configPath: null,
  };
}

/** Sync walk for no-tsconfig wide programs (skips common build/vendor dirs). */
function discoverSourceRootNames(root: string): string[] {
  const skipDirs = new Set([
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".git",
    ".next",
    ".turbo",
    ".cache",
    ".vercel",
    "out",
    "vendor",
  ]);
  const out: string[] = [];
  const seenDirs = new Set<string>();
  const seenFiles = new Set<string>();

  let rootReal = root;
  try {
    rootReal = realpathSync(root);
  } catch {
    // keep root
  }

  const realpathInsideRoot = (absPath: string): string | null => {
    try {
      const real = realpathSync(absPath);
      if (!isPathInsideRoot(real, rootReal)) return null;
      return real;
    } catch {
      return null;
    }
  };

  const walk = (dir: string): void => {
    const realDir = realpathInsideRoot(dir);
    if (!realDir) return;
    if (seenDirs.has(realDir)) return;
    seenDirs.add(realDir);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = statSync(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (skipDirs.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!isFile) continue;
      const real = realpathInsideRoot(abs);
      if (!real || seenFiles.has(real)) continue;
      seenFiles.add(real);
      const ext = extname(entry.name);
      if (isTypeScriptFile(ext) || isJavaScriptFile(ext)) {
        out.push(real);
      }
    }
  };

  walk(root);
  return out;
}

export function isProjectSourceFile(sourceFile: ts.SourceFile, root: string): boolean {
  if (sourceFile.isDeclarationFile) return false;
  const path = sourceFile.fileName.replaceAll("\\", "/");
  if (!isPathInsideRoot(path, root)) return false;
  if (path.includes("/node_modules/") || path.includes(`${sep}node_modules${sep}`)) {
    return false;
  }
  return true;
}

export function toPosixRelative(root: string, absolutePath: string): string {
  return relative(
    canonicalizePath(root),
    canonicalizePath(absolutePath),
  ).replaceAll("\\", "/");
}
