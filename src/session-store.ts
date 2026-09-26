/**
 * src/session-store.ts — In-memory session store for ViewPoint server.
 *
 * Each session holds the clone result, file graph, and architecture facts.
 *
 * Completed sessions have best-effort snapshots for process restarts.
 * IDs are random UUID v4 strings.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExportGraph } from './types.js';
import type { Architecture } from './architecture.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionState {
  status?: 'cloning' | 'analysing' | 'complete' | 'error';
  error?: string;
  expiresAt?: number;
  /** Absolute path to the cloned repository on disk. */
  repoPath: string;
  /** Serialisable URL of the repository (used for display only). */
  repoUrl: string;
  /** Built export graph — populated after /analyse completes. */
  graph?: ExportGraph;
  architecture?: Architecture;
  architectureError?: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const sessions = new Map<string, SessionState>();
const timers = new Map<string, NodeJS.Timeout>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const storeDir = path.join(os.tmpdir(), 'viewpoint-sessions');
syncFs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });

// Recover completed sessions after a process restart on the same server disk.
for (const file of syncFs.readdirSync(storeDir)) {
  if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
  try {
    const data = JSON.parse(syncFs.readFileSync(path.join(storeDir, file), 'utf8'));
    const id = file.slice(0, -5);
    const graph = data.graph ? { analysisVersion: data.graph.analysisVersion, ...(data.graph.warnings?.length ? { warnings: data.graph.warnings } : {}), nodes: new Map(data.graph.nodes), edges: new Map<string, Set<string>>(data.graph.edges.map(([key, values]: [string, string[]]) => [key, new Set(values)])) } : undefined;
    sessions.set(id, { ...data, graph });
    const remaining = (data.expiresAt ?? 0) - Date.now();
    if (remaining <= 0) void deleteSession(id).catch(() => undefined);
    else {
      const timer = setTimeout(() => { void deleteSession(id).catch(() => undefined); }, remaining);
      timer.unref();
      timers.set(id, timer);
    }
  } catch { /* Ignore corrupt snapshots; never trust them as an analysis result. */ }
}

/** Create a new session and return its ID. */
export function createSession(repoPath: string, repoUrl: string): string {
  const id = crypto.randomUUID();
  sessions.set(id, { repoPath, repoUrl, expiresAt: Date.now() + SESSION_TTL_MS });
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
    const state = { ...existing, ...patch };
    sessions.set(id, state);
    if (state.graph) {
      const snapshot = { ...state, graph: { analysisVersion: state.graph.analysisVersion, ...(state.graph.warnings?.length ? { warnings: state.graph.warnings } : {}), nodes: [...state.graph.nodes], edges: [...state.graph.edges].map(([key, values]) => [key, [...values]]) } };
      const target = path.join(storeDir, id + '.json');
      try {
        syncFs.writeFileSync(target + '.tmp', JSON.stringify(snapshot), { mode: 0o600 });
        syncFs.renameSync(target + '.tmp', target);
      } catch {
        console.warn('Could not persist analysis session; recent results are available until server restart.');
      }
    }
  }
}

/** Expire a session and remove only cloneRepo's temporary directory. */
export async function deleteSession(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  clearTimeout(timers.get(id));
  timers.delete(id);
  await fs.rm(path.join(storeDir, id + '.json'), { force: true });

  const clonePath = path.resolve(session.repoPath);
  if (path.dirname(clonePath) === path.resolve(os.tmpdir()) &&
      path.basename(clonePath).startsWith('viewpoint-clone-')) {
    await fs.rm(clonePath, { recursive: true, force: true });
  }
}
