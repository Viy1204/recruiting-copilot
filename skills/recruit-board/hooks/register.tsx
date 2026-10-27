import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, Timer } from 'claude-code';
import type { BoardSnapshot, CandidateDetail, DocumentContent, RecruitingBoardPanel, RecruitingBoardState, RoleInfo, RoleSetResult, RunActivity, RunResult, RunResults, RunSummary } from '../types';
import { assertRunId, buildSnapshot, candidateStatus, ROLE_SCOPES, RUN_LABELS, runSummary, selectRoles, selectTask, STEP_LABELS } from '../model.mjs';

const PANE = 'recruiting-board';
type Selection = RecruitingBoardState['selection'];
type PreferenceChange = { kind: 'scope'; value: Selection['scope'] } | { kind: 'role'; value: string } | { kind: 'following'; value: string };
type ResultsPanel = Extract<RecruitingBoardPanel, { kind: 'results' }>;
const initial: RecruitingBoardState = { snapshot: null, panel: null, error: null, workspaceRoot: null, selection: { scope: 'active', following: [], role: '', query: '', editor: null, message: null }, taskSelection: { mode: 'live', runId: null }, activity: null, confirmations: null, stage: null, sessionId: null, showRecords: false, showStages: false, showSteps: false, showDetails: false };
const board = atom({ plugin: 'recruiting-board', key: 'board' } as const, initial);
const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知';
const within = (root: string, target: string) => {
  const base = root.replace(/\\/g, '/').replace(/\/$/, '');
  const path = target.replace(/\\/g, '/');
  return path === base || path.startsWith(`${base}/`);
};
type Source = { status: 'ok' | 'missing' | 'error'; text?: string; updatedAt?: string };
let timer: Timer | null = null;
let refreshing: { workspaceRoot: string; id: number } | null = null;
let root: string | null = null;
let requestSequence = 0;
let openingSequence = 0;

type ActionResults = {
  candidate: CandidateDetail;
  document: DocumentContent;
  'open-document': { opened: boolean; message: string };
  'role-info': RoleInfo;
  'role-set': RoleSetResult;
  'run-results': RunResults;
  'run-activity': RunActivity;
};
const documentStatuses = { ok: '可查看', missing: '文件缺失', blocked: '未开放', error: '读取失败' };
const messageOf = (error: unknown) => error instanceof Error ? error.message : '本地资料操作失败，请恢复后重试。';

function elementKey(prefix: string, id: string) {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < id.length; index++) hash = BigInt.asUintN(64, (hash ^ BigInt(id.charCodeAt(index))) * 0x100000001b3n);
  return `${prefix}-${hash.toString(16)}`;
}

async function action<A extends keyof ActionResults>($: EngineInterface, workspaceRoot: string, command: A, args: string[] = []): Promise<ActionResults[A]> {
  const result = await $.process.run(['node', `${$.plugin.root}/scripts/actions.mjs`, command, '--workspace', workspaceRoot, ...args], { cwd: $.plugin.root, timeoutMs: 30000 });
  if (result.isStdoutTruncated || result.isStderrTruncated) throw new Error('本地操作结果超过读取上限。');
  if (result.exitCode !== 0) {
    let error: { code?: string; message?: string } | undefined;
    try { error = JSON.parse(result.stderr).error; }
    catch { throw new Error('无法运行本地资料操作，请检查 Node.js 和工作区文件。'); }
    throw new Error(typeof error?.message === 'string' ? `${error.code ?? 'ACTION_FAILED'}：${error.message}` : '本地资料操作失败，请检查工作区文件。');
  }
  try { return JSON.parse(result.stdout) as ActionResults[A]; }
  catch { throw new Error('本地操作返回了无法读取的结果，请重试。'); }
}

function preferences(value: unknown, role = ''): Selection {
  const saved = value !== null && typeof value === 'object' ? value as Partial<Selection> : {};
  return {
    scope: saved.scope === 'following' || saved.scope === 'all' ? saved.scope : 'active',
    following: Array.isArray(saved.following) ? [...new Set(saved.following.filter((name): name is string => typeof name === 'string' && name.length > 0))] : [],
    role: typeof saved.role === 'string' ? saved.role : role,
    query: '', editor: null, message: null
  };
}

function preferenceKey(workspaceRoot: string) {
  return `role-preferences:${workspaceRoot}`;
}

function savedPreferences(selection: Selection) {
  return { scope: selection.scope, following: selection.following, role: selection.role };
}

const savingPreferences = new Set<string>();
async function persistPreferences($: EngineInterface, workspaceRoot: string) {
  if (savingPreferences.has(workspaceRoot)) return;
  savingPreferences.add(workspaceRoot);
  try {
    while (true) {
      const held = await read($, board);
      if (held.workspaceRoot !== workspaceRoot) return;
      const saved = savedPreferences(held.selection);
      await $.store.set(preferenceKey(workspaceRoot), saved);
      const current = await read($, board);
      if (current.workspaceRoot !== workspaceRoot || JSON.stringify(savedPreferences(current.selection)) === JSON.stringify(saved)) return;
    }
  } catch {
    await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot ? current : ({ ...current, selection: { ...current.selection, message: '个人岗位选择暂未保存，当前筛选仍有效；下次调整会重试保存。' } }));
  } finally { savingPreferences.delete(workspaceRoot); }
}

async function changePreference($: EngineInterface, change: PreferenceChange) {
  const held = await read($, board);
  if (!held.workspaceRoot) return;
  const workspaceRoot = held.workspaceRoot;
  await update($, board, (current): RecruitingBoardState => {
    if (current.workspaceRoot !== workspaceRoot) return current;
    const selection = current.selection;
    if (change.kind === 'scope') return { ...current, selection: { ...selection, scope: change.value, role: '', message: null } };
    if (change.kind === 'role') return { ...current, selection: { ...selection, role: change.value, message: null } };
    return { ...current, selection: { ...selection, following: selection.following.includes(change.value) ? selection.following.filter(name => name !== change.value) : [...selection.following, change.value], message: null } };
  });
  await persistPreferences($, workspaceRoot);
}

function resultRevision(run: RunSummary | undefined) {
  return run ? run.resultSummary?.revision ?? 0 : null;
}

function withSnapshot(current: RecruitingBoardState, snapshot: BoardSnapshot): RecruitingBoardState {
  const hold = current.panel !== null || current.showRecords || current.showDetails || current.selection.editor !== null;
  const task = selectTask(snapshot.runs, current.taskSelection, hold);
  const taskSelection = hold && task.newerRunId && task.selection.mode === 'live' ? { ...task.selection, mode: 'pinned' as const } : task.selection;
  return { ...current, snapshot, error: null, taskSelection, activity: current.activity?.runId === taskSelection.runId ? current.activity : null, confirmations: task.run && current.confirmations?.runId === taskSelection.runId ? current.confirmations : null };
}

async function loadActivity($: EngineInterface, force = false) {
  const held = await read($, board);
  const runId = held.taskSelection.runId;
  const run = held.snapshot?.runs?.find(run => run.id === runId);
  if (!held.workspaceRoot || !run || root !== held.workspaceRoot) return;
  const workspaceRoot = held.workspaceRoot;
  const revision = resultRevision(run);
  if (!force && held.activity?.runId === run.id && held.activity.revision !== null && revision !== null && held.activity.revision >= revision) return;
  const requestId = ++requestSequence;
  await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.taskSelection.runId !== run.id ? current : ({ ...current, activity: { requestId, runId: run.id, revision, status: 'loading', data: current.activity?.runId === run.id ? current.activity.data : null, message: null } }));
  try {
    const data = await action($, workspaceRoot, 'run-activity', ['--run', run.id]);
    if (data.runId !== run.id || revision !== null && data.revision < revision) throw new Error('动态不属于当前任务版本，请重新读取。');
    await update($, board, (current): RecruitingBoardState => root !== workspaceRoot || current.workspaceRoot !== workspaceRoot || current.taskSelection.runId !== run.id || current.activity?.requestId !== requestId || resultRevision(current.snapshot?.runs?.find(run => run.id === runId)) !== revision ? current : ({ ...current, activity: { ...current.activity, revision: data.revision, status: 'ready', data, message: null } }));
  } catch (error) {
    await update($, board, (current): RecruitingBoardState => root !== workspaceRoot || current.workspaceRoot !== workspaceRoot || current.taskSelection.runId !== run.id || current.activity?.requestId !== requestId || resultRevision(current.snapshot?.runs?.find(run => run.id === runId)) !== revision ? current : ({ ...current, activity: { ...current.activity, status: current.activity.data ? 'stale' : 'error', message: `最近动态读取失败：${messageOf(error)}` } }));
  }
}

function taskOptions(runs: RunSummary[], selected: string | null) {
  const labels = runs.map(run => `${run.label}${run.role ? ` · ${run.role}` : ''} · ${RUN_LABELS[run.status]}`);
  const options = runs.map((run, index) => ({ value: run.id, label: `${labels[index]}${labels.filter(label => label === labels[index]).length > 1 ? ` · ${new Date(run.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}` : ''}` }));
  if (selected && !runs.some(run => run.id === selected)) options.unshift({ value: selected, label: '所选任务记录已移除' });
  return options;
}

function groupResults(results: RunResult[]) {
  const groups = new Map<string, { candidateId: string; name: string; rawRole: string; attention: RunResult['attention']; updatedAt: string; results: RunResult[] }>();
  const order = { decision: 0, notice: 1, none: 2 };
  for (const result of results) {
    let group = groups.get(result.candidateId);
    if (!group) {
      const [name, rawRole] = JSON.parse(result.candidateId) as [string, string];
      group = { candidateId: result.candidateId, name, rawRole, attention: 'none', updatedAt: result.updatedAt, results: [] };
      groups.set(result.candidateId, group);
    }
    if (order[result.attention] < order[group.attention]) group.attention = result.attention;
    if (result.updatedAt > group.updatedAt) group.updatedAt = result.updatedAt;
    group.results.unshift(result);
  }
  for (const group of groups.values()) group.results.sort((a, b) => order[a.attention] - order[b.attention] || b.updatedAt.localeCompare(a.updatedAt));
  return [...groups.values()].sort((a, b) => order[a.attention] - order[b.attention] || b.updatedAt.localeCompare(a.updatedAt));
}

async function loadConfirmations($: EngineInterface, force = false) {
  const held = await read($, board);
  const run = held.snapshot?.runs?.find(run => run.id === held.taskSelection.runId);
  if (!held.workspaceRoot || !run || root !== held.workspaceRoot) return;
  const workspaceRoot = held.workspaceRoot;
  const revision = resultRevision(run);
  if (!force && held.confirmations?.runId === run.id && held.confirmations.revision === revision) return;
  const requestId = ++requestSequence;
  await update($, board, (current): RecruitingBoardState => root !== workspaceRoot || current.workspaceRoot !== workspaceRoot || current.taskSelection.runId !== run.id || resultRevision(current.snapshot?.runs?.find(item => item.id === run.id)) !== revision ? current : ({ ...current, confirmations: { requestId, runId: run.id, revision, status: 'loading', data: current.confirmations?.runId === run.id ? current.confirmations.data : null, error: null } }));
  const active = await read($, board);
  if (root !== workspaceRoot || active.workspaceRoot !== workspaceRoot || active.taskSelection.runId !== run.id || active.confirmations?.requestId !== requestId || resultRevision(active.snapshot?.runs?.find(item => item.id === run.id)) !== revision) return;
  try {
    const data = await action($, workspaceRoot, 'run-results', ['--run', run.id]);
    if (data.runId !== run.id || data.revision !== revision) throw new Error(data.runId === run.id && revision !== null && data.revision > revision ? '确认记录版本超前，等待任务摘要刷新。' : '确认记录不属于当前任务版本，请重新读取。');
    await update($, board, (current): RecruitingBoardState => root !== workspaceRoot || current.workspaceRoot !== workspaceRoot || current.taskSelection.runId !== run.id || current.confirmations?.requestId !== requestId || resultRevision(current.snapshot?.runs?.find(item => item.id === run.id)) !== revision ? current : ({ ...current, confirmations: { ...current.confirmations, status: 'ready', data, error: null } }));
  } catch (error) {
    await update($, board, (current): RecruitingBoardState => root !== workspaceRoot || current.workspaceRoot !== workspaceRoot || current.taskSelection.runId !== run.id || current.confirmations?.requestId !== requestId || resultRevision(current.snapshot?.runs?.find(item => item.id === run.id)) !== revision ? current : ({ ...current, confirmations: { ...current.confirmations, status: current.confirmations.data ? 'stale' : 'error', error: `本轮确认列表读取失败：${messageOf(error)}` } }));
  }
}

async function loadResults($: EngineInterface) {
  const held = await read($, board);
  const panel = held.panel;
  if (!held.workspaceRoot || panel?.kind !== 'results' || panel.runId !== held.taskSelection.runId) return;
  const workspaceRoot = held.workspaceRoot;
  const requestId = ++requestSequence;
  const revision = resultRevision(held.snapshot?.runs?.find(run => run.id === panel.runId));
  await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.panel?.kind !== 'results' || current.panel.requestId !== panel.requestId || current.taskSelection.runId !== panel.runId ? current : ({ ...current, panel: { ...current.panel, requestId, revision, status: 'loading', message: null } }));
  const active = await read($, board);
  if (active.workspaceRoot !== workspaceRoot || active.panel?.kind !== 'results' || active.panel.requestId !== requestId) return;
  try {
    const data = await action($, workspaceRoot, 'run-results', ['--run', panel.runId]);
    if (data.runId !== panel.runId) throw new Error('返回的结果不属于所选任务，请重新读取。');
    if (revision !== null && data.revision < revision) throw new Error('任务结果版本落后于当前摘要，请重新读取。');
    await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.taskSelection.runId !== panel.runId || current.panel?.kind !== 'results' || current.panel.requestId !== requestId ? current : ({ ...current, panel: { ...current.panel, revision: data.revision, status: 'ready', data } }));
  } catch (error) {
    await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.taskSelection.runId !== panel.runId || current.panel?.kind !== 'results' || current.panel.requestId !== requestId ? current : ({ ...current, panel: { ...current.panel, status: current.panel.data ? 'stale' : 'error', message: `本轮结果读取失败：${messageOf(error)}` } }));
  }
}

async function openResults($: EngineInterface, runId: string, filter: ResultsPanel['filter'], candidateId?: string) {
  const held = await read($, board);
  if (!held.workspaceRoot || held.taskSelection.runId !== runId) return;
  const workspaceRoot = held.workspaceRoot;
  const requestId = ++requestSequence;
  await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.taskSelection.runId !== runId ? current : ({ ...current, panel: { kind: 'results', requestId, runId, revision: null, status: 'loading', data: null, filter, expanded: candidateId ? [candidateId] : [], message: null } }));
  await loadResults($);
}

async function selectRun($: EngineInterface, runId: string) {
  const held = await read($, board);
  if (held.panel?.kind === 'roles' && held.panel.status === 'saving') return;
  const requestId = ++requestSequence;
  await update($, board, (current): RecruitingBoardState => current.panel?.kind === 'roles' && current.panel.status === 'saving' ? current : ({ ...current, taskSelection: { mode: 'pinned', runId }, activity: current.activity?.runId === runId ? current.activity : null, confirmations: current.confirmations?.runId === runId ? current.confirmations : null, panel: current.panel?.kind === 'results' ? { kind: 'results', requestId, runId, revision: null, status: 'loading', data: null, filter: current.panel.filter, expanded: [], message: null } : null }));
  await Promise.all([loadResults($), loadActivity($), loadConfirmations($)]);
}

async function followLatest($: EngineInterface) {
  const held = await read($, board);
  if (held.panel?.kind === 'roles' && held.panel.status === 'saving') return;
  await update($, board, (current): RecruitingBoardState => {
    if (current.panel?.kind === 'roles' && current.panel.status === 'saving') return current;
    const taskSelection = selectTask(current.snapshot?.runs ?? null, { mode: 'live', runId: null }).selection;
    return { ...current, taskSelection, activity: current.activity?.runId === taskSelection.runId ? current.activity : null, confirmations: current.confirmations?.runId === taskSelection.runId ? current.confirmations : null, panel: null, showRecords: false, showSteps: false, showDetails: false, selection: { ...current.selection, editor: null } };
  });
  await Promise.all([loadActivity($), loadConfirmations($)]);
}

async function candidateBack($: EngineInterface) {
  const held = await read($, board);
  if (held.panel?.kind !== 'candidate') return;
  const panel = held.panel;
  const returnTo = panel.returnTo;
  await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== held.workspaceRoot || current.panel?.kind !== 'candidate' || current.panel.requestId !== panel.requestId ? current : ({ ...current, panel: returnTo && current.taskSelection.runId === returnTo.runId ? { ...returnTo, requestId: ++requestSequence } : null }));
  if (returnTo && (returnTo.status !== 'ready' || returnTo.revision !== resultRevision(held.snapshot?.runs?.find(run => run.id === returnTo.runId)))) await loadResults($);
}

async function openCandidate($: EngineInterface, candidateId: string, origin: Extract<RecruitingBoardPanel, { kind: 'candidate' }>['origin'] = 'stages') {
  const held = await read($, board);
  if (!held.workspaceRoot) return;
  const workspaceRoot = held.workspaceRoot;
  const returnTo = held.panel?.kind === 'results' ? held.panel : held.panel?.kind === 'candidate' ? held.panel.returnTo : null;
  if (!held.snapshot?.candidates?.some(candidate => candidate.id === candidateId)) return;
  const requestId = ++requestSequence;
  await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot ? current : ({ ...current, panel: { kind: 'candidate', requestId, candidateId, origin: held.panel?.kind === 'candidate' ? held.panel.origin : origin, showBackground: false, status: 'loading', detail: null, document: null, documentId: null, documentBusy: false, message: null, returnTo } }));
  try {
    const detail = await action($, workspaceRoot, 'candidate', ['--candidate', candidateId]);
    await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.panel?.kind !== 'candidate' || current.panel.requestId !== requestId ? current : ({ ...current, panel: { ...current.panel, status: 'ready', detail } }));
  } catch (error) {
    await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.panel?.kind !== 'candidate' || current.panel.requestId !== requestId ? current : ({ ...current, panel: { ...current.panel, status: 'error', message: messageOf(error) } }));
  }
}

async function candidateDocument($: EngineInterface, documentId: string, open = false) {
  const held = await read($, board);
  const panel = held.panel;
  if (!held.workspaceRoot || panel?.kind !== 'candidate' || panel.status !== 'ready' || panel.documentBusy || !panel.detail?.documents.some(document => document.id === documentId && document.status === 'ok')) return;
  const workspaceRoot = held.workspaceRoot;
  const requestId = ++requestSequence;
  await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.panel?.kind !== 'candidate' || current.panel.requestId !== panel.requestId ? current : ({ ...current, panel: { ...current.panel, requestId, documentId, document: open ? current.panel.document : null, documentBusy: true, message: null } }));
  const active = await read($, board);
  if (active.workspaceRoot !== workspaceRoot || active.panel?.requestId !== requestId) return;
  try {
    if (open) {
      const result = await action($, workspaceRoot, 'open-document', ['--candidate', panel.candidateId, '--document', documentId]);
      await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.panel?.kind !== 'candidate' || current.panel.requestId !== requestId ? current : ({ ...current, panel: { ...current.panel, documentBusy: false, message: result.message } }));
    } else {
      const document = await action($, workspaceRoot, 'document', ['--candidate', panel.candidateId, '--document', documentId]);
      await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.panel?.kind !== 'candidate' || current.panel.requestId !== requestId ? current : ({ ...current, panel: { ...current.panel, documentBusy: false, document } }));
    }
  } catch (error) {
    await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.panel?.kind !== 'candidate' || current.panel.requestId !== requestId ? current : ({ ...current, panel: { ...current.panel, documentBusy: false, message: messageOf(error) } }));
  }
}

async function manageRoles($: EngineInterface) {
  const held = await read($, board);
  if (!held.workspaceRoot || held.panel?.kind === 'roles' && held.panel.status === 'saving') return;
  const workspaceRoot = held.workspaceRoot;
  const preferred = held.panel?.kind === 'roles' ? held.panel.role : held.selection.role;
  const requestId = ++requestSequence;
  await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot ? current : ({ ...current, panel: { kind: 'roles', requestId, status: 'loading', info: null, role: '', selectedStatus: '', message: null } }));
  try {
    const info = await action($, workspaceRoot, 'role-info');
    const role = info.roles.find(item => item.name === preferred) ?? info.roles[0];
    await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.panel?.kind !== 'roles' || current.panel.requestId !== requestId ? current : ({ ...current, panel: { ...current.panel, status: 'ready', info, role: role?.name ?? '', selectedStatus: role?.status && info.allowedStatuses.includes(role.status) ? role.status : '' } }));
  } catch (error) {
    await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.panel?.kind !== 'roles' || current.panel.requestId !== requestId ? current : ({ ...current, panel: { ...current.panel, status: 'error', message: messageOf(error) } }));
  }
}

async function saveRole($: EngineInterface) {
  const held = await read($, board);
  const panel = held.panel;
  if (!held.workspaceRoot || panel?.kind !== 'roles' || panel.status !== 'ready' || !panel.info || !panel.info.roles.some(role => role.name === panel.role) || !panel.info.allowedStatuses.includes(panel.selectedStatus)) return;
  const workspaceRoot = held.workspaceRoot;
  const requestId = ++requestSequence;
  await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.panel?.kind !== 'roles' || current.panel.requestId !== panel.requestId || current.panel.status !== 'ready' ? current : ({ ...current, panel: { ...current.panel, requestId, status: 'saving', message: null } }));
  const active = await read($, board);
  if (active.workspaceRoot !== workspaceRoot || active.panel?.requestId !== requestId) return;
  try {
    const info = await action($, workspaceRoot, 'role-set', ['--role', panel.role, '--status', panel.selectedStatus, '--revision', panel.info.contextRevision]);
    await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.panel?.kind !== 'roles' || current.panel.requestId !== requestId ? current : ({ ...current, panel: { ...current.panel, status: 'ready', info, message: info.changed ? '岗位状态已保存，原文件已备份。' : '岗位状态未变化。' } }));
    await refresh($);
  } catch (error) {
    await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot || current.panel?.kind !== 'roles' || current.panel.requestId !== requestId ? current : ({ ...current, panel: { ...current.panel, status: 'error', message: `${messageOf(error)} 请重新读取岗位后再保存。` } }));
  }
}

async function source($: EngineInterface, root: string, relative: string): Promise<Source> {
  const file = `${root}/${relative}`;
  try {
    if (!await $.fs.exists(file)) return { status: 'missing' };
    const info = await $.fs.stat(file, { resolve: true });
    if (!info.realPath || !within(root, info.realPath) || info.kind !== 'file' || info.size > 4 * 1024 * 1024) return { status: 'error' };
    return { status: 'ok', text: await $.fs.read(file), updatedAt: new Date(info.mtimeMs).toISOString() };
  } catch { return { status: 'error' }; }
}

function snapshotSignature(snapshot: BoardSnapshot | null) {
  return snapshot === null ? 'null' : JSON.stringify({
    ...snapshot,
    generatedAt: undefined,
    sources: { ...snapshot.sources, runs: { status: snapshot.sources.runs.status } }
  });
}

async function refresh($: EngineInterface) {
  if (!root || refreshing?.workspaceRoot === root) return;
  const workspaceRoot = root;
  const pending = { workspaceRoot, id: ++requestSequence };
  refreshing = pending;
  try {
    const [ledger, context, config] = await Promise.all([source($, workspaceRoot, '02-sourcing/dedup-ledger.csv'), source($, workspaceRoot, 'CONTEXT.md'), source($, workspaceRoot, '_shared/recruit-board.config.json')]);
    const directory = `${workspaceRoot}/runtime/recruit-board/runs`;
    const runFiles: { status: 'ok' | 'missing' | 'error'; files: { name: string; text?: string; error: boolean }[] } = { status: 'missing', files: [] };
    try {
      if (await $.fs.exists(directory)) {
        const info = await $.fs.stat(directory, { resolve: true });
        if (!info.realPath || !within(workspaceRoot, info.realPath) || info.kind !== 'dir') throw new Error('进度目录不在工作区内');
        runFiles.status = 'ok';
        for (const entry of await $.fs.list(directory)) {
          if (!entry.name.endsWith('.json')) continue;
          try { assertRunId(entry.name.slice(0, -5)); }
          catch { runFiles.files.push({ name: entry.name, error: true }); continue; }
          const file = await source($, workspaceRoot, `runtime/recruit-board/runs/${entry.name}`);
          runFiles.files.push({ name: entry.name, text: file.text, error: file.status !== 'ok' });
        }
      }
    } catch { runFiles.status = 'error'; }
    const held = await read($, board);
    if (root !== workspaceRoot || held.workspaceRoot !== workspaceRoot || refreshing !== pending) return;
    const snapshot = buildSnapshot({
      workspace: workspaceRoot.split('/').filter(Boolean).at(-1) ?? '招聘工作区',
      generatedAt: new Date(await $.clock.now()).toISOString(), ledger, context, runFiles, config
    }, held.snapshot);
    if (held.error || snapshotSignature(snapshot) !== snapshotSignature(held.snapshot)) {
      await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot ? current : withSnapshot(current, snapshot));
    }
    const current = await read($, board);
    const results = current.panel;
    if (current.workspaceRoot === workspaceRoot) await Promise.all([
      loadActivity($),
      loadConfirmations($),
      results?.kind === 'results' && results.revision !== resultRevision(snapshot.runs?.find(run => run.id === results.runId)) ? loadResults($) : Promise.resolve()
    ]);
  } catch {
    const message = '看板读取失败；以下保留最后记录，招聘主任务可继续。';
    if ((await read($, board)).error !== message) await update($, board, (current): RecruitingBoardState => current.workspaceRoot !== workspaceRoot ? current : ({ ...current, error: message }));
  } finally { if (refreshing === pending) refreshing = null; }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, board, (current): RecruitingBoardState => {
      const { role: legacyRole, runId: legacyRunId, ...normalized } = current as RecruitingBoardState & { role?: string; runId?: string | null };
      return { ...initial, ...normalized, snapshot: current.snapshot ? { ...current.snapshot, runs: current.snapshot.runs?.map(runSummary) ?? null } : null, selection: current.selection ?? preferences(undefined, legacyRole ?? ''), taskSelection: current.taskSelection ?? (legacyRunId ? { mode: 'pinned', runId: legacyRunId } : initial.taskSelection), activity: null, confirmations: null, panel: null };
    });
    try {
      if (!(await $.command.list()).some(command => command.name === PANE)) {
        await $.command.register({ name: 'recruiting-board', description: '打开本地招聘进展面板，按需查看资料或管理岗位', argumentHint: '[工作区绝对路径]' });
      }
    } catch {
      await update($, board, (current): RecruitingBoardState => ({ ...current, error: '招聘看板命令注册失败。' }));
    }
    return next(e);
  });

  on('command.run', { command: 'recruiting-board' }, async ($, e) => {
    const argument = e.args.trim();
    const requested = (argument.startsWith('"') && argument.endsWith('"')) || (argument.startsWith("'") && argument.endsWith("'")) ? argument.slice(1, -1) : argument;
    if (argument && !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(requested)) {
      return { text: '请提供工作区绝对路径：/recruiting-board <工作区绝对路径>；省略参数时使用当前会话目录。路径含空格时可加引号。' };
    }
    const opening = ++openingSequence;
    try {
      const info = await $.fs.stat(argument ? requested : await $.session.cwd(), { resolve: true });
      if (info.kind !== 'dir' || !info.realPath) {
        return { text: '无法定位招聘工作区目录，请运行 /recruiting-board <工作区绝对路径>。' };
      }
      const workspaceRoot = info.realPath.replace(/\\/g, '/').replace(/\/$/, '') || '/';
      const ledgerPath = `${workspaceRoot}/02-sourcing/dedup-ledger.csv`;
      if (!await $.fs.exists(ledgerPath)) {
        return { text: '所选目录不是招聘工作区：未找到 02-sourcing/dedup-ledger.csv。请运行 /recruiting-board <工作区绝对路径>。' };
      }
      const ledger = await $.fs.stat(ledgerPath, { resolve: true });
      if (ledger.kind !== 'file' || !ledger.realPath || !within(workspaceRoot, ledger.realPath)) {
        return { text: '候选人台账不是工作区内的有效文件，请检查 02-sourcing/dedup-ledger.csv。' };
      }
      const sessionId = await $.session.id();
      const held = await read($, board);
      let selection = held.selection;
      if (held.workspaceRoot !== workspaceRoot) {
        try { selection = preferences(await $.store.get(preferenceKey(workspaceRoot))); }
        catch { selection = { ...preferences(undefined), message: '个人岗位选择未能读取，当前使用在招范围。' }; }
      }
      if (opening !== openingSequence) return { text: '已转到另一次工作区打开请求。' };
      root = workspaceRoot;
      await update($, board, (current): RecruitingBoardState => current.workspaceRoot === workspaceRoot ? ({ ...current, sessionId }) : ({ ...initial, workspaceRoot, sessionId, selection }));
      await refresh($);
      if (opening !== openingSequence || root !== workspaceRoot) return { text: '已转到另一次工作区打开请求。' };
      const opened = await $.ui.open({ id: PANE, title: '招聘进展' });
      if (opened.isPlaced && !timer) timer = $.clock.every(2000, () => { void refresh($); });
      return { text: opened.isPlaced ? '招聘进展已打开；候选资料只读，岗位状态可从管理入口手动保存。' : '当前宿主未显示面板；可用 recruit-board 的本机网页查看。' };
    } catch {
      await update($, board, (current): RecruitingBoardState => ({ ...current, error: '无法打开招聘看板，请检查工作区路径与读取权限。' }));
      return { text: '无法打开招聘看板，请检查工作区路径与读取权限；用 /recruiting-board <工作区绝对路径> 指定招聘工作区。招聘任务可继续。' };
    }
  });

  on('ui.close', { id: PANE }, async ($, e, next) => {
    timer?.cancel(); timer = null;
    root = null;
    refreshing = null;
    openingSequence++;
    await update($, board, (current): RecruitingBoardState => ({ ...current, panel: null, activity: null, confirmations: null }));
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    timer?.cancel(); timer = null;
    root = null;
    refreshing = null;
    openingSequence++;
    await update($, board, () => initial);
    return next(e);
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e);
      return <Text>招聘进展请在 Desktop 或本机网页查看。</Text>;
    }
    const { Box, Text, Button, Select, Input, Code } = $.ui.resolve(e);
    const held = await read($, board);
    const snapshot = held.snapshot;
    if (!snapshot) return <Box flexDirection="column" gap="xs" padding="sm"><Text weight="semibold">Recruiting Copilot</Text><Text size="heading">招聘进展</Text><Text color={held.error ? 'error' : 'inactive'}>{held.error ?? '尚无读取记录。请运行 /recruiting-board。'}</Text></Box>;
    const panel = held.panel;
    const runs = snapshot.runs ?? [];
    const task = selectTask(snapshot.runs, held.taskSelection, true);
    const run = task.run;
    const runOptions = taskOptions(runs, held.taskSelection.runId);
    const current = run?.steps.find(step => step.status === 'running') ?? (run?.status === 'failed' ? run.steps.find(step => step.status === 'failed') : null);
    const ordinaryCodes = ['UNKNOWN_STATUS', 'DUPLICATE_KEY', 'ROLE_ALIAS_COLLISION'];
    const alerts = snapshot.diagnostics.filter(item => !ordinaryCodes.includes(item.code));
    const runColor = run ? { running: 'claude', waiting: 'warning', completed: 'success', failed: 'error', cancelled: 'inactive' }[run.status] : 'inactive';
    const taskContext = <Box flexDirection="column" gap="xs">
      <Box justifyContent="space-between" gap="sm"><Text size="caption" weight="medium">Recruiting Copilot · 招聘进展</Text><Text size="caption" color={held.error || snapshot.status === 'error' || snapshot.status === 'stale' ? 'error' : snapshot.status === 'partial' ? 'warning' : 'inactive'}>{held.error ? '读取失败' : snapshot.status === 'ok' ? '已同步' : snapshot.status === 'stale' ? '数据陈旧' : '有读取诊断'}</Text></Box>
      <Text size="caption" dimColor>{snapshot.workspace}</Text>
      {panel && <Text weight="semibold">{run ? `${run.label}${run.role ? ` · ${run.role}` : ''} · ${RUN_LABELS[run.status]}` : snapshot.runs === null ? '任务状态未知' : held.taskSelection.runId ? '所选任务记录已移除' : '尚无任务进度记录'}</Text>}
      {panel && run && <Text size="caption" dimColor>{current ? `${current.label} · ` : ''}最后记录 {time(run.updatedAt)}{run.ownerSessionId === held.sessionId ? ' · 当前会话' : ''}</Text>}
      {(held.taskSelection.mode === 'pinned' || task.newerRunId) && <Box flexDirection="column" gap="xs">
        <Text size="caption" color={task.newerRunId ? 'warning' : 'inactive'}>{task.newerRunId ? '有新任务，当前阅读保持不变。' : '已固定当前任务。'}</Text>
        {!(panel?.kind === 'roles' && panel.status === 'saving') && <Button key="follow-latest" plain label={task.newerRunId ? '回到最新 · 跟随最新' : '跟随最新'} onPress={() => { void followLatest($); }} />}
      </Box>}
      {(held.error || alerts.length > 0 || snapshot.status === 'stale') && <Box flexDirection="column" gap="xs" borderStyle="single" borderColor={held.error || snapshot.status === 'error' || snapshot.status === 'stale' ? 'error' : 'warning'} padding="xs">
        {held.error && <Text color="error">{held.error}</Text>}
        {snapshot.status === 'stale' && <Text color="warning">数据读取失败，以下保留上次成功记录（陈旧）。</Text>}
        {snapshot.sources.runs.status === 'stale' && <Text size="caption" color="warning">任务摘要读取失败，任务与最近动态沿用最后记录（陈旧）。</Text>}
        {alerts.map(item => <Text size="caption" color={item.level === 'error' ? 'error' : 'warning'}>{item.message}</Text>)}
      </Box>}
    </Box>;
    if (panel?.kind === 'candidate') {
      const detail = panel.detail;
      return <Box flexDirection="column" gap="md" padding="sm">
        {taskContext}
        <Button key="candidate-back" plain label={panel.returnTo ? '返回本轮处理记录' : panel.origin === 'confirmations' ? '返回本轮需确认' : panel.origin === 'activity' ? '返回最近动态' : '返回阶段名单'} onPress={() => { void candidateBack($); }} />
        <Text size="heading" weight="semibold">{detail?.candidate.name ?? '候选人详情'}</Text>
        {panel.status === 'loading' && <Text dimColor>正在读取候选人资料…</Text>}
        {panel.message && <Text color={panel.status === 'error' ? 'error' : 'warning'}>{panel.message}</Text>}
        {panel.status === 'error' && <Button key="candidate-retry" label="重新读取候选资料" onPress={() => { void openCandidate($, panel.candidateId); }} />}
        {detail && <Box flexDirection="column" gap="sm">
          <Text>{detail.candidate.role} · {detail.candidate.rawStatus ?? '状态未归类'}</Text>
          {detail.candidate.rawRole !== detail.candidate.role && <Text size="caption" dimColor>原岗位：{detail.candidate.rawRole}</Text>}
          <Button key="candidate-background" plain label={panel.showBackground ? '背景与评估 · 收起' : '背景与评估 · 展开'} onPress={() => { void update($, board, (current): RecruitingBoardState => current.panel?.kind !== 'candidate' ? current : ({ ...current, panel: { ...current.panel, showBackground: !current.panel.showBackground } })); }} />
          {panel.showBackground && <Box flexDirection="column" gap="xs">
            <Text size="caption">原评级：{detail.candidate.rating ?? '未评级'}</Text>
            <Text weight="semibold">背景摘要</Text><Code source={detail.background || '台账未记录背景摘要。'} />
            <Text weight="semibold">备注</Text><Code source={detail.notes || '台账未记录备注。'} />
          </Box>}
          <Text size="caption" dimColor>来源轮次：{detail.sourceRound || '未记录'}</Text>
          {detail.warnings.map(warning => <Text size="caption" color="warning">{warning}</Text>)}
          <Text weight="semibold">关联资料</Text>
          {!detail.documents.length && <Text dimColor>尚无可关联的简历或面试档案。</Text>}
          {detail.documents.map(document => <Box flexDirection="column" gap="xs" padding="sm" borderStyle="round" borderColor="promptBorder">
            <Text weight="medium">{document.label} · {documentStatuses[document.status]}</Text>
            {document.status !== 'ok' ? <Text size="caption" color="warning">{document.message ?? documentStatuses[document.status]}</Text> : !panel.documentBusy && <Box gap="sm">
              {document.kind !== 'pdf' && <Button key={elementKey('document-read', document.id)} plain label="阅读正文" onPress={() => { void candidateDocument($, document.id); }} />}
              <Button key={elementKey('document-open', document.id)} plain label={document.kind === 'pdf' ? '打开 PDF' : '打开原文件'} onPress={() => { void candidateDocument($, document.id, true); }} />
            </Box>}
          </Box>)}
          {panel.documentBusy && <Text dimColor>正在处理所选资料…</Text>}
          {panel.document && <Box flexDirection="column" gap="xs" padding="xs" borderStyle="single" borderColor="promptBorder">
            <Text weight="semibold">{panel.document.document.label}</Text>
            {panel.document.text === null ? <Text dimColor>PDF 请用本机默认应用打开。</Text> : <Code source={panel.document.text || '（空文档）'} language={panel.document.document.kind === 'markdown' ? 'markdown' : 'text'} />}
          </Box>}
        </Box>}
      </Box>;
    }
    if (panel?.kind === 'results') {
      const groups = panel.data?.results ? groupResults(panel.data.results) : [];
      const shown = groups.filter(group => panel.filter === 'all' || group.attention === panel.filter);
      const decisions = groups.filter(group => group.attention === 'decision').length;
      const notices = groups.filter(group => group.attention === 'notice').length;
      return <Box flexDirection="column" gap="md" padding="sm">
        {taskContext}
        <Button key="results-back" plain label="返回招聘进展" onPress={() => { void update($, board, (current): RecruitingBoardState => ({ ...current, panel: null })); }} />
        <Text size="heading" weight="semibold">本轮处理记录</Text>
        {runOptions.length > 0 && <Select key="run" label="任务" options={runOptions} value={held.taskSelection.runId ?? ''} onSelect={value => { void selectRun($, value); }} />}
        {run?.status === 'failed' && <Text color="error">任务失败，以下仅为已记录的处理结果。</Text>}
        {panel.status === 'loading' && <Text dimColor>{panel.data ? '正在更新本轮结果，以下保留上次记录…' : '正在读取本轮结果…'}</Text>}
        {panel.message && <Text color="error">{panel.message}{panel.status === 'stale' ? ' 以下保留上次成功记录（陈旧）。' : ' 当前人数未知。'}</Text>}
        {panel.data && panel.data.results !== null && <Text tabular>本轮已记录 {groups.length} 人 · 需你确认 {decisions} 人 · 提醒 {notices} 人</Text>}
        <Box gap="sm" flexWrap="wrap">
          <Button key="results-filter-all" plain label={panel.filter === 'all' ? '全部 · 已选' : '全部'} onPress={() => { void update($, board, (current): RecruitingBoardState => current.panel?.kind !== 'results' ? current : ({ ...current, panel: { ...current.panel, filter: 'all' } })); }} />
          <Button key="results-filter-decision" plain label={panel.filter === 'decision' ? '需你确认 · 已选' : '需你确认'} onPress={() => { void update($, board, (current): RecruitingBoardState => current.panel?.kind !== 'results' ? current : ({ ...current, panel: { ...current.panel, filter: 'decision' } })); }} />
          <Button key="results-filter-notice" plain label={panel.filter === 'notice' ? '提醒 · 已选' : '提醒'} onPress={() => { void update($, board, (current): RecruitingBoardState => current.panel?.kind !== 'results' ? current : ({ ...current, panel: { ...current.panel, filter: 'notice' } })); }} />
        </Box>
        {panel.data?.results === null && <Text dimColor>此任务尚未记录候选人处理结果，人数未知。</Text>}
        {panel.data && panel.data.results !== null && !shown.length && <Text dimColor>{!groups.length ? '本轮已记录 0 人，尚无候选人处理结果。' : panel.filter === 'decision' ? '本轮暂无需你确认的人选。' : panel.filter === 'notice' ? '本轮暂无提醒人选。' : '本轮尚无候选人处理结果。'}</Text>}
        {shown.map(group => <Box key={elementKey('result-person', group.candidateId)} flexDirection="column" gap="xs" padding="sm" borderStyle="single" borderColor="promptBorder">
          <Box justifyContent="space-between" gap="sm">
            {snapshot.candidates?.some(candidate => candidate.id === group.candidateId) ? <Button key={elementKey('result-candidate', group.candidateId)} plain onPress={() => { void openCandidate($, group.candidateId); }}><Text weight="semibold">{group.name}</Text></Button> : <Text weight="semibold">{group.name}</Text>}
            <Text size="caption" color={group.attention === 'decision' || group.attention === 'notice' ? 'warning' : 'inactive'}>{group.attention === 'decision' ? '需你确认' : group.attention === 'notice' ? '提醒' : '已记录'}</Text>
          </Box>
          <Text size="caption" dimColor>原岗位：{group.rawRole}</Text>
          {!snapshot.candidates?.some(candidate => candidate.id === group.candidateId) && <Text size="caption" dimColor>{snapshot.candidates === null ? '台账未读取，暂无法打开候选资料。' : '未入台账，可查看处理记录。'}</Text>}
          {(panel.expanded.includes(group.candidateId) ? group.results : group.results.slice(0, 1)).map(result => <Box flexDirection="column" gap="xs" paddingY="xs">
            <Text weight="medium">{result.action}{result.attention === 'decision' ? ' · 需你确认' : result.attention === 'notice' ? ' · 提醒' : ''}</Text>
            <Text>{result.outcome}</Text>
            {result.nextAction && <Text size="caption">下一步：{result.nextAction}</Text>}
            <Text size="caption" dimColor>{run?.steps.find(step => step.id === result.stepId)?.label ?? result.stepId} · {time(result.updatedAt)}</Text>
          </Box>)}
          {group.results.length > 1 && <Button key={elementKey('result-expand', group.candidateId)} plain label={panel.expanded.includes(group.candidateId) ? '收起其余记录' : `查看其余记录 · ${group.results.length - 1} 条`} onPress={() => { void update($, board, (current): RecruitingBoardState => current.panel?.kind !== 'results' ? current : ({ ...current, panel: { ...current.panel, expanded: current.panel.expanded.includes(group.candidateId) ? current.panel.expanded.filter(id => id !== group.candidateId) : [...current.panel.expanded, group.candidateId] } })); }} />}
        </Box>)}
        {panel.data && <Text size="caption" dimColor>最后记录 {time(panel.data.updatedAt)}</Text>}
        {panel.status !== 'loading' && <Button key="results-reload" plain label="重新读取本轮结果" onPress={() => { void loadResults($); }} />}
      </Box>;
    }
    if (panel?.kind === 'roles') {
      const selected = panel.info?.roles.find(role => role.name === panel.role);
      const editable = panel.status === 'ready' && panel.info !== null;
      return <Box flexDirection="column" gap="md" padding="sm">
        {taskContext}
        {panel.status !== 'saving' && <Button key="role-cancel" plain label="返回招聘进展" onPress={() => { void update($, board, (current): RecruitingBoardState => ({ ...current, panel: null })); }} />}
        <Text size="heading" weight="semibold">管理岗位</Text>
        <Text size="caption" dimColor>保存前核对岗位文件版本，原文件自动备份。</Text>
        {panel.status === 'loading' && <Text dimColor>正在读取当前岗位配置…</Text>}
        {panel.status === 'saving' && <Text dimColor>正在保存岗位状态…</Text>}
        {panel.message && <Text color={panel.status === 'error' ? 'error' : 'success'}>{panel.message}</Text>}
        {editable && panel.info && <Box flexDirection="column" gap="sm">
          {panel.info.roles.length ? <Select key="manage-role" label="岗位" options={panel.info.roles.map(role => ({ value: role.name, label: `${role.name} · ${role.status ?? '状态未知'}` }))} value={panel.role} onSelect={value => { void update($, board, (current): RecruitingBoardState => {
            if (current.panel?.kind !== 'roles' || current.panel.status !== 'ready' || !current.panel.info) return current;
            const role = current.panel.info.roles.find(item => item.name === value);
            return { ...current, panel: { ...current.panel, role: value, selectedStatus: role?.status && current.panel.info.allowedStatuses.includes(role.status) ? role.status : '', message: null } };
          }); }} /> : <Text dimColor>未找到可编辑的标准岗位表，请在 CONTEXT.md 中维护岗位。</Text>}
          {selected && <Box flexDirection="column" gap="xs">
            <Text size="caption" dimColor>当前状态：{selected.status ?? '未记录'}</Text>
            <Text size="caption">新状态：{panel.selectedStatus || '请选择状态'}</Text>
            <Box gap="sm" flexWrap="wrap">{panel.info.allowedStatuses.map((status, index) => <Button key={`role-status-${index}`} plain label={panel.selectedStatus === status ? `${status} · 已选` : status} onPress={() => { void update($, board, (current): RecruitingBoardState => current.panel?.kind !== 'roles' || current.panel.status !== 'ready' ? current : ({ ...current, panel: { ...current.panel, selectedStatus: status, message: null } })); }} />)}</Box>
            {panel.info.allowedStatuses.includes(panel.selectedStatus) && panel.selectedStatus !== selected.status && <Button key="role-save" variant="primary" label="保存岗位状态" onPress={() => { void saveRole($); }} />}
          </Box>}
        </Box>}
        {panel.status !== 'saving' && <Button key="role-reload" plain label="重新读取岗位" onPress={() => { void manageRoles($); }} />}
      </Box>;
    }
    const selection = held.selection;
    const view = selectRoles(snapshot, selection);
    const scope = ROLE_SCOPES.find(scope => scope.id === selection.scope)?.label ?? '在招';
    const available = selectRoles(snapshot, { scope: selection.scope, following: selection.following }).roles;
    const followingRoles = [...new Set([...snapshot.roles.map(role => role.name), ...selection.following])].filter(name => name.toLocaleLowerCase().includes(selection.editor?.query.trim().toLocaleLowerCase() ?? ''));
    const finished = run?.steps.filter(step => step.status === 'completed').length ?? 0;
    const skipped = run?.steps.filter(step => step.status === 'skipped').length ?? 0;
    const members = view.candidates?.filter(candidate => candidate.stage === held.stage) ?? [];
    const roleOptions = [{ value: '', label: `${scope}岗位汇总` }, ...view.roles.map(role => ({ value: role.name, label: `${role.name} · ${role.status ?? '状态未知'}` }))];
    if (selection.role && !view.roles.some(role => role.name === selection.role)) roleOptions.push({ value: selection.role, label: `${selection.role} · ${view.selectionMissing ? '未在当前源中' : view.outsideScope ? '当前范围外' : '搜索结果外'}` });
    const unclassified = view.stages.find(stage => stage.id === 'unclassified')?.count ?? 0;
    const stepColors = { pending: 'inactive', running: runColor, completed: 'success', skipped: 'inactive', failed: 'error' };
    const stageColumns = e.props.bodyColumns < 44 ? 2 : 3;
    const stageRows = Array.from({ length: Math.ceil(view.stages.length / stageColumns) }, (_, index) => view.stages.slice(index * stageColumns, (index + 1) * stageColumns));
    const activity = held.activity?.runId === run?.id ? held.activity : null;
    const confirmations = held.confirmations?.runId === run?.id ? held.confirmations : null;
    const confirmationSourceReady = snapshot.sources.runs.status === 'ok';
    const confirmationReady = confirmationSourceReady && confirmations?.status === 'ready' && confirmations.data !== null && confirmations.data.results !== null && confirmations.data.revision === run?.resultSummary?.revision;
    const decisions = confirmationReady && run?.resultSummary?.decisions ? groupResults(confirmations?.data?.results ?? []).filter(group => group.attention === 'decision') : [];
    return <Box flexDirection="column" gap="md" padding="sm">
      {taskContext}
      <Box flexDirection="column" gap="sm">
        <Text size="heading" weight="semibold">本轮需确认</Text>
        {run ? <Box flexDirection="column" gap="xs">
          <Text size="caption" dimColor>{task.newerRunId ? '历史轮次' : '所选轮次'}：{run.label}{run.role ? ` · ${run.role}` : ''} · {time(run.createdAt)}</Text>
          <Text size="caption" dimColor>确认名单按所选轮次显示，不受下方岗位范围筛选影响。</Text>
          {!confirmationSourceReady ? <Text color="warning">任务摘要未能读取最新记录，需确认人数未知，暂不显示确认名单。</Text> : run.resultSummary === null ? <Text dimColor>此任务尚未记录候选人处理结果，需确认人数未知。</Text> : run.resultSummary.decisions === 0 ? <Text tabular>本轮需确认 0 人，暂无需你确认的人选。</Text> : confirmationReady ? <Text tabular>本轮需确认 {decisions.length} 人{decisions.length > 5 ? ' · 先显示前 5 人' : ''}</Text> : confirmations?.error ? <Text color="warning">{confirmations.error} 当前人数未知，暂不显示确认名单。</Text> : <Text dimColor>正在更新本轮确认列表，当前人数未知…</Text>}
          {decisions.slice(0, 5).map(group => {
            const candidate = snapshot.candidates?.find(candidate => candidate.id === group.candidateId);
            return <Box key={elementKey('confirmation', group.candidateId)} flexDirection="column" gap="sm" padding="sm" marginTop="sm" borderStyle="round" borderColor="promptBorder">
              <Box justifyContent="space-between" gap="sm" flexWrap="wrap">
                {candidate ? <Button key={elementKey('confirmation-candidate', group.candidateId)} plain onPress={() => { void openCandidate($, group.candidateId, 'confirmations'); }}><Text size="heading" weight="semibold">{group.name}</Text></Button> : <Text size="heading" weight="semibold">{group.name}</Text>}
                <Text size="caption" dimColor>{candidate ? `原状态：${candidateStatus(candidate)}` : '原状态未知'}</Text>
              </Box>
              <Text size="caption" dimColor>{candidate?.role ?? group.rawRole}{!candidate ? snapshot.candidates === null ? ' · 台账未读取' : ' · 未入台账' : ''}</Text>
              {candidate && candidate.rawRole !== candidate.role && <Text size="caption" dimColor>原岗位：{candidate.rawRole}</Text>}
              <Box flexDirection="column" gap="xs" paddingY="xs">
                <Text weight="semibold">需要你决定</Text>
                {group.results.filter(result => result.attention === 'decision' && result.nextAction).map(result => <Text key={elementKey('confirmation-next', result.id)}>下一步：{result.nextAction}</Text>)}
              </Box>
              <Box gap="sm" flexWrap="wrap">
                {candidate && <Button key={elementKey('confirmation-profile', group.candidateId)} variant="secondary" label="查看资料" onPress={() => { void openCandidate($, group.candidateId, 'confirmations'); }} />}
                <Button key={elementKey('confirmation-evidence', group.candidateId)} plain label="查看依据" onPress={() => { void openResults($, run.id, 'decision', group.candidateId); }} />
              </Box>
            </Box>;
          })}
          <Button key="run-decisions" plain label={decisions.length > 5 ? `展开全部需确认 · ${decisions.length} 人` : '查看本轮确认依据'} onPress={() => { void openResults($, run.id, 'decision'); }} />
          {confirmations && (confirmations.status === 'error' || confirmations.status === 'stale') && <Button key="confirmations-reload" plain label="重新读取确认列表" onPress={() => { void loadConfirmations($, true); }} />}
        </Box> : <Box flexDirection="column" gap="xs"><Text weight="medium">{snapshot.runs === null ? '进度读取失败，任务状态未知' : held.taskSelection.runId ? '所选记录已移除，请选择其他任务' : '尚无任务进度记录'}</Text><Text size="caption" dimColor>{snapshot.runs === null ? '无法确认任务步骤，等待恢复读取。' : held.taskSelection.runId ? '当前任务选择保持不变，人数未知。' : '工作流记录候选处理结果后，会在这里显示本轮需确认的人选。'}</Text></Box>}
      </Box>
      {run && <Box flexDirection="column" gap="xs" padding="sm" borderStyle="single" borderColor="promptBorder">
        <Text weight="semibold">任务进度</Text>
        <Text size="caption" color={runColor}>{run.label} · {RUN_LABELS[run.status]}{current ? ` · ${current.label}` : ''} · 最后记录 {time(run.updatedAt)}{snapshot.sources.runs.status === 'stale' ? ' · 陈旧' : ''}{run.ownerSessionId === held.sessionId ? ' · 当前会话' : ''}</Text>
        {(run.status === 'waiting' || run.status === 'failed') && <Text color={run.status === 'failed' ? 'error' : 'warning'}>{run.reason ?? current?.reason ?? (run.status === 'waiting' ? '任务等待后续处理，未记录具体理由。' : '任务失败，未记录具体理由；保留最后记录。')}</Text>}
      </Box>}
      <Box flexDirection="column" gap="sm">
        <Button key="show-records" plain label={held.showRecords ? '执行记录 · 收起' : '执行记录 · 展开'} onPress={() => { void update($, board, (current): RecruitingBoardState => ({ ...current, showRecords: !current.showRecords })); }} />
        {held.showRecords && <Box flexDirection="column" gap="sm">
          {runOptions.length > 0 && <Select key="run" label="任务" options={runOptions} value={held.taskSelection.runId ?? ''} onSelect={value => { void selectRun($, value); }} />}
          {run && <Box flexDirection="column" gap="xs">
            <Button key="run-results" plain label={`本轮已记录 ${run.resultSummary === null ? '人数未知（未记录）' : `${run.resultSummary.total} 人`} · 查看处理记录`} onPress={() => { void openResults($, run.id, 'all'); }} />
            <Text tabular>完成 {finished}/{run.steps.length} · 跳过 {skipped}</Text>
            <Button key="show-steps" plain label={held.showSteps ? '收起全部步骤' : '查看全部步骤'} onPress={() => { void update($, board, (current): RecruitingBoardState => ({ ...current, showSteps: !current.showSteps })); }} />
            {held.showSteps && <Box flexDirection="column" gap="xs">{run.steps.map((step, index) => <Box gap="sm" paddingY="xs" justifyContent="space-between"><Text>{index + 1}. {step.label}{step.reason ? ` · ${step.reason}` : ''}</Text><Text size="caption" color={stepColors[step.status]}>{step.status === 'running' && run.status === 'waiting' ? '当前 · 等待' : step.status === 'running' && run.status === 'cancelled' ? '已停止' : step.status === 'running' && run.status === 'failed' ? '已中断' : STEP_LABELS[step.status]}</Text></Box>)}</Box>}
          </Box>}
          {run && <Box flexDirection="column" gap="sm">
            <Box justifyContent="space-between" gap="sm"><Text weight="semibold">最近动态</Text><Text size="caption" dimColor>最多 3 条记录</Text></Box>
            {activity?.status === 'loading' && <Text size="caption" dimColor>{activity.data ? '正在更新，以下保留最后记录…' : '正在读取最近记录…'}</Text>}
            {activity?.message && <Text size="caption" color="warning">{activity.message}{activity.data ? ' 以下保留上次记录（陈旧）。' : ' 最近动态未知。'}</Text>}
            {activity?.data?.items === null && <Text size="caption" dimColor>此任务尚未记录候选人处理结果，最近动态未知。</Text>}
            {activity?.data?.items?.length === 0 && <Text size="caption" dimColor>此任务还没有候选人处理记录。</Text>}
            {activity?.data?.items?.map(item => {
              const [name, rawRole] = JSON.parse(item.candidateId) as [string, string];
              const available = snapshot.candidates?.some(candidate => candidate.id === item.candidateId);
              return <Box key={elementKey('activity-record', item.id)} flexDirection="column" gap="xs" paddingY="sm" borderStyle="single" borderColor="promptBorder" paddingX="sm">
                <Box justifyContent="space-between" gap="sm">
                  {available ? <Button key={elementKey('activity-candidate', item.id)} plain onPress={() => { void openCandidate($, item.candidateId, 'activity'); }}><Text weight="semibold">{name}</Text></Button> : <Text weight="semibold">{name}</Text>}
                  <Text size="caption" color={item.attention === 'none' ? 'inactive' : 'warning'}>{item.attention === 'decision' ? '需你确认' : item.attention === 'notice' ? '提醒' : '已记录'}</Text>
                </Box>
                <Text size="caption" dimColor>原岗位：{rawRole}</Text>
                <Text weight="medium">{item.action}</Text>
                <Text>{item.outcome}</Text>
                {item.nextAction && <Text size="caption">下一步：{item.nextAction}</Text>}
                <Text size="caption" dimColor>{time(item.updatedAt)}</Text>
                {!available && <Text size="caption" dimColor>{snapshot.candidates === null ? '台账未读取，暂无法打开候选资料。' : '未入台账，保留此条处理记录。'}</Text>}
              </Box>;
            })}
            {activity?.data && snapshot.sources.runs.status === 'stale' && <Text size="caption" color="warning">最近动态沿用最后成功记录（陈旧）。</Text>}
            {activity && activity.status !== 'loading' && activity.status !== 'ready' && <Button key="activity-reload" plain label="重新读取最近动态" onPress={() => { void loadActivity($, true); }} />}
          </Box>}
        </Box>}
        {!held.showRecords && activity?.message && <Text size="caption" color="warning">{activity.message}{activity.data ? ' 最近动态保留上次记录（陈旧），可展开执行记录重试。' : ' 最近动态未知，可展开执行记录重试。'}</Text>}
      </Box>
      <Box flexDirection="column" gap="sm" padding="sm" borderStyle="single" borderColor="promptBorder">
        <Text size="heading" weight="semibold">岗位与人选</Text>
        <Text size="caption" dimColor>按岗位查找人选与资料</Text>
        <Box gap="sm" flexWrap="wrap">{ROLE_SCOPES.map(item => <Button key={`scope-${item.id}`} variant={selection.scope === item.id ? 'primary' : 'secondary'} label={selection.scope === item.id ? `${item.label} · 已选` : item.label} onPress={() => { void changePreference($, { kind: 'scope', value: item.id as Selection['scope'] }); }} />)}</Box>
        <Input key="role-search" label="搜索岗位" placeholder="搜索当前范围的岗位" value={selection.query} onInput={value => { void update($, board, (current): RecruitingBoardState => ({ ...current, selection: { ...current.selection, query: value } })); }} onSubmit={value => { void update($, board, (current): RecruitingBoardState => ({ ...current, selection: { ...current.selection, query: value } })); }} />
        <Select key="role" label="岗位" options={roleOptions} value={selection.role} onSelect={value => { void changePreference($, { kind: 'role', value }); }} />
        <Text size="caption" dimColor>{view.label}</Text>
        {view.selectionMissing ? <Text size="caption" color="warning">已选岗位“{selection.role}”未在当前源中，保留选择；统计未知。</Text> : view.outsideScope ? <Text size="caption" color="warning">已选岗位“{selection.role}”在当前范围外，继续显示该岗位记录。</Text> : selection.role && !view.roles.some(role => role.name === selection.role) && <Text size="caption" dimColor>已选岗位不匹配当前搜索，继续显示该岗位记录。</Text>}
        {!available.length ? <Text size="caption" dimColor>{selection.scope === 'following' ? selection.following.length ? '关注岗位未在当前源中。' : '尚未关注岗位，点击“选择关注岗位”添加。' : selection.scope === 'active' ? '当前没有在招或状态未知的岗位。' : '当前没有岗位记录。'}</Text> : !view.roles.length && <Text size="caption" dimColor>当前范围没有匹配的岗位；搜索仅缩小可选清单，统计保持所选范围。</Text>}
        <Button key="choose-following" plain label={selection.editor ? '收起关注岗位' : '选择关注岗位'} onPress={() => { void update($, board, (current): RecruitingBoardState => ({ ...current, selection: { ...current.selection, editor: current.selection.editor ? null : { query: '' } } })); }} />
        {selection.editor && <Box flexDirection="column" gap="xs" padding="xs" borderStyle="single" borderColor="promptBorder">
          <Text weight="medium">个人关注岗位 · {selection.following.length} 个</Text>
          <Text size="caption" dimColor>从全部岗位选择，调整后自动保存个人偏好。</Text>
          <Input key="following-search" label="搜索全部岗位" placeholder="输入岗位名称" value={selection.editor.query} onInput={value => { void update($, board, (current): RecruitingBoardState => current.selection.editor === null ? current : ({ ...current, selection: { ...current.selection, editor: { query: value } } })); }} onSubmit={value => { void update($, board, (current): RecruitingBoardState => current.selection.editor === null ? current : ({ ...current, selection: { ...current.selection, editor: { query: value } } })); }} />
          {!followingRoles.length && <Text size="caption" dimColor>没有匹配的岗位。</Text>}
          {followingRoles.map(name => <Box justifyContent="space-between" gap="sm"><Text size="caption">{name}{snapshot.roles.some(role => role.name === name) ? '' : ' · 未在当前源中'}</Text><Button key={elementKey('following', name)} plain label={selection.following.includes(name) ? '取消关注' : '关注'} onPress={() => { void changePreference($, { kind: 'following', value: name }); }} /></Box>)}
        </Box>}
        {selection.message && <Text size="caption" color="warning">{selection.message}</Text>}
        <Button key="manage-roles" plain label="管理岗位" onPress={() => { void manageRoles($); }} />
        {snapshot.sources.ledger.status === 'stale' && <Text size="caption" color="warning">以下保留上次候选记录（陈旧）。</Text>}
        <Button key="show-stages" plain label={held.showStages ? '候选阶段 · 收起' : '候选阶段 · 展开'} onPress={() => { void update($, board, (current): RecruitingBoardState => ({ ...current, showStages: !current.showStages })); }} />
        {snapshot.sources.context.status !== 'ok' && <Text size="caption" dimColor>未读取岗位配置{snapshot.sources.context.status === 'stale' ? '，上次配置已陈旧' : '，仅列台账岗位'}</Text>}
        {held.showStages && <Box flexDirection="column" gap="xs">
          <Text weight="semibold">候选人阶段 · 共 {view.total === null ? '未知' : view.total} 条</Text>
          {stageRows.map(stages => <Box gap="sm">{stages.map(stage => <Box flexDirection="column" flexGrow={1} flexShrink={1} width={stageColumns === 2 ? '50%' : '33%'} padding="sm" gap="xs" borderStyle="single" borderColor={held.stage === stage.id ? 'claude' : 'promptBorder'}>
            <Button key={`stage-${stage.id}`} plain label={`${stage.label}${held.stage === stage.id ? ' · 收起' : ''}`} onPress={() => { void update($, board, (current): RecruitingBoardState => ({ ...current, stage: current.stage === stage.id ? null : stage.id })); }} />
            <Text size="heading" weight="semibold" tabular>{stage.count === null ? '—' : stage.count}</Text>
          </Box>)}</Box>)}
          {unclassified > 0 && <Text size="caption" dimColor>含 {unclassified} 条未归类候选记录，保留原状态。</Text>}
          {held.stage && <Box flexDirection="column" gap="xs" padding="xs">
            <Text weight="medium">{view.stages.find(stage => stage.id === held.stage)?.label}</Text>
            {!members.length && <Text size="caption">{view.total === null ? '台账未读取，记录数未知' : '此阶段暂无候选记录'}</Text>}
            {members.map(candidate => <Box flexDirection="column" gap="xs" paddingY="xs"><Button key={elementKey('candidate', candidate.id)} plain onPress={() => { void openCandidate($, candidate.id); }}><Text weight="medium">{candidate.name}</Text></Button><Text size="caption" dimColor>{candidate.role} · {candidateStatus(candidate)}</Text>{candidate.rawRole !== candidate.role && <Text size="caption" dimColor>原岗位：{candidate.rawRole}</Text>}</Box>)}
          </Box>}
        </Box>}
      </Box>
      <Box flexDirection="column" gap="xs">
        <Button key="show-details" plain label={`候选统计只读 · 本地台账 · ${held.showDetails ? '收起数据详情' : '数据详情'}`} onPress={() => { void update($, board, (current): RecruitingBoardState => ({ ...current, showDetails: !current.showDetails })); }} />
        {held.showDetails && <Box flexDirection="column" gap="xs">
          <Text size="caption" dimColor>统一主界面为网页版，本面板显示同一工作区记录。</Text>
          <Text size="caption">{run ? run.ownerSessionId === held.sessionId ? '已绑定当前会话' : run.ownerSessionId ? '其他会话的任务记录' : '尚未绑定当前会话' : '尚无可用任务记录'}</Text>
          <Text size="caption" mono>任务标识 {run?.id ?? held.taskSelection.runId ?? '—'}</Text>
          <Text size="caption" mono>绑定会话 {run?.ownerSessionId ?? '未绑定'}</Text>
          <Text size="caption" dimColor>最后记录 {time(run?.updatedAt ?? null)}{snapshot.sources.runs.status === 'stale' ? ' · 陈旧' : ''}</Text>
          <Text size="caption" dimColor>台账更新 {time(snapshot.ledgerUpdatedAt)}</Text>
          <Text size="caption" dimColor>兼容配置 {snapshot.sources.config.status === 'ok' ? '已加载' : snapshot.sources.config.status === 'missing' ? '未配置，使用标准映射' : snapshot.sources.config.status === 'stale' ? '陈旧，保留上次记录' : '读取或校验失败'}{snapshot.sources.config.updatedAt ? ` · ${time(snapshot.sources.config.updatedAt)}` : ''}</Text>
          <Text size="caption" dimColor>最近同步 {time(snapshot.generatedAt)}</Text>
          {snapshot.diagnostics.filter(item => ordinaryCodes.includes(item.code)).map(item => <Text size="caption" dimColor>{item.message}</Text>)}
          <Text size="caption" dimColor>按姓名＋原岗位计数，同人不同原岗位不自动合并。原状态以台账为准，总数与阶段使用同一岗位范围，含该范围内未归类记录。</Text>
        </Box>}
      </Box>
    </Box>;
  });
};
