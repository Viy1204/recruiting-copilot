import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot, parseCSV, readConfig, readRoles } from '../model.mjs';
import { insideWorkspace, MAX_FILE_BYTES, readSource, resolveWorkspace } from './reader.mjs';

const MAX_ORIGINAL_BYTES = 24 * 1024 * 1024;
export const MAX_DOCUMENTS = 30;
export const MATERIAL_CATEGORIES = Object.freeze(['resume', 'archive', 'brief', 'other']);
const kinds = { '.md': 'markdown', '.txt': 'text', '.pdf': 'pdf', '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.doc': 'doc', '.docx': 'docx', '.rtf': 'rtf' };
const mimeTypes = { markdown: 'text/plain; charset=utf-8', text: 'text/plain; charset=utf-8', pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rtf: 'application/rtf' };
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const documentId = (candidate, reference) => createHash('sha256').update(JSON.stringify([candidate, reference])).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const materialKind = file => kinds[path.extname(file).toLowerCase()] ?? 'unsupported';

export function candidateKey(value) {
  let key;
  try { key = JSON.parse(value); } catch { throw failure('CANDIDATE_INVALID', '候选记录标识无效'); }
  if (typeof value !== 'string' || !Array.isArray(key) || key.length !== 2 || key.some(item => typeof item !== 'string' || !item.trim() || item !== item.trim()) || JSON.stringify(key) !== value || value.length > 4096) throw failure('CANDIDATE_INVALID', '候选记录标识无效');
  return key;
}

function referencePath(value) {
  let raw = value.trim();
  const link = /^\[[^\]]*\]\((?:<([^<>]+)>|([^\r\n]+))\)$/.exec(raw);
  if (link) raw = (link[1] ?? link[2]).trim();
  else if (/^`[^`]+`$/.test(raw)) raw = raw.slice(1, -1);
  return raw;
}

function resolveReference(root, value, base) {
  const raw = referencePath(value);
  if (!raw || /[\x00-\x1f]/.test(raw) || raw.length > 4096 || /^[\\/]{2}/.test(raw)) throw failure('DOCUMENT_PATH_BLOCKED', '文件路径为空、包含非法字符或指向网络共享', 403);
  let file;
  if (/^file:/i.test(raw)) {
    const url = new URL(raw);
    if (url.hostname || url.search || url.hash) throw failure('DOCUMENT_PATH_BLOCKED', '仅支持本机工作区内的文件', 403);
    file = fileURLToPath(url);
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) throw failure('DOCUMENT_PATH_BLOCKED', '不打开外部链接或执行协议', 403);
    if (process.platform !== 'win32' && path.win32.isAbsolute(raw)) throw failure('DOCUMENT_PATH_BLOCKED', '文件路径不属于当前本机工作区', 403);
    file = path.resolve(base, raw.replace(/[\\/]/g, path.sep));
  }
  if (!insideWorkspace(root, file)) throw failure('DOCUMENT_OUTSIDE_WORKSPACE', '文件位于工作区外，未开放读取', 403);
  return file;
}

export function materialCategory(file, label = '') {
  const name = path.basename(file.replace(/\\/g, '/'));
  if (/(?:^|[-_.\s])brief(?:[-_.\s]|$)|简报/i.test(name) || /brief|简报/i.test(label)) return 'brief';
  if (file.replace(/\\/g, '/').startsWith('03-interview/') && ['markdown', 'text'].includes(materialKind(name))) return 'archive';
  if (file.replace(/\\/g, '/').startsWith('runtime/resumes/') || /简历|resume/i.test(label)) return 'resume';
  return 'other';
}

function validDocx(bytes) {
  // 只检查有界 ZIP 目录和 Word 主文档，不解压或执行办公文档。
  const minimum = Math.max(0, bytes.length - 65557);
  let end = bytes.length - 22;
  while (end >= minimum && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < minimum || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) return false;
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count < 2 || count > 4096 || bytes.readUInt16LE(end + 8) !== count || start + size !== end) return false;
  const names = new Set();
  let offset = start;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) return false;
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), length = bytes.readUInt16LE(offset + 28);
    const next = offset + 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42), compressed = bytes.readUInt32LE(offset + 20);
    if (!length || next > end || flags & 1 || ![0, 8].includes(method) || local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) return false;
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + length), rawName = nameBytes.toString('utf8');
    const emptyDirectory = rawName.endsWith('/') && compressed === 0 && bytes.readUInt32LE(offset + 24) === 0;
    const name = emptyDirectory ? rawName.replace(/\\/g, '/') : rawName;
    const localLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
    const localName = bytes.subarray(local + 30, local + 30 + localLength);
    const matchingName = nameBytes.equals(localName) || (emptyDirectory && localName.toString('utf8').replace(/\\/g, '/') === name);
    if (local + 30 + localLength + localExtra + compressed > start || !matchingName || /[\x00\\]/.test(name) || name.startsWith('/') || name.split('/').includes('..') || names.has(name)) return false;
    names.add(name);
    offset = next;
  }
  return offset === end && names.has('[Content_Types].xml') && names.has('word/document.xml');
}

function validOriginal(bytes, kind) {
  if (kind === 'pdf') return bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
  if (kind === 'png') return bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 && bytes.subarray(-12, -4).equals(Buffer.from('0000000049454e44', 'hex'));
  if (kind === 'jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if (kind === 'doc') return bytes.length >= 512 && bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')) && bytes.readUInt16LE(28) === 0xfffe && [9, 12].includes(bytes.readUInt16LE(30)) && bytes.includes(Buffer.from('WordDocument\0', 'utf16le'));
  if (kind === 'docx') return bytes.length >= 22 && validDocx(bytes);
  if (kind === 'rtf') return /^\{\\rtf[1-9]\d*(?:\\|\s)/.test(bytes.subarray(0, 64).toString('ascii'));
  return true;
}

export async function inspectDocument(root, reference) {
  let handle;
  const kind = materialKind(referencePath(reference.path));
  const blocked = (message, size = null) => ({ file: null, kind, status: 'blocked', message, size });
  try {
    const file = resolveReference(root, reference.path, reference.base ?? root);
    if (kind === 'unsupported' || (reference.kind && reference.kind !== kind)) return blocked('支持 Markdown、TXT、PDF、PNG/JPG、DOC/DOCX、RTF，文件类型须与扩展名一致');
    const resolved = await realpath(file);
    if (!insideWorkspace(root, resolved)) throw failure('DOCUMENT_OUTSIDE_WORKSPACE', '文件指向工作区外，未开放读取', 403);
    if (materialKind(resolved) !== kind) return blocked('附件链接的实际文件类型不一致，未开放读取');
    const before = await lstat(resolved);
    if (!before.isFile() || before.isSymbolicLink()) return blocked('附件不是普通文件');
    handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    const limit = ['markdown', 'text'].includes(kind) ? MAX_FILE_BYTES : MAX_ORIGINAL_BYTES;
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size > limit) return blocked('附件不是普通文件、读取时发生变化或超过读取上限', info.size);
    const chunks = [];
    let length = 0;
    while (length <= limit) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    if (length > limit) return blocked('附件超过读取上限', length);
    const bytes = Buffer.concat(chunks, length);
    const current = await realpath(file), after = await handle.stat();
    if (current !== resolved || !insideWorkspace(root, current) || after.size !== info.size || after.mtimeMs !== info.mtimeMs) return blocked('附件在读取时发生变化，请重试');
    if (reference.sha256 && createHash('sha256').update(bytes).digest('hex') !== reference.sha256) return blocked('归档原件的内容校验不一致，请核对后重新关联', bytes.length);
    let text = null;
    if (['markdown', 'text'].includes(kind)) {
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
      try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
      catch { return blocked('文本编码无法安全读取，支持 UTF-8 或带 BOM 的 UTF-16', bytes.length); }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return blocked('附件含有二进制控制字节，不能作为文本读取', bytes.length);
    } else if (!validOriginal(bytes, kind)) return blocked('附件字节与声明的文件类型不符或文件头、目录损坏', bytes.length);
    return { file: resolved, kind, status: 'ok', message: null, size: bytes.length, bytes, text };
  } catch (error) {
    const status = error.code === 'ENOENT' ? 'missing' : error.status === 403 ? 'blocked' : 'error';
    return { file: null, kind, status, message: status === 'missing' ? '台账或映射指向的文件不存在' : status === 'blocked' ? error.message : '附件无法读取', size: null };
  } finally { if (handle) await handle.close(); }
}

export function parseFilesConfig(text) {
  let value;
  try { value = JSON.parse(text.replace(/^﻿/, '')); } catch { throw failure('FILES_CONFIG_INVALID', '资料映射不是有效 JSON'); }
  if (!object(value) || value.schemaVersion !== 1 || !object(value.candidates) || Object.keys(value).some(key => !['schemaVersion', 'candidates'].includes(key))) throw failure('FILES_CONFIG_INVALID', '资料映射版本或字段无效');
  for (const [key, entry] of Object.entries(value.candidates)) {
    candidateKey(key);
    if (!object(entry) || Object.keys(entry).some(field => !['files', 'confirmed'].includes(field)) || (entry.confirmed !== undefined && typeof entry.confirmed !== 'boolean') || !Array.isArray(entry.files) || entry.files.length > MAX_DOCUMENTS) throw failure('FILES_CONFIG_INVALID', '资料映射的 files 必须是有限文件列表');
    for (const file of entry.files) {
      if (!object(file) || Object.keys(file).some(field => !['path', 'label', 'kind', 'category', 'sha256', 'source'].includes(field)) || typeof file.path !== 'string' || !file.path.trim() || file.path.length > 4096 || (file.label !== undefined && (typeof file.label !== 'string' || !file.label.trim() || /[\x00-\x1f]/.test(file.label) || file.label.length > 300)) || (file.kind !== undefined && !Object.hasOwn(mimeTypes, file.kind)) || (file.category !== undefined && !MATERIAL_CATEGORIES.includes(file.category)) || (file.sha256 !== undefined && (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)))) throw failure('FILES_CONFIG_INVALID', '资料映射包含无效路径、标题、类别或文件类型');
      if (file.source !== undefined && (!object(file.source) || Object.keys(file.source).some(field => !['type', 'path', 'importedAt'].includes(field)) || file.source.type !== 'local' || typeof file.source.path !== 'string' || !file.source.path.trim() || file.source.path.length > 4096 || /[\x00-\x1f]/.test(file.source.path) || typeof file.source.importedAt !== 'string' || !Number.isFinite(Date.parse(file.source.importedAt)))) throw failure('FILES_CONFIG_INVALID', '资料映射的本地来源无效');
    }
  }
  return value;
}

function markdownLinks(text) {
  const links = [];
  for (const match of text.matchAll(/(?<!!)\[([^\]\r\n]+)\]\(/g)) {
    let index = match.index + match[0].length, file = '', closed = false;
    if (text[index] === '<') {
      const end = text.indexOf('>', index + 1);
      if (end >= 0 && !/[\r\n]/.test(text.slice(index, end)) && text[end + 1] === ')') { file = text.slice(index + 1, end); closed = true; }
    } else {
      let depth = 1;
      for (; index < text.length; index++) {
        const char = text[index];
        if (/[\r\n]/.test(char)) break;
        if (char === '\\' && /[()\\]/.test(text[index + 1] ?? '')) { file += text[++index]; continue; }
        if (char === '(') depth++;
        else if (char === ')' && --depth === 0) { closed = true; break; }
        file += char;
      }
    }
    if (closed && file) links.push({ label: match[1], file });
  }
  return links;
}

const fieldValue = (text, labels) => {
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const field = /^\s*[-*]\s*(?:\*\*)?([^：:*]+?)(?:\*\*)?\s*[：:]\s*(.+)$/.exec(line);
    if (field && labels.includes(field[1].trim())) values.push(field[2].trim().replace(/^\*\*\s*/, ''));
  }
  return [...new Set(values)];
};
const uniqueText = (rows, column) => [...new Set(rows.map(row => row[column].trim()).filter(Boolean))].join('\n\n');
const metadata = (reference, inspected) => ({ id: reference.id, path: reference.relativePath, label: reference.label, category: reference.category, kind: inspected.kind, status: inspected.status, message: inspected.message, size: inspected.size, filename: reference.filename, mimeType: mimeTypes[inspected.kind] ?? 'application/octet-stream', downloadOnly: ['doc', 'docx', 'rtf'].includes(inspected.kind) });

function archiveProgress(text) {
  const sections = new Map();
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading && heading[1].length <= 2) section = heading[2].trim();
    else {
      const lines = sections.get(section) ?? [];
      lines.push(line); sections.set(section, lines);
    }
  }
  const clean = value => {
    const result = (value ?? '').replace(/\*\*|`/g, '').trim();
    return !result || /〔|〕/.test(result) || /^(?:[-—–]+|待填写|未填写)$/.test(result) ? null : result;
  };
  const field = (section, label) => {
    const values = fieldValue((sections.get(section) ?? []).join('\n'), [label]).map(clean).filter(Boolean);
    return [...new Set(values)].join('\n') || null;
  };
  const interviews = [];
  const columns = ['轮次', '时间', '形式', '面试官', '状态'];
  let indexes = null;
  for (const line of sections.get('面试安排') ?? []) {
    if (!line.trim().startsWith('|')) { indexes = null; continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(value => value.trim());
    if (columns.every(name => cells.includes(name))) { indexes = columns.map(name => cells.indexOf(name)); continue; }
    if (!indexes || cells.every(value => /^:?-{3,}:?$/.test(value))) continue;
    const values = indexes.map(index => clean(cells[index]));
    if (values.every(value => value === null)) continue;
    const [round, time, format, interviewers, status] = values;
    interviews.push({ round, time, format, interviewers, status });
  }
  return { currentStatus: field('基本信息', '当前状态'), interviews, conclusion: field('决策', '结论'), nextAction: field('决策', '下一步') };
}

async function candidateSources(workspace) {
  const root = await resolveWorkspace(workspace);
  const [ledger, context, configSource, filesSource] = await Promise.all([
    readSource(root, '02-sourcing/dedup-ledger.csv'), readSource(root, 'CONTEXT.md'), readSource(root, '_shared/recruit-board.config.json'), readSource(root, '_shared/recruit-board.files.json')
  ]);
  const snapshot = buildSnapshot({ workspace: path.basename(root), generatedAt: new Date().toISOString(), ledger, context, config: configSource, runFiles: { status: 'missing' } });
  return { root, ledger, context, configSource, filesSource, snapshot };
}

async function candidateRecords(workspace, id, shared = null, archivesOnly = false) {
  const [name, rawRole] = candidateKey(id);
  const { root, ledger, context, configSource, filesSource, snapshot } = shared ?? await candidateSources(workspace);
  if (!snapshot.candidates) throw failure('CANDIDATE_SOURCE_ERROR', '候选台账无法读取，请恢复后重试', 503);
  if (snapshot.sources.config.status === 'error') throw failure('CANDIDATE_CONFIG_ERROR', '兼容配置无效，无法确认候选资料归属', 503);
  const candidate = snapshot.candidates.find(item => item.id === id);
  if (!candidate) throw failure('CANDIDATE_NOT_FOUND', '当前台账中未找到这条候选记录', 404);
  const rows = parseCSV(ledger.text).filter(row => row[1].trim() === name && row[2].trim() === rawRole);
  const warnings = [], identityWarnings = [], references = [];
  let explicit = null;
  if (filesSource.status === 'ok') {
    try { explicit = parseFilesConfig(filesSource.text).candidates[id] ?? null; }
    catch (error) { warnings.push(error.message); }
  } else if (filesSource.status === 'error') warnings.push('资料映射文件无法读取，未应用显式关联');
  const addReference = (file, base, label, kind, category, extra = {}) => {
    let relativePath = null;
    try { relativePath = path.relative(root, resolveReference(root, file, base)).split(path.sep).join('/'); }
    catch (error) { if (error.status !== 403 && !(error instanceof TypeError)) throw error; }
    const key = JSON.stringify([relativePath === null ? base : root, relativePath ?? referencePath(file)]);
    const existing = references.find(item => item.key === key);
    if (existing) {
      if (extra.explicit) Object.assign(existing, { label: label || existing.label, kind: kind ?? existing.kind, category: category ?? existing.category, ...extra });
      return;
    }
    if (references.length >= MAX_DOCUMENTS) { if (!warnings.includes('文件关联超过上限，仅显示前 30 份')) warnings.push('文件关联超过上限，仅显示前 30 份'); return; }
    const filename = path.basename((relativePath ?? referencePath(file)).replace(/\\/g, '/'));
    references.push({ path: file, base, relativePath, filename, label: label || filename, kind, category: category ?? materialCategory(relativePath ?? file, label), ...extra, key, id: documentId(id, key) });
  };
  if (!explicit?.confirmed) {
    for (const file of [...new Set(rows.map(row => row[7].trim()).filter(Boolean))]) {
      const kind = materialKind(file);
      addReference(file, root, undefined, undefined, ['unsupported', 'markdown'].includes(kind) ? materialCategory(file) : 'resume');
    }
  }
  for (const file of explicit?.files ?? []) addReference(file.path, root, file.label, file.kind, file.category, { sha256: file.sha256, explicit: true });
  const uniqueName = snapshot.candidates.filter(item => item.name === name).length === 1;
  const plainName = !/[\s*＊xX×某〇○?？<>《》〔〕\[\]\\/:]/.test(name) && !/(?:先生|女士|小姐|同学|老师)$/.test(name);
  if (!explicit?.confirmed && plainName && uniqueName) {
    const archive = `03-interview/${name}.md`;
    const source = await readSource(root, archive);
    if (source.status === 'ok') {
      const fields = fieldValue(source.text, ['应聘岗位', '岗位']);
      const names = fieldValue(source.text, ['姓名', '姓名 / 性别 / 年龄']);
      let aliases = {};
      if (configSource.status === 'ok') aliases = readConfig(configSource.text, context.status === 'ok' ? readRoles(context.text) : []).roleAliases;
      const matching = fields.length === 1 && fields.some(value => {
        const full = Object.hasOwn(aliases, value) ? aliases[value] : value;
        if (full === candidate.role) return true;
        if (Object.hasOwn(aliases, value) || snapshot.roles.some(role => role.configured && role.name === value)) return false;
        const withoutNote = value.replace(/\s*[（(][^（）()]*[）)]\s*$/, '').trim();
        const canonical = Object.hasOwn(aliases, withoutNote) ? aliases[withoutNote] : withoutNote;
        return canonical === candidate.role;
      });
      const title = /^#\s+(.+)$/m.exec(source.text)?.[1].trim().replace(/^面试档案\s*[—–-]\s*/, '').replace(/\s*[（(][^（）()]*[）)]\s*$/, '').trim();
      const nameMatches = names.length ? names.every(value => value === name || value.startsWith(`${name} /`) || value.startsWith(`${name}/`)) : title === name;
      if (matching && nameMatches) {
        addReference(archive, root, '面试档案', 'markdown', 'archive');
        for (const link of markdownLinks(source.text)) {
          if (!link.file.startsWith('#')) addReference(link.file, path.join(root, '03-interview'), link.label);
        }
      } else identityWarnings.push('同名档案的姓名或岗位无法唯一核对，未自动关联；可在资料映射中明确指定');
    } else if (source.status === 'error') identityWarnings.push('同名面试档案无法读取，未自动关联');
  } else if (!explicit?.confirmed) identityWarnings.push(uniqueName ? '称谓或打码姓名不自动匹配面试档案，可使用显式资料映射' : '同名跨原岗位记录未自动关联面试档案，可使用显式资料映射');
  const documents = [], progressRecords = [], archives = [];
  let archiveErrors = 0;
  for (const reference of references) {
    if (archivesOnly && reference.category !== 'archive') continue;
    const inspected = await inspectDocument(root, reference);
    const document = metadata(reference, inspected);
    documents.push(document);
    if (reference.category !== 'archive') continue;
    archives.push({ document, text: inspected.text });
    if (inspected.status !== 'ok') { archiveErrors++; continue; }
    if (inspected.text === null) continue;
    const progress = archiveProgress(inspected.text);
    if (progress.currentStatus || progress.interviews.length || progress.conclusion || progress.nextAction) progressRecords.push({ documentId: document.id, label: document.label, ...progress });
  }
  const progress = {
    status: archiveErrors ? progressRecords.length ? 'partial' : 'error' : progressRecords.length ? 'ok' : 'missing',
    records: progressRecords,
    message: archiveErrors ? '部分已关联面试档案无法读取，请查看资料提示；以下只显示可核实记录。' : progressRecords.length ? null : '尚无已核实的面试安排或下一步记录。'
  };
  documents.sort((left, right) => Number(right.status === 'ok') - Number(left.status === 'ok'));
  if (!explicit?.confirmed && !references.some(reference => reference.explicit && documents.some(document => document.id === reference.id && document.status === 'ok'))) warnings.push(...identityWarnings);
  const resumes = documents.filter(document => document.category === 'resume');
  if (!resumes.some(document => document.status === 'ok')) {
    warnings.push(resumes.length ? '原始简历的关联文件尚不可用，请查看各文件的缺失或校验说明' : '原始简历未获取；档案和 brief 不能替代原始简历');
  }
  if (candidate.conflict) warnings.push('同一原人岗记录存在状态或评级冲突，详情保留各条台账文本');
  return { root, references, archives, detail: {
    candidate: { id: candidate.id, name: candidate.name, rawRole: candidate.rawRole, role: candidate.role, rawStatus: candidate.rawStatus, rating: candidate.rating },
    background: uniqueText(rows, 3), notes: uniqueText(rows, 8), sourceRound: uniqueText(rows, 6), documents, warnings, progress
  } };
}

export async function readCandidateArchives(workspace, id = null) {
  const shared = await candidateSources(workspace);
  if (!shared.snapshot.candidates) return { status: 'missing', candidates: [], diagnostics: [] };
  if (shared.snapshot.sources.config.status === 'error') throw failure('CANDIDATE_CONFIG_ERROR', '兼容配置无效，无法核对进展档案来源', 503);
  let mapped = {};
  if (shared.filesSource.status === 'error') throw failure('FILES_CONFIG_INVALID', '资料映射无法读取，进展来源待核对', 503);
  if (shared.filesSource.status === 'ok') mapped = parseFilesConfig(shared.filesSource.text).candidates;
  const names = new Set();
  const folder = path.join(shared.root, '03-interview');
  try {
    if (!insideWorkspace(shared.root, await realpath(folder))) throw failure('DOCUMENT_OUTSIDE_WORKSPACE', '面试档案目录位于工作区外', 403);
    for (const entry of await readdir(folder, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.md')) names.add(entry.name);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ledgerArchives = new Set(parseCSV(shared.ledger.text).filter(row => materialCategory(row[7].trim()) === 'archive').map(row => JSON.stringify([row[1].trim(), row[2].trim()])));
  const targets = shared.snapshot.candidates.filter(candidate => id ? candidate.id === id : ledgerArchives.has(candidate.id) || mapped[candidate.id]?.files.some(file => (file.category ?? materialCategory(file.path, file.label)) === 'archive') || names.has(`${candidate.name}.md`));
  if (id && !targets.length) throw failure('CANDIDATE_NOT_FOUND', '当前台账中未找到这条候选记录', 404);
  const candidates = [];
  for (const candidate of targets) {
    const record = await candidateRecords(workspace, candidate.id, shared, true);
    if (record.archives.length) candidates.push({ candidate, archives: record.archives, progress: record.detail.progress });
  }
  return { status: 'ok', candidates, diagnostics: [] };
}

export async function readCandidateDetail(workspace, id) {
  return (await candidateRecords(workspace, id)).detail;
}

export async function readCandidateDocument(workspace, id, document) {
  if (typeof document !== 'string' || !/^[a-f0-9]{64}$/.test(document)) throw failure('DOCUMENT_INVALID', '附件标识无效');
  const record = await candidateRecords(workspace, id);
  const reference = record.references.find(item => item.id === document);
  if (!reference) throw failure('DOCUMENT_NOT_FOUND', '附件未关联到当前候选记录', 404);
  const file = await inspectDocument(record.root, reference);
  if (file.status !== 'ok') throw failure('DOCUMENT_UNAVAILABLE', file.message, file.status === 'missing' ? 404 : file.status === 'blocked' ? 403 : 503);
  return { document: metadata(reference, file), text: file.text, absolutePath: file.file, bytes: file.bytes };
}
