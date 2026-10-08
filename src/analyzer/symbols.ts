import ts from "typescript";
import { isTestFile } from "../scanner/scan-files.ts";
import { toPosixRelative } from "./program.ts";

export interface FileSymbols {
  file: string;
  functions: string[];
  classes: string[];
  isRoute: boolean;
  isTest: boolean;
}

export function extractSymbols(sourceFile: ts.SourceFile, root: string): FileSymbols {
  const file = toPosixRelative(root, sourceFile.fileName);
  const functions: string[] = [];
  const classes: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      functions.push(node.name.text);
    }
    if (ts.isClassDeclaration(node) && node.name) {
      classes.push(node.name.text);
    }
    // const foo = () => {} / function expressions assigned
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          functions.push(decl.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    file,
    functions,
    classes,
    isRoute: detectRoute(file, sourceFile),
    isTest: isTestFile(file),
  };
}

function detectRoute(relativePath: string, sourceFile: ts.SourceFile): boolean {
  const path = relativePath.replaceAll("\\", "/");
  if (/(^|\/)app\/.*\/route\.[cm]?[jt]sx?$/.test(path)) return true;
  if (/(^|\/)pages\/api\/.+\.[cm]?[jt]sx?$/.test(path)) return true;

  const httpMethods = new Set([
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "all",
    "use",
  ]);
  // Factory/constructors: express(), new Koa(), Router(), …
  // Bare `app`/`router` identifiers are NOT trusted — only aliases bound to a
  // factory (`const app = express()`) or chained factory calls count.
  const frameworkFactories = new Set([
    "express",
    "fastify",
    "hono",
    "koa",
    "router",
  ]);

  // Functions that return a router/app factory (e.g. `function createApp() { return express(); }`).
  const routerFactoryFns = new Set<string>();
  const routerAliases = new Set<string>();

  const noteRouterFactoryFn = (name: string, body: ts.ConciseBody | undefined): void => {
    if (!body) return;
    const visitReturn = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression) {
        if (isRouterFactoryInitializer(node.expression, frameworkFactories, routerFactoryFns)) {
          routerFactoryFns.add(name.toLowerCase());
        }
      }
      ts.forEachChild(node, visitReturn);
    };
    if (ts.isBlock(body)) {
      for (const stmt of body.statements) visitReturn(stmt);
    } else if (isRouterFactoryInitializer(body, frameworkFactories, routerFactoryFns)) {
      routerFactoryFns.add(name.toLowerCase());
    }
  };

  const collectFactoryFns = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      noteRouterFactoryFn(node.name.text, node.body);
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        if (
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
          init.body
        ) {
          noteRouterFactoryFn(decl.name.text, init.body);
        }
      }
    }
    ts.forEachChild(node, collectFactoryFns);
  };

  const collectAliases = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        if (!init) continue;
        if (isRouterFactoryInitializer(init, frameworkFactories, routerFactoryFns)) {
          routerAliases.add(decl.name.text.toLowerCase());
        }
      }
    }
    ts.forEachChild(node, collectAliases);
  };

  // Collect factory fns to a fixpoint so nested wrappers work regardless of
  // declaration order (`createApp` → `createInner` → `express()`).
  for (;;) {
    const before = routerFactoryFns.size;
    collectFactoryFns(sourceFile);
    if (routerFactoryFns.size === before) break;
  }
  collectAliases(sourceFile);

  let hasHttpHandler = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name)
    ) {
      const method = node.expression.name.text.toLowerCase();
      if (!httpMethods.has(method)) {
        ts.forEachChild(node, visit);
        return;
      }

      const receiver = node.expression.expression;
      if (
        !isRouterLikeReceiver(receiver, frameworkFactories, routerAliases, routerFactoryFns)
      ) {
        ts.forEachChild(node, visit);
        return;
      }

      // Require a route path plus a handler arg, or middleware-style `use`.
      const firstArg = node.arguments[0];
      const pathLike = firstArg ? looksLikeRoutePathArg(firstArg) : false;
      if (method === "use" && node.arguments.length >= 1) {
        hasHttpHandler = true;
      } else if (pathLike && node.arguments.length >= 2) {
        hasHttpHandler = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hasHttpHandler;
}

/** Initializer / return value that constructs an HTTP router or app. */
function isRouterFactoryInitializer(
  expr: ts.Expression,
  factories: ReadonlySet<string>,
  factoryFns: ReadonlySet<string>,
): boolean {
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    if (ts.isIdentifier(callee)) {
      if (factories.has(callee.text.toLowerCase())) return true;
      if (factoryFns.has(callee.text.toLowerCase())) return true;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text.toLowerCase();
      const obj = callee.expression;
      if (ts.isIdentifier(obj) && factories.has(obj.text.toLowerCase())) {
        if (method === "router" || factories.has(method)) return true;
      }
    }
    if (isRequireFactoryCall(callee, factories)) return true;
    if (isRouterFactoryInitializer(callee, factories, factoryFns)) return true;
  }
  if (
    ts.isNewExpression(expr) &&
    expr.expression &&
    ts.isIdentifier(expr.expression)
  ) {
    return factories.has(expr.expression.text.toLowerCase());
  }
  return false;
}

function isRequireFactoryCall(
  expr: ts.Expression,
  factories: ReadonlySet<string>,
): boolean {
  if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression)) return false;
  if (expr.expression.text !== "require") return false;
  const arg = expr.arguments[0];
  if (!arg || !ts.isStringLiteral(arg)) return false;
  return factories.has(arg.text.toLowerCase());
}

function isRouterLikeReceiver(
  receiver: ts.Expression,
  factories: ReadonlySet<string>,
  aliases: ReadonlySet<string>,
  factoryFns: ReadonlySet<string>,
): boolean {
  if (ts.isIdentifier(receiver)) {
    return aliases.has(receiver.text.toLowerCase());
  }
  return isRouterFactoryInitializer(receiver, factories, factoryFns);
}

/** True for Express-style path strings: `/users`, `/:id`, `*`, `:id` — not URLs. */
function looksLikeRoutePathArg(arg: ts.Expression): boolean {
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return isRoutePathText(arg.text);
  }
  // `/users/${id}` or `${base}/users` — inspect static template pieces.
  if (ts.isTemplateExpression(arg)) {
    // Reject URL-like templates (`https://${host}/api`).
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(arg.head.text)) return false;
    if (isRoutePathText(arg.head.text)) return true;
    for (const span of arg.templateSpans) {
      const lit = span.literal.text;
      // `${base}/users`, `${base}/:id`, `${base}/*`
      if (
        /\/(?:[A-Za-z0-9:_*-]|$)/.test(lit) ||
        lit.startsWith("*") ||
        /^:[A-Za-z_]/.test(lit)
      ) {
        return true;
      }
    }
    return false;
  }
  return false;
}

function isRoutePathText(text: string): boolean {
  if (text.startsWith("/") || text.startsWith("*")) return true;
  // Bare param token (`:id`), not `https://…`.
  if (/^:[A-Za-z_][\w]*$/.test(text)) return true;
  return false;
}
