import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createApp } from './server.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Next exposes a CommonJS factory; require preserves its shape under Node16 resolution.
const next: typeof import('next').default = createRequire(import.meta.url)('next');
const dev = process.argv.includes('--dev');
const port = Number(process.env['PORT'] ?? 3000);
const web = next({ dev, dir: projectRoot, port });
await web.prepare();
const api = createApp();
const handle = web.getRequestHandler();
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/$/, '') || '/';
  if (['/', '/architecture', '/graph-view', '/full-map'].includes(pathname) || pathname.startsWith('/_next/') || pathname.startsWith('/__nextjs')) {
    void handle(req, res);
  } else {
    api(req, res);
  }
});
server.on('upgrade', web.getUpgradeHandler());
server.listen(port, () => console.log(`ViewPoint (${dev ? 'development' : 'production'}) at http://localhost:${port}`));
