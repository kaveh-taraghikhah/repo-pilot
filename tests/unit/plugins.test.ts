import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listNextRoutes, nextPlugin } from "../../src/plugins/builtins/next.ts";
import { dockerPlugin } from "../../src/plugins/builtins/docker.ts";
import { detectTestRunner, testRunnerPlugin } from "../../src/plugins/builtins/test-runner.ts";
import { importPluginModule, loadPlugins } from "../../src/plugins/loader.ts";
import { PluginRegistry } from "../../src/plugins/registry.ts";
import type { ProjectContext } from "../../src/plugins/types.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function ctx(partial: Partial<ProjectContext>): ProjectContext {
  return {
    root: partial.root ?? "/tmp",
    packageJson: partial.packageJson ?? null,
    files: partial.files ?? [],
  };
}

describe("PluginRegistry", () => {
  it("registers and activates plugins", () => {
    const registry = new PluginRegistry();
    registry.register(nextPlugin, { builtin: true });
    registry.register(dockerPlugin, { builtin: true });

    expect(registry.list()).toHaveLength(2);
    expect(registry.list().every((e) => !e.active)).toBe(true);

    registry.markActive("next", true);
    expect(registry.getActive().map((p) => p.name)).toEqual(["next"]);

    registry.markActive("next", false);
    expect(registry.getActive()).toHaveLength(0);
  });

  it("refuses external overwrite of builtins", () => {
    const registry = new PluginRegistry();
    registry.register(nextPlugin, { builtin: true });
    const result = registry.register(
      {
        name: "next",
        detect: () => true,
      },
      { builtin: false },
    );
    expect(result.ok).toBe(false);
    expect(registry.get("next")).toBe(nextPlugin);
  });

  it("markActive resolves plugin names case-insensitively", () => {
    const registry = new PluginRegistry();
    registry.register({ name: "Docker", detect: () => true }, { builtin: true });
    registry.markActive("docker", true);
    expect(registry.list().find((p) => p.name === "Docker")?.active).toBe(true);
    expect(registry.get("docker")?.name).toBe("Docker");
  });

  it("refuses duplicate built-in plugin names case-insensitively", () => {
    const registry = new PluginRegistry();
    expect(registry.register({ name: "next", detect: () => true }, { builtin: true }).ok).toBe(
      true,
    );
    const result = registry.register({ name: "Next", detect: () => true }, { builtin: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Built-in plugin/i);
    expect(registry.list().filter((p) => p.name.toLowerCase() === "next")).toHaveLength(1);
  });

  it("refuses duplicate external plugin names without last-wins", () => {
    const registry = new PluginRegistry();
    const first = {
      name: "custom",
      detect: () => true,
      commands: [
        {
          name: "one",
          description: "a",
          async run() {
            return 0;
          },
        },
      ],
    };
    const second = {
      name: "custom",
      detect: () => true,
      commands: [
        {
          name: "two",
          description: "b",
          async run() {
            return 0;
          },
        },
      ],
    };
    expect(registry.register(first, { builtin: false }).ok).toBe(true);
    const result = registry.register(second, { builtin: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already-registered/i);
    expect(registry.get("custom")?.commands?.map((c) => c.name)).toEqual(["one"]);
  });
});

describe("next plugin", () => {
  it("detects next dependency", async () => {
    expect(
      await nextPlugin.detect(
        ctx({
          packageJson: { dependencies: { next: "15.0.0" } },
        }),
      ),
    ).toBe(true);

    expect(
      await nextPlugin.detect(
        ctx({
          packageJson: { dependencies: { react: "19.0.0" } },
        }),
      ),
    ).toBe(false);
  });

  it("lists app and pages routes from context files", () => {
    const routes = listNextRoutes(
      ctx({
        files: [
          "app/page.tsx",
          "app/api/hello/route.ts",
          "pages/about.tsx",
          "pages/_app.tsx",
          "pages/_document.tsx",
          "src/utils.ts",
          "app/layout.tsx",
        ],
      }),
    );

    expect(routes).toEqual([
      "app/api/hello/route.ts",
      "app/page.tsx",
      "pages/about.tsx",
    ]);
  });
});

describe("test-runner plugin", () => {
  it("detects vitest from package.json", () => {
    const runner = detectTestRunner(
      ctx({ packageJson: { devDependencies: { vitest: "3.0.0" } } }),
    );
    expect(runner).toBe("vitest");
    expect(
      testRunnerPlugin.detect(
        ctx({ packageJson: { devDependencies: { vitest: "3.0.0" } } }),
      ),
    ).toBe(true);
  });

  it("detects vitest from vitest.config.mjs", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-vitest-mjs-"));
    temps.push(dir);
    writeFileSync(join(dir, "vitest.config.mjs"), "export default {};\n");
    expect(detectTestRunner(ctx({ root: dir, packageJson: {} }))).toBe("vitest");
  });
});

describe("hasDependency", () => {
  it("does not treat Object.prototype keys as installed packages", async () => {
    const { hasDependency } = await import("../../src/plugins/context.ts");
    expect(hasDependency({ dependencies: {} }, "toString")).toBe(false);
    expect(hasDependency({ dependencies: {} }, "constructor")).toBe(false);
    expect(hasDependency({ dependencies: { react: "19" } }, "react")).toBe(true);
  });
});

describe("importPluginModule", () => {
  it("transpiles TypeScript plugins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-plug-"));
    temps.push(dir);
    const pluginPath = join(dir, "my-plugin.ts");
    writeFileSync(
      pluginPath,
      `export default { name: "demo", detect() { return true; } };\n`,
    );
    const mod = await importPluginModule(pluginPath);
    const plugin = (mod.default ?? mod.plugin) as { name: string; detect: () => boolean };
    expect(plugin.name).toBe("demo");
    expect(plugin.detect()).toBe(true);
  });

  it("resolves relative imports from the plugin directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-plug-rel-"));
    temps.push(dir);
    writeFileSync(join(dir, "helper.js"), `export const TAG = "ok";\n`);
    writeFileSync(
      join(dir, "my-plugin.ts"),
      `import { TAG } from "./helper.js";\nexport default { name: "rel", detect() { return TAG === "ok"; } };\n`,
    );
    const mod = await importPluginModule(join(dir, "my-plugin.ts"));
    const plugin = mod.default as { name: string; detect: () => boolean };
    expect(plugin.name).toBe("rel");
    expect(plugin.detect()).toBe(true);
  });

  it("transpiles relative .ts imports for Node-compatible loading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-plug-ts-rel-"));
    temps.push(dir);
    writeFileSync(join(dir, "helper.ts"), `export const TAG = "ok";\n`);
    writeFileSync(
      join(dir, "my-plugin.ts"),
      `import { TAG } from "./helper.ts";\nexport default { name: "ts-rel", detect() { return TAG === "ok"; } };\n`,
    );
    const mod = await importPluginModule(join(dir, "my-plugin.ts"));
    const plugin = mod.default as { name: string; detect: () => boolean };
    expect(plugin.name).toBe("ts-rel");
    expect(plugin.detect()).toBe(true);
  });

  it("removes stale transpile artifacts", async () => {
    const { readdirSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "repopilot-plug-stale-"));
    temps.push(dir);
    const pluginPath = join(dir, "my-plugin.ts");
    writeFileSync(pluginPath, `export default { name: "v1", detect() { return true; } };\n`);
    await importPluginModule(pluginPath);
    writeFileSync(pluginPath, `export default { name: "v2", detect() { return true; } };\n`);
    await importPluginModule(pluginPath);
    const artifacts = readdirSync(dir).filter((n) => n.includes(".repopilot.") && n.endsWith(".mjs"));
    expect(artifacts).toHaveLength(1);
  });
});

describe("loadPlugins path safety", () => {
  it("rejects plugins that escape via symlink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-plugroot-"));
    const outside = mkdtempSync(join(tmpdir(), "repopilot-plugout-"));
    temps.push(dir, outside);

    writeFileSync(
      join(outside, "evil.js"),
      `export default { name: "evil", detect() { return true; } };\n`,
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", private: true }));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/index.ts"), "export {};\n");

    try {
      symlinkSync(join(outside, "evil.js"), join(dir, "link-plugin.js"));
    } catch {
      return;
    }

    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ plugins: ["./link-plugin.js"] }),
    );

    const { warnings, registry } = await loadPlugins(dir);
    expect(registry.get("evil")).toBeUndefined();
    expect(warnings.some((w) => w.includes("escapes project root"))).toBe(true);
  });

  it("allows in-repo plugin filenames that start with ..", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-plug-dotdot-"));
    temps.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", private: true }));
    writeFileSync(
      join(dir, "..foo.js"),
      `export default { name: "dotdot", detect() { return true; } };\n`,
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ plugins: ["./..foo.js"] }),
    );

    const { warnings, registry } = await loadPlugins(dir);
    expect(warnings.some((w) => w.includes("escapes project root"))).toBe(false);
    expect(registry.get("dotdot")).toBeDefined();
  });
});

describe("createProgram plugin commands", () => {
  it("skips plugins whose name collides with a core command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-plugin-collide-"));
    temps.push(dir);
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "collide" }));
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ plugins: ["./plugins/doctor-plugin.mjs"] }),
    );
    writeFileSync(
      join(dir, "plugins", "doctor-plugin.mjs"),
      `export default {
        name: "doctor",
        async detect() { return true; },
        commands: [{ name: "run", description: "x", async run() { return 0; } }],
      };
      `,
    );

    const { createProgram } = await import("../../src/cli/program.ts");
    const errChunks: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let program;
    try {
      program = await createProgram(dir);
    } finally {
      process.stderr.write = origErr;
    }
    // Core `doctor` remains; colliding plugin group is not registered as a duplicate.
    expect(program.commands.filter((c) => c.name() === "doctor")).toHaveLength(1);
    expect(program.commands.find((c) => c.name() === "doctor")?.description()).toMatch(
      /healthy/i,
    );
    expect(errChunks.join("")).toMatch(/conflicts with command/i);
  });

  it("skips plugins whose name collides case-insensitively", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-plugin-case-"));
    temps.push(dir);
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "case" }));
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ plugins: ["./plugins/p.mjs"] }),
    );
    writeFileSync(
      join(dir, "plugins", "p.mjs"),
      `export default {
        name: "Doctor",
        async detect() { return true; },
        commands: [{ name: "run", description: "x", async run() { return 0; } }],
      };
      `,
    );

    const { createProgram } = await import("../../src/cli/program.ts");
    const errChunks: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let program;
    try {
      program = await createProgram(dir);
    } finally {
      process.stderr.write = origErr;
    }
    expect(
      program.commands.filter((c) => c.name().toLowerCase() === "doctor"),
    ).toHaveLength(1);
    expect(errChunks.join("")).toMatch(/Doctor/i);
  });

  it("plugins list omits commands and warns for colliding names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-plugin-list-collide-"));
    temps.push(dir);
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "list-collide" }));
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ plugins: ["./plugins/p.mjs"] }),
    );
    writeFileSync(
      join(dir, "plugins", "p.mjs"),
      `export default {
        name: "doctor",
        async detect() { return true; },
        commands: [{ name: "run", description: "x", async run() { return 0; } }],
      };
      `,
    );

    const { pluginsListCommand } = await import("../../src/cli/commands/plugins.ts");
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await pluginsListCommand({
        json: true,
        quiet: true,
        color: false,
        cache: true,
        cwd: dir,
      });
    } finally {
      process.stdout.write = orig;
    }
    const data = JSON.parse(chunks.join("")) as {
      plugins: Array<{ name: string; commands: string[] }>;
      warnings: string[];
    };
    const doctor = data.plugins.find((p) => p.name === "doctor");
    expect(doctor?.commands).toEqual([]);
    expect(data.warnings.some((w) => /conflicts with command/i.test(w))).toBe(true);
  });

  it("does not mount CLI groups for inactive plugins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-plugin-inactive-"));
    temps.push(dir);
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "inactive" }));
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ plugins: ["./plugins/p.mjs"] }),
    );
    writeFileSync(
      join(dir, "plugins", "p.mjs"),
      `export default {
        name: "sleepy",
        async detect() { return false; },
        commands: [{ name: "wake", description: "x", async run() { return 0; } }],
      };
      `,
    );

    const { createProgram } = await import("../../src/cli/program.ts");
    const program = await createProgram(dir);
    expect(program.commands.find((c) => c.name() === "sleepy")).toBeUndefined();

    const { pluginsListCommand } = await import("../../src/cli/commands/plugins.ts");
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await pluginsListCommand({
        json: true,
        quiet: true,
        color: false,
        cache: true,
        cwd: dir,
      });
    } finally {
      process.stdout.write = orig;
    }
    const data = JSON.parse(chunks.join("")) as {
      plugins: Array<{ name: string; active: boolean; commands: string[] }>;
    };
    const sleepy = data.plugins.find((p) => p.name === "sleepy");
    expect(sleepy?.active).toBe(false);
    expect(sleepy?.commands).toEqual([]);
  });

  it("plugins list uses the same core command set as createCoreProgram", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-core-sync-"));
    temps.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "core-sync" }));

    const { createCoreProgram, createProgram } = await import("../../src/cli/program.ts");
    const { takenTopLevelCommandNames } = await import("../../src/cli/reserved-commands.ts");
    const core = createCoreProgram(dir);
    const full = await createProgram(dir);
    const coreNames = [...takenTopLevelCommandNames(core)].sort();
    const fullTop = full.commands.map((c) => c.name()).filter(Boolean).sort();
    expect(coreNames).toEqual(fullTop);
  });
});
