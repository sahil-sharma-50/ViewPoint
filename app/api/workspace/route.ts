import { loadAnalysis } from '../../../src/vercel-session';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const analysis = await loadAnalysis(url.searchParams.get('session') ?? '');
  if (!analysis) return Response.json({ error: 'This session has expired. Analyse the repository again.' }, { status: 404 });
  const { graph, repoUrl, architecture } = analysis;
  return Response.json(url.searchParams.get('view') === 'architecture' ? { graph, repoUrl, architecture } : { graph, repoUrl }, { headers: { 'Cache-Control': 'no-store' } });
}
