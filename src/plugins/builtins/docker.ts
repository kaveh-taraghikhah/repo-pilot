import { existsSync } from "node:fs";
import { join } from "node:path";
import { printJson } from "../../output/json.ts";
import type { PluginCommand, PluginCheck, RepoPilotPlugin } from "../types.ts";

function hasDockerfile(root: string): boolean {
  return (
    existsSync(join(root, "Dockerfile")) ||
    existsSync(join(root, "dockerfile"))
  );
}

function hasCompose(root: string): boolean {
  return (
    existsSync(join(root, "docker-compose.yml")) ||
    existsSync(join(root, "docker-compose.yaml")) ||
    existsSync(join(root, "compose.yml")) ||
    existsSync(join(root, "compose.yaml"))
  );
}

const doctorCommand: PluginCommand = {
  name: "doctor",
  description: "Check Docker-related project files",
  async run(ctx, options) {
    const dockerfile = hasDockerfile(ctx.root);
    const compose = hasCompose(ctx.root);
    const payload = {
      plugin: "docker",
      dockerfile,
      compose,
    };
    if (options.json) {
      printJson(payload);
    } else if (!options.quiet) {
      process.stdout.write("\nDocker doctor\n\n");
      process.stdout.write(`  Dockerfile: ${dockerfile ? "yes" : "no"}\n`);
      process.stdout.write(`  Compose:    ${compose ? "yes" : "no"}\n\n`);
    }
    return 0;
  },
};

const composeNeedsDockerfile: PluginCheck = {
  id: "docker-compose-dockerfile",
  label: "Docker Compose pairing",
  async run(ctx) {
    const dockerfile = hasDockerfile(ctx.root);
    const compose = hasCompose(ctx.root);
    if (compose && !dockerfile) {
      return {
        status: "warn",
        message: "docker-compose present but Dockerfile missing",
      };
    }
    if (dockerfile || compose) {
      return {
        status: "pass",
        message: "Docker project files look consistent",
      };
    }
    return { status: "pass", message: "No Docker files (skipped detail)" };
  },
};

export const dockerPlugin: RepoPilotPlugin = {
  name: "docker",
  detect(ctx) {
    return hasDockerfile(ctx.root) || hasCompose(ctx.root);
  },
  commands: [doctorCommand],
  checks: [composeNeedsDockerfile],
};
