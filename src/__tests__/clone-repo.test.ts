/**
 * src/__tests__/clone-repo.test.ts
 *
 * Unit tests for cloneRepo, isValidGitHubUrl, canonicalGitHubUrl,
 * computeRepoSize, and DEFAULT_MAX_BYTES.
 *
 * All external I/O (execFile, fs/promises) is mocked — no real git calls.
 * See clone-repo.integration.test.ts for a live clone smoke test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isValidGitHubUrl,
  canonicalGitHubUrl,
  DEFAULT_MAX_BYTES,
} from '../clone-repo.js';

// ---------------------------------------------------------------------------
// DEFAULT_MAX_BYTES — configurable checkout budget
// ---------------------------------------------------------------------------

describe('DEFAULT_MAX_BYTES', () => {
  it('defaults to a configurable 512 MB checkout budget', () => {
    expect(DEFAULT_MAX_BYTES).toBe(512 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// isValidGitHubUrl — pure URL validation (no I/O)
// ---------------------------------------------------------------------------

describe('isValidGitHubUrl', () => {
  it('accepts a well-formed HTTPS owner/repo URL', () => {
    expect(isValidGitHubUrl('https://github.com/owner/repo')).toBe(true);
  });

  it('accepts a URL with a trailing slash', () => {
    expect(isValidGitHubUrl('https://github.com/owner/repo/')).toBe(true);
  });

  it('rejects HTTP (non-HTTPS) URLs', () => {
    expect(isValidGitHubUrl('http://github.com/owner/repo')).toBe(false);
  });

  it('rejects non-github.com hostnames', () => {
    expect(isValidGitHubUrl('https://gitlab.com/owner/repo')).toBe(false);
    expect(isValidGitHubUrl('https://evil.github.com/owner/repo')).toBe(false);
    expect(isValidGitHubUrl('https://github.com.evil.com/owner/repo')).toBe(false);
  });

  it('rejects a URL with only one path segment (no repo)', () => {
    expect(isValidGitHubUrl('https://github.com/owner')).toBe(false);
  });

  it('rejects a URL with more than two path segments', () => {
    expect(isValidGitHubUrl('https://github.com/owner/repo/tree/main')).toBe(false);
  });

  it('rejects the bare root path', () => {
    expect(isValidGitHubUrl('https://github.com/')).toBe(false);
    expect(isValidGitHubUrl('https://github.com')).toBe(false);
  });

  it('rejects non-URL garbage strings', () => {
    expect(isValidGitHubUrl('not-a-url')).toBe(false);
    expect(isValidGitHubUrl('')).toBe(false);
  });

  it('rejects URLs with embedded credentials', () => {
    expect(isValidGitHubUrl('https://user:pass@github.com/owner/repo')).toBe(false);
    expect(isValidGitHubUrl('https://token@github.com/owner/repo')).toBe(false);
  });

  it('rejects URLs with a query string', () => {
    expect(isValidGitHubUrl('https://github.com/owner/repo?tab=readme')).toBe(false);
  });

  it('rejects URLs with a fragment', () => {
    expect(isValidGitHubUrl('https://github.com/owner/repo#readme')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canonicalGitHubUrl — strips extra URL components
// ---------------------------------------------------------------------------

describe('canonicalGitHubUrl', () => {
  it('returns https://github.com/<owner>/<repo> for a clean URL', () => {
    expect(canonicalGitHubUrl('https://github.com/owner/repo')).toBe(
      'https://github.com/owner/repo',
    );
  });

  it('strips a trailing slash', () => {
    expect(canonicalGitHubUrl('https://github.com/owner/repo/')).toBe(
      'https://github.com/owner/repo',
    );
  });
});

// ---------------------------------------------------------------------------
// cloneRepo — mock all external I/O
// ---------------------------------------------------------------------------

// Hoist mock factories so they run before module evaluation.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  lstat: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock('node:os', () => ({
  tmpdir: () => '/tmp',
}));

// Make promisify return a wrapper that returns a Promise, matching how the
// module-under-test calls the promisified execFile (no callback).
vi.mock('node:util', () => ({
  promisify:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      Promise.resolve(fn(...args)),
}));

import * as cp from 'node:child_process';
import * as fsp from 'node:fs/promises';

// Typed convenience aliases.
const mockExecFile = vi.mocked(cp.execFile) as unknown as ReturnType<typeof vi.fn>;
const mockMkdtemp = vi.mocked(fsp.mkdtemp);
const mockRm = vi.mocked(fsp.rm);
const mockLstat = vi.mocked(fsp.lstat);
const mockReaddir = vi.mocked(fsp.readdir);

// Import cloneRepo AFTER all mocks are declared (vitest hoisting handles ordering).
import { cloneRepo } from '../clone-repo.js';

// The module calls the promisified execFile as: execFile(cmd, args, opts)
// Our promisify wrapper does: Promise.resolve(fn(cmd, args, opts))
// So the mock must be synchronous — return a value (success) or throw (failure).
function execFileSucceeds() {
  mockExecFile.mockReturnValue(undefined); // resolves to undefined
}

function execFileFails(msg = 'git clone failed') {
  mockExecFile.mockImplementation(() => {
    throw new Error(msg);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  // rm always resolves unless a test overrides it.
  mockRm.mockResolvedValue(undefined);
});

describe('cloneRepo', () => {
  // --- URL rejection (no I/O) ---

  it('returns INVALID_URL for a non-URL string', async () => {
    const result = await cloneRepo('not-a-url');
    expect(result).toEqual({ ok: false, error: 'INVALID_URL' });
    expect(cp.execFile).not.toHaveBeenCalled();
  });

  it('returns INVALID_URL for an HTTP URL', async () => {
    const result = await cloneRepo('http://github.com/owner/repo');
    expect(result).toEqual({ ok: false, error: 'INVALID_URL' });
    expect(cp.execFile).not.toHaveBeenCalled();
  });

  it('returns INVALID_URL for a URL with credentials', async () => {
    const result = await cloneRepo('https://user:pass@github.com/owner/repo');
    expect(result).toEqual({ ok: false, error: 'INVALID_URL' });
    expect(cp.execFile).not.toHaveBeenCalled();
  });

  it('returns INVALID_URL for a URL with a query string', async () => {
    const result = await cloneRepo('https://github.com/owner/repo?ref=main');
    expect(result).toEqual({ ok: false, error: 'INVALID_URL' });
    expect(cp.execFile).not.toHaveBeenCalled();
  });

  it('returns INVALID_URL for a URL with a fragment', async () => {
    const result = await cloneRepo('https://github.com/owner/repo#readme');
    expect(result).toEqual({ ok: false, error: 'INVALID_URL' });
    expect(cp.execFile).not.toHaveBeenCalled();
  });

  // --- mkdtemp failure ---

  it('returns CLONE_FAILED (no throw) when mkdtemp fails', async () => {
    mockMkdtemp.mockRejectedValue(new Error('EACCES: permission denied'));

    const result = await cloneRepo('https://github.com/owner/repo');

    expect(result).toEqual({ ok: false, error: 'CLONE_FAILED' });
    expect(cp.execFile).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();
  });

  // --- canonical URL passed to git ---

  it('passes the canonical URL to git, not the raw user input', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/viewpoint-clone-canonical');
    execFileSucceeds();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReaddir.mockResolvedValue([] as any);

    // Input has a trailing slash; git must receive the clean canonical form.
    await cloneRepo('https://github.com/owner/repo/');

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['clone', '--depth=1', 'https://github.com/owner/repo', '/tmp/viewpoint-clone-canonical'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  // --- clone failure ---

  it('retries a network failure once in a fresh directory with HTTP/1.1', async () => {
    mockMkdtemp.mockResolvedValueOnce('/tmp/viewpoint-first').mockResolvedValueOnce('/tmp/viewpoint-retry');
    mockExecFile.mockRejectedValueOnce({ stderr: 'RPC failed; connection reset' }).mockResolvedValueOnce(undefined);
    mockReaddir.mockResolvedValue([]);
    expect(await cloneRepo('https://github.com/owner/repo')).toEqual({ ok: true, path: '/tmp/viewpoint-retry' });
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile.mock.calls[1][2].env).toMatchObject({ GIT_CONFIG_KEY_4: 'http.version', GIT_CONFIG_VALUE_4: 'HTTP/1.1', GIT_TERMINAL_PROMPT: '0' });
    expect(mockRm).toHaveBeenCalledWith('/tmp/viewpoint-first', { recursive: true, force: true });
  });

  it('blocks inherited authentication prompts and isolates public checkout configuration', async () => {
    vi.stubEnv('GIT_ASKPASS', 'launch-signin');
    vi.stubEnv('GIT_CONFIG_PARAMETERS', 'credential.helper=manager');
    try {
      mockMkdtemp.mockResolvedValue('/tmp/viewpoint-clone-public');
      execFileSucceeds();
      mockReaddir.mockResolvedValue([]);
      await cloneRepo('https://github.com/owner/repo');
      const options = mockExecFile.mock.calls[0][2];
      expect(options.cwd).toBe('/tmp/viewpoint-clone-public');
      expect(options.windowsHide).toBe(true);
      expect(options.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'Never', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'core.askPass', GIT_CONFIG_VALUE_1: '' });
      expect(options.env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([
    [{ code: 'ENOENT' }, 'GIT_UNAVAILABLE'],
    [{ killed: true }, 'CLONE_TIMEOUT'],
    [{ stderr: 'fatal: repository not found' }, 'REPO_UNAVAILABLE'],
    [{ stderr: 'fatal: Could not resolve host: github.com' }, 'NETWORK_ERROR'],
    [{ stderr: 'Clone succeeded, but checkout failed.' }, 'CHECKOUT_FAILED'],
  ])('classifies clone failure %j without exposing raw output', async (failure, expected) => {
    mockMkdtemp.mockResolvedValue('/tmp/viewpoint-clone-failure');
    mockExecFile.mockRejectedValue(failure);
    expect(await cloneRepo('https://github.com/owner/repo')).toEqual({ ok: false, error: expected });
    expect(mockRm).toHaveBeenCalled();
  });

  it('returns CLONE_FAILED and cleans up when git clone fails', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/viewpoint-clone-abc');
    execFileFails();

    const result = await cloneRepo('https://github.com/owner/repo');

    expect(result).toEqual({ ok: false, error: 'CLONE_FAILED' });
    expect(mockRm).toHaveBeenCalledWith('/tmp/viewpoint-clone-abc', {
      recursive: true,
      force: true,
    });
  });

  it('still returns CLONE_FAILED even when cleanup rm throws', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/viewpoint-clone-rmfail');
    execFileFails();
    mockRm.mockRejectedValue(new Error('rm failed'));

    // Must not throw — rm failure is swallowed.
    const result = await cloneRepo('https://github.com/owner/repo');
    expect(result).toEqual({ ok: false, error: 'CLONE_FAILED' });
  });

  // --- checkout size enforcement ---

  it('returns SIZE_EXCEEDED and cleans up when TS source exceeds the limit', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/viewpoint-clone-xyz');
    execFileSucceeds();

    // One .ts file of 200 bytes.
    mockReaddir.mockResolvedValue([
      { name: 'bigfile.ts', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    mockLstat.mockResolvedValue({ size: 200 } as Awaited<ReturnType<typeof fsp.lstat>>);

    // maxBytes = 100 → 200-byte file exceeds the limit.
    const result = await cloneRepo('https://github.com/owner/repo', 100);

    expect(result).toEqual({ ok: false, error: 'SIZE_EXCEEDED' });
    expect(mockRm).toHaveBeenCalledWith('/tmp/viewpoint-clone-xyz', {
      recursive: true,
      force: true,
    });
  });

  it('counts all file types toward the checkout budget', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/viewpoint-clone-nonts');
    execFileSucceeds();

    // A large JS file counts toward the checkout budget.
    mockReaddir.mockResolvedValue([
      { name: 'bundle.js', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    mockLstat.mockResolvedValue({ size: 999_999_999 } as Awaited<ReturnType<typeof fsp.lstat>>);

    // maxBytes = 1 — the JS file exceeds the budget.
    const result = await cloneRepo('https://github.com/owner/repo', 1);

    expect(result).toEqual({ ok: false, error: 'SIZE_EXCEEDED' });
  });

  // --- success path ---

  it('returns { ok: true, path } on a successful clone within the size limit', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/viewpoint-clone-ok');
    execFileSucceeds();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReaddir.mockResolvedValue([] as any); // empty directory → 0 bytes

    const result = await cloneRepo('https://github.com/owner/repo');

    expect(result).toEqual({ ok: true, path: '/tmp/viewpoint-clone-ok' });
    expect(mockRm).not.toHaveBeenCalled();
  });

  // --- symlink safety ---

  it('skips symlinks when computing directory size', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/viewpoint-clone-sym');
    execFileSucceeds();

    // Symlink whose target would be enormous — must be ignored.
    mockReaddir.mockResolvedValue([
      { name: 'link.ts', isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    // lstat must never be called for a symlink.
    mockLstat.mockRejectedValue(new Error('lstat must not be called for symlinks'));

    // maxBytes = 1; if symlink were followed, SIZE_EXCEEDED would fire.
    const result = await cloneRepo('https://github.com/owner/repo', 1);

    expect(result).toEqual({ ok: true, path: '/tmp/viewpoint-clone-sym' });
  });
});
