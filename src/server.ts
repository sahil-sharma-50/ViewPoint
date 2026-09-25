/**
 * src/server.ts — Last Rites HTTP server (Task 4).
 *
 * Routes:
 *   GET /              → interactive dependency-map UI (HTML)
 *   GET /api/graph     → serialised ExportGraph as JSON
 *   POST /api/graph    → { repoPath } → build and return graph JSON
 *
 * The graph is serialised with edges as { source: file, targets: file[] }
 * so that the browser can map them to nodes via node.file.
 */

import express from 'express';
import * as path from 'node:path';
import * as url from 'node:url';
import { buildGraph } from './analyse-repo.js';
import { renderGraphPage } from './graph-view.js';
import type { ExportGraph } from './types.js';

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

export interface SerialNode {
  id: string;
  file: string;
  name: string;
  kind: string;
  fanIn: number;
  fanOut: number;
  isSoleExport: boolean;
  isEntryPoint: boolean;
  entryPointKind?: string;
  certainty: string;
  evidence: { kind: string; detail: string }[];
}

export interface SerialEdge {
  /** Repo-relative file path of the importer */
  source: string;
  /** Repo-relative file paths of all files this source imports */
  targets: string[];
}

export interface SerialGraph {
  nodes: SerialNode[];
  edges: SerialEdge[];
}

/** Convert an ExportGraph (with Maps/Sets) to a plain JSON-safe object. */
export function serialiseGraph(graph: ExportGraph): SerialGraph {
  // Build a reverse lookup: absFileId → repo-relative file path.
  // Edges keys are absolute file IDs; nodes carry repo-relative paths.
  // We derive the repo-relative path from nodes keyed by the same file.
  const absToRel = new Map<string, string>();
  for (const node of graph.nodes.values()) {
    // node.id is "relFile#name"; node.file is the repo-relative path.
    // We need the absolute key that edges use.  The edges map uses the same
    // string that buildGraph stores — which is the absolute normalised path.
    // We reconstruct it from node.file by checking which edge key ends with
    // the repo-relative file.  However, to avoid O(n²) scanning we instead
    // build a set of all distinct node.file values and later match edge
    // source keys by suffix.  We record them separately below.
    absToRel.set(node.file, node.file); // identity entry for rel → rel
  }

  // Collect all distinct repo-relative file values from nodes.
  const relFiles = new Set<string>();
  for (const node of graph.nodes.values()) {
    relFiles.add(node.file);
  }

  // Map edge keys (absolute paths) to repo-relative paths by matching suffix.
  const edgeKeyToRel = new Map<string, string>();
  for (const edgeKey of graph.edges.keys()) {
    // edgeKey may be absolute (e.g. /tmp/repo/src/foo.ts) or relative.
    // Match by finding which relFile the edgeKey ends with.
    for (const rel of relFiles) {
      if (edgeKey === rel || edgeKey.endsWith('/' + rel) || edgeKey.endsWith('\\' + rel)) {
        edgeKeyToRel.set(edgeKey, rel);
        break;
      }
    }
  }

  const edges: SerialEdge[] = [];
  for (const [source, targetSet] of graph.edges) {
    const sourceRel = edgeKeyToRel.get(source);
    if (!sourceRel) continue; // skip edge keys that don't map to a known file

    const targets: string[] = [];
    for (const target of targetSet) {
      const targetRel = edgeKeyToRel.get(target);
      if (targetRel) targets.push(targetRel);
    }
    if (targets.length > 0) {
      edges.push({ source: sourceRel, targets });
    }
  }

  const nodes: SerialNode[] = Array.from(graph.nodes.values()).map((n) => ({
    id: n.id,
    file: n.file,
    name: n.name,
    kind: n.kind,
    fanIn: n.fanIn,
    fanOut: n.fanOut,
    isSoleExport: n.isSoleExport,
    isEntryPoint: n.isEntryPoint,
    entryPointKind: n.entryPointKind,
    certainty: n.certainty,
    evidence: n.evidence,
  }));

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Express application
// ---------------------------------------------------------------------------

export function createApp(demoGraph: ExportGraph): express.Application {
  const app = express();
  app.use(express.json());

  // Serve the interactive dependency-map UI.
  app.get('/', (_req, res) => {
    const html = renderGraphPage(serialiseGraph(demoGraph));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  // GET /api/graph — return the pre-built demo graph.
  app.get('/api/graph', (_req, res) => {
    res.json(serialiseGraph(demoGraph));
  });

  // POST /api/graph — build a graph for a given repoPath.
  app.post('/api/graph', async (req, res) => {
    const { repoPath } = req.body as { repoPath?: unknown };
    if (typeof repoPath !== 'string' || !repoPath.trim()) {
      res.status(400).json({ ok: false, error: 'repoPath is required' });
      return;
    }
    const result = await buildGraph(repoPath.trim());
    if (!result.ok) {
      res.status(422).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true, graph: serialiseGraph(result.graph) });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Start server (only when this module is the entry point)
// ---------------------------------------------------------------------------

const __filename = url.fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith('server.js')) {
  const DEMO_PATH = path.resolve(path.dirname(__filename), '..', 'demo');
  buildGraph(DEMO_PATH).then((result) => {
    if (!result.ok) {
      console.error('Failed to build demo graph:', result.error);
      process.exit(1);
    }
    const PORT = Number(process.env['PORT'] ?? 3000);
    const app = createApp(result.graph);
    app.listen(PORT, () => {
      console.log(`Last Rites server running on http://localhost:${PORT}`);
    });
  });
}
