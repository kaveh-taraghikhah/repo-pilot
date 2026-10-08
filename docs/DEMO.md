# Demo walkthrough

Reproducible output from `bun run demo` (fixtures only — no dirty worktree required).

Regenerate by running the script and pasting if the CLI formatting changes.

## 1. Impact — `tests/fixtures/simple-graph`

```bash
bun src/cli.ts impact src/payment.ts --cwd tests/fixtures/simple-graph --no-color
```

```text
Impact Analysis

Changed files
─────────────

  src/payment.ts

Direct dependents
─────────────────

  src/order.ts

Indirect dependents
───────────────────

  src/api.ts

Tests potentially affected
──────────────────────────

  src/payment.test.ts

Risk
────

  HIGH

Reasons:
  • exported API changed
  • 2 dependent modules
  • 1 potentially affected test

Suggested validation:
  bun test payment
  npm test -- payment
```

## 2. Graph (text)

```bash
bun src/cli.ts graph --cwd tests/fixtures/simple-graph --no-color
```

```text
Dependency Graph

4 modules, 3 edges

src/api.ts
└── src/order.ts
    └── src/payment.ts

src/payment.test.ts (test)
└── src/payment.ts
```

## 3. Architecture check — expected failure

```bash
bun src/cli.ts check --skip-scripts --cwd tests/fixtures/architecture-violation --no-color
```

```text
RepoPilot Check

✗ Architecture

1 violation

api-cannot-import-database
  src/api/users.ts → src/repositories/user.ts


Result: FAILED
```

## 4. Doctor — healthy fixture

```bash
bun src/cli.ts doctor --cwd tests/fixtures/healthy-project --no-color
```

Expect mostly greens; Docker may warn if the daemon isn’t running locally.

## Interactive viewer

```bash
bun run build:web
bun src/cli.ts graph --serve --cwd tests/fixtures/simple-graph
```

Opens the SVG explorer on `http://127.0.0.1:4173` by default.
