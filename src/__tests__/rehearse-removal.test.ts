/**
 * src/__tests__/rehearse-removal.test.ts
 *
 * Integration tests for rehearseRemoval() against the demo/ fixture.
 *
 * Plan acceptance criteria (last-rites-plan.md § Task 5):
 *   - Successful newDashboard rehearsal:
 *       result.ok === true
 *       delta.newErrors.length === 0
 *       patchText includes 'newDashboard'
 *       unknownChecks.length === 3
 *   - Ineligible candidate (darkMode, certainty === 'unsafe') returns ok:false
 *   - Node not found in graph returns ok:false
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { buildGraph } from '../analyse-repo.js';
import { rehearseRemoval } from '../rehearse-removal.js';
import type { ExportGraph } from '../types.js';

// ---------------------------------------------------------------------------
// Resolve paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DEMO_PATH = path.resolve(__dirname, '../../demo');

// ---------------------------------------------------------------------------
// Shared graph fixture
// ---------------------------------------------------------------------------

let graph: ExportGraph;

beforeAll(async () => {
  const result = await buildGraph(DEMO_PATH);
  if (!result.ok) {
    throw new Error(`buildGraph failed: ${result.error}`);
  }
  graph = result.graph;
}, 30_000);

// ---------------------------------------------------------------------------
// Helper: find a node in the graph by file fragment and export name
// ---------------------------------------------------------------------------

function findNodeId(fileFragment: string, exportName: string): string | undefined {
  for (const node of graph.nodes.values()) {
    if (node.file.includes(fileFragment) && node.name === exportName) {
      return node.id;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Successful rehearsal — newDashboard.ts (certainty: 'candidate', isSoleExport: true)
// ---------------------------------------------------------------------------

describe('rehearseRemoval — newDashboard (successful candidate)', () => {
  it('returns ok:true', async () => {
    const nodeId = findNodeId('newDashboard', 'renderDashboard');
    expect(nodeId).toBeDefined();

    const result = await rehearseRemoval(
      DEMO_PATH,
      { nodeId: nodeId!, file: 'src/features/newDashboard.ts', name: 'renderDashboard' },
      graph,
    );

    expect(result.ok).toBe(true);
  }, 60_000);

  it('delta.newErrors.length === 0 (no new TS errors introduced)', async () => {
    const nodeId = findNodeId('newDashboard', 'renderDashboard');
    const result = await rehearseRemoval(
      DEMO_PATH,
      { nodeId: nodeId!, file: 'src/features/newDashboard.ts', name: 'renderDashboard' },
      graph,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delta.newErrors).toHaveLength(0);
  }, 60_000);

  it('patchText includes "newDashboard"', async () => {
    const nodeId = findNodeId('newDashboard', 'renderDashboard');
    const result = await rehearseRemoval(
      DEMO_PATH,
      { nodeId: nodeId!, file: 'src/features/newDashboard.ts', name: 'renderDashboard' },
      graph,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patchText).toContain('newDashboard');
    expect(result.patchText).toContain('+++ /dev/null');
  }, 60_000);

  it('unknownChecks.length === 3 with correct kinds', async () => {
    const nodeId = findNodeId('newDashboard', 'renderDashboard');
    const result = await rehearseRemoval(
      DEMO_PATH,
      { nodeId: nodeId!, file: 'src/features/newDashboard.ts', name: 'renderDashboard' },
      graph,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownChecks).toHaveLength(3);

    const kinds = result.unknownChecks.map((c) => c.kind);
    expect(kinds).toContain('test-suite');
    expect(kinds).toContain('build-tool');
    expect(kinds).toContain('runtime-behaviour');
  }, 60_000);

  it('removedFiles contains the candidate file', async () => {
    const nodeId = findNodeId('newDashboard', 'renderDashboard');
    const result = await rehearseRemoval(
      DEMO_PATH,
      { nodeId: nodeId!, file: 'src/features/newDashboard.ts', name: 'renderDashboard' },
      graph,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removedFiles.length).toBe(1);
    expect(result.removedFiles[0]).toContain('newDashboard');
  }, 60_000);

  it('before.diagnosticCount === 0 (demo has no pre-existing TS errors)', async () => {
    const nodeId = findNodeId('newDashboard', 'renderDashboard');
    const result = await rehearseRemoval(
      DEMO_PATH,
      { nodeId: nodeId!, file: 'src/features/newDashboard.ts', name: 'renderDashboard' },
      graph,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.before.diagnosticCount).toBe(0);
  }, 60_000);

  it('after.diagnosticCount === 0 (removal introduces no errors)', async () => {
    const nodeId = findNodeId('newDashboard', 'renderDashboard');
    const result = await rehearseRemoval(
      DEMO_PATH,
      { nodeId: nodeId!, file: 'src/features/newDashboard.ts', name: 'renderDashboard' },
      graph,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.after.diagnosticCount).toBe(0);
  }, 60_000);
});

describe('rehearseRemoval — diagnostic delta and import stripping', () => {
  async function withFixture(source: string, check: (repo: string, graph: ExportGraph, nodeId: string) => Promise<void>) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'last-rites-fixture-'));
    try {
      fs.mkdirSync(path.join(repo, 'src'));
      fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}');
      fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', strict: true },
        include: ['src/**/*'],
      }));
      fs.writeFileSync(path.join(repo, 'src/candidate.ts'), 'export function retire() { return 1; }\n');
      fs.writeFileSync(path.join(repo, 'src/consumer.test.ts'), source);
      fs.writeFileSync(path.join(repo, 'src/broken.ts'), "const n: number = 'existing error';\n");
      const result = await buildGraph(repo);
      if (!result.ok) throw new Error(result.error);
      const node = [...result.graph.nodes.values()].find((n) => n.file === 'src/candidate.ts');
      if (!node) throw new Error('candidate node missing');
      await check(repo, result.graph, node.id);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  it('keeps pre-existing errors out of the delta and removes imports', async () => {
    const source = "import { retire } from './candidate.js';\nexport const present = true;\n";
    await withFixture(source, async (repo, fixtureGraph, nodeId) => {
      const result = await rehearseRemoval(repo, { nodeId, file: '../../spoof.ts', name: 'spoof' }, fixtureGraph);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.before.diagnosticCount).toBe(1);
      expect(result.after.diagnosticCount).toBe(1);
      expect(result.delta.newErrors).toHaveLength(0);
      expect(result.modifiedFiles).toContain('src/consumer.test.ts');
      expect(result.patchText).toContain('+++ /dev/null');
      expect(result.patchText).toContain("-import { retire } from './candidate.js';");
      expect(fs.readFileSync(path.join(repo, 'src/consumer.test.ts'), 'utf8')).toBe(source);
      expect(fs.existsSync(path.join(repo, 'src/candidate.ts'))).toBe(true);
    });
  });

  it('reports references left behind after deleting the import', async () => {
    await withFixture("import { retire } from './candidate.js';\nretire();\n", async (repo, fixtureGraph, nodeId) => {
      const result = await rehearseRemoval(repo, { nodeId, file: 'src/candidate.ts', name: 'retire' }, fixtureGraph);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.delta.newErrors.some((error) => error.code === 2304)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Ineligible candidate — darkMode.ts (certainty: 'unsafe', fanIn: 1)
// ---------------------------------------------------------------------------

describe('rehearseRemoval — darkMode (ineligible: unsafe certainty)', () => {
  it('returns ok:false for a node with certainty "unsafe"', async () => {
    const nodeId = findNodeId('darkMode', 'toggleDarkMode');
    expect(nodeId).toBeDefined();

    const result = await rehearseRemoval(
      DEMO_PATH,
      { nodeId: nodeId!, file: 'src/features/darkMode.ts', name: 'toggleDarkMode' },
      graph,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('NOT_CANDIDATE');
  }, 60_000);
});

it('rejects partial-file removal with NOT_SOLE_EXPORT', async () => {
  const nodeId = findNodeId('newDashboard', 'renderDashboard');
  expect(nodeId).toBeDefined();
  const node = graph.nodes.get(nodeId!);
  expect(node).toBeDefined();
  const restrictedGraph: ExportGraph = {
    ...graph,
    nodes: new Map(graph.nodes).set(nodeId!, { ...node!, isSoleExport: false }),
  };
  const result = await rehearseRemoval(
    DEMO_PATH,
    { nodeId: nodeId!, file: node!.file, name: node!.name },
    restrictedGraph,
  );
  expect(result).toEqual({ ok: false, error: 'NOT_SOLE_EXPORT' });
});

// ---------------------------------------------------------------------------
// Unknown node ID
// ---------------------------------------------------------------------------

describe('rehearseRemoval — unknown nodeId', () => {
  it('returns ok:false when the nodeId does not exist in the graph', async () => {
    const result = await rehearseRemoval(
      DEMO_PATH,
      { nodeId: 'src/nonexistent.ts#nothing', file: 'src/nonexistent.ts', name: 'nothing' },
      graph,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('not found in graph');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// legacyExport.ts — second candidate (also sole-export, fanIn: 0)
// ---------------------------------------------------------------------------

describe('rehearseRemoval — legacyExport (second candidate)', () => {
  it('returns ok:true with delta.newErrors.length === 0', async () => {
    const nodeId = findNodeId('legacyExport', 'generateLegacyExport');
    expect(nodeId).toBeDefined();

    const result = await rehearseRemoval(
      DEMO_PATH,
      { nodeId: nodeId!, file: 'src/features/legacyExport.ts', name: 'generateLegacyExport' },
      graph,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delta.newErrors).toHaveLength(0);
    expect(result.patchText).toContain('legacyExport');
    expect(result.unknownChecks).toHaveLength(3);
  }, 60_000);
});
