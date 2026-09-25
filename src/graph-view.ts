/**
 * src/graph-view.ts — Interactive dependency-map page renderer (Task 4).
 *
 * Generates a self-contained HTML page (inline CSS + JS) that:
 *   - Groups nodes by directory into collapsible sections.
 *   - Provides a real-time search filter across all files.
 *   - Selecting a file highlights its incoming (fan-in) and outgoing (fan-out) connections.
 *   - Shows source evidence for each node.
 *   - Distinguishes shared dependencies (fanIn > 1) with a badge.
 *   - Shows certainty as both text label and colour.
 *   - Offers "Preview removal" only for candidate + isSoleExport === true files;
 *     otherwise shows a clear label explaining why preview is unavailable.
 *
 * All repository text (file paths, export names, evidence) is set via
 * textContent to prevent XSS.
 */

import type { SerialGraph } from './server.js';

/** Escape a value for safe inline embedding in a JSON string inside HTML. */
function jsonEmbed(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export function renderGraphPage(graph: SerialGraph, sessionId?: string): string {
  const graphJson = jsonEmbed(graph);
  const sessionIdJson = jsonEmbed(sessionId ?? null);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Last Rites — Dependency Map</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #0f1117;
  --surface: #1a1d27;
  --surface2: #222636;
  --border: #2e3248;
  --text: #e2e4f0;
  --muted: #7b82a8;
  --accent: #6c8ef5;
  --candidate: #22c55e;
  --unknown: #f59e0b;
  --unsafe: #ef4444;
  --shared: #a855f7;
  --hl-in: rgba(34,197,94,0.15);
  --hl-out: rgba(108,142,245,0.15);
  --hl-border-in: #22c55e;
  --hl-border-out: #6c8ef5;
  --hl-shared: rgba(168,85,247,0.15);
  --hl-border-shared: #a855f7;
  --radius: 6px;
  --font: -apple-system, "Segoe UI", system-ui, sans-serif;
}

html, body { height: 100%; }
body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100vh;
  overflow: hidden;
}

header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 12px 20px;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
header h1 { font-size: 16px; font-weight: 600; letter-spacing: 0.5px; white-space: nowrap; }
header h1 span { color: var(--muted); font-weight: 400; }

#search {
  flex: 1;
  min-width: 200px;
  max-width: 400px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  padding: 6px 12px;
  font-size: 13px;
  outline: none;
}
#search:focus { border-color: var(--accent); }

.legend {
  display: flex;
  gap: 12px;
  align-items: center;
  font-size: 12px;
  color: var(--muted);
}
.dot {
  display: inline-block;
  width: 8px; height: 8px;
  border-radius: 50%;
  margin-right: 4px;
}

.layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  overflow: hidden;
  height: 100%;
}

/* ── Left panel — file tree ─────────────────────────────────────── */
#file-panel {
  background: var(--surface);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  padding: 8px 0;
}

.dir-group { }
.dir-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}
.dir-header:hover { color: var(--text); }
.dir-arrow { font-size: 9px; transition: transform 0.15s; }
.dir-arrow.open { transform: rotate(90deg); }

.file-list { }
.file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 14px 5px 24px;
  font-size: 12px;
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: background 0.1s, border-color 0.1s;
}
.file-item:hover { background: var(--surface2); }
.file-item.selected {
  background: var(--surface2);
  border-left-color: var(--accent);
}
.file-item.hl-in {
  background: var(--hl-in);
  border-left-color: var(--hl-border-in);
}
.file-item.hl-out {
  background: var(--hl-out);
  border-left-color: var(--hl-border-out);
}
.file-item.hl-shared {
  background: var(--hl-shared);
  border-left-color: var(--hl-border-shared);
}
.file-item.hidden { display: none; }
.file-item.dim { opacity: 0.35; }

.cert-badge {
  flex-shrink: 0;
  width: 6px; height: 6px;
  border-radius: 50%;
}
.cert-candidate { background: var(--candidate); }
.cert-unknown   { background: var(--unknown); }
.cert-unsafe    { background: var(--unsafe); }

.file-label { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

.shared-badge {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--shared);
  font-weight: 600;
  border: 1px solid var(--shared);
  border-radius: 3px;
  padding: 0 4px;
  line-height: 14px;
}

/* ── Right panel — detail view ──────────────────────────────────── */
#detail-panel {
  overflow-y: auto;
  padding: 24px;
  background: var(--bg);
}

#detail-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--muted);
  font-size: 13px;
}

#detail-content { display: none; max-width: 760px; }

.detail-header {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}
.detail-file {
  font-size: 18px;
  font-weight: 600;
  word-break: break-all;
}
.detail-cert {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.detail-cert.cert-candidate { color: var(--candidate); background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.3); }
.detail-cert.cert-unknown   { color: var(--unknown);   background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.3); }
.detail-cert.cert-unsafe    { color: var(--unsafe);    background: rgba(239,68,68,0.12);  border: 1px solid rgba(239,68,68,0.3); }

.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
}
.stat-label { font-size: 11px; color: var(--muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
.stat-value { font-size: 22px; font-weight: 700; }

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
  margin-top: 24px;
}

.evidence-list { list-style: none; }
.evidence-item {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 12px;
  margin-bottom: 6px;
  font-size: 12px;
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.ev-kind {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  border-radius: 3px;
  padding: 2px 6px;
  background: var(--surface2);
  color: var(--muted);
  font-family: monospace;
}
.ev-detail { color: var(--text); font-family: monospace; word-break: break-all; }

.conn-list { list-style: none; }
.conn-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 5px;
  font-size: 12px;
  font-family: monospace;
  cursor: pointer;
  transition: background 0.1s;
}
.conn-item:hover { background: var(--surface2); }
.conn-arrow { color: var(--muted); font-size: 10px; }

.preview-box {
  margin-top: 24px;
  border-radius: var(--radius);
  padding: 16px;
  border: 1px solid var(--border);
}
.preview-box.can-preview {
  border-color: rgba(34,197,94,0.4);
  background: rgba(34,197,94,0.06);
}
.preview-box.no-preview {
  background: var(--surface);
}
.preview-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}
.preview-reason {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 12px;
  line-height: 1.6;
}
.btn-preview {
  background: var(--candidate);
  color: #000;
  border: none;
  border-radius: var(--radius);
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.btn-preview:hover { opacity: 0.9; }
.preview-result {
  margin-top: 12px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  font-size: 12px;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text);
}

.no-results {
  padding: 16px 14px;
  font-size: 12px;
  color: var(--muted);
}
</style>
</head>
<body>

<header>
  <h1>Last Rites <span>— Dependency Map</span></h1>
  <input id="search" type="search" placeholder="Search files…" autocomplete="off" spellcheck="false">
  <div class="legend">
    <span><span class="dot" style="background:var(--candidate)"></span>Candidate</span>
    <span><span class="dot" style="background:var(--unknown)"></span>Unknown</span>
    <span><span class="dot" style="background:var(--unsafe)"></span>Unsafe</span>
    <span><span class="dot" style="background:var(--shared)"></span>Shared dep</span>
  </div>
</header>

<div class="layout">
  <div id="file-panel"></div>
  <div id="detail-panel">
    <div id="detail-empty">Select a file to inspect its connections</div>
    <div id="detail-content"></div>
  </div>
</div>

<script>
(function () {
  'use strict';

  // ── Data ──────────────────────────────────────────────────────────────────
  const GRAPH = ${graphJson};
  const SESSION_ID = ${sessionIdJson};

  // Index nodes by file path (one file may have multiple exports → array of nodes).
  const nodesByFile = new Map();
  for (const node of GRAPH.nodes) {
    if (!nodesByFile.has(node.file)) nodesByFile.set(node.file, []);
    nodesByFile.get(node.file).push(node);
  }

  // Index edges: source file → Set of target files (outgoing).
  const outEdges = new Map(); // file → Set<file>
  for (const edge of GRAPH.edges) {
    if (!outEdges.has(edge.source)) outEdges.set(edge.source, new Set());
    for (const t of edge.targets) {
      outEdges.get(edge.source).add(t);
    }
  }

  // Reverse edges: target file → Set of source files (incoming).
  const inEdges = new Map(); // file → Set<file>
  for (const [src, targets] of outEdges) {
    for (const tgt of targets) {
      if (!inEdges.has(tgt)) inEdges.set(tgt, new Set());
      inEdges.get(tgt).add(src);
    }
  }

  // Representative node per file (first node in the array, used for certainty/metadata).
  function repNode(file) {
    const arr = nodesByFile.get(file);
    return arr ? arr[0] : null;
  }

  // Collect all distinct file paths, sorted.
  const allFiles = Array.from(nodesByFile.keys()).sort();

  // ── Grouping ──────────────────────────────────────────────────────────────
  function dirOf(file) {
    const slash = file.lastIndexOf('/');
    const backslash = file.lastIndexOf('\\\\');
    const idx = Math.max(slash, backslash);
    return idx === -1 ? '.' : file.slice(0, idx);
  }

  const groups = new Map(); // dir → file[]
  for (const f of allFiles) {
    const d = dirOf(f);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(f);
  }

  // ── Build file panel ──────────────────────────────────────────────────────
  const filePanel = document.getElementById('file-panel');
  const fileItems = new Map(); // file → DOM element

  for (const [dir, files] of groups) {
    const group = document.createElement('div');
    group.className = 'dir-group';

    const header = document.createElement('div');
    header.className = 'dir-header';

    const arrow = document.createElement('span');
    arrow.className = 'dir-arrow open';
    arrow.textContent = '▶';

    const label = document.createElement('span');
    label.textContent = dir;

    header.appendChild(arrow);
    header.appendChild(label);
    group.appendChild(header);

    const list = document.createElement('div');
    list.className = 'file-list';

    for (const file of files) {
      const node = repNode(file);
      const item = document.createElement('div');
      item.className = 'file-item';
      item.dataset.file = file;

      const badge = document.createElement('span');
      badge.className = 'cert-badge cert-' + (node ? node.certainty : 'unknown');

      const lbl = document.createElement('span');
      lbl.className = 'file-label';
      // Set via textContent — never innerHTML — to handle special chars safely.
      lbl.textContent = file.slice(dirOf(file).length + 1) || file;

      item.appendChild(badge);
      item.appendChild(lbl);

      // Shared-dependency badge for fanIn > 1
      if (node && node.fanIn > 1) {
        const sh = document.createElement('span');
        sh.className = 'shared-badge';
        sh.textContent = 'shared×' + node.fanIn;
        item.appendChild(sh);
      }

      item.addEventListener('click', () => selectFile(file));
      list.appendChild(item);
      fileItems.set(file, item);
    }

    group.appendChild(list);

    header.addEventListener('click', () => {
      const open = list.style.display !== 'none';
      list.style.display = open ? 'none' : '';
      arrow.classList.toggle('open', !open);
    });

    filePanel.appendChild(group);
  }

  // ── Search ────────────────────────────────────────────────────────────────
  const searchInput = document.getElementById('search');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    for (const [file, el] of fileItems) {
      const match = !q || file.toLowerCase().includes(q);
      el.classList.toggle('hidden', !match);
    }
    // Show "no results" hint if needed
    for (const group of filePanel.querySelectorAll('.dir-group')) {
      const visible = group.querySelectorAll('.file-item:not(.hidden)').length > 0;
      group.style.display = visible ? '' : 'none';
    }
  });

  // ── Selection + highlighting ──────────────────────────────────────────────
  let selectedFile = null;

  function clearHighlights() {
    for (const el of fileItems.values()) {
      el.classList.remove('selected', 'hl-in', 'hl-out', 'hl-shared', 'dim');
    }
  }

  function selectFile(file) {
    if (selectedFile === file) return;
    selectedFile = file;
    clearHighlights();

    const sel = fileItems.get(file);
    if (sel) sel.classList.add('selected');

    // Outgoing: files that this file imports
    const outs = outEdges.get(file) || new Set();
    // Incoming: files that import this file
    const ins = inEdges.get(file) || new Set();
    // Shared: outgoing that are also imported by others (fanIn > 1)
    const sharedOuts = new Set([...outs].filter((f) => {
      const n = repNode(f);
      return n && n.fanIn > 1;
    }));

    for (const [f, el] of fileItems) {
      if (f === file) continue;
      if (sharedOuts.has(f)) {
        el.classList.add('hl-shared');
      } else if (outs.has(f)) {
        el.classList.add('hl-out');
      } else if (ins.has(f)) {
        el.classList.add('hl-in');
      } else {
        el.classList.add('dim');
      }
    }

    renderDetail(file, outs, ins);
  }

  // ── Detail panel ──────────────────────────────────────────────────────────
  const detailEmpty = document.getElementById('detail-empty');
  const detailContent = document.getElementById('detail-content');

  function renderDetail(file, outs, ins) {
    detailEmpty.style.display = 'none';
    detailContent.style.display = '';
    detailContent.innerHTML = '';

    const nodes = nodesByFile.get(file) || [];
    const node = nodes[0];
    if (!node) return;

    // ── Header ──
    const hdr = document.createElement('div');
    hdr.className = 'detail-header';

    const fileEl = document.createElement('div');
    fileEl.className = 'detail-file';
    fileEl.textContent = file;
    hdr.appendChild(fileEl);

    const certEl = document.createElement('span');
    certEl.className = 'detail-cert cert-' + node.certainty;
    certEl.textContent = node.certainty.charAt(0).toUpperCase() + node.certainty.slice(1);
    hdr.appendChild(certEl);

    detailContent.appendChild(hdr);

    // Certainty explanation
    const certDesc = document.createElement('p');
    certDesc.style.cssText = 'font-size:12px;color:var(--muted);margin-bottom:16px;line-height:1.6;';
    const certDescMap = {
      candidate: 'No known internal consumers. Flagged as a retirement candidate. Human review is still required — external consumers are invisible to the internal import graph.',
      unknown:   'Cannot be confidently classified. May be used via a dynamic import, barrel re-export, .d.ts declaration, or declared as a package.json entry point.',
      unsafe:    'Has at least one known internal consumer. Removal would break an existing import.',
    };
    certDesc.textContent = certDescMap[node.certainty] || '';
    detailContent.appendChild(certDesc);

    // ── Stats grid ──
    const grid = document.createElement('div');
    grid.className = 'detail-grid';

    function stat(label, value, color) {
      const card = document.createElement('div');
      card.className = 'stat-card';
      const l = document.createElement('div');
      l.className = 'stat-label';
      l.textContent = label;
      const v = document.createElement('div');
      v.className = 'stat-value';
      v.textContent = String(value);
      if (color) v.style.color = color;
      card.appendChild(l);
      card.appendChild(v);
      return card;
    }

    const fanInColor = node.fanIn === 0 ? 'var(--candidate)' : node.fanIn > 1 ? 'var(--shared)' : 'var(--unsafe)';
    grid.appendChild(stat('Fan-in (importers)', node.fanIn, fanInColor));
    grid.appendChild(stat('Fan-out (imports)', node.fanOut, null));
    grid.appendChild(stat('Exports in file', nodes.length, null));
    if (node.isEntryPoint) {
      grid.appendChild(stat('Entry point', node.entryPointKind || 'yes', 'var(--unknown)'));
    }
    detailContent.appendChild(grid);

    // ── Exports list ──
    if (nodes.length > 1 || (nodes.length === 1 && nodes[0].name !== file.split('/').pop()?.replace(/\\.ts$/, ''))) {
      const expTitle = document.createElement('div');
      expTitle.className = 'section-title';
      expTitle.textContent = 'Exports (' + nodes.length + ')';
      detailContent.appendChild(expTitle);

      const expList = document.createElement('ul');
      expList.className = 'evidence-list';
      for (const n of nodes) {
        const li = document.createElement('li');
        li.className = 'evidence-item';
        const k = document.createElement('span');
        k.className = 'ev-kind';
        k.textContent = n.kind;
        const d = document.createElement('span');
        d.className = 'ev-detail';
        d.textContent = n.name;
        li.appendChild(k);
        li.appendChild(d);
        expList.appendChild(li);
      }
      detailContent.appendChild(expList);
    }

    // ── Evidence ──
    if (node.evidence.length > 0) {
      const evTitle = document.createElement('div');
      evTitle.className = 'section-title';
      evTitle.textContent = 'Evidence';
      detailContent.appendChild(evTitle);

      const evList = document.createElement('ul');
      evList.className = 'evidence-list';
      for (const ev of node.evidence) {
        const li = document.createElement('li');
        li.className = 'evidence-item';
        const k = document.createElement('span');
        k.className = 'ev-kind';
        k.textContent = ev.kind;
        const d = document.createElement('span');
        d.className = 'ev-detail';
        d.textContent = ev.detail;
        li.appendChild(k);
        li.appendChild(d);
        evList.appendChild(li);
      }
      detailContent.appendChild(evList);
    }

    // ── Incoming connections (files that import this file) ──
    if (ins.size > 0) {
      const inTitle = document.createElement('div');
      inTitle.className = 'section-title';
      inTitle.textContent = 'Imported by (' + ins.size + ')';
      detailContent.appendChild(inTitle);

      const inList = document.createElement('ul');
      inList.className = 'conn-list';
      for (const f of ins) {
        const li = document.createElement('li');
        li.className = 'conn-item';
        li.style.borderLeftColor = 'var(--hl-border-in)';
        const arrow = document.createElement('span');
        arrow.className = 'conn-arrow';
        arrow.textContent = '→';
        const lbl = document.createElement('span');
        lbl.textContent = f;
        li.appendChild(arrow);
        li.appendChild(lbl);
        li.addEventListener('click', () => selectFile(f));
        inList.appendChild(li);
      }
      detailContent.appendChild(inList);
    }

    // ── Outgoing connections (files this file imports) ──
    if (outs.size > 0) {
      const outTitle = document.createElement('div');
      outTitle.className = 'section-title';
      outTitle.textContent = 'Imports (' + outs.size + ')';
      detailContent.appendChild(outTitle);

      const outList = document.createElement('ul');
      outList.className = 'conn-list';
      for (const f of outs) {
        const li = document.createElement('li');
        li.className = 'conn-item';
        li.style.borderLeftColor = 'var(--hl-border-out)';
        const isShared = repNode(f) && repNode(f).fanIn > 1;
        if (isShared) li.style.borderLeftColor = 'var(--hl-border-shared)';
        const arrow = document.createElement('span');
        arrow.className = 'conn-arrow';
        arrow.textContent = '←';
        const lbl = document.createElement('span');
        lbl.textContent = f;
        if (isShared) {
          lbl.textContent += ' (shared)';
          lbl.style.color = 'var(--shared)';
        }
        li.appendChild(arrow);
        li.appendChild(lbl);
        li.addEventListener('click', () => selectFile(f));
        outList.appendChild(li);
      }
      detailContent.appendChild(outList);
    }

    // ── Preview removal section ──
    const box = document.createElement('div');
    box.className = 'preview-box';

    const previewTitle = document.createElement('div');
    previewTitle.className = 'preview-title';

    const previewReason = document.createElement('div');
    previewReason.className = 'preview-reason';

    const canPreview = node.certainty === 'candidate' && node.isSoleExport;

    if (canPreview) {
      box.classList.add('can-preview');
      previewTitle.textContent = 'Preview Removal';
      previewReason.textContent =
        'This file is a retirement candidate with a single export — the entire file can be removed. ' +
        'Clicking "Preview removal" calls the /rehearse endpoint with the selected node ID.';

      const btn = document.createElement('button');
      btn.className = 'btn-preview';
      btn.textContent = 'Preview removal';

      const resultEl = document.createElement('pre');
      resultEl.className = 'preview-result';
      resultEl.style.display = 'none';
      const reportLink = document.createElement('a');
      reportLink.textContent = 'Open full report and download patch →';
      reportLink.style.display = 'none';
      reportLink.style.color = 'var(--candidate)';

      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Running…';
        resultEl.style.display = '';
        resultEl.textContent = 'Requesting rehearsal…';
        reportLink.style.display = 'none';
        try {
          // Use the embedded SESSION_ID (set by the server when rendering a
          // session graph page), or fall back to the ?session= query param.
          const sid = SESSION_ID || new URLSearchParams(window.location.search).get('session') || '';
          const resp = await fetch('/rehearse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, candidateId: node.id }),
          });
          const data = await resp.json();
          if (data.ok) {
            const d = data.delta;
            resultEl.textContent =
              'New errors introduced: ' + d.newErrors.length + '\\n' +
              'Resolved errors: ' + d.resolvedErrors.length + '\\n' +
              'Net change: ' + d.netChange + '\\n\\n' +
              (data.patchText ? 'Patch preview (first 2000 chars):\\n' + data.patchText.slice(0, 2000) : '');
            if (sid) {
              const reportUrl = '/report?session=' + encodeURIComponent(sid);
              reportLink.href = reportUrl;
              reportLink.style.display = 'inline-block';
            }
          } else {
            resultEl.textContent = 'Rehearsal unavailable: ' + (data.error || 'unknown error');
          }
        } catch (e) {
          resultEl.textContent = 'Request failed: ' + String(e);
        } finally {
          btn.disabled = false;
          btn.textContent = 'Preview removal';
        }
      });

      box.appendChild(previewTitle);
      box.appendChild(previewReason);
      box.appendChild(btn);
      box.appendChild(resultEl);
      box.appendChild(reportLink);
    } else {
      box.classList.add('no-preview');
      previewTitle.textContent = 'Preview Removal — Not Available';

      let reason = '';
      if (node.certainty === 'unsafe') {
        reason = 'This file has ' + node.fanIn + ' known internal consumer' + (node.fanIn !== 1 ? 's' : '') +
          ' — removing it would break existing imports. Resolve all consumers before attempting removal.';
      } else if (node.certainty === 'unknown') {
        reason = 'This file cannot be confidently classified. It may be used via a dynamic import, ' +
          'a barrel re-export reaching node_modules, or declared as a package.json entry point. ' +
          'Manual inspection is required before removal.';
      } else if (!node.isSoleExport) {
        reason = 'This file exports multiple symbols. Removing the file would affect all of its exports. ' +
          'Only files with a single export (isSoleExport: true) are offered a whole-file preview.';
      } else {
        reason = 'Preview is only available for retirement candidates with a single export.';
      }

      previewReason.textContent = reason;
      box.appendChild(previewTitle);
      box.appendChild(previewReason);
    }

    detailContent.appendChild(box);
  }

  // ── Auto-select the first candidate if any ────────────────────────────────
  const firstCandidate = allFiles.find((f) => repNode(f)?.certainty === 'candidate');
  if (firstCandidate) selectFile(firstCandidate);

})();
</script>

<footer style="text-align:center;padding:12px 0;font-size:12px;color:var(--muted);border-top:1px solid var(--border);background:var(--surface);">
  Made with IBM Bob
</footer>
</body>
</html>`;
}
