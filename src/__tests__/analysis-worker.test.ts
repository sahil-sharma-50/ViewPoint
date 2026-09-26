import { expect, it, vi } from 'vitest';
import { analyseInWorker, architectureInWorker } from '../analysis-worker.js';

vi.mock('node:worker_threads', () => ({
  Worker: class { constructor() { throw new Error('Worker could not start'); } },
}));

it('reports worker startup failures through the result contract', async () => {
  await expect(analyseInWorker('repository')).resolves.toMatchObject({ ok: false, error: expect.any(String) });
  await expect(architectureInWorker('repository', { nodes: [], edges: [] })).resolves.toMatchObject({ ok: false, error: expect.any(String) });
});
