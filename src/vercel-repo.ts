import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x as extract } from 'tar';
import { buildGraph } from './analyse-repo.js';
import { buildArchitecture, type Architecture } from './architecture.js';
import { canonicalGitHubUrl, isValidGitHubUrl } from './clone-repo.js';
import { listRepoFiles } from './repo-files.js';
import type { SerialGraph } from './server.js';

export interface SavedAnalysis {
  repoUrl: string;
  graph: SerialGraph;
  architecture: Architecture;
  excerpts: Record<string, string>;
  expiresAt: number;
}

const archiveLimit = 35_000_000;
const extractedLimit = 90_000_000;
const fileLimit = 5_000;

/** Vercel functions cannot depend on Git or retain a checkout between requests. */
export async function analyseArchive(input: string): Promise<SavedAnalysis> {
  const repoUrl = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(input) ? `https://github.com/${input}` : input;
  if (!isValidGitHubUrl(repoUrl)) throw new Error('Enter a public GitHub repository URL or owner/repository.');
  const canonical = canonicalGitHubUrl(repoUrl);
  const [owner, suppliedName] = new URL(canonical).pathname.slice(1).split('/');
  const repository = suppliedName!.replace(/\.git$/, '');
  const root = await mkdtemp(join(tmpdir(), 'viewpoint-archive-'));
  try {
    const response = await fetch(`https://codeload.github.com/${owner}/${repository}/tar.gz/HEAD`, {
      signal: AbortSignal.timeout(120_000), redirect: 'error',
      headers: { 'User-Agent': 'ViewPoint/1.0' },
    });
    if (response.status === 404) throw new Error('GitHub could not find that public repository.');
    if (!response.ok || !response.body) throw new Error('GitHub could not provide the repository archive. Try again.');
    let compressed = 0;
    let extracted = 0;
    let count = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        compressed += chunk.length;
        callback(compressed > archiveLimit ? new Error('Repository archive exceeds the 35 MB download budget.') : null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), limit,
      extract({ cwd: root, strip: 1, preservePaths: false, filter(_name, entry) {
        if ('type' in entry ? entry.type === 'Directory' : entry.isDirectory()) return true;
        if (!('type' in entry ? entry.type === 'File' : entry.isFile())) return false;
        extracted += entry.size;
        count++;
        if (extracted > extractedLimit || count > fileLimit) throw new Error('Repository exceeds this deployment’s 90 MB / 5,000 file analysis budget.');
        return true;
      } }),
    );
    const built = await buildGraph(root);
    if (!built.ok) throw new Error(built.error);
    if (!built.graph.nodes.size) throw new Error('This repository contains no inspectable files.');
    const graph: SerialGraph = {
      nodes: [...built.graph.nodes.values()],
      edges: [...built.graph.edges].filter(([, targets]) => targets.size > 0).map(([source, targets]) => ({ source, targets: [...targets] })),
      ...(built.graph.warnings?.length ? { warnings: [...built.graph.warnings] } : {}),
    };
    const architecture = buildArchitecture(root, graph);
    const excerpts: Record<string, string> = {};
    let excerptLength = 0;
    for (const file of listRepoFiles(root)) {
      const relative = file.slice(root.length + 1).replace(/\\/g, '/');
      if (!/\.(?:[cm]?[jt]sx?|py|go|java)$/i.test(relative)) continue;
      if (excerptLength >= 2_000_000) break;
      try {
        const source = (await readFile(file, 'utf8')).split('\n').slice(0, 60).join('\n').slice(0, 4_000);
        excerpts[relative] = source;
        excerptLength += source.length;
      } catch { /* The graph and available excerpts remain usable. */ }
    }
    if (Object.keys(excerpts).length < graph.nodes.filter(node => /\.(?:[cm]?[jt]sx?|py|go|java)$/i.test(node.file)).length)
      graph.warnings = [...(graph.warnings ?? []), 'AI source excerpts are limited to 2 MB; later files may have graph evidence only.'];
    return { repoUrl: `https://github.com/${owner}/${repository}`, graph, architecture, excerpts, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
  } finally { await rm(root, { recursive: true, force: true }); }
}
