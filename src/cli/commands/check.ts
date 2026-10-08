import { checkExitCode, runCheck } from "../../check/runner.ts";
import { printJson } from "../../output/json.ts";
import { printCacheStats, printCheck } from "../../output/terminal.ts";
import type { OutputOptions } from "../../output/types.ts";
import { runCommand } from "../errors.ts";

export interface CheckCommandOptions extends OutputOptions {
  skipScripts?: boolean;
}

export async function checkCommand(
  options: CheckCommandOptions,
): Promise<number> {
  return runCommand(options, async () => {
    const result = await runCheck({
      cwd: options.cwd,
      cache: options.cache,
      skipScripts: options.skipScripts,
    });

    if (options.json) {
      printJson(result);
    } else {
      printCheck(result, options);
      if (result.cache) printCacheStats(result.cache, options);
    }

    return checkExitCode(result);
  });
}
