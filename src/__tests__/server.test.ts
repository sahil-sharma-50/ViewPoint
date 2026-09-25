/**
 * src/__tests__/server.test.ts — Route tests for the Last Rites HTTP server (Task 4).
 *
 * Tests:
 *   - GET /        → 200 text/html with graph data embedded
 *   - GET /api/graph → 200 JSON with nodes[] and edges[]
 *   - POST /api/graph with valid repoPath → 200 JSON with graph
 *   - POST /api/graph with missing repoPath → 400
 *   - POST /api/graph with invalid repoPath → 422
 *
 * Uses Node.js built-in http.createServer + http.request to talk to the live
 * Express app so no external test-http library is required.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as url from 'node:url';
import { buildGraph } from '../analyse-repo.js';
import { createApp, serialiseGraph } from '../server.js';
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

  it('body contains embedded graph JSON', async () => {
    const res = await httpRequest(port, 'GET', '/');
    expect(res.body).toContain('"nodes"');
    expect(res.body).toContain('"edges"');
  });

  it('body contains certainty values', async () => {
    const res = await httpRequest(port, 'GET', '/');
    expect(res.body).toContain('candidate');
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
  it('returns 400 when repoPath is missing', async () => {
    const res = await httpRequest(port, 'POST', '/api/graph', {});
    expect(res.status).toBe(400);
    const data = JSON.parse(res.body) as { ok: boolean };
    expect(data.ok).toBe(false);
  });

  it('returns 422 for a path that has no tsconfig.json', async () => {
    const res = await httpRequest(port, 'POST', '/api/graph', { repoPath: '/nonexistent/path/xyz' });
    expect(res.status).toBe(422);
    const data = JSON.parse(res.body) as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
  });

  it('returns 200 with ok:true and graph for the demo repo', async () => {
    const res = await httpRequest(port, 'POST', '/api/graph', { repoPath: DEMO_PATH });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as { ok: boolean; graph: { nodes: unknown[] } };
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.graph.nodes)).toBe(true);
    expect(data.graph.nodes.length).toBeGreaterThan(0);
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
