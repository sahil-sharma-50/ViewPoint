import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { get, put } from '@vercel/blob';
import type { SavedAnalysis } from './vercel-repo.js';

const pathname = (id: string) => `sessions/${id}.json.gz`;

export async function saveAnalysis(analysis: SavedAnalysis): Promise<string> {
  const id = randomUUID();
  const payload = gzipSync(JSON.stringify(analysis));
  if (payload.length > 4_000_000) throw new Error("Repository map exceeds this deployment's 4 MB session budget.");
  await put(pathname(id), payload, {
    access: 'private', addRandomSuffix: false, contentType: 'application/gzip',
  });
  return id;
}

export async function loadAnalysis(id: string): Promise<SavedAnalysis | undefined> {
  if (!/^[a-f0-9-]{36}$/.test(id)) return undefined;
  const result = await get(pathname(id), { access: 'private' });
  if (result?.statusCode !== 200 || !result.stream) return undefined;
  const bytes = await new Response(result.stream).arrayBuffer();
  const analysis = JSON.parse(gunzipSync(Buffer.from(bytes), { maxOutputLength: 30_000_000 }).toString()) as SavedAnalysis;
  return analysis.expiresAt > Date.now() ? analysis : undefined;
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}
