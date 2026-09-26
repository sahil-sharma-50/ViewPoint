'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import Header from '../header';
import { AiExchange, useWorkspace, ViewSwitch, WorkspaceStatus, WorkspaceWarnings } from '../workspace';
import type { SerialNode } from '../../src/server';
import type { Explanation } from '../../src/watsonx';
import { githubFileUrl } from '../../src/source-links';
import '../workspace.css';
import FileMap from './file-map';

const basename = (file: string) => file.split('/').pop() || file;
const sourceFile = /\.(?:[cm]?[jt]sx?|py|go|java)$/i;
const ancestors = (file: string) => new Set(file.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/')));
type Directory = { name: string; path: string; folders: Map<string, Directory>; files: SerialNode[] };
type ConnectionFilter = 'all' | 'standalone' | 'no-importers' | 'no-imports';

function fileTree(files: SerialNode[]): Directory {
  const root: Directory = { name: '', path: '', folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.file.split('/');
    let folder = root;
    for (const name of parts.slice(0, -1)) {
      if (!folder.folders.has(name)) folder.folders.set(name, { name, path: folder.path ? `${folder.path}/${name}` : name, folders: new Map(), files: [] });
      folder = folder.folders.get(name)!;
    }
    folder.files.push(file);
  }
  return root;
}

function Inspector({ node, sessionId, repoUrl, files }: {
  node: SerialNode;
  sessionId: string;
  repoUrl: string;
  files: SerialNode[];
}) {
  const [answer, setAnswer] = useState<Explanation>();
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [askedQuestion, setAskedQuestion] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const sourceUrl = githubFileUrl(repoUrl, node.file);

  async function explain() {
    const submitted = question.trim();
    if (!submitted) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setAskedQuestion(submitted);
    setQuestion('');
    setAnswer(undefined);
    setBusy(true);
    try {
      const response = await fetch('/api/map-explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, selection: { kind: 'file', file: node.file }, question: submitted }),
        signal: controller.signal,
      });
      const body = await response.json();
      if (!controller.signal.aborted) setAnswer(body);
    } catch {
      if (!controller.signal.aborted) setAnswer({ ok: false, error: 'Explanation unavailable. The file connections remain visible.' });
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <aside className="vp-inspector" aria-label="Selected file details">
    <div className="vp-evidence-heading"><span>FILE DETAILS</span>{sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">Open source ↗</a>}</div>
    <div className="vp-inspector-heading"><h2>{basename(node.file)}</h2></div>
    <p className="files-inspector-path">{node.file}</p>
    <dl className="vp-facts">
      <div><dt>Files importing this</dt><dd>{node.fanIn}</dd></div>
      <div><dt>Files imported</dt><dd>{node.fanOut}</dd></div>
    </dl>
    <p className="files-hint">Connections come from source imports. Runtime and external links may not appear.</p>
    <section className="vp-ai">
      <div className="vp-ai-heading"><span className="vp-ai-mark" aria-hidden="true">✧</span><h3>Ask about this file</h3><span>watsonx</span></div>
      <p>Granite generates an AI explanation from source evidence when you ask.</p>
      <AiExchange question={askedQuestion} answer={answer} busy={busy} repoUrl={repoUrl} files={files} />
      <form className="vp-ai-form" onSubmit={event => { event.preventDefault(); void explain(); }}>
        <label htmlFor="file-question">Your question</label>
        <input id="file-question" type="text" maxLength={300} placeholder={askedQuestion ? 'Ask another question…' : 'What does this file do?'} value={question} onChange={event => setQuestion(event.target.value)} />
        <button className="vp-secondary" type="submit" disabled={busy || !question.trim()}>{busy ? 'Asking…' : 'Ask Granite'}<span aria-hidden="true">↗</span></button>
      </form>
    </section>
  </aside>;
}

export default function FilesPage() {
  const { data, error, sessionId } = useWorkspace('files');
  const linkedFile = useSearchParams().get('file');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ConnectionFilter>('all');
  const [selected, setSelected] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLElement>(null);
  const files = useMemo(() => [...(data?.graph.nodes ?? [])].sort((a, b) => a.file.localeCompare(b.file)), [data]);
  const sourceFiles = files.filter(item => sourceFile.test(item.file));
  useEffect(() => {
    if (!files.length) return;
    const saved = sessionStorage.getItem(`viewpoint:files:${sessionId}`);
    const initial = linkedFile && files.some(item => item.file === linkedFile) ? linkedFile
      : saved && files.some(item => item.file === saved) ? saved
      : files.find(item => item.isEntryPoint)?.file ?? files[0]!.file;
    setSelected(initial);
    setExpanded(ancestors(initial));
  }, [files, linkedFile, sessionId]);
  useEffect(() => { if (selected) sessionStorage.setItem(`viewpoint:files:${sessionId}`, selected); }, [selected, sessionId]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      const active = list?.querySelector<HTMLElement>('.vp-file[aria-current="true"]');
      if (!list || !active) return;
      const area = list.getBoundingClientRect();
      const row = active.getBoundingClientRect();
      if (row.top < area.top + 4) list.scrollTop += row.top - area.top - 6;
      else if (row.bottom > area.bottom - 4) list.scrollTop += row.bottom - area.bottom + 6;
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, filter, query]);
  function selectFile(file: string, fromMap = false) {
    setSelected(file);
    setExpanded(ancestors(file));
    if (fromMap) { setFilter('all'); setQuery(''); }
  }
  const filtered = files.filter(node => node.file.toLowerCase().includes(query.trim().toLowerCase()) && (
    filter === 'all' ||
    (sourceFile.test(node.file) && (
      (filter === 'standalone' && node.fanIn === 0 && node.fanOut === 0) ||
      (filter === 'no-importers' && node.fanIn === 0) ||
      (filter === 'no-imports' && node.fanOut === 0)
    ))
  ));
  const tree = fileTree(filtered);
  const node = files.find(item => item.file === selected);
  const searching = Boolean(query.trim());
  const toggleFolder = (path: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  function renderFolder(folder: Directory, depth = 0): ReactNode {
    return <>
      {[...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map(child => {
        const open = searching || expanded.has(child.path);
        return <li key={child.path}>
          <button type="button" className="vp-folder" style={{ paddingLeft: 8 + depth * 15 }} aria-expanded={open} onClick={() => toggleFolder(child.path)} title={child.path}>
            <span className="vp-folder-chevron" aria-hidden="true" /><span>{child.name}</span>
          </button>
          {open && <ul>{renderFolder(child, depth + 1)}</ul>}
        </li>;
      })}
      {folder.files.map(item => <li key={item.file}><button type="button" className="vp-file" style={{ paddingLeft: 25 + depth * 15 }} aria-current={selected === item.file ? 'true' : undefined} onClick={() => selectFile(item.file)} title={item.file}>
        <span>{basename(item.file)}</span>
      </button></li>)}
    </>;
  }

  return <div className="repository-workspace"><Header workspace repoName={data?.repoUrl.replace('https://github.com/', '')} />
    {!data ? <WorkspaceStatus error={error} /> : <main className="vp-main">
      <div className="vp-titlebar"><div><h1>Files</h1><span aria-hidden="true">|</span><p>See what each file imports and what imports it.</p></div><ViewSwitch sessionId={sessionId} view="files" /></div>
      <WorkspaceWarnings warnings={data.graph.warnings} />
      <div className="vp-shell">
        <aside className="vp-sidebar" aria-label="Repository files">
          <div className="vp-sidebar-title"><h2>Repository files</h2><span>{files.length} files</span></div>
          <label className="vp-search"><span className="vp-sr-only">Search files</span><input type="search" placeholder="Find a file…" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <div className="vp-connection-filters" aria-label="Filter files by known imports">
            {([
              ['all', 'All', files.length],
              ['standalone', 'Standalone', sourceFiles.filter(item => item.fanIn === 0 && item.fanOut === 0).length],
              ['no-importers', 'No importers', sourceFiles.filter(item => item.fanIn === 0).length],
              ['no-imports', 'No imports', sourceFiles.filter(item => item.fanOut === 0).length],
            ] as const).map(([value, label, count]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} title={value === 'standalone' ? 'Neither imports files nor is imported by another file' : value === 'no-importers' ? 'No known files import this file' : value === 'no-imports' ? 'This file has no known internal imports' : 'Show every file'}>{label}<span>{count}</span></button>)}
          </div>
          <div className="vp-list-label">{filtered.length} {filtered.length === 1 ? 'FILE' : 'FILES'}</div>
          <nav ref={listRef} className="vp-file-list" aria-label={filter === 'all' ? 'Repository file tree' : 'Filtered files'}><ul>
            {filter === 'all' ? renderFolder(tree) : filtered.map(item => <li key={item.file}><button type="button" className="vp-file vp-flat-file" aria-current={selected === item.file ? 'true' : undefined} onClick={() => selectFile(item.file)} title={item.file}>
              <span><strong>{basename(item.file)}</strong><small>{item.file.slice(0, -basename(item.file).length).replace(/\/$/, '') || 'Repository root'}</small></span>
            </button></li>)}
            {!filtered.length && <li className="vp-list-empty">No files match your search or filter.</li>}
          </ul></nav>
        </aside>
        <div className="vp-detail"><FileMap graph={data.graph} selected={node?.file} select={file => selectFile(file, true)} /></div>
        {node ? <Inspector key={`${sessionId}:${node.file}`} node={node} sessionId={sessionId} repoUrl={data.repoUrl} files={data.graph.nodes} /> : <aside className="vp-inspector files-inspector-empty"><h2>Choose a file</h2><p>Select a file to see its source connections.</p></aside>}
      </div>
    </main>}
  </div>;
}
