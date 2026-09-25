/**
 * src/session-store.ts — In-memory session store for Last Rites server.
 *
 * Each session holds the clone result (with the temp-dir path) and, once
 * analysis is complete, the ExportGraph.  An optional rehearsal result is
 * stored after /rehearse is called.
 *
 * Sessions are never persisted — they exist only for the lifetime of the
 * server process.  IDs are random UUID v4 strings.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExportGraph, RehearsalResult } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionState {
  /** Absolute path to the cloned repository on disk. */
  repoPath: string;
  /** Serialisable URL of the repository (used for display only). */
  repoUrl: string;
  /** Built export graph — populated after /analyse completes. */
  graph?: ExportGraph;
  /** Most recent rehearsal result — populated after /rehearse completes. */
  rehearsal?: RehearsalResult & { ok: true };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const sessions = new Map<string, SessionState>();
const timers = new Map<string, NodeJS.Timeout>();
const SESSION_TTL_MS = 30 * 60 * 1000;

/** Create a new session and return its ID. */
export function createSession(repoPath: string, repoUrl: string): string {
  const id = crypto.randomUUID();
  sessions.set(id, { repoPath, repoUrl });
  const timer = setTimeout(() => { void deleteSession(id).catch(() => undefined); }, SESSION_TTL_MS);
  timer.unref();
  timers.set(id, timer);
  return id;
}

/** Retrieve a session by ID.  Returns undefined if not found. */
export function getSession(id: string): SessionState | undefined {
  return sessions.get(id);
}

/** Update an existing session (partial).  No-op if session not found. */
export function updateSession(id: string, patch: Partial<SessionState>): void {
  const existing = sessions.get(id);
  if (existing) {
    sessions.set(id, { ...existing, ...patch });
  }
}

/** Expire a session and remove only cloneRepo's temporary directory. */
export async function deleteSession(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  clearTimeout(timers.get(id));
  timers.delete(id);

  const clonePath = path.resolve(session.repoPath);
  if (path.dirname(clonePath) === path.resolve(os.tmpdir()) &&
      path.basename(clonePath).startsWith('last-rites-clone-')) {
    await fs.rm(clonePath, { recursive: true, force: true });
  }
}
