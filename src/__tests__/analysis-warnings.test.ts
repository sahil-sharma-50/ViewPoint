import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph } from '../analyse-repo.js';
import { serialiseGraph } from '../server.js';
import * as sessions from '../session-store.js';
import { mapExplainContext } from '../map-explain.js';

vi.mock('../python-adapter.js', () => ({
  scanPython: async () => ({ ok: false, error: 'Python is unavailable.' }),
  scanStructured: async () => ({ ok: false, error: 'Language scan timed out.' }),
}));

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('preserves language scan warnings through serialization and session recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viewpoint-warnings-'));
  roots.push(root);
  await writeFile(join(root, 'main.py'), 'print("hello")');
  await writeFile(join(root, 'main.go'), 'package main');
  await writeFile(join(root, 'Main.java'), 'class Main {}');
  const result = await buildGraph(root);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const warnings = [
    'Python connections could not be scanned. Python is unavailable.',
    'Go connections could not be scanned. Language scan timed out.',
    'Java connections could not be scanned. Language scan timed out.',
  ];
  expect(result.graph).toMatchObject({ warnings });
  expect(result.graph.nodes.size).toBe(3);
  expect(serialiseGraph(result.graph)).toMatchObject({ warnings });
  for (const selection of [{ kind: 'file', file: 'main.py' }, { kind: 'folder', folder: '' }] as const) {
    const context = mapExplainContext(serialiseGraph(result.graph), selection);
    expect(context.ok).toBe(true);
    if (context.ok) expect(context.evidence).toEqual(expect.arrayContaining(warnings.map(warning => `Incomplete connection map: ${warning}`)));
  }
  const id = sessions.createSession(root, 'test');
  try {
    sessions.updateSession(id, { graph: result.graph, status: 'complete' });
    vi.resetModules();
    const recovered = await import('../session-store.js');
    try { expect(recovered.getSession(id)?.graph).toMatchObject({ warnings }); }
    finally { await recovered.deleteSession(id); }
  } finally { await sessions.deleteSession(id); }
});
