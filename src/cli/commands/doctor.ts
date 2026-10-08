import { spawnSync } from "node:child_process";
import { loadConfig } from "../../config/loader.ts";
import { doctorExitCode, runDoctor } from "../../doctor/checks.ts";
import { printJson } from "../../output/json.ts";
import { printDoctor } from "../../output/terminal.ts";
import type { OutputOptions } from "../../output/types.ts";
import { findProjectRoot } from "../../scanner/find-root.ts";
import { readManifests } from "../../scanner/read-manifests.ts";
import { runCommand } from "../errors.ts";

export async function doctorCommand(options: OutputOptions): Promise<number> {
  return runCommand(options, async () => {
    const root = findProjectRoot(options.cwd);
    const [manifests, config] = await Promise.all([
      readManifests(root),
      loadConfig(root),
    ]);

    const result = await runDoctor({
      root,
      manifests,
      config,
      bunAvailable: isBunAvailable(),
      nodeMajor: Number(process.versions.node.split(".")[0] ?? 0),
      dockerRunning: probeDocker(),
    });

    if (options.json) {
      printJson(result);
    } else {
      printDoctor(result, options);
    }

    return doctorExitCode(result);
  });
}

function isBunAvailable(): boolean {
  const result = spawnSync("bun", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0;
}

function probeDocker(): boolean | null {
  const which = spawnSync("docker", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (which.status !== 0) return null;

  const info = spawnSync("docker", ["info"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return info.status === 0;
}
