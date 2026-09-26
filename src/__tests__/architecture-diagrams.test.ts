import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArchitecture } from '../architecture.js';
// @ts-expect-error Browser view builder is JavaScript.
import { buildDiagramViews } from '../../app/architecture/views.js';

const roots: string[] = [];

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('extracts deployment and state facts and exposes exactly the five requested diagrams', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viewpoint-architecture-'));
  roots.push(root);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'App.tsx'), "import { useState } from 'react'; export function App() { const [phase, setPhase] = useState('idle'); setPhase('ready'); return <main />; }");
  await writeFile(join(root, 'src', 'Flag.tsx'), "import React from 'react'; export function Flag() { const [open, setOpen] = React.useState(false); setOpen(true); return <main />; }");
  await writeFile(join(root, 'Dockerfile'), 'FROM node:20\nCMD ["node", "server.js"]\n');
  await writeFile(join(root, 'compose.yaml'), 'services:\n  web:\n    image: example/web:1\n');
  await writeFile(join(root, 'infra.tf'), 'resource "aws_s3_bucket" "assets" {\n}\n');
  const graph = { nodes: [
    { id: '1', file: 'src/App.tsx', name: 'App', fanIn: 0, fanOut: 1, isEntryPoint: true },
    { id: '2', file: 'src/Flag.tsx', name: 'Flag', fanIn: 1, fanOut: 0, isEntryPoint: false },
  ], edges: [{ source: 'src/App.tsx', targets: ['src/Flag.tsx'] }] };
  const architecture = buildArchitecture(root, graph);
  expect(architecture.deployments).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'Dockerfile', target: 'node:20' })]));
  expect(architecture.deployments).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'compose.yaml', target: 'example/web:1' })]));
  expect(architecture.deployments).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'infra.tf', target: 'aws_s3_bucket.assets' })]));
  expect(architecture.states).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'src/App.tsx', name: 'phase', initial: 'idle', values: ['ready'] })]));
  expect(architecture.states).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'src/Flag.tsx', name: 'open', initial: 'false', values: ['true'] })]));
  const { components, views } = buildDiagramViews(graph, architecture);
  expect(views.map((view: { id: string }) => view.id)).toEqual(['system', 'flow', 'dependencies', 'deployment', 'lifecycle']);
  expect(views[2].edges.map((edge: { source: string; target: string }) => [components.find((node: { id: string }) => node.id === edge.source)?.name, components.find((node: { id: string }) => node.id === edge.target)?.name])).toContainEqual(['src/App.tsx', 'src/Flag.tsx']);
  expect(views[3].edges.length).toBeGreaterThan(0);
  expect(views[4].edges.length).toBeGreaterThan(0);
});

it('shows source modules even when no imports connect them', () => {
  const graph = { nodes: [{ id: 'one', file: 'lib/one.ts', isEntryPoint: false }], edges: [] };
  const { components, views } = buildDiagramViews(graph, { files: [], routes: [], calls: [], states: [], deployments: [] });
  for (const id of ['system', 'dependencies']) {
    const view = views.find((item: { id: string }) => item.id === id);
    expect(view.nodeIds).not.toContain('empty');
    expect(components.filter((item: { id: string }) => view.nodeIds.includes(item.id)).flatMap((item: { files: string[] }) => item.files)).toContain('lib/one.ts');
    expect(view.edges).toEqual([]);
  }
});

it('counts distinct importer-to-imported pairs and reports view truncation', () => {
  const graph = {
    nodes: Array.from({ length: 15 }, (_, index) => ({ id: String(index), file: `lib${index}/one.ts` })),
    edges: [{ source: 'lib0/one.ts', targets: ['lib1/one.ts', 'lib1/one.ts', 'lib2/one.ts'] }],
  };
  const { views } = buildDiagramViews(graph, { files: [], routes: [], calls: [] });
  const system = views.find((item: { id: string }) => item.id === 'system');
  expect(system.edges.map((edge: { count: number }) => edge.count)).toEqual([1, 1]);
  expect(system.totalNodes).toBe(15);
  expect(system.nodeIds).toHaveLength(12);
});

it('shows observed setter values without inventing transitions from the initial value', () => {
  const { components, views } = buildDiagramViews({ nodes: [], edges: [] }, {
    files: [], routes: [], calls: [],
    states: [{ file: 'App.tsx', name: 'phase', initial: 'idle', values: ['idle', 'ready'] }],
  });
  const view = views.find((item: { id: string }) => item.id === 'lifecycle');
  expect(view.edges).toHaveLength(2);
  for (const edge of view.edges) {
    expect(edge.source).not.toBe(edge.target);
    const source = components.find((item: { id: string }) => item.id === edge.source);
    expect(source.name).toContain('initial: idle');
    expect(source.name).not.toBe('phase: idle');
  }
});

it('does not classify unresolved relative or computed HTTP hosts as verified external services', () => {
  const { components, views } = buildDiagramViews({ nodes: [{ file: 'client.ts' }], edges: [] }, {
    files: [], routes: [], calls: [
      { source: 'client.ts', method: 'GET', url: '/api/missing' },
      { source: 'client.ts', method: 'GET', url: 'https://api.*.example.com/data', dynamic: true },
    ],
  });
  const view = views.find((item: { id: string }) => item.id === 'flow');
  for (const edge of view.edges) {
    const target = components.find((item: { id: string }) => item.id === edge.target);
    expect(target.runtime).toBe('unknown');
  }
});

it('only emits HTTP arrows for unshadowed fetch and imported HTTP clients', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viewpoint-http-symbols-'));
  roots.push(root);
  await writeFile(join(root, 'server.ts'), "import express from 'express'; const app = express(); app.get('/api/users', () => {});");
  await writeFile(join(root, 'fake.ts'), `function fetch(key: string) { return new Map().get(key); }
    fetch('/api/users'); const axios = new Map(); axios.get('/api/users');`);
  await writeFile(join(root, 'client.ts'), `import client from 'axios';
    import request from 'node-fetch'; import { fetch as remoteFetch } from 'undici';
    fetch('/api/users'); client.get('/api/users'); request('/api/users'); remoteFetch('/api/users');
    function local(fetch: Function, client: Map<string, string>, request: Function, remoteFetch: Function) {
      fetch('/fake'); client.get('/fake'); request('/fake'); remoteFetch('/fake');
    }`);
  const architecture = buildArchitecture(root, { nodes: [], edges: [] });
  expect(architecture.calls).toEqual(Array.from({ length: 4 }, () => ({
    source: 'client.ts', method: 'GET', url: '/api/users', target: 'server.ts',
  })));
});
