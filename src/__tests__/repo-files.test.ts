import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { listRepoFiles } from '../repo-files.js';
import { buildGraph } from '../analyse-repo.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('omits every dot path and generated dependency folder from inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viewpoint-inventory-'));
  roots.push(root);
  for (const name of ['src/live.ts', 'src/.env.example', '.github/workflows/ci.yml', '.next/cache/file', 'node_modules/pkg/index.js', 'dist/index.js', 'src/.hidden/secret.ts']) {
    const file = join(root, name);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, name);
  }
  expect(listRepoFiles(root).map(file => relative(root, file).replace(/\\/g, '/'))).toEqual(['src/live.ts']);
});

it('shows every tracked regular file, including GitHub dotfiles and generated folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viewpoint-tracked-'));
  roots.push(root);
  execFileSync('git', ['init', root]);
  for (const name of ['.github/workflows/ci.yml', '.env.example', 'dist/bundle.js', 'src/live.ts']) {
    const file = join(root, name);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, name);
  }
  execFileSync('git', ['-C', root, 'add', '--all']);
  await writeFile(join(root, 'untracked.txt'), 'not on GitHub');
  expect(listRepoFiles(root).map(file => relative(root, file).replace(/\\/g, '/'))).toEqual([
    '.env.example', '.github/workflows/ci.yml', 'dist/bundle.js', 'src/live.ts',
  ]);
});

it('does not add imported hidden source files back into the graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viewpoint-inventory-'));
  roots.push(root);
  await mkdir(join(root, 'src', '.private'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'import "./.private/secret.js"; export const live = 1;');
  await writeFile(join(root, 'src', '.private', 'secret.ts'), 'export const hidden = 1;');
  const result = await buildGraph(root);
  expect(result.ok).toBe(true);
  if (result.ok) expect([...result.graph.nodes.values()].map(node => node.file)).toEqual(['src/index.ts']);
});

it('omits tracked files deleted from the checkout without losing the rest of the graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viewpoint-deleted-'));
  roots.push(root);
  execFileSync('git', ['init', root]);
  await writeFile(join(root, 'live.ts'), 'export const live = true;');
  await writeFile(join(root, 'removed.ts'), 'export {};');
  execFileSync('git', ['-C', root, 'add', '--all']);
  await rm(join(root, 'removed.ts'));
  expect(listRepoFiles(root).map(file => relative(root, file))).toEqual(['live.ts']);
});
