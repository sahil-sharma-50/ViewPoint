import { expect, it } from 'vitest';
import { buildFolderMap, buildHttpFolderLinks, folderContents, traceDependents } from '../full-map.js';
import { folderRoutePath, layoutFolders } from '../folder-layout.js';
import { mapExplainContext } from '../map-explain.js';
import { serialiseGraph } from '../server.js';
import type { SerialGraph, SerialNode } from '../server.js';
import type { ExportGraph } from '../types.js';

const node = (file: string): SerialNode => ({
  id: file,
  file,
  name: file,
  fanIn: 0,
  fanOut: 0,
  isEntryPoint: false,
});
const graph: SerialGraph = {
  nodes: ['src/a.ts', 'src/sub/b.ts', 'src/app.test.ts', 'lib/c.ts', 'README.md', '.env'].map(node),
  edges: [
    { source: 'src/a.ts', targets: ['lib/c.ts'] },
    { source: 'src/sub/b.ts', targets: ['lib/c.ts'] },
    { source: 'lib/c.ts', targets: ['src/a.ts'] },
  ],
};

it('groups known links by folder and keeps support files behind a toggle', () => {
  const map = buildFolderMap(graph);
  expect(map.folders.map(folder => folder.path)).toEqual(['lib', 'src', 'src/sub']);
  expect(map.links).toContainEqual({ source: 'src', target: 'lib', count: 1 });
  expect(map.links).toContainEqual({ source: 'src/sub', target: 'lib', count: 1 });
  expect(map.links).toContainEqual({ source: 'lib', target: 'src', count: 1 });
  expect(map.files.has('README.md')).toBe(false);
  expect(map.files.has('src/app.test.ts')).toBe(false);
  expect(buildFolderMap(graph, true).files.has('src/app.test.ts')).toBe(true);
  expect(buildFolderMap(graph, true).folders.some(folder => folder.path === '')).toBe(true);
});

it('hides Python and Go test files until support files are enabled', () => {
  const graph: SerialGraph = { nodes: ['api.py', 'test_api.py', 'api_test.py', 'api_test.go', 'api.go'].map(node), edges: [] };
  expect([...buildFolderMap(graph).files.keys()]).toEqual(['api.py', 'api.go']);
  expect(buildFolderMap(graph, true).files.size).toBe(5);
});

it('only draws HTTP links backed by files in the visible folder map', () => {
  const calls = [
    { source: 'src/a.ts', target: 'lib/c.ts', method: 'GET', url: '/api' },
    { source: 'src/app.test.ts', target: 'lib/c.ts', method: 'GET', url: '/api' },
  ];
  expect(buildHttpFolderLinks(buildFolderMap(graph), calls)).toEqual([{ source: 'src', target: 'lib', count: 1 }]);
  expect(buildHttpFolderLinks(buildFolderMap(graph, true), calls)).toEqual([{ source: 'src', target: 'lib', count: 2 }]);
});

it('separates nested web and Python source modules', () => {
  const nested: SerialGraph = {
    nodes: [
      'src/features/voice/speech.ts',
      'web/src/app/page.tsx',
      'web/src/components/Card.tsx',
      'web/src/lib/data.ts',
      'agent/src/lexguard/api/routes.py',
      'agent/src/lexguard/services/orders.py',
    ].map(node),
    edges: [
      { source: 'web/src/app/page.tsx', targets: ['web/src/components/Card.tsx'] },
      { source: 'web/src/components/Card.tsx', targets: ['web/src/lib/data.ts'] },
      { source: 'agent/src/lexguard/api/routes.py', targets: ['agent/src/lexguard/services/orders.py'] },
    ],
  };
  const map = buildFolderMap(nested);
  expect(map.folders.map(folder => folder.path)).toEqual([
    'agent/src/lexguard/api', 'agent/src/lexguard/services',
    'src/features/voice',
    'web/src/app', 'web/src/components', 'web/src/lib',
  ]);
  expect(map.links).toContainEqual({ source: 'web/src/app', target: 'web/src/components', count: 1 });
  expect(map.links).toContainEqual({ source: 'agent/src/lexguard/api', target: 'agent/src/lexguard/services', count: 1 });
});

it('reveals direct children, ranks connected files, and searches beyond the first page', () => {
  const large: SerialGraph = {
    nodes: Array.from({ length: 35 }, (_, index) =>
      node(`src/file${String(index).padStart(2, '0')}.ts`),
    ),
    edges: [{ source: 'src/file34.ts', targets: ['src/file01.ts'] }],
  };
  const map = buildFolderMap(large);
  const first = folderContents(map, 'src', { limit: 30 });
  expect(first.files).toHaveLength(30);
  expect(first.files[0]?.file).toBe('src/file01.ts');
  expect(first.files[1]?.file).toBe('src/file34.ts');
  expect(first.remaining).toBe(5);
  expect(
    folderContents(map, 'src', { limit: 30, query: 'file33' }).files.map(file => file.file),
  ).toContain('src/file33.ts');
});

it('keeps a large repository paged while retaining every searchable file', () => {
  const large: SerialGraph = {
    nodes: Array.from({ length: 3000 }, (_, index) =>
      node(`packages/package${Math.floor(index / 100)}/file${index}.ts`),
    ),
    edges: [],
  };
  const map = buildFolderMap(large);
  expect(map.folders).toHaveLength(30);
  expect(folderContents(map, 'packages/package29').files).toHaveLength(30);
  expect(
    folderContents(map, 'packages/package29', { query: 'file2999' }).files.map(file => file.file),
  ).toEqual(['packages/package29/file2999.ts']);
  expect(layoutFolders(map.folders, map.links, new Set()).cards.size).toBe(30);
});

it('traces direct and transitive dependents without looping on cycles', () => {
  const impact = traceDependents(graph, 'lib/c.ts');
  expect([...impact.direct].sort()).toEqual(['src/a.ts', 'src/sub/b.ts']);
  expect([...impact.transitive].sort()).toEqual(['src/a.ts', 'src/sub/b.ts']);
  expect(impact.transitive.has('lib/c.ts')).toBe(false);
});

it('serializes exact graph paths before suffix matches', () => {
  const a = node('a.ts');
  const nested = node('lib/a.ts');
  const graph: ExportGraph = {
    nodes: new Map([
      [a.id, a],
      [nested.id, nested],
    ]) as ExportGraph['nodes'],
    edges: new Map([['/repo/lib/a.ts', new Set(['/repo/a.ts'])]]),
  };
  expect(serialiseGraph(graph).edges).toEqual([{ source: 'lib/a.ts', targets: ['a.ts'] }]);
});

it('lays out expanded folder cards without overlap even with cyclic links', () => {
  const folders = Array.from({ length: 12 }, (_, index) => ({
    path: `folder${index}`,
    fileCount: 3,
  }));
  const links = folders.map((folder, index) => ({
    source: folder.path,
    target: folders[(index + 1) % folders.length]!.path,
    count: 1,
  }));
  const layout = layoutFolders(folders, links, new Set(['folder3', 'folder8']));
  for (const first of layout.cards.values())
    for (const second of layout.cards.values()) {
      if (first === second) continue;
      expect(
        first.x + first.width <= second.x ||
          second.x + second.width <= first.x ||
          first.y + first.height <= second.y ||
          second.y + second.height <= first.y,
      ).toBe(true);
    }
  for (const link of links) {
    const route = layout.routes.get(`${link.source}\0${link.target}`)!;
    for (let index = 1; index < route.length; index++) {
      const from = route[index - 1]!;
      const to = route[index]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 4));
      for (let step = 1; step < steps; step++) {
        const x = from.x + (to.x - from.x) * step / steps;
        const y = from.y + (to.y - from.y) * step / steps;
        for (const [path, card] of layout.cards) {
          if (path === link.source || path === link.target) continue;
          expect(x > card.x + 2 && x < card.x + card.width - 2 && y > card.y + 2 && y < card.y + card.height - 2).toBe(false);
        }
      }
    }
  }
  expect(folderRoutePath([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }])).toContain(' Q 20 0 ');
});

it('lays out a repository-root cluster alongside source folders', () => {
  const layout = layoutFolders(
    [
      { path: '', fileCount: 1 },
      { path: 'src', fileCount: 8 },
    ],
    [],
    new Set(),
  );
  expect(layout.cards.get('')?.width).toBe(290);
  expect(layout.cards.get('src')?.width).toBe(290);
  const root = layout.cards.get('')!;
  const source = layout.cards.get('src')!;
  expect(source.x - root.x - root.width).toBeGreaterThanOrEqual(95);
});

it('grounds map explanations in existing folders, files, and file links', () => {
  const file = mapExplainContext(graph, { kind: 'file', file: 'src/a.ts' });
  expect(file.ok).toBe(true);
  if (file.ok) expect(file.excerptFiles).toEqual(['src/a.ts']);
  const folder = mapExplainContext(graph, { kind: 'folder', folder: 'src' });
  expect(folder.ok).toBe(true);
  if (folder.ok) expect(folder.evidence.some(item => item.includes('src/a.ts'))).toBe(true);
  const link = mapExplainContext(graph, { kind: 'link', source: 'src', target: 'lib' });
  expect(link.ok).toBe(true);
  if (link.ok) expect(link.evidence).toContain('src/a.ts → lib/c.ts');
  expect(mapExplainContext(graph, { kind: 'file', file: '../../.env' }).ok).toBe(false);
  expect(mapExplainContext(graph, { kind: 'link', source: 'lib', target: 'missing' }).ok).toBe(
    false,
  );
});
