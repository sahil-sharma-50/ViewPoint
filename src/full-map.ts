import type { SerialGraph, SerialNode } from './server.js';
import type { ApiCall } from './architecture.js';

export interface FolderMap {
  files: Map<string, SerialNode>;
  folders: { path: string; fileCount: number }[];
  links: { source: string; target: string; count: number }[];
  fileLinks: { source: string; target: string }[];
  degree: Map<string, number>;
}

const sourceFile = /\.(?:[cm]?[jt]sx?|py|go|java)$/i;
const supportFile = (file: string) =>
  /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?|scripts)(?:\/|$)|(?:\.test|\.spec|\.config)\.[^.]+$|(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:py|go))$/i.test(
    file,
  );
const visible = (file: string) => !file.split('/').some(part => part.startsWith('.'));
export const topFolder = (file: string) => {
  const directories = file.split('/').slice(0, -1);
  const source = directories.indexOf('src');
  if (source >= 0) return directories.slice(0, source + 3).join('/');
  return directories.slice(0, 2).join('/');
};

export function buildHttpFolderLinks(map: FolderMap, calls: ApiCall[]) {
  const links = new Map<string, FolderMap['links'][number]>();
  for (const call of calls) {
    if (!call.target || !map.files.has(call.source) || !map.files.has(call.target)) continue;
    const source = topFolder(call.source);
    const target = topFolder(call.target);
    if (source === target) continue;
    const key = `${source}\0${target}`;
    const existing = links.get(key);
    if (existing) existing.count++;
    else links.set(key, { source, target, count: 1 });
  }
  return [...links.values()];
}

/** Reuse the analysed graph; folder links count distinct known file links. */
export function buildFolderMap(graph: SerialGraph, showSupport = false): FolderMap {
  const files = new Map<string, SerialNode>();
  for (const node of graph.nodes)
    if (
      visible(node.file) &&
      (showSupport || (sourceFile.test(node.file) && !supportFile(node.file)))
    )
      files.set(node.file, node);
  const counts = new Map<string, number>();
  for (const file of files.keys())
    counts.set(topFolder(file), (counts.get(topFolder(file)) ?? 0) + 1);
  const links = new Map<string, { source: string; target: string; count: number }>();
  const degree = new Map<string, number>();
  const fileLinks: FolderMap['fileLinks'] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges)
    for (const target of edge.targets) {
      if (!files.has(edge.source) || !files.has(target)) continue;
      const fileKey = `${edge.source}\0${target}`;
      if (seen.has(fileKey)) continue;
      seen.add(fileKey);
      fileLinks.push({ source: edge.source, target });
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(target, (degree.get(target) ?? 0) + 1);
      const source = topFolder(edge.source);
      const destination = topFolder(target);
      if (source === destination) continue;
      const key = `${source}\0${destination}`;
      const existing = links.get(key);
      if (existing) existing.count++;
      else links.set(key, { source, target: destination, count: 1 });
    }
  return {
    files,
    folders: [...counts]
      .map(([path, fileCount]) => ({ path, fileCount }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    links: [...links.values()].sort(
      (a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
    ),
    fileLinks,
    degree,
  };
}

export function folderContents(
  map: FolderMap,
  folder: string,
  options: { limit?: number; query?: string } = {},
) {
  const folders = new Set<string>();
  const clusters = new Set(map.folders.map(cluster => cluster.path));
  const direct: SerialNode[] = [];
  const prefix = folder ? `${folder}/` : '';
  for (const [file, node] of map.files) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    if (rest.includes('/')) {
      const child = prefix + rest.split('/')[0];
      if (!clusters.has(child)) folders.add(child);
    } else direct.push(node);
  }
  direct.sort(
    (a, b) =>
      (map.degree.get(b.file) ?? 0) - (map.degree.get(a.file) ?? 0) || a.file.localeCompare(b.file),
  );
  const limit = options.limit ?? 30;
  const query = options.query?.trim().toLowerCase();
  const files = query
    ? direct.filter(node => node.file.toLowerCase().includes(query))
    : direct.slice(0, limit);
  return {
    folders: [...folders].sort(),
    files,
    remaining: query ? 0 : Math.max(0, direct.length - files.length),
    total: direct.length,
  };
}

export function traceDependents(graph: SerialGraph, file: string) {
  const reverse = new Map<string, Set<string>>();
  for (const edge of graph.edges)
    for (const target of edge.targets) {
      if (!reverse.has(target)) reverse.set(target, new Set());
      reverse.get(target)!.add(edge.source);
    }
  const direct = new Set(reverse.get(file) ?? []);
  direct.delete(file);
  const transitive = new Set<string>();
  const queue = [...direct];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    if (current === file || transitive.has(current)) continue;
    transitive.add(current);
    for (const importer of reverse.get(current) ?? [])
      if (!transitive.has(importer)) queue.push(importer);
  }
  return { direct, transitive };
}
