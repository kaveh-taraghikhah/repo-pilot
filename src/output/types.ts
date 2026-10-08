export interface OutputOptions {
  json: boolean;
  quiet: boolean;
  color: boolean;
  cwd: string;
  cache: boolean;
}

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  message: string;
  details?: string[];
}

export interface DoctorResult {
  root: string;
  checks: DoctorCheckResult[];
  summary: {
    passed: number;
    warnings: number;
    failed: number;
  };
}

export interface AnalyzeIssue {
  severity: "warn" | "info";
  message: string;
}

export interface AnalyzeResult {
  project: string;
  root: string;
  files: number;
  filesByExtension: Record<string, number>;
  typescriptPercentage: number;
  reactComponents: number;
  testFiles: number;
  dependencies: {
    production: number;
    development: number;
  };
  architecture: string[];
  modules: number;
  functions: number;
  classes: number;
  routes: number;
  exports: number;
  circularDependencies: number;
  unusedExports: number;
  highComplexityFiles: number;
  issues: AnalyzeIssue[];
  cache?: CacheStats;
}

export interface GraphCommandResult {
  root: string;
  nodes: Array<{ id: string; path: string; kind: string }>;
  edges: Array<{ from: string; to: string; type: string }>;
  cycles: string[][];
  cache?: CacheStats;
}

export type ImpactBand = "high" | "medium" | "low";

export interface ChangedFileResult {
  path: string;
  status: string;
  impact: ImpactBand;
  dependents: number;
}

export interface ChangedResult {
  branch: string;
  since: string | null;
  files: ChangedFileResult[];
  summary: {
    high: number;
    medium: number;
    low: number;
    total: number;
  };
}

export type RiskLevel = "high" | "medium" | "low";

export interface ImpactResult {
  changed: string[];
  directDependents: string[];
  indirectDependents: string[];
  affectedTests: string[];
  risk: RiskLevel;
  reasons: string[];
  suggestedValidation: string[];
  summary: {
    changed: number;
    direct: number;
    indirect: number;
    tests: number;
  };
  cache?: CacheStats;
}

export interface CacheStats {
  filesTotal: number;
  filesCached: number;
  filesParsed: number;
  durationMs: number;
}

export interface ArchitectureRule {
  name: string;
  from: string;
  cannotImport: string[];
}

export interface RuleViolation {
  rule: string;
  from: string;
  to: string;
}

export interface ScriptCheckResult {
  name: string;
  status: "pass" | "fail" | "skip";
  command?: string;
  message?: string;
}

export interface PluginCheckItem {
  id: string;
  label: string;
  plugin: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface CheckResult {
  passed: boolean;
  architecture: {
    rulesEvaluated: number;
    violations: RuleViolation[];
  };
  scripts: ScriptCheckResult[];
  pluginChecks: PluginCheckItem[];
  summary: {
    violations: number;
    scriptFailures: number;
    pluginFailures: number;
  };
  cache?: CacheStats;
}

export interface RepoPilotConfig {
  /** Soft-fail Docker by default; set true to hard-fail when Docker is down */
  dockerRequired?: boolean;
  ignore?: string[];
  rules?: ArchitectureRule[];
  /** Module paths for external plugins (relative to project root or absolute) */
  plugins?: string[];
}
