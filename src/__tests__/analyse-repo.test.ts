/**
 * src/__tests__/analyse-repo.test.ts
 *
 * Integration tests for buildGraph() against the demo/ fixture.
 *
 * Plan acceptance criteria (last-rites-plan.md § Task 3):
 *   - newDashboard: certainty === 'candidate', fanIn === 0, isSoleExport === true
 *   - legacyExport: certainty === 'candidate', fanIn === 0, isSoleExport === true
 *   - darkMode:     certainty === 'unsafe',    fanIn === 1, evidence references index.ts
 *   - formatDate:   certainty === 'unsafe',    fanIn === 3
 *   - Entry-point:  file declared in package.json "main" → classified 'unknown'
 *
 * These tests run against the real demo/ directory on disk (no mocks needed).
 * The entry-point test uses a self-contained temp-dir fixture.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { buildGraph } from '../analyse-repo.js';
import type { ExportGraph, ExportNode } from '../types.js';

// ---------------------------------------------------------------------------
// Resolve the demo/ directory relative to this test file.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
// test lives at src/__tests__/; demo lives at demo/ (workspace root)
const DEMO_PATH = path.resolve(__dirname, '../../demo');

// ---------------------------------------------------------------------------
// Helper: find a node by matching the file path suffix and export name.
// ---------------------------------------------------------------------------

function findNode(graph: ExportGraph, fileFragment: string, exportName: string): ExportNode | undefined {
  for (const node of graph.nodes.values()) {
    if (node.file.includes(fileFragment) && node.name === exportName) {
      return node;
    }
  }
  return undefined;
}

/** Collect all distinct node.file values from the graph. */
function allNodeFiles(graph: ExportGraph): Set<string> {
  const files = new Set<string>();
  for (const node of graph.nodes.values()) {
    files.add(node.file);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Shared graph fixture — built once for all tests in this file.
// ---------------------------------------------------------------------------

let graph: ExportGraph;

beforeAll(async () => {
  const result = await buildGraph(DEMO_PATH);
  if (!result.ok) {
    throw new Error(`buildGraph failed: ${result.error}`);
  }
  graph = result.graph;
});

// ---------------------------------------------------------------------------
// Graph structure sanity checks
// ---------------------------------------------------------------------------

describe('buildGraph — graph structure', () => {
  it('returns ok:true for the demo repo', async () => {
    const result = await buildGraph(DEMO_PATH);
    expect(result.ok).toBe(true);
  });

  it('graph.nodes is non-empty', () => {
    expect(graph.nodes.size).toBeGreaterThan(0);
  });

  it('every edge source exists as a node file', () => {
    const nodeFiles = allNodeFiles(graph);
    for (const [source] of graph.edges) {
      expect(nodeFiles.has(source)).toBe(true);
    }
  });

  it('every edge target exists as a node file', () => {
    const nodeFiles = allNodeFiles(graph);
    for (const [, targets] of graph.edges) {
      for (const target of targets) {
        expect(nodeFiles.has(target)).toBe(true);
      }
    }
  });

  it('index.ts → darkMode.ts edge exists', () => {
    // index.ts imports darkMode; confirm the directed edge is present.
    const nodeFiles = allNodeFiles(graph);
    const indexFile = [...nodeFiles].find((f) => f.endsWith('index.ts'));
    const darkFile = [...nodeFiles].find((f) => f.includes('darkMode'));
    expect(indexFile).toBeDefined();
    expect(darkFile).toBeDefined();

    const targets = graph.edges.get(indexFile!);
    expect(targets).toBeDefined();
    expect(targets!.has(darkFile!)).toBe(true);
  });

  it('index.ts has a node even though it exports nothing', () => {
    const nodeFiles = allNodeFiles(graph);
    expect([...nodeFiles].some((f) => f.endsWith('index.ts'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// newDashboard.ts — unused candidate
// ---------------------------------------------------------------------------

describe('newDashboard.ts', () => {
  it('has certainty === "candidate"', () => {
    const node = findNode(graph, 'newDashboard', 'renderDashboard');
    expect(node).toBeDefined();
    expect(node!.certainty).toBe('candidate');
  });

  it('has fanIn === 0', () => {
    const node = findNode(graph, 'newDashboard', 'renderDashboard');
    expect(node!.fanIn).toBe(0);
  });

  it('has isSoleExport === true', () => {
    const node = findNode(graph, 'newDashboard', 'renderDashboard');
    expect(node!.isSoleExport).toBe(true);
  });

  it('evidence includes no-internal-refs', () => {
    const node = findNode(graph, 'newDashboard', 'renderDashboard');
    expect(node!.evidence.some((e) => e.kind === 'no-internal-refs')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// legacyExport.ts — unused candidate
// ---------------------------------------------------------------------------

describe('legacyExport.ts', () => {
  it('has certainty === "candidate"', () => {
    const node = findNode(graph, 'legacyExport', 'generateLegacyExport');
    expect(node).toBeDefined();
    expect(node!.certainty).toBe('candidate');
  });

  it('has fanIn === 0', () => {
    const node = findNode(graph, 'legacyExport', 'generateLegacyExport');
    expect(node!.fanIn).toBe(0);
  });

  it('has isSoleExport === true', () => {
    const node = findNode(graph, 'legacyExport', 'generateLegacyExport');
    expect(node!.isSoleExport).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// darkMode.ts — has internal consumer (index.ts)
// ---------------------------------------------------------------------------

describe('darkMode.ts', () => {
  it('has certainty === "unsafe"', () => {
    const node = findNode(graph, 'darkMode', 'toggleDarkMode');
    expect(node).toBeDefined();
    expect(node!.certainty).toBe('unsafe');
  });

  it('has fanIn === 1', () => {
    const node = findNode(graph, 'darkMode', 'toggleDarkMode');
    expect(node!.fanIn).toBe(1);
  });

  it('evidence detail references index.ts', () => {
    const node = findNode(graph, 'darkMode', 'toggleDarkMode');
    const internalRefEvidence = node!.evidence.filter((e) => e.kind === 'internal-ref');
    expect(internalRefEvidence.length).toBeGreaterThan(0);
    expect(internalRefEvidence.some((e) => e.detail.includes('index.ts'))).toBe(true);
  });

  it('evidence detail includes a line number', () => {
    const node = findNode(graph, 'darkMode', 'toggleDarkMode');
    const ev = node!.evidence.find((e) => e.kind === 'internal-ref' && e.detail.includes('index.ts'));
    expect(ev).toBeDefined();
    // Detail should be like "imported by src/index.ts:8"
    expect(/:\d+$/.test(ev!.detail)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatDate.ts — shared dependency, imported by 3 files
// ---------------------------------------------------------------------------

describe('formatDate.ts', () => {
  it('has certainty === "unsafe"', () => {
    const node = findNode(graph, 'formatDate', 'formatDate');
    expect(node).toBeDefined();
    expect(node!.certainty).toBe('unsafe');
  });

  it('has fanIn === 3', () => {
    const node = findNode(graph, 'formatDate', 'formatDate');
    expect(node!.fanIn).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Entry-point protection — self-contained temp-dir fixture.
//
// We create a minimal repo with:
//   package.json  { "main": "dist/lib.js" }
//   tsconfig.json { "include": ["src"] }
//   src/lib.ts    export function hello() {}
//
// buildGraph should classify lib.ts as isEntryPoint=true and certainty='unknown'.
// ---------------------------------------------------------------------------

let epFixtureDir = '';

beforeAll(() => {
  epFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-rites-ep-'));

  // package.json — declares dist/lib.js as the main entry point
  fs.writeFileSync(
    path.join(epFixtureDir, 'package.json'),
    JSON.stringify({ name: 'ep-fixture', main: 'dist/lib.js' }),
  );

  // tsconfig.json
  fs.writeFileSync(
    path.join(epFixtureDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        strict: true,
        rootDir: 'src',
        outDir: 'dist',
        skipLibCheck: true,
      },
      include: ['src'],
    }),
  );

  // src/lib.ts — the entry-point source file
  fs.mkdirSync(path.join(epFixtureDir, 'src'));
  fs.writeFileSync(
    path.join(epFixtureDir, 'src', 'lib.ts'),
    'export function hello(): string { return "hello"; }\n',
  );
});

afterAll(() => {
  if (epFixtureDir) {
    fs.rmSync(epFixtureDir, { recursive: true, force: true });
  }
});

describe('entry-point protection', () => {
  it('demo package.json has no entry-point fields → no nodes classified unknown via entry-point', () => {
    for (const node of graph.nodes.values()) {
      expect(node.evidence.filter((e) => e.kind === 'entry-point')).toHaveLength(0);
    }
  });

  it('file declared in package.json "main" is classified unknown, not candidate', async () => {
    const result = await buildGraph(epFixtureDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // src/lib.ts is declared via "main": "dist/lib.js" → must be unknown, not candidate
    const libNodes = Array.from(result.graph.nodes.values()).filter(
      (n) => n.file.endsWith('lib.ts'),
    );
    expect(libNodes.length).toBeGreaterThan(0);
    for (const node of libNodes) {
      expect(node.isEntryPoint).toBe(true);
      expect(node.certainty).toBe('unknown');
      expect(node.certainty).not.toBe('candidate');
      expect(node.evidence.some((e) => e.kind === 'entry-point')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Node IDs are consistent with edges
// ---------------------------------------------------------------------------

describe('node/edge consistency', () => {
  it('every node ID follows the pattern <file>#<name>', () => {
    for (const [id, node] of graph.nodes) {
      expect(id).toBe(`${node.file}#${node.name}`);
    }
  });

  it('node.file values are repo-relative (no leading slash)', () => {
    for (const node of graph.nodes.values()) {
      expect(node.file.startsWith('/')).toBe(false);
      expect(node.file.startsWith('\\')).toBe(false);
    }
  });
});
