import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArchitectureRule } from "../rules/types.ts";
import type { RepoPilotConfig } from "../output/types.ts";

const DEFAULT_CONFIG: RepoPilotConfig = {
  dockerRequired: false,
  ignore: [],
  rules: [],
  plugins: [],
};

export async function loadConfig(root: string): Promise<RepoPilotConfig> {
  const fromPackage = await loadFromPackageJson(root);
  const fromYaml = await loadFromYamlLike(root);
  const fromJson = await loadFromRepopilotJson(root);

  // Merge order: defaults < package.json < yaml < .repopilot.json (file wins)
  const merged: RepoPilotConfig = {
    ...DEFAULT_CONFIG,
    ...fromPackage,
    ...fromYaml,
    ...fromJson,
  };

  // Rules: package then file overrides entirely if file provides rules
  if (fromJson.rules !== undefined) {
    merged.rules = fromJson.rules;
  } else if (fromPackage.rules !== undefined) {
    merged.rules = fromPackage.rules;
  } else {
    merged.rules = [];
  }

  // Plugins: later sources replace earlier if they provide plugins
  if (fromJson.plugins !== undefined) {
    merged.plugins = fromJson.plugins;
  } else if (fromPackage.plugins !== undefined) {
    merged.plugins = fromPackage.plugins;
  } else {
    merged.plugins = [];
  }

  return merged;
}

async function loadFromPackageJson(root: string): Promise<Partial<RepoPilotConfig>> {
  const path = join(root, "package.json");
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      repopilot?: RepoPilotConfig;
    };
    return normalizeConfig(raw.repopilot ?? {});
  } catch {
    return {};
  }
}

async function loadFromRepopilotJson(root: string): Promise<Partial<RepoPilotConfig>> {
  const path = join(root, ".repopilot.json");
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as RepoPilotConfig;
    return normalizeConfig(raw);
  } catch {
    return {};
  }
}

function normalizeConfig(input: Partial<RepoPilotConfig>): Partial<RepoPilotConfig> {
  const out: Partial<RepoPilotConfig> = { ...input };

  // Keep rules/plugins/ignore only when they are intentional arrays.
  // Non-arrays and arrays whose entries are all invalid are dropped so they
  // cannot wipe valid package.json#repopilot entries.
  if (Array.isArray(input.rules)) {
    const rules = input.rules
      .filter((r): r is ArchitectureRule => Boolean(r && r.name && r.from))
      .map((r) => ({
        name: r.name,
        from: r.from,
        cannotImport: Array.isArray(r.cannotImport) ? r.cannotImport : [],
      }));
    if (input.rules.length === 0 || rules.length > 0) {
      out.rules = rules;
    } else {
      delete out.rules;
    }
  } else {
    delete out.rules;
  }

  if (Array.isArray(input.plugins)) {
    const plugins = input.plugins.filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    if (input.plugins.length === 0 || plugins.length > 0) {
      out.plugins = plugins;
    } else {
      delete out.plugins;
    }
  } else {
    delete out.plugins;
  }

  const rawIgnore = (input as { ignore?: unknown }).ignore;
  if (Array.isArray(rawIgnore)) {
    const ignore = rawIgnore.filter((p): p is string => typeof p === "string" && p.length > 0);
    if (rawIgnore.length === 0 || ignore.length > 0) {
      out.ignore = ignore;
    } else {
      delete out.ignore;
    }
  } else if (typeof rawIgnore === "string" && rawIgnore.length > 0) {
    out.ignore = [rawIgnore];
  } else if (rawIgnore !== undefined) {
    delete out.ignore;
  }
  return out;
}

/** Minimal key:value parser for .repopilot.yml (simple keys only). */
async function loadFromYamlLike(root: string): Promise<Partial<RepoPilotConfig>> {
  const candidates = [".repopilot.yml", ".repopilot.yaml", "repopilot.yml"];
  for (const name of candidates) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      const text = await readFile(path, "utf8");
      return parseSimpleYaml(text);
    } catch {
      return {};
    }
  }
  return {};
}

export function parseSimpleYaml(text: string): Partial<RepoPilotConfig> {
  const config: Partial<RepoPilotConfig> = {};
  const lines = text.split(/\r?\n/);
  let inIgnore = false;
  let currentList: string[] | null = null;
  let lastIgnore: string[] | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed === "ignore:" || trimmed.startsWith("ignore:")) {
      inIgnore = true;
      const inline = trimmed.slice("ignore:".length).trim();
      if (inline.startsWith("[") && inline.endsWith("]")) {
        const items = inline
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        lastIgnore = items;
        currentList = null;
        inIgnore = false;
      } else if (inline.length > 0) {
        // Scalar form: `ignore: dist`
        lastIgnore = [inline.replace(/^["']|["']$/g, "")];
        currentList = null;
        inIgnore = false;
      } else {
        currentList = [];
        lastIgnore = currentList;
      }
      continue;
    }

    if (inIgnore && trimmed.startsWith("-")) {
      currentList?.push(trimmed.slice(1).trim().replace(/^["']|["']$/g, ""));
      continue;
    }

    inIgnore = false;
    currentList = null;

    const dockerMatch = trimmed.match(/^dockerRequired:\s*(true|false)\s*$/i);
    if (dockerMatch) {
      config.dockerRequired = dockerMatch[1].toLowerCase() === "true";
    }
  }

  if (lastIgnore !== undefined) {
    config.ignore = lastIgnore;
  }

  return config;
}
