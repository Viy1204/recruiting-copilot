import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertRunId, buildSnapshot } from '../model.mjs';

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const workspaceKeyForRoot = root => createHash('sha256').update(root).digest('hex');
export const insideWorkspace = (root, file) => file === root || (!path.relative(root, file).startsWith(`..${path.sep}`) && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file)));

export async function resolveWorkspace(workspace) {
  if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('必须显式指定 --workspace');
  const root = await realpath(path.resolve(workspace));
  if (!(await stat(root)).isDirectory()) throw new Error('工作区必须是存在的目录');
  return root;
}

export async function readSource(root, relative) {
  try {
    const file = await realpath(path.join(root, relative));
    if (!insideWorkspace(root, file)) return { status: 'error' };
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return { status: 'error' };
    const bytes = await readFile(file);
    if (bytes.length > MAX_FILE_BYTES) return { status: 'error' };
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return { status: 'ok', text, updatedAt: info.mtime.toISOString(), revision: relative === 'CONTEXT.md' ? createHash('sha256').update(bytes).digest('hex') : undefined };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'missing' : 'error' };
  }
}

async function readRuns(root) {
  try {
    const relative = 'runtime/recruit-board/runs';
    const directory = await realpath(path.join(root, relative));
    if (!insideWorkspace(root, directory)) return { status: 'error' };
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      try { assertRunId(entry.name.slice(0, -5)); }
      catch { files.push({ name: entry.name, error: true }); continue; }
      const source = await readSource(root, `${relative}/${entry.name}`);
      files.push({ name: entry.name, text: source.text, error: source.status !== 'ok' });
    }
    return { status: 'ok', files };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'missing' : 'error' };
  }
}

export async function readSnapshot(root, previous = null, now = () => new Date().toISOString()) {
  const [ledger, context, runFiles, config] = await Promise.all([
    readSource(root, '02-sourcing/dedup-ledger.csv'), readSource(root, 'CONTEXT.md'), readRuns(root), readSource(root, '_shared/recruit-board.config.json')
  ]);
  return buildSnapshot({ workspace: path.basename(root), generatedAt: now(), ledger, context, runFiles, config }, previous);
}
