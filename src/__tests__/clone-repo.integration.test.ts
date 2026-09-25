/**
 * src/__tests__/clone-repo.integration.test.ts
 *
 * Live smoke test: clones a real small public GitHub repository, verifies
 * the result, then cleans up the temporary directory.
 *
 * Runs only when LAST_RITES_INTEGRATION=1 is set, so it never blocks the
 * normal unit-test suite or CI environments without network access.
 *
 *   LAST_RITES_INTEGRATION=1 npx vitest run src/__tests__/clone-repo.integration.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { rm, access } from 'node:fs/promises';
import { cloneRepo } from '../clone-repo.js';

const RUN = process.env['LAST_RITES_INTEGRATION'] === '1';

// A small, stable, public repository — minimal content, fast to clone.
const TEST_REPO_URL = 'https://github.com/octocat/Hello-World';

describe.skipIf(!RUN)('cloneRepo — live integration', () => {
  let clonedPath: string | undefined;

  afterEach(async () => {
    if (clonedPath !== undefined) {
      await rm(clonedPath, { recursive: true, force: true });
      clonedPath = undefined;
    }
  });

  it(
    'clones a real public repo, returns ok:true with an accessible path, then cleans up',
    async () => {
      const result = await cloneRepo(TEST_REPO_URL);

      expect(result.ok).toBe(true);
      if (!result.ok) return; // narrow type for TS

      clonedPath = result.path;

      // The clone directory must exist and be accessible.
      await expect(access(result.path)).resolves.toBeUndefined();

      // The path must be inside the OS temp directory.
      const { tmpdir } = await import('node:os');
      expect(result.path.startsWith(tmpdir())).toBe(true);

      // The path must include our well-known prefix.
      expect(result.path).toContain('last-rites-clone-');
    },
    60_000, // 60 s timeout for slow network conditions
  );
});
