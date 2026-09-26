import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph } from '../analyse-repo.js';
import { serialiseGraph } from '../server.js';

const roots: string[] = [];
async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'repository-map-test-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('maps import directions including tests', async () => {
  const root = await repository({
    'src/app.ts': 'import { value } from "./shared.js"; import("./lazy.js"); console.log(value);',
    'src/shared.ts': 'export const value = 1;',
    'src/lazy.ts': 'export const lazy = true;',
    'src/app.test.ts': 'import "./app.js";',
    '.env': 'SECRET=hidden',
    'node_modules/ignored.js': 'export {};',
  });
  const result = await buildGraph(root);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const graph = serialiseGraph(result.graph);
  expect(graph.nodes.map(node => node.file)).not.toContain('.env');
  expect(graph.nodes.map(node => node.file)).not.toContain('node_modules/ignored.js');
  expect(graph.edges).toContainEqual({ source: 'src/app.ts', targets: ['src/shared.ts', 'src/lazy.ts'] });
  expect(graph.edges).toContainEqual({ source: 'src/app.test.ts', targets: ['src/app.ts'] });
  expect(graph.nodes.find(node => node.file === 'src/app.ts')?.fanIn).toBe(1);
});

it('keeps inventory files visible even without imports', async () => {
  const root = await repository({ 'README.md': '# Project', 'src/main.ts': 'console.log("hello")' });
  const result = await buildGraph(root);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.graph.nodes.has('README.md')).toBe(true);
  expect(result.graph.nodes.get('src/main.ts')?.isEntryPoint).toBe(true);
});

it('maps TypeScript import-equals and type imports', async () => {
  const root = await repository({
    'main.ts': 'import value = require("./value"); type Value = import("./types").Value;',
    'value.ts': 'export = 1;',
    'types.ts': 'export interface Value { id: string }',
  });
  const result = await buildGraph(root);
  expect(result.ok).toBe(true);
  if (result.ok) expect([...result.graph.edges.get('main.ts')!].sort()).toEqual(['types.ts', 'value.ts']);
});

it('maps Go package imports without inventing connections between package peers', async () => {
  const root = await repository({
    'go.mod': 'module example.com/project\n\ngo 1.22\n',
    'main.go': 'package main\nimport "example.com/project/service"\nfunc main() { service.Run() }',
    'peer.go': 'package main\nfunc unused() {}',
    'service/run.go': 'package service\nfunc Run() {}',
    'service/run_test.go': 'package service\nfunc TestRun() {}',
  });
  const result = await buildGraph(root);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect([...result.graph.edges.get('main.go')!]).toEqual(['service/run.go']);
    expect([...result.graph.edges.get('peer.go')!]).toEqual([]);
  }
});

it('resolves Java imports from declared packages and types', async () => {
  const root = await repository({
    'src/main/java/com/example/Main.java': 'package com.example; import com.example.lib.Value; import static com.example.lib.Value.ID; class Main {}',
    'src/main/java/com/example/lib/Value.java': 'package com.example.lib; public class Value { public static int ID = 1; }',
    'src/main/java/com/example/lib/ValueExtra.java': 'package com.example.lib; public class ValueExtra {}',
  });
  const result = await buildGraph(root);
  expect(result.ok).toBe(true);
  if (result.ok) expect([...result.graph.edges.get('src/main/java/com/example/Main.java')!]).toEqual(['src/main/java/com/example/lib/Value.java']);
});

it('does not resolve Python relative imports beyond the top-level package', async () => {
  const root = await repository({
    'pkg/__init__.py': '',
    'pkg/main.py': 'from ..unrelated import value\nfrom . import local\n',
    'pkg/local.py': 'value = 1',
    'unrelated.py': 'value = 2',
  });
  const result = await buildGraph(root);
  expect(result.ok).toBe(true);
  if (result.ok) expect([...result.graph.edges.get('pkg/main.py')!]).toEqual(['pkg/__init__.py', 'pkg/local.py']);
});
