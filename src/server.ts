/** Repository analysis API. Clone paths and graphs stay behind session IDs. */

import express from 'express';
import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';
import { analyseInWorker, architectureInWorker } from './analysis-worker.js';
import { cloneRepo, cloneErrorMessages, isValidGitHubUrl, DEFAULT_MAX_BYTES } from './clone-repo.js';
import { buildGraph, ANALYSIS_VERSION } from './analyse-repo.js';
import { explainArchitecture, explainMapContext } from './watsonx.js';
import { mapExplainContext } from './map-explain.js';
import type { MapSelection } from './map-explain.js';
import { createSession, getSession, updateSession } from './session-store.js';
import type { ExportGraph } from './types.js';

// ---------------------------------------------------------------------------
// Serialisation helpers for API responses
// ---------------------------------------------------------------------------

export interface SerialNode {
  id: string;
  file: string;
  name: string;
  fanIn: number;
  fanOut: number;
  isEntryPoint: boolean;
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
  warnings?: string[];
}

/** Convert an ExportGraph (with Maps/Sets) to a plain JSON-safe object. */
export function serialiseGraph(graph: ExportGraph): SerialGraph {
  // Collect all distinct repo-relative file values from nodes.
  const relFiles = new Set<string>();
  for (const node of graph.nodes.values()) {
    relFiles.add(node.file);
  }

  // Production graphs use relative paths. Resolve those in O(1); retain an
  // absolute-path fallback for older graphs, preferring the longest suffix.
  const suffixes = [...relFiles].sort((a, b) => b.length - a.length);
  const resolved = new Map<string, string | undefined>();
  const resolve = (file: string): string | undefined => {
    if (resolved.has(file)) return resolved.get(file);
    const normalized = file.replace(/\\/g, '/');
    const relative = relFiles.has(normalized) ? normalized : suffixes.find(candidate => normalized.endsWith('/' + candidate));
    resolved.set(file, relative);
    return relative;
  };

  const edges: SerialEdge[] = [];
  for (const [source, targetSet] of graph.edges) {
    const sourceRel = resolve(source);
    if (!sourceRel) continue; // skip edge keys that don't map to a known file

    const targets: string[] = [];
    for (const target of targetSet) {
      const targetRel = resolve(target);
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
    fanIn: n.fanIn,
    fanOut: n.fanOut,
    isEntryPoint: n.isEntryPoint,
  }));

  return { nodes, edges, ...(graph.warnings?.length ? { warnings: graph.warnings } : {}) };
}

// ---------------------------------------------------------------------------
// Express application factory
// ---------------------------------------------------------------------------

export function createApp(clone: typeof cloneRepo = cloneRepo): express.Application {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use((_req, res, next) => { res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  const refreshes = new Map<string, Promise<Awaited<ReturnType<typeof buildGraph>>>>();
  const architectureJobs = new Map<string, Promise<void>>();
  function ensureArchitecture(sessionId: string): Promise<void> {
    const session = getSession(sessionId);
    if (!session?.graph || !session.repoPath || session.architecture || session.architectureError) return Promise.resolve();
    let job = architectureJobs.get(sessionId);
    if (!job) {
      job = architectureInWorker(session.repoPath, serialiseGraph(session.graph)).then(result => {
        if (result.ok) updateSession(sessionId, { architecture: result.architecture });
        else updateSession(sessionId, { architectureError: result.error });
      }).finally(() => architectureJobs.delete(sessionId));
      architectureJobs.set(sessionId, job);
    }
    return job;
  }
  app.use(['/graph', '/architecture', '/api/workspace', '/api/map-explain', '/api/architecture-brief'], async (req, res, next) => {
    const sessionId = typeof req.query['session'] === 'string' ? req.query['session'] : req.body?.sessionId;
    if (typeof sessionId !== 'string') { next(); return; }
    const session = getSession(sessionId);
    if (!session?.graph || session.graph.analysisVersion === ANALYSIS_VERSION) { next(); return; }
    let refresh = refreshes.get(sessionId);
    if (!refresh) {
      refresh = analyseInWorker(session.repoPath).finally(() => refreshes.delete(sessionId));
      refreshes.set(sessionId, refresh);
    }
    const result = await refresh;
    if (!result.ok) { res.status(503).json({ ok: false, error: 'This saved analysis could not be refreshed. Analyse the repository again.' }); return; }
    updateSession(sessionId, { graph: result.graph, architecture: undefined, architectureError: undefined });
    next();
  });

  const __filename = url.fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(__filename), '..');
  const publicDir = path.join(projectRoot, 'public');
  const isDev = process.env['npm_lifecycle_event'] === 'dev';
  app.get('/__dev/reload', (_req, res) => {
    if (!isDev) { res.status(204).end(); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();
    res.write(': connected\n\n');
  });
  app.use(express.static(publicDir, { index: false }));
  let activeAnalyses = 0;
  app.get('/analysis-status', (req, res) => {
    const session = getSession(String(req.query['session'] ?? ''));
    res.setHeader('Cache-Control', 'no-store');
    if (!session) { res.status(404).json({ error: 'This session has expired. Analyse the repository again.' }); return; }
    res.json({ status: session.status ?? 'complete', error: session.error, repoUrl: session.repoUrl, expiresAt: session.expiresAt });
  });

  // ── POST /analyse ─────────────────────────────────────────────────────────
  // Accepts: { url: string }
  // Returns: { sessionId: string }  or  HTTP 400 with { error: string }
  app.post('/analyse', async (req, res) => {
    const body = (req.body ?? {}) as { url?: unknown; token?: unknown; async?: boolean };
    const input = typeof body.url === 'string' ? body.url.trim() : '';
    const repoUrl = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(input) ? 'https://github.com/' + input : input;
    if (!repoUrl || !isValidGitHubUrl(repoUrl)) {
      res.status(400).json({ error: 'Enter a GitHub repository URL or owner/repository.' });
      return;
    }
    if (body.token !== undefined) {
      res.status(400).json({ error: 'Only public GitHub repositories are supported. Tokens are not accepted.' }); return;
    }
    if (activeAnalyses >= 2) {
      res.status(429).json({ error: 'The server is analysing two repositories. Please try again shortly.' }); return;
    }
    activeAnalyses++;
    const sessionId = createSession('', repoUrl);
    updateSession(sessionId, { status: 'cloning' });
    if (body.async) res.status(202).json({ sessionId });
    try {
      const cloneResult = await clone(repoUrl, DEFAULT_MAX_BYTES);
      if (!cloneResult.ok) {
        const message = cloneResult.error === 'SIZE_EXCEEDED'
          ? `Repository exceeds this server's ${Math.round(DEFAULT_MAX_BYTES / 1024 / 1024)} MB checkout budget. Configure VIEWPOINT_MAX_REPO_MB for a larger server.`
          : cloneErrorMessages[cloneResult.error];
        updateSession(sessionId, { status: 'error', error: message });
        if (!body.async) res.status(400).json({ error: message });
        return;
      }
      updateSession(sessionId, { repoPath: cloneResult.path, status: 'analysing' });
      await new Promise<void>(resolve => setImmediate(resolve));
      const graphResult = await analyseInWorker(cloneResult.path);
      if (!graphResult.ok || graphResult.graph.nodes.size === 0) {
        await fs.promises.rm(cloneResult.path, { recursive: true, force: true });
        throw new Error(graphResult.ok ? 'This repository contains no inspectable files.' : graphResult.error);
      }
      updateSession(sessionId, { graph: graphResult.graph, status: 'complete' });
      void ensureArchitecture(sessionId);
      if (!body.async) res.json({ sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Analysis failed. Please try again.';
      updateSession(sessionId, { status: 'error', error: message });
      if (!res.headersSent) res.status(400).json({ error: message });
    } finally {
      activeAnalyses--;
    }
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

  app.get('/api/workspace', async (req, res) => {
    const sessionId = typeof req.query['session'] === 'string' ? req.query['session'] : '';
    const session = getSession(sessionId);
    if (!session?.graph || !session.repoPath) {
      res.status(404).json({ error: 'This session has expired. Analyse the repository again.' });
      return;
    }
    const graph = serialiseGraph(session.graph);
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (req.query['view'] !== 'architecture') {
        res.json({ graph, repoUrl: session.repoUrl });
        return;
      }
      if (!session.architecture && !session.architectureError) {
        void ensureArchitecture(sessionId);
        res.status(202).json({ status: 'building' });
        return;
      }
      const current = getSession(sessionId);
      if (current?.architectureError) throw new Error(current.architectureError);
      const architecture = current?.architecture;
      if (!architecture) throw new Error('Architecture view unavailable.');
      res.json({ graph, architecture, repoUrl: session.repoUrl });
    } catch {
      res.status(500).json({ error: 'Architecture view could not be prepared.' });
    }
  });

  app.post('/api/map-explain', async (req, res) => {
    const origin = req.get('origin');
    if (origin) {
      try { if (new URL(origin).host !== req.get('host')) { res.status(403).json({ ok: false, error: 'Cross-origin requests are not supported.' }); return; } }
      catch { res.status(403).json({ ok: false, error: 'Invalid origin.' }); return; }
    }
    res.setHeader('Cache-Control', 'no-store');
    const { sessionId, selection, question } = req.body ?? {};
    const validSelection = selection && typeof selection === 'object' && (
      (selection.kind === 'file' && typeof selection.file === 'string' && selection.file.length <= 2000) ||
      (selection.kind === 'folder' && typeof selection.folder === 'string' && selection.folder.length <= 2000) ||
      (selection.kind === 'link' && typeof selection.source === 'string' && typeof selection.target === 'string' && selection.source.length <= 2000 && selection.target.length <= 2000)
    );
    if (typeof sessionId !== 'string' || !validSelection || typeof question !== 'string' || !question.trim() || question.length > 300) {
      res.status(400).json({ ok: false, error: 'Choose a map item and enter a short question.' }); return;
    }
    const session = getSession(sessionId);
    if (!session?.graph || !session.repoPath) { res.status(404).json({ ok: false, error: 'This session has expired. Analyse the repository again.' }); return; }
    const context = mapExplainContext(serialiseGraph(session.graph), selection as MapSelection);
    if (!context.ok) { res.status(400).json(context); return; }
    const excerpts: { file: string; text: string }[] = [];
    try {
      const root = await fs.promises.realpath(session.repoPath);
      for (const relativeFile of context.excerptFiles) {
        const file = await fs.promises.realpath(path.resolve(root, relativeFile));
        const relative = path.relative(root, file);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
        const stats = await fs.promises.stat(file);
        if (!stats.isFile() || stats.size > 100_000) continue;
        excerpts.push({ file: relativeFile, text: (await fs.promises.readFile(file, 'utf8')).split('\n').slice(0, 60).join('\n').slice(0, 4000) });
      }
    } catch { /* The known graph still provides useful evidence. */ }
    const evidence = [...context.evidence.slice(0, 16), ...excerpts.map(item => `Source excerpt: ${item.file}, first 60 lines.`)];
    res.json(await explainMapContext(context.subject, evidence, question.trim(), excerpts));
  });

  app.post('/api/architecture-brief', async (req, res) => {
    const origin = req.get('origin');
    if (origin) {
      try { if (new URL(origin).host !== req.get('host')) { res.status(403).json({ ok: false, error: 'Cross-origin requests are not supported.' }); return; } }
      catch { res.status(403).json({ ok: false, error: 'Invalid origin.' }); return; }
    }
    res.setHeader('Cache-Control', 'no-store');
    const sessionId = req.body?.sessionId;
    if (typeof sessionId !== 'string') { res.status(400).json({ ok: false, error: 'Choose an analysed repository.' }); return; }
    const session = getSession(sessionId);
    if (!session?.graph || !session.repoPath) { res.status(404).json({ ok: false, error: 'This session has expired.' }); return; }
    await ensureArchitecture(sessionId);
    const current = getSession(sessionId);
    if (!current?.architecture) { res.status(503).json({ ok: false, error: current?.architectureError ?? 'Architecture view unavailable.' }); return; }
    res.json(await explainArchitecture(current.architecture));
  });

  app.use((error: { type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) { next(error); return; }
    const status = error?.type === 'entity.parse.failed' ? 400 : error?.type === 'entity.too.large' ? 413 : 500;
    const message = status === 400 ? 'Request body must be valid JSON.'
      : status === 413 ? 'Request body is too large.' : 'The request could not be completed. Please try again.';
    res.status(status).json({ ok: false, error: message });
  });

  return app;
}
