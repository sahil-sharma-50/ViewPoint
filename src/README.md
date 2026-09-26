# Repository analysis and API

`web-server.ts` starts Next.js and the Express API in one local process. `server.ts` accepts a public GitHub URL, tracks analysis sessions, and serves graph and architecture data to the views in `app/`.

The analysis flow is:

1. `clone-repo.ts` creates a temporary checkout of the public repository.
2. `repo-files.ts` inventories its files. `analyse-repo.ts` builds the file graph defined in `types.ts`, including imports from tests. `python-adapter.ts` and `helpers/` scan Python, Go, and Java connections.
3. `analysis-worker.ts` runs graph and architecture work outside the HTTP thread. `architecture.ts` records source-backed components, routes, HTTP calls, and other diagram facts.
4. `full-map.ts` and `folder-layout.ts` prepare folder relationships. `session-store.ts` keeps results available by session ID and expires temporary checkouts.

`watsonx.ts` and `map-explain.ts` provide optional explanations only when a user asks. Tests are in `__tests__/`. Run the checks from the repository root with `npm test`, `npm run lint`, and `npm run build` after installing dependencies.

Vercel uses `vercel-repo.ts` to download and analyze a bounded public GitHub archive in one request. `vercel-session.ts` stores compressed maps in a private Vercel Blob store for 24 hours; Next.js API routes in `app/` serve the saved map and optional IBM explanations. The local Express flow above remains the default for `npm run dev` and `npm start`.
