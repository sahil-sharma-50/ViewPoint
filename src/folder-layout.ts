import dagre from '@dagrejs/dagre';

type Folder = { path: string; fileCount: number };
type Link = { source: string; target: string; count: number };
type Card = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

/** Round turns while keeping the first and last points on their cards. */
export function folderRoutePath(points: Point[]) {
  if (!points.length) return '';
  let path = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const before = points[index - 1]!;
    const corner = points[index]!;
    const after = points[index + 1]!;
    const incoming = Math.hypot(corner.x - before.x, corner.y - before.y);
    const outgoing = Math.hypot(after.x - corner.x, after.y - corner.y);
    if (!incoming || !outgoing) continue;
    const radius = Math.min(12, incoming / 2, outgoing / 2);
    path += ` L ${corner.x - (corner.x - before.x) * radius / incoming} ${corner.y - (corner.y - before.y) * radius / incoming}`;
    path += ` Q ${corner.x} ${corner.y} ${corner.x + (after.x - corner.x) * radius / outgoing} ${corner.y + (after.y - corner.y) * radius / outgoing}`;
  }
  return `${path} L ${points.at(-1)!.x} ${points.at(-1)!.y}`;
}

function crossesCard(a: Point, b: Point, card: Card, padding = 0) {
  const left = card.x - padding;
  const right = card.x + card.width + padding;
  const top = card.y - padding;
  const bottom = card.y + card.height + padding;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let enter = 0;
  let leave = 1;
  for (const [start, delta, low, high] of [[a.x, dx, left, right], [a.y, dy, top, bottom]]) {
    if (!delta) {
      if (start <= low || start >= high) return false;
      continue;
    }
    const first = (low - start) / delta;
    const second = (high - start) / delta;
    enter = Math.max(enter, Math.min(first, second));
    leave = Math.min(leave, Math.max(first, second));
    if (enter >= leave) return false;
  }
  return enter < 1 && leave > 0;
}

function clearRoute(points: Point[], cards: Card[], padding = 0) {
  return points.slice(1).every((point, index) =>
    cards.every(card => !crossesCard(points[index]!, point, card, padding)));
}

function outsidePort(point: Point, card: Card): Point {
  const sides = [
    { distance: Math.abs(point.x - card.x), point: { x: card.x - 14, y: point.y } },
    { distance: Math.abs(point.x - card.x - card.width), point: { x: card.x + card.width + 14, y: point.y } },
    { distance: Math.abs(point.y - card.y), point: { x: point.x, y: card.y - 14 } },
    { distance: Math.abs(point.y - card.y - card.height), point: { x: point.x, y: card.y + card.height + 14 } },
  ];
  return sides.sort((a, b) => a.distance - b.distance)[0]!.point;
}

function aroundCards(start: Point, end: Point, source: Card, target: Card, cards: Card[], width: number, height: number) {
  const from = outsidePort(start, source);
  const to = outsidePort(end, target);
  const xs = [...new Set([from.x, to.x, 6, width - 6, ...cards.flatMap(card => [card.x - 14, card.x + card.width + 14])])].sort((a, b) => a - b);
  const ys = [...new Set([from.y, to.y, 6, height - 6, ...cards.flatMap(card => [card.y - 14, card.y + card.height + 14])])].sort((a, b) => a - b);
  const column = xs.indexOf(from.x);
  const row = ys.indexOf(from.y);
  const goal = `${xs.indexOf(to.x)},${ys.indexOf(to.y)}`;
  const key = (x: number, y: number) => `${x},${y}`;
  const best = new Map([[key(column, row), 0]]);
  const previous = new Map<string, string>();
  const open = [{ x: column, y: row, cost: 0, priority: 0 }];
  while (open.length) {
    open.sort((a, b) => b.priority - a.priority);
    const current = open.pop()!;
    const currentKey = key(current.x, current.y);
    if (current.cost !== best.get(currentKey)) continue;
    if (currentKey === goal) {
      const route: Point[] = [];
      for (let at: string | undefined = goal; at; at = previous.get(at)) {
        const [x, y] = at.split(',').map(Number);
        route.push({ x: xs[x]!, y: ys[y]! });
      }
      return [start, ...route.reverse(), end];
    }
    for (const [x, y] of [[current.x - 1, current.y], [current.x + 1, current.y], [current.x, current.y - 1], [current.x, current.y + 1]]) {
      if (x < 0 || y < 0 || x >= xs.length || y >= ys.length) continue;
      const a = { x: xs[current.x]!, y: ys[current.y]! };
      const b = { x: xs[x]!, y: ys[y]! };
      if (!clearRoute([a, b], cards)) continue;
      const next = current.cost + Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      const nextKey = key(x, y);
      if (next >= (best.get(nextKey) ?? Infinity)) continue;
      best.set(nextKey, next);
      previous.set(nextKey, currentKey);
      open.push({ x, y, cost: next, priority: next + Math.abs(b.x - to.x) + Math.abs(b.y - to.y) });
    }
  }
  return [start, end];
}

/** Keep directory cards separate while routing cross-folder links. */
export function layoutFolders(
  folders: Folder[],
  links: Link[],
  expanded: Set<string>,
  heights?: Map<string, number>,
) {
  const graph = new dagre.graphlib.Graph();
  const id = (folder: string) => `folder:${folder}`;
  graph.setGraph({ rankdir: 'TB', nodesep: 95, ranksep: 100, marginx: 30, marginy: 30 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const folder of folders)
    graph.setNode(id(folder.path), {
      width: 290,
      height: heights?.get(folder.path) ?? (expanded.has(folder.path) ? 440 : 150),
    });
  for (const link of links)
    if (graph.hasNode(id(link.source)) && graph.hasNode(id(link.target)))
      graph.setEdge(id(link.source), id(link.target));
  dagre.layout(graph);
  const cards = new Map<string, Card>();
  for (const folder of folders) {
    const point = graph.node(id(folder.path));
    cards.set(folder.path, {
      x: point.x - point.width / 2,
      y: point.y - point.height / 2,
      width: point.width,
      height: point.height,
    });
  }
  const routes = new Map<string, { x: number; y: number }[]>();
  for (const link of links)
    if (graph.hasEdge(id(link.source), id(link.target))) {
      const points = graph.edge(id(link.source), id(link.target)).points as Point[];
      const blockers = [...cards].filter(([path]) => path !== link.source && path !== link.target).map(([, card]) => card);
      routes.set(`${link.source}\0${link.target}`,
        clearRoute(points, blockers) ? points : aroundCards(points[0]!, points.at(-1)!, cards.get(link.source)!, cards.get(link.target)!, [...cards.values()], Math.ceil(graph.graph().width ?? 0), Math.ceil(graph.graph().height ?? 0)));
    }
  return {
    width: Math.ceil(graph.graph().width ?? 0),
    height: Math.ceil(graph.graph().height ?? 0),
    cards,
    routes,
  };
}
