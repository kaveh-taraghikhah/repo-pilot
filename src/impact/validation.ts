import { basename } from "node:path";

/**
 * Build suggested validation commands from affected test paths.
 */
export function buildSuggestedValidation(affectedTests: string[]): string[] {
  if (affectedTests.length === 0) {
    return [];
  }

  const stems = affectedTests
    .map((p) => basename(p).replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, ""))
    .filter(Boolean);

  const unique = [...new Set(stems)].slice(0, 8);
  if (unique.length === 0) return [];

  const pattern = unique.join(" ");
  return [`bun test ${pattern}`, `npm test -- ${pattern}`];
}
