import { explainArchitecture } from '../../../src/watsonx';
import { loadAnalysis, sameOrigin } from '../../../src/vercel-session';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ ok: false, error: 'Cross-origin requests are not supported.' }, { status: 403 });
  let body: { sessionId?: unknown };
  try { body = await request.json(); }
  catch { return Response.json({ ok: false, error: 'Choose an analysed repository.' }, { status: 400 }); }
  if (typeof body.sessionId !== 'string') return Response.json({ ok: false, error: 'Choose an analysed repository.' }, { status: 400 });
  const analysis = await loadAnalysis(body.sessionId);
  if (!analysis) return Response.json({ ok: false, error: 'This session has expired.' }, { status: 404 });
  return Response.json(await explainArchitecture(analysis.architecture), { headers: { 'Cache-Control': 'no-store' } });
}
