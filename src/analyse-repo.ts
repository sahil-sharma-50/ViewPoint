/**
 * src/analyse-repo.ts — TypeScript Export Graph Builder (Task 3).
 *
 * Builds an ExportGraph by:
 *   1. Loading tsconfig.json from repoPath via ts.parseJsonConfigFileContent.
 *   2. Creating a ts.Program over all source files in rootDir.
 *   3. Walking each source file to collect export declarations and import edges.
 *   4. Applying certainty/evidence rules from src/types.ts:
 *      - 'candidate'  → fanIn === 0, no unknown conditions, not an entry point.
 *      - 'unknown'    → dynamic import with non-literal specifier, barrel re-export
 *                       reaching node_modules, .d.ts-only declaration, or entry point.
 *      - 'unsafe'     → fanIn > 0.
 *
 * Module resolution uses ts.resolveModuleName so relative imports and tsconfig
 * path aliases work correctly. Only edges that resolve to internal source files
 * (not node_modules) are recorded.
 *
 * Returns a discriminated union — never throws.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as ts from 'typescript';
import type {
  ExportGraph,
  ExportNode,
  ExportKind,
  EntryPointKind,
} from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildGraph(
  repoPath: string,
): Promise<{ ok: true; graph: ExportGraph } | { ok: false; error: string }> {
  try {
    const graph = buildGraphSync(repoPath);
    return { ok: true, graph };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Internal implementation (sync — ts.Program is synchronous)
// ---------------------------------------------------------------------------

function buildGraphSync(repoPath: string): ExportGraph {
  // ── 1. Load tsconfig ──────────────────────────────────────────────────────
  const tsconfigPath = path.join(repoPath, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) {
    throw new Error(`tsconfig.json not found at ${tsconfigPath}`);
  }

  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    repoPath,
  );
  if (parsedConfig.errors.length > 0) {
    throw new Error(
      parsedConfig.errors
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
        .join('\n'),
    );
  }

  // ── 2. Collect package.json entry points ─────────────────────────────────
  const entryPoints = collectEntryPoints(repoPath);

  // ── 3. Create ts.Program ──────────────────────────────────────────────────
  const program = ts.createProgram({
    rootNames: parsedConfig.fileNames,
    options: parsedConfig.options,
  });

  // Normalise repoPath for comparisons (trailing sep removed).
  const repoRoot = normalisePath(repoPath);

  // ── 4. Collect all internal source files ─────────────────────────────────
  // An "internal" file is one that lives inside repoPath and is not from node_modules.
  // "production internal" files additionally exclude test files (*.test.ts, *.spec.ts).
  // Test files are excluded from edge-building (fan-in) so that importing a module
  // in a test suite does not prevent that module from being classified as a candidate.
  const internalFiles = new Set<string>();
  const productionFiles = new Set<string>(); // internal files that are not test files
  for (const sf of program.getSourceFiles()) {
    const norm = normalisePath(sf.fileName);
    if (norm.startsWith(repoRoot + '/') && !norm.includes('/node_modules/')) {
      internalFiles.add(norm);
      if (!isTestFile(norm)) {
        productionFiles.add(norm);
      }
    }
  }

  // ── 5. Build nodes and edges ──────────────────────────────────────────────
  // nodes: fileId → ExportNode
  // edges: fileId → Set<fileId> (files this file imports)
  const nodes = new Map<string, ExportNode>();
  const edges = new Map<string, Set<string>>();

  // Track which files have dynamic imports with non-literal specifiers.
  const hasDynamicUnknown = new Set<string>();
  // Track barrel re-exports reaching node_modules.
  const hasBarrelReexport = new Set<string>();

  // First pass: collect exports and detect dynamic-import/barrel issues.
  for (const sf of program.getSourceFiles()) {
    const fileId = normalisePath(sf.fileName);
    if (!internalFiles.has(fileId)) continue;
    if (sf.isDeclarationFile) continue; // skip .d.ts — handled below if needed

    const repoRelative = toRepoRelative(fileId, repoRoot);

    // Collect all top-level export declarations.
    const exports = collectExports(sf);

    // Walk for dynamic imports and barrel re-exports.
    walkDynamicImports(sf, hasDynamicUnknown, fileId);
    walkBarrelReexports(sf, hasBarrelReexport, fileId, program, internalFiles, repoRoot, parsedConfig.options);

    if (exports.length === 0) continue; // no exports → skip node creation

    const isSoleExport = exports.length === 1;

    // Entry-point detection.
    const epInfo = entryPoints.get(repoRelative);
    const isEntryPoint = epInfo !== undefined;

    for (const exp of exports) {
      const nodeId = `${repoRelative}#${exp.name}`;
      const node: ExportNode = {
        id: nodeId,
        file: repoRelative,
        name: exp.name,
        kind: exp.kind,
        fanIn: 0,   // computed in second pass
        fanOut: 0,  // computed after edges are built
        isSoleExport,
        isEntryPoint,
        entryPointKind: epInfo,
        certainty: 'candidate', // placeholder; set in classify pass
        evidence: [],
      };
      nodes.set(nodeId, node);
    }

    // Initialise edge set for this file.
    if (!edges.has(fileId)) {
      edges.set(fileId, new Set<string>());
    }
  }

  // Second pass: resolve imports and build edges.
  // Only production files contribute to edges (test files are excluded as importers
  // so they don't inflate fanIn counts for production modules).
  for (const sf of program.getSourceFiles()) {
    const fileId = normalisePath(sf.fileName);
    if (!productionFiles.has(fileId)) continue;
    if (sf.isDeclarationFile) continue;

    const fileEdges = edges.get(fileId) ?? new Set<string>();

    // Walk import declarations.
    ts.forEachChild(sf, (node) => {
      if (
        ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node)
      ) {
        const modSpecifier = node.moduleSpecifier;
        if (!modSpecifier || !ts.isStringLiteral(modSpecifier)) return;

        const specifier = modSpecifier.text;
        const resolved = resolveImport(specifier, sf.fileName, parsedConfig.options);
        if (!resolved) return;

        const normResolved = normalisePath(resolved);
        if (!internalFiles.has(normResolved)) return;

        fileEdges.add(normResolved);
      }
    });

    edges.set(fileId, fileEdges);
  }

  // ── 6. Compute fanIn, fanOut, and evidence ────────────────────────────────

  // fanIn: number of distinct internal files that import file X.
  // We need a reverse map: importedFileId → Set of importer fileIds.
  const reverseEdges = new Map<string, Set<string>>();
  for (const [importer, imported] of edges) {
    for (const dep of imported) {
      if (!reverseEdges.has(dep)) reverseEdges.set(dep, new Set());
      reverseEdges.get(dep)!.add(importer);
    }
  }

  // Assign fanIn, fanOut, and internal-ref evidence to nodes.
  for (const node of nodes.values()) {
    const fileId = toAbsoluteFileId(node.file, repoRoot);

    // fanIn: how many internal files import this file.
    const importers = reverseEdges.get(fileId) ?? new Set<string>();
    node.fanIn = importers.size;

    // fanOut: how many internal files this file imports.
    const deps = edges.get(fileId) ?? new Set<string>();
    node.fanOut = deps.size;

    // Build evidence for internal references (fanIn > 0).
    for (const importerFileId of importers) {
      const importerRelative = toRepoRelative(importerFileId, repoRoot);
      const importerSf = program.getSourceFile(importerFileId);
      const line = importerSf ? findImportLine(importerSf, fileId, parsedConfig.options) : undefined;
      const detail = line !== undefined
        ? `imported by ${importerRelative}:${line}`
        : `imported by ${importerRelative}`;
      node.evidence.push({ kind: 'internal-ref', detail });
    }
  }

  // ── 7. Classify certainty ─────────────────────────────────────────────────
  for (const node of nodes.values()) {
    const fileId = toAbsoluteFileId(node.file, repoRoot);

    if (node.isEntryPoint) {
      node.certainty = 'unknown';
      node.evidence.push({ kind: 'entry-point', detail: `declared in package.json "${node.entryPointKind}" field` });
      continue;
    }

    if (node.fanIn > 0) {
      node.certainty = 'unsafe';
      continue;
    }

    // fanIn === 0 — check unknown conditions.
    let hasUnknownCondition = false;

    if (hasDynamicUnknown.has(fileId)) {
      hasUnknownCondition = true;
      node.evidence.push({ kind: 'dynamic-import', detail: 'file contains a dynamic import with a non-literal specifier' });
    }

    if (hasBarrelReexport.has(fileId)) {
      hasUnknownCondition = true;
      node.evidence.push({ kind: 'barrel-reexport', detail: 'file contains a re-export that may reach node_modules' });
    }

    if (hasUnknownCondition) {
      node.certainty = 'unknown';
    } else {
      node.certainty = 'candidate';
      node.evidence.push({ kind: 'no-internal-refs', detail: 'no internal files import this file' });
    }
  }

  // ── 8. Build the file-level edge map for ExportGraph ─────────────────────
  // ExportGraph.edges uses repo-relative file IDs (not absolute paths).
  const graphEdges = new Map<string, Set<string>>();
  for (const [importerAbs, importedAbsSet] of edges) {
    const importerRel = toRepoRelative(importerAbs, repoRoot);
    const importedRelSet = new Set<string>();
    for (const importedAbs of importedAbsSet) {
      importedRelSet.add(toRepoRelative(importedAbs, repoRoot));
    }
    graphEdges.set(importerRel, importedRelSet);
  }

  return { nodes, edges: graphEdges };
}

// ---------------------------------------------------------------------------
// Export collection
// ---------------------------------------------------------------------------

interface ExportDecl {
  name: string;
  kind: ExportKind;
}

function collectExports(sf: ts.SourceFile): ExportDecl[] {
  const result: ExportDecl[] = [];

  ts.forEachChild(sf, (node) => {
    if (!hasExportModifier(node)) return;

    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
      const name = node.name?.text;
      if (name) result.push({ name, kind: 'function' });
    } else if (ts.isClassDeclaration(node)) {
      const name = node.name?.text;
      if (name) result.push({ name, kind: 'class' });
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          result.push({ name: decl.name.text, kind: 'variable' });
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      result.push({ name: node.name.text, kind: 'interface' });
    } else if (ts.isTypeAliasDeclaration(node)) {
      result.push({ name: node.name.text, kind: 'type' });
    } else if (ts.isEnumDeclaration(node)) {
      result.push({ name: node.name.text, kind: 'enum' });
    } else if (ts.isModuleDeclaration(node)) {
      result.push({ name: node.name.text, kind: 'namespace' });
    }
  });

  return result;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

// ---------------------------------------------------------------------------
// Dynamic import detection
// ---------------------------------------------------------------------------

function walkDynamicImports(
  sf: ts.SourceFile,
  result: Set<string>,
  fileId: string,
): void {
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      // import(expr) — check whether expr is a string literal.
      const arg = node.arguments[0];
      if (!arg || !ts.isStringLiteral(arg)) {
        result.add(fileId);
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sf, visit);
}

// ---------------------------------------------------------------------------
// Barrel re-export detection (re-exports that may reach node_modules)
// ---------------------------------------------------------------------------

function walkBarrelReexports(
  sf: ts.SourceFile,
  result: Set<string>,
  fileId: string,
  program: ts.Program,
  internalFiles: Set<string>,
  repoRoot: string,
  compilerOptions: ts.CompilerOptions,
): void {
  ts.forEachChild(sf, (node) => {
    if (!ts.isExportDeclaration(node)) return;
    // export * from '...' or export { ... } from '...'
    const modSpec = node.moduleSpecifier;
    if (!modSpec || !ts.isStringLiteral(modSpec)) return;

    const specifier = modSpec.text;
    const resolved = resolveImport(specifier, sf.fileName, compilerOptions);
    if (!resolved) {
      // Unresolvable → treat as potentially external.
      result.add(fileId);
      return;
    }
    const norm = normalisePath(resolved);
    if (!internalFiles.has(norm)) {
      // Resolved outside internal files → reaches node_modules or external.
      result.add(fileId);
    }
  });

  void program; void repoRoot; // suppress unused warnings
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

function resolveImport(
  specifier: string,
  fromFile: string,
  compilerOptions: ts.CompilerOptions,
): string | undefined {
  const result = ts.resolveModuleName(specifier, fromFile, compilerOptions, ts.sys);
  const resolved = result.resolvedModule;
  if (!resolved) return undefined;
  if (resolved.isExternalLibraryImport) return undefined;
  return resolved.resolvedFileName;
}

// ---------------------------------------------------------------------------
// Entry-point collection from package.json
// ---------------------------------------------------------------------------

function collectEntryPoints(repoPath: string): Map<string, EntryPointKind> {
  const pkgPath = path.join(repoPath, 'package.json');
  const result = new Map<string, EntryPointKind>();

  if (!fs.existsSync(pkgPath)) return result;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return result;
  }

  function addResolved(raw: string, kind: EntryPointKind): void {
    // Strip leading './' and .js extension; try multiple TS extensions.
    const stripped = raw.replace(/^\.\//, '').replace(/\.js$/, '');
    for (const ext of ['.ts', '.tsx', '']) {
      const candidate = stripped + ext;
      result.set(candidate, kind);
    }
    // Also store as-is (repo-relative without leading ./).
    result.set(raw.replace(/^\.\//, ''), kind);
  }

  function processValue(value: unknown, kind: EntryPointKind): void {
    if (typeof value === 'string') {
      addResolved(value, kind);
    } else if (typeof value === 'object' && value !== null) {
      for (const v of Object.values(value as Record<string, unknown>)) {
        processValue(v, kind);
      }
    }
  }

  if (typeof pkg['main'] === 'string') processValue(pkg['main'], 'main');
  if (typeof pkg['module'] === 'string') processValue(pkg['module'], 'module');
  processValue(pkg['exports'], 'exports');
  processValue(pkg['bin'], 'bin');

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise slashes to forward-slash for cross-platform consistency. */
function normalisePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '');
}

/**
 * Returns true when the file is a test or spec file.
 * Test files are excluded from edge-building so they don't inflate fanIn
 * counts for production modules.
 */
function isTestFile(fileId: string): boolean {
  const base = fileId.split('/').pop() ?? '';
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(base);
}

/** Return the path relative to repoRoot (no leading slash). */
function toRepoRelative(absPath: string, repoRoot: string): string {
  const norm = normalisePath(absPath);
  if (norm.startsWith(repoRoot + '/')) {
    return norm.slice(repoRoot.length + 1);
  }
  return norm;
}

/** Reconstruct the absolute file ID from a repo-relative path and repoRoot. */
function toAbsoluteFileId(repoRelative: string, repoRoot: string): string {
  return `${repoRoot}/${repoRelative}`;
}

/**
 * Find the 1-based line number of the first import statement in `importer`
 * that resolves to `targetFileId`.
 */
function findImportLine(
  sf: ts.SourceFile,
  targetFileId: string,
  options: ts.CompilerOptions,
): number | undefined {
  let result: number | undefined;

  ts.forEachChild(sf, (node) => {
    if (result !== undefined) return;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const resolved = resolveImport(specifier, sf.fileName, options);
      if (resolved && normalisePath(resolved) === targetFileId) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        result = line + 1; // 1-based
      }
    }
  });

  return result;
}
