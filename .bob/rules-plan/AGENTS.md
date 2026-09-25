# AGENTS.md — Plan Mode

This file provides guidance to agents when working with code in this repository.

## Planning Constraints

- **Bobcoin budget: 40 total.** Each task is sized ≤ 4–9 coins. Check `last-rites-plan.md` for current estimates before proposing new work.
- **Dependency order is strict:** Task 3 (Graph Builder) must complete before Task 4 (Presenter) or Task 5 (Rehearsal) begin. Task 5 must complete before Task 6. Tasks 2 and 4 can be parallelised as subagents once Task 1 commits the type skeleton.
- **`ExportGraph` is the central data contract.** Any change to `ExportNode` or `ExportGraph` types propagates to all downstream modules. Lock the shape in Task 1's type skeleton before delegating Tasks 2/4 to subagents.

## Architectural Non-Negotiables

- All modules are **pure functions over `ExportGraph`** — no module holds internal state between calls.
- The rehearsal sandbox must never mutate the original clone directory — this is a correctness constraint, not a style preference.
- `tsc --noEmit` is the sole pass/fail gate; test execution in the sandbox is explicitly out of scope.

## Evaluation as Acceptance Gate

All five metrics in `last-rites-plan.md §Measurable Before/After Evaluation` must pass before Task 6 can be marked complete. Plan for the evaluation script (`scripts/evaluate.ts`) to be written alongside the CLI wiring, not after.

## Known Unknowns (verify at runtime)

1. `ts.createProgram` `paths` alias resolution in target repos — may require extra `moduleResolution` config.
2. TypeScript printer whitespace after single-export removal — may need cosmetic post-processing.
3. Free deployment host compatibility with Node 20 + temp-dir write access for cloning.
