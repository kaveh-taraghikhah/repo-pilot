import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphCommandResult } from "../output/types.ts";
import { isEscapingRelative } from "../path-utils.ts";

export interface GraphServeOptions {
  port: number;
  payload: GraphCommandResult;
  refresh?: () => Promise<GraphCommandResult>;
  openBrowser?: boolean;
  staticRoot?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function resolveStaticRoot(explicit?: string): string {
  if (explicit && existsSync(explicit)) return explicit;

  const here = fileURLToPath(new URL(".", import.meta.url));
  // Cover: source layout (src/graph), bundled CLI (dist/cli.js → dist/web),
  // and local dev / package checkout via cwd.
  const candidates = [
    resolve(here, "web"),
    resolve(here, "../web"),
    resolve(here, "../../dist/web"),
    resolve(here, "../../web/graph-viewer/dist"),
    resolve(process.cwd(), "dist/web"),
    resolve(process.cwd(), "web/graph-viewer/dist"),
  ];

  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }

  throw new Error(
    "Graph viewer assets not found. Run `bun run build:web` first (outputs dist/web).",
  );
}

/** Resolve a URL path under staticRoot; returns null if it escapes the root. */
export function resolveSafeStaticPath(
  staticRoot: string,
  urlPathname: string,
): string | null {
  let pathname = urlPathname === "/" ? "/index.html" : urlPathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  if (/\.\.($|[/\\])/.test(pathname)) return null;

  const root = resolve(staticRoot);
  const candidate = resolve(root, pathname.replace(/^\/+/, ""));
  const rel = relative(root, candidate);
  if (isEscapingRelative(rel)) {
    return null;
  }
  if (!candidate.startsWith(root + sep) && candidate !== root) {
    return null;
  }

  // Reject symlink escapes: real path must stay under the real static root.
  if (existsSync(candidate)) {
    try {
      const realRoot = realpathSync(root);
      const realCandidate = realpathSync(candidate);
      if (
        realCandidate !== realRoot &&
        !realCandidate.startsWith(realRoot + sep)
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }

  return candidate;
}

export type GraphHandlerResult = {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
};

/**
 * Pure request handler for tests and both Bun/Node servers.
 */
export function createGraphHandler(
  getPayload: () => GraphCommandResult | Promise<GraphCommandResult>,
  staticRoot: string,
) {
  return async function handle(
    reqUrl: string,
    method: string,
  ): Promise<GraphHandlerResult> {
    if (method !== "GET" && method !== "HEAD") {
      return {
        status: 405,
        headers: { "content-type": "text/plain" },
        body: "Method Not Allowed",
      };
    }

    let url: URL;
    try {
      url = new URL(reqUrl, "http://localhost");
    } catch {
      return {
        status: 400,
        headers: { "content-type": "text/plain" },
        body: "Bad Request",
      };
    }

    if (url.pathname === "/api/graph") {
      const payload = await getPayload();
      return {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
        body: method === "HEAD" ? new Uint8Array() : JSON.stringify(payload),
      };
    }

    // Reject traversal on the pathname / path-before-query only
    // (query strings may legitimately contain "..")
    const pathBeforeQuery = (reqUrl.split("?")[0] ?? "").replace(/^https?:\/\/[^/]+/i, "");
    if (
      /\.\.($|[/\\])|%2e%2e/i.test(url.pathname) ||
      /\.\.($|[/\\])|%2e%2e/i.test(pathBeforeQuery)
    ) {
      return {
        status: 403,
        headers: { "content-type": "text/plain" },
        body: "Forbidden",
      };
    }

    const filePath = resolveSafeStaticPath(staticRoot, url.pathname);
    if (filePath === null) {
      return {
        status: 403,
        headers: { "content-type": "text/plain" },
        body: "Forbidden",
      };
    }

    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = extname(filePath).toLowerCase();
      const body = method === "HEAD" ? new Uint8Array() : readFileSync(filePath);
      return {
        status: 200,
        headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
        body,
      };
    }

    // SPA fallback only for extensionless app routes — same symlink jail as assets
    const wantsAsset = Boolean(extname(url.pathname));
    if (!wantsAsset) {
      const indexPath = resolveSafeStaticPath(staticRoot, "/index.html");
      if (indexPath && existsSync(indexPath) && statSync(indexPath).isFile()) {
        return {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: method === "HEAD" ? new Uint8Array() : readFileSync(indexPath),
        };
      }
    }

    return {
      status: 404,
      headers: { "content-type": "text/plain" },
      body: "Not Found",
    };
  };
}

export async function startGraphServer(options: GraphServeOptions): Promise<{
  url: string;
  stop: () => void;
}> {
  const staticRoot = resolveStaticRoot(options.staticRoot);
  let payload = options.payload;

  const handle = createGraphHandler(async () => payload, staticRoot);

  const dispatch = async (reqUrl: string, method: string) => {
    try {
      const url = new URL(reqUrl, "http://localhost");
      if (
        url.pathname === "/api/graph" &&
        url.searchParams.get("refresh") === "1" &&
        options.refresh
      ) {
        payload = await options.refresh();
      }
      return handle(reqUrl, method);
    } catch {
      return {
        status: 400,
        headers: { "content-type": "text/plain" },
        body: "Bad Request",
      };
    }
  };

  const url = `http://127.0.0.1:${options.port}`;

  if (typeof globalThis.Bun !== "undefined") {
    const server = globalThis.Bun.serve({
      port: options.port,
      hostname: "127.0.0.1",
      async fetch(req: Request) {
        const result = await dispatch(req.url, req.method);
        return new Response(result.body, {
          status: result.status,
          headers: result.headers,
        });
      },
    });

    if (options.openBrowser) tryOpen(url);

    return {
      url,
      stop: () => {
        server.stop(true);
      },
    };
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const host = req.headers.host ?? `127.0.0.1:${options.port}`;
      const full = `http://${host}${req.url ?? "/"}`;
      const result = await dispatch(full, req.method ?? "GET");
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal Server Error");
    }
  });

  await listenLocalhost(server, options.port);

  if (options.openBrowser) tryOpen(url);

  return {
    url,
    stop: () => {
      server.close();
    },
  };
}

/** Bind an `http.Server` to 127.0.0.1; reject on EADDRINUSE / other listen errors. */
export function listenLocalhost(
  server: {
    listen: (
      port: number,
      host: string,
      cb: () => void,
    ) => void;
    once: (event: "error", cb: (err: Error) => void) => void;
    removeListener: (event: "error", cb: (err: Error) => void) => void;
  },
  port: number,
): Promise<void> {
  return new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
}

function tryOpen(target: string): void {
  try {
    if (process.platform === "darwin") {
      spawn("open", [target], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", target], {
        stdio: "ignore",
        detached: true,
      }).unref();
    } else {
      spawn("xdg-open", [target], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // ignore
  }
}
