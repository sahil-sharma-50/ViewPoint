import { del, list } from '@vercel/blob';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`)
    return new Response('Unauthorized', { status: 401 });

  let cursor: string | undefined;
  let removed = 0;
  do {
    const page = await list({ prefix: 'sessions/', cursor });
    const expired = page.blobs.filter(blob => new Date(blob.uploadedAt).getTime() < Date.now() - 24 * 60 * 60 * 1000);
    if (expired.length) {
      await del(expired.map(blob => blob.url));
      removed += expired.length;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return Response.json({ removed });
}
