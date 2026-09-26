import { expect, it, vi } from 'vitest';

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    // Exercise a real process that fails before consuming its input.
    spawn: () => original.spawn(process.execPath, ['-e', 'process.exit(1)']),
  };
});

import { scanPython } from '../python-adapter.js';

it('returns a scan failure when a helper exits before reading its input', async () => {
  const result = await scanPython('.', ['x'.repeat(1_000_000)]);
  expect(result.ok).toBe(false);
});
