import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { decisionView } from '../decisions-domain.mjs';
import { candidateSubject } from '../model.mjs';
import { boardDirectory } from './storage.mjs';
import { listDecisions } from './decisions.mjs';
import { resolveWorkspace } from './reader.mjs';
import { readRunRecord } from './results.mjs';
import { readArchiveEvents } from './events.mjs';

const diagnostic = (code, source, message) => ({ code, source, level: 'error', message });
const unknownCounts = () => ({ open: null, snoozed: null, history: null, followUp: null });

function associate(item, runs, linkedDecision = null, previous = null) {
  const subjects = new Map(), messages = [];
  let workspace = item.context?.scope === 'workspace';
  const add = subject => { if (subject) subjects.set(JSON.stringify([subject.candidateId, subject.rawRole]), subject); };
  if (item.context?.scope === 'candidate') add(candidateSubject(item.context.candidateId));
  if (item.context?.scope === 'role') add({ candidateId: null, name: null, rawRole: item.context.role, role: item.context.role });
  add(candidateSubject(item.identity?.subjectKey ?? item.subjectKey));
  for (const source of item.sources ?? []) {
    const run = runs.get(source.runId);
    if (!run) messages.push(`来源轮次 ${source.runId} 缺失或无法读取，无法核实关联对象`);
    else if (source.resultId) {
      const result = run.results?.find(result => result.id === source.resultId);
      if (!result) messages.push(`来源结果 ${source.runId}/${source.resultId} 缺失或无法读取，无法核实关联对象`);
      else add(candidateSubject(result.candidateId));
    }
  }
  if (item.decisionId) {
    if (!linkedDecision) messages.push('关联事项缺失或无法读取，无法核实关联对象');
    else {
      linkedDecision.subjects.forEach(add);
      messages.push(...linkedDecision.associationMessages);
      workspace ||= linkedDecision.associationStatus === 'workspace';
    }
  }
  for (const id of item.sourceRunIds ?? []) if (!runs.has(id)) messages.push(`重点来源轮次 ${id} 缺失或无法读取，保留最后可信记录`);
  if (messages.length && previous?.updatedAt === item.updatedAt && previous?.revision === item.revision) {
    for (const subject of previous.subjects ?? []) add(subject);
  }
  if (workspace && subjects.size) messages.push('工作区归属与具体对象来源并存，关联范围待确认');
  if (!workspace && !subjects.size && !messages.length) messages.push('没有可核实的人选或岗位关联，关联待确认');
  return {
    ...item, subjects: [...subjects.values()],
    associationStatus: workspace && !subjects.size ? 'workspace' : subjects.size ? messages.length ? 'partial' : 'resolved' : 'unknown',
    associationMessages: [...new Set(messages)]
  };
}

function decisionPriority(item, now) {
  if (item.effectiveState === 'open') return item.blocking || (item.deadline !== null && item.deadline <= now) || (item.snoozedUntil !== null && item.snoozedUntil <= now) ? 0 : 1;
  return item.effectiveState === 'history_review' ? 2 : 3;
}

const validActivity = item => item && typeof item.candidateId === 'string' && typeof item.at === 'string'
  && Number.isFinite(Date.parse(item.at)) && ['day', 'instant'].includes(item.precision) && ['archive', 'result'].includes(item.sourceKind);

function candidateActivityIndex({ archiveHighlights, runs, previous, archiveStatus, runStatus, runsRead, now }) {
  const entries = new Map(), retained = Array.isArray(previous?.candidateActivity) ? previous.candidateActivity.filter(validActivity) : [];
  const consider = item => {
    if (!validActivity(item) || item.at > now) return;
    const current = entries.get(item.candidateId);
    if (current && item.at < current.at) return;
    if (current && item.at === current.at && current.sourceKind === 'archive' && item.sourceKind !== 'archive') return;
    if (current && item.at === current.at && current.sourceKind === item.sourceKind && current.precision === 'instant' && item.precision === 'day') return;
    entries.set(item.candidateId, item);
  };
  for (const item of archiveHighlights) {
    consider({ candidateId: item.context?.candidateId, at: item.occurredAt, precision: item.timePrecision === 'day' ? 'day' : 'instant', sourceKind: 'archive' });
  }
  for (const run of runs.values()) for (const result of run.results ?? []) consider({ candidateId: result.candidateId, at: result.updatedAt, precision: 'instant', sourceKind: 'result' });
  if (archiveStatus !== 'ok') for (const item of retained) if (item.sourceKind === 'archive') consider(item);
  if (runStatus !== 'ok') for (const item of retained) if (item.sourceKind === 'result') consider(item);
  const known = archiveStatus === 'ok' || runsRead || retained.length > 0;
  if (!known) return null;
  return [...entries.values()].sort((a, b) => b.at.localeCompare(a.at) || a.candidateId.localeCompare(b.candidateId));
}

export async function readWorkspaceOverview(workspace, previous = null, now = () => new Date().toISOString()) {
  const root = await resolveWorkspace(workspace), time = now();
  const diagnostics = [], runs = new Map();
  let decisions = null, highlights = null, decisionStatus = 'missing', runStatus = 'missing', runsRead = false;
  try {
    const directory = await boardDirectory(root, ['runtime', 'recruit-board', 'decisions']);
    const marker = await lstat(path.join(directory, '.initialized'));
    if (!marker.isFile() || marker.isSymbolicLink()) throw new Error('invalid marker');
    const data = await listDecisions(root);
    diagnostics.push(...data.diagnostics);
    decisionStatus = data.diagnostics.length ? 'error' : 'ok';
    decisions = data.items.map(item => decisionView(item, time));
  } catch (error) {
    decisionStatus = error.code === 'ENOENT' ? 'missing' : 'error';
    try {
      const base = await boardDirectory(root, ['runtime', 'recruit-board']);
      await lstat(path.join(base, '.decisions-known'));
      decisionStatus = 'error';
    } catch (markerError) { if (markerError.code !== 'ENOENT') decisionStatus = 'error'; }
    diagnostics.push(diagnostic(decisionStatus === 'missing' ? 'DECISIONS_UNREGISTERED' : 'DECISIONS_UNREADABLE', 'decisions', decisionStatus === 'missing' ? '尚未接入跨轮事项，当前事项数量未知' : '事项存储缺失或无法读取，当前事项数量未知'));
  }
  try {
    const directory = await boardDirectory(root, ['runtime', 'recruit-board', 'runs']);
    runStatus = 'ok';
    runsRead = true;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      try { runs.set(id, await readRunRecord(root, id)); }
      catch {
        runStatus = 'error';
        diagnostics.push(diagnostic('HIGHLIGHT_RUN_INVALID', 'runs', '一份轮次记录无法读取，近期重点可能不完整'));
      }
    }
  } catch (error) {
    runStatus = error.code === 'ENOENT' ? 'missing' : 'error';
    if (runStatus === 'error') diagnostics.push(diagnostic('HIGHLIGHTS_UNREADABLE', 'runs', '无法读取轮次，近期重点未知'));
  }
  if (previous?.highlights?.some(item => item.sourceRunIds.some(id => !runs.has(id)))) {
    runStatus = 'error';
    diagnostics.push(diagnostic('HIGHLIGHT_RUN_MISSING', 'runs', '近期重点的来源轮次缺失，保留最后可信记录'));
  }
  const resultTimes = new Map();
  for (const run of runs.values()) for (const result of run.results ?? []) {
    if (result.updatedAt > time) continue;
    const current = resultTimes.get(result.candidateId);
    if (!current || current < result.updatedAt) resultTimes.set(result.candidateId, result.updatedAt);
  }
  if (previous?.candidateActivity?.some(item => validActivity(item) && item.sourceKind === 'result' && (!resultTimes.has(item.candidateId) || resultTimes.get(item.candidateId) < item.at))) {
    runStatus = 'error';
    diagnostics.push(diagnostic('CANDIDATE_ACTIVITY_SOURCE_UNAVAILABLE', 'runs', '曾成功读取的人选处理记录缺失或已变化，保留最后可信进展时间'));
  }
  for (const item of decisions ?? []) {
    for (const source of item.sources) {
      const run = runs.get(source.runId);
      if (!run || (source.resultId && !run.results?.some(result => result.id === source.resultId))) {
        diagnostics.push({ ...diagnostic('DECISION_SOURCE_UNAVAILABLE', 'decisions', '事项来源轮次或结果无法核实；保留事项状态，不据此失效'), runId: source.runId });
      }
    }
  }
  let archiveStatus = 'ok', archiveHighlights = [];
  try {
    const archiveEvents = await readArchiveEvents(root);
    archiveHighlights = archiveEvents.highlights;
    diagnostics.push(...archiveEvents.diagnostics);
    if (archiveEvents.diagnostics.some(item => item.level === 'error')) archiveStatus = 'error';
  } catch (error) {
    archiveStatus = 'error';
    diagnostics.push(diagnostic('PROGRESS_SOURCE_UNAVAILABLE', 'candidate-progress', '候选进展档案无法读取，近期进展可能不完整'));
  }
  if (runStatus === 'missing' && decisionStatus === 'ok' && !archiveHighlights.length) {
    runStatus = 'error';
    diagnostics.push(diagnostic('HIGHLIGHTS_UNREADABLE', 'runs', '已接入的轮次目录缺失，近期重点未知'));
  }
  const previousArchive = previous?.highlights?.filter(item => item.sourceKind === 'archive') ?? [];
  for (const item of previousArchive) {
    if (!archiveHighlights.some(current => current.eventKey === item.eventKey && current.context.candidateId === item.context.candidateId)) {
      archiveStatus = 'error';
      diagnostics.push(diagnostic('PROGRESS_SOURCE_UNAVAILABLE', 'candidate-progress', '曾成功读取的候选进展来源缺失或已变化，保留最后可信记录'));
      archiveHighlights.push(item);
    }
  }
  if (runStatus === 'ok' || archiveHighlights.length > 0) {
    const byEvent = new Map();
    if (runStatus !== 'ok') for (const item of previous?.highlights ?? []) if (item.sourceKind !== 'archive') byEvent.set(item.eventKey, item);
    for (const run of [...runs.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      for (const highlight of run.highlights ?? []) {
        const previous = byEvent.get(highlight.eventKey);
        const sourceRunIds = [...new Set([...(previous?.sourceRunIds ?? []), run.id])];
        if (!previous || highlight.updatedAt > previous.updatedAt) byEvent.set(highlight.eventKey, { ...highlight, runId: run.id, trigger: run.trigger, sourceRunIds });
        else previous.sourceRunIds = sourceRunIds;
      }
    }
    for (const item of archiveHighlights) {
      if (item.occurredAt > time) {
        diagnostics.push(diagnostic('PROGRESS_EVENT_FUTURE', 'candidate-progress', '档案进展的发生时间在未来，未作为已发生事件显示'));
        continue;
      }
      const recorded = byEvent.get(item.eventKey);
      const previousId = recorded?.context?.candidateId;
      if (previousId && previousId !== item.context.candidateId) {
        diagnostics.push(diagnostic('PROGRESS_EVENT_CONFLICT', 'candidate-progress', '进展事件ID对应不同人选，未合并冲突记录'));
        archiveStatus = 'error';
        const separate = `${item.eventKey}:${createHash('sha256').update(item.context.candidateId).digest('hex').slice(0, 12)}`;
        byEvent.set(separate, { ...item, eventKey: separate });
        continue;
      }
      const sourceRunIds = [...new Set([...(recorded?.sourceRunIds ?? []), ...item.sourceRunIds])];
      const value = recorded && recorded.correction && recorded.updatedAt > item.updatedAt ? { ...item, ...recorded, context: item.context, details: recorded.details?.length ? recorded.details : item.details, sourceKind: 'archive', sourceDocumentId: item.sourceDocumentId, sourceDocumentLabel: item.sourceDocumentLabel, timePrecision: 'instant' } : { ...item, trigger: recorded?.trigger ?? item.trigger };
      byEvent.set(item.eventKey, { ...value, runId: recorded?.runId ?? item.runId, sourceRunIds });
    }
    const cutoff = new Date(Date.parse(time) - 7 * 86400000).toISOString();
    highlights = [...byEvent.values()].filter(item => item.timePrecision === 'day' ? item.updatedAt.slice(0, 10) >= cutoff.slice(0, 10) : item.updatedAt >= cutoff).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.eventKey.localeCompare(b.eventKey));
  }
  if (previous?.decisions && decisions && previous.decisions.some(item => !decisions.some(current => current.id === item.id))) {
    decisionStatus = 'error';
    diagnostics.push(diagnostic('DECISION_REMOVED', 'decisions', '曾成功读取的事项缺失，保留最后可信记录'));
  }
  let stale = archiveStatus === 'error' && previousArchive.length > 0, retainedDecisions = false;
  if (decisionStatus !== 'ok' && previous?.decisions !== null && previous?.decisions !== undefined) {
    decisions = previous.decisions.map(item => ({ ...item, effectiveState: item.state === 'snoozed' && item.snoozedUntil !== null && item.snoozedUntil <= time ? 'open' : item.state }));
    stale = true; retainedDecisions = true;
  }
  if ((runStatus === 'error' || runStatus === 'missing') && (previous?.highlights?.length || previous?.candidateActivity?.some(item => validActivity(item) && item.sourceKind === 'result'))) {
    highlights ??= previous.highlights;
    stale = true;
  }
  const counts = decisionStatus === 'ok' || retainedDecisions ? {
    open: decisions.filter(item => item.effectiveState === 'open').length,
    snoozed: decisions.filter(item => item.effectiveState === 'snoozed').length,
    history: decisions.filter(item => item.effectiveState === 'history_review').length,
    followUp: decisions.filter(item => item.state === 'decided' && ['pending', 'running', 'failed', 'uncertain'].includes(item.followUp.status)).length
  } : unknownCounts();
  if (decisionStatus !== 'ok' && !retainedDecisions) decisions = null;
  const previousDecisions = new Map((previous?.decisions ?? []).map(item => [item.id, item]));
  decisions = decisions?.map(item => associate(item, runs, null, previousDecisions.get(item.id))) ?? null;
  const byDecision = new Map((decisions ?? []).map(item => [item.id, item]));
  const previousHighlights = new Map((previous?.highlights ?? []).map(item => [item.eventKey, item]));
  highlights = highlights?.map(item => associate(item, runs, byDecision.get(item.decisionId), previousHighlights.get(item.eventKey))) ?? null;
  decisions?.sort((a, b) => decisionPriority(a, time) - decisionPriority(b, time) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const status = stale ? 'stale' : decisionStatus === 'error' || runStatus === 'error' || archiveStatus === 'error' || diagnostics.some(item => item.code === 'DECISION_SOURCE_UNAVAILABLE') ? 'error' : decisionStatus === 'missing' ? 'missing' : 'ok';
  const updatedAt = stale ? previous.updatedAt : [...(decisions ?? []).map(item => item.updatedAt), ...[...runs.values()].map(run => run.updatedAt), ...archiveHighlights.map(item => item.updatedAt)].sort().at(-1) ?? null;
  const candidateActivity = candidateActivityIndex({ archiveHighlights, runs, previous, archiveStatus, runStatus, runsRead, now: time });
  const revision = createHash('sha256').update(JSON.stringify({ status, decisions, highlights, candidateActivity, counts, diagnostics })).digest('hex');
  return { status, updatedAt, revision, decisions, highlights, candidateActivity, counts, diagnostics };
}

export function overviewSummary(overview) {
  const { decisions, highlights, candidateActivity, ...summary } = overview;
  return summary;
}
