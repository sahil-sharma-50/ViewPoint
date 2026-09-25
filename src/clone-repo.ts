/**
 * src/clone-repo.ts — Clone a public GitHub repository to a temporary directory.
 *
 * Contract:
 *   - URL must be HTTPS, hostname exactly "github.com", with owner/repo path segments.
 *   - Uses execFile (no shell) with a hard timeout.
 *   - Creates a unique temporary directory per clone.
 *   - Enforces a source size limit (bytes, no symlinks) after cloning.
 *   - Cleans up the temporary directory on any failure.
 *   - Returns a discriminated union — never throws.
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CloneResult } from './types.js';

const execFile = promisify(_execFile);

/** Maximum total source size in bytes (default: 500 MB). */
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

/** git clone timeout in milliseconds (default: 120 s). */
const CLONE_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/**
 * Returns true when `raw` is a valid clonable GitHub repository URL:
 *   - scheme: https
 *   - hostname: exactly github.com
 *   - pathname: /<owner>/<repo> (exactly two non-empty segments)
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

  // Strip trailing slash, then check for exactly two path segments.
  const segments = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  if (segments.length !== 2) return false;

  // Neither owner nor repo may be empty (already guaranteed by filter, but be explicit).
  const [owner, repo] = segments;
  if (!owner || !repo) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Size computation (no symlinks)
// ---------------------------------------------------------------------------

async function computeDirectorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // skip symlinks
    if (entry.isDirectory()) {
      total += await computeDirectorySize(full);
    } else if (entry.isFile()) {
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

  // Create a unique temp directory for this clone.
  const cloneRoot = await mkdtemp(join(tmpdir(), 'last-rites-clone-'));

  try {
    // Clone without a shell; timeout guards against hanging.
    await execFile('git', ['clone', '--depth=1', repoUrl, cloneRoot], {
      timeout: CLONE_TIMEOUT_MS,
    });
  } catch {
    await rm(cloneRoot, { recursive: true, force: true });
    return { ok: false, error: 'CLONE_FAILED' };
  }

  // Enforce size limit (without following symlinks).
  let totalBytes: number;
  try {
    totalBytes = await computeDirectorySize(cloneRoot);
  } catch {
    await rm(cloneRoot, { recursive: true, force: true });
    return { ok: false, error: 'CLONE_FAILED' };
  }

  if (totalBytes > maxBytes) {
    await rm(cloneRoot, { recursive: true, force: true });
    return { ok: false, error: 'SIZE_EXCEEDED' };
  }

  return { ok: true, path: cloneRoot };
}
