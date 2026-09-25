/**
 * src/cli.ts — Last Rites command-line entry point.
 *
 * Usage:
 *   tsx src/cli.ts --url <githubUrl> --select <candidateId>
 *
 *   --url     Public GitHub repository URL (https://github.com/<owner>/<repo>)
 *   --select  Node ID of the candidate to rehearse (e.g. "src/features/newDashboard.ts#newDashboard")
 *
 * The CLI runs the full pipeline:
 *   1. Clone the repository to a temp directory.
 *   2. Build the export graph.
 *   3. Rehearse removal of the selected candidate.
 *   4. Write report.html and removal.patch to ./output/.
 *
 * Exits 0 on success, 1 on any error.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as url from 'node:url';
import { cloneRepo } from './clone-repo.js';
import { buildGraph } from './analyse-repo.js';
import { rehearseRemoval } from './rehearse-removal.js';
import { generateReport } from './report-writer.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { url: string; select: string } {
  let repoUrl = '';
  let selectId = '';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) {
      repoUrl = argv[++i];
    } else if (argv[i] === '--select' && argv[i + 1]) {
      selectId = argv[++i];
    }
  }

  return { url: repoUrl, select: selectId };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.url) {
    console.error('Usage: last-rites --url <githubUrl> --select <candidateId>');
    console.error('  --url     Public GitHub repository URL');
    console.error('  --select  Node ID of the candidate to rehearse');
    process.exit(1);
  }

  if (!args.select) {
    console.error('Error: --select <candidateId> is required.');
    process.exit(1);
  }

  // ── 1. Clone ──────────────────────────────────────────────────────────────
  console.log(`Cloning ${args.url} …`);
  const cloneResult = await cloneRepo(args.url);
  if (!cloneResult.ok) {
    const msgs: Record<string, string> = {
      INVALID_URL: 'Invalid GitHub URL.',
      CLONE_FAILED: 'Failed to clone the repository.',
      SIZE_EXCEEDED: 'Repository TypeScript source exceeds the 50 MB limit.',
    };
    console.error('Clone failed:', msgs[cloneResult.error] ?? cloneResult.error);
    process.exit(1);
  }
  const repoPath = cloneResult.path;
  console.log(`Cloned to ${repoPath}`);

  try {

  // ── 2. Build graph ────────────────────────────────────────────────────────
  console.log('Building export graph…');
  const graphResult = await buildGraph(repoPath);
  if (!graphResult.ok) {
    console.error('Graph build failed:', graphResult.error);
    process.exitCode = 1;
    return;
  }
  const graph = graphResult.graph;
  console.log(`Graph built: ${graph.nodes.size} nodes`);

  // ── 3. Find and validate candidate ───────────────────────────────────────
  const node = graph.nodes.get(args.select);
  if (!node) {
    console.error(`Candidate "${args.select}" not found in graph.`);
    console.error('Available candidates:');
    for (const [id, n] of graph.nodes) {
      if (n.certainty === 'candidate') {
        console.error(`  ${id}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  // ── 4. Rehearse removal ───────────────────────────────────────────────────
  console.log(`Rehearsing removal of "${node.file}" (${node.name})…`);
  const candidate = { nodeId: node.id, file: node.file, name: node.name };
  const rehearsalResult = await rehearseRemoval(repoPath, candidate, graph);
  if (!rehearsalResult.ok) {
    console.error('Rehearsal failed:', rehearsalResult.error);
    process.exitCode = 1;
    return;
  }

  // ── 5. Write output ───────────────────────────────────────────────────────
  const outputDir = path.resolve('output');
  fs.mkdirSync(outputDir, { recursive: true });

  const report = generateReport(rehearsalResult, {
    repoUrl: args.url,
    candidateFile: node.file,
    candidateName: node.name,
  });

  const reportPath = path.join(outputDir, 'report.html');
  const patchPath  = path.join(outputDir, 'removal.patch');

  fs.writeFileSync(reportPath, report.html, 'utf8');
  fs.writeFileSync(patchPath, report.patchText, 'utf8');

  console.log(`Report written to ${reportPath}`);
  console.log(`Patch  written to ${patchPath}`);

  // ── 6. Summary ────────────────────────────────────────────────────────────
  const delta = rehearsalResult.delta;
  console.log('\n── Rehearsal Summary ──────────────────────────────────────────');
  console.log(`  Before errors : ${rehearsalResult.before.diagnosticCount}`);
  console.log(`  After errors  : ${rehearsalResult.after.diagnosticCount}`);
  console.log(`  New errors    : ${delta.newErrors.length}`);
  console.log(`  Resolved      : ${delta.resolvedErrors.length}`);
  console.log(`  Net change    : ${delta.netChange}`);
  console.log(`  Removed files : ${rehearsalResult.removedFiles.join(', ')}`);
  console.log(`  Modified files: ${rehearsalResult.modifiedFiles.length}`);

  if (delta.newErrors.length === 0) {
    console.log('\n✓ Clean removal — no new TypeScript errors introduced.');
  } else {
    console.log(`\n✗ ${delta.newErrors.length} new TypeScript error(s) would be introduced.`);
    for (const e of delta.newErrors) {
      console.log(`  TS${e.code} ${e.file ?? ''}:${e.line ?? ''} — ${e.message}`);
    }
  }
  } finally {
    await fs.promises.rm(repoPath, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Entry point guard
// ---------------------------------------------------------------------------

const __filename = url.fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith('cli.js')) {
  main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
}
