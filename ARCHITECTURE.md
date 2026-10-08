# Architecture

Shared parse/graph pipeline; commands ask different questions on top of it.

## Why these boundaries

Almost every command runs the same spine:

**find root → scan files → parse with TypeScript → build graph → answer a question.**

`impact` walks dependents and scores risk. `check` evaluates architecture globs on edges. `graph --serve` serializes the same graph to a small viewer. One parse/graph path means fixtures and the cache pay for themselves across the tool.

```text
                    ┌─────────────┐
                    │  cli/       │  commander + --cwd early for plugins
                    │  program.ts │
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
   scanner/            config/           plugins/
   find root           .repopilot.json   detect → commands/checks
   ignore + walk       package#repopilot
         │
         ▼
   analyzer/  ─────────────────────────────────────────┐
   createProgram → imports/exports/symbols             │
   parse-incremental + cache/fingerprint               │
         │                                             │
         ▼                                             │
   graph/                                              │
   ProjectGraph (inbound + outbound)                   │
   Tarjan cycles · no ghost nodes for ignored targets  │
         │                                             │
         ├────────────┬────────────┬───────────────────┘
         ▼            ▼            ▼
      impact/      check/       graph/serve
      seeds+walk   rules+scripts  static viewer + JSON API
      risk+tests
         │
         ▼
      output/   terminal · --json · --quiet · NO_COLOR
```

## Centerpiece: impact

`src/impact/engine.ts` is where the non-toy behavior lives.

1. **Resolve seeds** — CLI file args, or Git dirty / `--since` diffs.
2. **Split** seeds into in-graph vs missing (deleted / renamed away / never scanned).
3. **Recover importers of missing seeds** by scanning parsed ASTs (relative imports, aliases, `#` package imports). Live sibling veto avoids attributing `payment.ts` importers to a still-living `payment.tsx`.
4. **Walk ignore-skipped bridges** — chains like `entry → ignored/mid → ignored/bridge → gone` never appear as graph edges, so BFS has to hop via AST until it hits a scanned node.
5. **Merge dependents**, keep tests in `affectedTests` (not `directDependents`), compute risk, suggest validation.

Related modules:

| File | Job |
|------|-----|
| `impact/walk.ts` | Graph BFS for direct/indirect dependents |
| `impact/risk.ts` | Heuristic high/medium/low + reason strings |
| `impact/exports-changed.ts` | Diff-line export touch detection |
| `impact/validation.ts` | Suggested `bun test` / `npm test` stems |
| `path-utils.ts` | Canonicalize paths when the leaf is already deleted |

## Analyzer and graph

- **`analyzer/program.ts`** — builds a TS program; maps realpath → scan path so symlink layouts and graph IDs stay aligned.
- **`analyzer/imports.ts`** — `ts.resolveModuleName` plus alias / `#imports` helpers and a denylist for builtins/common packages.
- **`graph/build.ts`** — only adds edges to nodes that were actually parsed. Comment in code: ghost nodes would truncate impact walks. That constraint is load-bearing.
- **`graph/graph.ts`** — bidirectional adjacency, kind upgrades (`module` → `test`/`route`), Tarjan SCCs for cycles.

## Cache

`.repopilot/cache` stores per-file parse results keyed by content hash. Invalidation is not “hash the file and hope”:

- tool version + cache schema (`toolCacheIdentity`)
- tsconfig chain including `extends` (JSONC-stripped)
- `package.json` text
- sorted source relative path set

See `cache/fingerprint.ts` and `analyzer/parse-incremental.ts`. Concurrency uses a small `mapPool` (default 8).

## Plugins

Built-ins (`next`, `docker`, `test-runner`) always register; `detect()` decides whether their commands/checks activate.

The published CLI targets **Node**. Bun can `import` TypeScript plugins directly; Node cannot. `plugins/loader.ts` transpiles `.ts` plugins beside the source (so relative imports and `import.meta.url` behave), writes hashed `.repopilot.*.mjs` artifacts, cleans them up, and rejects paths that escape the project root. Built-in names cannot be overridden.

`--cwd` is read from `process.argv` before Commander finishes so plugin command groups attach to the right project (`cli/program.ts`).

## Output contract

Commands return structured results (`output/types.ts`). Rendering is separate:

- human terminal via picocolors (respects TTY + `NO_COLOR`)
- `--json` for scripts/CI
- `--quiet` for exit-code-only use
- exit via `process.exitCode`, not always a hard `process.exit`

## Tests as documentation

Fixtures under `tests/fixtures/` are tiny repos that pin behavior:

| Fixture | Pins |
|---------|------|
| `simple-graph` | payment → order → api + test; impact happy path |
| `architecture-ok` / `architecture-violation` | layered import rules |
| `circular-dependency` | cycle detection |
| `healthy-project` / `broken-env` | doctor heuristics |
| `next-lite` / `docker-lite` | plugin detection |

Unit tests lean hard on impact edge cases (deleted seeds, skipped bridges, NodeNext `.js` → `.ts`/`.tsx` twin rules). Integration tests drive the CLI against those fixtures.

## Out of scope

- Language server / editor plugin
- Monorepo task runner
- Hosted service — analysis stays local; cache is on disk

Prefer a new question on the shared graph over a second parser.
