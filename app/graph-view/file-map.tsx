'use client';

import { useMemo, useRef } from 'react';
import type { SerialGraph } from '../../src/server';

const basename = (file: string) => file.split('/').pop() || file;

export default function FileMap({ graph, selected, select }: {
  graph: SerialGraph;
  selected?: string;
  select: (file: string) => void;
}) {
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const connected = useMemo(() => {
    const known = new Set(graph.nodes.map(node => node.file));
    const importers = new Set<string>();
    const dependencies = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.source === selected) for (const target of edge.targets) if (known.has(target)) dependencies.add(target);
      if (edge.targets.includes(selected ?? '') && known.has(edge.source)) importers.add(edge.source);
    }
    return { importers: [...importers].sort(), dependencies: [...dependencies].sort() };
  }, [graph, selected]);

  function fileButton(file: string) {
    return <button key={file} type="button" className="files-focus-file" title={file} onClick={() => select(file)}>
      <strong>{basename(file)}</strong><small>{file}</small>
    </button>;
  }

  return <section className="vp-map-panel files-focus-panel" aria-label="File dependency graph">
    <div className="vp-panel-heading"><h2>File connections</h2><span className="vp-map-key">Known internal imports</span></div>
    <div className="files-focus-scroll" tabIndex={0} aria-label="Scrollable file connections"
      onPointerDown={event => {
        if (event.button !== 0 || event.pointerType === 'touch' || (event.target as HTMLElement).closest('button, a')) return;
        const viewport = event.currentTarget;
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
        viewport.setPointerCapture(event.pointerId);
        viewport.classList.add('is-panning');
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        event.currentTarget.scrollTo(start.left + start.x - event.clientX, start.top + start.y - event.clientY);
      }}
      onPointerUp={event => { drag.current = null; event.currentTarget.classList.remove('is-panning'); }}
      onPointerCancel={event => { drag.current = null; event.currentTarget.classList.remove('is-panning'); }}
      onLostPointerCapture={event => { drag.current = null; event.currentTarget.classList.remove('is-panning'); }}>
      {selected ? <div className="files-focus-layout">
        <div className="files-focus-column"><h3>Imported by <span>{connected.importers.length}</span></h3>{connected.importers.length ? connected.importers.map(fileButton) : <p>No known internal importers.</p>}</div>
        {connected.importers.length > 0 ? <span className="files-focus-arrow" aria-hidden="true" /> : <span aria-hidden="true" />}
        <div className="files-focus-center"><h3>Selected file</h3><div><strong>{basename(selected)}</strong><small>{selected}</small></div></div>
        {connected.dependencies.length > 0 ? <span className="files-focus-arrow" aria-hidden="true" /> : <span aria-hidden="true" />}
        <div className="files-focus-column"><h3>Imports <span>{connected.dependencies.length}</span></h3>{connected.dependencies.length ? connected.dependencies.map(fileButton) : <p>No known internal dependencies.</p>}</div>
      </div> : <div className="files-focus-empty"><strong>Choose a file to trace its connections.</strong><p>Use the repository list to inspect known importers, dependencies, and source evidence.</p></div>}
    </div>
  </section>;
}
