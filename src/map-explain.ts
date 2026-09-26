import { buildFolderMap, topFolder } from './full-map.js';
import type { SerialGraph } from './server.js';

export type MapSelection =
  | { kind: 'file'; file: string }
  | { kind: 'folder'; folder: string }
  | { kind: 'link'; source: string; target: string };

export function mapExplainContext(
  graph: SerialGraph,
  selection: MapSelection,
):
  | { ok: true; subject: string; evidence: string[]; excerptFiles: string[] }
  | { ok: false; error: string } {
  const map = buildFolderMap(graph, true);
  const sourceFile = /\.(?:[cm]?[jt]sx?|py|go|java)$/i;
  const warnings = (graph.warnings ?? []).map(warning => `Incomplete connection map: ${warning}`);
  if (selection.kind === 'file') {
    const node = map.files.get(selection.file);
    if (!node) return { ok: false, error: 'Select a file present in this repository map.' };
    const links = map.fileLinks
      .filter(link => link.source === node.file || link.target === node.file)
      .slice(0, 12);
    return {
      ok: true,
      subject: `File ${node.file}`,
      evidence: [
        ...warnings,
        `${node.file}: ${node.fanIn} known incoming files and ${node.fanOut} outgoing dependencies.`,
        ...links.map(link => `${link.source} → ${link.target}`),
      ].slice(0, 18),
      excerptFiles: sourceFile.test(node.file) ? [node.file] : [],
    };
  }
  if (selection.kind === 'folder') {
    const members = [...map.files.keys()].filter(file => topFolder(file) === selection.folder);
    if (!members.length)
      return { ok: false, error: 'Select a folder present in this repository map.' };
    members.sort(
      (a, b) => (map.degree.get(b) ?? 0) - (map.degree.get(a) ?? 0) || a.localeCompare(b),
    );
    const excerptFiles = members.filter(file => sourceFile.test(file)).slice(0, 2);
    const evidence = [
      ...warnings,
      `${selection.folder || 'Repository root'}: ${members.length} visible files.`,
      ...members
        .slice(0, 12)
        .map(file => `${file}: ${map.degree.get(file) ?? 0} known file links.`),
    ];
    return {
      ok: true,
      subject: `Folder ${selection.folder || 'Repository root'}`,
      evidence,
      excerptFiles,
    };
  }
  const links = map.fileLinks.filter(
    link =>
      topFolder(link.source) === selection.source && topFolder(link.target) === selection.target,
  );
  if (!links.length) return { ok: false, error: 'Select an existing folder connection.' };
  return {
    ok: true,
    subject: `Connection ${selection.source || 'Repository root'} → ${selection.target || 'Repository root'}`,
    evidence: [...warnings, ...links.map(link => `${link.source} → ${link.target}`)].slice(0, 18),
    excerptFiles: [...new Set([links[0]!.source, links[0]!.target])]
      .filter(file => sourceFile.test(file))
      .slice(0, 2),
  };
}
