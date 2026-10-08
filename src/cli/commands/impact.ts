import { runImpact } from "../../impact/engine.ts";
import { printJson } from "../../output/json.ts";
import { printCacheStats, printImpact } from "../../output/terminal.ts";
import type { OutputOptions } from "../../output/types.ts";
import { runCommand } from "../errors.ts";

export interface ImpactCommandOptions extends OutputOptions {
  files?: string[];
  since?: string;
}

export async function impactCommand(
  options: ImpactCommandOptions,
): Promise<number> {
  return runCommand(options, async () => {
    const result = await runImpact({
      cwd: options.cwd,
      files: options.files,
      since: options.since,
      cache: options.cache,
    });

    if (options.json) {
      printJson(result);
    } else {
      printImpact(result, options);
      if (result.cache) printCacheStats(result.cache, options);
    }

    return 0;
  });
}
