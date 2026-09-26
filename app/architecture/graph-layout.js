import dagre from '@dagrejs/dagre';

export function directConnections(edges, id) {
  const connected = edges.filter(edge => edge.source === id || edge.target === id);
  return {
    edgeIds: new Set(connected.map(edge => edge.id)),
    nodeIds: new Set([id, ...connected.flatMap(edge => [edge.source, edge.target])]),
  };
}

/** Follow Dagre's route while rounding each bend without moving its endpoints. */
export function smoothRoute(points, radius = 30) {
  if (!points.length) return '';
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];
    const incoming = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outgoing = Math.hypot(next.x - corner.x, next.y - corner.y);
    if (!incoming || !outgoing) continue;
    const distance = Math.min(radius, incoming / 2, outgoing / 2);
    const before = { x: corner.x - (corner.x - previous.x) * distance / incoming, y: corner.y - (corner.y - previous.y) * distance / incoming };
    const after = { x: corner.x + (next.x - corner.x) * distance / outgoing, y: corner.y + (next.y - corner.y) * distance / outgoing };
    path += ` L ${before.x} ${before.y} Q ${corner.x} ${corner.y} ${after.x} ${after.y}`;
  }
  return path + ` L ${points.at(-1).x} ${points.at(-1).y}`;
}

/** Layout only the selected, grouped view; Dagre reserves room for every node and edge. */
export function layoutDiagram(nodes, edges, stacked) {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: stacked ? 'TB' : 'LR', nodesep: 34, ranksep: 85, edgesep: 20, marginx: 32, marginy: 32 });
  graph.setDefaultEdgeLabel(() => ({}));
  const width = stacked ? 214 : 190;
  const height = stacked ? 70 : 72;
  for (const node of nodes) graph.setNode(node.id, { width, height });
  for (const edge of edges) graph.setEdge(edge.source, edge.target, {}, edge.id);
  dagre.layout(graph);
  const positions = new Map(nodes.map(node => {
    const point = graph.node(node.id);
    return [node.id, { x: point.x - width / 2, y: point.y - height / 2, width, height }];
  }));
  const routes = new Map(edges.map(edge => [edge.id, graph.edge({ v: edge.source, w: edge.target, name: edge.id }).points]));
  return { width: Math.ceil(graph.graph().width), height: Math.ceil(graph.graph().height), positions, routes };
}
