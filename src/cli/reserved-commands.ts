import type { Command } from "commander";

/** Top-level command names already registered on `program` (lowercase). */
export function takenTopLevelCommandNames(program: Command): Set<string> {
  return new Set(
    program.commands
      .map((c) => c.name())
      .filter(Boolean)
      .map((n) => n.toLowerCase()),
  );
}

/** Return the taken name that conflicts with `candidate` (case-insensitive), if any. */
export function findCommandNameConflict(
  candidate: string,
  taken: Iterable<string>,
): string | undefined {
  const needle = candidate.toLowerCase();
  for (const name of taken) {
    if (name.toLowerCase() === needle) return name;
  }
  return undefined;
}

export function pluginCommandGroupConflictWarning(
  pluginName: string,
  conflictsWith: string,
): string {
  return `Plugin "${pluginName}" CLI group not registered: conflicts with command "${conflictsWith}"`;
}
