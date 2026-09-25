/**
 * src/__tests__/server.test.ts — Route tests for the Last Rites HTTP server (Task 4).
 *
 * Tests:
 *   - GET /        → 200 text/html with graph data embedded
 *   - GET /api/graph → 200 JSON with nodes[] and edges[]
 *   - POST /api/graph cannot analyse arbitrary server filesystem paths
 *
 * Uses Node.js built-in http.createServer + http.request to talk to the live
 * Express app so no external test-http library is required.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as vm from 'node:vm';
import * as path from 'node:path';
import * as url from 'node:url';
import { buildGraph } from '../analyse-repo.js';
import { createApp, serialiseGraph } from '../server.js';
import { deleteSession } from '../session-store.js';
import type { ExportGraph } from '../types.js';

// ---------------------------------------------------------------------------
// Resolve paths
// ---------------------------------------------------------------------------
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DEMO_PATH = path.resolve(__dirname, '../../demo');

// ---------------------------------------------------------------------------
// HTTP helper — fires a request against the live server on a random port.
// ---------------------------------------------------------------------------
function httpRequest(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: {
        'content-type': bodyStr ? 'application/json' : 'text/plain',
        ...(bodyStr ? { 'content-length': String(Buffer.byteLength(bodyStr)) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        }),
      );
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Shared server fixture — started once for all tests in this file.
// ---------------------------------------------------------------------------
let demoGraph: ExportGraph;
let server: http.Server;
let port: number;

beforeAll(async () => {
  const result = await buildGraph(DEMO_PATH);
  if (!result.ok) throw new Error('buildGraph failed: ' + result.error);
  demoGraph = result.graph;

  const app = createApp(demoGraph);
  server = http.createServer(app);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const addr = server.address() as { port: number };
  port = addr.port;
});

afterAll(() => {
  server?.close();
});

// ---------------------------------------------------------------------------
// GET / tests
// ---------------------------------------------------------------------------

describe('GET /', () => {
  it('returns 200', async () => {
    const res = await httpRequest(port, 'GET', '/');
    expect(res.status).toBe(200);
  });

  it('returns text/html content-type', async () => {
    const res = await httpRequest(port, 'GET', '/');
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('body contains URL input form', async () => {
    const res = await httpRequest(port, 'GET', '/');
    expect(res.body).toContain('Analyse');
  });

  it('body contains analyse endpoint reference', async () => {
    const res = await httpRequest(port, 'GET', '/');
    // The URL input form posts to /analyse
    expect(res.body).toContain('/analyse');
  });

  it('serves parseable browser JavaScript', async () => {
    const res = await httpRequest(port, 'GET', '/');
    const script = res.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    expect(() => new vm.Script(script!)).not.toThrow();
  });

  it('body contains "Made with IBM Bob" footer', async () => {
    const res = await httpRequest(port, 'GET', '/');
    expect(res.body).toContain('Made with IBM Bob');
  });
});

// ---------------------------------------------------------------------------
// GET /api/graph tests
// ---------------------------------------------------------------------------

describe('GET /api/graph', () => {
  it('returns 200', async () => {
    const res = await httpRequest(port, 'GET', '/api/graph');
    expect(res.status).toBe(200);
  });

  it('returns application/json content-type', async () => {
    const res = await httpRequest(port, 'GET', '/api/graph');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('response has nodes array', async () => {
    const res = await httpRequest(port, 'GET', '/api/graph');
    const data = JSON.parse(res.body) as { nodes: unknown[]; edges: unknown[] };
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(data.nodes.length).toBeGreaterThan(0);
  });

  it('response has edges array', async () => {
    const res = await httpRequest(port, 'GET', '/api/graph');
    const data = JSON.parse(res.body) as { nodes: unknown[]; edges: unknown[] };
    expect(Array.isArray(data.edges)).toBe(true);
  });

  it('every node has required fields', async () => {
    const res = await httpRequest(port, 'GET', '/api/graph');
    const data = JSON.parse(res.body) as {
      nodes: { id: string; file: string; certainty: string; fanIn: number; fanOut: number }[];
    };
    for (const node of data.nodes) {
      expect(typeof node.id).toBe('string');
      expect(typeof node.file).toBe('string');
      expect(['candidate', 'unknown', 'unsafe']).toContain(node.certainty);
      expect(typeof node.fanIn).toBe('number');
      expect(typeof node.fanOut).toBe('number');
    }
  });

  it('edges have source (file path) and targets (file path array)', async () => {
    const res = await httpRequest(port, 'GET', '/api/graph');
    const data = JSON.parse(res.body) as {
      edges: { source: string; targets: string[] }[];
    };
    for (const edge of data.edges) {
      expect(typeof edge.source).toBe('string');
      expect(Array.isArray(edge.targets)).toBe(true);
    }
  });

  it('edge sources and targets are repo-relative file paths present in nodes', async () => {
    const res = await httpRequest(port, 'GET', '/api/graph');
    const data = JSON.parse(res.body) as {
      nodes: { file: string }[];
      edges: { source: string; targets: string[] }[];
    };
    const nodeFiles = new Set(data.nodes.map((n) => n.file));
    for (const edge of data.edges) {
      expect(nodeFiles.has(edge.source)).toBe(true);
      for (const t of edge.targets) {
        expect(nodeFiles.has(t)).toBe(true);
      }
    }
  });

  it('newDashboard.ts node has certainty candidate', async () => {
    const res = await httpRequest(port, 'GET', '/api/graph');
    const data = JSON.parse(res.body) as { nodes: { file: string; certainty: string }[] };
    const node = data.nodes.find((n) => n.file.includes('newDashboard'));
    expect(node).toBeDefined();
    expect(node!.certainty).toBe('candidate');
  });

  it('darkMode.ts node has certainty unsafe', async () => {
    const res = await httpRequest(port, 'GET', '/api/graph');
    const data = JSON.parse(res.body) as { nodes: { file: string; certainty: string }[] };
    const node = data.nodes.find((n) => n.file.includes('darkMode'));
    expect(node).toBeDefined();
    expect(node!.certainty).toBe('unsafe');
  });

  it('index.ts → darkMode.ts edge is present', async () => {
    const res = await httpRequest(port, 'GET', '/api/graph');
    const data = JSON.parse(res.body) as {
      edges: { source: string; targets: string[] }[];
    };
    const edge = data.edges.find((e) => e.source.endsWith('index.ts'));
    expect(edge).toBeDefined();
    expect(edge!.targets.some((t) => t.includes('darkMode'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/graph tests
// ---------------------------------------------------------------------------

describe('POST /api/graph', () => {
  it('does not accept a client-supplied local path', async () => {
    const res = await httpRequest(port, 'POST', '/api/graph', { repoPath: DEMO_PATH });
    expect(res.status).toBe(404);
  });
});

describe('session workflow', () => {
  it('analyses, rehearses, renders a report, and downloads its patch', async () => {
    const clonePath = await fs.mkdtemp(path.join(os.tmpdir(), 'last-rites-clone-test-'));
    await fs.cp(path.join(DEMO_PATH, 'src'), path.join(clonePath, 'src'), {
      recursive: true,
      filter: (source) => !source.endsWith('.test.ts'),
    });
    await fs.copyFile(path.join(DEMO_PATH, 'tsconfig.json'), path.join(clonePath, 'tsconfig.json'));
    await fs.copyFile(path.join(DEMO_PATH, 'package.json'), path.join(clonePath, 'package.json'));

    const app = createApp(demoGraph, async () => ({ ok: true, path: clonePath }));
    const testServer = http.createServer(app);
    await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    const testPort = (testServer.address() as { port: number }).port;
    let sessionId = '';
    try {
      const analysed = await httpRequest(testPort, 'POST', '/analyse', {
        url: 'https://github.com/example/demo',
      });
      expect(analysed.status).toBe(200);
      sessionId = (JSON.parse(analysed.body) as { sessionId: string }).sessionId;
      expect(sessionId).toBeTruthy();

      const graph = await httpRequest(testPort, 'GET', `/graph?session=${sessionId}`);
      expect(graph.status).toBe(200);
      const nodes = (JSON.parse(graph.body) as { nodes: { id: string }[] }).nodes;
      const candidateId = nodes.find((node) => node.id.includes('newDashboard'))?.id;
      expect(candidateId).toBeTruthy();

      const view = await httpRequest(testPort, 'GET', `/graph-view?session=${sessionId}`);
      expect(view.status).toBe(200);
      expect(view.body).toContain(sessionId);
      const viewScript = view.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      expect(viewScript).toBeDefined();
      expect(() => new vm.Script(viewScript!)).not.toThrow();

      const rehearsed = await httpRequest(testPort, 'POST', '/rehearse', { sessionId, candidateId });
      expect(rehearsed.status).toBe(200);
      const result = JSON.parse(rehearsed.body) as { ok: boolean; delta: { newErrors: unknown[] } };
      expect(result.ok).toBe(true);
      expect(result.delta.newErrors).toHaveLength(0);

      const report = await httpRequest(testPort, 'GET', `/report?session=${sessionId}`);
      expect(report.status).toBe(200);
      expect(report.body).toContain(`/report/patch?session=${sessionId}`);

      const patch = await httpRequest(testPort, 'GET', `/report/patch?session=${sessionId}`);
      expect(patch.status).toBe(200);
      expect(patch.headers['content-disposition']).toContain('removal.patch');
      expect(patch.body).toContain('newDashboard');
    } finally {
      if (sessionId) await deleteSession(sessionId);
      await new Promise<void>((resolve) => testServer.close(() => resolve()));
      expect(await fs.stat(clonePath).then(() => true, () => false)).toBe(false);
    }
  });

  it('removes a clone when analysis fails before a session exists', async () => {
    const clonePath = await fs.mkdtemp(path.join(os.tmpdir(), 'last-rites-clone-test-'));
    const app = createApp(demoGraph, async () => ({ ok: true, path: clonePath }));
    const testServer = http.createServer(app);
    await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    try {
      const analysed = await httpRequest((testServer.address() as { port: number }).port, 'POST', '/analyse', {
        url: 'https://github.com/example/demo',
      });
      expect(analysed.status).toBe(400);
      expect(await fs.stat(clonePath).then(() => true, () => false)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => testServer.close(() => resolve()));
      await fs.rm(clonePath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// serialiseGraph unit tests — edge key → repo-relative path mapping
// ---------------------------------------------------------------------------

describe('serialiseGraph', () => {
  it('produces a non-empty nodes array from the demo graph', () => {
    const serial = serialiseGraph(demoGraph);
    expect(serial.nodes.length).toBeGreaterThan(0);
  });

  it('all serial node files are repo-relative (no leading slash)', () => {
    const serial = serialiseGraph(demoGraph);
    for (const node of serial.nodes) {
      expect(node.file.startsWith('/')).toBe(false);
      expect(node.file.startsWith('\\')).toBe(false);
    }
  });

  it('edge targets reference existing node file values', () => {
    const serial = serialiseGraph(demoGraph);
    const nodeFiles = new Set(serial.nodes.map((n) => n.file));
    for (const edge of serial.edges) {
      expect(nodeFiles.has(edge.source)).toBe(true);
      for (const t of edge.targets) {
        expect(nodeFiles.has(t)).toBe(true);
      }
    }
  });

  it('index.ts → darkMode.ts edge survives serialisation', () => {
    const serial = serialiseGraph(demoGraph);
    const nodeFiles = new Set(serial.nodes.map((n) => n.file));
    const indexFile = [...nodeFiles].find((f) => f.endsWith('index.ts'));
    const darkFile = [...nodeFiles].find((f) => f.includes('darkMode'));
    expect(indexFile).toBeDefined();
    expect(darkFile).toBeDefined();

    const edge = serial.edges.find((e) => e.source === indexFile);
    expect(edge).toBeDefined();
    expect(edge!.targets).toContain(darkFile);
  });
});
