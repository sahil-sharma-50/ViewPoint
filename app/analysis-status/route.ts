import { loadAnalysis } from '../../src/vercel-session';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get('session') ?? '';
  const analysis = await loadAnalysis(sessionId);
  if (!analysis) return Response.json({ error: 'This session has expired. Analyse the repository again.' }, { status: 404 });
  return Response.json({ status: 'complete', repoUrl: analysis.repoUrl, expiresAt: analysis.expiresAt }, { headers: { 'Cache-Control': 'no-store' } });
}
