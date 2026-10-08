import type { PluginListEntry, RepoPilotPlugin } from "./types.ts";

export class PluginRegistry {
  private readonly plugins = new Map<string, RepoPilotPlugin>();
  private readonly active = new Set<string>();
  private readonly builtin = new Set<string>();

  register(
    plugin: RepoPilotPlugin,
    options: { builtin?: boolean } = {},
  ): { ok: boolean; reason?: string } {
    const existingKey = this.findRegisteredName(plugin.name);
    if (existingKey !== undefined) {
      if (this.builtin.has(existingKey) && !options.builtin) {
        return {
          ok: false,
          reason: `External plugin "${plugin.name}" conflicts with a built-in plugin (skipped)`,
        };
      }
      if (!options.builtin) {
        return {
          ok: false,
          reason: `External plugin "${plugin.name}" conflicts with already-registered plugin "${existingKey}" (skipped)`,
        };
      }
      return {
        ok: false,
        reason: `Built-in plugin "${plugin.name}" conflicts with already-registered plugin "${existingKey}" (skipped)`,
      };
    }

    this.plugins.set(plugin.name, plugin);
    if (options.builtin) this.builtin.add(plugin.name);
    return { ok: true };
  }

  /** Case-insensitive lookup of an already-registered plugin name. */
  private findRegisteredName(candidate: string): string | undefined {
    const needle = candidate.toLowerCase();
    for (const name of this.plugins.keys()) {
      if (name.toLowerCase() === needle) return name;
    }
    return undefined;
  }

  markActive(name: string, isActive: boolean): void {
    const key = this.findRegisteredName(name) ?? name;
    if (isActive) this.active.add(key);
    else this.active.delete(key);
  }

  get(name: string): RepoPilotPlugin | undefined {
    const key = this.findRegisteredName(name);
    return key !== undefined ? this.plugins.get(key) : undefined;
  }

  getActive(): RepoPilotPlugin[] {
    return [...this.active]
      .map((name) => this.plugins.get(name))
      .filter((p): p is RepoPilotPlugin => Boolean(p));
  }

  list(): PluginListEntry[] {
    return [...this.plugins.values()]
      .map((p) => ({
        name: p.name,
        active: this.active.has(p.name),
        builtin: this.builtin.has(p.name),
        commands: (p.commands ?? []).map((c) => c.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
