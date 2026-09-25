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
  // Pass compilerOptions so collectEntryPoints can remap dist/ → src/ paths.
  // (parsedConfig.options is already available; program is created after this step.)
  const entryPoints = collectEntryPoints(repoPath, parsedConfig.options);

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
  // The graph is file-level: one or more nodes per file, but every production
  // file that appears as an edge endpoint has at least one node so that edge
  // sources and targets are always resolvable in graph.nodes.
  //
  // nodes: nodeId (file#name) → ExportNode
  // edges: absFileId → Set<absFileId> (files this file imports)
  const nodes = new Map<string, ExportNode>();
  const edges = new Map<string, Set<string>>();

  // Track which production files have non-literal dynamic imports.
  // Fix: if ANY production file has a non-literal dynamic import, we cannot
  // know which other files it may load at runtime.  We record the set of
  // *containing* files here; the classify pass uses anyDynamicUnknown to
  // propagate the uncertainty to every fanIn===0 file that would otherwise
  // be classified 'candidate'.
  const hasDynamicUnknown = new Set<string>();
  // Track barrel re-exports reaching node_modules.
  const hasBarrelReexport = new Set<string>();

  // First pass: collect exports and detect dynamic-import/barrel issues.
  // Every internal production file gets at least one node (stub if no exports).
  for (const sf of program.getSourceFiles()) {
    const fileId = normalisePath(sf.fileName);
    if (!internalFiles.has(fileId)) continue;
    if (sf.isDeclarationFile) continue;

    const repoRelative = toRepoRelative(fileId, repoRoot);

    // Collect all top-level export declarations.
    const fileExports = collectExports(sf);

    // Walk for dynamic imports and barrel re-exports.
    walkDynamicImports(sf, hasDynamicUnknown, fileId);
    walkBarrelReexports(sf, hasBarrelReexport, fileId, program, internalFiles, repoRoot, parsedConfig.options);

    // Entry-point detection.
    const epInfo = entryPoints.get(repoRelative);
    const isEntryPoint = epInfo !== undefined;

    if (fileExports.length === 0) {
      // No exports — create a stub node so the file exists in the graph.
      // Files with no exports are never removal candidates (isSoleExport=false).
      const stub = fileBaseName(repoRelative);
      const nodeId = `${repoRelative}#${stub}`;
      nodes.set(nodeId, {
        id: nodeId,
        file: repoRelative,
        name: stub,
        kind: 'variable',
        fanIn: 0,
        fanOut: 0,
        isSoleExport: false,
        isEntryPoint,
        entryPointKind: epInfo,
        certainty: 'candidate',
        evidence: [],
      });
    } else {
      const isSoleExport = fileExports.length === 1;
      for (const exp of fileExports) {
        const nodeId = `${repoRelative}#${exp.name}`;
        nodes.set(nodeId, {
          id: nodeId,
          file: repoRelative,
          name: exp.name,
          kind: exp.kind,
          fanIn: 0,
          fanOut: 0,
          isSoleExport,
          isEntryPoint,
          entryPointKind: epInfo,
          certainty: 'candidate',
          evidence: [],
        });
      }
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
  // If any production file contains a non-literal dynamic import, none of the
  // fanIn===0 files can be confidently classified — the dynamic import may load
  // any of them at runtime.  We propagate the uncertainty to every file that
  // would otherwise be a 'candidate'.
  const anyDynamicUnknown = hasDynamicUnknown.size > 0;

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

    // This file itself has an unresolvable dynamic import.
    if (hasDynamicUnknown.has(fileId)) {
      hasUnknownCondition = true;
      node.evidence.push({ kind: 'dynamic-import', detail: 'file contains a dynamic import with a non-literal specifier' });
    }

    // Some OTHER file in the repo has an unresolvable dynamic import that
    // might target this file — we cannot rule it out.
    if (anyDynamicUnknown && !hasDynamicUnknown.has(fileId)) {
      hasUnknownCondition = true;
      node.evidence.push({ kind: 'dynamic-import', detail: 'repo contains a non-literal dynamic import that may target this file' });
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

function collectEntryPoints(
  repoPath: string,
  compilerOptions: ts.CompilerOptions,
): Map<string, EntryPointKind> {
  const pkgPath = path.join(repoPath, 'package.json');
  const result = new Map<string, EntryPointKind>();

  if (!fs.existsSync(pkgPath)) return result;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return result;
  }

  // Compute the outDir → rootDir remapping so "dist/lib.js" → "src/lib.ts".
  // ts.CompilerOptions stores paths as absolute strings; make them repo-relative.
  const repoNorm = normalisePath(repoPath);
  const rawOutDir = compilerOptions.outDir
    ? normalisePath(compilerOptions.outDir).replace(repoNorm + '/', '')
    : null;
  const rawRootDir = compilerOptions.rootDir
    ? normalisePath(compilerOptions.rootDir).replace(repoNorm + '/', '')
    : null;

  function addResolved(raw: string, kind: EntryPointKind): void {
    const stripped = raw.replace(/^\.\//, '');

    // Candidates to register: as-is (no-ext and with .js stripped), plus
    // outDir→rootDir remapped version with TS extensions.
    const candidates = new Set<string>();
    candidates.add(stripped);
    // Strip .js and add .ts/.tsx variants.
    const noJs = stripped.replace(/\.js$/, '');
    candidates.add(noJs);
    candidates.add(noJs + '.ts');
    candidates.add(noJs + '.tsx');

    // If the path starts with outDir, also register with rootDir prefix.
    if (rawOutDir && rawRootDir && stripped.startsWith(rawOutDir + '/')) {
      const rel = stripped.slice(rawOutDir.length + 1);
      const relNoJs = rel.replace(/\.js$/, '');
      candidates.add(rawRootDir + '/' + relNoJs + '.ts');
      candidates.add(rawRootDir + '/' + relNoJs + '.tsx');
      candidates.add(rawRootDir + '/' + relNoJs);
    }

    for (const c of candidates) {
      result.set(c, kind);
    }
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
 * Return the base filename without extension for use as a stub node name.
 * e.g. "src/index.ts" → "index", "src/features/darkMode.ts" → "darkMode"
 */
function fileBaseName(repoRelative: string): string {
  const base = repoRelative.split('/').pop() ?? repoRelative;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
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
