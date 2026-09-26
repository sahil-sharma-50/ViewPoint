'use client';

import { useEffect, useRef, useState } from 'react';

const groups = [
  { label: 'ENTRY', modules: [{ id: 'application', name: 'Application', subtitle: 'Entry file', detail: 'The example starts at the application entry file.' }] },
  { label: 'MODULES', modules: [{ id: 'workspace', name: 'Workspace', subtitle: 'UI and state', detail: 'The workspace organizes the interface and its state.' }, { id: 'shared-ui', name: 'Shared UI', subtitle: 'Components', detail: 'Shared components support the interface.' }] },
  { label: 'ROUTES', modules: [{ id: 'api-routes', name: 'API routes', subtitle: 'HTTP handlers', detail: 'API routes handle requests from the app.' }] },
];

export default function CodePreview() {
  const stage = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<{ width: number; height: number; paths: string[] }>({ width: 500, height: 225, paths: [] });
  const [detail, setDetail] = useState('Hover a component to see its role.');

  useEffect(() => {
    const container = stage.current;
    if (!container) return;
    const cards: Record<string, HTMLElement> = Object.fromEntries([...container.querySelectorAll<HTMLElement>('[data-module]')].map(card => [card.dataset.module!, card]));
    const measure = () => {
      const frame = container.getBoundingClientRect();
      const connect = (source: string, target: string) => {
        const from = cards[source]!.getBoundingClientRect();
        const to = cards[target]!.getBoundingClientRect();
        const x1 = from.right - frame.left + 1;
        const y1 = from.top + from.height / 2 - frame.top;
        const x2 = to.left - frame.left - 4;
        const y2 = to.top + to.height / 2 - frame.top;
        const bend = Math.max(8, (x2 - x1) / 2);
        return `M ${x1} ${y1} C ${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
      };
      setLinks({ width: frame.width, height: frame.height, paths: [connect('application', 'workspace'), connect('application', 'shared-ui'), connect('workspace', 'api-routes'), connect('shared-ui', 'api-routes')] });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    Object.values(cards).forEach(card => observer.observe(card));
    measure();
    return () => observer.disconnect();
  }, []);

  return <figure className="hero-art atlas-preview" aria-label="Illustration of a repository architecture map, from entry files through shared modules to API routes">
    <div className="atlas-window">
      <div className="atlas-window-bar"><span className="atlas-window-mark">VP</span><span>Architecture / system overview</span><span className="atlas-window-count">ILLUSTRATION</span></div>
      <div className="atlas-window-heading"><strong>See the system at a glance.</strong><span>Components and known connections</span></div>
      <div ref={stage} className="atlas-stage">
        <svg className="atlas-links" aria-hidden="true" viewBox={`0 0 ${links.width} ${links.height}`} preserveAspectRatio="none"><defs><marker id="atlas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 1 L 9 5 L 0 9 z" /></marker></defs>{links.paths.map((path, index) => <path key={index} d={path} markerEnd="url(#atlas-arrow)" />)}</svg>
        {groups.map(group => <div key={group.label} className="atlas-group"><span>{group.label}</span>{group.modules.map(module => <div key={module.id} className="atlas-module" data-module={module.id} tabIndex={0} role="img" aria-label={`${module.name}. ${module.detail}`} onMouseEnter={() => setDetail(module.detail)} onMouseLeave={() => setDetail('Hover a component to see its role.')} onFocus={() => setDetail(module.detail)} onBlur={() => setDetail('Hover a component to see its role.')}><strong>{module.name}</strong><small>{module.subtitle}</small></div>)}</div>)}
      </div>
      <div className="atlas-window-footer"><span><i /> Example map</span><span className="atlas-detail" aria-live="polite">{detail}</span></div>
    </div>
  </figure>;
}
