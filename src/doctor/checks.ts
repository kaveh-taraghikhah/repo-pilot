import type { DoctorCheckResult, DoctorResult, RepoPilotConfig } from "../output/types.ts";
import { isGitRepository } from "../scanner/find-root.ts";
import {
  hasTypeScriptDependency,
  missingEnvKeys,
  type ManifestSnapshot,
} from "../scanner/read-manifests.ts";

export interface DoctorContext {
  root: string;
  manifests: ManifestSnapshot;
  config: RepoPilotConfig;
  bunAvailable: boolean;
  nodeMajor: number;
  dockerRunning: boolean | null;
}

export async function runDoctor(ctx: DoctorContext): Promise<DoctorResult> {
  const checks: DoctorCheckResult[] = [
    checkGit(ctx),
    checkRuntime(ctx),
    checkPackageJson(ctx),
    checkLockfile(ctx),
    checkTsconfig(ctx),
    checkDependenciesInstalled(ctx),
    checkEnv(ctx),
    checkDocker(ctx),
  ];

  const summary = {
    passed: checks.filter((c) => c.status === "pass").length,
    warnings: checks.filter((c) => c.status === "warn").length,
    failed: checks.filter((c) => c.status === "fail").length,
  };

  return { root: ctx.root, checks, summary };
}

function checkGit(ctx: DoctorContext): DoctorCheckResult {
  if (isGitRepository(ctx.root)) {
    return {
      id: "git",
      label: "Git",
      status: "pass",
      message: "Git repository detected",
    };
  }
  return {
    id: "git",
    label: "Git",
    status: "warn",
    message: "Not a Git repository (no .git directory)",
  };
}

function checkRuntime(ctx: DoctorContext): DoctorCheckResult {
  const details: string[] = [];
  if (ctx.bunAvailable) {
    details.push("Bun is available");
  }
  details.push(`Node.js major version: ${ctx.nodeMajor}`);

  const engines = ctx.manifests.packageJson?.engines?.node;
  if (engines) {
    const satisfied = isNodeEngineSatisfied(engines, ctx.nodeMajor);
    if (satisfied === false) {
      return {
        id: "runtime",
        label: "Runtime",
        status: "fail",
        message: `Node.js version not supported (need ${engines}, found major ${ctx.nodeMajor})`,
        details,
      };
    }
  }

  if (ctx.nodeMajor < 18) {
    return {
      id: "runtime",
      label: "Runtime",
      status: "fail",
      message: "Node.js version not supported (requires >= 18)",
      details,
    };
  }

  return {
    id: "runtime",
    label: "Runtime",
    status: "pass",
    message: "Node.js version supported",
    details,
  };
}

function checkPackageJson(ctx: DoctorContext): DoctorCheckResult {
  if (ctx.manifests.packageJsonError) {
    return {
      id: "package-json",
      label: "package.json",
      status: "fail",
      message: "package.json invalid",
      details: [ctx.manifests.packageJsonError],
    };
  }
  if (!ctx.manifests.packageJson) {
    return {
      id: "package-json",
      label: "package.json",
      status: "fail",
      message: "package.json missing",
    };
  }
  return {
    id: "package-json",
    label: "package.json",
    status: "pass",
    message: "package.json valid",
  };
}

function checkLockfile(ctx: DoctorContext): DoctorCheckResult {
  if (ctx.manifests.lockfile) {
    return {
      id: "lockfile",
      label: "Lockfile",
      status: "pass",
      message: `Lockfile detected (${ctx.manifests.lockfile})`,
    };
  }
  return {
    id: "lockfile",
    label: "Lockfile",
    status: "warn",
    message: "No lockfile detected",
  };
}

function checkTsconfig(ctx: DoctorContext): DoctorCheckResult {
  const needsTs =
    hasTypeScriptDependency(ctx.manifests.packageJson) ||
    Boolean(ctx.manifests.tsconfig);

  if (ctx.manifests.tsconfigError) {
    return {
      id: "tsconfig",
      label: "TypeScript",
      status: "fail",
      message: "TypeScript configuration invalid",
      details: [ctx.manifests.tsconfigError],
    };
  }

  if (ctx.manifests.tsconfig) {
    return {
      id: "tsconfig",
      label: "TypeScript",
      status: "pass",
      message: "TypeScript configuration valid",
    };
  }

  if (needsTs || hasTypeScriptDependency(ctx.manifests.packageJson)) {
    return {
      id: "tsconfig",
      label: "TypeScript",
      status: "warn",
      message: "TypeScript dependency present but tsconfig.json is missing",
    };
  }

  return {
    id: "tsconfig",
    label: "TypeScript",
    status: "pass",
    message: "TypeScript configuration not required",
  };
}

function checkDependenciesInstalled(ctx: DoctorContext): DoctorCheckResult {
  if (ctx.manifests.hasNodeModules) {
    return {
      id: "dependencies",
      label: "Dependencies",
      status: "pass",
      message: "Dependencies installed",
    };
  }
  return {
    id: "dependencies",
    label: "Dependencies",
    status: "warn",
    message: "Dependencies not installed (node_modules missing)",
  };
}

function checkEnv(ctx: DoctorContext): DoctorCheckResult {
  const required = ctx.manifests.envExampleKeys;
  if (required.length === 0) {
    return {
      id: "env",
      label: "Environment",
      status: "pass",
      message: "No .env.example to validate",
    };
  }

  const defined = new Set([
    ...ctx.manifests.envKeys,
    ...ctx.manifests.envLocalKeys,
  ]);
  const missing = missingEnvKeys(required, defined);

  if (missing.length === 0) {
    return {
      id: "env",
      label: "Environment",
      status: "pass",
      message: "Environment variables match .env.example",
    };
  }

  const localExists =
    ctx.manifests.envLocalKeys.length > 0 || ctx.manifests.envKeys.length > 0;

  return {
    id: "env",
    label: "Environment",
    status: "warn",
    message: localExists
      ? ".env / .env.local exists but is missing keys from .env.example:"
      : ".env.example defines keys not present in .env / .env.local:",
    details: missing,
  };
}

function checkDocker(ctx: DoctorContext): DoctorCheckResult {
  if (ctx.dockerRunning === true) {
    return {
      id: "docker",
      label: "Docker",
      status: "pass",
      message: "Docker is running",
    };
  }

  if (ctx.dockerRunning === null) {
    return {
      id: "docker",
      label: "Docker",
      status: "warn",
      message: "Docker not available (docker CLI not found)",
    };
  }

  if (ctx.config.dockerRequired) {
    return {
      id: "docker",
      label: "Docker",
      status: "fail",
      message: "Docker is not running",
    };
  }

  return {
    id: "docker",
    label: "Docker",
    status: "warn",
    message: "Docker is not running",
  };
}

/**
 * Parse a common engines.node range and decide if `major` satisfies it.
 * Returns null when the range cannot be interpreted.
 * Supports `||` unions (any alternative may match).
 */
export function isNodeEngineSatisfied(
  enginesNode: string,
  major: number,
): boolean | null {
  const text = enginesNode.trim();
  if (!text) return null;

  const alternatives = text.split(/\s*\|\|\s*/).map((s) => s.trim()).filter(Boolean);
  if (alternatives.length > 1) {
    const results = alternatives.map((alt) => isNodeEngineSatisfiedSingle(alt, major));
    if (results.every((r) => r === null)) return null;
    return results.some((r) => r === true);
  }

  return isNodeEngineSatisfiedSingle(text, major);
}

function isNodeEngineSatisfiedSingle(
  text: string,
  major: number,
): boolean | null {
  let min: number | null = null;
  let maxExclusive: number | null = null;
  let maxInclusive: number | null = null;
  let matched = false;

  const ge = text.match(/>=\s*(\d+)/);
  if (ge) {
    min = Number(ge[1]);
    matched = true;
  }
  const gt = text.match(/>\s*(\d+)/);
  if (gt && !ge) {
    min = Number(gt[1]) + 1;
    matched = true;
  }

  const lt = text.match(/<\s*(\d+)/);
  if (lt && !text.match(/<=\s*(\d+)/)) {
    maxExclusive = Number(lt[1]);
    matched = true;
  }
  const lte = text.match(/<=\s*(\d+)/);
  if (lte) {
    maxInclusive = Number(lte[1]);
    matched = true;
  }

  // ^18 / ~18 / 18.x — major-compatible range: >=N and <N+1
  const caret = text.match(/^[\^~]?(\d+)/);
  if (caret && min === null && maxExclusive === null && maxInclusive === null) {
    const n = Number(caret[1]);
    min = n;
    maxExclusive = n + 1;
    matched = true;
  }

  if (!matched) {
    const any = text.match(/(\d+)/);
    if (!any) return null;
    min = Number(any[1]);
  }

  if (min !== null && major < min) return false;
  if (maxExclusive !== null && major >= maxExclusive) return false;
  if (maxInclusive !== null && major > maxInclusive) return false;
  return true;
}

/** @deprecated Prefer isNodeEngineSatisfied — kept for callers/tests. */
export function parseMinNodeMajor(enginesNode: string): number | null {
  const ge = enginesNode.match(/>=\s*(\d+)/);
  if (ge) return Number(ge[1]);
  const caret = enginesNode.match(/^[\^~]?(\d+)/);
  if (caret) return Number(caret[1]);
  // Do not treat `<N` as a minimum
  if (/^\s*</.test(enginesNode)) return null;
  const match = enginesNode.match(/(\d+)/);
  if (!match) return null;
  return Number(match[1]);
}

export function doctorExitCode(result: DoctorResult): number {
  return result.summary.failed > 0 ? 1 : 0;
}
