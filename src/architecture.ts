import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { listRepoFiles, scriptFile } from './repo-files.js';
import type { SerialGraph } from './server.js';

export interface ApiCall {
  source: string;
  method: string;
  url: string;
  target?: string;
  dynamic?: true;
}

export interface ApiRoute { file: string; url: string; method?: string; unmounted?: true }

export interface ArchitectureFile {
  file: string;
  language?: string;
  lines?: number;
  role: 'entry' | 'interface' | 'routes' | 'logic' | 'data' | 'other';
  runtime: 'frontend' | 'backend' | 'shared' | 'unknown';
  evidence: string[];
}

export interface Architecture {
  schema: 1;
  routes: ApiRoute[];
  calls: ApiCall[];
  files: ArchitectureFile[];
  deployments: { file: string; target: string; kind: string }[];
  states: { file: string; name: string; initial: string; values: string[] }[];
  scannedFiles: number;
  skippedFiles: number;
}

function routeUrl(file: string): string | undefined {
  const segments = (value: string) => value.split('/').map(part => /^\[\.\.\.(.+)\]$/.test(part) ? ':' + part.slice(4, -1) + '*' : /^\[(.+)\]$/.test(part) ? ':' + part.slice(1, -1) : part).join('/');
  const nextApp = file.match(/(?:^|\/)(?:src\/)?app\/(api(?:\/.*?)?)\/route\.[cm]?[jt]sx?$/);
  if (nextApp) return '/' + segments(nextApp[1]!.split('/').filter(part => !/^\(.+\)$/.test(part)).join('/'));
  const nextPage = file.match(/(?:^|\/)(?:src\/)?pages\/api\/(.+)\.[cm]?[jt]sx?$/);
  if (nextPage) return '/api' + (nextPage[1] === 'index' ? '' : '/' + segments(nextPage[1]!.replace(/\/index$/, '')));
  return undefined;
}

function methodFromFetch(node: ts.CallExpression): string {
  const options = node.arguments[1];
  if (!options) return 'GET';
  if (options && ts.isObjectLiteralExpression(options)) {
    let method = 'GET';
    for (const prop of options.properties) {
      if (ts.isSpreadAssignment(prop) || prop.name && ts.isComputedPropertyName(prop.name)) method = 'UNKNOWN';
      else if (prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) && prop.name.text === 'method')
        method = ts.isPropertyAssignment(prop) && ts.isStringLiteralLike(prop.initializer) ? prop.initializer.text.toUpperCase() : 'UNKNOWN';
    }
    return method;
  }
  return 'UNKNOWN';
}

function literalValue(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (node.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  return undefined;
}

/** Resolve only source literals and constants. A star marks a computed segment. */
function urlText(expression: ts.Expression, checker: ts.TypeChecker): string {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isIdentifier(expression)) {
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && declaration.parent.flags & ts.NodeFlags.Const && declaration.initializer && ts.isStringLiteralLike(declaration.initializer)) return declaration.initializer.text;
    return 'Dynamic URL';
  }
  if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'URL' && expression.arguments?.[0]) {
    const input = urlText(expression.arguments[0], checker);
    const base = expression.arguments[1] ? urlText(expression.arguments[1], checker) : undefined;
    try { return new URL(input, base).href; } catch { return 'Dynamic URL'; }
  }
  if (ts.isTemplateExpression(expression)) {
    let result = expression.head.text;
    for (const span of expression.templateSpans) {
      const value = urlText(span.expression, checker);
      result += value === 'Dynamic URL' ? /^https?:\/\/[^/]+$/.test(result) ? '/*' : '*' : value;
      result += span.literal.text;
    }
    return result || 'Dynamic URL';
  }
  return 'Dynamic URL';
}

function reachable(seeds: Set<string>, graph: SerialGraph): Set<string> {
  const imports = new Map(graph.edges.map(edge => [edge.source, edge.targets]));
  const seen = new Set(seeds);
  const queue = [...seeds];
  for (let index = 0; index < queue.length; index++) {
    for (const target of imports.get(queue[index]!) ?? []) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

/** Read visible source files. Only parsed JS/TS facts create named HTTP connections. */
export function buildArchitecture(root: string, graph: SerialGraph): Architecture {
  const inventory = listRepoFiles(root);
  const sourceFiles = inventory.filter(file => scriptFile.test(file) || /\.(?:py|go|java)$/i.test(file));
  const files = sourceFiles.map(file => path.relative(root, file).replace(/\\/g, '/'));
  const routes: ApiRoute[] = [];
  const calls: ApiCall[] = [];
  const deployments: Architecture['deployments'] = [];
  const states: Architecture['states'] = [];
  for (const filePath of inventory) {
    const file = path.relative(root, filePath).replace(/\\/g, '/');
    if (!/(?:^|\/)(?:Dockerfile(?:\.[^/]+)?|(?:compose|docker-compose)(?:\.[^/]+)?\.ya?ml|package\.json)$|\.tf$/i.test(file)) continue;
    if (fs.statSync(filePath).size > 100_000) continue;
    if (/(?:^|\/)Dockerfile(?:\.[^/]+)?$/i.test(file)) {
      const source = fs.readFileSync(filePath, 'utf8');
      for (const match of source.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?([^\s]+)(?:\s+AS\s+([^\s]+))?/gim)) {
        deployments.push({ file, target: match[1]!, kind: match[2] ? `Build stage ${match[2]}` : 'Container base image' });
      }
    }
    if (/(?:^|\/)(?:compose|docker-compose)(?:\.[^/]+)?\.ya?ml$/i.test(file)) {
      const source = fs.readFileSync(filePath, 'utf8');
      for (const match of source.matchAll(/^\s+image:\s*['"]?([^\s'"#]+)['"]?/gim)) {
        deployments.push({ file, target: match[1]!, kind: 'Compose service image' });
      }
    }
    if (/\.tf$/i.test(file)) {
      const source = fs.readFileSync(filePath, 'utf8');
      for (const match of source.matchAll(/^\s*resource\s+"([^"]+)"\s+"([^"]+)"/gm)) {
        deployments.push({ file, target: match[1] + '.' + match[2], kind: 'Terraform resource' });
      }
    }
    if (/(?:^|\/)package\.json$/.test(file)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { scripts?: Record<string, string> };
        if (typeof manifest.scripts?.start === 'string') deployments.push({ file, target: manifest.scripts.start, kind: 'Start command' });
      } catch { /* Malformed manifests provide no deployment facts. */ }
    }
  }
  const facts = new Map<string, { jsx: boolean; client: boolean; server: boolean; data: boolean; evidence: string[]; lines: number }>();
  const frontendSeeds = new Set<string>();
  const backendSeeds = new Set<string>();
  const entryFiles = new Set(graph.nodes.filter(node => node.isEntryPoint).map(node => node.file));

  for (let index = 0; index < sourceFiles.length; index++) {
    const file = files[index]!;
    const text = fs.readFileSync(sourceFiles[index]!, 'utf8');
    if (!scriptFile.test(file)) {
      facts.set(file, { jsx: false, client: false, server: false,
        data: /(?:^|\/)(?:db|database|data|models|repositories)\//.test(file),
        evidence: [], lines: text ? text.split(/\r\n|\r|\n/).length : 0 });
      continue;
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    // Bind local names without resolving dependencies or reading library files.
    const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = name => name === file ? source : undefined;
    const checker = ts.createProgram([file], options, host).getTypeChecker();
    function imported(expression: ts.Expression): { module: string; name: string } | undefined {
      if (ts.isPropertyAccessExpression(expression)) {
        const base = imported(expression.expression);
        return base && (base.name === 'default' || base.name === '*') ? { ...base, name: expression.name.text } : undefined;
      }
      if (!ts.isIdentifier(expression)) return undefined;
      const declaration = checker.getSymbolAtLocation(expression)?.declarations?.[0];
      if (!declaration) return undefined;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isCallExpression(declaration.initializer)) {
        const call = declaration.initializer;
        if (ts.isIdentifier(call.expression) && call.expression.text === 'require' && call.arguments[0] && ts.isStringLiteralLike(call.arguments[0])) return { module: call.arguments[0].text, name: 'default' };
      }
      const name = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : ts.isImportClause(declaration) ? 'default' : ts.isNamespaceImport(declaration) ? '*' : undefined;
      if (!name) return undefined;
      let parent: ts.Node = declaration;
      while (!ts.isImportDeclaration(parent) && parent.parent) parent = parent.parent;
      return ts.isImportDeclaration(parent) && ts.isStringLiteralLike(parent.moduleSpecifier) ? { module: parent.moduleSpecifier.text, name } : undefined;
    }
    function serverReceiver(expression: ts.Expression): { unmounted: boolean } | undefined {
      const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer ||
        !(ts.isCallExpression(declaration.initializer) || ts.isNewExpression(declaration.initializer))) return undefined;
      const factory = imported(declaration.initializer.expression);
      if (!factory) return undefined;
      if (factory.module === 'express' && ['default', 'Router'].includes(factory.name)) return { unmounted: factory.name === 'Router' };
      if (factory.module === 'fastify' && ['default', 'fastify'].includes(factory.name)) return { unmounted: false };
      if (factory.module === 'hono' && factory.name === 'Hono') return { unmounted: false };
      return undefined;
    }
    const stateSetters = new Map<ts.Symbol, Architecture['states'][number]>();
    const evidence: string[] = [];
    const nextRoute = routeUrl(file);
    if (nextRoute) {
      if (/\/route\.[cm]?[jt]sx?$/.test(file)) {
        for (const exported of checker.getSymbolAtLocation(source)?.exports?.keys() ?? []) {
          const method = String(exported);
          if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) routes.push({ file, url: nextRoute, method });
        }
      } else routes.push({ file, url: nextRoute });
      evidence.push('Route ' + nextRoute); backendSeeds.add(file);
    }
    let jsx = false;
    let server = false;
    let data = /(?:^|\/)(?:db|database|data|models|repositories)\//.test(file);
    const client = source.statements.some(node => ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'use client');
    if (client) evidence.push('Client component');
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const dependency = statement.moduleSpecifier.text;
        if (/^(?:next\/server|express|fastify|hono)(?:\/|$)/.test(dependency)) server = true;
        if (/^(?:@prisma\/client|drizzle-orm|mongoose|pg|mysql2|better-sqlite3)(?:\/|$)/.test(dependency)) data = true;
      }
    }
    function collectStates(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer && ts.isCallExpression(node.initializer)
        && imported(node.initializer.expression)?.module === 'react' && imported(node.initializer.expression)?.name === 'useState'
        && literalValue(node.initializer.arguments[0]) !== undefined) {
        const [value, setter] = node.name.elements;
        if (value && setter && ts.isBindingElement(value) && ts.isBindingElement(setter) && ts.isIdentifier(value.name) && ts.isIdentifier(setter.name)) {
          const state = { file, name: value.name.text, initial: literalValue(node.initializer.arguments[0])!, values: [] as string[] };
          states.push(state);
          const symbol = checker.getSymbolAtLocation(setter.name);
          if (symbol) stateSetters.set(symbol, state);
        }
      }
      ts.forEachChild(node, collectStates);
    }
    collectStates(source);
    function visit(node: ts.Node): void {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) jsx = true;
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const setter = ts.isIdentifier(expression) ? checker.getSymbolAtLocation(expression) : undefined;
        if (setter && stateSetters.has(setter) && literalValue(node.arguments[0]) !== undefined) {
          const state = stateSetters.get(setter)!;
          const value = literalValue(node.arguments[0])!;
          if (!state.values.includes(value)) state.values.push(value);
        }
        if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'listen') server = true;
        if (node.arguments.length >= 2 && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && ts.isPropertyAccessExpression(expression) && /^(?:get|post|put|patch|delete|head|options|all)$/i.test(expression.name.text) && serverReceiver(expression.expression)) {
          const url = node.arguments[0].text;
          if (url.startsWith('/')) {
            routes.push({ file, url, method: expression.name.text.toUpperCase(), ...(serverReceiver(expression.expression)?.unmounted ? { unmounted: true as const } : {}) });
            evidence.push('Route ' + url); server = true;
          }
        }
        if (node.arguments[0]) {
          let method: string | undefined;
          const client = imported(expression);
          const globalFetch = ts.isIdentifier(expression) && expression.text === 'fetch' && !checker.getSymbolAtLocation(expression);
          const importedFetch = client && (
            ['node-fetch', 'cross-fetch', 'isomorphic-fetch'].includes(client.module) && client.name === 'default' ||
            ['undici', 'cross-fetch'].includes(client.module) && client.name === 'fetch'
          );
          if (globalFetch || importedFetch) method = methodFromFetch(node);
          if (client?.module === 'axios' && ts.isPropertyAccessExpression(expression) && /^(get|post|put|patch|delete|head|options|request)$/i.test(client.name)) method = client.name.toUpperCase();
          if (method) {
            const url = urlText(node.arguments[0], checker);
            calls.push({ source: file, method, url, ...(url.includes('*') || url === 'Dynamic URL' ? { dynamic: true as const } : {}) });
            if (evidence.length < 5) evidence.push(method + ' ' + url);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (jsx) evidence.push('Renders JSX');
    if (jsx || client || /(?:^|\/)(?:app\/page|pages\/index)\.[cm]?[jt]sx?$/.test(file)) frontendSeeds.add(file);
    if (server) backendSeeds.add(file);
    facts.set(file, { jsx, client, server, data, evidence: evidence.slice(0, 5), lines: text ? text.split(/\r\n|\r|\n/).length : 0 });
  }

  for (const call of calls) {
    if (call.dynamic) continue;
    // Absolute URLs do not prove which repository service receives a request.
    if (!call.url.startsWith('/') || call.url.startsWith('//')) continue;
    const pathname = call.url.split(/[?#]/)[0];
    const candidates = new Set(routes.filter(route => !route.unmounted && route.url === pathname && (route.method === call.method || route.method === 'ALL')).map(route => route.file));
    if (candidates.size === 1) call.target = [...candidates][0];
  }
  const frontend = reachable(frontendSeeds, graph);
  const backend = reachable(backendSeeds, graph);
  const insights: ArchitectureFile[] = files.map(file => {
    const fact = facts.get(file)!;
    const route = routes.some(item => item.file === file);
    const entry = !route && (entryFiles.has(file) || /(?:^|\/)(?:app\/page|pages\/index)\.[cm]?[jt]sx?$/.test(file) || /^(?:src\/)?(?:index|main|server)\.[cm]?[jt]sx?$/.test(file));
    const role = route ? 'routes' : entry ? 'entry' : fact.jsx || fact.client || /(?:^|\/)(?:components|views|screens)\//.test(file) ? 'interface' : fact.data ? 'data' : /(?:^|\/)(?:features|lib|services|utils|controllers|hooks)\//.test(file) ? 'logic' : 'other';
    const runtime = frontend.has(file) && backend.has(file) ? 'shared' : frontend.has(file) ? 'frontend' : backend.has(file) ? 'backend' : 'unknown';
    const extension = path.extname(file).toLowerCase();
    const language = extension === '.py' ? 'Python' : extension === '.go' ? 'Go' : extension === '.java' ? 'Java' : extension === '.tsx' || extension === '.ts' || extension === '.mts' || extension === '.cts' ? 'TypeScript' : 'JavaScript';
    return { file, role, runtime, evidence: fact.evidence, lines: fact.lines, language };
  });
  return { schema: 1, routes, calls, files: insights, deployments, states, scannedFiles: files.length, skippedFiles: 0 };
}
