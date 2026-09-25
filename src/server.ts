/**
 * src/server.ts — Last Rites HTTP server (Tasks 4 + 6).
 *
 * Routes:
 *   GET  /                       → public/index.html (URL input form)
 *   POST /analyse   { url }      → clones repo, builds graph, returns { sessionId }
 *   GET  /graph?session=<id>     → serialised ExportGraph for a session
 *   POST /rehearse  { sessionId, candidateId }
 *                                → runs rehearseRemoval, returns RehearsalResult
 *   GET  /report?session=<id>    → rendered HTML report page
 *   GET  /report/patch?session=<id>
 *                                → attachment download of removal.patch
 *   GET  /api/graph              → demo graph (backward-compat for existing tests)
 *
 * The server NEVER accepts a client-supplied filesystem path.
 * Session state (repoPath, graph, rehearsal) lives server-side under a UUID.
 */

import express from 'express';
import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';
import { cloneRepo, isValidGitHubUrl } from './clone-repo.js';
import { buildGraph } from './analyse-repo.js';
import { rehearseRemoval } from './rehearse-removal.js';
import { renderGraphPage } from './graph-view.js';
import { generateReport } from './report-writer.js';
import { createSession, getSession, updateSession } from './session-store.js';
import type { ExportGraph } from './types.js';

// ---------------------------------------------------------------------------
// Serialisation helpers (unchanged from Task 4 — existing tests depend on them)
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
// Express application factory
// ---------------------------------------------------------------------------

export function createApp(demoGraph: ExportGraph, clone: typeof cloneRepo = cloneRepo): express.Application {
  const app = express();
  app.use(express.json());

  const __filename = url.fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(__filename), '..');
  const publicDir = path.join(projectRoot, 'public');

  // ── GET / ─────────────────────────────────────────────────────────────────
  // Serve the URL input form.  Falls back to a minimal inline form if the
  // public/ directory hasn't been built yet (e.g. during unit tests).
  app.get('/', (_req, res) => {
    const indexPath = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.sendFile(indexPath);
    } else {
      // Fallback: render the demo graph as the old Task 4 view.
      const html = renderGraphPage(serialiseGraph(demoGraph));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    }
  });

  // ── POST /analyse ─────────────────────────────────────────────────────────
  // Accepts: { url: string }
  // Returns: { sessionId: string }  or  HTTP 400 with { error: string }
  app.post('/analyse', async (req, res) => {
    const body = req.body as { url?: unknown };
    const repoUrl = typeof body.url === 'string' ? body.url.trim() : '';

    if (!repoUrl) {
      res.status(400).json({ error: 'Missing "url" field.' });
      return;
    }
    if (!isValidGitHubUrl(repoUrl)) {
      res.status(400).json({
        error:
          'Invalid GitHub URL. Supply a public HTTPS URL in the form ' +
          'https://github.com/<owner>/<repo>.',
      });
      return;
    }

    // Clone
    const cloneResult = await clone(repoUrl);
    if (!cloneResult.ok) {
      const msgs: Record<string, string> = {
        INVALID_URL: 'Invalid GitHub URL.',
        CLONE_FAILED: 'Failed to clone the repository. Check that the URL is public and accessible.',
        SIZE_EXCEEDED: 'Repository TypeScript source exceeds the 50 MB limit.',
      };
      res.status(400).json({ error: msgs[cloneResult.error] ?? cloneResult.error });
      return;
    }

    const graphResult = await buildGraph(cloneResult.path);
    if (!graphResult.ok || graphResult.graph.nodes.size === 0) {
      await fs.promises.rm(cloneResult.path, { recursive: true, force: true });
      res.status(400).json({ error: graphResult.ok
        ? 'No TypeScript files found in this repository.'
        : 'Could not analyse this repository. A valid root tsconfig.json is required.' });
      return;
    }

    const sessionId = createSession(cloneResult.path, repoUrl);
    updateSession(sessionId, { graph: graphResult.graph });
    res.json({ sessionId });
  });

  // ── GET /graph?session=<id> ───────────────────────────────────────────────
  // Returns: serialised ExportGraph JSON for the given session.
  app.get('/graph', (req, res) => {
    const sessionId = typeof req.query['session'] === 'string' ? req.query['session'] : '';
    if (!sessionId) {
      res.status(400).json({ error: 'Missing "session" query parameter.' });
      return;
    }
    const session = getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    if (!session.graph) {
      res.status(404).json({ error: 'Graph not yet available for this session.' });
      return;
    }
    res.json(serialiseGraph(session.graph));
  });

  // ── GET /graph-view?session=<id> ─────────────────────────────────────────
  // Renders the interactive graph page with the session's graph embedded and
  // the sessionId baked in so "Preview removal" can call /rehearse correctly.
  app.get('/graph-view', (req, res) => {
    const sessionId = typeof req.query['session'] === 'string' ? req.query['session'] : '';
    if (!sessionId) {
      res.status(400).send('<p>Missing "session" query parameter.</p>');
      return;
    }
    const session = getSession(sessionId);
    if (!session) {
      res.status(404).send('<p>Session not found.</p>');
      return;
    }
    if (!session.graph) {
      res.status(404).send('<p>Graph not yet available for this session.</p>');
      return;
    }
    const html = renderGraphPage(serialiseGraph(session.graph), sessionId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  // ── POST /rehearse ────────────────────────────────────────────────────────
  // Accepts: { sessionId: string, candidateId: string }
  // Returns: RehearsalResult  or  HTTP 400/404
  app.post('/rehearse', async (req, res) => {
    const body = req.body as { sessionId?: unknown; candidateId?: unknown };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const candidateId = typeof body.candidateId === 'string' ? body.candidateId : '';

    if (!sessionId || !candidateId) {
      res.status(400).json({ error: 'Missing "sessionId" or "candidateId".' });
      return;
    }

    const session = getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    if (!session.graph) {
      res.status(404).json({ error: 'Graph not available for this session.' });
      return;
    }

    // Validate candidate from the stored graph — never trust client-supplied paths.
    const node = session.graph.nodes.get(candidateId);
    if (!node) {
      res.status(400).json({ error: `Candidate "${candidateId}" not found in graph.` });
      return;
    }
    if (node.certainty !== 'candidate') {
      res.status(400).json({
        error:
          `Cannot rehearse removal: node "${candidateId}" has certainty "${node.certainty}". ` +
          'Only nodes with certainty "candidate" may be rehearsed.',
      });
      return;
    }
    if (!node.isSoleExport) {
      res.status(400).json({
        error:
          `Cannot rehearse removal: node "${candidateId}" is not a sole export (isSoleExport is false). ` +
          'Whole-file removal is only available for files with a single export.',
      });
      return;
    }

    const candidate = { nodeId: node.id, file: node.file, name: node.name };
    const result = await rehearseRemoval(session.repoPath, candidate, session.graph);

    if (result.ok) {
      updateSession(sessionId, { rehearsal: result });
    }

    res.json(result);
  });

  // ── GET /report?session=<id> ──────────────────────────────────────────────
  // Returns: rendered HTML report page for the most recent rehearsal.
  app.get('/report', (req, res) => {
    const sessionId = typeof req.query['session'] === 'string' ? req.query['session'] : '';
    if (!sessionId) {
      res.status(400).send('<p>Missing "session" query parameter.</p>');
      return;
    }
    const session = getSession(sessionId);
    if (!session || !session.rehearsal) {
      res.status(404).send('<p>Rehearsal result not found. Run /rehearse first.</p>');
      return;
    }

    // Find the candidate node from the graph to get its file/name.
    let candidateFile = '(unknown)';
    let candidateName = '(unknown)';
    if (session.graph) {
      for (const node of session.graph.nodes.values()) {
        if (session.rehearsal.removedFiles.includes(node.file)) {
          candidateFile = node.file;
          candidateName = node.name;
          break;
        }
      }
    }

    const report = generateReport(session.rehearsal, {
      repoUrl: session.repoUrl,
      candidateFile,
      candidateName,
      patchUrl: `/report/patch?session=${encodeURIComponent(sessionId)}`,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(report.html);
  });

  // ── GET /report/patch?session=<id> ───────────────────────────────────────
  // Returns: removal.patch file download.
  app.get('/report/patch', (req, res) => {
    const sessionId = typeof req.query['session'] === 'string' ? req.query['session'] : '';
    if (!sessionId) {
      res.status(400).send('Missing "session" query parameter.');
      return;
    }
    const session = getSession(sessionId);
    if (!session || !session.rehearsal) {
      res.status(404).send('Rehearsal result not found. Run /rehearse first.');
      return;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="removal.patch"');
    res.send(session.rehearsal.patchText);
  });

  // ── GET /api/graph ────────────────────────────────────────────────────────
  // Backward-compatible route used by existing Task 4 tests — returns the
  // built-in demo graph.
  app.get('/api/graph', (_req, res) => {
    res.json(serialiseGraph(demoGraph));
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
