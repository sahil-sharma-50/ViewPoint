# Web app

This directory contains the Next.js interface for ViewPoint. `layout.tsx` loads the shared styles, and `page.tsx` accepts a public GitHub repository URL.

| Route | What it shows |
| --- | --- |
| `/architecture` | Source-backed system, flow, dependency, deployment, and state diagrams. |
| `/full-map` | Expandable folder clusters with known file and HTTP connections. |
| `/graph-view` | Searchable files, import relationships, and links to source on GitHub. |

`workspace.tsx` shares session loading, view navigation, warnings, and optional IBM Granite answers. The route pages use a `session` query parameter to request analysis results. Locally, `src/web-server.ts` sends page requests to Next.js and API requests to Express in `src/server.ts`. On Vercel, route handlers in this directory serve repository analysis, saved maps, optional explanations, and daily private session cleanup.
