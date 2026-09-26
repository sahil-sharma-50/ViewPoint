import { mapExplainContext, type MapSelection } from '../../../src/map-explain';
import { explainMapContext } from '../../../src/watsonx';
import { loadAnalysis, sameOrigin } from '../../../src/vercel-session';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ ok: false, error: 'Cross-origin requests are not supported.' }, { status: 403 });
  let body: { sessionId?: unknown; selection?: unknown; question?: unknown };
  try { body = await request.json(); }
  catch { return Response.json({ ok: false, error: 'Enter a question and choose a map item.' }, { status: 400 }); }
  const { sessionId, selection, question } = body;
  const validSelection = selection && typeof selection === 'object' && (
    ('kind' in selection && selection.kind === 'file' && 'file' in selection && typeof selection.file === 'string' && selection.file.length <= 2000) ||
    ('kind' in selection && selection.kind === 'folder' && 'folder' in selection && typeof selection.folder === 'string' && selection.folder.length <= 2000) ||
    ('kind' in selection && selection.kind === 'link' && 'source' in selection && 'target' in selection && typeof selection.source === 'string' && typeof selection.target === 'string' && selection.source.length <= 2000 && selection.target.length <= 2000)
  );
  if (typeof sessionId !== 'string' || !validSelection || typeof question !== 'string' || !question.trim() || question.length > 300)
    return Response.json({ ok: false, error: 'Choose a map item and enter a short question.' }, { status: 400 });
  const analysis = await loadAnalysis(sessionId);
  if (!analysis) return Response.json({ ok: false, error: 'This session has expired. Analyse the repository again.' }, { status: 404 });
  const context = mapExplainContext(analysis.graph, selection as MapSelection);
  if (!context.ok) return Response.json(context, { status: 400 });
  const excerpts = context.excerptFiles.flatMap(file => analysis.excerpts[file] ? [{ file, text: analysis.excerpts[file] }] : []);
  const evidence = [...context.evidence.slice(0, 16), ...excerpts.map(item => `Source excerpt: ${item.file}, first 60 lines.`)];
  const result = await explainMapContext(context.subject, evidence, question.trim(), excerpts);
  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
