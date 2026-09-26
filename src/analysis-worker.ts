import { Worker } from 'node:worker_threads';
import type { buildGraph } from './analyse-repo.js';
import type { Architecture } from './architecture.js';
import type { SerialGraph } from './server.js';

/** Keep compiler work off the HTTP thread so progress and navigation stay responsive. */
export function analyseInWorker(repoPath: string): ReturnType<typeof buildGraph> {
  return new Promise<Awaited<ReturnType<typeof buildGraph>>>(resolve => {
    const source = new URL(import.meta.url.endsWith('.ts') ? './analyse-repo.ts' : './analyse-repo.js', import.meta.url).href;
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const module = workerData.source.endsWith('.ts')
          ? await (await import('tsx/esm/api')).tsImport(workerData.source, workerData.parent)
          : await import(workerData.source);
        parentPort.postMessage(await module.buildGraph(workerData.repoPath));
      })().catch(() => parentPort.postMessage({ ok: false, error: 'Repository analysis failed.' }));
    `, { eval: true, workerData: { repoPath, source, parent: import.meta.url }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    const timeout = setTimeout(() => {
      resolve({ ok: false, error: 'Analysis exceeded the three minute processing budget.' });
      void worker.terminate();
    }, 180_000);
    worker.once('message', result => { clearTimeout(timeout); resolve(result); void worker.terminate(); });
    worker.once('error', () => { clearTimeout(timeout); resolve({ ok: false, error: 'Analysis exceeded the worker memory budget or could not start.' }); });
    worker.once('exit', () => { clearTimeout(timeout); resolve({ ok: false, error: 'Analysis worker stopped before completing.' }); });
  }).catch(() => ({ ok: false, error: 'Analysis worker could not start.' }));
}

/** Architecture parsing is independent of the first file map and stays off the HTTP thread. */
export function architectureInWorker(repoPath: string, graph: SerialGraph): Promise<{ ok: true; architecture: Architecture } | { ok: false; error: string }> {
  return new Promise<{ ok: true; architecture: Architecture } | { ok: false; error: string }>(resolve => {
    const source = new URL(import.meta.url.endsWith('.ts') ? './architecture.ts' : './architecture.js', import.meta.url).href;
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const module = workerData.source.endsWith('.ts')
          ? await (await import('tsx/esm/api')).tsImport(workerData.source, workerData.parent)
          : await import(workerData.source);
        parentPort.postMessage({ ok: true, architecture: module.buildArchitecture(workerData.repoPath, workerData.graph) });
      })().catch(() => parentPort.postMessage({ ok: false, error: 'Architecture analysis failed.' }));
    `, { eval: true, workerData: { repoPath, graph, source, parent: import.meta.url }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    const timeout = setTimeout(() => {
      resolve({ ok: false, error: 'Architecture analysis exceeded the three minute processing budget.' });
      void worker.terminate();
    }, 180_000);
    worker.once('message', result => { clearTimeout(timeout); resolve(result); void worker.terminate(); });
    worker.once('error', () => { clearTimeout(timeout); resolve({ ok: false, error: 'Architecture worker could not start.' }); });
    worker.once('exit', () => { clearTimeout(timeout); resolve({ ok: false, error: 'Architecture worker stopped before completing.' }); });
  }).catch(() => ({ ok: false, error: 'Architecture worker could not start.' }));
}
