import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { listRepoFiles, readRepoConfig, scriptFile } from './repo-files.js';
import { scanPython, scanStructured } from './python-adapter.js';
import type { ExportGraph } from './types.js';

export const ANALYSIS_VERSION = 9;
const relative = (root: string, file: string) => path.relative(root, file).replace(/\\/g, '/');
const basename = (file: string) => path.posix.basename(file).replace(/\.[^.]+$/, '');

/** Build only the file inventory and known source connections. No usage classification. */
export async function buildGraph(
  repoPath: string,
): Promise<{ ok: true; graph: ExportGraph } | { ok: false; error: string }> {
  try {
    const root = path.resolve(repoPath);
    const inventory = listRepoFiles(root);
    const files = inventory.map(file => relative(root, file));
    const known = new Set(files);
    const config = readRepoConfig(root, inventory);
    const entryPoints = packageEntries(root);
    const edges = new Map(files.map(file => [file, new Set<string>()]));
    const warnings: string[] = [];

    for (let index = 0; index < inventory.length; index++) {
      const absolute = inventory[index]!;
      const file = files[index]!;
      if (!scriptFile.test(file)) continue;
      const source = ts.createSourceFile(
        absolute,
        fs.readFileSync(absolute, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const add = (specifier: string) => {
        const resolved = ts.resolveModuleName(specifier, absolute, config.options, ts.sys)
          .resolvedModule?.resolvedFileName;
        if (!resolved) return;
        const target = relative(root, resolved);
        if (known.has(target) && target !== file) edges.get(file)!.add(target);
      };
      function visit(node: ts.Node): void {
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
            node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression))
          add(node.moduleReference.expression.text);
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal))
          add(node.argument.literal.text);
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier))
          add(node.moduleSpecifier.text);
        if (ts.isCallExpression(node) && node.arguments.length &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
             (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
            ts.isStringLiteralLike(node.arguments[0]!))
          add(node.arguments[0].text);
        ts.forEachChild(node, visit);
      }
      visit(source);
    }

    const pythonFiles = files.filter(file => file.endsWith('.py'));
    if (pythonFiles.length) {
      const scan = await scanPython(root, pythonFiles);
      if (scan.ok) for (const edge of scan.edges) edges.get(edge.source)?.add(edge.target);
      else warnings.push(`Python connections could not be scanned. ${scan.error}`);
    }
    for (const [language, extension] of [['go', '.go'], ['java', '.java']] as const) {
      const languageFiles = files.filter(file => file.endsWith(extension));
      if (!languageFiles.length) continue;
      const scan = await scanStructured(root, languageFiles, language);
      if (scan.ok) for (const edge of scan.edges) edges.get(edge.source)?.add(edge.target);
      else warnings.push(`${language === 'go' ? 'Go' : 'Java'} connections could not be scanned. ${scan.error}`);
    }

    const incoming = new Map(files.map(file => [file, 0]));
    for (const targets of edges.values())
      for (const target of targets) incoming.set(target, (incoming.get(target) ?? 0) + 1);
    const nodes = new Map(files.map(file => [file, {
      id: file,
      file,
      name: basename(file),
      fanIn: incoming.get(file) ?? 0,
      fanOut: edges.get(file)!.size,
      isEntryPoint: entryPoints.has(file) || /(?:^|\/)(?:index|main|app|server)\.[cm]?[jt]sx?$/.test(file),
    }]));
    return { ok: true, graph: { analysisVersion: ANALYSIS_VERSION, nodes, edges, ...(warnings.length ? { warnings } : {}) } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function packageEntries(root: string): Set<string> {
  const entries = new Set<string>();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    function add(value: unknown): void {
      if (typeof value === 'string') {
        const file = value.replace(/^\.\//, '');
        entries.add(file);
        entries.add(file.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'));
        entries.add(file.replace(/^dist\//, 'src/').replace(/\.js$/, '.tsx'));
      } else if (value && typeof value === 'object') for (const item of Object.values(value)) add(item);
    }
    for (const key of ['main', 'module', 'exports', 'bin']) add(pkg[key]);
  } catch { /* Repositories without package.json still have an import graph. */ }
  return entries;
}
