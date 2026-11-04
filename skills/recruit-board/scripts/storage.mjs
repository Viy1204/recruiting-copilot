import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, link, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { insideWorkspace, MAX_FILE_BYTES } from './reader.mjs';

export const storageError = (code, message, status = 422) => Object.assign(new Error(message), { code, status });

export async function boardDirectory(root, parts, create = false) {
  let directory = root;
  for (const part of parts) {
    const next = path.join(directory, part);
    if (create) await mkdir(next, { recursive: true });
    directory = await realpath(next);
    if (!insideWorkspace(root, directory) || !(await lstat(directory)).isDirectory()) throw storageError('WORKSPACE_PATH_UNSAFE', '看板数据目录必须位于工作区内');
  }
  return directory;
}

export async function readJSONFile(file, root, maxBytes = MAX_FILE_BYTES) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || !insideWorkspace(root, await realpath(file))) throw storageError('WORKSPACE_PATH_UNSAFE', '记录必须是工作区内的普通 JSON 文件');
  if (info.size > maxBytes) throw storageError('WORKSPACE_FILE_TOO_LARGE', '记录超过文件大小上限');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw storageError('WORKSPACE_PATH_UNSAFE', '记录在读取时发生变化，请重试');
    if (opened.size > maxBytes) throw storageError('WORKSPACE_FILE_TOO_LARGE', '记录超过文件大小上限');
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw storageError('WORKSPACE_FILE_TOO_LARGE', '记录超过文件大小上限');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw storageError('WORKSPACE_FILE_INVALID', '记录不是有效的 UTF-8 JSON'); }
  } finally { await handle.close(); }
}

export async function writeJSONFile(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw storageError('WORKSPACE_FILE_TOO_LARGE', '记录超过文件大小上限');
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`);
  try {
    const output = await open(temporary, 'wx');
    try { await output.writeFile(text, 'utf8'); await output.sync(); }
    finally { await output.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

function ownerIsAlive(owner) {
  if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.token)) throw storageError('DECISION_LOCKED', '写入锁无法核实，请检查锁的来源后再恢复', 409);
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export async function withItemLock(directory, key, operation, depth = 0) {
  if (depth > 16) throw storageError('DECISION_LOCKED', '锁恢复链过长，请检查残留写入进程', 409);
  const lockFile = path.join(directory, `${key}.lock`);
  const owner = { pid: process.pid, host: hostname(), token: randomUUID() };
  const temporary = path.join(directory, `.${key}-${owner.token}.owner`);
  let acquired = false;
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; attempt < 4 && !acquired; attempt++) {
      try { await link(temporary, lockFile); acquired = true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let previous;
        try { previous = await readJSONFile(lockFile, directory, 2048); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (ownerIsAlive(previous)) throw storageError('DECISION_LOCKED', '事项正在写入，请重试', 409);
        // 同一已退出进程的锁只由一位恢复者删除，避免另一恢复者误删新写入者的锁。
        const recoveryKey = `reclaim-${createHash('sha256').update(`${key}:${previous.token}`).digest('hex').slice(0, 48)}`;
        await withItemLock(directory, recoveryKey, async () => {
          let current;
          try { current = await readJSONFile(lockFile, directory, 2048); }
          catch (error) { if (error.code === 'ENOENT') return; throw error; }
          if (current.token === previous.token && !ownerIsAlive(current)) await rm(lockFile);
        }, depth + 1);
      }
    }
    if (!acquired) throw storageError('DECISION_LOCKED', '事项写入冲突，请重试', 409);
    return await operation();
  } finally {
    try {
      if (acquired) {
        const current = await readJSONFile(lockFile, directory, 2048);
        if (current.token !== owner.token) throw storageError('DECISION_LOCKED', '锁所有者已变化，未删除其他写入者的锁', 409);
        await rm(lockFile);
      }
    } finally { await rm(temporary, { force: true }); }
  }
}
