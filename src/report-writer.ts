/**
 * src/report-writer.ts — HTML report page and patch string generator.
 *
 * Generates:
 *   - A self-contained HTML page showing before/after diagnostic table,
 *     all three unknownChecks with their reasons, and the patch text.
 *   - A plain unified-diff patch string suitable for download as
 *     "removal.patch".
 *
 * Input: RehearsalResult & { ok: true } plus context metadata.
 * Output: { html: string; patchText: string }
 *
 * All user-supplied content (file names, messages) is HTML-escaped so
 * this module can never produce XSS.
 */

import type { RehearsalResult, TsError, UnknownCheck } from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReportContext {
  repoUrl: string;
  candidateFile: string;
  candidateName: string;
  patchUrl?: string;
}

export interface ReportOutput {
  html: string;
  patchText: string;
}

export function generateReport(
  result: RehearsalResult & { ok: true },
  ctx: ReportContext,
): ReportOutput {
  return {
    html: buildHtml(result, ctx),
    patchText: result.patchText,
  };
}

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function errorRow(e: TsError, rowClass: string): string {
  const file = e.file ? esc(e.file) : '—';
  const line = e.line != null ? String(e.line) : '—';
  return `<tr class="${rowClass}"><td>TS${e.code}</td><td>${esc(e.message)}</td><td>${file}</td><td>${line}</td></tr>`;
}

function unknownRow(u: UnknownCheck): string {
  return `<tr><td><code>${esc(u.kind)}</code></td><td>${esc(u.reason)}</td></tr>`;
}

function buildHtml(result: RehearsalResult & { ok: true }, ctx: ReportContext): string {
  const { before, after, delta, removedFiles, modifiedFiles, unknownChecks, patchText } = result;

  const newErrRows = delta.newErrors.length
    ? delta.newErrors.map((e) => errorRow(e, 'new-err')).join('\n')
    : '<tr><td colspan="4" class="none-cell">None — no new errors introduced ✓</td></tr>';

  const resolvedErrRows = delta.resolvedErrors.length
    ? delta.resolvedErrors.map((e) => errorRow(e, 'resolved-err')).join('\n')
    : '<tr><td colspan="4" class="none-cell">None</td></tr>';

  const unknownRows = unknownChecks.map(unknownRow).join('\n');

  const removedList = removedFiles.map((f) => `<li><code>${esc(f)}</code></li>`).join('\n');
  const modifiedList = modifiedFiles.length
    ? modifiedFiles.map((f) => `<li><code>${esc(f)}</code></li>`).join('\n')
    : '<li class="none-cell">None</li>';

  const netLabel = delta.netChange <= 0
    ? `<span class="good">${delta.netChange}</span>`
    : `<span class="bad">+${delta.netChange}</span>`;

  const patchBlock = patchText
    ? `<pre class="patch-block">${esc(patchText)}</pre>`
    : '<p class="none-cell">No patch generated.</p>';

  const statusBanner = delta.newErrors.length === 0
    ? `<div class="banner pass">✓ 0 new TypeScript errors introduced; review unknown checks below</div>`
    : `<div class="banner fail">✗ ${delta.newErrors.length} new TypeScript error(s) would be introduced</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Last Rites — Removal Report</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system,"Segoe UI",system-ui,sans-serif; background:#0f1117; color:#e2e4f0; padding:32px 24px; font-size:14px; line-height:1.6; }
.page { max-width:860px; margin:0 auto; }
h1 { font-size:22px; font-weight:700; margin-bottom:4px; }
.subtitle { color:#7b82a8; font-size:13px; margin-bottom:24px; }
.subtitle code { background:#1a1d27; padding:1px 6px; border-radius:3px; font-size:12px; }
.section { margin-top:28px; }
.section-title { font-size:12px; font-weight:600; color:#7b82a8; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:10px; }
table { width:100%; border-collapse:collapse; font-size:12px; }
th { text-align:left; padding:7px 10px; background:#1a1d27; border:1px solid #2e3248; color:#7b82a8; font-weight:600; }
td { padding:7px 10px; border:1px solid #2e3248; vertical-align:top; }
tr:nth-child(even) td { background:#13151f; }
.new-err td { background:rgba(239,68,68,0.08); }
.resolved-err td { background:rgba(34,197,94,0.08); }
.none-cell { color:#7b82a8; font-style:italic; }
.banner { padding:12px 16px; border-radius:6px; font-size:14px; font-weight:600; margin-bottom:20px; }
.banner.pass { background:rgba(34,197,94,0.12); border:1px solid rgba(34,197,94,0.35); color:#22c55e; }
.banner.fail { background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.35); color:#ef4444; }
.meta-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:12px; margin-bottom:20px; }
.stat { background:#1a1d27; border:1px solid #2e3248; border-radius:6px; padding:12px; }
.stat-label { font-size:11px; color:#7b82a8; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; }
.stat-value { font-size:22px; font-weight:700; }
.good { color:#22c55e; }
.bad  { color:#ef4444; }
ul { list-style:none; padding:0; }
li { background:#1a1d27; border:1px solid #2e3248; border-radius:4px; padding:6px 10px; margin-bottom:4px; font-size:12px; }
code { font-family:monospace; font-size:12px; }
.patch-block { background:#1a1d27; border:1px solid #2e3248; border-radius:6px; padding:14px; font-size:11px; font-family:monospace; overflow-x:auto; white-space:pre; color:#e2e4f0; max-height:480px; overflow-y:auto; }
.unknown-table td:first-child { white-space:nowrap; }
.dl-link { display:inline-block; margin-top:10px; background:#22c55e; color:#000; font-weight:600; font-size:12px; padding:7px 14px; border-radius:5px; text-decoration:none; }
.dl-link:hover { opacity:0.9; }
footer { margin-top:40px; padding-top:14px; border-top:1px solid #2e3248; text-align:center; font-size:12px; color:#7b82a8; }
</style>
</head>
<body>
<div class="page">
  <h1>Last Rites — Removal Report</h1>
  <p class="subtitle">Repository: <code>${esc(ctx.repoUrl)}</code> &nbsp;·&nbsp; Candidate: <code>${esc(ctx.candidateFile)}</code> (${esc(ctx.candidateName)})</p>

  ${statusBanner}

  <div class="meta-grid">
    <div class="stat"><div class="stat-label">Before errors</div><div class="stat-value">${before.diagnosticCount}</div></div>
    <div class="stat"><div class="stat-label">After errors</div><div class="stat-value">${after.diagnosticCount}</div></div>
    <div class="stat"><div class="stat-label">Net change</div><div class="stat-value">${netLabel}</div></div>
    <div class="stat"><div class="stat-label">New errors</div><div class="stat-value ${delta.newErrors.length ? 'bad' : 'good'}">${delta.newErrors.length}</div></div>
    <div class="stat"><div class="stat-label">Resolved</div><div class="stat-value good">${delta.resolvedErrors.length}</div></div>
  </div>

  <div class="section">
    <div class="section-title">Files Removed</div>
    <ul>${removedList}</ul>
  </div>

  <div class="section">
    <div class="section-title">Files Modified (import-strip)</div>
    <ul>${modifiedList}</ul>
  </div>

  <div class="section">
    <div class="section-title">New TypeScript Errors Introduced</div>
    <table>
      <thead><tr><th>Code</th><th>Message</th><th>File</th><th>Line</th></tr></thead>
      <tbody>${newErrRows}</tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-title">TypeScript Errors Resolved by Removal</div>
    <table>
      <thead><tr><th>Code</th><th>Message</th><th>File</th><th>Line</th></tr></thead>
      <tbody>${resolvedErrRows}</tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-title">Unknown Checks (requires manual verification)</div>
    <table class="unknown-table">
      <thead><tr><th>Kind</th><th>Reason</th></tr></thead>
      <tbody>${unknownRows}</tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-title">Unified Diff (removal.patch)</div>
    <a class="dl-link" href="${esc(ctx.patchUrl ?? 'removal.patch')}">⬇ Download removal.patch</a>
    ${patchBlock}
  </div>
</div>

<footer>Made with IBM Bob</footer>
</body>
</html>`;
}
