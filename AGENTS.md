# AGENTS.md — Agent (Coding) Mode

This file provides guidance to agents when working with code in this repository.

## Project Status

**Task 1 complete.** Scaffold, type contracts, and demo fixture are committed.
`src/types.ts` is the stable contract for all subsequent tasks.

## Stack

- **Runtime:** Node.js 20, TypeScript 6 (strict mode, `module: Node16`)
- **Compiler API:** `typescript` package directly — NOT `ts-morph` (explicitly prohibited)
- **Test framework:** `vitest`
- **Linter:** ESLint 10 flat config (`eslint.config.js`) — `@eslint/js` + `typescript-eslint`
- **Formatter:** Prettier
- **CLI runner:** `tsx` for development, compiled `dist/` for production
- **Key deps:** `@inquirer/select`, `diff`, `fs-extra`, `express`

## Commands

```
npm run build      # tsc → dist/
npm run lint       # eslint src/
npm test           # vitest run (src/**/*.test.ts only)
npm test -- --reporter=verbose              # verbose output
npm test -- src/__tests__/<file>.test.ts    # single test file
npm run analyse    # tsx src/cli.ts (dev shortcut)
npm run evaluate   # tsx scripts/evaluate.ts (acceptance proof, Task 6+)
npm run start      # node dist/server.js (Task 6+)
```

## Architecture

```
CLI entry (src/cli.ts)
  └─ clone-repo.ts        → CloneResult discriminated union
       └─ analyse-repo.ts → ExportGraph (Map<id, ExportNode> + edges)
            └─ present-candidates.ts  (--select <id> for CI/tests)
                 └─ rehearse-removal.ts  (copy → strip imports → tsc diagnostics → diff)
                      └─ report-writer.ts → report.html + removal.patch
```

## Certainty Model (implemented in src/types.ts)

| Value | Meaning |
|-------|---------|
| `'candidate'` | `fanIn === 0`, no unknown conditions, not a declared entry point. Offered for removal preview. Zero internal imports does NOT prove unused by external consumers — human review is still required. |
| `'unknown'` | Cannot be confidently classified: dynamic import with non-literal specifier, barrel re-export reaching `node_modules`, `.d.ts`-only declaration, or file listed in `package.json` entry-point fields. Shown in "Needs review" section. |
| `'unsafe'` | `fanIn > 0`. Has at least one known internal consumer. Hidden by default with count toggle. |

**`'safe'` does not exist.** The plan originally used `'safe'`; the implemented types use `'candidate'` throughout. Do not introduce `'safe'` in any new code.

## Verification / Rehearsal Model

The rehearsal engine compares diagnostic counts **before and after** removal.
A repository may already have pre-existing TypeScript errors.
The acceptance criterion is **`delta.newErrors.length === 0`** — i.e. no *new* errors introduced — NOT `after.diagnosticCount === 0`.
`DiagnosticDelta` (defined in `src/types.ts`) carries `newErrors`, `resolvedErrors`, and `netChange`.

## Demo Fixture (`demo/`)

`demo/` is a purpose-built TypeScript app. It contains **unused feature modules** (`newDashboard.ts`, `legacyExport.ts`) that are never imported anywhere inside the demo — they exist to be retirement candidates for integration tests. It does **not** use feature flags.

```
demo/src/
  features/
    newDashboard.ts   ← unused module — fanIn: 0, isSoleExport: true → certainty: 'candidate'
    legacyExport.ts   ← unused module — fanIn: 0, isSoleExport: true → certainty: 'candidate'
    darkMode.ts       ← imported by index.ts → fanIn: 1, certainty: 'unsafe'
  utils/
    formatDate.ts     ← imported by all three features → fanIn: 3, certainty: 'unsafe'
  index.ts            ← app entry; imports darkMode only
```

Integration tests assert:
- `newDashboard.certainty === 'candidate'`, `fanIn === 0`, `isSoleExport === true`
- `darkMode.certainty === 'unsafe'`, `fanIn === 1`
- `formatDate.fanIn === 3`

## Non-Obvious Constraints

- **Discriminated unions over exceptions:** all public module functions return `Promise<{ ok: true; ... } | { ok: false; error: ErrorKind }>`.
- **No `ts-morph`:** use the `typescript` package compiler API directly (`ts.createProgram`, `ts.createPrinter`, `ts.visitEachChild`).
- **No string-replacement AST edits:** source mutations go through the TypeScript transformer/printer pipeline only.
- **Rehearsal sandboxing:** `rehearseRemoval` must copy the source tree to a fresh `os.tmpdir()` path before any mutation. Never write to the original clone path.
- **`typescript` in regular deps**, not devDeps — it is loaded at runtime to parse target repos.
- **`tsconfig.json`:** `strict: true`, `target: ES2022`, `module: Node16`, `outDir: dist`.
- **Entry-point protection:** files referenced by `package.json` `exports`, `main`, `module`, or `bin` must be classified `'unknown'`, never `'candidate'`.

## Test File Location

Test files live in `src/__tests__/` (same `src/` tree). Vitest discovers them automatically via `vitest.config.ts` (`include: ['src/**/*.test.ts']`). Running a single file:
```
npm test -- src/__tests__/<module>.test.ts
```

## Integration Test Seam

`presentCandidates` must accept a `--select <id>` option that bypasses the interactive prompt. All integration tests that exercise the full pipeline use this flag. Do not write tests that depend on stdin/TTY.

## Evaluation Script

`scripts/evaluate.ts` is the acceptance proof for Task 6. It must assert all five before/after metrics defined in `last-rites-plan.md`. Keep it deterministic: fix the demo repo URL and `--select` id as constants inside the script.

## Bob Subagent Guidance

Tasks 2 (Cloner) and 4 (Presenter) are subagent-eligible (self-contained, mocked tests).
Tasks 3, 5, 6 must run in the main context — they share/produce core types.
Task 7 (artefacts) is subagent-eligible after Task 6 completes.

## Hackathon Requirements

- `bob_sessions/` must contain ≥ 6 PNG screenshots of Bob task session summaries.
- `evaluation-results.md` (generated by `npm run evaluate`) must be committed.
- `SUBMISSION.md` with problem statement + IBM Bob usage statement (≤ 500 words each).
- Repository must be **public** with no IBM Cloud credentials in any committed file.
- Submission deadline: **September 27, 2026 at 11:00 AM ET**.
