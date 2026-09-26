'use client';

import { useEffect, useRef } from 'react';
import Header from '../header';
import { useWorkspace, ViewSwitch, WorkspaceStatus, WorkspaceWarnings } from '../workspace';
import { mountDiagram } from './diagram';
import type { SerialGraph } from '../../src/server';
import type { Architecture } from '../../src/architecture';
import '../workspace.css';
import './workspace.css';

function Diagram({ graph, architecture, repoUrl, sessionId }: { graph: SerialGraph; architecture: Architecture; repoUrl: string; sessionId: string }) {
  const host = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!host.current) return;
    return mountDiagram(host.current, graph, architecture, repoUrl, sessionId);
  }, [graph, architecture, repoUrl, sessionId]);
  return <section ref={host} className="flow-section" aria-label="Architecture diagram">
    <div className="diagram-browser"><div className="diagram-browser-head"><h2>System maps <span id="diagram-view-total" /></h2></div><nav id="diagram-options" className="diagram-cards" aria-label="Architecture diagrams" /><aside className="diagram-guide" aria-label="Reading the map"><h2>Reading the map</h2><div className="diagram-legend" aria-label="Connection types"><span className="key-item"><i className="key-import" /><span><strong>Import</strong><small>Uses code from another component</small></span></span><span className="key-item"><i className="key-http" /><span><strong>HTTP call</strong><small>Request found in source code</small></span></span><span className="key-item"><i className="key-deploy" /><span><strong>Deployment</strong><small>Declared runtime or infrastructure</small></span></span><span className="key-item"><i className="key-state" /><span><strong>State update</strong><small>Observed setter value</small></span></span></div><p>Choose a component or arrow to see its source files.</p></aside></div>
    <div className="diagram-shell">
      <div className="diagram-stage">
        <div className="diagram-current" aria-live="polite"><strong id="diagram-current-name">System Architecture Diagram</strong><small id="diagram-current-description" /></div>
        <div className="diagram-viewport"><div id="diagram-space"><div className="diagram-canvas"><svg id="architecture-edges" aria-label="Component connections" /><div id="architecture-nodes" /></div></div></div>
        <aside className="diagram-inspector" id="diagram-inspector" aria-hidden="true" aria-live="polite"><button id="inspector-close" type="button" aria-label="Close details">×</button><span id="flow-counter">SOURCE EVIDENCE</span><h2 id="flow-node-title">Component</h2><p id="flow-explanation" /><div id="flow-files" aria-label="Source files in selected component" /><ol id="flow-steps" className="flow-steps" aria-label="Connected components" /></aside>
        <div className="diagram-tools" aria-label="Diagram controls"><button id="diagram-zoom-in" type="button" aria-label="Zoom in" title="Zoom in">+</button><button id="diagram-zoom-out" type="button" aria-label="Zoom out" title="Zoom out">−</button><button id="diagram-fit" type="button" title="Fit diagram">Fit</button><button id="diagram-fullscreen" type="button" aria-label="Expand diagram" title="Expand diagram">⤢</button><details className="diagram-export"><summary aria-label="Copy diagram" title="Copy diagram">⧉</summary><div className="diagram-export-menu"><button type="button" data-export="copy-svg">Copy SVG</button><button type="button" data-export="copy-png">Copy PNG</button><button type="button" data-export="download-svg">Download SVG</button><button type="button" data-export="download-png">Download PNG</button></div></details><span id="diagram-export-status" role="status" aria-live="polite" /></div>
      </div>
    </div>
  </section>;
}

export default function ArchitecturePage() {
  const { data, error, sessionId } = useWorkspace('architecture');
  return <div className="architecture-page repository-workspace"><Header workspace repoName={data?.repoUrl.replace('https://github.com/', '')} />{!data?.architecture ? <WorkspaceStatus error={error} /> : <main className="architecture-shell vp-main">
    <div className="vp-titlebar"><div className="architecture-title"><h1>Architecture</h1><span aria-hidden="true">|</span><p>Explore components and their connections</p></div><ViewSwitch sessionId={sessionId} view="architecture" /></div>
    <WorkspaceWarnings warnings={data.graph.warnings} />
    <Diagram graph={data.graph} architecture={data.architecture} repoUrl={data.repoUrl} sessionId={sessionId} />
  </main>}<footer className="site-footer"><span>Made with IBM Bob</span><span>Connections inferred from source code.</span></footer></div>;
}
