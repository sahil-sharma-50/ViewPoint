/**
 * src/types.ts — Shared type contracts for Last Rites.
 *
 * Certainty model:
 *   'candidate' — fanIn === 0 AND no unknown conditions AND NOT a declared entry point.
 *                 Zero internal imports does NOT prove unused by external consumers;
 *                 the label 'candidate' conveys that human review is still required.
 *   'unknown'   — fanIn === 0 AND at least one condition prevents confident classification:
 *                 dynamic import with non-literal specifier, barrel re-export reaching
 *                 node_modules boundary, .d.ts-only declaration, or unresolved dynamic use.
 *   'unsafe'    — fanIn > 0. File has at least one known internal consumer.
 *
 * Entry-point protection:
 *   Files listed in package.json "exports", "main", "module", or "bin" fields are marked
 *   isEntryPoint: true and never classified as 'candidate' — they are always 'unknown'
 *   because external callers are undetectable by internal-graph analysis alone.
 */

// ---------------------------------------------------------------------------
// Certainty
// ---------------------------------------------------------------------------

/**
 * 'candidate' (formerly 'safe' in the plan) — fanIn === 0, no unknown conditions,
 * not a declared entry point. Still requires human review before deletion because
 * external consumers are invisible to the internal import graph.
 *
 * 'unknown'   — cannot be confidently classified; surface in "Needs review" UI section.
 * 'unsafe'    — has ≥ 1 known internal consumer; hide by default.
 */
export type Certainty = 'candidate' | 'unknown' | 'unsafe';

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export type EvidenceKind =
  | 'no-internal-refs'   // fanIn === 0; zero internal import sites found
  | 'dynamic-import'     // import(expr) where expr is not a string literal → unknown
  | 'barrel-reexport'    // re-exports that may cross the node_modules boundary → unknown
  | 'dts-only'           // .d.ts-only declaration → unknown
  | 'entry-point'        // declared in package.json exports/main/bin → unknown
  | 'internal-ref';      // this file IS imported internally (unsafe)

export interface EvidenceItem {
  kind: EvidenceKind;
  /** Human-readable detail, e.g. "imported by src/index.ts:4" */
  detail: string;
}

// ---------------------------------------------------------------------------
// Export graph nodes and edges
// ---------------------------------------------------------------------------

export type ExportKind =
  | 'function'
  | 'class'
  | 'variable'
  | 'type'
  | 'interface'
  | 'enum'
  | 'namespace';

/** The kind of package.json field that declares this file as an entry point. */
export type EntryPointKind = 'exports' | 'main' | 'module' | 'bin';

export interface ExportNode {
  id: string;
  /** Repo-relative path, e.g. "src/features/newDashboard.ts" */
  file: string;
  name: string;
  kind: ExportKind;
  /** Number of distinct internal files that import this file. */
  fanIn: number;
  /** Number of distinct internal files this file imports. */
  fanOut: number;
  /** True when this is the only export declaration in its file (whole-file removal path). */
  isSoleExport: boolean;
  /**
   * True when the file is referenced by a package.json entry-point field.
   * Such files are always classified 'unknown' regardless of fanIn.
   */
  isEntryPoint: boolean;
  /** Set when isEntryPoint is true; undefined otherwise. */
  entryPointKind?: EntryPointKind;
  certainty: Certainty;
  evidence: EvidenceItem[];
}

/** Directed import graph: edges[A] = Set of file IDs that A imports. */
export interface ExportGraph {
  nodes: Map<string, ExportNode>;
  /** edges[fileId] = set of fileIds that fileId imports */
  edges: Map<string, Set<string>>;
}

// ---------------------------------------------------------------------------
// Clone result
// ---------------------------------------------------------------------------

export type CloneError = 'INVALID_URL' | 'CLONE_FAILED' | 'SIZE_EXCEEDED';

export type CloneResult =
  | { ok: true; path: string }
  | { ok: false; error: CloneError };

// ---------------------------------------------------------------------------
// TypeScript diagnostic snapshot
// ---------------------------------------------------------------------------

export interface TsError {
  code: number;
  message: string;
  file?: string;
  line?: number;
}

export interface DiagnosticSnapshot {
  diagnosticCount: number;
  errors: TsError[];
}

// ---------------------------------------------------------------------------
// Unknown checks (things we cannot verify without running user scripts)
// ---------------------------------------------------------------------------

export type UnknownCheckKind = 'test-suite' | 'build-tool' | 'runtime-behaviour';

export interface UnknownCheck {
  kind: UnknownCheckKind;
  reason: string;
}

// ---------------------------------------------------------------------------
// Rehearsal result
//
// Verification model: compare diagnostics BEFORE and AFTER removal.
// A repository may already have pre-existing TypeScript errors.
// The rehearsal engine reports the DELTA (newErrors = after - before errors).
// Acceptance criterion is newErrors.length === 0, NOT after.diagnosticCount === 0.
// ---------------------------------------------------------------------------

/** New errors introduced by the removal (not present in the before snapshot). */
export interface DiagnosticDelta {
  /** Errors present after removal that were NOT in the before snapshot. */
  newErrors: TsError[];
  /** Errors resolved by the removal (present before, gone after). */
  resolvedErrors: TsError[];
  /** Net change: after.diagnosticCount - before.diagnosticCount */
  netChange: number;
}

export type RehearsalResult =
  | {
      ok: true;
      before: DiagnosticSnapshot;
      after: DiagnosticSnapshot;
      delta: DiagnosticDelta;
      removedFiles: string[];
      modifiedFiles: string[];
      patchText: string;
      unknownChecks: UnknownCheck[];
    }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Selected candidate (CLI / POST /rehearse payload)
// ---------------------------------------------------------------------------

export interface SelectedCandidate {
  nodeId: string;
  file: string;
  name: string;
}
