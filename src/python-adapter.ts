import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

type Scan =
  | { ok: true; edges: { source: string; target: string }[] }
  | { ok: false; error: string };

function scan(root: string, files: string[], helper: string, language?: string): Promise<Scan> {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const helperPath = path.join(projectRoot, 'src', 'helpers', helper);
  const localPackages = path.join(projectRoot, '.tools', 'python');
  return new Promise(resolve => {
    const child = spawn(process.platform === 'win32' ? 'python' : 'python3', [helperPath], {
      windowsHide: true,
      env: { ...process.env, PYTHONPATH: [localPackages, process.env['PYTHONPATH']].filter(Boolean).join(path.delimiter) },
    });
    let output = '';
    let settled = false;
    const finish = (value: Scan) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: 'Language scan timed out.' });
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.resume();
    child.stdin.on('error', () => {
      child.kill();
      finish({ ok: false, error: 'Language scan could not receive its input.' });
    });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 10_000_000) {
        child.kill();
        finish({ ok: false, error: 'Language scan exceeded its output budget.' });
      }
    });
    child.on('error', () => finish({ ok: false, error: 'Python is unavailable.' }));
    child.on('close', () => {
      try { finish(JSON.parse(output) as Scan); }
      catch { finish({ ok: false, error: 'Language scan returned invalid output.' }); }
    });
    child.stdin.end(JSON.stringify({ root, files, language }));
  });
}

export const scanPython = (root: string, files: string[]) =>
  scan(root, files, 'python_adapter.py');

export const scanStructured = (root: string, files: string[], language: 'go' | 'java') =>
  scan(root, files, 'structured_adapter.py', language);
