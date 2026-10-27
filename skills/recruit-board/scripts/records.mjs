import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot, parseCSV, readConfig, readRoles } from '../model.mjs';
import { insideWorkspace, MAX_FILE_BYTES, readSource, resolveWorkspace } from './reader.mjs';

const MAX_PDF_BYTES = 24 * 1024 * 1024;
const MAX_DOCUMENTS = 30;
const kinds = { '.md': 'markdown', '.txt': 'text', '.pdf': 'pdf' };
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const documentId = (candidate, reference) => createHash('sha256').update(JSON.stringify([candidate, reference])).digest('hex');

function candidateKey(value) {
  let key;
  try { key = JSON.parse(value); } catch { throw failure('CANDIDATE_INVALID', '候选记录标识无效'); }
  if (!Array.isArray(key) || key.length !== 2 || key.some(item => typeof item !== 'string' || !item.trim() || item !== item.trim()) || JSON.stringify(key) !== value || value.length > 4096) throw failure('CANDIDATE_INVALID', '候选记录标识无效');
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

async function inspectDocument(root, reference) {
  let handle;
  try {
    const file = resolveReference(root, reference.path, reference.base);
    const kind = kinds[path.extname(file).toLowerCase()] ?? 'unsupported';
    if (kind === 'unsupported' || (reference.kind && reference.kind !== kind)) return { file: null, kind, status: 'blocked', message: '仅支持 Markdown、TXT 和 PDF，文件类型须与扩展名一致', size: null };
    const resolved = await realpath(file);
    if (!insideWorkspace(root, resolved)) throw failure('DOCUMENT_OUTSIDE_WORKSPACE', '文件指向工作区外，未开放读取', 403);
    if (kinds[path.extname(resolved).toLowerCase()] !== kind) throw failure('DOCUMENT_PATH_BLOCKED', '附件链接的实际文件类型不一致，未开放读取', 403);
    handle = await open(resolved, 'r');
    const info = await handle.stat();
    const limit = kind === 'pdf' ? MAX_PDF_BYTES : MAX_FILE_BYTES;
    if (!info.isFile() || info.size > limit) return { file: null, kind, status: 'blocked', message: '附件不是普通文件或超过读取上限', size: info.size };
    const bytes = await handle.readFile();
    if (bytes.length > limit) return { file: null, kind, status: 'blocked', message: '附件超过读取上限', size: bytes.length };
    let text = null;
    if (kind === 'pdf') {
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return { file: null, kind, status: 'blocked', message: '附件不是有效的 PDF 文件', size: bytes.length };
    } else {
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
      try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
      catch { return { file: null, kind, status: 'blocked', message: '文本编码无法安全读取，支持 UTF-8 或带 BOM 的 UTF-16', size: bytes.length }; }
    }
    return { file: resolved, kind, status: 'ok', message: null, size: bytes.length, bytes, text };
  } catch (error) {
    const status = error.code === 'ENOENT' ? 'missing' : error.status === 403 ? 'blocked' : 'error';
    return { file: null, kind: kinds[path.extname(referencePath(reference.path)).toLowerCase()] ?? 'unsupported', status, message: status === 'missing' ? '台账或映射指向的文件不存在' : status === 'blocked' ? error.message : '附件无法读取', size: null };
  } finally { if (handle) await handle.close(); }
}

function explicitFiles(text, id) {
  let value;
  try { value = JSON.parse(text.replace(/^﻿/, '')); } catch { throw failure('FILES_CONFIG_INVALID', '资料映射不是有效 JSON'); }
  const object = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  if (!object(value) || value.schemaVersion !== 1 || !object(value.candidates) || Object.keys(value).some(key => !['schemaVersion', 'candidates'].includes(key))) throw failure('FILES_CONFIG_INVALID', '资料映射版本或字段无效');
  for (const [key, entry] of Object.entries(value.candidates)) {
    candidateKey(key);
    if (!object(entry) || Object.keys(entry).some(field => field !== 'files') || !Array.isArray(entry.files) || entry.files.length > MAX_DOCUMENTS) throw failure('FILES_CONFIG_INVALID', '资料映射的 files 必须是有限文件列表');
    for (const file of entry.files) {
      if (!object(file) || Object.keys(file).some(field => !['path', 'label', 'kind'].includes(field)) || typeof file.path !== 'string' || !file.path.trim() || file.path.length > 4096 || (file.label !== undefined && (typeof file.label !== 'string' || !file.label.trim() || file.label.length > 300)) || (file.kind !== undefined && !['markdown', 'text', 'pdf'].includes(file.kind))) throw failure('FILES_CONFIG_INVALID', '资料映射包含无效路径、标题或文件类型');
    }
  }
  return Object.hasOwn(value.candidates, id) ? value.candidates[id].files : [];
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

async function candidateRecords(workspace, id) {
  const [name, rawRole] = candidateKey(id);
  const root = await resolveWorkspace(workspace);
  const [ledger, context, configSource, filesSource] = await Promise.all([
    readSource(root, '02-sourcing/dedup-ledger.csv'), readSource(root, 'CONTEXT.md'), readSource(root, '_shared/recruit-board.config.json'), readSource(root, '_shared/recruit-board.files.json')
  ]);
  const snapshot = buildSnapshot({ workspace: path.basename(root), generatedAt: new Date().toISOString(), ledger, context, config: configSource, runFiles: { status: 'missing' } });
  if (!snapshot.candidates) throw failure('CANDIDATE_SOURCE_ERROR', '候选台账无法读取，请恢复后重试', 503);
  if (snapshot.sources.config.status === 'error') throw failure('CANDIDATE_CONFIG_ERROR', '兼容配置无效，无法确认候选资料归属', 503);
  const candidate = snapshot.candidates.find(item => item.id === id);
  if (!candidate) throw failure('CANDIDATE_NOT_FOUND', '当前台账中未找到这条候选记录', 404);
  const rows = parseCSV(ledger.text).filter(row => row[1].trim() === name && row[2].trim() === rawRole);
  const warnings = [], references = [];
  const addReference = (file, base, label, kind) => {
    if (references.length >= MAX_DOCUMENTS) { if (!warnings.includes('文件关联超过上限，仅显示前 30 份')) warnings.push('文件关联超过上限，仅显示前 30 份'); return; }
    const reference = { path: file, base, label: label || path.basename(referencePath(file).replace(/\\/g, '/')), kind };
    const key = JSON.stringify([base, referencePath(file)]);
    if (!references.some(item => item.key === key)) references.push({ ...reference, key, id: documentId(id, key) });
  };
  const resumePaths = [...new Set(rows.map(row => row[7].trim()).filter(Boolean))];
  for (const file of resumePaths) addReference(file, root);
  if (!resumePaths.length) warnings.push('台账未填写简历路径');
  if (filesSource.status === 'ok') {
    try { for (const file of explicitFiles(filesSource.text, id)) addReference(file.path, root, file.label, file.kind); }
    catch (error) { warnings.push(error.message); }
  } else if (filesSource.status === 'error') warnings.push('资料映射文件无法读取，未应用显式关联');
  const uniqueName = snapshot.candidates.filter(item => item.name === name).length === 1;
  const plainName = !/[\s*＊xX×某〇○?？<>《》〔〕\[\]\\/:]/.test(name) && !/(?:先生|女士|小姐|同学|老师)$/.test(name);
  if (plainName && uniqueName) {
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
        addReference(archive, root, '面试档案', 'markdown');
        for (const link of markdownLinks(source.text)) {
          if (!link.file.startsWith('#')) addReference(link.file, path.join(root, '03-interview'), link.label);
        }
      } else warnings.push('同名档案的姓名或岗位无法唯一核对，未自动关联；可在资料映射中明确指定');
    } else if (source.status === 'error') warnings.push('同名面试档案无法读取，未自动关联');
  } else warnings.push(uniqueName ? '称谓或打码姓名不自动匹配面试档案，可使用显式资料映射' : '同名跨原岗位记录未自动关联面试档案，可使用显式资料映射');
  const documents = [];
  for (const reference of references) {
    const inspected = await inspectDocument(root, reference);
    documents.push({ id: reference.id, label: reference.label, kind: inspected.kind, status: inspected.status, message: inspected.message, size: inspected.size });
  }
  if (candidate.conflict) warnings.push('同一原人岗记录存在状态或评级冲突，详情保留各条台账文本');
  return { root, references, detail: {
    candidate: { id: candidate.id, name: candidate.name, rawRole: candidate.rawRole, role: candidate.role, rawStatus: candidate.rawStatus, rating: candidate.rating },
    background: uniqueText(rows, 3), notes: uniqueText(rows, 8), sourceRound: uniqueText(rows, 6), documents, warnings
  } };
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
  return { document: { id: reference.id, label: reference.label, kind: file.kind, status: 'ok', message: null, size: file.size }, text: file.text, absolutePath: file.file, bytes: file.bytes };
}
