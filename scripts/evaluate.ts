/**
 * scripts/evaluate.ts — Acceptance proof for Task 6.
 *
 * Runs the full Last Rites pipeline against the local demo repo, asserts all
 * five developer-effort dimensions from last-rites-plan.md, and writes
 * evaluation-results.md.
 *
 * All constants (repo path, --select id) are fixed here — this script is
 * deterministic: no LLM, no user scripts, no network.
 *
 * Exits 0 if all assertions pass; exits 1 on any failure.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as url from 'node:url';
import { buildGraph } from '../src/analyse-repo.js';
import { rehearseRemoval } from '../src/rehearse-removal.js';
import { generateReport } from '../src/report-writer.js';

// ---------------------------------------------------------------------------
// Constants — fixed for determinism
// ---------------------------------------------------------------------------

const __filename = url.fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '..');

/** Local demo repo — no network required. */
const DEMO_REPO_PATH = path.join(PROJECT_ROOT, 'demo');

/** Node ID of the candidate to rehearse — src/features/newDashboard.ts#renderDashboard */
const SELECT_CANDIDATE_ID = 'src/features/newDashboard.ts#renderDashboard';

/** Node ID of the shared dependency that must remain unsafe. */
const FORMAT_DATE_ID = 'src/utils/formatDate.ts#formatDate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AssertionResult {
  name: string;
  passed: boolean;
  detail: string;
}

function assert(
  results: AssertionResult[],
  name: string,
  cond: boolean,
  detail: string,
): void {
  results.push({ name, passed: cond, detail });
  const prefix = cond ? '  ✓' : '  ✗';
  console.log(`${prefix} ${name}`);
  if (!cond) console.log(`    → ${detail}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Last Rites — Evaluation Script');
  console.log(`Demo repo : ${DEMO_REPO_PATH}`);
  console.log(`Candidate : ${SELECT_CANDIDATE_ID}`);
  console.log('');

  // ── 1. Build export graph ────────────────────────────────────────────────
  console.log('Step 1: Building export graph…');
  const graphResult = await buildGraph(DEMO_REPO_PATH);
  if (!graphResult.ok) {
    console.error('FATAL: buildGraph failed:', graphResult.error);
    process.exit(1);
  }
  const graph = graphResult.graph;
  console.log(`  ${graph.nodes.size} nodes built.\n`);

  // ── 2. Locate the newDashboard candidate node ────────────────────────────
  const candidateNode = graph.nodes.get(SELECT_CANDIDATE_ID);
  if (!candidateNode) {
    // Attempt to find it with a partial match for resilience
    let found: string | undefined;
    for (const [id] of graph.nodes) {
      if (id.includes('newDashboard')) { found = id; break; }
    }
    console.error(`FATAL: Candidate "${SELECT_CANDIDATE_ID}" not found in graph.`);
    if (found) console.error(`  Nearest match: ${found}`);
    console.error('  Available nodes:', [...graph.nodes.keys()].slice(0, 10).join(', '));
    process.exit(1);
  }

  // ── 3. Rehearse removal ──────────────────────────────────────────────────
  console.log('Step 2: Rehearsing removal of newDashboard…');
  const candidate = {
    nodeId: candidateNode.id,
    file: candidateNode.file,
    name: candidateNode.name,
  };
  const rehearsalResult = await rehearseRemoval(DEMO_REPO_PATH, candidate, graph);
  if (!rehearsalResult.ok) {
    console.error('FATAL: rehearseRemoval failed:', rehearsalResult.error);
    process.exit(1);
  }
  console.log('  Rehearsal complete.\n');

  // ── 4. Generate report ───────────────────────────────────────────────────
  const report = generateReport(rehearsalResult, {
    repoUrl: 'local:demo',
    candidateFile: candidateNode.file,
    candidateName: candidateNode.name,
  });

  // ── 5. Run assertions ────────────────────────────────────────────────────
  console.log('Step 3: Asserting five evaluation dimensions…');
  const results: AssertionResult[] = [];
  const delta = rehearsalResult.delta;
  const formatDateNode = graph.nodes.get(FORMAT_DATE_ID);

  // Dimension 1 — fanIn === 0 AND evidence includes 'no-internal-refs'
  assert(
    results,
    'Dimension 1 — newDashboard.fanIn === 0 with no-internal-refs evidence',
    candidateNode.fanIn === 0 &&
      candidateNode.evidence.some((e) => e.kind === 'no-internal-refs'),
    `fanIn=${candidateNode.fanIn}, evidence=[${candidateNode.evidence.map((e) => e.kind).join(',')}]`,
  );

  // Dimension 2 — delta.newErrors.length === 0 (no new TS errors after removal)
  assert(
    results,
    'Dimension 2 — delta.newErrors.length === 0',
    delta.newErrors.length === 0,
    `newErrors=${delta.newErrors.length}, errors=${JSON.stringify(delta.newErrors.slice(0, 3))}`,
  );

  // Dimension 3 — formatDate is classified unsafe (fanIn === 3)
  assert(
    results,
    'Dimension 3 — formatDate.certainty === "unsafe" (fanIn === 3)',
    formatDateNode !== undefined &&
      formatDateNode.certainty === 'unsafe' &&
      formatDateNode.fanIn === 3,
    formatDateNode
      ? `certainty=${formatDateNode.certainty}, fanIn=${formatDateNode.fanIn}`
      : `Node not found (tried ${FORMAT_DATE_ID})`,
  );

  // Dimension 4 — patchText is non-empty
  assert(
    results,
    'Dimension 4 — patchText.length > 0',
    rehearsalResult.patchText.length > 0,
    `patchText.length=${rehearsalResult.patchText.length}`,
  );

  // Dimension 5 — report HTML exists and key fields are non-empty
  const reportExists = report.html.length > 0;
  const hasBeforeAfter = report.html.includes('Before errors') && report.html.includes('After errors');
  const hasUnknownChecks = report.html.includes('test-suite') && report.html.includes('build-tool');
  const hasPatchSection = report.html.includes('removal.patch');
  assert(
    results,
    'Dimension 5 — report HTML is non-empty and contains all required sections',
    reportExists && hasBeforeAfter && hasUnknownChecks && hasPatchSection,
    `html.length=${report.html.length}, hasBeforeAfter=${hasBeforeAfter}, ` +
      `hasUnknownChecks=${hasUnknownChecks}, hasPatchSection=${hasPatchSection}`,
  );

  // ── 6. Write evaluation-results.md ──────────────────────────────────────
  const allPassed = results.every((r) => r.passed);
  const md = buildMarkdown(
    results, allPassed, rehearsalResult.before.diagnosticCount,
    rehearsalResult.after.diagnosticCount, delta, candidateNode, formatDateNode,
  );
  const outPath = path.join(PROJECT_ROOT, 'evaluation-results.md');
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`\nevaluation-results.md written to ${outPath}`);

  // ── 7. Write report.html and removal.patch to ./output/ ─────────────────
  const outputDir = path.join(PROJECT_ROOT, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'report.html'), report.html, 'utf8');
  fs.writeFileSync(path.join(outputDir, 'removal.patch'), report.patchText, 'utf8');
  console.log(`output/report.html and output/removal.patch written.`);

  // ── 8. Exit ───────────────────────────────────────────────────────────────
  console.log('');
  if (allPassed) {
    console.log('All 5 assertions passed ✓  (exit 0)');
    process.exit(0);
  } else {
    const failed = results.filter((r) => !r.passed).map((r) => r.name);
    console.error(`${failed.length} assertion(s) FAILED:`);
    for (const name of failed) console.error(`  • ${name}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Markdown builder
// ---------------------------------------------------------------------------

function buildMarkdown(
  results: AssertionResult[],
  allPassed: boolean,
  beforeCount: number,
  afterCount: number,
  delta: { newErrors: unknown[]; resolvedErrors: unknown[]; netChange: number },
  candidateNode: { fanIn: number; certainty: string; file: string; name: string },
  formatDateNode: { fanIn: number; certainty: string } | undefined,
): string {
  const rows = results
    .map(
      (r) =>
        `| ${r.name} | ${r.passed ? '✅ PASS' : '❌ FAIL'} | ${r.detail} |`,
    )
    .join('\n');

  return `# Last Rites — Evaluation Results

**Status:** ${allPassed ? '✅ ALL ASSERTIONS PASS' : '❌ ONE OR MORE ASSERTIONS FAILED'}

## Five Developer-Effort Dimensions

| Assertion | Result | Detail |
|-----------|--------|--------|
${rows}

## Rehearsal Summary

| Metric | Value |
|--------|-------|
| Candidate | \`${candidateNode.file}\` (${candidateNode.name}) |
| Certainty | ${candidateNode.certainty} |
| Fan-in | ${candidateNode.fanIn} |
| Before diagnostic errors | ${beforeCount} |
| After diagnostic errors | ${afterCount} |
| New errors introduced | ${delta.newErrors.length} |
| Errors resolved | ${delta.resolvedErrors.length} |
| Net change | ${delta.netChange} |

## formatDate Node

| Metric | Value |
|--------|-------|
| Certainty | ${formatDateNode?.certainty ?? 'NOT FOUND'} |
| Fan-in | ${formatDateNode?.fanIn ?? 'N/A'} |

---
*Generated by \`npm run evaluate\`.*
`;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
