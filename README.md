# Last Rites

> A controlled demolition simulator for TypeScript codebases.

Last Rites statically analyses a public GitHub TypeScript repository, identifies retirement candidates (exports with no known internal consumers), previews whole-file removal using in-process TypeScript diagnostics, and produces a reviewable unified diff patch — without executing any user scripts.

Built for the IBM Bob 2.0 Hackathon.

---

## Quick start

### Prerequisites

- Node.js 20+
- Git (for cloning target repositories)

### Install

```bash
npm install
```

### Build

```bash
npm run build        # compiles src/ → dist/
```

### Run CLI

```bash
node dist/cli.js                         # prints "Last Rites v0.1"
npm run analyse -- --url <github-url>    # full pipeline (Task 6+)
```

### Run tests

```bash
npm test             # vitest — root project tests
```

### Run evaluation (Task 6+)

```bash
npm run evaluate     # runs pipeline against demo/, writes evaluation-results.md
```

### Start web server (Task 6+)

```bash
npm run start        # Express server on http://localhost:3000
```

---

## Demo fixture

`demo/` contains a purpose-built TypeScript app used for integration tests and the evaluation script.

```
demo/src/
  features/
    newDashboard.ts   ← candidate (fanIn: 0, isSoleExport: true)
    legacyExport.ts   ← candidate (fanIn: 0, isSoleExport: true)
    darkMode.ts       ← unsafe   (fanIn: 1, imported by index.ts)
  utils/
    formatDate.ts     ← unsafe   (fanIn: 3, imported by all three features)
  index.ts            ← app entry point
```

```bash
cd demo
npm install
npm run build    # tsc --noEmit → 0 errors
npm test         # vitest → ≥ 6 tests pass
```

---

## Certainty model

| Label | Meaning |
|-------|---------|
| `candidate` | fanIn === 0, no unknown conditions, not a declared entry point. **Still requires human review** — external consumers are invisible to the internal import graph. |
| `unknown` | Cannot be confidently classified (dynamic import, barrel re-export, .d.ts-only, or declared entry point). |
| `unsafe` | fanIn > 0. Has at least one known internal consumer. |

---

## Architecture

```
CLI / Web UI
  └─ clone-repo        → CloneResult
       └─ analyse-repo → ExportGraph (nodes + edges + certainty + evidence)
            └─ rehearse-removal → RehearsalResult (before/after diagnostics + delta + patch)
                 └─ report-writer → report.html + removal.patch
```

---

## Limitations

- TypeScript repositories only (`tsconfig.json` must exist at root).
- Whole-file removal only (partial export stripping is a stretch goal).
- No user scripts executed — verification uses TypeScript diagnostics only.
- Test results, build-tool results, and runtime behaviour are always `unknown`.
- Repos exceeding 50 MB of TypeScript source are rejected.
- Dynamic imports with non-literal specifiers → `unknown` classification.

---

## Hackathon submission

See [`SUBMISSION.md`](SUBMISSION.md) (Task 7).
