# AGENTS.md — Agent (Coding) Mode

This file provides guidance to agents when working with code in this repository.

## Pre-Scaffold State

No source files exist yet. When implementing any task, first check whether `package.json` exists before running `npm` commands.

## Strict Coding Conventions (from plan)

- **Return discriminated unions, never throw:** all public module functions return `Promise<{ ok: true; ... } | { ok: false; error: ErrorKind }>`.
- **No `ts-morph`:** use the `typescript` package compiler API directly (`ts.createProgram`, `ts.createPrinter`, `ts.visitEachChild`).
- **No string-replacement AST edits:** source mutations go through the TypeScript transformer/printer pipeline only.
- **Rehearsal sandboxing:** `rehearseRemoval` must copy the source tree to a fresh `os.tmpdir()` path before any mutation. Never write to the original clone path.
- **`typescript` in regular deps**, not devDeps — it is loaded at runtime to parse target repos.
- **`tsconfig.json`:** `strict: true`, `target: ES2022`, `module: Node16` (or `NodeNext`), `outDir: dist`.

## Test File Location

Test files live in `src/__tests__/` (same `src/` tree). Vitest discovers them automatically. Running a single file:
```
npm test -- src/__tests__/<module>.test.ts
```

## Integration Test Seam

`presentCandidates` must accept a `--select <id>` option that bypasses the interactive prompt. All integration tests that exercise the full pipeline use this flag. Do not write tests that depend on stdin/TTY.

## Evaluation Script

`scripts/evaluate.ts` is the acceptance proof for Task 6. It must assert all five before/after metrics defined in `last-rites-plan.md`. Keep it deterministic: fix the demo repo URL and `--select` id as constants inside the script.
