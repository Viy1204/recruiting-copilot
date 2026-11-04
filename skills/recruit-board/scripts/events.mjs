import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRunId } from '../model.mjs';
import { readCandidateArchives } from './records.mjs';
import { resolveWorkspace, insideWorkspace, MAX_FILE_BYTES } from './reader.mjs';
import { boardDirectory, withItemLock } from './storage.mjs';

const columns = ['事件ID', '发生时间', '类型', '事实', '依据', '预约时段', '面试官', '来源任务'];
const header = '\n## 进展记录\n\n| ' + columns.join(' | ') + ' |\n|' + columns.map(() => '---').join('|') + '|\n';
const failure = (code, message, status = 422) => Object.assign(new Error(message), { code, status });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value === '—' || value === '-' ? '' : value.trim();
const cells = line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(value => plain(value.trim().replace(/\\\|/g, '|')));
const cell = value => (value ?? '').replace(/\|/g, '\\|') || '—';

function eventTime(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(value + 'T00:00:00.000Z');
    if (date.toISOString().slice(0, 10) !== value) throw failure('PROGRESS_EVENT_INVALID', '事件日期无效');
    return { occurredAt: date.toISOString(), timePrecision: 'day' };
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw failure('PROGRESS_EVENT_INVALID', '事件发生时间须为日期或含时区的 ISO 时间');
  return { occurredAt: new Date(value).toISOString(), timePrecision: 'instant' };
}

function validateEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['eventKey', 'occurredAt', 'type', 'text', 'evidence', 'slot', 'interviewer', 'runId'].includes(key))) throw failure('PROGRESS_EVENT_INVALID', '进展事件字段无效');
  const limits = { eventKey: 200, type: 80, text: 300, evidence: 300, slot: 300, interviewer: 300 };
  for (const [key, limit] of Object.entries(limits)) {
    const field = value[key];
    if ((['slot', 'interviewer'].includes(key) && field == null)) continue;
    if (typeof field !== 'string' || !field.trim() || field !== field.trim() || field.length > limit || /[\x00-\x1f]/.test(field)) throw failure('PROGRESS_EVENT_INVALID', `进展事件 ${key} 必须为有限单行文本`);
  }
  if (value.runId != null) assertRunId(value.runId);
  return { ...value, ...eventTime(value.occurredAt), type: value.type, slot: value.slot ?? '', interviewer: value.interviewer ?? '', runId: value.runId ?? null };
}

export function parseArchiveEvents(text) {
  const events = [], diagnostics = [], keys = new Set();
  let active = false, indexes = null;
  for (const [number, line] of text.split(/\r?\n/).entries()) {
    const heading = /^(#{1,2})\s+(.+)$/.exec(line);
    if (heading) { active = heading[2].trim() === '进展记录'; indexes = null; continue; }
    if (!active || !line.trim().startsWith('|')) continue;
    const row = cells(line);
    if (columns.every(name => row.includes(name))) { indexes = columns.map(name => row.indexOf(name)); continue; }
    if (!indexes || row.every(value => /^:?-{3,}:?$/.test(value))) continue;
    if (row.every(value => !value) || row.some(value => /〔|〕/.test(value))) continue;
    const [eventKey, occurredAt, type, fact, evidence, slot, interviewer, runId] = indexes.map(index => row[index] ?? '');
    try {
      const event = validateEvent({ eventKey, occurredAt, type, text: fact, evidence, slot: slot || undefined, interviewer: interviewer || undefined, runId: runId || undefined });
      if (keys.has(eventKey)) throw failure('PROGRESS_EVENT_CONFLICT', '同一档案事件ID重复');
      keys.add(eventKey); events.push({ ...event, line: number + 1 });
    } catch (error) { diagnostics.push({ code: 'PROGRESS_EVENT_INVALID', message: `进展记录第 ${number + 1} 行无效：${error.message}` }); }
  }
  return { events, diagnostics };
}

export async function readArchiveEvents(workspace) {
  const records = await readCandidateArchives(workspace), highlights = [], diagnostics = [];
  for (const { candidate, archives, progress } of records.candidates) {
    const candidateEvents = [];
    for (const { document, text } of archives) {
      if (document.status !== 'ok' || text === null) {
        diagnostics.push({ code: 'PROGRESS_SOURCE_UNAVAILABLE', source: 'candidate-progress', level: 'error', message: '已关联面试档案无法读取，近期进展可能不完整', candidateId: candidate.id }); continue;
      }
      const parsed = parseArchiveEvents(text);
      diagnostics.push(...parsed.diagnostics.map(item => ({ ...item, source: 'candidate-progress', level: 'error', candidateId: candidate.id })));
      for (const event of parsed.events) {
        candidateEvents.push(event);
        const details = [{ label: '进展', value: event.type }];
        if (event.slot) details.push({ label: '预约时段', value: event.slot });
        if (event.interviewer) details.push({ label: '面试官', value: event.interviewer });
        highlights.push({ eventKey: event.eventKey, text: event.text, evidence: event.evidence, occurredAt: event.occurredAt, updatedAt: event.occurredAt, timePrecision: event.timePrecision, context: { scope: 'candidate', candidateId: candidate.id }, details, subjectKey: candidate.id, decisionId: null, correction: null, runId: event.runId, sourceRunIds: event.runId ? [event.runId] : [], trigger: 'unknown', sourceKind: 'archive', sourceDocumentId: document.id, sourceDocumentLabel: document.label });
      }
    }
    const slotKey = value => (value ?? '').replace(/[（(](?:Asia\/Shanghai|UTC\+08:00|北京时间)[）)]/g, '').replace(/\s/g, '').replace(/[–—~～至]/g, '-');
    for (const record of progress.records) for (const interview of record.interviews) {
      const status = interview.status ?? '';
      if (/未发|待发|计划|拟发|预计|取消|改期/.test(status)) continue;
      const date = /(?:邀约|邀请)[^\n]*?(\d{4}-\d{2}-\d{2})[^\n]*?(?:发出|发送|送达)/.exec(status)?.[1];
      if (!date || !interview.time || candidateEvents.some(event => slotKey(event.slot) === slotKey(interview.time))) continue;
      const eventKey = 'interview-' + hash(JSON.stringify([candidate.id, interview.time, '邀约已发'])).slice(0, 48);
      const event = { eventKey, ...eventTime(date), type: '邀约已发', text: `${interview.round || '面试'}已安排，候选人邀约已发出`, evidence: `原面试安排表明确记录：${status}`, slot: interview.time, interviewer: interview.interviewers ?? '' };
      candidateEvents.push(event);
      const details = [{ label: '进展', value: event.type }, { label: '预约时段', value: interview.time }];
      if (interview.interviewers) details.push({ label: '面试官', value: interview.interviewers });
      highlights.push({ eventKey, text: event.text, evidence: event.evidence, occurredAt: event.occurredAt, updatedAt: event.occurredAt, timePrecision: 'day', context: { scope: 'candidate', candidateId: candidate.id }, details, subjectKey: candidate.id, decisionId: null, correction: null, runId: null, sourceRunIds: [], trigger: 'unknown', sourceKind: 'archive', sourceDocumentId: record.documentId, sourceDocumentLabel: record.label, recovered: true });
    }
    const uncovered = progress.records.flatMap(item => item.interviews).some(interview => !candidateEvents.some(event => slotKey(event.slot) === slotKey(interview.time) && (!/取消/.test(interview.status ?? '') || /取消/.test(event.type)) && (!/改期/.test(interview.status ?? '') || /改期/.test(event.type))));
    if (uncovered) diagnostics.push({ code: 'PROGRESS_EVENT_MISSING', source: 'candidate-progress', level: 'warning', message: '已关联档案有面试安排或变更，但缺少对应时段、带实际发生日期的进展事件，请核对后补录', candidateId: candidate.id });
  }
  return { status: records.status, highlights, diagnostics };
}

export async function recordCandidateEvent({ workspace, candidateId, documentId, event }, now = () => new Date().toISOString()) {
  const root = await resolveWorkspace(workspace), requested = validateEvent(event);
  if (!/^[a-f0-9]{64}$/.test(documentId ?? '')) throw failure('PROGRESS_EVENT_INVALID', '必须指定已关联面试档案的资源 ID');
  const currentTime = now();
  if (requested.timePrecision === 'day' ? requested.occurredAt.slice(0, 10) > currentTime.slice(0, 10) : requested.occurredAt > currentTime) throw failure('PROGRESS_EVENT_INVALID', '不能将未来预约时段作为已发生的进展');
  const directory = await boardDirectory(root, ['runtime', 'recruit-board', 'events'], true);
  return withItemLock(directory, 'archives', async () => {
    const linked = await readCandidateArchives(root, candidateId);
    const source = linked.candidates[0]?.archives.find(item => item.document.id === documentId);
    if (!source || source.document.status !== 'ok' || source.document.kind !== 'markdown') throw failure('PROGRESS_SOURCE_UNAVAILABLE', '只能写入已核实关联且可读取的 Markdown 面试档案');
    const parsed = parseArchiveEvents(source.text);
    if (parsed.diagnostics.length) throw failure('PROGRESS_EVENT_INVALID', '原进展表存在无效记录，请先核对');
    const previous = parsed.events.find(item => item.eventKey === requested.eventKey);
    const content = value => JSON.stringify(['eventKey', 'occurredAt', 'timePrecision', 'type', 'text', 'evidence', 'slot', 'interviewer', 'runId'].map(key => value[key]));
    if (previous) {
      if (content(previous) !== content(requested)) throw failure('PROGRESS_EVENT_CONFLICT', '已有事件内容冲突，请使用新的更正事件并注明原事件依据', 409);
      return { changed: false, eventKey: requested.eventKey, documentId, candidateId };
    }
    const relative = source.document.path;
    const file = path.join(root, relative), resolved = await realpath(file), info = await lstat(file);
    if (!insideWorkspace(root, resolved) || !info.isFile() || info.isSymbolicLink()) throw failure('PROGRESS_SOURCE_UNAVAILABLE', '面试档案必须是工作区内普通文件');
    const before = await readFile(file);
    const encoding = before[0] === 0xff && before[1] === 0xfe ? 'utf-16le' : before[0] === 0xfe && before[1] === 0xff ? 'utf-16be' : 'utf-8';
    if (encoding !== 'utf-8') throw failure('PROGRESS_SOURCE_UNAVAILABLE', '事件写入暂要求 UTF-8 档案，未覆盖原文件编码');
    if (new TextDecoder('utf-8', { fatal: true }).decode(before) !== source.text) throw failure('PROGRESS_EVENT_CONFLICT', '面试档案在读取后已变化，请重新核对', 409);
    const line = '| ' + [requested.eventKey, requested.timePrecision === 'day' ? requested.occurredAt.slice(0, 10) : requested.occurredAt, requested.type, requested.text, requested.evidence, requested.slot, requested.interviewer, requested.runId].map(cell).join(' | ') + ' |\n';
    let next;
    if (/^##\s+进展记录\s*$/m.test(source.text)) {
      const match = /^##\s+进展记录\s*$/m.exec(source.text), start = match.index + match[0].length;
      const tail = source.text.slice(start), following = /^#{1,2}\s+/m.exec(tail), end = following ? start + following.index : source.text.length;
      const tableHeader = tail.slice(0, end - start).split(/\r?\n/).find(value => value.trim().startsWith('|') && cells(value).includes('事件ID'));
      if (!tableHeader || JSON.stringify(cells(tableHeader)) !== JSON.stringify(columns)) throw failure('PROGRESS_EVENT_INVALID', '进展记录标题下须为约定顺序的表头，未自动覆盖');
      next = source.text.slice(0, end).replace(/\s*$/, '\n') + line + '\n' + source.text.slice(end);
    } else next = source.text.replace(/\s*$/, '\n') + header + line;
    if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw failure('PROGRESS_EVENT_INVALID', '面试档案超过大小上限');
    const backup = path.join(directory, hash(candidateId).slice(0, 16) + '-' + randomUUID() + '.md');
    await writeExclusive(backup, before);
    const temporary = path.join(path.dirname(file), '.event-' + randomUUID() + '.tmp');
    try {
      await writeExclusive(temporary, Buffer.from(next));
      if (hash(await readFile(file)) !== hash(before)) throw failure('PROGRESS_EVENT_CONFLICT', '面试档案在写入前已变化，请重新核对', 409);
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    return { changed: true, eventKey: requested.eventKey, documentId, candidateId, backup: path.relative(root, backup).split(path.sep).join('/') };
  });
}

async function writeExclusive(file, bytes) {
  const handle = await open(file, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export async function eventsCLI(args) {
  const [command, ...flags] = args;
  if (command !== 'record' || flags.length !== 4) throw failure('PROGRESS_EVENT_INVALID', '用法：events.mjs record --workspace <目录> --input-file <事件JSON>');
  const values = {};
  for (let i = 0; i < flags.length; i += 2) {
    const name = flags[i].replace(/^--/, '');
    if (!['workspace', 'input-file'].includes(name) || values[name] || !flags[i + 1]) throw failure('PROGRESS_EVENT_INVALID', '事件命令参数无效');
    values[name] = flags[i + 1];
  }
  if (!values.workspace || !values['input-file']) throw failure('PROGRESS_EVENT_INVALID', '缺少工作区或事件输入文件');
  const root = await resolveWorkspace(values.workspace), file = await realpath(path.resolve(values['input-file']));
  const info = await lstat(file);
  if (!insideWorkspace(root, file) || !info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw failure('PROGRESS_EVENT_INVALID', '事件输入须为工作区内的普通 JSON 文件');
  const input = JSON.parse(await readFile(file, 'utf8'));
  return recordCandidateEvent({ ...input, workspace: root });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await eventsCLI(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({ error: { code: error.code ?? 'PROGRESS_EVENT_FAILED', message: error.message } }) + '\n'); process.exitCode = 1; }
}
