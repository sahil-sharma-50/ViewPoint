import { topFolder } from '../../src/full-map';

/** Five evidence-backed Architecture diagrams. Empty views say so instead of inventing edges. */
export function buildDiagramViews(graph, architecture) {
  const facts = new Map((architecture.files || []).map(item => [item.file, item]));
  const graphNodes = new Map(graph.nodes.map(node => [node.file, node]));
  const routeByFile = new Map(architecture.routes.map(route => [route.file, route]));
  const allFiles = facts.size ? [...facts.keys()] : [...new Set(graph.nodes.map(node => node.file))];
  const files = allFiles;
  const role = file => facts.get(file)?.role || (routeByFile.has(file) ? 'routes' : graphNodes.get(file)?.isEntryPoint ? 'entry' : 'other');
  const componentName = file => {
    const parts = file.replace(/^src\//, '').split('/');
    if (role(file) === 'entry') return 'Application entry';
    if (role(file) === 'routes') return routeByFile.get(file)?.url || 'API routes';
    if (parts.length === 1) return 'Root modules';
    if (parts.length === 2 && ['features', 'services', 'utils', 'components'].includes(parts[0])) return parts[1].replace(/\.[cm]?[jt]sx?$/, '');
    return topFolder(file).replace(/^src\//, '') || 'Root modules';
  };
  const grouped = new Map();
  for (const file of files) {
    const name = componentName(file);
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(file);
  }
  const calledFiles = new Set(architecture.calls.map(call => call.source));
  const score = ([name, members]) => (name === 'Application entry' ? 1000 : 0) + (members.some(file => role(file) === 'routes') ? 800 : 0) + (members.some(file => role(file) === 'interface') ? 500 : 0) + (members.some(file => calledFiles.has(file)) ? 300 : 0) + members.length * 5;
  const ranked = [...grouped.entries()].sort((a, b) => score(b) - score(a) || a[0].localeCompare(b[0]));
  const chosen = ranked.slice(0, 40);
  if (ranked.length > chosen.length) chosen.push(['Other modules', ranked.slice(chosen.length).flatMap(([, members]) => members)]);
  const components = chosen.map(([name, members], index) => {
    const runtimes = new Set(members.map(file => facts.get(file)?.runtime).filter(Boolean));
    const runtime = runtimes.size === 1 ? [...runtimes][0] : runtimes.has('frontend') && runtimes.has('backend') || runtimes.has('shared') ? 'shared' : runtimes.has('frontend') ? 'frontend' : runtimes.has('backend') ? 'backend' : 'unknown';
    return { id: 'c' + index, name, files: members, kind: name === 'Other modules' ? 'other' : role(members[0]), runtime };
  });
  const fileComponent = new Map(components.flatMap(component => component.files.map(file => [file, component.id])));
  const addNode = (id, name, files = [], kind = 'other', runtime = 'unknown') => {
    if (!components.some(component => component.id === id)) components.push({ id, name, files, kind, runtime });
    return id;
  };
  const empty = addNode('empty', 'No source evidence', [], 'other');
  const externalByCall = new Map();
  for (const call of architecture.calls) {
    if (call.target || !fileComponent.has(call.source)) continue;
    let host;
    try { if (/^https?:\/\//.test(call.url)) host = new URL(call.url).host; } catch { /* A computed URL has no verified host. */ }
    const name = host && !host.includes('*') ? host : 'Unknown destination';
    const id = addNode('external:' + name, name, [], 'external', name === 'Unknown destination' ? 'unknown' : 'external');
    externalByCall.set(call, id);
  }
  const byId = new Map(components.map(component => [component.id, component]));
  const connections = new Map();
  const connect = (source, target, type, label, example, call) => {
    if (!source || !target || source === target || !byId.has(target)) return;
    const id = source + '|' + target + '|' + type;
    const edge = connections.get(id) || { id, source, target, type, label, example, call, count: 0 };
    edge.count++;
    connections.set(id, edge);
  };
  const imports = [...new Map(graph.edges.flatMap(edge => edge.targets.map(target => ({ source: edge.source, target }))).map(edge => [edge.source + '\0' + edge.target, edge])).values()];
  for (const edge of imports) connect(fileComponent.get(edge.source), fileComponent.get(edge.target), 'import', 'Static import', edge.source + ' imports ' + edge.target);
  for (const call of architecture.calls) connect(fileComponent.get(call.source), call.target ? fileComponent.get(call.target) : externalByCall.get(call), 'http', call.method + ' ' + call.url, call.source, call);
  const allEdges = [...connections.values()];
  const incoming = id => allEdges.filter(edge => edge.target === id).sort((a, b) => b.count - a.count);
  const views = [];
  const addView = (id, label, description, candidates, extra = []) => {
    const all = [...new Map(candidates.filter(Boolean).map(edge => [edge.id, edge])).values()];
    const edges = all.slice(0, 14);
    const allNodeIds = [...new Set([...all.flatMap(edge => [edge.source, edge.target]), ...extra])].filter(node => byId.has(node));
    const nodeIds = allNodeIds.slice(0, 12);
    if (!nodeIds.length) nodeIds.push(empty);
    const view = { id, label, description, nodeIds, totalNodes: allNodeIds.length, totalEdges: all.length, edges: edges.filter(edge => nodeIds.includes(edge.source) && nodeIds.includes(edge.target)) };
    views.push(view);
    return view;
  };
  const rankedEdges = [...allEdges].sort((a, b) => (b.type === 'http') - (a.type === 'http') || b.count - a.count);
  addView('system', 'System Architecture Diagram', 'Source-backed components and their strongest connections.', rankedEdges, components.filter(component => component.id !== empty).map(component => component.id));
  const calls = allEdges.filter(edge => edge.type === 'http');
  addView('flow', 'Request / Data Flow Diagram', 'Observed HTTP requests and the imports around their callers. No request path is inferred without source evidence.', calls.flatMap(edge => [incoming(edge.source)[0], edge]));
  const moduleEdges = [];
  const modules = graph.nodes.map(node => {
    const id = addNode('module:' + node.file, node.file, [node.file], 'module', facts.get(node.file)?.runtime);
    byId.set(id, components.find(component => component.id === id));
    return id;
  });
  for (const edge of imports) {
    const targetFile = edge.target;
    const source = addNode('module:' + edge.source, edge.source, [edge.source], 'module', facts.get(edge.source)?.runtime);
    const target = addNode('module:' + targetFile, targetFile, [targetFile], 'module', facts.get(targetFile)?.runtime);
    byId.set(source, components.find(component => component.id === source));
    byId.set(target, components.find(component => component.id === target));
    moduleEdges.push({ id: source + '|' + target, source, target, type: 'import', label: 'Static import', example: edge.source + ' imports ' + targetFile, file: edge.source, count: 1 });
  }
  addView('dependencies', 'Code / Module Dependency Diagram', 'Directed static imports between source files, including tests.', moduleEdges, modules);
  const deploymentEdges = [];
  for (const item of architecture.deployments || []) {
    const source = addNode('deploy-file:' + item.file, item.file, [item.file], 'deployment');
    const target = addNode('deploy-target:' + item.target, item.target, [], 'deployment');
    byId.set(source, components.find(component => component.id === source));
    byId.set(target, components.find(component => component.id === target));
    deploymentEdges.push({ id: source + '|' + target + '|' + item.kind, source, target, type: 'deploy', label: item.kind, example: item.file + ' declares ' + item.target, file: item.file, count: 1 });
  }
  addView('deployment', 'Deployment / Infrastructure Diagram', 'Declared container images, Terraform resources, and runtime commands.', deploymentEdges);
  const stateEdges = [];
  const stateRoots = [];
  for (const [index, state] of (architecture.states || []).entries()) {
    const source = addNode('state:' + index, state.name + ' (initial: ' + state.initial + ')', [state.file], 'state');
    byId.set(source, components.find(component => component.id === source));
    stateRoots.push(source);
    for (const value of state.values) {
      const target = addNode(source + ':value:' + value, state.name + ': ' + value, [state.file], 'state');
      byId.set(target, components.find(component => component.id === target));
      stateEdges.push({ id: source + '|' + target, source, target, type: 'state', label: 'Sets ' + state.name + ' to ' + value, example: state.file + ' sets ' + state.name + ' to ' + value, file: state.file, count: 1 });
    }
  }
  addView('lifecycle', 'State / Lifecycle Diagram', 'State variables point to observed literal setter values. Initial values are annotations; transition order is unknown.', stateEdges, stateRoots);
  return { components, views };
}
