# AGENTS.md — Ask Mode

This file provides guidance to agents when working with code in this repository.

## Context for Answering Questions

- **Project is not yet implemented.** All architectural decisions live in `last-rites-plan.md`, not in source code.
- `last-rites-plan.md` is the single source of truth for task scope, type definitions, acceptance criteria, and Bobcoin budget.
- `docs/ibm-bob-2-hackathon-guide.md` is currently empty — the live guide is at the external URL in `hackathon-description.md`.
- The `demo/` directory (pinned snapshot of a small TypeScript library) does not exist yet; it is created in Task 1.
- `bob_sessions/` contains only a placeholder until development screenshots are added.

## Key Architectural Decisions Already Made

- TypeScript compiler API (`typescript` pkg) chosen over `ts-morph` — lighter, no extra abstraction layer.
- `diff` npm package chosen for patch generation — no shell-out to `git diff` or `diff` binary.
- `@inquirer/select` for interactive terminal UI — no heavy TUI frameworks.
- Explicit limitations (dynamic imports, barrel re-exports, `.d.ts` types, no test execution) are product features, not bugs.
