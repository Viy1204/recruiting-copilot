import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { insideWorkspace, MAX_FILE_BYTES } from './reader.mjs';

export const WORKSPACE_LOCK_FILES = Object.freeze({
  context: 'context.lock',
  ledger: 'ledger.lock'
});

const ioError = (code, message, status = 400, extra = {}) =>
  Object.assign(new Error(message), { code, status, ...extra });

/**
 * Replaces workspace root path occurrences in error messages to avoid leaking local paths.
 * @param {string} message
 * @param {string | null | undefined} root
 */
export function sanitizeWorkspaceMessage(message, root) {
  let out = String(message ?? '未知错误');
  if (root) {
    const posixRoot = root.split(path.sep).join('/');
    for (const candidate of new Set([root, posixRoot])) {
      if (candidate) out = out.split(candidate).join('<workspace>');
    }
  }
  return out;
}

/**
 * Decodes UTF-8 (with optional BOM) or BOM-tagged UTF-16 bytes and provides a lossless encoder.
 * @param {Buffer | Uint8Array} bytes
 * @param {{ label?: string, code?: string, status?: number }} [options]
 */
export function decodeTextWithMeta(
  bytes,
  { label = '文件', code = 'TEXT_ENCODING_INVALID', status = 422 } = {}
) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let encoding = 'utf8';
  let bom = Buffer.alloc(0);
  let body = buf;
  if (buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    bom = buf.subarray(0, 3);
    body = buf.subarray(3);
  } else if (buf.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    encoding = 'utf16le';
    bom = buf.subarray(0, 2);
    body = buf.subarray(2);
  } else if (buf.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    encoding = 'utf16be';
    bom = buf.subarray(0, 2);
    body = buf.subarray(2);
  }
  const codec = encoding === 'utf8' ? 'utf-8' : encoding === 'utf16le' ? 'utf-16le' : 'utf-16be';
  try {
    const text = new TextDecoder(codec, { fatal: true, ignoreBOM: true }).decode(body);
    return {
      text,
      encoding,
      bom,
      encode(next) {
        const output = Buffer.from(next, encoding === 'utf8' ? 'utf8' : 'utf16le');
        if (encoding === 'utf16be') output.swap16();
        return Buffer.concat([bom, output]);
      }
    };
  } catch {
    throw ioError(code, `${label}编码无法安全保留，请使用有效 UTF-8 或 UTF-16 文本`, status);
  }
}

/**
 * Decodes strict UTF-8 bytes without allowing invalid byte sequences.
 * @param {Buffer | Uint8Array} bytes
 * @param {{ label?: string, code?: string, status?: number, stripBom?: boolean }} [options]
 */
export function decodeUTF8Strict(
  bytes,
  { label = '文件', code = 'TEXT_ENCODING_INVALID', status = 422, stripBom = false } = {}
) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return stripBom ? text.replace(/^\uFEFF/, '') : text;
  } catch {
    throw ioError(code, `${label}不是有效的 UTF-8 文本`, status);
  }
}

/**
 * Inspects a workspace-relative path segment by segment, rejecting traversal and any symlink/junction.
 * Always checks parent segments before reporting `missing`, so a symlinked directory with a missing
 * child is reported as `unsafe` (`SYMLINK_ESCAPE`) rather than `missing`.
 * @param {string} root
 * @param {string} relativePath
 */
export async function inspectRelativePath(root, relativePath) {
  const normalized = String(relativePath ?? '').trim();
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    path.posix.isAbsolute(normalized) ||
    /^[a-zA-Z]:/.test(normalized)
  ) {
    return { status: 'unsafe', code: 'PATH_TRAVERSAL', message: `路径不能是空值或绝对路径：${relativePath}` };
  }
  const resolved = path.resolve(root, normalized);
  if (!insideWorkspace(root, resolved)) {
    return { status: 'unsafe', code: 'PATH_TRAVERSAL', message: `路径越出工作区边界：${relativePath}` };
  }
  const rel = path.relative(root, resolved);
  const parts = rel ? rel.split(path.sep).filter(Boolean) : [];
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (error.code === 'ENOENT') return { status: 'missing', target: resolved };
      return { status: 'error', code: 'PATH_UNREADABLE', message: `无法访问路径：${relativePath}` };
    }
    if (info.isSymbolicLink()) {
      return { status: 'unsafe', code: 'SYMLINK_ESCAPE', message: `禁止通过符号链接访问路径：${relativePath}` };
    }
  }
  const realTarget = await realpath(resolved);
  if (!insideWorkspace(root, realTarget)) {
    return { status: 'unsafe', code: 'SYMLINK_ESCAPE', message: `真实路径越出工作区边界：${relativePath}` };
  }
  const info = await lstat(realTarget);
  return { status: 'ok', target: realTarget, info };
}

/**
 * Walks and optionally creates a workspace subdirectory segment by segment, rejecting symlinks/junctions.
 * @param {string} root
 * @param {string[]} parts
 * @param {{ create?: boolean, code?: string, status?: number }} [options]
 */
export async function ensureSafeDirectory(
  root,
  parts,
  { create = false, code = 'UNSAFE_WORKSPACE_PATH', status = 403 } = {}
) {
  let current = root;
  for (const part of parts) {
    if (typeof part !== 'string' || !part || part === '.' || part === '..' || /[/\\]/.test(part)) {
      throw ioError(code, `目录路径段不合法：${String(part)}`, status);
    }
    const next = path.join(current, part);
    let info;
    try {
      info = await lstat(next);
    } catch (error) {
      if (error.code !== 'ENOENT') throw ioError(code, `无法访问工作区子目录：${parts.join('/')}`, status);
      if (!create) return null;
      try {
        await mkdir(next);
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw ioError(code, `无法创建工作区子目录：${parts.join('/')}`, status);
      }
      info = await lstat(next);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw ioError(code, `目录路径不安全：${parts.join('/')}`, status);
    }
    const real = await realpath(next);
    if (!insideWorkspace(root, real)) {
      throw ioError(code, `目录越出工作区边界：${parts.join('/')}`, status);
    }
    current = real;
  }
  return current;
}

/**
 * Safely reads a regular file inside a workspace with segment-by-segment symlink checks,
 * pre-read size validation, O_NOFOLLOW open, and fstat dev/ino consistency verification.
 * @param {string} root
 * @param {string} relativePath
 * @param {{ maxBytes?: number, label?: string, decode?: boolean, encodingCode?: string }} [options]
 */
export async function readSafeWorkspaceFile(
  root,
  relativePath,
  { maxBytes = MAX_FILE_BYTES, label = relativePath, decode = false, encodingCode = 'TEXT_ENCODING_INVALID' } = {}
) {
  const inspected = await inspectRelativePath(root, relativePath);
  if (inspected.status === 'missing') return { status: 'missing' };
  if (inspected.status !== 'ok') return inspected;
  if (!inspected.info.isFile()) {
    return { status: 'error', code: 'NOT_A_FILE', message: `${label}必须是普通文件` };
  }
  if (inspected.info.size > maxBytes) {
    return { status: 'error', code: 'FILE_TOO_LARGE', message: `${label}超过大小上限` };
  }
  let handle;
  try {
    handle = await open(inspected.target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === 'ELOOP') {
      return { status: 'unsafe', code: 'SYMLINK_ESCAPE', message: `禁止通过符号链接访问路径：${relativePath}` };
    }
    if (error.code === 'ENOENT') return { status: 'missing' };
    return { status: 'error', code: 'PATH_UNREADABLE', message: `无法打开文件：${label}` };
  }
  let bytes;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== inspected.info.dev || opened.ino !== inspected.info.ino) {
      return { status: 'unsafe', code: 'FILE_CHANGED', message: `${label}在读取期间发生变化，请重试` };
    }
    if (opened.size > maxBytes) {
      return { status: 'error', code: 'FILE_TOO_LARGE', message: `${label}超过大小上限` };
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytes.length > maxBytes) {
    return { status: 'error', code: 'FILE_TOO_LARGE', message: `${label}超过大小上限` };
  }
  if (!decode) {
    return { status: 'ok', file: inspected.target, info: inspected.info, bytes };
  }
  const decoded = decodeTextWithMeta(bytes, { label, code: encodingCode });
  return { status: 'ok', file: inspected.target, info: inspected.info, bytes, ...decoded };
}

/**
 * Reads a JSON object from a workspace-scoped `--input-file` path.
 * Relative paths resolve against `root` (never `process.cwd()`), symlinks/junctions are rejected,
 * regular-file type and size limits are enforced before reading into memory, and UTF-8 BOM is stripped.
 * @param {string} root
 * @param {string} inputPath
 * @param {{ maxBytes?: number, label?: string, code?: string }} [options]
 */
export async function readWorkspaceInputJSON(
  root,
  inputPath,
  { maxBytes = MAX_FILE_BYTES, label = '输入文件', code = 'INPUT_FILE_INVALID' } = {}
) {
  const rawPath = typeof inputPath === 'string' ? inputPath.trim() : '';
  if (!rawPath) {
    throw ioError(code, `${label}路径不能为空`, 400);
  }
  const resolved = path.resolve(root, rawPath);
  if (!insideWorkspace(root, resolved)) {
    throw ioError(code, `${label}必须位于工作区内`, 400);
  }
  const rel = path.relative(root, resolved);
  if (!rel) {
    throw ioError(code, `${label}必须是工作区内的普通 JSON 文件`, 400);
  }
  const res = await readSafeWorkspaceFile(root, rel, { maxBytes, label });
  if (res.status === 'missing') {
    throw ioError(code, `${label}不存在`, 400);
  }
  if (res.status === 'unsafe') {
    throw ioError(code, res.message, 403);
  }
  if (res.status !== 'ok') {
    throw ioError(code, res.message, 422);
  }
  const text = decodeUTF8Strict(res.bytes, { label, code, status: 400, stripBom: true });
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw ioError(code, `${label}不是有效 JSON`, 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ioError(code, `${label}必须是 JSON 对象`, 400);
  }
  return value;
}

/**
 * Atomically writes bytes to `targetFile` via exclusive temp file + fsync + optional pre-rename hook + rename.
 * @param {string} targetFile
 * @param {Buffer | Uint8Array | string} content
 * @param {{ mode?: number, tempPrefix?: string, beforeRename?: () => Promise<void> | void }} [options]
 */
export async function writeAtomicFile(
  targetFile,
  content,
  { mode = 0o600, tempPrefix = `.${path.basename(targetFile)}`, beforeRename = null } = {}
) {
  let temporary = path.join(path.dirname(targetFile), `${tempPrefix}-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (beforeRename) {
      await beforeRename();
    }
    await rename(temporary, targetFile);
    temporary = null;
  } finally {
    if (temporary) await rm(temporary, { force: true });
  }
}

/**
 * Executes `operation` while holding an exclusive workspace lock file under `runtime/recruit-board/roles`.
 * @param {string} root
 * @param {string} lockName
 * @param {(lockDir: string) => Promise<T>} operation
 * @param {{ dirParts?: string[], lockedCode?: string, lockedMessage?: string, unsafeCode?: string, unsafeStatus?: number, exitCode?: number }} [options]
 * @template T
 */
export async function withWorkspaceLock(
  root,
  lockName,
  operation,
  {
    dirParts = ['runtime', 'recruit-board', 'roles'],
    lockedCode = 'WORKSPACE_LOCKED',
    lockedMessage = '工作区文件正在写入或仍有未释放的锁，请确认后重试',
    unsafeCode = 'UNSAFE_WORKSPACE_PATH',
    unsafeStatus = 403,
    exitCode
  } = {}
) {
  const lockDir = await ensureSafeDirectory(root, dirParts, {
    create: true,
    code: unsafeCode,
    status: unsafeStatus
  });
  const lockFile = path.join(lockDir, lockName);
  let lock;
  try {
    lock = await open(lockFile, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw ioError(lockedCode, lockedMessage, 409, exitCode !== undefined ? { exitCode } : {});
    }
    throw ioError(unsafeCode, `无法获取写入锁：${lockName}`, unsafeStatus);
  }
  try {
    return await operation(lockDir);
  } finally {
    try {
      await lock.close();
    } finally {
      await rm(lockFile, { force: true });
    }
  }
}
