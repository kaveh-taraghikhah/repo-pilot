# RepoPilot

Local CLI for TypeScript repos that answers one question before you merge:

**What else will this change touch?**

I kept reviewing PRs where a “small” edit to a payment helper quietly broke an API route three imports away. Import-graph tools could draw the living tree, but they fell over on the cases that show up in real worktrees — deleted files, path aliases, ignored bridge modules, and “which tests should I actually run tonight?”

RepoPilot is the tool I wanted for that. It walks the repo with the TypeScript compiler API, overlays Git changes, and reports blast radius, risk reasons, and a short validation hint. Everything else (doctor, architecture `check`, plugins, graph viewer) exists to feed or explain that answer.

## Quick demo

```bash
bun install
bun run demo
```

That runs against checked-in fixtures so you can see real output without pointing it at your own repo. Full paste of expected output: [docs/DEMO.md](./docs/DEMO.md). Sample from `tests/fixtures/simple-graph`:

```text
Impact Analysis

Changed files
  src/payment.ts

Direct dependents
  src/order.ts

Indirect dependents
  src/api.ts

Tests potentially affected
  src/payment.test.ts

Risk
  HIGH

Reasons:
  • exported API changed
  • 2 dependent modules
  • 1 potentially affected test

Suggested validation:
  bun test payment
  npm test -- payment
```

Interactive graph (after `bun run build:web`):

```bash
bun src/cli.ts graph --serve --cwd tests/fixtures/simple-graph
```

## Install

```bash
bun install          # prepare builds dist/cli.js
bun link
# or from source:
bun src/cli.ts doctor
```

Full release build (CLI + graph viewer assets):

```bash
bun run build
```

Requires Node.js ≥ 18 for the published binary. Bun is used for local build and development.

## How it works (short version)

1. **Scan** the project root, respect ignore patterns, load config from `.repopilot.json` or `package.json#repopilot`.
2. **Parse** with a TypeScript `Program` — module resolution, `paths`, `#imports`, not regex-on-imports.
3. **Build a bidirectional graph** of scanned modules. Unresolved / ignored targets do **not** become ghost nodes (that would truncate impact walks).
4. **Impact** seeds from files you name or from Git dirty/diff state. If a seed is already gone from disk, recover importers via AST (including ignore-bridge chains), then walk dependents, score risk, and suggest tests.
5. **Cache** under `.repopilot/cache` with per-file content hashes plus a project fingerprint (tool version, schema, tsconfig `extends` chain, package.json, source set).

Deeper map: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Commands

### Impact (centerpiece)

```bash
repopilot impact
repopilot impact src/services/payment.ts
repopilot impact --json
repopilot impact --since main
```

### Graph

```bash
repopilot graph
repopilot graph --serve
repopilot graph --serve --port 4173 --no-open
```

`--serve` opens an SVG explorer with search and a node panel (dependents / dependencies / cycles). Needs viewer assets from `bun run build:web`.

### Architecture check

```bash
repopilot check
repopilot check --skip-scripts
```

Rules are globs evaluated on graph edges, e.g. “API cannot import repositories”:

```json
{
  "rules": [
    {
      "name": "api-cannot-import-database",
      "from": "src/api/**",
      "cannotImport": ["src/repositories/**"]
    }
  ]
}
```

### Plugins

```bash
repopilot plugins list
repopilot next routes
repopilot docker doctor
repopilot test-runner info
```

| Plugin | Detects | Commands | Checks |
|--------|---------|----------|--------|
| `next` | `next` dep or `next.config.*` | `routes` | — |
| `docker` | Dockerfile / Compose | `doctor` | warns if Compose without Dockerfile |
| `test-runner` | Vitest or Jest | `info` | passes when a runner is configured |

Plugin checks merge into `repopilot check` after architecture rules.

```ts
interface RepoPilotPlugin {
  name: string;
  detect(ctx: ProjectContext): Promise<boolean> | boolean;
  commands?: PluginCommand[];
  checks?: PluginCheck[];
}
```

External plugins via `.repopilot.json` or `package.json#repopilot`:

```json
{
  "plugins": ["./my-plugin.ts"]
}
```

`.ts` plugins are transpiled beside the source so the Node-built binary can load them. Prefer `.js` / `.mjs` if you want zero transpile cost.

### Other

```bash
repopilot doctor
repopilot analyze
repopilot changed --since main
repopilot clean
```

### Global flags

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable output |
| `--quiet` | Suppress non-error human output |
| `--no-color` | Disable ANSI colors |
| `--no-cache` | Disable incremental analysis cache |
| `--cwd <path>` | Working directory |

## Compared to related tools

RepoPilot is not trying to replace every static-analysis tool in the ecosystem. Rough fit:

| Need | Closer fit |
|------|------------|
| Draw / lint import structure | madge, dependency-cruiser |
| Find unused exports / dead code | knip, ts-prune |
| “This PR/worktree change — who depends on it, how risky, what to run?” | **RepoPilot impact** |
| Enforce layer rules on a shared graph | RepoPilot `check` (also doable in dep-cruiser) |

The deliberate bet is Git-aware blast radius with deleted-module recovery and a validation hint — not a full monorepo orchestrator (Nx/Turborepo) or a language-server.

## Design tradeoffs (on purpose)

- **Export change detection** scans unified diffs for export lines. Fast and good enough for risk elevation; not a semantic “did this symbol’s type change?” compare.
- **Risk levels** are explicit heuristics (fan-out thresholds, export touch, worker paths). Easy to argue with; easy to explain in a PR.
- **Unused exports** are best-effort from the parsed graph, not a full reachability product.
- **Single-root tsconfig** today. Multi-package monorepos are on the roadmap, not pretended as done.
- **Bun for build, Node for the shipped CLI** — fast local tooling without forcing Bun on consumers.

## Limitations

- No per-symbol usage tracking inside dependents (module-level impact).
- Path alias / `#imports` support follows what the compiler and a few hand-rolled cases cover; exotic resolvers may need work.
- Suggested validation is stem-filtered `bun test` / `npm test` hints, not a custom runner protocol.
- Graph viewer is a local static+API server, not a hosted SaaS.
- Incremental cache assumes a normal local disk layout under `.repopilot/`.

## Development

```bash
bun install
bun run build:web
bun src/cli.ts graph --serve --cwd tests/fixtures/simple-graph
bun run demo
bun run test
bun run typecheck
bun run build
```

CI runs typecheck + tests on push/PR (see `.github/workflows/ci.yml`).

## Roadmap

Shipped path: doctor → analyze → graph → changed → impact → cache → check → graph viewer → plugins.

Next up when I have time: multi-tsconfig / monorepo awareness, semantic export compare, and a Prisma plugin.

## License

MIT
