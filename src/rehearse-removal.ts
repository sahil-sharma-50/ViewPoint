/**
 * src/rehearse-removal.ts — Rehearsal Engine (Task 5).
 *
 * For a whole-file sole-export candidate:
 *   1. Copy the source tree into a fresh os.tmpdir() sandbox.
 *   2. Collect baseline TypeScript semantic diagnostics (in-process, no shell-out).
 *   3. Delete the candidate file from the sandbox.
 *   4. Walk all remaining .ts files in the sandbox; remove every import declaration
 *      whose resolved specifier points to the deleted file (AST transformer, not
 *      string replacement).
 *   5. Collect post-removal diagnostics from a second ts.Program.
 *   6. Generate a unified diff with the `diff` package.
 *   7. Return RehearsalResult with before/after snapshots, DiagnosticDelta,
 *      removedFiles, modifiedFiles, patchText, and three fixed unknownChecks.
 *
 * The candidate is validated against graph.nodes — caller-supplied file paths
 * are never trusted; only the graph-stored node.file is used.
 *
 * Returns a discriminated union — never throws.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as fse from 'fs-extra';
import * as diff from 'diff';
import * as ts from 'typescript';
import type {
  ExportGraph,
  RehearsalResult,
  SelectedCandidate,
  DiagnosticSnapshot,
  DiagnosticDelta,
  TsError,
  UnknownCheck,
} from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function rehearseRemoval(
  repoPath: string,
  candidate: SelectedCandidate,
  graph: ExportGraph,
): Promise<RehearsalResult> {
  try {
    return await rehearseRemovalImpl(repoPath, candidate, graph);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

async function rehearseRemovalImpl(
  repoPath: string,
  candidate: SelectedCandidate,
  graph: ExportGraph,
): Promise<RehearsalResult> {
  // ── 1. Validate candidate against graph ───────────────────────────────────
  // Never trust the caller-supplied file path — resolve it from the graph node.
  const node = graph.nodes.get(candidate.nodeId);
  if (!node) {
    return { ok: false, error: `Candidate node "${candidate.nodeId}" not found in graph.` };
  }
  if (node.certainty !== 'candidate') {
    return { ok: false, error: `NOT_CANDIDATE: node "${candidate.nodeId}" has certainty "${node.certainty}", expected "candidate".` };
  }
  if (!node.isSoleExport) {
    return { ok: false, error: 'NOT_SOLE_EXPORT' };
  }

  // Use the graph-stored file path (repo-relative, forward-slash).
  const candidateRelFile = normalisePath(node.file);
  const repoRoot = fs.realpathSync(repoPath);
  const originalCandidate = path.resolve(repoRoot, candidateRelFile);
  const relativeCandidate = path.relative(repoRoot, originalCandidate);
  if (!relativeCandidate || relativeCandidate.startsWith('..') || path.isAbsolute(relativeCandidate)) {
    return { ok: false, error: 'Candidate file is outside the repository.' };
  }
  if (!fs.existsSync(originalCandidate) || !fs.statSync(originalCandidate).isFile()) {
    return { ok: false, error: 'Candidate file no longer exists.' };
  }
  if (path.relative(repoRoot, fs.realpathSync(originalCandidate)).startsWith('..')) {
    return { ok: false, error: 'Candidate file resolves outside the repository.' };
  }

  // ── 2. Load tsconfig from the original repo ────────────────────────────────
  const tsconfigPath = path.join(repoPath, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) {
    return { ok: false, error: `tsconfig.json not found at ${tsconfigPath}` };
  }

  const parsedConfig = loadTsConfig(repoPath);
  if (!parsedConfig.ok) {
    return { ok: false, error: parsedConfig.error };
  }

  // ── 3. Collect baseline diagnostics from the original tree ────────────────
  const before = collectDiagnostics(parsedConfig.fileNames, parsedConfig.options, repoPath);

  // ── 4. Copy source tree to sandbox ────────────────────────────────────────
  const sandboxId = crypto.randomUUID();
  const sandboxPath = path.join(os.tmpdir(), `last-rites-sandbox-${sandboxId}`);

  try {
    await fse.copy(repoPath, sandboxPath, {
      filter: (src) => {
        const parts = path.relative(repoPath, src).split(path.sep);
        return !fs.lstatSync(src).isSymbolicLink() && !parts.includes('node_modules') && !parts.includes('.git');
      },
    });

    // ── 5. Strip import declarations BEFORE deleting the candidate file ────
    // Resolution must happen while the file still exists in the sandbox.
    const sandboxConfig = loadTsConfig(sandboxPath);
    if (!sandboxConfig.ok) {
      return { ok: false, error: `Sandbox tsconfig parse error: ${sandboxConfig.error}` };
    }

    const modifiedFiles: string[] = [];
    const originalContents = new Map<string, string>(); // relPath → original text
    const modifiedContents = new Map<string, string>(); // relPath → stripped text

    for (const absFile of sandboxConfig.fileNames) {
      const normAbs = normalisePath(absFile);
      const relFile = toRepoRelative(normAbs, normalisePath(sandboxPath));

      // Skip the candidate file itself and non-TS files.
      if (relFile === candidateRelFile) continue;
      if (!normAbs.endsWith('.ts') && !normAbs.endsWith('.tsx')) continue;

      const originalText = fs.readFileSync(absFile, 'utf8');
      const strippedText = stripImportsOf(originalText, absFile, candidateRelFile, sandboxPath, sandboxConfig.options);

      if (strippedText !== originalText) {
        fs.writeFileSync(absFile, strippedText, 'utf8');
        modifiedFiles.push(relFile);
        originalContents.set(relFile, originalText);
        modifiedContents.set(relFile, strippedText);
      }
    }

    // ── 6. Delete the candidate file from the sandbox ─────────────────────
    const sandboxCandidateAbs = path.join(sandboxPath, candidateRelFile.replace(/\//g, path.sep));
    if (fs.existsSync(sandboxCandidateAbs)) {
      fs.unlinkSync(sandboxCandidateAbs);
    }

    // ── 7. Collect post-removal diagnostics from the sandbox ──────────────
    // Re-enumerate files now that the candidate is gone.
    const postConfig = loadTsConfig(sandboxPath);
    if (!postConfig.ok) {
      return { ok: false, error: `Post-removal tsconfig parse error: ${postConfig.error}` };
    }

    const after = collectDiagnostics(postConfig.fileNames, postConfig.options, sandboxPath, repoPath);

    // ── 8. Compute diagnostic delta ────────────────────────────────────────
    const delta = computeDelta(before, after);

    // ── 9. Generate unified diff ───────────────────────────────────────────
    const patchParts: string[] = [];

    // Patch for the removed file (empty after).
    if (fs.existsSync(originalCandidate)) {
      const removedOrigText = fs.readFileSync(originalCandidate, 'utf8');
      const removedPatch = diff.createTwoFilesPatch(
        `a/${candidateRelFile}`,
        '/dev/null',
        removedOrigText,
        '',
        '',
        '',
      );
      patchParts.push(removedPatch);
    }

    // Patches for modified files.
    for (const relFile of modifiedFiles) {
      const origText = originalContents.get(relFile) ?? '';
      const newText = modifiedContents.get(relFile) ?? '';
      const filePatch = diff.createTwoFilesPatch(
        `a/${relFile}`,
        `b/${relFile}`,
        origText,
        newText,
        '',
        '',
      );
      patchParts.push(filePatch);
    }

    const patchText = patchParts.join('');

    // ── 10. Fixed unknown checks ───────────────────────────────────────────
    const unknownChecks: UnknownCheck[] = [
      {
        kind: 'test-suite',
        reason: 'Static analysis cannot run the project\'s test suite. Run your test runner after this patch to confirm no tests break.',
      },
      {
        kind: 'build-tool',
        reason: 'Bundlers (webpack, vite, esbuild, etc.) may discover imports through non-standard mechanisms not visible to the TypeScript compiler. Verify the build still succeeds.',
      },
      {
        kind: 'runtime-behaviour',
        reason: 'Runtime dynamic behaviour (e.g. plugin loaders, eval, require() with variables) cannot be detected by static analysis. Confirm the application behaves correctly after removal.',
      },
    ];

    return {
      ok: true,
      before,
      after,
      delta,
      removedFiles: [candidateRelFile],
      modifiedFiles,
      patchText,
      unknownChecks,
    };
  } finally {
    // ── Cleanup: always remove the sandbox ────────────────────────────────
    try {
      await fse.remove(sandboxPath);
    } catch {
      // Best-effort cleanup — do not let cleanup failure mask the real result.
    }
  }
}

// ---------------------------------------------------------------------------
// Import-stripping transformer (AST-based, never string replacement)
// ---------------------------------------------------------------------------

/**
 * Parse `sourceText` as a TypeScript source file, remove any top-level
 * import declarations whose module specifier resolves to `targetRelFile`
 * (repo-relative, forward-slash), and return the modified source text.
 *
 * Uses the TypeScript transformer/printer pipeline — no string replacement.
 */
function stripImportsOf(
  sourceText: string,
  absoluteFilePath: string,
  targetRelFile: string,
  sandboxPath: string,
  compilerOptions: ts.CompilerOptions,
): string {
  const sf = ts.createSourceFile(
    absoluteFilePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    absoluteFilePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const sandboxNorm = normalisePath(sandboxPath);
  // Absolute (normalised) path to the deleted file in the sandbox.
  const targetAbs = `${sandboxNorm}/${targetRelFile}`;

  let changed = false;

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    return (sourceFile) => {
      const newStatements = sourceFile.statements.filter((stmt) => {
        if (!ts.isImportDeclaration(stmt)) return true;

        const modSpec = stmt.moduleSpecifier;
        if (!ts.isStringLiteral(modSpec)) return true;

        const specifier = modSpec.text;
        const resolved = resolveImport(specifier, absoluteFilePath, compilerOptions);
        if (!resolved) return true;

        const resolvedNorm = normalisePath(resolved);
        if (resolvedNorm === targetAbs) {
          changed = true;
          return false; // drop this import declaration
        }
        return true;
      });

      if (!changed) return sourceFile;

      return context.factory.updateSourceFile(sourceFile, newStatements);
    };
  };

  if (!changed) {
    // Quick pre-check: if no import resolved to the target, skip the transform.
    // We run a dry-check by scanning import specifiers without building the full transform.
    const hasMatch = sf.statements.some((stmt) => {
      if (!ts.isImportDeclaration(stmt)) return false;
      const modSpec = stmt.moduleSpecifier;
      if (!ts.isStringLiteral(modSpec)) return false;
      const resolved = resolveImport(modSpec.text, absoluteFilePath, compilerOptions);
      if (!resolved) return false;
      return normalisePath(resolved) === targetAbs;
    });
    if (!hasMatch) return sourceText;
  }

  const result = ts.transform(sf, [transformer]);
  const transformedSf = result.transformed[0];
  result.dispose();

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  return printer.printFile(transformedSf);
}

// ---------------------------------------------------------------------------
// TypeScript program helpers
// ---------------------------------------------------------------------------

type TsConfigResult =
  | { ok: true; fileNames: string[]; options: ts.CompilerOptions }
  | { ok: false; error: string };

function loadTsConfig(repoPath: string): TsConfigResult {
  const tsconfigPath = path.join(repoPath, 'tsconfig.json');
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    return { ok: false, error: ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n') };
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoPath);
  if (parsed.errors.length > 0) {
    return {
      ok: false,
      error: parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'),
    };
  }
  return { ok: true, fileNames: parsed.fileNames, options: parsed.options };
}

function collectDiagnostics(
  fileNames: string[],
  options: ts.CompilerOptions,
  rootPath: string,
  dependencyRoot?: string,
): DiagnosticSnapshot {
  const host = ts.createCompilerHost(options);
  if (dependencyRoot) {
    host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map((specifier) => {
      const inSandbox = ts.resolveModuleName(specifier, containingFile, options, host).resolvedModule;
      if (inSandbox || specifier.startsWith('.')) return inSandbox;

      // The sandbox omits node_modules. Resolve installed packages from the
      // original tree so a copy does not introduce unrelated missing-module errors.
      const relativeFile = path.relative(rootPath, containingFile);
      if (relativeFile.startsWith('..') || path.isAbsolute(relativeFile)) return undefined;
      const originalFile = path.join(dependencyRoot, relativeFile);
      const installedPackage = ts.resolveModuleName(specifier, originalFile, options, ts.sys).resolvedModule;
      return installedPackage?.isExternalLibraryImport ? installedPackage : undefined;
    });
  }
  const program = ts.createProgram({ rootNames: fileNames, options, host });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const errors: TsError[] = [];

  for (const d of diagnostics) {
    if (d.category !== ts.DiagnosticCategory.Error) continue;
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    let file: string | undefined;
    let line: number | undefined;
    if (d.file) {
      file = toRepoRelative(normalisePath(d.file.fileName), normalisePath(rootPath));
      if (d.start !== undefined) {
        const lc = d.file.getLineAndCharacterOfPosition(d.start);
        line = lc.line + 1; // 1-based
      }
    }
    errors.push({ code: d.code, message, file, line });
  }

  return { diagnosticCount: errors.length, errors };
}

function computeDelta(before: DiagnosticSnapshot, after: DiagnosticSnapshot): DiagnosticDelta {
  // Printer changes can shift line numbers in edited files. Match by file,
  // code, and message, preserving duplicate counts.
  const key = (e: TsError) => JSON.stringify([e.code, e.message, e.file]);
  const subtract = (left: TsError[], right: TsError[]) => {
    const counts = new Map<string, number>();
    for (const error of right) counts.set(key(error), (counts.get(key(error)) ?? 0) + 1);
    return left.filter((error) => {
      const remaining = counts.get(key(error)) ?? 0;
      if (!remaining) return true;
      counts.set(key(error), remaining - 1);
      return false;
    });
  };

  const newErrors = subtract(after.errors, before.errors);
  const resolvedErrors = subtract(before.errors, after.errors);
  const netChange = after.diagnosticCount - before.diagnosticCount;

  return { newErrors, resolvedErrors, netChange };
}

// ---------------------------------------------------------------------------
// Import resolution helper
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
// Path helpers
// ---------------------------------------------------------------------------

function normalisePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '');
}

function toRepoRelative(normAbs: string, normRoot: string): string {
  if (normAbs.startsWith(normRoot + '/')) {
    return normAbs.slice(normRoot.length + 1);
  }
  return normAbs;
}
