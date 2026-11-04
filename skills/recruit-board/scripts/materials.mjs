import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildSnapshot } from '../model.mjs';
import { insideWorkspace, MAX_FILE_BYTES, readSource, resolveWorkspace } from './reader.mjs';
import { candidateKey, inspectDocument, materialCategory, materialKind, MATERIAL_CATEGORIES, MAX_DOCUMENTS, parseFilesConfig, readCandidateDetail } from './records.mjs';
import { withItemLock } from './storage.mjs';

const CONFIG_PATH = '_shared/recruit-board.files.json';
const MAX_OPTIONS = 300;
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 6;
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const revisionFor = bytes => digest(bytes ?? Buffer.from('recruit-board.files:missing:v1'));
const allowedDirectory = file => file.startsWith('03-interview/') || file.startsWith('runtime/resumes/');
const relativeTo = (root, file) => path.relative(root, file).split(path.sep).join('/');

async function directory(root, relative, create = false) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (create) {
      try { await mkdir(current); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !insideWorkspace(root, await realpath(current))) throw failure('MATERIALS_PATH_UNSAFE', '资料或控制目录必须是工作区内的真实目录', 403);
  }
  return current;
}

function selectionPath(value, existing = false) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 4096 || /[\x00-\x1f:*?"<>|]/.test(value)) throw failure('MATERIALS_PATH_INVALID', '请选择资料目录内的相对文件路径');
  const file = value.replace(/\\/g, '/');
  if (file.startsWith('/') || file.split('/').some(part => !part || ['.', '..'].includes(part) || /[. ]$/.test(part)) || (!existing && !allowedDirectory(file))) throw failure('MATERIALS_PATH_INVALID', '只能关联既定资料目录或当前候选已确认的工作区文件', 403);
  return file;
}

async function selectedDocument(root, value, expected = {}, existing = false) {
  const file = selectionPath(value, existing);
  try {
    if (path.posix.dirname(file) !== '.') await directory(root, path.posix.dirname(file));
    const resolved = await realpath(path.join(root, file));
    if (!insideWorkspace(root, resolved) || (!existing && !allowedDirectory(relativeTo(root, resolved)))) throw failure('MATERIALS_PATH_UNSAFE', '资料链接的实际文件必须位于工作区和允许的资料目录内', 403);
    const inspected = await inspectDocument(root, { path: file, base: root, ...expected });
    if (inspected.status !== 'ok') throw failure('MATERIALS_FILE_UNAVAILABLE', inspected.message, inspected.status === 'missing' ? 404 : inspected.status === 'blocked' ? 403 : 503);
    return { ...inspected, path: file };
  } catch (error) {
    if (error.code === 'ENOENT') throw failure('MATERIALS_FILE_UNAVAILABLE', '选择的资料文件不存在，请重新读取列表', 404);
    throw error;
  }
}

async function mapping(root) {
  const file = path.join(root, CONFIG_PATH);
  let info;
  try { await directory(root, '_shared'); info = await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { file, bytes: null, revision: revisionFor(null), value: { schemaVersion: 1, candidates: {} }, mode: 0o600 };
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES || !insideWorkspace(root, await realpath(file))) throw failure('MATERIALS_CONFIG_UNSAFE', '资料映射必须是工作区内的普通 JSON 文件', 403);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_FILE_BYTES) throw failure('MATERIALS_CONFIG_UNSAFE', '资料映射在读取时发生变化', 409);
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (bytesRead > MAX_FILE_BYTES || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || bytesRead !== after.size) throw failure('MATERIALS_CONFIG_UNSAFE', '资料映射超过大小上限或在读取时发生变化', 409);
    bytes = buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw failure('FILES_CONFIG_INVALID', '资料映射的文本编码无效', 503); }
  return { file, bytes, revision: revisionFor(bytes), value: parseFilesConfig(text), mode: info.mode & 0o777 };
}

async function knownCandidate(root, id) {
  candidateKey(id);
  const [ledger, context, config] = await Promise.all([readSource(root, '02-sourcing/dedup-ledger.csv'), readSource(root, 'CONTEXT.md'), readSource(root, '_shared/recruit-board.config.json')]);
  const snapshot = buildSnapshot({ workspace: path.basename(root), generatedAt: new Date().toISOString(), ledger, context, config, runFiles: { status: 'missing' } });
  if (!snapshot.candidates) throw failure('CANDIDATE_SOURCE_ERROR', '候选台账无法读取，请恢复后重试', 503);
  if (snapshot.sources.config.status === 'error') throw failure('CANDIDATE_CONFIG_ERROR', '兼容配置无效，无法确认候选资料归属', 503);
  if (!snapshot.candidates.some(candidate => candidate.id === id)) throw failure('CANDIDATE_NOT_FOUND', '当前台账中未找到这条候选记录', 404);
}

async function optionsInWorkspace(root) {
  const options = [], warnings = [];
  let visited = 0, truncated = false;
  async function scan(relative, depth = 0) {
    if (depth > MAX_DEPTH) { truncated = true; return; }
    let folder;
    try { folder = await directory(root, relative); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (!warnings.includes('部分资料目录无法安全读取，未列出其中的文件')) warnings.push('部分资料目录无法安全读取，未列出其中的文件');
      return;
    }
    const entries = await opendir(folder);
    try {
      for await (const entry of entries) {
        if (++visited > MAX_ENTRIES || options.length >= MAX_OPTIONS) { truncated = true; break; }
        if (entry.isSymbolicLink()) continue;
        const file = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await scan(file, depth + 1);
        else if (entry.isFile() && materialKind(entry.name) !== 'unsupported') {
          let inspected;
          try { inspected = await selectedDocument(root, file); }
          catch { continue; }
          options.push({ path: file, label: entry.name, filename: entry.name, kind: inspected.kind, category: materialCategory(file), size: inspected.size });
        }
        if (visited > MAX_ENTRIES || options.length >= MAX_OPTIONS) { truncated = true; break; }
      }
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      warnings.push('部分资料目录无法读取，列表可能不完整');
    }
  }
  for (const folder of ['03-interview', 'runtime/resumes']) {
    if (visited > MAX_ENTRIES || options.length >= MAX_OPTIONS) break;
    await scan(folder);
  }
  options.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
  if (truncated) warnings.push('待选资料达到数量或目录深度上限，列表可能不完整');
  return { options, warnings, truncated };
}

export async function listCandidateMaterials(workspace, candidateId) {
  candidateKey(candidateId);
  const root = await resolveWorkspace(workspace);
  const current = await mapping(root);
  const detail = await readCandidateDetail(root, candidateId);
  const options = await optionsInWorkspace(root);
  if ((await mapping(root)).revision !== current.revision) throw failure('MATERIALS_CONFLICT', '资料映射已变化，请重新读取', 409);
  return { candidateId, revision: current.revision, confirmed: current.value.candidates[candidateId]?.confirmed === true, files: detail.documents.filter(file => file.path), ...options, warnings: [...detail.warnings, ...options.warnings] };
}

function checkRevision(revision) {
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw failure('MATERIALS_INPUT_INVALID', '资料映射版本无效');
}

function checkFiles(files) {
  if (!Array.isArray(files) || files.length > MAX_DOCUMENTS) throw failure('MATERIALS_INPUT_INVALID', 'files 必须是最多 30 份文件的列表');
  const seen = new Set();
  return files.map(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some(key => !['path', 'label', 'category'].includes(key)) || (file.label !== undefined && (typeof file.label !== 'string' || !file.label.trim() || file.label !== file.label.trim() || file.label.length > 300 || /[\x00-\x1f]/.test(file.label))) || (file.category !== undefined && !MATERIAL_CATEGORIES.includes(file.category))) throw failure('MATERIALS_INPUT_INVALID', '资料的路径、标题或类别无效');
    const selected = selectionPath(file.path, true);
    if (seen.has(selected)) throw failure('MATERIALS_INPUT_INVALID', '资料列表中不能重复选择同一路径');
    seen.add(selected);
    return { path: selected, ...(file.label ? { label: file.label } : {}), category: file.category ?? materialCategory(selected, file.label) };
  });
}

async function locked(root, operation) {
  const control = await directory(root, 'runtime/recruit-board/materials', true);
  try { return await withItemLock(control, 'files', () => operation(control)); }
  catch (error) {
    if (error.code === 'DECISION_LOCKED') throw failure('MATERIALS_LOCKED', '资料映射正在写入或写入锁需要核对，请重试', 409);
    throw error;
  }
}

async function commitMapping(root, current, candidateId, entry, control) {
  if (JSON.stringify(current.value.candidates[candidateId]) === JSON.stringify(entry)) return { changed: false, revision: current.revision, backup: null };
  const value = { ...current.value, candidates: { ...current.value.candidates, [candidateId]: entry } };
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > MAX_FILE_BYTES) throw failure('MATERIALS_CONFIG_TOO_LARGE', '资料映射超过大小上限');
  await directory(root, '_shared', true);
  await directory(root, 'runtime/recruit-board/materials');
  if ((await mapping(root)).revision !== current.revision) throw failure('MATERIALS_CONFLICT', '资料映射已被修改，请重新读取后保存', 409);
  let backup = null;
  if (current.bytes !== null) {
    const file = path.join(control, `files-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(current.bytes); await handle.sync(); }
    finally { await handle.close(); }
    backup = relativeTo(root, file);
  }
  const temporary = path.join(root, '_shared', `.recruit-board.files-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', current.mode);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    if ((await mapping(root)).revision !== current.revision) throw failure('MATERIALS_CONFLICT', '保存前检测到资料映射变化，请重新读取后保存', 409);
    await rename(temporary, current.file);
  } finally { await rm(temporary, { force: true }); }
  return { changed: true, revision: revisionFor(bytes), backup };
}

export async function setCandidateMaterials({ workspace, candidateId, revision, files }) {
  candidateKey(candidateId);
  checkRevision(revision);
  const selected = checkFiles(files);
  const root = await resolveWorkspace(workspace);
  await knownCandidate(root, candidateId);
  return locked(root, async control => {
    const current = await mapping(root);
    if (current.revision !== revision) throw failure('MATERIALS_CONFLICT', '资料映射已被修改，请重新读取后保存', 409);
    const previous = current.value.candidates[candidateId]?.files ?? [];
    const detail = await readCandidateDetail(root, candidateId);
    const retained = new Set(detail.documents.filter(file => file.path && file.status === 'ok').map(file => file.path));
    const next = [];
    for (const file of selected) {
      const existing = previous.find(item => item.path === file.path);
      const inspected = await selectedDocument(root, file.path, existing?.sha256 ? { sha256: existing.sha256 } : {}, retained.has(file.path));
      next.push({ ...file, kind: inspected.kind, ...(existing?.sha256 ? { sha256: existing.sha256 } : {}), ...(existing?.source ? { source: existing.source } : {}) });
    }
    await knownCandidate(root, candidateId);
    const saved = await commitMapping(root, current, candidateId, { files: next, confirmed: true }, control);
    return { candidateId, ...saved, files: (await readCandidateDetail(root, candidateId)).documents };
  });
}

async function archiveOriginal(root, inspected, hash, existingFiles) {
  for (const existing of existingFiles) {
    if (existing.sha256 !== hash) continue;
    const candidate = await selectedDocument(root, existing.path, { sha256: hash });
    if (candidate.kind === inspected.kind) return { path: candidate.path, reused: true };
  }
  const folder = await directory(root, 'runtime/resumes/local', true);
  // 首次导入可能在映射提交前中断；按已知归档命名检查同 hash 文件后复用。
  let count = 0;
  const entries = await opendir(folder);
  for await (const entry of entries) {
    if (++count > MAX_ENTRIES) throw failure('MATERIALS_ARCHIVE_LIMIT', '本地归档目录条目过多，请先核对索引', 409);
    if (!entry.isFile() || !entry.name.includes(`--${hash.slice(0, 12)}.`) || materialKind(entry.name) !== inspected.kind) continue;
    const file = `runtime/resumes/local/${entry.name}`;
    const candidate = await selectedDocument(root, file);
    if (digest(candidate.bytes) === hash) return { path: file, reused: true };
  }
  const extension = path.extname(inspected.file).toLowerCase();
  const basename = path.basename(inspected.file, path.extname(inspected.file)).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || 'material';
  const filename = `${basename}--${hash.slice(0, 12)}${extension}`;
  const file = path.join(folder, filename), relative = relativeTo(root, file);
  const temporary = path.join(folder, `.material-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(inspected.bytes); await handle.sync(); }
    finally { await handle.close(); }
    await directory(root, 'runtime/resumes/local');
    try { await link(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await selectedDocument(root, relative);
      if (digest(previous.bytes) !== hash) throw failure('MATERIALS_ARCHIVE_CONFLICT', '同名归档的内容不同，未覆盖原件', 409);
      return { path: relative, reused: true };
    }
    const archived = await selectedDocument(root, relative, { sha256: hash });
    if (archived.bytes.length !== inspected.bytes.length) throw failure('MATERIALS_ARCHIVE_CONFLICT', '归档内容校验失败', 409);
    return { path: relative, reused: false };
  } finally { await rm(temporary, { force: true }); }
}

export async function importCandidateMaterial({ workspace, candidateId, sourcePath, category = 'resume', label, revision }) {
  candidateKey(candidateId);
  if (!MATERIAL_CATEGORIES.includes(category) || (label !== undefined && (typeof label !== 'string' || !label.trim() || label !== label.trim() || label.length > 300 || /[\x00-\x1f]/.test(label)))) throw failure('MATERIALS_INPUT_INVALID', '资料标题或类别无效');
  if (revision !== undefined) checkRevision(revision);
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || sourcePath.length > 4096 || /[\x00-\x1f]/.test(sourcePath) || /^[\\/]{2}/.test(sourcePath)) throw failure('MATERIALS_SOURCE_INVALID', '本地导入必须提供明确的本机绝对 sourcePath');
  const root = await resolveWorkspace(workspace);
  await knownCandidate(root, candidateId);
  const source = await realpath(sourcePath);
  if (/^[\\/]{2}/.test(source) || materialKind(source) !== materialKind(sourcePath)) throw failure('MATERIALS_SOURCE_INVALID', '本地来源链接的实际文件类型不一致或指向网络共享', 403);
  const inspected = await inspectDocument(path.dirname(source), { path: source, base: path.dirname(source) });
  if (inspected.status !== 'ok') throw failure('MATERIALS_SOURCE_UNAVAILABLE', inspected.message, 403);
  const hash = digest(inspected.bytes);
  return locked(root, async control => {
    const current = await mapping(root);
    if (revision !== undefined && current.revision !== revision) throw failure('MATERIALS_CONFLICT', '资料映射已被修改，请重新读取后导入', 409);
    const previous = current.value.candidates[candidateId];
    const files = [...(previous?.files ?? [])];
    if (files.length >= MAX_DOCUMENTS && !files.some(file => file.sha256 === hash)) throw failure('MATERIALS_INPUT_INVALID', '候选显式资料已达 30 份上限');
    const allFiles = Object.values(current.value.candidates).flatMap(entry => entry.files);
    const archive = await archiveOriginal(root, inspected, hash, allFiles);
    const index = files.findIndex(file => file.path === archive.path || file.sha256 === hash);
    const file = { path: archive.path, label: label ?? files[index]?.label ?? path.basename(sourcePath), kind: inspected.kind, category, sha256: hash, source: files[index]?.source ?? { type: 'local', path: source, importedAt: new Date().toISOString() } };
    if (index < 0) {
      if (files.length >= MAX_DOCUMENTS) throw failure('MATERIALS_INPUT_INVALID', '候选显式资料已达 30 份上限');
      files.push(file);
    } else files[index] = file;
    await knownCandidate(root, candidateId);
    const saved = await commitMapping(root, current, candidateId, { ...previous, files }, control);
    return { candidateId, ...saved, path: archive.path, sha256: hash, reused: archive.reused };
  });
}
