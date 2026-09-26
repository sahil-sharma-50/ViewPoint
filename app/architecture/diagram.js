import { directConnections, layoutDiagram, smoothRoute } from './graph-layout.js';
import { buildDiagramViews } from './views.js';

export function mountDiagram(root, graph, architecture, repoUrl, sessionId) {
  const events = new AbortController();
  const $ = id => root.querySelector('#' + id);
  const githubRepo = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repoUrl) ? repoUrl.replace(/\/$/, '') : null;
  const facts = new Map((architecture.files || []).map(item => [item.file, item]));
  const { components, views } = buildDiagramViews(graph, architecture);
  const byId = new Map(components.map(component => [component.id, component]));
  const storageKey = 'viewpoint:architecture:' + sessionId;
  let saved = null;
  try { saved = JSON.parse(globalThis.sessionStorage.getItem(storageKey) || 'null'); } catch { /* Ignore stale browser state. */ }
  const restoredView = views.find(candidate => candidate.id === saved?.view);
  function renderCard(candidate) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'diagram-card'; button.dataset.view = candidate.id; button.title = candidate.description;
    const label = document.createElement('strong'); label.textContent = candidate.label;
    const stats = document.createElement('span'); stats.className = 'diagram-card-stats'; stats.textContent = String(candidate.nodeIds.includes('empty') ? 0 : candidate.nodeIds.length);
    stats.title = (candidate.nodeIds.includes('empty') ? 0 : candidate.nodeIds.length) + ' components, ' + candidate.edges.length + ' connections';
    button.append(label, stats);
    button.addEventListener('click', () => { view = candidate; active = -1; selected = null; zoom = 1; drawView(); render(); }, { signal: events.signal });
    $('diagram-options').append(button);
  }
  for (const candidate of views) renderCard(candidate);
  $('diagram-view-total').textContent = String(views.length);
  const canvas = root.querySelector('.diagram-canvas');
  const space = $('diagram-space');
  const viewport = root.querySelector('.diagram-viewport');
  const svg = $('architecture-edges');
  const svgNS = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(svgNS, 'defs');
  for (const [type, color] of [['import', '#6296e1'], ['http', '#e5a76d'], ['deploy', '#79b99a'], ['state', '#c39ae6']]) {
    const marker = document.createElementNS(svgNS, 'marker');
    marker.setAttribute('id', 'arrow-' + type); marker.setAttribute('viewBox', '0 0 10 10'); marker.setAttribute('refX', '9.5'); marker.setAttribute('refY', '5'); marker.setAttribute('markerWidth', '6'); marker.setAttribute('markerHeight', '6'); marker.setAttribute('orient', 'auto-start-reverse');
    const tip = document.createElementNS(svgNS, 'path'); tip.setAttribute('d', 'M 0 1 L 9 5 L 0 9 z'); tip.setAttribute('fill', color); marker.append(tip); defs.append(marker);
  }
  let view = restoredView || views[0];
  let active = Number.isInteger(saved?.active) && saved.active >= 0 && saved.active < view.edges.length ? saved.active : -1;
  let selected = view.nodeIds.includes(saved?.selected) ? saved.selected : null;
  let hovered = null;
  let scale = 1; let zoom = typeof saved?.zoom === 'number' && saved.zoom >= .5 && saved.zoom <= 2.5 ? saved.zoom : 1; let canvasWidth = 1100; let canvasHeight = 380;
  const saveState = () => globalThis.sessionStorage.setItem(storageKey, JSON.stringify({ view: view.id, active, selected, zoom }));
  let stacked = innerWidth < 700; let positions = new Map();
  function fit() {
    scale = (stacked ? Math.max(.5, Math.min(1, (viewport.clientWidth - 24) / canvasWidth)) : Math.max(.2, Math.min(1.1, (viewport.clientWidth - 32) / canvasWidth, (viewport.clientHeight - 110) / canvasHeight))) * zoom;
    space.style.width = canvasWidth * scale + 'px'; space.style.height = canvasHeight * scale + 'px';
    canvas.style.transform = 'scale(' + scale + ')';
  }
  const observer = new ResizeObserver(() => { if (stacked !== (innerWidth < 700)) { stacked = innerWidth < 700; drawView(); render(); } else fit(); });
  observer.observe(viewport);
  $('diagram-zoom-in').addEventListener('click', () => { zoom = Math.min(2.5, zoom + .25); fit(); saveState(); }, { signal: events.signal });
  $('diagram-zoom-out').addEventListener('click', () => { zoom = Math.max(.5, zoom - .25); fit(); saveState(); }, { signal: events.signal });
  $('diagram-fit').addEventListener('click', () => { zoom = 1; panOffset = { x: 0, y: 0 }; space.style.translate = '0px 0px'; fit(); viewport.scrollTo(0, 0); saveState(); }, { signal: events.signal });
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    const next = Math.max(.5, Math.min(2.5, zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    if (next === zoom) return;
    const before = space.getBoundingClientRect();
    const frame = viewport.getBoundingClientRect();
    const x = (event.clientX - before.left) / scale;
    const y = (event.clientY - before.top) / scale;
    zoom = next; fit();
    viewport.scrollTo(x * scale - (event.clientX - frame.left), y * scale - (event.clientY - frame.top));
    saveState();
  }, { passive: false, signal: events.signal });
  let pan = null; let dragged = false; let panOffset = { x: 0, y: 0 };
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.pointerType === 'touch' || event.target.closest('button, a, summary, .diagram-inspector, .system-edge-hit')) return;
    event.preventDefault();
    pan = { x: event.clientX, y: event.clientY, offsetX: panOffset.x, offsetY: panOffset.y };
    dragged = false;
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('is-panning');
  }, { signal: events.signal });
  viewport.addEventListener('pointermove', event => {
    if (pan) {
      if (Math.abs(pan.x - event.clientX) + Math.abs(pan.y - event.clientY) > 5) dragged = true;
      panOffset = { x: pan.offsetX + event.clientX - pan.x, y: pan.offsetY + event.clientY - pan.y };
      space.style.translate = `${panOffset.x}px ${panOffset.y}px`;
    }
  }, { signal: events.signal });
  const stopPan = () => { pan = null; viewport.classList.remove('is-panning'); };
  viewport.addEventListener('pointerup', stopPan, { signal: events.signal });
  viewport.addEventListener('pointercancel', stopPan, { signal: events.signal });
  viewport.addEventListener('click', event => {
    if (dragged) { dragged = false; return; }
    if (event.target.closest('.system-node, .system-edge-hit')) return;
    selected = null; active = -1; render();
    root.querySelector('.diagram-export').open = false;
  }, { signal: events.signal });
  $('diagram-fullscreen').addEventListener('click', () => { if (document.fullscreenElement) void document.exitFullscreen(); else void root.requestFullscreen(); }, { signal: events.signal });
  $('inspector-close').addEventListener('click', () => { selected = null; active = -1; render(); }, { signal: events.signal });

  function exportSvg() {
    const colors = getComputedStyle(root);
    const color = (name, fallback) => colors.getPropertyValue(name).trim() || fallback;
    const exported = document.createElementNS(svgNS, 'svg');
    exported.setAttribute('xmlns', svgNS);
    exported.setAttribute('width', String(canvasWidth)); exported.setAttribute('height', String(canvasHeight));
    exported.setAttribute('viewBox', `0 0 ${canvasWidth} ${canvasHeight}`);
    const add = (parent, tag, attributes, content) => {
      const element = document.createElementNS(svgNS, tag);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
      if (content !== undefined) element.textContent = content;
      parent.append(element);
      return element;
    };
    add(exported, 'title', {}, view.label);
    exported.append(defs.cloneNode(true));
    add(exported, 'rect', { width: canvasWidth, height: canvasHeight, fill: color('--bg', '#111214') });
    for (const path of svg.querySelectorAll('.system-edge')) {
      const style = getComputedStyle(path);
      add(exported, 'path', {
        d: path.getAttribute('d'), fill: 'none', stroke: style.stroke,
        'stroke-width': style.strokeWidth, 'stroke-dasharray': style.strokeDasharray,
        opacity: style.opacity, 'marker-end': path.getAttribute('marker-end'),
      });
    }
    for (const button of $('architecture-nodes').children) {
      const x = parseFloat(button.style.left); const y = parseFloat(button.style.top);
      const width = button.offsetWidth; const height = button.offsetHeight;
      const style = getComputedStyle(button);
      const group = add(exported, 'g', { opacity: style.opacity });
      add(group, 'rect', { x, y, width, height, rx: 6, fill: style.backgroundColor, stroke: style.borderColor });
      const label = button.querySelector('small'); const name = button.querySelector('strong'); const count = button.querySelector('span');
      add(group, 'text', { x: x + 11, y: y + 21, fill: getComputedStyle(label).color, 'font-size': 9, 'font-family': 'Arial, sans-serif' }, label.textContent);
      add(group, 'text', { x: x + 11, y: y + 41, fill: color('--text', '#f0f1f4'), 'font-size': 12, 'font-weight': 600, 'font-family': 'Arial, sans-serif' }, name.textContent.length > 24 ? name.textContent.slice(0, 23) + '…' : name.textContent);
      add(group, 'text', { x: x + 11, y: y + height - 10, fill: color('--muted', '#a0a4af'), 'font-size': 9, 'font-family': 'Arial, sans-serif' }, count.textContent);
    }
    return new XMLSerializer().serializeToString(exported);
  }
  function download(blob, extension) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url;
    link.download = `architecture-${view.id.replace(/[^a-z0-9-]/gi, '-')}.${extension}`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function pngBlob(source) {
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
    try {
      const image = new Image(); image.src = url;
      await image.decode();
      const bitmap = document.createElement('canvas'); bitmap.width = canvasWidth * 2; bitmap.height = canvasHeight * 2;
      bitmap.getContext('2d').drawImage(image, 0, 0, bitmap.width, bitmap.height);
      return await new Promise((resolve, reject) => bitmap.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG conversion failed')), 'image/png'));
    } finally { URL.revokeObjectURL(url); }
  }
  for (const button of root.querySelectorAll('[data-export]')) button.addEventListener('click', async () => {
    const action = button.dataset.export;
    const format = action.endsWith('svg') ? 'SVG' : 'PNG';
    const status = $('diagram-export-status');
    status.textContent = `Preparing ${format}…`;
    try {
      const source = exportSvg();
      const blob = format === 'SVG' ? new Blob([source], { type: 'image/svg+xml' }) : await pngBlob(source);
      if (action.startsWith('download')) download(blob, format.toLowerCase());
      else if (format === 'SVG') await navigator.clipboard.writeText(source);
      else await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      status.textContent = `${format} ${action.startsWith('download') ? 'downloaded' : 'copied'}.`;
      root.querySelector('.diagram-export').open = false;
    } catch {
      status.textContent = `${format} ${action.startsWith('download') ? 'download' : 'copy'} failed. Try ${action.startsWith('download') ? 'copying' : 'downloading'} it instead.`;
    }
    const message = status.textContent;
    setTimeout(() => { if (status.textContent === message) status.textContent = ''; }, 4000);
  }, { signal: events.signal });

  function drawView() {
    panOffset = { x: 0, y: 0 }; space.style.translate = '0px 0px';
    hovered = null;
    for (const button of $('diagram-options').children) button.setAttribute('aria-pressed', String(button.dataset.view === view.id));
    $('diagram-current-name').textContent = view.label;
    const coverage = view.nodeIds.length < view.totalNodes || view.edges.length < view.totalEdges
      ? ` Showing ${view.nodeIds.length} of ${view.totalNodes} components and ${view.edges.length} of ${view.totalEdges} connections.` : '';
    $('diagram-current-description').textContent = view.nodeIds.includes('empty') ? 'No source evidence for this diagram in the repository.' : view.description + coverage;
    const members = view.nodeIds.map(id => byId.get(id));
    const nodeWidth = stacked ? 214 : 190;
    const layout = layoutDiagram(members, view.edges, stacked);
    positions = layout.positions;
    canvasWidth = Math.max(layout.width, stacked ? 320 : 740);
    canvasHeight = Math.max(layout.height, stacked ? 310 : 330);
    canvas.style.width = canvasWidth + 'px'; canvas.style.height = canvasHeight + 'px';
    svg.setAttribute('viewBox', '0 0 ' + canvasWidth + ' ' + canvasHeight);
    svg.setAttribute('width', String(canvasWidth)); svg.setAttribute('height', String(canvasHeight));
    svg.replaceChildren(defs); $('architecture-nodes').replaceChildren();
    const crossesCard = (path, edge) => {
      const length = path.getTotalLength();
      for (let distance = 4; distance < length - 4; distance += 4) {
        const point = path.getPointAtLength(distance);
        for (const [id, box] of positions) {
          if (id === edge.source || id === edge.target) continue;
          if (point.x > box.x + 2 && point.x < box.x + box.width - 2 && point.y > box.y + 2 && point.y < box.y + box.height - 2) return true;
        }
      }
      return false;
    };
    const clearAlternatives = (edge, from, to) => {
      if (stacked) {
        const direction = from.y < to.y ? 1 : -1;
        const start = { x: from.x + from.width / 2, y: direction === 1 ? from.y + from.height : from.y };
        const end = { x: to.x + to.width / 2, y: direction === 1 ? to.y : to.y + to.height };
        const middle = (start.y + end.y) / 2;
        const direct = `M ${start.x} ${start.y} C ${start.x} ${middle} ${end.x} ${middle} ${end.x} ${end.y}`;
        const nearTarget = end.y - direction * 28;
        const corridor = smoothRoute([start, { x: start.x, y: nearTarget }, { x: end.x, y: nearTarget }, end]);
        const boxes = [...positions.values()];
        const left = Math.min(...boxes.map(box => box.x)) - 28;
        const right = Math.max(...boxes.map(box => box.x + box.width)) + 28;
        const outside = x => smoothRoute([start, { x: start.x, y: start.y + direction * 28 }, { x, y: start.y + direction * 28 }, { x, y: end.y - direction * 28 }, { x: end.x, y: end.y - direction * 28 }, end]);
        return [direct, corridor, outside(left), outside(right)];
      }
      const direction = from.x < to.x ? 1 : -1;
      const paired = view.edges.some(other => other.source === edge.target && other.target === edge.source);
      const offset = paired ? (edge.source < edge.target ? -10 : 10) : 0;
      const start = { x: direction === 1 ? from.x + from.width : from.x, y: from.y + from.height / 2 + offset };
      const end = { x: direction === 1 ? to.x : to.x + to.width, y: to.y + to.height / 2 + offset };
      const middle = (start.x + end.x) / 2;
      const direct = `M ${start.x} ${start.y} C ${middle} ${start.y} ${middle} ${end.y} ${end.x} ${end.y}`;
      const nearTarget = end.x - direction * 28;
      const nearSource = start.x + direction * 28;
      const aroundTarget = smoothRoute([start, { x: nearTarget, y: start.y }, { x: nearTarget, y: end.y }, end]);
      const aroundSource = smoothRoute([start, { x: nearSource, y: start.y }, { x: nearSource, y: end.y }, end]);
      const boxes = [...positions.values()];
      const top = Math.min(...boxes.map(box => box.y)) - 28;
      const bottom = Math.max(...boxes.map(box => box.y + box.height)) + 28;
      const outside = y => smoothRoute([start, { x: nearSource, y: start.y }, { x: nearSource, y }, { x: nearTarget, y }, { x: nearTarget, y: end.y }, end]);
      return [direct, aroundTarget, aroundSource, outside(top), outside(bottom)];
    };
    for (const [edgeIndex, edge] of view.edges.entries()) {
      const from = positions.get(edge.source); const to = positions.get(edge.target);
      if (!from || !to) continue;
      const route = layout.routes.get(edge.id);
      const d = route?.length ? smoothRoute(route) : `M ${from.x + nodeWidth} ${from.y + 36} L ${to.x} ${to.y + 36}`;
      const path = document.createElementNS(svgNS, 'path'); path.setAttribute('d', d); path.setAttribute('class', 'system-edge ' + edge.type); path.setAttribute('marker-end', 'url(#arrow-' + edge.type + ')'); path.dataset.id = edge.id; path.dataset.context = String(edgeIndex < 3);
      svg.append(path);
      if (crossesCard(path, edge)) {
        for (const alternative of clearAlternatives(edge, from, to)) {
          path.setAttribute('d', alternative);
          if (!crossesCard(path, edge)) break;
        }
      }
      const hit = document.createElementNS(svgNS, 'path'); hit.setAttribute('d', path.getAttribute('d')); hit.setAttribute('class', 'system-edge-hit');
      hit.setAttribute('tabindex', '0'); hit.setAttribute('role', 'button'); hit.setAttribute('aria-label', byId.get(edge.source).name + ' to ' + byId.get(edge.target).name + ': ' + edge.label);
      const selectEdge = () => {
        active = view.edges.indexOf(edge); selected = null; render();
      };
      hit.addEventListener('click', selectEdge);
      hit.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectEdge(); } });
      const title = document.createElementNS(svgNS, 'title'); title.textContent = edge.type === 'import' ? edge.count + ' static imports' : edge.label; hit.append(title); svg.append(hit);
    }
    for (const component of members) {
      const point = positions.get(component.id);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'system-node kind-' + component.kind; button.dataset.component = component.id;
      button.style.left = point.x + 'px'; button.style.top = point.y + 'px';
      const kindLabel = document.createElement('small'); kindLabel.textContent = component.kind === 'external' ? component.runtime === 'unknown' ? 'Unresolved request' : 'External service' : component.runtime !== 'unknown' ? component.runtime[0].toUpperCase() + component.runtime.slice(1) + ' / ' + component.kind : component.kind;
      const name = document.createElement('strong'); name.textContent = component.name;
      const count = document.createElement('span'); count.textContent = component.kind === 'external' ? 'Request destination' : component.kind === 'state' ? 'Observed state' : component.kind === 'deployment' ? 'Deployment fact' : component.id === 'empty' ? 'Nothing detected for this diagram' : component.files.length + (component.files.length === 1 ? ' source file' : ' source files');
      button.append(kindLabel, name, count);
      button.addEventListener('mouseenter', () => { hovered = component.id; updateHighlights(); });
      button.addEventListener('mouseleave', () => { if (hovered === component.id) { hovered = null; updateHighlights(); } });
      button.addEventListener('focus', () => { hovered = component.id; updateHighlights(); });
      button.addEventListener('blur', () => { if (hovered === component.id) { hovered = null; updateHighlights(); } });
      button.addEventListener('click', () => { active = -1; selected = component.id; render(); });
      $('architecture-nodes').append(button);
    }
    $('flow-steps').replaceChildren();
    view.edges.forEach((edge, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button'); button.type = 'button'; button.className = 'flow-step-button';
      button.setAttribute('aria-label', 'Connection ' + (index + 1) + ': ' + byId.get(edge.source).name + ' to ' + byId.get(edge.target).name);
      const number = document.createElement('span'); number.textContent = String(index + 1).padStart(2, '0');
      const names = document.createElement('span');
      const from = document.createElement('small'); from.textContent = byId.get(edge.source).name;
      const to = document.createElement('strong'); to.textContent = byId.get(edge.target).name;
      names.append(from, to); button.append(number, names);
      button.addEventListener('click', () => { active = index; selected = null; render(); });
      item.append(button); $('flow-steps').append(item);
    });
    fit(); viewport.scrollTo(0, 0);
  }
  function updateHighlights() {
    const edge = view.edges[active];
    const focus = hovered || selected;
    const { edgeIds: related, nodeIds: connected } = focus ? directConnections(view.edges, focus) : { edgeIds: new Set(), nodeIds: new Set() };
    for (const button of $('architecture-nodes').children) {
      const id = button.dataset.component;
      button.classList.toggle('active', edge ? [edge.source, edge.target].includes(id) : id === selected);
      button.setAttribute('aria-pressed', String(id === selected));
      button.classList.toggle('connected', !!hovered && connected.has(id));
      button.classList.toggle('dimmed', !!focus && !connected.has(id));
    }
    for (const path of svg.querySelectorAll('.system-edge')) {
      path.classList.toggle('active', !!edge && path.dataset.id === edge.id);
      path.classList.toggle('trace', !!edge && path.dataset.id === edge.id || !!focus && related.has(path.dataset.id));
      path.classList.toggle('dimmed', !!focus && !related.has(path.dataset.id));
    }
  }
  function render() {
    saveState();
    const edge = view.edges[active];
    const related = selected ? directConnections(view.edges, selected).edgeIds : new Set();
    const inspector = $('diagram-inspector');
    const open = !!selected || !!edge;
    inspector.classList.toggle('is-open', open);
    inspector.setAttribute('aria-hidden', String(!open));
    inspector.inert = !open;
    $('flow-steps').hidden = !!selected;
    updateHighlights();
    for (const [index, item] of [...$('flow-steps').children].entries()) {
      const button = item.firstElementChild;
      button.classList.toggle('active', index === active);
      item.hidden = !!selected && !related.has(view.edges[index].id);
      if (index === active) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    }
    const component = byId.get(selected);
    const filePanel = $('flow-files');
    filePanel.replaceChildren();
    const edgeFile = edge?.file || edge?.call?.source || edge?.example?.split(' imports ')[0];
    const sourceFiles = component?.files.length ? component.files : component?.kind === 'external'
      ? [...new Set(view.edges.filter(item => item.target === component.id && item.type === 'http').map(item => item.call?.source).filter(Boolean))]
      : edgeFile ? [edgeFile] : [];
    filePanel.hidden = !sourceFiles.length;
    if (sourceFiles.length) {
      const heading = document.createElement('strong');
      heading.textContent = component?.kind === 'external' ? 'Request source' : edge ? 'Connection source' : sourceFiles.length + (sourceFiles.length === 1 ? ' source file' : ' source files');
      filePanel.append(heading);
      const description = document.createElement('p');
      description.textContent = component?.kind === 'external' ? 'Files that make this request.' : edge ? 'Files that establish this connection.' : 'Files included in this component.';
      filePanel.append(description);
      for (const file of sourceFiles) {
        const fact = facts.get(file);
        const row = document.createElement('div'); row.className = 'flow-file';
        const name = document.createElement('b'); name.textContent = file;
        const details = document.createElement('span');
        details.textContent = [fact?.language, fact?.lines === undefined ? null : fact.lines + ' lines', fact?.runtime].filter(Boolean).join(' · ');
        row.append(name, details);
        if (githubRepo) {
          const link = document.createElement('a');
          link.href = githubRepo + '/blob/HEAD/' + file.split('/').map(encodeURIComponent).join('/');
          link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = 'Open in GitHub ↗';
          row.append(link);
        }
        if (fact?.evidence.length) {
          const evidence = document.createElement('small'); evidence.textContent = fact.evidence.join(' · ');
          row.append(evidence);
        }
        filePanel.append(row);
      }
    }
    const category = edge ? ({ http: 'HTTP connection', import: 'Static import', deploy: 'Deployment fact', state: 'State update' }[edge.type] || 'Connection') : component ? (component.runtime === component.kind ? component.kind : component.runtime + ' / ' + component.kind) : 'Diagram';
    $('flow-counter').textContent = category[0].toUpperCase() + category.slice(1);
    $('flow-node-title').textContent = edge ? byId.get(edge.source).name + ' → ' + byId.get(edge.target).name : component?.name || view.label;
    $('flow-explanation').hidden = !!component && !edge;
    if (edge?.type === 'http') $('flow-explanation').textContent = (edge.count > 1 ? edge.count + ' observed HTTP calls in this direction. Example: ' : '') + edge.label + ' in ' + edge.call.source + '. ' + (edge.call.target ? 'Matches the local route.' : edge.call.dynamic ? 'The full destination is computed at runtime.' : byId.get(edge.target).runtime === 'external' ? 'The source names an external host.' : 'No local route could be matched.');
    else if (edge?.type === 'import') $('flow-explanation').textContent = edge.count + (edge.count === 1 ? ' distinct file import' : ' distinct file imports') + ' in this direction. Example: ' + edge.example + '.';
    else if (edge) $('flow-explanation').textContent = edge.example + '. ' + view.description;
    else $('flow-explanation').textContent = view.description;
  }
  drawView(); render();
  return () => {
    observer.disconnect(); events.abort();
    for (const id of ['diagram-options', 'architecture-edges', 'architecture-nodes', 'flow-steps']) $(id).replaceChildren();
  };
}
