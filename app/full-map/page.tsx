'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Header from '../header';
import { AiExchange, useWorkspace, ViewSwitch, WorkspaceStatus, WorkspaceWarnings } from '../workspace';
import { buildFolderMap, buildHttpFolderLinks, folderContents, topFolder, traceDependents } from '../../src/full-map';
import { folderRoutePath, layoutFolders } from '../../src/folder-layout';
import type { Architecture } from '../../src/architecture';
import '../workspace.css';
import './map.css';

type Selection =
  | { kind: 'file'; file: string }
  | { kind: 'folder'; folder: string }
  | { kind: 'link'; source: string; target: string };
type AiAnswer = { ok: true; summary: string; evidence: string[] } | { ok: false; error: string };
const label = (folder: string) => (folder ? folder.split('/').pop() : 'Repository root');
const nestedTrail = (file: string) => {
  const directories = file.split('/').slice(0, -1);
  const clusterDepth = topFolder(file).split('/').filter(Boolean).length;
  return directories
    .slice(clusterDepth)
    .map((_, index) => directories.slice(0, clusterDepth + index + 1).join('/'));
};

export default function FullMapPage() {
  const workspace = useWorkspace('files');
  return <FullMap key={workspace.sessionId} workspace={workspace} />;
}

function FullMap({ workspace }: { workspace: ReturnType<typeof useWorkspace> }) {
  const { data, error, sessionId } = workspace;
  const focus = useSearchParams().get('focus');
  const [showSupport, setShowSupport] = useState(false);
  const [showHttp, setShowHttp] = useState(false);
  const [architecture, setArchitecture] = useState<Architecture>();
  const [httpError, setHttpError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [nested, setNested] = useState<Set<string>>(new Set());
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [selection, setSelection] = useState<Selection>();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeResult, setActiveResult] = useState(-1);
  const [restoredSession, setRestoredSession] = useState('');
  const [aiQuestion, setAiQuestion] = useState('');
  const [askedQuestion, setAskedQuestion] = useState('');
  const [aiAnswer, setAiAnswer] = useState<AiAnswer>();
  const [aiBusy, setAiBusy] = useState(false);
  const aiRequest = useRef<AbortController | null>(null);
  const [exportStatus, setExportStatus] = useState('');
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const measureFileLinks = useRef<() => void>(() => {});
  const [fileRoutes, setFileRoutes] = useState<{ source: string; target: string; path: string; x: number; y: number }[]>([]);
  const fittedSize = useRef({ width: 0, height: 0 });
  const resultsRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; offsetX: number; offsetY: number; clearSelection: boolean } | undefined>(
    undefined,
  );
  const map = useMemo(
    () => (data ? buildFolderMap(data.graph, showSupport) : undefined),
    [data, showSupport],
  );
  const httpLinks = useMemo(
    () => (showHttp && architecture && map ? buildHttpFolderLinks(map, architecture.calls) : []),
    [showHttp, architecture, map],
  );
  const layoutLinks = useMemo(() => {
    const combined = new Map<string, { source: string; target: string; count: number }>();
    for (const link of [...(map?.links ?? []), ...httpLinks]) {
      const key = `${link.source}\0${link.target}`;
      const existing = combined.get(key);
      if (existing) existing.count += link.count;
      else combined.set(key, { ...link });
    }
    return [...combined.values()];
  }, [map, httpLinks]);
  const layout = useMemo(
    () => (map ? layoutFolders(map.folders, layoutLinks, expanded) : undefined),
    [map, layoutLinks, expanded],
  );
  const selectedFile = selection?.kind === 'file' ? selection.file : undefined;
  const selectedNode = selectedFile ? map?.files.get(selectedFile) : undefined;
  const impact = useMemo(
    () => (selectedFile && data ? traceDependents(data.graph, selectedFile) : undefined),
    [data, selectedFile],
  );
  const searchResults = useMemo(
    () =>
      query.trim() && map
        ? [...map.files.values()]
            .filter(node => node.file.toLowerCase().includes(query.trim().toLowerCase()))
            .slice(0, 30)
        : [],
    [query, map],
  );
  const linksFromFile = useMemo(
    () =>
      selectedFile && map
        ? map.fileLinks.filter(link => link.source === selectedFile || link.target === selectedFile)
        : [],
    [selectedFile, map],
  );
  const selectedFolderLinks = useMemo(
    () =>
      new Set(linksFromFile.map(link => `${topFolder(link.source)}\0${topFolder(link.target)}`)),
    [linksFromFile],
  );
  const connectedFiles = useMemo(
    () => new Set(linksFromFile.flatMap(link => [link.source, link.target])),
    [linksFromFile],
  );
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !selectedFile) {
      measureFileLinks.current = () => setFileRoutes([]);
      setFileRoutes([]);
      return;
    }
    const measure = () => {
      const stageBounds = stage.getBoundingClientRect();
      const rows = new Map<string, HTMLElement>();
      const cards = new Map<string, HTMLElement>();
      stage.querySelectorAll<HTMLElement>('.atlas-file[data-file]').forEach(row => {
        if (row.dataset.file) rows.set(row.dataset.file, row);
      });
      stage.querySelectorAll<HTMLElement>('.atlas-cluster[data-folder]').forEach(card => {
        if (card.dataset.folder !== undefined) cards.set(card.dataset.folder, card);
      });
      const routes = linksFromFile.flatMap(link => {
        const from = rows.get(link.source);
        const to = rows.get(link.target);
        const sourceCard = cards.get(topFolder(link.source))?.getBoundingClientRect();
        const targetCard = cards.get(topFolder(link.target))?.getBoundingClientRect();
        if (!sourceCard || !targetCard) return [];
        const sameColumn = sourceCard.left < targetCard.right && targetCard.left < sourceCard.right;
        const leftToRight = sourceCard.left < targetCard.left;
        const point = (row: HTMLElement | undefined, card: DOMRect, right: boolean) => {
          const bounds = row?.getBoundingClientRect();
          const clip = row?.closest('.atlas-cluster-scroll')?.getBoundingClientRect();
          const center = bounds ? bounds.top + bounds.height / 2 : card.top + card.height / 2;
          const visible = bounds && clip && center >= clip.top && center <= clip.bottom;
          return {
            x: ((visible ? right ? bounds.right : bounds.left : right ? card.right : card.left) - stageBounds.left) / viewport.scale,
            y: ((visible ? center : Math.max(card.top + 16, Math.min(card.bottom - 16, center))) - stageBounds.top) / viewport.scale,
          };
        };
        const a = point(from, sourceCard, sameColumn || leftToRight);
        const b = point(to, targetCard, sameColumn || !leftToRight);
        const { x: x1, y: y1 } = a;
        const { x: x2, y: y2 } = b;
        const bend = Math.max(50, Math.abs(x2 - x1) / 2);
        const direction = leftToRight ? 1 : -1;
        const lane = (Math.max(sourceCard.right, targetCard.right) - stageBounds.left) / viewport.scale + 24;
        return [{ source: link.source, target: link.target,
          path: sameColumn
            ? folderRoutePath([{ x: x1, y: y1 }, { x: lane, y: y1 }, { x: lane, y: y2 }, { x: x2, y: y2 }])
            : `M ${x1} ${y1} C ${x1 + direction * bend} ${y1}, ${x2 - direction * bend} ${y2}, ${x2} ${y2}`,
          x: x1, y: y1 }];
      });
      setFileRoutes(routes);
    };
    measureFileLinks.current = measure;
    const frame = requestAnimationFrame(measure);
    const settled = setTimeout(measure, 380);
    return () => { cancelAnimationFrame(frame); clearTimeout(settled); };
  }, [selectedFile, linksFromFile, expanded, nested, limits, layout, viewport.scale]);

  useEffect(() => {
    if (!data || !sessionId || restoredSession === sessionId) return;
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(`viewpoint:full-map:${sessionId}`) || 'null',
      );
      if (saved) {
        setShowSupport(Boolean(saved.showSupport));
        setShowHttp(Boolean(saved.showHttp));
        setExpanded(new Set(Array.isArray(saved.expanded) ? saved.expanded : []));
        setNested(new Set(Array.isArray(saved.nested) ? saved.nested : []));
        if (
          saved.selection?.kind === 'file' &&
          data.graph.nodes.some(node => node.file === saved.selection.file)
        )
          setSelection(saved.selection);
        else if (saved.selection?.kind === 'folder' || saved.selection?.kind === 'link')
          setSelection(saved.selection);
      }
    } catch {
      /* Ignore stale browser state. */
    }
    setRestoredSession(sessionId);
  }, [data, sessionId, restoredSession]);
  useLayoutEffect(() => {
    if (restoredSession !== sessionId || !sessionId) return;
    sessionStorage.setItem(
      `viewpoint:full-map:${sessionId}`,
      JSON.stringify({
        showSupport,
        showHttp,
        expanded: [...expanded],
        nested: [...nested],
        selection,
        viewport: { ...viewport, ...fittedSize.current },
      }),
    );
  }, [sessionId, restoredSession, showSupport, showHttp, expanded, nested, selection, viewport]);
  useEffect(() => {
    if (restoredSession === sessionId && focus && map?.files.has(focus)) selectFile(focus);
  }, [focus, restoredSession, sessionId, map]);
  useEffect(() => {
    if (selectedFile && map && !map.files.has(selectedFile)) {
      setSelection(undefined);
    }
  }, [map, selectedFile]);
  useEffect(() => {
    setAiAnswer(undefined);
    setAskedQuestion('');
    setAiQuestion('');
    setAiBusy(false);
    return () => aiRequest.current?.abort();
  }, [selection, sessionId]);
  useEffect(() => {
    if (!exportStatus) return;
    const timer = setTimeout(() => setExportStatus(''), 4000);
    return () => clearTimeout(timer);
  }, [exportStatus]);
  useEffect(() => {
    setHttpError('');
    if (!showHttp || architecture || !sessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(
          `/api/workspace?session=${encodeURIComponent(sessionId)}&view=architecture`,
          { signal: controller.signal, cache: 'no-store' },
        );
        if (response.status === 202) {
          if (controller.signal.aborted) return;
          timer = setTimeout(() => void load(), 500);
          return;
        }
        const body = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(body.error || 'HTTP relationships are unavailable.');
        setArchitecture(body.architecture);
      } catch (reason) {
        if (!controller.signal.aborted)
          setHttpError(
            reason instanceof Error ? reason.message : 'HTTP relationships are unavailable.',
          );
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [showHttp, architecture, sessionId]);
  useEffect(() => {
    if (!layout || !viewportRef.current) return;
    const element = viewportRef.current;
    const fit = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (
        !width ||
        !height ||
        (fittedSize.current.width === width && fittedSize.current.height === height)
      )
        return;
      const previous = fittedSize.current;
      fittedSize.current = { width, height };
      if (previous.width && previous.height) {
        setViewport(current => ({ ...current, x: current.x + (width - previous.width) / 2, y: current.y + (height - previous.height) / 2 }));
        return;
      }
      try {
        const saved = JSON.parse(sessionStorage.getItem(`viewpoint:full-map:${sessionId}`) || 'null')?.viewport;
        if (saved && Math.abs(saved.width - width) < 2 && Math.abs(saved.height - height) < 2 && Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.scale) && saved.scale >= 0.01 && saved.scale <= 3) {
          setViewport({ x: saved.x, y: saved.y, scale: saved.scale });
          return;
        }
      } catch { /* Ignore stale browser state. */ }
      const scale = Math.min(1, (width - 48) / layout.width, (height - 48) / layout.height);
      setViewport({ scale, x: (width - layout.width * scale) / 2, y: (height - layout.height * scale) / 2 });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [layout]);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if ((event.target as Element).closest('.atlas-cluster-scroll')) return;
      event.preventDefault();
      const frame = element.getBoundingClientRect();
      const x = event.clientX - frame.left;
      const y = event.clientY - frame.top;
      setViewport(current => {
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
        const scale = Math.max(0.01, Math.min(3, current.scale * Math.exp(-Math.max(-120, Math.min(120, delta)) * 0.0015)));
        return {
          scale,
          x: x - ((x - current.x) * scale) / current.scale,
          y: y - ((y - current.y) * scale) / current.scale,
        };
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [layout]);

  const selectFile = (file: string) => {
    if (!map?.files.has(file)) return;
    setSelection({ kind: 'file', file });
    setExpanded(current => new Set([...current, topFolder(file)]));
    setNested(current => new Set([...current, ...nestedTrail(file)]));
    setLimits(current => {
      const next = { ...current };
      const parent = file.split('/').slice(0, -1).join('/');
      next[parent] = Math.max(next[parent] ?? 30, folderContents(map, parent, { limit: Infinity }).total);
      return next;
    });
  };
  useEffect(() => {
    if (activeResult < 0) return;
    const list = resultsRef.current;
    const option = list?.querySelector<HTMLElement>(`#atlas-result-${activeResult}`);
    if (!list || !option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
  }, [activeResult]);
  const toggleTop = (folder: string) =>
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  const toggleNested = (folder: string) =>
    setNested(current => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  const zoom = (factor: number) =>
    setViewport(current => {
      const scale = Math.max(0.01, Math.min(3, current.scale * factor));
      const centerX = (viewportRef.current?.clientWidth ?? 0) / 2;
      const centerY = (viewportRef.current?.clientHeight ?? 0) / 2;
      return {
        scale,
        x: centerX - ((centerX - current.x) * scale) / current.scale,
        y: centerY - ((centerY - current.y) * scale) / current.scale,
      };
    });
  function exportSvg() {
    if (!layout || !map) return '';
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('xmlns', ns);
    svg.setAttribute('width', String(layout.width));
    svg.setAttribute('height', String(layout.height));
    svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
    const styles = getComputedStyle(document.querySelector('.atlas-page')!);
    const color = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback;
    const add = (
      parent: SVGElement,
      tag: string,
      attrs: Record<string, string | number>,
      content?: string,
    ) => {
      const element = document.createElementNS(ns, tag);
      for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
      if (content !== undefined) element.textContent = content;
      parent.append(element);
      return element;
    };
    add(svg, 'title', {}, 'Full repository map');
    const defs = add(svg, 'defs', {});
    const marker = add(defs, 'marker', {
      id: 'export-arrow',
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: 'auto',
    });
    add(marker, 'path', { d: 'M 0 1 L 9 5 L 0 9 z', fill: color('--accent', '#75aaff') });
    add(svg, 'rect', {
      width: layout.width,
      height: layout.height,
      fill: color('--bg', '#111214'),
    });
    const httpMarker = marker.cloneNode(true) as SVGElement;
    httpMarker.setAttribute('id', 'export-http-arrow');
    httpMarker.querySelector('path')!.setAttribute('fill', '#e3a366');
    defs.append(httpMarker);
    for (const link of map.links) {
      const route = layout.routes.get(`${link.source}\0${link.target}`);
      if (!route) continue;
      add(svg, 'path', {
        d: folderRoutePath(route),
        fill: 'none',
        stroke: color('--accent', '#75aaff'),
        'stroke-width': 2,
        opacity: 0.7,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'marker-end': 'url(#export-arrow)',
      });
    }
    for (const link of httpLinks) {
      const route = layout.routes.get(`${link.source}\0${link.target}`);
      if (route)
        add(svg, 'path', {
          d: folderRoutePath(route.map((point, index) => index > 0 && index < route.length - 1 ? { x: point.x, y: point.y + 6 } : point)),
          fill: 'none',
          stroke: '#e3a366',
          'stroke-width': 2,
          'stroke-dasharray': '7 5',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          'marker-end': 'url(#export-http-arrow)',
        });
    }
    for (const folder of map.folders) {
      const card = layout.cards.get(folder.path)!;
      add(svg, 'rect', {
        x: card.x,
        y: card.y,
        width: card.width,
        height: card.height,
        rx: 12,
        fill: color('--surface', '#181b20'),
        stroke: color('--border', '#30343d'),
      });
      add(
        svg,
        'text',
        {
          x: card.x + 16,
          y: card.y + 31,
          fill: color('--text', '#f2f3f5'),
          'font-size': 16,
          'font-weight': 600,
          'font-family': 'Arial, sans-serif',
        },
        `${label(folder.path)}${folder.path ? '/' : ''}`,
      );
      add(
        svg,
        'text',
        {
          x: card.x + 16,
          y: card.y + 56,
          fill: color('--muted', '#aeb4c0'),
          'font-size': 11,
          'font-family': 'Arial, sans-serif',
        },
        `${folder.fileCount} ${folder.fileCount === 1 ? 'file' : 'files'}`,
      );
      if (expanded.has(folder.path)) {
        const names = folderContents(map, folder.path, { limit: 12 }).files.map(node =>
          node.file.split('/').pop()!,
        );
        names.forEach((name, index) =>
          add(
            svg,
            'text',
            {
              x: card.x + 16,
              y: card.y + 88 + index * 21,
              fill: color('--text', '#f2f3f5'),
              'font-size': 11,
              'font-family': 'Arial, sans-serif',
            },
            name.length > 34 ? name.slice(0, 31) + '…' : name,
          ),
        );
      }
    }
    return new XMLSerializer().serializeToString(svg);
  }
  async function exportMap(action: 'copy-svg' | 'copy-png' | 'download-svg' | 'download-png') {
    if (!layout) return;
    const format = action.endsWith('svg') ? 'SVG' : 'PNG';
    setExportStatus(`Preparing ${format}…`);
    try {
      const source = exportSvg();
      let blob = new Blob([source], { type: 'image/svg+xml' });
      if (format === 'PNG') {
        const url = URL.createObjectURL(blob);
        try {
          const image = new Image();
          image.src = url;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = layout.width * 2;
          canvas.height = layout.height * 2;
          canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
          blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              value => (value ? resolve(value) : reject(new Error('PNG conversion failed'))),
              'image/png',
            ),
          );
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      if (action.startsWith('copy')) {
        if (format === 'SVG') await navigator.clipboard.writeText(source);
        else await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `full-map.${format.toLowerCase()}`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setExportStatus(`${format} ${action.startsWith('copy') ? 'copied' : 'downloaded'}.`);
    } catch {
      setExportStatus(`${format} export failed. Try downloading it instead.`);
    }
  }
  async function askAi(question: string) {
    const submitted = question.trim();
    if (!selection || !sessionId || !submitted) return;
    aiRequest.current?.abort();
    const controller = new AbortController();
    aiRequest.current = controller;
    setAskedQuestion(submitted);
    setAiQuestion('');
    setAiBusy(true);
    setAiAnswer(undefined);
    try {
      const response = await fetch('/api/map-explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, selection, question: submitted }),
        signal: controller.signal,
      });
      const body = await response.json();
      if (controller.signal.aborted) return;
      setAiAnswer(
        response.ok ? body : { ok: false, error: body.error || 'AI explanation unavailable.' },
      );
    } catch {
      if (!controller.signal.aborted) setAiAnswer({ ok: false, error: 'AI explanation unavailable.' });
    } finally {
      if (!controller.signal.aborted) setAiBusy(false);
    }
  }
  function renderFolderItems(folder: string, depth = 0) {
    if (!map || depth > 12) return null;
    const contents = folderContents(map, folder, { limit: limits[folder] ?? 30 });
    const folders = contents.folders;
    const files = contents.files;
    return (
      <div className="atlas-children" style={{ paddingLeft: depth ? 12 : 0 }}>
        {folders.map(child => (
          <div key={child} className="atlas-nested">
            <button
              type="button"
              onClick={() => toggleNested(child)}
              aria-expanded={nested.has(child)}
            >
              {nested.has(child) ? '▾' : '▸'} {label(child)}/
            </button>
            {nested.has(child) && renderFolderItems(child, depth + 1)}
          </div>
        ))}
        {files.map(node => (
          <button
            key={node.file}
            type="button"
            className={`atlas-file ${selectedFile === node.file ? 'is-selected' : connectedFiles.has(node.file) ? 'is-connected' : ''}`}
            data-file={node.file}
            onClick={() => selectFile(node.file)}
            title={node.file}
          >
            <span>{node.file.split('/').pop()}</span>
            <i className="atlas-dot" aria-hidden="true" />
          </button>
        ))}
        {contents.remaining > 0 && (
          <button
            type="button"
            className="atlas-more"
            onClick={() =>
              setLimits(current => ({ ...current, [folder]: (current[folder] ?? 30) + 30 }))
            }
          >
            Show {Math.min(30, contents.remaining)} more · {contents.remaining} hidden
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="atlas-page repository-workspace">
      <Header workspace repoName={data?.repoUrl.replace('https://github.com/', '')} />
      {!data || !map || !layout ? (
        <WorkspaceStatus error={error} />
      ) : (
        <main className="atlas-shell vp-main">
          <div className="vp-titlebar">
            <div>
              <h1>Full Map</h1>
              <span aria-hidden="true">|</span>
              <p>Explore folders, follow code links, and see how files connect.</p>
            </div>
            <ViewSwitch sessionId={sessionId} view="full-map" />
          </div>
          <WorkspaceWarnings warnings={data.graph.warnings} />
          <div className="atlas-panel" ref={panelRef}>
          <div className="atlas-toolbar">
            <div className="atlas-search-wrap">
              <label className="atlas-search">
                <span className="vp-sr-only">Search repository files</span>
                <input
                  type="search"
                  role="combobox"
                  aria-expanded={searchOpen && Boolean(query.trim())}
                  aria-controls="atlas-search-results"
                  aria-activedescendant={
                    activeResult >= 0 ? `atlas-result-${activeResult}` : undefined
                  }
                  value={query}
                  onChange={event => {
                    setQuery(event.target.value);
                    setActiveResult(-1);
                    setSearchOpen(true);
                  }}
                  onFocus={() => setSearchOpen(true)}
                  onKeyDown={event => {
                    if (event.key === 'Escape') {
                      setSearchOpen(false);
                      setActiveResult(-1);
                      return;
                    }
                    if (!searchResults.length) return;
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault();
                      setSearchOpen(true);
                      setActiveResult(current =>
                        event.key === 'ArrowDown'
                          ? Math.min(current + 1, searchResults.length - 1)
                          : current < 0
                            ? searchResults.length - 1
                            : Math.max(current - 1, 0),
                      );
                    } else if (event.key === 'Enter' && activeResult >= 0) {
                      event.preventDefault();
                      selectFile(searchResults[activeResult]!.file);
                      setQuery('');
                      setSearchOpen(false);
                      setActiveResult(-1);
                    }
                  }}
                  placeholder="Find any file…"
                />
              </label>
              {searchOpen && query.trim() && (
                <div
                  id="atlas-search-results"
                  ref={resultsRef}
                  className="atlas-search-results"
                  role="listbox"
                  aria-label="File search results"
                >
                  <div className="atlas-results-heading">
                    {searchResults.length
                      ? `${searchResults.length} matching ${searchResults.length === 1 ? 'file' : 'files'}`
                      : 'No matching files'}
                  </div>
                  {searchResults.map((node, index) => (
                    <button
                      type="button"
                      id={`atlas-result-${index}`}
                      role="option"
                      aria-selected={index === activeResult}
                      key={node.file}
                      onMouseEnter={() => setActiveResult(index)}
                      onClick={() => {
                        selectFile(node.file);
                        setQuery('');
                        setSearchOpen(false);
                        setActiveResult(-1);
                      }}
                    >
                      <strong>{node.file.split('/').pop()}</strong>
                      <small>
                        {node.file.includes('/')
                          ? node.file.slice(0, node.file.lastIndexOf('/'))
                          : 'Repository root'}
                      </small>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <label>
              <input
                type="checkbox"
                checked={showSupport}
                onChange={event => setShowSupport(event.target.checked)}
              />{' '}
              Tests &amp; support
            </label>
            <label>
              <input
                type="checkbox"
                checked={showHttp}
                onChange={event => setShowHttp(event.target.checked)}
              />{' '}
              HTTP layer
            </label>
            <span className="atlas-count">
              {map.folders.length} clusters · {map.files.size} files · {map.fileLinks.length} known
              links
            </span>
          </div>
          {httpError && (
            <p className="atlas-note" role="status">
              {httpError}
            </p>
          )}
          <div className="atlas-workspace">
            <div className="atlas-map-wrap">
              <div className="atlas-map-tools">
                <button type="button" onClick={() => zoom(1.2)} aria-label="Zoom in">
                  +
                </button>
                <button type="button" onClick={() => zoom(1 / 1.2)} aria-label="Zoom out">
                  −
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const element = viewportRef.current;
                    if (!element) return;
                    const scale = Math.min(
                      1,
                      (element.clientWidth - 48) / layout.width,
                      (element.clientHeight - 48) / layout.height,
                    );
                    setViewport({
                      scale,
                      x: (element.clientWidth - layout.width * scale) / 2,
                      y: (element.clientHeight - layout.height * scale) / 2,
                    });
                  }}
                >
                  Fit
                </button>
                <button
                  type="button"
                  aria-label="Expand map"
                  title="Expand map"
                  onClick={() => {
                    if (document.fullscreenElement) void document.exitFullscreen();
                    else void panelRef.current?.requestFullscreen();
                  }}
                >
                  ⤢
                </button>
                <details className="atlas-export">
                  <summary aria-label="Copy or download map" title="Copy or download map">
                    ⧉
                  </summary>
                  <div className="atlas-export-menu">
                    {(['copy-svg', 'copy-png', 'download-svg', 'download-png'] as const).map(
                      action => (
                        <button
                          key={action}
                          type="button"
                          onClick={event => {
                            event.currentTarget.closest('details')!.open = false;
                            void exportMap(action);
                          }}
                        >
                          {action === 'copy-svg'
                            ? 'Copy SVG'
                            : action === 'copy-png'
                              ? 'Copy PNG'
                              : action === 'download-svg'
                                ? 'Download SVG'
                                : 'Download PNG'}
                        </button>
                      ),
                    )}
                  </div>
                </details>
              </div>
              <span className="atlas-export-status" role="status">
                {exportStatus}
              </span>
              <div
                ref={viewportRef}
                className="atlas-viewport"
                tabIndex={0}
                aria-label="Full repository map"
                onKeyDown={event => {
                  if (event.key === '+') zoom(1.2);
                  else if (event.key === '-') zoom(1 / 1.2);
                  else if (event.key.startsWith('Arrow')) {
                    event.preventDefault();
                    setViewport(current => ({
                      ...current,
                      x:
                        current.x +
                        (event.key === 'ArrowLeft' ? 45 : event.key === 'ArrowRight' ? -45 : 0),
                      y:
                        current.y +
                        (event.key === 'ArrowUp' ? 45 : event.key === 'ArrowDown' ? -45 : 0),
                    }));
                  }
                }}
                onPointerDown={event => {
                  if (event.button !== 0 || (event.target as HTMLElement).closest('button,a,input,.atlas-cluster-scroll'))
                    return;
                  event.preventDefault();
                  event.currentTarget.focus();
                  drag.current = {
                    x: event.clientX,
                    y: event.clientY,
                    offsetX: viewport.x,
                    offsetY: viewport.y,
                    clearSelection: !(event.target as Element).closest('.atlas-cluster,.atlas-link'),
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={event => {
                  const start = drag.current;
                  if (!start) return;
                  const x = start.offsetX + event.clientX - start.x;
                  const y = start.offsetY + event.clientY - start.y;
                  setViewport(current => ({ ...current, x, y }));
                }}
                onPointerUp={event => {
                  const start = drag.current;
                  if (start?.clearSelection && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5)
                    setSelection(undefined);
                  drag.current = undefined;
                }}
                onPointerCancel={() => {
                  drag.current = undefined;
                }}
                onLostPointerCapture={() => {
                  drag.current = undefined;
                }}
              >
                <div
                  ref={stageRef}
                  className="atlas-map-stage"
                  style={{
                    width: layout.width,
                    height: layout.height,
                    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
                  }}
                >
                  <svg
                    className={`atlas-lines ${selectedFile ? 'is-file-focused' : ''}`}
                    width={layout.width}
                    height={layout.height}
                    aria-label="Folder connections"
                  >
                    <defs>
                      <marker id="atlas-http-arrow" viewBox="0 0 8 8" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                        <path d="M0 0 L8 4 L0 8" style={{ fill: '#e3a366' }} />
                      </marker>
                      <marker
                        id="atlas-arrow"
                        markerWidth="8"
                        markerHeight="8"
                        refX="7"
                        refY="4"
                        orient="auto"
                      >
                        <path d="M0 0 L8 4 L0 8" />
                      </marker>
                    </defs>
                    {map.links.map(link => {
                      const route = layout.routes.get(`${link.source}\0${link.target}`);
                      if (!route) return null;
                      const active =
                        selection?.kind === 'link'
                          ? selection.source === link.source && selection.target === link.target
                          : selectedFile
                            ? selectedFolderLinks.has(`${link.source}\0${link.target}`)
                            : selection?.kind === 'folder' &&
                              (selection.folder === link.source ||
                                selection.folder === link.target);
                      return (
                        <g
                          key={`${link.source}:${link.target}`}
                          className={`atlas-link ${active ? 'is-active' : ''}`}
                        >
                          <path d={folderRoutePath(route)} markerEnd="url(#atlas-arrow)" />
                          <path
                            className="atlas-link-hit"
                            d={folderRoutePath(route)}
                            role="button"
                            tabIndex={0}
                            aria-label={`${label(link.source)} to ${label(link.target)}: ${link.count} known links`}
                            onClick={() =>
                              setSelection({
                                kind: 'link',
                                source: link.source,
                                target: link.target,
                              })
                            }
                            onKeyDown={event => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setSelection({
                                  kind: 'link',
                                  source: link.source,
                                  target: link.target,
                                });
                              }
                            }}
                          />
                          <title>
                              {`${link.count} known code links`}
                          </title>
                        </g>
                      );
                    })}
                    {httpLinks.map(link => {
                      const route = layout.routes.get(`${link.source}\0${link.target}`);
                      return route ? (
                        <path
                          key={`http:${link.source}:${link.target}`}
                          className="atlas-http-link"
                          d={folderRoutePath(route.map((point, index) => index > 0 && index < route.length - 1 ? { x: point.x, y: point.y + 6 } : point))}
                          markerEnd="url(#atlas-http-arrow)"
                          aria-label={`${label(link.source)} requests ${label(link.target)}: ${link.count} detected HTTP calls`}
                        />
                      ) : null;
                    })}
                  </svg>
                  {map.folders.map(folder => {
                    const card = layout.cards.get(folder.path)!;
                    const open = expanded.has(folder.path);
                    return (
                      <section
                        key={folder.path}
                        data-folder={folder.path}
                        className={`atlas-cluster ${open ? 'is-expanded' : ''} ${selection?.kind === 'folder' && selection.folder === folder.path ? 'is-selected' : ''}`}
                        style={{
                          left: card.x,
                          top: card.y,
                          width: card.width,
                          height: card.height,
                        }}
                        aria-label={`${label(folder.path)} folder`}
                        onTransitionEnd={event => { if (event.target === event.currentTarget) measureFileLinks.current(); }}
                      >
                        <div className="atlas-cluster-top">
                          <button
                            type="button"
                            className="atlas-folder-name"
                            onClick={() => {
                              setSelection({ kind: 'folder', folder: folder.path });
                              toggleTop(folder.path);
                            }}
                            aria-expanded={open}
                          >
                            <span className="atlas-folder-icon">▦</span>
                            <span>
                              <small>FOLDER CLUSTER</small>
                              <strong>
                                {label(folder.path)}
                                {folder.path ? '/' : ''}
                              </strong>
                            </span>
                          </button>
                          <span className="atlas-folder-count">{folder.fileCount}</span>
                        </div>
                        <p>
                          {folder.fileCount} {folder.fileCount === 1 ? 'file' : 'files'} ·{' '}
                          {map.links
                            .filter(
                              link => link.source === folder.path || link.target === folder.path,
                            )
                            .reduce((sum, link) => sum + link.count, 0)}{' '}
                          cross-folder links
                        </p>
                        {open ? (
                          <div className="atlas-cluster-scroll" onScroll={() => measureFileLinks.current()}>
                            {renderFolderItems(folder.path)}
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="atlas-expand"
                            onClick={() => {
                              setSelection({ kind: 'folder', folder: folder.path });
                              toggleTop(folder.path);
                            }}
                          >
                            Explore files <span>↗</span>
                          </button>
                        )}
                      </section>
                    );
                  })}
                  {selectedFile && fileRoutes.length > 0 && (
                    <svg className="atlas-file-lines" width={layout.width} height={layout.height} aria-label="Selected file connections">
                      <defs><marker id="atlas-file-arrow" markerUnits="userSpaceOnUse" markerWidth={8 / viewport.scale} markerHeight={8 / viewport.scale} refX="7" refY="4" viewBox="0 0 8 8" orient="auto"><path d="M0 0 L8 4 L0 8" /></marker></defs>
                      {fileRoutes.map(route => <g key={`${route.source}\0${route.target}`} data-source={route.source} data-target={route.target}>
                        <title>{`${route.source} imports ${route.target}`}</title>
                        <path d={route.path} markerEnd="url(#atlas-file-arrow)" style={{ strokeWidth: 2.5 / viewport.scale }} />
                        <circle cx={route.x} cy={route.y} r={3 / viewport.scale} />
                      </g>)}
                    </svg>
                  )}
                </div>
              </div>
              <div className="atlas-legend">
                <span>
                  <i className="atlas-legend-code" /> Known code link
                </span>
                {showHttp && (
                  <span>
                    <i className="atlas-legend-http" /> Detected local HTTP
                  </span>
                )}
                <span>Arrows point toward dependencies</span>
                <span>Drag to pan · Scroll to zoom</span>
              </div>
            </div>
            <aside className="atlas-inspector" aria-label="Map details">
              <div className="atlas-inspector-heading">Map details</div>
              {selection?.kind === 'file' && selectedNode ? (
                <>
                  <h2>{selectedFile!.split('/').pop()}</h2>
                  <p className="atlas-path">{selectedFile}</p>
                  <dl className="atlas-metrics">
                    <div>
                      <dt>Direct consumers</dt>
                      <dd>{impact?.direct.size ?? 0}</dd>
                    </div>
                    <div>
                      <dt>Reachable consumers</dt>
                      <dd>{impact?.transitive.size ?? 0}</dd>
                    </div>
                    <div>
                      <dt>Dependencies</dt>
                      <dd>{linksFromFile.filter(link => link.source === selectedFile).length}</dd>
                    </div>
                  </dl>
                  <p className="atlas-evidence-note">
                    Known code links only. Dynamic and external use may be absent.
                  </p>
                  {linksFromFile.length > 0 && (
                    <div className="atlas-file-links">
                      <h3>
                        Connected files <span>{linksFromFile.length}</span>
                      </h3>
                      {linksFromFile.slice(0, 16).map(link => (
                        <button
                          key={`${link.source}:${link.target}`}
                          type="button"
                          onClick={() =>
                            selectFile(link.source === selectedFile ? link.target : link.source)
                          }
                        >
                          <span aria-hidden="true">{link.source === selectedFile ? '→' : '←'}</span>
                          <span>
                            <strong>
                              {(link.source === selectedFile ? link.target : link.source)
                                .split('/')
                                .pop()}
                            </strong>
                            <small>
                              {link.source === selectedFile ? link.target : link.source}
                            </small>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  <Link
                    className="atlas-action"
                    href={`/graph-view?session=${encodeURIComponent(sessionId)}&file=${encodeURIComponent(selectedFile!)}`}
                  >
                    Open in Files →
                  </Link>
                </>
              ) : selection?.kind === 'folder' ? (
                <>
                  <h2>{label(selection.folder)}/</h2>
                  <p className="atlas-path">{selection.folder || 'Repository root'}</p>
                  <p>
                    {map.folders.find(folder => folder.path === selection.folder)?.fileCount ?? 0}{' '}
                    files in this cluster. Expand it to inspect nested folders and files.
                  </p>
                  <p>
                    {
                      map.links.filter(
                        link =>
                          link.source === selection.folder || link.target === selection.folder,
                      ).length
                    }{' '}
                    connected folder directions.
                  </p>
                </>
              ) : selection?.kind === 'link' ? (
                <>
                  <h2>
                    {label(selection.source)} → {label(selection.target)}
                  </h2>
                  <p>
                    {map.links.find(
                      link => link.source === selection.source && link.target === selection.target,
                    )?.count ?? 0}{' '}
                    known file links in this direction.
                  </p>
                  <div className="atlas-file-links">
                    {map.fileLinks
                      .filter(
                        link =>
                          topFolder(link.source) === selection.source &&
                          topFolder(link.target) === selection.target,
                      )
                      .slice(0, 16)
                      .map(link => (
                        <button
                          key={`${link.source}:${link.target}`}
                          onClick={() => selectFile(link.source)}
                        >
                          {link.source} → {link.target}
                        </button>
                      ))}
                  </div>
                </>
              ) : (
                <>
                  <h2>See the whole codebase.</h2>
                  <p>
                    Open a folder cluster, select a file, or follow a connection to inspect its
                    evidence.
                  </p>
                </>
              )}
              {selection && (
                <section className="vp-ai">
                  <div className="vp-ai-heading"><span className="vp-ai-mark" aria-hidden="true">✧</span><h3>Ask about this selection</h3><span>watsonx</span></div>
                  <p>Granite generates an AI explanation from source evidence when you ask.</p>
                  <AiExchange question={askedQuestion} answer={aiAnswer} busy={aiBusy} repoUrl={data.repoUrl} files={data.graph.nodes} />
                  <form className="vp-ai-form"
                    onSubmit={event => {
                      event.preventDefault();
                      void askAi(aiQuestion);
                    }}
                  >
                    <label htmlFor="atlas-ai-question">Your question</label>
                    <input
                      id="atlas-ai-question"
                      value={aiQuestion}
                      onChange={event => setAiQuestion(event.target.value)}
                      maxLength={300}
                      placeholder={askedQuestion ? 'Ask another question…' : 'Ask about this selection…'}
                    />
                    <button className="vp-secondary" type="submit" disabled={aiBusy || !aiQuestion.trim()}>
                      {aiBusy ? 'Asking…' : 'Ask Granite'}<span aria-hidden="true">↗</span>
                    </button>
                  </form>
                </section>
              )}
            </aside>
          </div>
          </div>
        </main>
      )}
    </div>
  );
}
