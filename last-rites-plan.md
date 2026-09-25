# Last Rites — Build Plan (v3) *(amended after Task 1)*

## Top-Level Overview

**Goal:** Deliver a working Last Rites prototype for the IBM Bob 2.0 Hackathon (deadline: September 27, 2026, 11:00 AM ET).

A developer pastes any public GitHub TypeScript repository URL into a web UI. The service clones the repo, statically analyses it using the TypeScript compiler API and explicit graph algorithms, and presents retirement candidates with an evidence trail and certainty classification. The developer selects a `candidate` (formerly called `safe` in earlier drafts), previews its removal, and downloads a reviewable unified diff patch. Verification compares TypeScript diagnostics before and after removal in an isolated in-process copy — new errors introduced by the removal are reported; pre-existing errors are ignored. The service never executes the submitted repo's build or test scripts. Checks that require running user scripts are reported as `unknown` in the output. No LLM is invoked at runtime.

**Scope:** TypeScript repositories only. Whole-file removal (candidate is the sole export of its file) is the supported path. Partial-file export stripping (symbol is one of several exports) is a stretch goal if budget permits.  
**Non-goals:** JavaScript-only repos, monorepos with multiple `tsconfig.json` files at distinct roots, dynamic `require()` calls, private repos, running any `npm run` script from a submitted repository on the public server.  
**Bob budget:** 40 Bobcoins. Estimated spend is tracked per task; actual spend is recorded after each task completes.

---

## Demo Repository

A purpose-built TypeScript app lives at `demo/` inside this repository. It is used **only** for development, integration tests, and the evaluation script — it is not a runtime gate or allowlist entry. Its structure:

```
demo/
  src/
    features/
      newDashboard.ts    ← sole export of its file; zero internal consumers → whole-file removal candidate
      legacyExport.ts    ← sole export of its file; zero internal consumers → whole-file removal candidate
      darkMode.ts        ← sole export of its file; consumed by index.ts → not a candidate
    utils/
      formatDate.ts      ← sole export of its file; consumed by darkMode, newDashboard, legacyExport → not a candidate
    index.ts             ← app entry: imports darkMode only
  package.json
  tsconfig.json
  vitest.config.ts
```

**Design rules:**
- `newDashboard.ts` imports `formatDate` and exports one function. Nothing in `demo/src/` imports `newDashboard`.
- `legacyExport.ts` imports `formatDate` and exports one function. Nothing in `demo/src/` imports `legacyExport`.
- `darkMode.ts` imports `formatDate` and exports one function. `index.ts` imports `darkMode`.
- `formatDate.ts` exports one function; it is imported by `darkMode`, `newDashboard`, and `legacyExport` — making it `unsafe` with `fanIn: 3`.
- `index.ts` is not itself a candidate.
- The demo has ≥ 4 passing `vitest` unit tests covering `darkMode` and `formatDate`.
- `newDashboard.ts` and `legacyExport.ts` are **unused modules** — they are never imported anywhere inside the demo. They exist solely as retirement candidates. The demo does **not** use feature flags.

This guarantees:
1. `newDashboard` and `legacyExport` are `candidate` whole-file entries exercising the primary removal path.
2. `darkMode` is `unsafe` (`fanIn: 1`), demonstrating correct classification.
3. `formatDate` is `unsafe` (`fanIn: 3`), demonstrating that shared dependencies are protected.
4. Removing `newDashboard` introduces zero *new* TypeScript errors (primary evaluation assertion: `delta.newErrors.length === 0`). The demo has no pre-existing errors, so `after.diagnosticCount === 0` also holds — but the authoritative assertion is the delta check.

---

## Explicit Limitations (surfaced in the product UI and report)

- **No user scripts executed.** The service never runs `npm run build`, `npm test`, or any other script from a submitted repository. Verification uses TypeScript diagnostics only.
- **Test results are `unknown`.** Whether removal breaks tests cannot be determined without running the test suite. This is reported explicitly in the output as an `unknownCheck`.
- **Build-tool checks are `unknown`.** Results from webpack, esbuild, rollup, etc. cannot be verified and are reported as `unknown`.
- Dynamic imports (`import(expr)`) where `expr` is not a string literal → `certainty: 'unknown'`.
- Barrel re-exports that reach the module boundary → `certainty: 'unknown'`.
- Ambient module declarations and `.d.ts`-only types → `certainty: 'unknown'`.
- Whole-file removal only in the initial build. Partial-file export stripping is a stretch goal.
- Private repos, repos requiring authentication, and repos exceeding 50 MB of TypeScript source are rejected at input.
- Passing TS diagnostics does not establish universal deletion safety — unknown external consumers remain undetected.

---

## Candidate Evidence Trail and Certainty Model

Every `ExportNode` carries:

```ts
// Implemented in src/types.ts — 'safe' was renamed 'candidate' after Task 1.
// Zero internal imports does NOT prove unused by external consumers.

type Certainty = 'candidate' | 'unknown' | 'unsafe';

interface ExportNode {
  id: string;
  file: string;            // repo-relative path
  name: string;
  kind: 'function' | 'class' | 'variable' | 'type' | 'interface' | 'enum' | 'namespace';
  fanIn: number;           // distinct internal importers
  fanOut: number;          // distinct internal imports (files this file imports)
  isSoleExport: boolean;   // true if this is the only export declaration in its file
  isEntryPoint: boolean;   // true if listed in package.json exports/main/module/bin
  certainty: Certainty;
  evidence: EvidenceItem[];
}

interface EvidenceItem {
  kind: 'no-internal-refs' | 'dynamic-import' | 'barrel-reexport' | 'dts-only' | 'entry-point' | 'internal-ref';
  detail: string;          // e.g. "imported by src/index.ts:4"
}
```

Classification rules (applied in order, first match wins):
1. `certainty: 'unsafe'` — `fanIn > 0`. Evidence lists each internal importer with file and line.
2. `certainty: 'unknown'` — `fanIn === 0` AND any of: dynamic import with non-literal specifier, barrel re-export reaching `node_modules` boundary, `.d.ts`-only declaration, `export default` (external callers untraceable by name), or file listed in a `package.json` entry-point field (`exports`, `main`, `module`, `bin`).
3. `certainty: 'candidate'` — `fanIn === 0` and none of the unknown conditions apply.

Only `candidate` entries with `isSoleExport: true` are offered the removal preview in this build (whole-file path). `candidate` entries where `isSoleExport: false` are displayed with a "Partial removal — stretch goal, not yet supported" label. `unknown` entries appear in a "Needs review" section. `unsafe` entries are hidden by default with a count toggle.

---

## Verification Model (no user scripts)

The rehearsal engine operates entirely in-process:

1. Copy the source tree to a temp directory using `fs-extra.copy`.
2. Delete the candidate's file from the copy.
3. Remove import statements referencing the deleted file from all other files in the copy (whole-file path only: all named imports from that module specifier are removed).
4. Create a new `ts.Program` over the modified copy and call `program.getSemanticDiagnostics()`.
5. Compare diagnostic count and error codes before (original tree) and after (modified copy).
6. Generate a unified diff between original and modified files using the `diff` npm package.

Checks that cannot be performed:
- `unknownCheck: 'test-suite'` — "Test results require running the repo's test runner, which is not executed on this server."
- `unknownCheck: 'build-tool'` — "Build tool output (webpack, esbuild, etc.) requires running the repo's build script, which is not executed on this server."
- `unknownCheck: 'runtime-behaviour'` — "Runtime behaviour after removal cannot be verified statically."

These `unknownChecks` are always included in the report regardless of diagnostic result.

---

## Measurable Evaluation — Developer Effort and Errors Avoided

Measured against removing `newDashboard` from the demo repo. Run by `scripts/evaluate.ts`.

| Dimension | Manual baseline | With Last Rites | Assertion in evaluate.ts |
|-----------|----------------|-----------------|--------------------------|
| Steps to identify all internal consumers | "Find All References" in IDE, inspect each hit — 5–8 manual steps for a small repo | 1 URL paste + 1 click: graph shows `fanIn: 0` with evidence | `node.fanIn === 0 && node.evidence.some(e => e.kind === 'no-internal-refs')` |
| Risk of leaving a broken import | Developer must manually track every `import { newDashboard }` site | Zero — rehearsal removes all import sites and confirms no new TS errors are introduced | `delta.newErrors.length === 0` |
| Risk of over-deleting a shared dependency | `formatDate` is also used by `darkMode`; easy to delete it too | Graph shows `formatDate.fanIn === 3`; it never appears as a candidate | `graph.nodes.get('formatDate').certainty === 'unsafe'` |
| Patch correctness | No reproducible verification | Diff generated from a diagnostics-clean sandbox | `patchText.length > 0` |
| Evidence provided to reviewer | None | Structured report: certainty, evidence items, before/after diagnostic counts, diff, unknownChecks listed | Report file exists; all fields non-empty |

All five assertions must pass for `npm run evaluate` to exit 0.

---

## Architecture

```
Web UI (Express + plain HTML/SSE)
  └─ POST /analyse  { url }
       └─ clone-repo          (git clone --depth 1; CloneResult)
            └─ analyse-repo   (ts.Program → ExportGraph; certainty + evidence)
                 └─ GET /graph?session=<id>
                      └─ POST /rehearse  { sessionId, candidateId }
                           └─ rehearse-removal  (in-process: copy tree, delete file,
                                                 remove imports, ts diagnostics before/after)
                                └─ report-writer  (report.md + removal.patch)
                                     └─ GET /report?session=<id>   (rendered HTML)
                                          └─ GET /report/patch?session=<id>  (download)
```

No route checks an allowlist. The `/rehearse` route accepts any session that has a completed `ExportGraph` and a valid `candidateId` with `certainty: 'candidate'` and `isSoleExport: true`.

---

## Sub-Tasks

---

### Task 1 — Project Scaffold, Type Contracts, and Demo App

**Status:** `[x] complete`
**Bobcoin estimate:** 4 | **Actual:** 4

**Intent:**
Bootstrap the Node.js / TypeScript project. Define and commit all shared type interfaces in `src/types.ts`. Build the demo app in `demo/`. This task's output — specifically `src/types.ts` — is the stable contract against which subagents for Tasks 2 and 4 are spawned.

**Expected Outcomes:**
- `package.json` with scripts: `build`, `lint`, `test`, `start`, `evaluate`.
- `tsconfig.json` targeting Node 20, `strict: true`, `outDir: dist`.
- ESLint + Prettier config committed.
- `vitest` installed; one smoke test passes.
- `src/types.ts` containing all shared types (full list below).
- `src/cli.ts` prints `Last Rites v0.1` and exits 0.
- `demo/` built per the Demo Repository spec: `newDashboard.ts`, `legacyExport.ts`, `darkMode.ts`, `formatDate.ts`, `index.ts`, own `package.json`, `tsconfig.json`, `vitest.config.ts`, ≥ 4 unit tests.
- `demo/npm run build` exits 0; `demo/npm test` reports ≥ 4 passing tests.
- `bob_sessions/README.md` placeholder committed.
- Root `README.md` updated with install and run instructions.

**Types committed to `src/types.ts` (see file for full JSDoc):**
```ts
// Amended from original plan — see "Certainty Model" section above for rationale.
type Certainty = 'candidate' | 'unknown' | 'unsafe';   // 'safe' renamed 'candidate'
type EvidenceKind = 'no-internal-refs'|'dynamic-import'|'barrel-reexport'|'dts-only'|'entry-point'|'internal-ref';
interface EvidenceItem { kind: EvidenceKind; detail: string; }
interface ExportNode { id: string; file: string; name: string; kind: ExportKind; fanIn: number; fanOut: number; isSoleExport: boolean; isEntryPoint: boolean; entryPointKind?: EntryPointKind; certainty: Certainty; evidence: EvidenceItem[]; }
interface ExportGraph { nodes: Map<string, ExportNode>; edges: Map<string, Set<string>>; }
type CloneError = 'INVALID_URL' | 'CLONE_FAILED' | 'SIZE_EXCEEDED';
type CloneResult = { ok: true; path: string } | { ok: false; error: CloneError };
interface TsError { code: number; message: string; file?: string; line?: number; }
type UnknownCheckKind = 'test-suite' | 'build-tool' | 'runtime-behaviour';
interface UnknownCheck { kind: UnknownCheckKind; reason: string; }
interface DiagnosticSnapshot { diagnosticCount: number; errors: TsError[]; }
interface DiagnosticDelta { newErrors: TsError[]; resolvedErrors: TsError[]; netChange: number; }
type RehearsalResult = { ok: true; before: DiagnosticSnapshot; after: DiagnosticSnapshot; delta: DiagnosticDelta; removedFiles: string[]; modifiedFiles: string[]; patchText: string; unknownChecks: UnknownCheck[]; } | { ok: false; error: string; }
interface SelectedCandidate { nodeId: string; file: string; name: string; }
```

**Todo List:**
1. `npm init -y`; add `typescript`, `ts-node`, `tsx`, `vitest`, `eslint`, `prettier`, `express`, `@types/express`, `fs-extra`, `@types/fs-extra`, `diff`, `@types/diff`.
2. Write `tsconfig.json` (Node 20, strict, `outDir: dist`, `rootDir: src`).
3. Write `eslint.config.js` and `.prettierrc`.
4. Write `src/types.ts` with all interfaces above — do not implement anything, types only.
5. Write `src/cli.ts` printing `Last Rites v0.1`.
6. Write `src/__tests__/smoke.test.ts` with one passing assertion.
7. Run `npm run build && npm test` — both pass.
8. Create `demo/` per spec; install its deps; run `cd demo && npm run build && npm test`.
9. Create `bob_sessions/README.md`; update root `README.md`.
10. Commit: `feat: scaffold, type contracts, and demo app`.

**Acceptance Check (all passed):**
```
npm run build           # exits 0 ✓
npm run lint            # exits 0 ✓
npm test                # 3 smoke tests pass ✓
node dist/cli.js        # prints "Last Rites v0.1" ✓
cd demo && npm install && npm run build && npm test  # 0 errors, 6 tests pass ✓
```

**Relevant Context:** Do not proceed to Task 2 or Task 3 until `src/types.ts` is committed and reviewed. Subagent prompts for Tasks 2 and 4 must include the verbatim content of `src/types.ts`.

---

### Task 2 — Repository Cloner  *(subagent-eligible after Task 1)*

**Status:** `[ ] pending`  
**Bobcoin estimate:** 2 | **Actual:** —

**Intent:**
Implement the module that accepts a public GitHub URL, validates it, shallow-clones it, enforces the size limit, and returns a typed result. No allowlist logic. Self-contained with mocked tests; can be implemented in parallel with Task 3.

**Subagent instructions:** Read `src/types.ts` before implementing. Use only types already defined there. Do not add new shared types.

**Expected Outcomes:**
- `src/clone-repo.ts` exporting `cloneRepo(url: string): Promise<CloneResult>`.
- `CloneResult` as defined in `src/types.ts`: `{ ok: true; path: string } | { ok: false; error: CloneError }`.
- Validates that `url` is a `https://github.com/` URL before cloning.
- Shallow clone: `git clone --depth 1 --filter=blob:none <url> <dest>` via `child_process.execFile`.
- Destination: `os.tmpdir()/last-rites-<sha256(url)>`.
- After clone: if total `.ts` file size > `MAX_TS_BYTES` (50 MB), delete dest dir and return `SIZE_EXCEEDED`.
- ≥ 4 unit tests with mocked `execFile`; no real network calls.

**Todo List:**
1. Read `src/types.ts`.
2. Write `src/clone-repo.ts`.
3. Write unit tests: valid URL success, invalid URL, clone failure, size exceeded.
4. `npm test` — all pass.

**Acceptance Check:**
```
npm test -- --reporter=verbose   # ≥4 clone-repo tests pass
```

---

### Task 3 — TypeScript Export Graph Builder with Certainty and Evidence

**Status:** `[ ] pending`  
**Bobcoin estimate:** 7 | **Actual:** —

**Intent:**
The core analysis step. Build an `ExportGraph` where every node carries its `isSoleExport` flag, certainty classification, and human-readable evidence trail. All later tasks consume this data structure.

**Expected Outcomes:**
- `src/analyse-repo.ts` exporting `buildGraph(repoPath: string): Promise<{ ok: true; graph: ExportGraph } | { ok: false; error: string }>`.
- Loads `tsconfig.json` from `repoPath` root using `ts.parseJsonConfigFileContent`.
- Creates a `ts.Program`; walks all source files within `rootDir`.
- For each source file: collects all top-level export declarations, builds `ExportNode` entries.
- `isSoleExport: true` when the file contains exactly one export declaration (the removal path is then whole-file deletion).
- Edges: for each import statement that resolves to an internal file (not `node_modules`), add a directed edge.
- `fanIn`: number of distinct internal files that import this file.
- `fanOut`: number of distinct internal files this file imports.
- Certainty rules applied as defined in the Certainty Model section.
- Each `EvidenceItem.detail` includes file and line: e.g. `"imported by src/index.ts:4"`.
- Dynamic import detection: walk import-call expressions; if the argument is not a string literal, mark all exports in that file `unknown`.
- Integration tests against `demo/`:
  - `newDashboard`: `certainty === 'candidate'`, `fanIn === 0`, `isSoleExport === true`.
  - `darkMode`: `certainty === 'unsafe'`, `fanIn === 1`, evidence detail references `index.ts`.
  - `formatDate`: `certainty === 'unsafe'`, `fanIn === 3`.

**Todo List:**
1. Move `typescript` to dependencies (from devDependencies).
2. Write `src/analyse-repo.ts`.
3. Implement edge building, fan counts, `isSoleExport`, evidence generation.
4. Apply certainty rules; detect dynamic imports.
5. Write integration tests against `demo/`.
6. `npm test` — all pass.

**Acceptance Check:**
```
npm test -- --reporter=verbose
# newDashboard.certainty === 'candidate' && newDashboard.isSoleExport === true
# darkMode.certainty === 'unsafe'
# formatDate.fanIn === 3
```

**Cannot verify without running:** Whether `ts.createProgram` loads the demo repo's `tsconfig.json` without host-overrides for `rootDir`. Confirmed by the integration test.

---

### Task 4 — Dependency View (Web UI)  *(subagent-eligible after Task 3)*

**Status:** `[ ] pending`  
**Bobcoin estimate:** 4 | **Actual:** —

**Intent:**
Build the web-facing dependency view: a JSON endpoint and a plain-HTML page rendering the candidate table with certainty badges, evidence expansion, and a "Preview removal" button for whole-file-eligible candidates. No frontend framework; no bundler.

**Subagent instructions:** Read `src/types.ts` before implementing. Endpoint is `GET /graph?session=<id>`. Frontend file is `public/graph.html`. Do not use React, Vue, or any bundler.

**Expected Outcomes:**
- `src/routes/graph.ts`: Express router, `GET /graph?session=<id>` returns `ExportGraph` serialised as `{ nodes: ExportNodeJson[]; edges: EdgeJson[] }`.
- `public/graph.html`: table with three sections — "Retirement candidates" (`candidate` + `isSoleExport: true`), "Needs review" (`unknown` or `candidate` + `isSoleExport: false`), "Has consumers" (`unsafe`, collapsed by default). Each row: name, file, kind, fan-in, certainty badge (green / amber / red), expandable evidence list.
- "Preview removal" button appears only on `candidate` + `isSoleExport: true` rows; POSTs `{ sessionId, candidateId }` to `/rehearse`.
- `candidate` + `isSoleExport: false` rows show label: "Partial removal not yet supported."
- No allowlist banner; no rehearsal restriction messaging.
- Unit test: given a mock `ExportGraph`, the `/graph` JSON response contains all nodes with correct `certainty` and `isSoleExport` values.

**Todo List:**
1. Read `src/types.ts` and Task 3 `ExportGraph` shape.
2. Write `src/routes/graph.ts`.
3. Write `public/graph.html` with inline CSS and vanilla JS.
4. Write route unit test.
5. `npm test` — passes.

**Acceptance Check:**
```
npm test -- --reporter=verbose   # graph route test passes
```
Manual smoke: run server locally, open `/graph.html`, confirm three sections render with correct badges.

**Relevant Context:** Session state is held in `src/session-store.ts` (`Map<string, SessionState>`). Write a stub `session-store.ts` in this task if it does not already exist; Task 6 will fill in the full `SessionState` type.

---

### Task 5 — Rehearsal Engine (In-Process TS Diagnostics, Whole-File Removal)

**Status:** `[ ] pending`  
**Bobcoin estimate:** 7 | **Actual:** —

**Intent:**
Implement the rehearsal engine. For a whole-file candidate: copy the source tree, delete the candidate's file, strip its import sites in other files using the TS compiler API, run `ts.Program.getSemanticDiagnostics()` before and after, generate a unified diff, and return the full result including fixed `unknownChecks`. No user scripts are executed.

**Expected Outcomes:**
- `src/rehearse-removal.ts` exporting `rehearseRemoval(repoPath: string, candidate: SelectedCandidate): Promise<RehearsalResult>`.
- Returns `{ ok: false; error: 'NOT_SOLE_EXPORT' }` if `candidate.isSoleExport` is false (not yet supported).
- Whole-file path:
  1. `fs-extra.copy` source tree to `os.tmpdir()/last-rites-sandbox-<uuid>`.
  2. Collect baseline diagnostics from a `ts.Program` over the original tree (in-process; no shell-out).
  3. Delete `<sandbox>/<candidate.file>`.
  4. Walk all other `.ts` files in the sandbox; for each, parse imports and remove any `import` statement whose module specifier resolves to the deleted file (entire import declaration removed, not just the specifier).
  5. Create a second `ts.Program` over the sandbox and collect diagnostics.
  6. Generate unified diff with the `diff` npm package between original files and sandbox files.
  7. Return `RehearsalResult` with `before`, `after`, `removedFiles`, `modifiedFiles`, `patchText`, and the three fixed `unknownChecks` (`test-suite`, `build-tool`, `runtime-behaviour`).
- Import-removal in step 4 uses the TypeScript compiler API (`ts.createSourceFile`, walk import declarations, filter, `ts.createPrinter`) — not string replacement.
- Integration test against `demo/`: remove `newDashboard`; assert `delta.newErrors.length === 0`, `patchText` includes `newDashboard`, `unknownChecks.length === 3`. (The demo has no pre-existing errors so `after.diagnosticCount === 0` also holds, but the authoritative assertion is the delta check.)
- Stretch goal (only if time/budget remain): partial-file removal for `isSoleExport: false` candidates — guarded behind `NOT_SOLE_EXPORT` until implemented.

**Todo List:**
1. Write `src/rehearse-removal.ts` with the whole-file path.
2. Implement sandbox copy, baseline diagnostics, file deletion, import-stripping transformer, post-removal diagnostics.
3. Generate unified diff; populate `unknownChecks` with the three fixed entries.
4. Write integration test.
5. `npm test` — all pass.

**Acceptance Check:**
```
npm test -- --reporter=verbose
# delta.newErrors.length === 0
# patchText includes 'newDashboard'
# unknownChecks.length === 3
# result.ok === true
```

**Cannot verify without running:** Whether the TS printer correctly emits the modified import lists without syntax errors — confirmed by `delta.newErrors.length === 0`.

---

### Task 6 — Express Server, CLI Integration, and Evaluation

**Status:** `[ ] pending`  
**Bobcoin estimate:** 5 | **Actual:** —

**Intent:**
Wire all modules into the Express server and `cli.ts`. Add the `/rehearse` route (no allowlist check), the `/report` render route, and the patch download endpoint. Write `scripts/evaluate.ts` asserting all five developer-effort dimensions.

**Expected Outcomes:**
- `src/session-store.ts`: `Map<string, SessionState>` where `SessionState = { cloneResult: CloneResult & { ok: true }; graph?: ExportGraph; rehearsal?: RehearsalResult & { ok: true }; }`.
- `src/server.ts`: Express app with routes:
  - `GET /` → `public/index.html` (URL input form)
  - `POST /analyse` `{ url }` → clones repo, builds graph, stores session, returns `{ sessionId }`
  - `GET /graph?session=<id>` → serialised `ExportGraph`
  - `POST /rehearse` `{ sessionId, candidateId }` → runs `rehearseRemoval`, stores result, returns `RehearsalResult`
  - `GET /report?session=<id>` → rendered HTML report page
  - `GET /report/patch?session=<id>` → `Content-Disposition: attachment; filename="removal.patch"` download
- `POST /rehearse` returns HTTP 400 with a plain-English message if `candidate.certainty !== 'candidate'` or `!candidate.isSoleExport`.
- `public/index.html`: URL input form with SSE or polling for progress during clone/analyse.
- `src/report-writer.ts`: generates an HTML report page and a `.patch` text string from `RehearsalResult`; includes the before/after diagnostic table and all three `unknownChecks` with their reasons.
- `cli.ts` updated: `--url <url> --select <candidateId>` flags; runs full pipeline and writes `report.html` + `removal.patch` to `./output/`.
- `scripts/evaluate.ts`: runs the pipeline against the demo repo, selects `newDashboard`, asserts all five evaluation dimensions, exits 0 on pass; writes `evaluation-results.md`.
- `render.yaml`: Render web service config, `npm run start`, Node 20, health check `GET /`.

**Todo List:**
1. Write `src/session-store.ts`.
2. Write `src/server.ts` with all routes.
3. Write `public/index.html`.
4. Write `src/report-writer.ts`.
5. Update `src/cli.ts`.
6. Write `scripts/evaluate.ts`; run `npm run evaluate`; confirm `evaluation-results.md` is written and all assertions pass.
7. Write `render.yaml`.
8. Commit: `feat: web server, CLI integration, and evaluation`.

**Acceptance Check:**
```
npm run build          # exits 0
npm test               # all tests pass
npm run evaluate       # evaluation-results.md written; exits 0
npm run start &        # server starts
curl localhost:3000/   # returns HTML
```

---

### Task 7 — Render Deployment and Submission Artefacts

**Status:** `[ ] pending`  
**Bobcoin estimate:** 4 | **Actual:** —

**Intent:**
Deploy the web service to Render, verify the full workflow end-to-end at the public URL, and prepare all hackathon submission artefacts (Bob session screenshots are captured manually).

**Note on Render cold starts:** The free tier sleeps after inactivity — 30–60 s to wake. Add a "Waking service…" spinner to `public/index.html` and document this in `SUBMISSION.md`.

**Note on Render sandbox:** Render's free web service allows `git clone` and temp-directory writes. If this proves false during deployment, the fallback is to embed the demo repo source as a bundled fixture and decline arbitrary URLs with a clear message.

**Expected Outcomes:**
- Service deployed; public URL returns `GET /` HTML.
- End-to-end at public URL: submit demo repo URL → dependency view renders → preview `newDashboard` removal → report page loads with non-empty patch → patch file downloads.
- `SUBMISSION.md` with all required fields: title, short description ≤ 500 words, long description ≤ 500 words, IBM Bob usage statement ≤ 500 words, Application URL, cover image note.
- `evaluation-results.md` committed (from Task 6).
- `bob_sessions/README.md` updated with instructions for adding screenshots.
- Repository public; no secrets in any committed file; `render.yaml` contains no credentials.

**Todo List:**
1. Push `render.yaml` to `main`; connect to Render; trigger deploy.
2. Confirm no environment variables are required (prototype uses no API keys).
3. Open public URL; run demo repo through full workflow; verify patch downloads.
4. Add cold-start spinner to `public/index.html`.
5. Draft `SUBMISSION.md`.
6. Run `npm run evaluate`; commit final `evaluation-results.md`.
7. Confirm repo is public; `git push origin main`.

**Acceptance Check:**
- Public URL returns the input form.
- Demo repo URL → dependency view → rehearse `newDashboard` → patch downloads correctly.
- `evaluation-results.md` committed; all assertions passing.
- `SUBMISSION.md` all fields populated.
- No secrets committed.

---

## Subagent Summary

| Task | Subagent? | Trigger | What subagent receives |
|------|-----------|---------|------------------------|
| Task 2 — Cloner | **Yes** | After Task 1 commits `src/types.ts` | Verbatim `src/types.ts` + task spec |
| Task 4 — Dependency View | **Yes** | After Task 3 commits `ExportGraph` shape | Verbatim `src/types.ts` + task spec |
| All other tasks | No | — | — |

Bob session screenshots are captured manually by the developer after each task.

---

## Bobcoin Budget

| Task | Estimated | Actual | Notes |
|------|-----------|--------|-------|
| Task 1 — Scaffold + Types + Demo App | 4 | — | |
| Task 2 — Cloner (subagent) | 2 | — | Simpler without allowlist logic |
| Task 3 — Graph Builder + Certainty | 7 | — | |
| Task 4 — Dependency View (subagent) | 4 | — | |
| Task 5 — Rehearsal (in-process, whole-file) | 7 | — | Simpler without user-script execution |
| Task 6 — Server + CLI + Evaluation | 5 | — | |
| Task 7 — Render Deploy + Submission | 4 | — | |
| Contingency | 7 | — | Increased; covers partial-file stretch goal |
| **Total** | **40** | **0** | |

*Update the Actual column after each task completes.*

---

## Dependency Order

```
Task 1 (Scaffold + Types + Demo App)
  ├─ Task 2 (Cloner) ← subagent, parallel with Task 3
  └─ Task 3 (Graph Builder)
        ├─ Task 4 (Dependency View) ← subagent, parallel with Task 5
        └─ Task 5 (Rehearsal Engine)
              └─ Task 6 (Server + CLI + Evaluation)
                    └─ Task 7 (Render Deploy + Submission)
```

Tasks 2 and 3 start after Task 1. Tasks 4 and 5 start after Task 3. Task 6 requires all of Tasks 2, 4, and 5.

---

## What Cannot Be Verified Without Running

1. Whether `ts.createProgram` loads the demo `tsconfig.json` without host overrides — confirmed by the Task 3 integration test.
2. Whether the TS printer emits syntactically correct files after import removal — confirmed by `delta.newErrors.length === 0` in the Task 5 integration test.
3. Whether Render allows `git clone` and temp-directory writes from a web service process — confirmed by Task 7 end-to-end test. Fallback: bundle demo repo as a fixture.
4. Exact Bobcoin cost per task — update Actual column as work completes.
