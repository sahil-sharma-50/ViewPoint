import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as ts from 'typescript';

const ignored = new Set(['.git', 'node_modules', '.next', '.venv', 'venv', '__pycache__', 'vendor', 'dist', 'build', 'coverage', 'target', 'output', '.playwright-cli', '.codex', '.agents']);
export const scriptFile = /\.[cm]?[jt]sx?$/i;

/** Inventory regular files only. Never follow a repository symlink. */
export function listRepoFiles(root: string): string[] {
  const maxFiles = Number(process.env['VIEWPOINT_MAX_FILES']) || 30_000;
  if (fs.existsSync(path.join(root, '.git'))) {
    const tracked = execFileSync('git', ['-C', root, 'ls-files', '--cached', '-z'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
      .split('\0').filter(Boolean);
    if (tracked.length > maxFiles) throw new Error(`Repository exceeds the configured ${maxFiles} file budget. Increase VIEWPOINT_MAX_FILES on your server.`);
    return tracked.map(file => path.join(root, file)).filter(file => fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()).sort();
  }
  const files: string[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        files.push(file);
        if (files.length > maxFiles) throw new Error(`Repository exceeds the configured ${maxFiles} file budget. Increase VIEWPOINT_MAX_FILES on your server.`);
      }
    }
  }
  walk(root);
  return files.sort();
}

/** Inferred module resolution settings for repository mapping. */
export function readRepoConfig(root: string, files = listRepoFiles(root)) {
  const configPath = ['tsconfig.json', 'jsconfig.json'].map(f => path.join(root, f)).find(f => fs.existsSync(f));
  const options: ts.CompilerOptions = {
    allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
  };
  let warning: string | undefined;
  let fileNames = files.filter(f => scriptFile.test(f));
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) warning = 'Project configuration could not be read; inferred settings are used.';
    else {
      const parsed = ts.parseJsonConfigFileContent({ ...config.config, compilerOptions: { ...config.config.compilerOptions, allowJs: true } }, ts.sys, root);
      Object.assign(options, parsed.options, { allowJs: true, noEmit: true });
      const regularFiles = new Set(files.map(file => path.resolve(file)));
      if (parsed.fileNames.length) fileNames = parsed.fileNames.filter(file => regularFiles.has(path.resolve(file)));
      if (parsed.errors.some(d => d.code !== 18003)) warning = 'Some project configuration could not be resolved; analysis coverage is incomplete.';
    }
  }
  return { fileNames, options, warning };
}
