import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  auditContext,
  DEFAULT_KEEP_RECENT,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_DECISIONS,
  DEFAULT_MAX_LINES,
  formatColdDecisionMarkdown,
  normalizeColdDecisionInput,
  planDecisionArchive
} from '../context-hygiene-domain.mjs';
import { insideWorkspace, MAX_FILE_BYTES, resolveWorkspace } from './reader.mjs';
import { withItemLock } from './storage.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const isValidRevision = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function decodeContext(bytes) {
  let encoding = 'utf8', bom = Buffer.alloc(0), body = bytes;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) { bom = bytes.subarray(0, 3); body = bytes.subarray(3); }
  else if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) { encoding = 'utf16le'; bom = bytes.subarray(0, 2); body = bytes.subarray(2); }
  else if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) { encoding = 'utf16be'; bom = bytes.subarray(0, 2); body = bytes.subarray(2); }
  try {
    const text = new TextDecoder({ utf8: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be' }[encoding], { fatal: true, ignoreBOM: true }).decode(body);
    return {
      text,
      encode: next => {
        const output = Buffer.from(next, encoding === 'utf8' ? 'utf8' : 'utf16le');
        if (encoding === 'utf16be') output.swap16();
        return Buffer.concat([bom, output]);
      }
    };
  } catch {
    throw failure('CONTEXT_ENCODING', 'CONTEXT.md 编码无法安全保留，请使用有效的 UTF-8 或带 BOM 的 UTF-16 文本', 422);
  }
}

async function ensureDir(root, segments, create = false) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw failure('CONTEXT_HYGIENE_UNREADABLE', '无法访问工作区目录', 422);
      if (!create) return null;
      await mkdir(current, { recursive: true });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || !insideWorkspace(root, await realpath(current))) {
      throw failure('CONTEXT_HYGIENE_UNSAFE', '目标目录必须位于工作区内且不能为符号链接', 403);
    }
  }
  return current;
}

async function readContextSafe(root) {
  const file = path.join(root, 'CONTEXT.md');
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') throw failure('CONTEXT_MISSING', '未找到工作区 CONTEXT.md', 404);
    throw failure('CONTEXT_UNREADABLE', '无法读取 CONTEXT.md', 422);
  }
  if (!info.isFile() || info.isSymbolicLink() || !insideWorkspace(root, await realpath(file))) {
    throw failure('CONTEXT_UNSAFE', 'CONTEXT.md 必须是工作区内的普通文本文件', 403);
  }
  if (info.size > MAX_FILE_BYTES) throw failure('CONTEXT_TOO_LARGE', 'CONTEXT.md 超过读取上限', 422);
  const bytes = await readFile(file);
  if (bytes.length > MAX_FILE_BYTES) throw failure('CONTEXT_TOO_LARGE', 'CONTEXT.md 超过读取上限', 422);
  return { file, info, bytes, revision: digest(bytes), ...decodeContext(bytes) };
}

async function readColdLogFile(root, file) {
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { exists: false, text: '', info: null };
    throw failure('ARCHIVE_UNREADABLE', '无法读取冷审计日志文件', 422);
  }
  if (!info.isFile() || info.isSymbolicLink() || !insideWorkspace(root, await realpath(file))) {
    throw failure('CONTEXT_HYGIENE_UNSAFE', '冷审计日志文件必须位于工作区内且不能为符号链接', 403);
  }
  const bytes = await readFile(file);
  return { exists: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), info };
}

async function atomicWriteFile(file, bytes, mode = 0o600) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`);
  try {
    const output = await open(temporary, 'wx', mode);
    try { await output.writeFile(bytes); await output.sync(); }
    finally { await output.close(); }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function listDecisionArchives(workspace) {
  const root = await resolveWorkspace(workspace);
  const dir = await ensureDir(root, ['runtime', 'decisions-log'], false);
  if (!dir) return { directory: 'runtime/decisions-log', files: [] };
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const full = path.join(dir, entry.name);
    const loaded = await readColdLogFile(root, full);
    const itemCount = loaded.text.split(/\r?\n/).filter(line => /^-\s+/.test(line)).length;
    files.push({
      name: entry.name,
      path: `runtime/decisions-log/${entry.name}`,
      bytes: Buffer.byteLength(loaded.text, 'utf8'),
      entries: itemCount
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { directory: 'runtime/decisions-log', files };
}

export async function auditContextWorkspace(workspace, {
  maxBytes = DEFAULT_MAX_BYTES,
  maxLines = DEFAULT_MAX_LINES,
  maxDecisions = DEFAULT_MAX_DECISIONS
} = {}) {
  const root = await resolveWorkspace(workspace);
  const context = await readContextSafe(root);
  const report = auditContext(context.text, { maxBytes, maxLines, maxDecisions });
  const archives = await listDecisionArchives(root);
  return {
    revision: context.revision,
    ...report,
    coldArchives: archives.files
  };
}

export async function archiveContextDecisions({
  workspace,
  expectedRevision,
  keepRecent = DEFAULT_KEEP_RECENT,
  beforeDate = null
}) {
  if (!isValidRevision(expectedRevision)) {
    throw failure('CONTEXT_HYGIENE_INPUT_INVALID', 'expectedRevision 必须为 64 位 SHA-256 十六进制字符串');
  }
  const root = await resolveWorkspace(workspace);
  const lockDir = await ensureDir(root, ['runtime', 'recruit-board', 'roles'], true);
  return withItemLock(lockDir, 'context-hygiene', async () => {
    const context = await readContextSafe(root);
    if (context.revision !== expectedRevision) {
      throw failure('CONTEXT_CONFLICT', 'CONTEXT.md 已被修改，请重新执行 audit 获取最新 revision 后归档', 409);
    }
    const plan = planDecisionArchive(context.text, { keepRecent, beforeDate });
    if (!plan.changed) {
      return {
        changed: false,
        archivedCount: 0,
        keptCount: plan.keptCount,
        revision: context.revision,
        backup: null,
        archiveFiles: []
      };
    }

    const archiveDir = await ensureDir(root, ['runtime', 'decisions-log'], true);
    const archiveFiles = [];
    for (const [bucket, items] of Object.entries(plan.archiveGroups)) {
      const target = path.join(archiveDir, `${bucket}.md`);
      const existing = await readColdLogFile(root, target);
      const header = existing.exists
        ? existing.text.trimEnd()
        : `# 决策冷审计日志（${bucket}）\n\n> 本文件为只追加冷日志，供人工回溯；AI 日常开工默认不读取。`;
      const additions = [];
      for (const item of items) {
        const marker = `<!-- archive-hash:${item.hash} -->`;
        if (existing.text.includes(marker)) continue;
        additions.push(`${marker}\n${item.text}`);
      }
      if (additions.length > 0 || !existing.exists) {
        const nextArchive = `${header}\n\n${additions.join('\n\n')}\n`;
        await atomicWriteFile(target, Buffer.from(nextArchive, 'utf8'), existing.info ? existing.info.mode & 0o777 : 0o600);
      }
      archiveFiles.push(`runtime/decisions-log/${bucket}.md`);
    }

    const latest = await readContextSafe(root);
    if (latest.revision !== expectedRevision) {
      throw failure('CONTEXT_CONFLICT', '保存前检测到 CONTEXT.md 变化，请重新读取后归档', 409);
    }
    const backup = path.join(lockDir, `CONTEXT-archive-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.md`);
    const saved = await open(backup, 'wx');
    try { await saved.writeFile(context.bytes); await saved.sync(); }
    finally { await saved.close(); }

    const nextBytes = context.encode(plan.nextContextText);
    if (nextBytes.length > MAX_FILE_BYTES) throw failure('CONTEXT_TOO_LARGE', '归档后内容超过读取上限', 422);
    await atomicWriteFile(context.file, nextBytes, context.info.mode & 0o777);

    return {
      changed: true,
      archivedCount: plan.archivedCount,
      keptCount: plan.keptCount,
      revision: digest(nextBytes),
      backup: path.relative(root, backup).split(path.sep).join('/'),
      archiveFiles: archiveFiles.sort()
    };
  });
}

export async function logColdDecision({ workspace, decision }, nowIso = new Date().toISOString()) {
  const root = await resolveWorkspace(workspace);
  const entry = normalizeColdDecisionInput(decision, nowIso);
  const lockDir = await ensureDir(root, ['runtime', 'recruit-board', 'roles'], true);
  return withItemLock(lockDir, 'context-hygiene', async () => {
    const archiveDir = await ensureDir(root, ['runtime', 'decisions-log'], true);
    const target = path.join(archiveDir, `${entry.month}.md`);
    const existing = await readColdLogFile(root, target);
    const idToken = `**[${entry.id}]**`;
    if (existing.text.includes(idToken)) {
      return {
        changed: false,
        replayed: true,
        id: entry.id,
        path: `runtime/decisions-log/${entry.month}.md`,
        entry
      };
    }
    const header = existing.exists
      ? existing.text.trimEnd()
      : `# 决策冷审计日志（${entry.month}）\n\n> 本文件为只追加冷日志，供人工回溯；AI 日常开工默认不读取。`;
    const block = formatColdDecisionMarkdown(entry).trimEnd();
    const nextText = `${header}\n\n${block}\n`;
    await atomicWriteFile(target, Buffer.from(nextText, 'utf8'), existing.info ? existing.info.mode & 0o777 : 0o600);
    return {
      changed: true,
      replayed: false,
      id: entry.id,
      path: `runtime/decisions-log/${entry.month}.md`,
      entry
    };
  });
}

async function readInputJSON(flags) {
  if (flags.input !== undefined && flags['input-file'] !== undefined) {
    throw failure('CONTEXT_HYGIENE_INPUT_INVALID', '--input 与 --input-file 只能提供一个');
  }
  if (flags.input !== undefined) {
    try { return JSON.parse(flags.input); }
    catch { throw failure('CONTEXT_HYGIENE_INPUT_INVALID', '--input 不是有效的 JSON'); }
  }
  if (flags['input-file'] !== undefined) {
    const root = await resolveWorkspace(flags.workspace);
    const real = await realpath(path.resolve(flags['input-file'])).catch(() => {
      throw failure('CONTEXT_HYGIENE_INPUT_INVALID', '无法读取 --input-file');
    });
    if (!insideWorkspace(root, real)) throw failure('CONTEXT_HYGIENE_UNSAFE', '--input-file 必须位于工作区内', 403);
    const bytes = await readFile(real);
    if (bytes.length > MAX_FILE_BYTES) throw failure('CONTEXT_TOO_LARGE', '--input-file 超过读取上限', 422);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw failure('CONTEXT_HYGIENE_INPUT_INVALID', '--input-file 不是有效的 UTF-8 JSON'); }
  }
  throw failure('CONTEXT_HYGIENE_INPUT_INVALID', '必须提供 --input 或 --input-file 参数');
}

const commandSpecs = {
  audit: { required: ['workspace'], optional: ['max-bytes', 'max-lines', 'max-decisions'] },
  'archive-decisions': { required: ['workspace', 'expected-revision'], optional: ['keep-recent', 'before'] },
  'log-decision': { required: ['workspace'], optional: ['input', 'input-file'] },
  'list-archive': { required: ['workspace'], optional: [] }
};

const positiveInt = (value, label) => {
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num < 0) throw failure('CONTEXT_HYGIENE_INPUT_INVALID', `${label} 必须为非负整数`);
  return num;
};

export async function contextHygieneCLI(argv) {
  const [command, ...args] = argv;
  const spec = Object.hasOwn(commandSpecs, command) ? commandSpecs[command] : null;
  if (!spec) {
    throw failure('CONTEXT_HYGIENE_INPUT_INVALID', '用法：context-hygiene.mjs audit/archive-decisions/log-decision/list-archive --workspace <目录> ...');
  }
  const allowed = new Set([...spec.required, ...spec.optional]);
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!flag?.startsWith('--')) throw failure('CONTEXT_HYGIENE_INPUT_INVALID', `无效参数：${flag ?? ''}`);
    const key = flag.slice(2);
    if (!allowed.has(key) || Object.hasOwn(flags, key) || value === undefined || value.startsWith('--')) {
      throw failure('CONTEXT_HYGIENE_INPUT_INVALID', `参数无效、重复或缺少值：${flag}`);
    }
    flags[key] = value;
  }
  for (const key of spec.required) {
    if (!Object.hasOwn(flags, key)) throw failure('CONTEXT_HYGIENE_INPUT_INVALID', `缺少必填参数：--${key}`);
  }

  if (command === 'audit') {
    return auditContextWorkspace(flags.workspace, {
      ...(flags['max-bytes'] !== undefined ? { maxBytes: positiveInt(flags['max-bytes'], 'max-bytes') } : {}),
      ...(flags['max-lines'] !== undefined ? { maxLines: positiveInt(flags['max-lines'], 'max-lines') } : {}),
      ...(flags['max-decisions'] !== undefined ? { maxDecisions: positiveInt(flags['max-decisions'], 'max-decisions') } : {})
    });
  }
  if (command === 'archive-decisions') {
    return archiveContextDecisions({
      workspace: flags.workspace,
      expectedRevision: flags['expected-revision'],
      ...(flags['keep-recent'] !== undefined ? { keepRecent: positiveInt(flags['keep-recent'], 'keep-recent') } : {}),
      ...(flags.before !== undefined ? { beforeDate: flags.before } : {})
    });
  }
  if (command === 'list-archive') return listDecisionArchives(flags.workspace);
  const payload = await readInputJSON(flags);
  return logColdDecision({ workspace: flags.workspace, decision: payload });
}

export function contextHygieneError(error) {
  return {
    error: {
      code: typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'CONTEXT_HYGIENE_FAILED',
      message: error.status || error.code?.startsWith('CONTEXT_') || error.code?.startsWith('ARCHIVE_') || error.code?.startsWith('DECISION_')
        ? error.message
        : '上下文健康检查或归档失败，请检查工作区文件和权限'
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await contextHygieneCLI(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify(contextHygieneError(error))}\n`); process.exitCode = 1; }
}
