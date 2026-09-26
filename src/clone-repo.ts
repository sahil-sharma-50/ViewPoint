import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CloneResult, CloneError } from './types.js';

const execFile = promisify(_execFile);

/** Configurable checkout budget, across all file types (including Git objects). */
export const DEFAULT_MAX_BYTES = (Number(process.env['VIEWPOINT_MAX_REPO_MB']) || 512) * 1024 * 1024;

/** git clone timeout in milliseconds (120 s). */
const CLONE_TIMEOUT_MS = 120_000;

export const cloneErrorMessages: Record<CloneError, string> = {
  INVALID_URL: 'Enter a public GitHub repository URL or owner/repository.',
  CLONE_FAILED: 'The repository could not be downloaded or stored. Check server disk space and retry. This does not mean the repository is private.',
  SIZE_EXCEEDED: 'Repository exceeds the configured checkout budget.',
  REPO_UNAVAILABLE: 'GitHub did not allow anonymous access to this repository. Check that the URL exists and the repository is public. No GitHub sign-in is required or requested.',
  CLONE_TIMEOUT: 'The repository download timed out after 120 seconds. Please retry or check the server connection.',
  NETWORK_ERROR: 'The server could not connect to GitHub reliably. Check its network, proxy, or TLS configuration and retry.',
  GIT_UNAVAILABLE: 'Git is not installed or is unavailable to the server. Install Git and restart the server.',
  CHECKOUT_FAILED: 'Git downloaded the repository but could not write its files. Check disk space, permissions, and filenames supported by this server.',
};

function classifyCloneError(error: unknown): CloneError {
  const failure = error as { code?: string; killed?: boolean; stderr?: string } | null;
  const detail = failure?.stderr ?? '';
  if (failure?.code === 'ENOENT') return 'GIT_UNAVAILABLE';
  if (failure?.killed) return 'CLONE_TIMEOUT';
  if (/repository not found|authentication failed|could not read Username|terminal prompts disabled|returned error: (401|403|404)/i.test(detail)) return 'REPO_UNAVAILABLE';
  if (/could not resolve|failed to connect|connection|SSL|TLS|RPC failed|early EOF|unable to access/i.test(detail)) return 'NETWORK_ERROR';
  if (/checkout failed|invalid path|filename too long|unable to create|unable to write|no space left|permission denied/i.test(detail)) return 'CHECKOUT_FAILED';
  return 'CLONE_FAILED';
}



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
  if (url.hostname !== 'github.com' || url.port) return false;

  // Reject embedded credentials.
  if (url.username !== '' || url.password !== '') return false;

  // Reject query strings and fragments.
  if (url.search !== '') return false;
  if (url.hash !== '') return false;

  // Pathname must be exactly /<owner>/<repo> (strip trailing slash first).
  const segments = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  if (segments.length !== 2) return false;

  const [owner, repo] = segments;
  if (!owner || !repo || !/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || repo === '.' || repo === '..') return false;

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
// checkout size computation (no symlinks, all regular files)
// ---------------------------------------------------------------------------

export async function computeRepoSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow symlinks
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await computeRepoSize(full);
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

  // Build a canonical URL so Git never receives raw user input.
  const cloneUrl = canonicalGitHubUrl(repoUrl);

  // Create a unique temp directory; if mkdtemp itself fails, return CLONE_FAILED.
  let cloneRoot: string;
  try {
    cloneRoot = await mkdtemp(join(tmpdir(), 'viewpoint-clone-'));
  } catch {
    return { ok: false, error: 'CLONE_FAILED' };
  }

  // Clone without a shell; timeout guards against hanging.
  const controller = new AbortController();
  let exceeded = false;
  let checking = false;
  const budgetCheck = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      if (await computeRepoSize(cloneRoot) > maxBytes) { exceeded = true; controller.abort(); }
    } catch { /* Git may rename an object while it is being counted. */ }
    finally { checking = false; }
  }, 2000);
  budgetCheck.unref();
  // Public-only checkout: never inherit credential helpers, URL rewrites or askpass commands.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
    await execFile('git', ['clone', '--depth=1', cloneUrl, cloneRoot], {
      timeout: CLONE_TIMEOUT_MS,
      signal: controller.signal,
      cwd: cloneRoot,
      windowsHide: true,
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1',
        GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'Never',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_COUNT: attempt ? '5' : '4', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'core.askPass', GIT_CONFIG_VALUE_1: '',
        GIT_CONFIG_KEY_2: 'core.longpaths', GIT_CONFIG_VALUE_2: 'true',
        GIT_CONFIG_KEY_3: 'http.extraHeader', GIT_CONFIG_VALUE_3: '',
        ...(attempt ? { GIT_CONFIG_KEY_4: 'http.version', GIT_CONFIG_VALUE_4: 'HTTP/1.1' } : {}),
      },
    });
        break;
      } catch (error) {
        if (attempt || exceeded || classifyCloneError(error) !== 'NETWORK_ERROR') throw error;
        // A transport retry gets a fresh checkout; never reuse partially downloaded objects.
        await rm(cloneRoot, { recursive: true, force: true });
        cloneRoot = await mkdtemp(join(tmpdir(), 'viewpoint-clone-'));
      }
    }
  } catch (error) {
    // Best-effort cleanup — swallow rm errors so they don't mask the real error.
    await rm(cloneRoot, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: exceeded ? 'SIZE_EXCEEDED' : classifyCloneError(error) };
  } finally {
    clearInterval(budgetCheck);
  }

  // Enforce checkout size limit (no symlinks).
  let repoBytes: number;
  try {
    repoBytes = await computeRepoSize(cloneRoot);
  } catch {
    await rm(cloneRoot, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: 'CLONE_FAILED' };
  }

  if (repoBytes > maxBytes) {
    await rm(cloneRoot, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: 'SIZE_EXCEEDED' };
  }

  return { ok: true, path: cloneRoot };
}
