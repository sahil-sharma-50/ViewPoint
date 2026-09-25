/**
 * src/clone-repo.ts — Clone a public GitHub repository to a temporary directory.
 *
 * Contract:
 *   - URL must use HTTPS, hostname exactly "github.com", and carry exactly two
 *     non-empty path segments (<owner>/<repo>).
 *   - URL must not contain credentials (user:pass@), query strings, or fragments.
 *   - A canonical URL (https://github.com/<owner>/<repo>) is constructed from
 *     the validated parts and passed to Git — never the raw user string.
 *   - Uses execFile (no shell) with a hard timeout.
 *   - Creates a unique temporary directory per clone; failure to create it
 *     returns CLONE_FAILED rather than throwing.
 *   - Enforces a TypeScript source size limit (*.ts / *.tsx bytes, no symlinks).
 *   - Cleans up the temporary directory on any failure (best-effort; rm errors
 *     are swallowed so cleanup never masks the real error).
 *   - Returns a discriminated union — never throws.
 *
 * Size limit:
 *   The default cap is 50 MB of TypeScript source (*.ts / *.tsx), matching the
 *   plan specification. Only regular files with those extensions are counted;
 *   symlinks and all other file types are ignored.
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, lstat, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import type { CloneResult } from './types.js';

const execFile = promisify(_execFile);

/** Maximum total TypeScript source size in bytes (50 MB, per plan specification). */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/** git clone timeout in milliseconds (120 s). */
const CLONE_TIMEOUT_MS = 120_000;

/** File extensions counted toward the TypeScript source size limit. */
const TS_EXTENSIONS = new Set(['.ts', '.tsx']);

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/**
 * Returns true when `raw` is a clonable GitHub repository URL that meets all
 * constraints:
 *   - Scheme: https (not http, not git+https, etc.)
 *   - No embedded credentials (user:pass@host)
 *   - Hostname: exactly github.com
 *   - Pathname: exactly /<owner>/<repo> — two non-empty segments
 *   - No query string
 *   - No fragment
 */
export function isValidGitHubUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  if (url.hostname !== 'github.com') return false;

  // Reject embedded credentials.
  if (url.username !== '' || url.password !== '') return false;

  // Reject query strings and fragments.
  if (url.search !== '') return false;
  if (url.hash !== '') return false;

  // Pathname must be exactly /<owner>/<repo> (strip trailing slash first).
  const segments = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  if (segments.length !== 2) return false;

  const [owner, repo] = segments;
  if (!owner || !repo) return false;

  return true;
}

/**
 * Build the canonical HTTPS clone URL from a validated owner/repo pair.
 * Always returns https://github.com/<owner>/<repo> — no trailing slash,
 * no credentials, no query, no fragment.
 */
export function canonicalGitHubUrl(raw: string): string {
  const url = new URL(raw);
  const [owner, repo] = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  return `https://github.com/${owner}/${repo}`;
}

// ---------------------------------------------------------------------------
// TypeScript source size computation (no symlinks, *.ts / *.tsx only)
// ---------------------------------------------------------------------------

export async function computeTsSourceSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow symlinks
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await computeTsSourceSize(full);
    } else if (entry.isFile() && TS_EXTENSIONS.has(extname(entry.name))) {
      const st = await lstat(full);
      total += st.size;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function cloneRepo(
  repoUrl: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<CloneResult> {
  if (!isValidGitHubUrl(repoUrl)) {
    return { ok: false, error: 'INVALID_URL' };
  }

  // Build a canonical URL so Git never receives raw user input.
  const cloneUrl = canonicalGitHubUrl(repoUrl);

  // Create a unique temp directory; if mkdtemp itself fails, return CLONE_FAILED.
  let cloneRoot: string;
  try {
    cloneRoot = await mkdtemp(join(tmpdir(), 'last-rites-clone-'));
  } catch {
    return { ok: false, error: 'CLONE_FAILED' };
  }

  // Clone without a shell; timeout guards against hanging.
  try {
    await execFile('git', ['clone', '--depth=1', cloneUrl, cloneRoot], {
      timeout: CLONE_TIMEOUT_MS,
    });
  } catch {
    // Best-effort cleanup — swallow rm errors so they don't mask the real error.
    await rm(cloneRoot, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: 'CLONE_FAILED' };
  }

  // Enforce TypeScript source size limit (no symlinks).
  let tsBytes: number;
  try {
    tsBytes = await computeTsSourceSize(cloneRoot);
  } catch {
    await rm(cloneRoot, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: 'CLONE_FAILED' };
  }

  if (tsBytes > maxBytes) {
    await rm(cloneRoot, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: 'SIZE_EXCEEDED' };
  }

  return { ok: true, path: cloneRoot };
}
