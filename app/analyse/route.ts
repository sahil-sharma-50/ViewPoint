import { analyseArchive } from '../../src/vercel-repo';
import { saveAnalysis, sameOrigin } from '../../src/vercel-session';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Cross-origin requests are not supported.' }, { status: 403 });
  let body: { url?: unknown; token?: unknown };
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Enter a public GitHub repository URL.' }, { status: 400 }); }
  if (body.token !== undefined) return Response.json({ error: 'Only public repositories are supported. Tokens are not accepted.' }, { status: 400 });
  const input = typeof body.url === 'string' ? body.url.trim() : '';
  if (!input || input.length > 300) return Response.json({ error: 'Enter a short public GitHub repository URL.' }, { status: 400 });
  try {
    const analysis = await analyseArchive(input);
    const sessionId = await saveAnalysis(analysis);
    return Response.json({ sessionId }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Repository analysis failed.' }, { status: 400 });
  }
}
