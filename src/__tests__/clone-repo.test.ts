/**
 * src/__tests__/clone-repo.test.ts
 *
 * Unit tests for cloneRepo and isValidGitHubUrl.
 *
 * All external I/O (execFile, fs/promises) is mocked — no real git calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isValidGitHubUrl } from '../clone-repo.js';

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
// So the mock must be synchronous and return a value (or throw).
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

  it('returns SIZE_EXCEEDED and cleans up when repo exceeds the size limit', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/last-rites-clone-xyz');
    execFileSucceeds();

    // Single 200-byte file inside the clone.
    mockReaddir.mockResolvedValue([
      { name: 'bigfile.ts', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    mockLstat.mockResolvedValue({ size: 200 } as Awaited<ReturnType<typeof fsp.lstat>>);

    // maxBytes = 100 → 200-byte file exceeds the limit.
    const result = await cloneRepo('https://github.com/owner/repo', 100);

    expect(result).toEqual({ ok: false, error: 'SIZE_EXCEEDED' });
    expect(mockRm).toHaveBeenCalledWith('/tmp/last-rites-clone-xyz', {
      recursive: true,
      force: true,
    });
  });

  it('returns { ok: true, path } on a successful clone within the size limit', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/last-rites-clone-ok');
    execFileSucceeds();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReaddir.mockResolvedValue([] as any); // empty directory → 0 bytes

    const result = await cloneRepo('https://github.com/owner/repo');

    expect(result).toEqual({ ok: true, path: '/tmp/last-rites-clone-ok' });
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('skips symlinks when computing directory size', async () => {
    mockMkdtemp.mockResolvedValue('/tmp/last-rites-clone-sym');
    execFileSucceeds();

    // One symlink entry pointing to an enormous target — must be skipped.
    mockReaddir.mockResolvedValue([
      { name: 'link.ts', isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    // lstat must never be called for a symlink.
    mockLstat.mockRejectedValue(new Error('lstat should not be called for symlinks'));

    // maxBytes = 1; if symlink were followed, SIZE_EXCEEDED would fire.
    const result = await cloneRepo('https://github.com/owner/repo', 1);

    expect(result).toEqual({ ok: true, path: '/tmp/last-rites-clone-sym' });
  });
});
