import { clearCache } from "../../cache/store.ts";
import type { OutputOptions } from "../../output/types.ts";
import { findProjectRoot } from "../../scanner/find-root.ts";
import { runCommand } from "../errors.ts";

export async function cleanCommand(options: OutputOptions): Promise<number> {
  // Errors stay human-readable even under --json (historical behavior).
  return runCommand(
    options,
    async () => {
      const root = findProjectRoot(options.cwd);
      const cleared = await clearCache(root);
      if (!options.quiet && !options.json) {
        if (cleared) {
          process.stdout.write("Cleared .repopilot/cache\n");
        } else {
          process.stdout.write("No cache to clear\n");
        }
      }
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ cleared }, null, 2)}\n`);
      }
      return 0;
    },
    "human",
  );
}
