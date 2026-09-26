import { expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { createSession, deleteSession, getSession, updateSession } from '../session-store.js';

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

it.each(['writeFileSync', 'renameSync'] as const)('keeps completed analysis available when snapshot %s fails', async method => {
  const id = createSession('', 'https://github.com/owner/repo');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.mocked(fs[method]).mockImplementationOnce(() => { throw new Error('Disk full'); });
  try {
    expect(() => updateSession(id, { status: 'complete', graph: { nodes: new Map(), edges: new Map() } })).not.toThrow();
    expect(getSession(id)?.status).toBe('complete');
    expect(getSession(id)?.graph).toBeDefined();
  } finally {
    warning.mockRestore();
    await deleteSession(id);
  }
});
