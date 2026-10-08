import type { OutputOptions } from "../output/types.ts";

export interface ProjectContext {
  root: string;
  packageJson: Record<string, unknown> | null;
  files: string[];
}

export interface PluginCommand {
  name: string;
  description: string;
  run(ctx: ProjectContext, options: OutputOptions): Promise<number>;
}

export interface PluginCheckResult {
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface PluginCheck {
  id: string;
  label: string;
  run(ctx: ProjectContext): Promise<PluginCheckResult>;
}

export interface RepoPilotPlugin {
  name: string;
  detect(ctx: ProjectContext): Promise<boolean> | boolean;
  commands?: PluginCommand[];
  checks?: PluginCheck[];
}

export interface PluginListEntry {
  name: string;
  active: boolean;
  builtin: boolean;
  commands: string[];
}
