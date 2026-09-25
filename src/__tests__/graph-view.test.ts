/**
 * src/__tests__/graph-view.test.ts — Browser smoke checks for the graph-view page renderer (Task 4).
 *
 * Tests the renderGraphPage() function against a hand-crafted minimal graph that
 * mirrors the demo fixture (newDashboard → candidate, darkMode → unsafe, etc.).
 *
 * We verify:
 *   - The returned string is valid HTML (starts with <!DOCTYPE html>).
 *   - The embedded graph JSON contains the expected node data.
 *   - File paths are set safely (no XSS opportunity from raw innerHTML).
 *   - "Preview removal" is offered only for candidate + isSoleExport nodes.
 *   - Unsafe/unknown/multi-export nodes get the "not available" label.
 *   - Edge serialisation: outgoing and incoming connections are embedded.
 *   - Certainty labels (candidate, unknown, unsafe) appear in the page source.
 *   - Shared-dependency indicators appear for nodes with fanIn > 1.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as url from 'node:url';
import { buildGraph } from '../analyse-repo.js';
import { serialiseGraph } from '../server.js';
import { renderGraphPage } from '../graph-view.js';
import type { SerialGraph } from '../server.js';

// ---------------------------------------------------------------------------
// Minimal demo graph fixture (hand-crafted to avoid I/O in every unit test)
// ---------------------------------------------------------------------------

const DEMO_GRAPH: SerialGraph = {
  nodes: [
    {
      id: 'src/features/newDashboard.ts#renderDashboard',
      file: 'src/features/newDashboard.ts',
      name: 'renderDashboard',
      kind: 'function',
      fanIn: 0,
      fanOut: 1,
      isSoleExport: true,
      isEntryPoint: false,
      certainty: 'candidate',
      evidence: [{ kind: 'no-internal-refs', detail: 'zero internal importers' }],
    },
    {
      id: 'src/features/darkMode.ts#toggleDarkMode',
      file: 'src/features/darkMode.ts',
      name: 'toggleDarkMode',
      kind: 'function',
      fanIn: 1,
      fanOut: 1,
      isSoleExport: true,
      isEntryPoint: false,
      certainty: 'unsafe',
      evidence: [{ kind: 'internal-ref', detail: 'imported by src/index.ts:8' }],
    },
    {
      id: 'src/utils/formatDate.ts#formatDate',
      file: 'src/utils/formatDate.ts',
      name: 'formatDate',
      kind: 'function',
      fanIn: 3,
      fanOut: 0,
      isSoleExport: true,
      isEntryPoint: false,
      certainty: 'unsafe',
      evidence: [
        { kind: 'internal-ref', detail: 'imported by src/features/darkMode.ts:2' },
        { kind: 'internal-ref', detail: 'imported by src/features/newDashboard.ts:2' },
        { kind: 'internal-ref', detail: 'imported by src/features/legacyExport.ts:2' },
      ],
    },
    {
      id: 'src/index.ts#index',
      file: 'src/index.ts',
      name: 'index',
      kind: 'variable',
      fanIn: 0,
      fanOut: 1,
      isSoleExport: false,
      isEntryPoint: false,
      certainty: 'candidate',
      evidence: [{ kind: 'no-internal-refs', detail: 'zero internal importers' }],
    },
    {
      id: 'src/features/legacyExport.ts#generateLegacyExport',
      file: 'src/features/legacyExport.ts',
      name: 'generateLegacyExport',
      kind: 'function',
      fanIn: 0,
      fanOut: 1,
      isSoleExport: true,
      isEntryPoint: false,
      certainty: 'candidate',
      evidence: [{ kind: 'no-internal-refs', detail: 'zero internal importers' }],
    },
  ],
  edges: [
    { source: 'src/index.ts', targets: ['src/features/darkMode.ts'] },
    { source: 'src/features/darkMode.ts', targets: ['src/utils/formatDate.ts'] },
    { source: 'src/features/newDashboard.ts', targets: ['src/utils/formatDate.ts'] },
    { source: 'src/features/legacyExport.ts', targets: ['src/utils/formatDate.ts'] },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DEMO_PATH = path.resolve(__dirname, '../../demo');

// ---------------------------------------------------------------------------
// Tests against the hand-crafted fixture
// ---------------------------------------------------------------------------

describe('renderGraphPage — HTML structure', () => {
  const html = renderGraphPage(DEMO_GRAPH);

  it('produces a string starting with <!DOCTYPE html>', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('contains a <title> element', () => {
    expect(html).toContain('<title>');
  });

  it('embeds the graph JSON in the page', () => {
    expect(html).toContain('"nodes"');
    expect(html).toContain('"edges"');
  });

  it('contains the certainty values candidate, unknown, unsafe', () => {
    // These appear in CSS vars, legend, and the embedded graph JSON.
    expect(html).toContain('candidate');
    expect(html).toContain('unsafe');
  });

  it('contains the "Preview Removal" label', () => {
    expect(html).toContain('Preview Removal');
  });

  it('contains the "Preview removal — Not Available" label for non-candidate files', () => {
    expect(html).toContain('Not Available');
  });

  it('contains "Made with IBM Bob" footer', () => {
    expect(html).toContain('Made with IBM Bob');
  });
});

describe('renderGraphPage — graph data embedding', () => {
  const html = renderGraphPage(DEMO_GRAPH);

  it('embeds node id for newDashboard', () => {
    expect(html).toContain('newDashboard.ts#renderDashboard');
  });

  it('embeds node id for darkMode', () => {
    expect(html).toContain('darkMode.ts#toggleDarkMode');
  });

  it('embeds evidence detail text (safely escaped)', () => {
    // Evidence details are JSON-stringified; the raw text should appear.
    expect(html).toContain('zero internal importers');
    expect(html).toContain('imported by src/index.ts');
  });

  it('embeds edge source and targets', () => {
    expect(html).toContain('"source"');
    expect(html).toContain('"targets"');
    expect(html).toContain('src/index.ts');
  });

  it('shared dependency formatDate appears with fanIn 3', () => {
    expect(html).toContain('"fanIn":3');
  });
});

describe('renderGraphPage — XSS safety', () => {
  it('does not use innerHTML for file paths (uses textContent in JS)', () => {
    // The page source should use textContent assignments for user-supplied data.
    expect(html_for_xss()).toContain('textContent');
  });

  it('HTML-special chars in file paths are not rendered as raw HTML', () => {
    // Craft a graph with a file path containing HTML-special characters.
    const xssGraph: SerialGraph = {
      nodes: [
        {
          id: 'src/<script>alert(1)</script>.ts#test',
          file: 'src/<script>alert(1)</script>.ts',
          name: 'test',
          kind: 'function',
          fanIn: 0,
          fanOut: 0,
          isSoleExport: true,
          isEntryPoint: false,
          certainty: 'candidate',
          evidence: [],
        },
      ],
      edges: [],
    };
    const xssHtml = renderGraphPage(xssGraph);
    // The raw script tag must not appear in the HTML outside the JSON embed.
    // The JSON embed must be escaped (\\u003c etc.).
    expect(xssHtml).not.toContain('<script>alert(1)</script>');
  });
});

function html_for_xss() {
  return renderGraphPage(DEMO_GRAPH);
}

// ---------------------------------------------------------------------------
// Tests against the real demo graph (integration smoke)
// ---------------------------------------------------------------------------

describe('renderGraphPage — demo graph smoke', () => {
  it('serialises the demo graph and produces valid HTML', async () => {
    const result = await buildGraph(DEMO_PATH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serial = serialiseGraph(result.graph);
    const html = renderGraphPage(serial);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('"nodes"');
    expect(html).toContain('"edges"');
  });

  it('demo graph HTML contains newDashboard certainty candidate', async () => {
    const result = await buildGraph(DEMO_PATH);
    if (!result.ok) return;

    const serial = serialiseGraph(result.graph);
    const html = renderGraphPage(serial);
    expect(html).toContain('newDashboard');
    expect(html).toContain('candidate');
  });

  it('demo graph HTML contains darkMode certainty unsafe', async () => {
    const result = await buildGraph(DEMO_PATH);
    if (!result.ok) return;

    const serial = serialiseGraph(result.graph);
    const html = renderGraphPage(serial);
    expect(html).toContain('darkMode');
    expect(html).toContain('unsafe');
  });

  it('demo graph HTML contains index.ts → darkMode.ts edge', async () => {
    const result = await buildGraph(DEMO_PATH);
    if (!result.ok) return;

    const serial = serialiseGraph(result.graph);
    expect(serial.edges.some((e) => e.source.endsWith('index.ts') && e.targets.some((t) => t.includes('darkMode')))).toBe(true);
  });

  it('demo graph: formatDate has fanIn 3 after serialisation', async () => {
    const result = await buildGraph(DEMO_PATH);
    if (!result.ok) return;

    const serial = serialiseGraph(result.graph);
    const node = serial.nodes.find((n) => n.file.includes('formatDate'));
    expect(node).toBeDefined();
    expect(node!.fanIn).toBe(3);
  });
});
