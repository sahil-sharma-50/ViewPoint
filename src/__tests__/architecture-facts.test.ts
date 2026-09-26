import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArchitecture } from '../architecture.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function architecture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'viewpoint-facts-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), text);
  }
  return buildArchitecture(root, { nodes: [], edges: [] });
}

it('matches local HTTP routes by method without choosing an ambiguous server', async () => {
  const facts = await architecture({
    'a.ts': 'import express from "express"; const app = express(); app.get("/items", () => {}); app.get("/ambiguous", () => {});',
    'b.ts': 'import express from "express"; const app = express(); app.post("/items", () => {}); app.get("/ambiguous", () => {});',
    'client.ts': 'fetch("/items#detail"); fetch("/items", {method:"POST"}); fetch("/items", {method:"DELETE"}); fetch("/ambiguous");',
  });
  expect(facts.calls.map(call => call.target)).toEqual(['a.ts', 'b.ts', undefined, undefined]);
});

it('does not turn external URL constructors or shadowed constants into local requests', async () => {
  const facts = await architecture({
    'app/api/items/route.ts': 'export function GET() {}',
    'client.ts': 'const endpoint = "/api/items"; fetch(new URL("/api/items", "https://external.example")); function load(endpoint: string) { fetch(endpoint); } let mutable = "/api/items"; mutable = "/other"; fetch(mutable);',
  });
  expect(facts.calls.map(call => call.target)).toEqual([undefined, undefined, undefined]);
  expect(facts.calls[0]?.url).toBe('https://external.example/api/items');
});

it('keeps observed state setter values bound to their declaration', async () => {
  const facts = await architecture({
    'state.tsx': `import { useState } from 'react';
      function First() { const [phase, setPhase] = useState('idle'); function finish() { setPhase('done'); } }
      function unrelated(setPhase: (s: string) => void) { setPhase('wrong'); }
      function Second() { const [phase, setPhase] = useState('closed'); setPhase('open'); }`,
  });
  expect(facts.states).toEqual([
    { file: 'state.tsx', name: 'phase', initial: 'idle', values: ['done'] },
    { file: 'state.tsx', name: 'phase', initial: 'closed', values: ['open'] },
  ]);
});

it('reads Next root API routes and omits route groups from URLs', async () => {
  const facts = await architecture({
    'app/api/route.ts': 'export function GET() {}',
    'app/api/(public)/items/route.ts': 'export function POST() {}',
    'client.ts': 'fetch("/api"); fetch("/api/items", {method:"POST"}); fetch("/api/items");',
  });
  expect(facts.calls.map(call => call.target)).toEqual(['app/api/route.ts', 'app/api/(public)/items/route.ts', undefined]);
});

it('does not invent GET methods from computed fetch options', async () => {
  const facts = await architecture({
    'app/api/route.ts': 'export function GET() {}',
    'client.ts': 'fetch("/api", options); fetch("/api", {method:verb}); fetch("/api", {...options});',
  });
  expect(facts.calls.map(call => call.target)).toEqual([undefined, undefined, undefined]);
  expect(facts.calls.every(call => call.method === 'UNKNOWN')).toBe(true);
});

it('recognizes server receivers by their imported factory and keeps unmounted routers unresolved', async () => {
  const facts = await architecture({
    'server.ts': 'import express from "express"; const application = express(); application.get("/real", () => {}); const router = express.Router(); router.get("/partial", () => {}); const app = new Map(); app.get("/fake");',
    'client.ts': 'fetch("/real"); fetch("/partial"); fetch("/fake");',
  });
  expect(facts.calls.map(call => call.target)).toEqual(['server.ts', undefined, undefined]);
  expect(facts.routes.some(route => route.url === '/fake')).toBe(false);
});

it('ignores lookalike state APIs and finds setters declared after their callbacks', async () => {
  const facts = await architecture({
    'state.tsx': `import { useState as state } from 'react';
      function App() { function finish() { setPhase('done'); } const [phase, setPhase] = state('idle'); }
      const other = { useState: () => [] }; const [fake, setFake] = other.useState('no'); setFake('wrong');`,
  });
  expect(facts.states).toEqual([{ file: 'state.tsx', name: 'phase', initial: 'idle', values: ['done'] }]);
});

it('reads Docker base images with build platform options', async () => {
  const facts = await architecture({ 'Dockerfile': 'FROM --platform=$BUILDPLATFORM node:22 AS build\nFROM build AS release\n' });
  expect(facts.deployments.map(fact => fact.target)).toEqual(['node:22', 'build']);
});
