/**
 * Detect whether a unified diff touches export declarations.
 */
export function diffTouchesExports(diffText: string): boolean {
  for (const line of diffText.split(/\r?\n/)) {
    // Added or removed export lines (ignore +++ --- file headers)
    if (
      (line.startsWith("+") || line.startsWith("-")) &&
      !line.startsWith("+++") &&
      !line.startsWith("---")
    ) {
      const body = line.slice(1).trimStart();
      // Allow `export foo`, `export{foo}`, `export*`, `export default`, etc.
      if (/^export(?:\s|[{*])/.test(body)) return true;
    }
  }
  return false;
}

export function hasPublicExports(exportCount: number): boolean {
  return exportCount > 0;
}
