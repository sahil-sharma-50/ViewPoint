# ViewPoint — Coding guidance

Follow the repository's root `AGENTS.md`. ViewPoint maps public GitHub repositories for developer onboarding.

- Keep repository analysis read-only. `clone-repo.ts` creates a temporary checkout; the app never edits repository source.
- Use the TypeScript compiler API for JavaScript and TypeScript connections. Python uses `ast`; Go and Java use tree-sitter.
- Preserve importer-to-imported edge direction and include imports from tests.
- Keep tests in `src/__tests__/`. Verify changes with `npm test`, `npm run lint`, and `npm run build` after dependencies are installed.
