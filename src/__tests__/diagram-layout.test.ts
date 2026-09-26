import { expect, it } from 'vitest';
// @ts-expect-error The browser layout helper is JavaScript.
import { directConnections, layoutDiagram, smoothRoute } from '../../app/architecture/graph-layout.js';

it('highlights only direct incoming and outgoing diagram connections', () => {
  const edges = [
    { id: 'a-b', source: 'a', target: 'b' },
    { id: 'c-b', source: 'c', target: 'b' },
    { id: 'c-d', source: 'c', target: 'd' },
  ];
  const connected = directConnections(edges, 'b');
  expect([...connected.edgeIds]).toEqual(['a-b', 'c-b']);
  expect([...connected.nodeIds]).toEqual(['b', 'a', 'c']);
});

it('keeps grouped architecture nodes apart, including cyclic connections', () => {
  const nodes = Array.from({ length: 12 }, (_, index) => ({ id: `n${index}` }));
  const edges = nodes.map((node, index) => ({ id: `e${index}`, source: node.id, target: nodes[(index + 1) % nodes.length]!.id }));
  for (const stacked of [false, true]) {
    const layout = layoutDiagram(nodes, edges, stacked);
    const points = [...layout.positions.values()];
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!; const b = points[j]!;
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
    expect(layout.routes.size).toBe(edges.length);
  }
});

it('rounds routed bends while preserving edge endpoints', () => {
  const path = smoothRoute([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }]);
  expect(path).toMatch(/^M 0 0/);
  expect(path).toContain(' Q 50 0 ');
  expect(path).toMatch(/ L 50 50$/);
});
