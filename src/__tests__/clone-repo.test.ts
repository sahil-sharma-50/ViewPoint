/**
 * src/__tests__/clone-repo.test.ts
 *
 * Unit tests for cloneRepo, isValidGitHubUrl, canonicalGitHubUrl,
 * computeTsSourceSize, and DEFAULT_MAX_BYTES.
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
// DEFAULT_MAX_BYTES — verify the plan-specified 50 MB limit
// ---------------------------------------------------------------------------

describe('DEFAULT_MAX_BYTES', () => {
  it('is exactly 50 MB', () => {
    expect(DEFAULT_MAX_BYTES).toBe(50 * 1024 * 1024);
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
    mockMkdtemp.mockResolvedValue('/tmp/last-rites-clone-canonical');
    execFileSucceeds();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReaddir.mockResolvedValue([] as any);

    // Input has a trailing slash; git must receive the clean canonical form.
    await cloneRepo('https://github.com/owner/repo/');

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['clone', '--depth=1', 'https://github.com/owner/repo', '/tmp/last-rites-clone-canonical'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  // --- clone failure ---

  it('returns CLONE_FAILED and cleans up when git clone fails', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/last-rites-clone-abc');
    execFileFails();

    const result = await cloneRepo('https://github.com/owner/repo');

    expect(result).toEqual({ ok: false, error: 'CLONE_FAILED' });
    expect(mockRm).toHaveBeenCalledWith('/tmp/last-rites-clone-abc', {
      recursive: true,
      force: true,
    });
  });

  it('still returns CLONE_FAILED even when cleanup rm throws', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/last-rites-clone-rmfail');
    execFileFails();
    mockRm.mockRejectedValue(new Error('rm failed'));

    // Must not throw — rm failure is swallowed.
    const result = await cloneRepo('https://github.com/owner/repo');
    expect(result).toEqual({ ok: false, error: 'CLONE_FAILED' });
  });

  // --- size enforcement (TS-source-only) ---

  it('returns SIZE_EXCEEDED and cleans up when TS source exceeds the limit', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/last-rites-clone-xyz');
    execFileSucceeds();

    // One .ts file of 200 bytes.
    mockReaddir.mockResolvedValue([
      { name: 'bigfile.ts', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    mockLstat.mockResolvedValue({ size: 200 } as Awaited<ReturnType<typeof fsp.lstat>>);

    // maxBytes = 100 → 200-byte .ts file exceeds the limit.
    const result = await cloneRepo('https://github.com/owner/repo', 100);

    expect(result).toEqual({ ok: false, error: 'SIZE_EXCEEDED' });
    expect(mockRm).toHaveBeenCalledWith('/tmp/last-rites-clone-xyz', {
      recursive: true,
      force: true,
    });
  });

  it('does NOT count non-TS files toward the size limit', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/last-rites-clone-nonts');
    execFileSucceeds();

    // A large JS file — must not count toward TS source limit.
    mockReaddir.mockResolvedValue([
      { name: 'bundle.js', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    mockLstat.mockResolvedValue({ size: 999_999_999 } as Awaited<ReturnType<typeof fsp.lstat>>);

    // maxBytes = 1 — JS file must not trigger SIZE_EXCEEDED.
    const result = await cloneRepo('https://github.com/owner/repo', 1);

    expect(result).toEqual({ ok: true, path: '/tmp/last-rites-clone-nonts' });
  });

  // --- success path ---

  it('returns { ok: true, path } on a successful clone within the size limit', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/last-rites-clone-ok');
    execFileSucceeds();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReaddir.mockResolvedValue([] as any); // empty directory → 0 bytes

    const result = await cloneRepo('https://github.com/owner/repo');

    expect(result).toEqual({ ok: true, path: '/tmp/last-rites-clone-ok' });
    expect(mockRm).not.toHaveBeenCalled();
  });

  // --- symlink safety ---

  it('skips symlinks when computing directory size', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/last-rites-clone-sym');
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

    expect(result).toEqual({ ok: true, path: '/tmp/last-rites-clone-sym' });
  });
});
