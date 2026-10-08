export { createProgram } from "./cli/program.ts";
export { runDoctor, doctorExitCode } from "./doctor/checks.ts";
export { runAnalyze } from "./analyzer/project-report.ts";
export { parseProject } from "./analyzer/parser.ts";
export { parseProjectIncremental } from "./analyzer/parse-incremental.ts";
export { loadProjectGraph } from "./analyzer/load-graph.ts";
export { buildProjectGraph } from "./graph/build.ts";
export { ProjectGraph } from "./graph/graph.ts";
export { createGraphHandler, resolveStaticRoot, startGraphServer } from "./graph/serve.ts";
export { collectChangedFiles } from "./git/changed.ts";
export { scoreChangedFiles, bandFor } from "./git/impact-score.ts";
export { parsePorcelain } from "./git/status.ts";
export { parseNameStatus } from "./git/diff.ts";
export { runImpact } from "./impact/engine.ts";
export { collectDependents } from "./impact/walk.ts";
export { computeRisk } from "./impact/risk.ts";
export { evaluateArchitectureRules } from "./rules/evaluate.ts";
export { runCheck, checkExitCode } from "./check/runner.ts";
export { clearCache } from "./cache/store.ts";
export { hashText, projectFingerprint } from "./cache/fingerprint.ts";
export { findProjectRoot } from "./scanner/find-root.ts";
export { scanFiles } from "./scanner/scan-files.ts";
export { readManifests, parseEnvKeys, missingEnvKeys } from "./scanner/read-manifests.ts";
export { loadConfig, parseSimpleYaml } from "./config/loader.ts";
export { loadPlugins } from "./plugins/loader.ts";
export { PluginRegistry } from "./plugins/registry.ts";
export { nextPlugin } from "./plugins/builtins/next.ts";
export { dockerPlugin } from "./plugins/builtins/docker.ts";
export { testRunnerPlugin } from "./plugins/builtins/test-runner.ts";
export type {
  AnalyzeResult,
  CacheStats,
  ChangedResult,
  CheckResult,
  DoctorResult,
  GraphCommandResult,
  ImpactResult,
  OutputOptions,
  PluginCheckItem,
  RepoPilotConfig,
} from "./output/types.ts";
export type {
  ProjectContext,
  RepoPilotPlugin,
  PluginCommand,
  PluginCheck,
  PluginListEntry,
} from "./plugins/types.ts";
