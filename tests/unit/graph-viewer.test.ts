import { describe, expect, it } from "vitest";
import { layoutGraph, nodeInCycle } from "../../web/graph-viewer/src/layout.ts";
import { createGraphHandler, listenLocalhost } from "../../src/graph/serve.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("layoutGraph", () => {
  it("assigns finite positions for a simple chain", () => {
    const nodes = [
      { id: "a.ts", path: "a.ts", kind: "module" },
      { id: "b.ts", path: "b.ts", kind: "module" },
      { id: "c.ts", path: "c.ts", kind: "module" },
    ];
    const edges = [
      { from: "a.ts", to: "b.ts", type: "import" },
      { from: "b.ts", to: "c.ts", type: "import" },
    ];
    const layout = layoutGraph(nodes, edges);
    expect(layout.positions["a.ts"]).toBeTruthy();
    expect(layout.positions["b.ts"]).toBeTruthy();
    expect(layout.positions["c.ts"]).toBeTruthy();
    for (const p of Object.values(layout.positions)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("detects cycle membership", () => {
    expect(nodeInCycle("a", [["a", "b", "c"]])).toBe(true);
    expect(nodeInCycle("z", [["a", "b"]])).toBe(false);
  });
});

describe("createGraphHandler", () => {
  it("serves /api/graph JSON and static index", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-web-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html>ok</html>");

    const payload = {
      root: "/proj",
      nodes: [{ id: "a.ts", path: "a.ts", kind: "module" }],
      edges: [],
      cycles: [] as string[][],
    };

    const handle = createGraphHandler(() => payload, dir);
    const api = await handle("http://localhost/api/graph", "GET");
    expect(api.status).toBe(200);
    expect(JSON.parse(String(api.body)).root).toBe("/proj");

    const head = await handle("http://localhost/api/graph", "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toEqual(new Uint8Array());

    const page = await handle("http://localhost/", "GET");
    expect(page.status).toBe(200);
    expect(String(page.body)).toContain("ok");
  });

  it("rejects path traversal attempts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-web-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html>ok</html>");
    writeFileSync(join(dir, "app.js"), "console.log(1)");
    writeFileSync(join(dir, "..", "secret.txt"), "nope");

    const handle = createGraphHandler(
      () => ({ root: "/", nodes: [], edges: [], cycles: [] }),
      dir,
    );

    const encoded = await handle("http://localhost/..%2Fsecret.txt", "GET");
    expect(encoded.status).toBe(403);

    const dotted = await handle("http://localhost/../../etc/passwd", "GET");
    expect([403, 404]).toContain(dotted.status);
    expect(String(dotted.body)).not.toContain("root:");
  });

  it("allows .. inside query strings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-web-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html>ok</html>");
    writeFileSync(join(dir, "app.js"), "ok");

    const handle = createGraphHandler(
      () => ({ root: "/", nodes: [], edges: [], cycles: [] }),
      dir,
    );

    const ok = await handle("http://localhost/app.js?from=../legacy", "GET");
    expect(ok.status).toBe(200);
    expect(String(ok.body)).toBe("ok");
  });

  it("does not SPA-fallback through a symlinked index.html", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-web-"));
    const outside = mkdtempSync(join(tmpdir(), "repopilot-web-out-"));
    writeFileSync(join(outside, "secret.html"), "<html>secret</html>");
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(join(outside, "secret.html"), join(dir, "index.html"));
    } catch {
      return;
    }

    const handle = createGraphHandler(
      () => ({ root: "/", nodes: [], edges: [], cycles: [] }),
      dir,
    );

    const spa = await handle("http://localhost/some-route", "GET");
    expect([403, 404]).toContain(spa.status);
    expect(String(spa.body)).not.toContain("secret");
  });
});

describe("listenLocalhost", () => {
  it("rejects when the port is already bound", async () => {
    const blocker = createServer();
    await listenLocalhost(blocker, 0);
    const addr = blocker.address() as AddressInfo;
    const second = createServer();
    await expect(listenLocalhost(second, addr.port)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    await new Promise<void>((resolve, reject) => {
      blocker.close((err) => (err ? reject(err) : resolve()));
    });
  });
});
