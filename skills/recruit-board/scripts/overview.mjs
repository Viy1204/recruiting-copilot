import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { decisionView } from '../decisions-domain.mjs';
import { candidateSubject } from '../model.mjs';
import { boardDirectory } from './storage.mjs';
import { listDecisions } from './decisions.mjs';
import { resolveWorkspace } from './reader.mjs';
import { readRunRecord } from './results.mjs';

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

export async function readWorkspaceOverview(workspace, previous = null, now = () => new Date().toISOString()) {
  const root = await resolveWorkspace(workspace), time = now();
  const diagnostics = [], runs = new Map();
  let decisions = null, highlights = null, decisionStatus = 'missing', runStatus = 'missing';
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
  if (runStatus === 'missing' && decisionStatus === 'ok') {
    runStatus = 'error';
    diagnostics.push(diagnostic('HIGHLIGHTS_UNREADABLE', 'runs', '已接入的轮次目录缺失，近期重点未知'));
  }
  for (const item of decisions ?? []) {
    for (const source of item.sources) {
      const run = runs.get(source.runId);
      if (!run || (source.resultId && !run.results?.some(result => result.id === source.resultId))) {
        diagnostics.push({ ...diagnostic('DECISION_SOURCE_UNAVAILABLE', 'decisions', '事项来源轮次或结果无法核实；保留事项状态，不据此失效'), runId: source.runId });
      }
    }
  }
  if (runStatus === 'ok') {
    const byEvent = new Map();
    for (const run of [...runs.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      for (const highlight of run.highlights ?? []) {
        const previous = byEvent.get(highlight.eventKey);
        const sourceRunIds = [...new Set([...(previous?.sourceRunIds ?? []), run.id])];
        if (!previous || highlight.updatedAt > previous.updatedAt) byEvent.set(highlight.eventKey, { ...highlight, runId: run.id, trigger: run.trigger, sourceRunIds });
        else previous.sourceRunIds = sourceRunIds;
      }
    }
    const cutoff = new Date(Date.parse(time) - 7 * 86400000).toISOString();
    highlights = [...byEvent.values()].filter(item => item.updatedAt >= cutoff).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.eventKey.localeCompare(b.eventKey));
  }
  if (previous?.decisions && decisions && previous.decisions.some(item => !decisions.some(current => current.id === item.id))) {
    decisionStatus = 'error';
    diagnostics.push(diagnostic('DECISION_REMOVED', 'decisions', '曾成功读取的事项缺失，保留最后可信记录'));
  }
  let stale = false, retainedDecisions = false;
  if (decisionStatus !== 'ok' && previous?.decisions !== null && previous?.decisions !== undefined) {
    decisions = previous.decisions.map(item => ({ ...item, effectiveState: item.state === 'snoozed' && item.snoozedUntil !== null && item.snoozedUntil <= time ? 'open' : item.state }));
    stale = true; retainedDecisions = true;
  }
  if ((runStatus === 'error' || runStatus === 'missing') && previous?.highlights?.length) {
    highlights = previous.highlights;
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
  const status = stale ? 'stale' : decisionStatus === 'error' || runStatus === 'error' || diagnostics.some(item => item.code === 'DECISION_SOURCE_UNAVAILABLE') ? 'error' : decisionStatus === 'missing' ? 'missing' : 'ok';
  const updatedAt = stale ? previous.updatedAt : [...(decisions ?? []).map(item => item.updatedAt), ...[...runs.values()].map(run => run.updatedAt)].sort().at(-1) ?? null;
  const revision = createHash('sha256').update(JSON.stringify({ status, decisions, highlights, counts, diagnostics })).digest('hex');
  return { status, updatedAt, revision, decisions, highlights, counts, diagnostics };
}

export function overviewSummary(overview) {
  const { decisions, highlights, ...summary } = overview;
  return summary;
}
