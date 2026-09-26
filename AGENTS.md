# AGENTS.md — Repository guidance

ViewPoint maps public repositories for developer onboarding. The product has three views: system Architecture, folder Full Map, and Files.

## Stack

- Node.js 20.9+, TypeScript 6, Next.js App Router, React, Express, Vitest, ESLint, Prettier.
- `src/web-server.ts` serves Next.js and the Express API in one process.
- Vercel uses Next.js route handlers, `src/vercel-repo.ts` for bounded GitHub archive analysis, and `src/vercel-session.ts` with private Blob sessions. `vercel.json` selects Next.js and schedules session cleanup.
- Use the `typescript` compiler API directly for JavaScript and TypeScript parsing; do not add `ts-morph`.
- Python uses `ast`; Go and Java use tree-sitter for connection scanning.

## Local setup

- Install Node.js 20.9+ and Git, then run `npm ci` from the repository root.
- Run `npm run dev` and open `http://localhost:3000`. Enter a public GitHub URL or `owner/repository`; there is no bundled demo repository.
- Python 3 enables Python imports. Go and Java additionally need `tree-sitter==0.26.0`, `tree-sitter-go==0.25.0`, and `tree-sitter-java==0.23.5`. The root README gives the install commands.
- Source maps work without IBM credentials. For optional explanations, copy `.env.example` to `.env` and set `WATSONX_API_ENDPOINT`, `WATSONX_PROJECT_ID`, and `WATSONX_API_KEY` on the server. Never expose these values with `NEXT_PUBLIC_` or commit `.env`.
- For the current local production process, run `npm run build` then `npm run start`. `PORT`, `VIEWPOINT_MAX_REPO_MB`, and `VIEWPOINT_MAX_FILES` are optional server environment variables.
- The public deployment is `https://viewpoint-bob.vercel.app/`. A separate Vercel deployment needs a private Blob store, its `BLOB_READ_WRITE_TOKEN`, and a production `CRON_SECRET`. Optional IBM credentials belong in Sensitive server-side Vercel variables. See the root README for deployment steps and Vercel limits.

## Commands

```bash
npm run dev
npm run build
npm run lint
npm test
npm run start
```

## Flow

`clone-repo.ts` creates a temporary checkout. `analyse-repo.ts` inventories visible files and records known import edges in `ExportGraph`. `architecture.ts` adds source backed component, route, and HTTP facts in a separate worker. `server.ts` serves the graph immediately; Architecture is prepared independently. `app/architecture/`, `app/full-map/`, and `app/graph-view/` render the three views. `watsonx.ts` is used only for user requested explanations.

On Vercel, `/analyse` builds the file graph and Architecture from a bounded public GitHub archive, saves the result in private Blob storage, and returns a session ID. `/api/workspace` loads that map; `/api/map-explain` calls Granite only after a user asks. The daily `/api/cleanup` route deletes expired sessions.

`src/types.ts` defines file nodes and import edges. Edges point from an importing file to the file it imports. Include test imports because onboarding requires a complete connection map. Keep repository analysis read-only.

## Verification

Tests live in `src/__tests__/`. Run `npm test`, `npm run lint`, and `npm run build`. The live GitHub clone test runs only when `VIEWPOINT_INTEGRATION=1` is set.

## Hackathon materials

- Keep at least six IBM Bob task screenshots in `bob_sessions/`; its README identifies the early prototype tasks separately from the current product.
- The repository must be public and must not commit IBM Cloud credentials.
- Submission deadline: September 27, 2026 at 11:00 AM ET.
