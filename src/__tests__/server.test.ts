import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph } from '../analyse-repo.js';
import { createApp } from '../server.js';
import { createSession, deleteSession, updateSession } from '../session-store.js';

let server: Server;
let base: string;
let sessionId: string;
let repoPath: string;
beforeAll(async () => {
  repoPath = await mkdtemp(join(tmpdir(), 'viewpoint-server-test-'));
  await writeFile(join(repoPath, 'index.ts'), 'export const ready = true;');
  const result = await buildGraph(repoPath);
  if (!result.ok) throw new Error(result.error);
  sessionId = createSession(repoPath, 'Test repository');
  updateSession(sessionId, { graph: result.graph, status: 'complete' });
  server = createApp().listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP port unavailable');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await deleteSession(sessionId);
  await rm(repoPath, { recursive: true, force: true });
});

it('serves the file graph immediately', async () => {
  const response = await fetch(`${base}/api/workspace?session=${sessionId}&view=files`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.graph.nodes.some((node: { file: string }) => node.file === 'index.ts')).toBe(true);
  expect(body.graph.architecture).toBeUndefined();
});

it.each([
  [400, '{"url":'],
  [413, JSON.stringify({ url: 'a'.repeat(17_000) })],
] as const)('returns a JSON error for an invalid API body (HTTP %s)', async (status, body) => {
  const response = await fetch(`${base}/analyse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toMatchObject({ ok: false, error: expect.any(String) });
});
