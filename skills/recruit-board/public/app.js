import { candidateStatus, ROLE_SCOPES, RUN_LABELS, selectRoles, selectTask, STAGES, STEP_LABELS } from '/model.mjs';
import { createSnapshotController } from '/live.mjs';

const byId = id => document.getElementById(id);
const roleSelect = byId('role'), runSelect = byId('run');
const initialURL = new URL(window.location.href), initialWorkspace = initialURL.searchParams.get('workspace');
let expectedWorkspaceKey = /^[a-f0-9]{64}$/i.test(initialWorkspace ?? '') ? initialWorkspace.toLowerCase() : null;
let workspaceBlocked = initialWorkspace !== null && expectedWorkspaceKey === null;
let snapshot = null, taskSelection = { mode: 'live', runId: null }, selectedStage = null, disconnected = false;
let selectionMessage = '', displayedRun = null, pageActive = true;
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const text = (target, value) => { const element = typeof target === 'string' ? byId(target) : target; if (element.textContent !== value) element.textContent = value; };
let selectedCandidateId = null, candidateOrigin = null, recordRequest = 0, documentRequest = 0, roleRequest = 0, roleInfo = null, csrfToken = null;
let rolePreferences = { scope: 'active', following: [], role: '' }, preferenceKey = null, temporaryPreferencesChanged = false, preferenceMessage = '';
let resultsRequest = 0;
const freshResults = runId => ({ runId, open: false, filter: 'all', data: undefined, status: 'idle', error: null, requestedVersion: null, loadedVersion: null, updatedAt: null, expanded: new Set(), decisionExpanded: new Set(), showAllDecisions: false });
let resultsState = freshResults(null);
let activityRequest = 0, activityAbort = null;
const freshActivity = runId => ({ runId, data: undefined, revision: null, requestedRevision: null, status: 'idle', error: '', retryAt: 0, ahead: null });
let activityState = freshActivity(null);
const scopeSummary = scope => ({ active: '在招岗位汇总', following: '关注岗位汇总', all: '全部岗位' }[scope]);
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知';
const shortTime = value => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

function options(select, values, selection) {
  const signature = JSON.stringify(values);
  if (select.dataset.options !== signature) {
    select.replaceChildren(...values.map(([value, label]) => {
      const option = node('option', '', label); option.value = value; return option;
    }));
    select.dataset.options = signature;
  }
  if (select.value !== selection) select.value = selection;
}

function workspaceHeaders(headers = {}) {
  return { ...headers, ...(expectedWorkspaceKey ? { 'X-Workspace-Key': expectedWorkspaceKey } : {}) };
}

async function jsonRequest(url, init = {}) {
  if (workspaceBlocked) throw new Error('服务已指向其他工作区，请重新打开');
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000), ...init, headers: workspaceHeaders(init.headers) });
  const data = await response.json();
  if (!response.ok) {
    if (data.error?.code === 'WORKSPACE_MISMATCH') blockWorkspace();
    throw new Error(data.error?.message ?? '本地操作失败，请重试');
  }
  return data;
}

function readTaskURL() {
  const id = new URL(window.location.href).searchParams.get('run');
  selectionMessage = id !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) ? '任务链接格式无效，已恢复实时跟随；也可从列表选择任务。' : '';
  return id !== null && !selectionMessage ? { mode: 'pinned', runId: id } : { mode: 'live', runId: null };
}

function writeTaskURL() {
  const url = new URL(window.location.href);
  if (taskSelection.mode === 'pinned' && taskSelection.runId) url.searchParams.set('run', taskSelection.runId);
  else url.searchParams.delete('run');
  if (expectedWorkspaceKey) url.searchParams.set('workspace', expectedWorkspaceKey);
  if (url.href !== window.location.href) window.history.replaceState(null, '', url);
}

taskSelection = readTaskURL();

function renderPreferenceNotice() {
  const message = snapshot?.workspaceKey ? preferenceMessage : '尚未取得工作区标识，岗位偏好仅在本页保留。';
  text('role-preferences-note', message);
  byId('role-preferences-note').hidden = !message;
}

function persistRolePreferences() {
  if (!snapshot?.workspaceKey) {
    temporaryPreferencesChanged = true;
    renderPreferenceNotice();
    return;
  }
  try {
    localStorage.setItem(`recruiting-board:role-preferences:${snapshot.workspaceKey}`, JSON.stringify(rolePreferences));
    preferenceMessage = '';
  } catch (error) {
    console.warn('岗位偏好保存失败', error);
    preferenceMessage = '本机偏好保存失败；当前选择在本页继续有效。';
  }
  renderPreferenceNotice();
}

function syncRolePreferences() {
  const key = snapshot.workspaceKey;
  if (key && key !== preferenceKey) {
    const keepTemporary = preferenceKey === null && temporaryPreferencesChanged;
    preferenceKey = key;
    if (keepTemporary) persistRolePreferences();
    else {
      rolePreferences = { scope: 'active', following: [], role: '' };
      preferenceMessage = '';
      try {
        const saved = localStorage.getItem(`recruiting-board:role-preferences:${key}`);
        if (saved) {
          const value = JSON.parse(saved);
          if (!value || !ROLE_SCOPES.some(scope => scope.id === value.scope) || !Array.isArray(value.following) || value.following.some(name => typeof name !== 'string') || typeof value.role !== 'string') throw new Error('岗位偏好格式无效');
          rolePreferences = { scope: value.scope, following: [...new Set(value.following)], role: value.role };
        }
      } catch (error) {
        console.warn('岗位偏好读取失败', error);
        preferenceMessage = '本机偏好读取失败；本次使用默认岗位范围。';
      }
    }
    temporaryPreferencesChanged = false;
  }
  renderPreferenceNotice();
}

function currentRoleView(query = byId('role-query').value) {
  return selectRoles(snapshot, { ...rolePreferences, query });
}

function renderFollowingPicker() {
  if (byId('following-picker').hidden) return;
  const query = byId('following-query').value.trim().toLocaleLowerCase();
  const names = [...new Set([...snapshot.roles.map(role => role.name), ...rolePreferences.following])];
  const values = names.filter(name => name.toLocaleLowerCase().includes(query));
  const list = byId('following-list');
  const signature = JSON.stringify([values, rolePreferences.following]);
  if (list.dataset.content === signature) return;
  list.dataset.content = signature;
  const items = values.map(name => {
    const item = node('li'), label = node('label', 'following-option'), checkbox = node('input');
    checkbox.type = 'checkbox'; checkbox.checked = rolePreferences.following.includes(name);
    checkbox.dataset.role = name;
    checkbox.addEventListener('change', () => {
      rolePreferences.following = checkbox.checked ? [...rolePreferences.following, name] : rolePreferences.following.filter(value => value !== name);
      list.dataset.content = JSON.stringify([values, rolePreferences.following]);
      persistRolePreferences();
      renderRoleControls(); renderStages(true);
    });
    const title = node('span', '', name);
    if (!snapshot.roles.some(role => role.name === name)) title.append(node('span', 'muted', ' · 未在当前源中'));
    label.append(checkbox, title); item.append(label); return item;
  });
  if (!items.length) items.push(node('li', 'picker-empty', names.length ? '没有匹配的岗位。' : '当前没有可选择的岗位。'));
  list.replaceChildren(...items);
}

function renderRoleControls() {
  const view = currentRoleView(), scopeView = byId('role-query').value.trim() ? currentRoleView('') : view;
  const scopeLabel = ROLE_SCOPES.find(scope => scope.id === rolePreferences.scope).label;
  for (const button of byId('role-scopes').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.scope === rolePreferences.scope));
  const values = [['', scopeSummary(rolePreferences.scope)], ...view.roles.map(role => [role.name, `${role.name} · ${role.status || '状态未知'}`])];
  if (rolePreferences.role && !view.roles.some(role => role.name === rolePreferences.role)) {
    const suffix = view.selectionMissing ? '未在当前源中' : scopeView.roles.some(role => role.name === rolePreferences.role) ? '当前选择 · 不匹配搜索' : `当前选择 · 不在${scopeLabel}范围`;
    values.push([rolePreferences.role, `${rolePreferences.role} · ${suffix}`]);
  }
  options(roleSelect, values, rolePreferences.role);
  const messages = [];
  if (!scopeView.roles.length) messages.push(rolePreferences.scope === 'following' ? rolePreferences.following.length ? '关注岗位未在当前源中，可重新选择关注。' : '尚未选择关注岗位，可从全部岗位中选择关注。' : `当前${scopeLabel}范围没有岗位。`);
  else if (!view.roles.length) messages.push('搜索没有匹配岗位；汇总数字仍按当前范围统计。');
  if (view.selectionMissing) messages.push('所选岗位已不在当前源中，候选记录数未知。');
  else if (rolePreferences.role && !view.roles.some(role => role.name === rolePreferences.role)) messages.push(scopeView.roles.some(role => role.name === rolePreferences.role) ? '保留所选岗位；它不匹配当前搜索。' : `保留所选岗位；它不在${scopeLabel}范围内。`);
  text('role-options-note', messages.join(' '));
  byId('role-options-note').hidden = !messages.length;
  const role = view.selectedRole;
  const context = snapshot.sources.context.status;
  const note = context !== 'ok' ? `未读取岗位配置${context === 'stale' ? '；保留上次配置（陈旧）' : '；岗位状态未知'}` : rolePreferences.role ? role?.configured ? `岗位状态：${role.status || '未填写'}${role.priority ? ` · 优先级 ${role.priority}` : ''}` : '此岗位仅见于台账，未在岗位表配置。' : rolePreferences.scope === 'active' ? '统计在招与状态未知岗位的候选记录。' : rolePreferences.scope === 'following' ? '统计所关注岗位的候选记录。' : '统计全部岗位的候选记录，包含历史岗位。';
  text('role-note', note);
  renderFollowingPicker();
  return view;
}

function closeCandidate() {
  selectedCandidateId = null; candidateOrigin = null; recordRequest++; documentRequest++;
  byId('candidate-record').hidden = true;
  byId('candidate-list').hidden = false;
  byId('results-content').hidden = false;
  byId('stage-record-host').append(byId('candidate-record'));
}

function markdownView(text) {
  const body = node('div', 'document-markdown');
  const plain = value => value.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  let paragraph = [], bullets = null, code = null;
  const flush = () => { if (paragraph.length) { body.append(node('p', '', plain(paragraph.join('\n')))); paragraph = []; } };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      flush(); bullets = null;
      if (code) { body.append(node('pre', 'document-text', code.join('\n'))); code = null; } else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line), bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (heading) { flush(); bullets = null; body.append(node(`h${Math.min(6, heading[1].length + 3)}`, '', plain(heading[2]))); }
    else if (bullet) { flush(); if (!bullets) { bullets = node('ul'); body.append(bullets); } bullets.append(node('li', '', plain(bullet[1]))); }
    else if (/^>\s?/.test(line)) { flush(); bullets = null; body.append(node('blockquote', '', plain(line.replace(/^>\s?/, '')))); }
    else if (!line.trim()) { flush(); bullets = null; }
    else { bullets = null; paragraph.push(line); }
  }
  flush(); if (code) body.append(node('pre', 'document-text', code.join('\n')));
  return body;
}

function documentURL(candidate, document, download = false) {
  return `/api/candidates/document?${new URLSearchParams({ candidate, document, ...(download ? { download: '1' } : {}), ...(expectedWorkspaceKey ? { workspace: expectedWorkspaceKey } : {}) })}`;
}

async function openCandidate(candidate, origin = 'stage', trigger = null) {
  const pending = ++recordRequest;
  documentRequest++; selectedCandidateId = candidate.id;
  candidateOrigin = { source: origin, trigger, candidateId: candidate.id };
  const host = { decisions: 'decision-record-host', results: 'run-record-host', activity: 'activity-record-host', stage: 'stage-record-host' }[origin];
  byId(host).append(byId('candidate-record'));
  byId('candidate-list').hidden = origin === 'stage';
  byId('results-content').hidden = origin === 'results';
  if (origin === 'decisions') byId('decisions-content').hidden = true;
  byId('candidate-record').hidden = false;
  byId('back-to-list').textContent = { decisions: '返回本轮确认名单', results: '返回处理名单', activity: '返回近期流水', stage: '返回名单' }[origin];
  const content = byId('record-content');
  content.replaceChildren(node('p', 'muted', '正在读取候选资料…'));
  byId('back-to-list').focus({ preventScroll: true });
  try {
    const detail = await jsonRequest(`/api/candidates/detail?${new URLSearchParams({ candidate: candidate.id })}`);
    if (pending !== recordRequest) return;
    const heading = node('h3', 'record-name', detail.candidate.name);
    const facts = node('dl', 'record-facts');
    const identityFacts = [['岗位', detail.candidate.role]];
    if (detail.candidate.rawRole && detail.candidate.rawRole !== detail.candidate.role) identityFacts.push(['原岗位', detail.candidate.rawRole]);
    identityFacts.push(['原状态', detail.candidate.rawStatus ?? '状态冲突，请核对台账']);
    for (const [label, value] of identityFacts) {
      const row = node('div'); row.append(node('dt', '', label), node('dd', '', value)); facts.append(row);
    }
    const evaluation = node('details', 'record-evaluation'), evaluationFacts = node('dl', 'record-facts');
    evaluation.append(node('summary', 'panel-summary', '背景与评估'));
    for (const [label, value] of [['评级', detail.candidate.rating || '未评级'], ['现职 / 背景', detail.background || '未填写'], ['评估备注', detail.notes || '未填写'], ['来源轮次', detail.sourceRound || '未填写']]) {
      const row = node('div'); row.append(node('dt', '', label), node('dd', '', value)); evaluationFacts.append(row);
    }
    evaluation.append(evaluationFacts);
    const warnings = node('div', 'record-warnings');
    warnings.append(...detail.warnings.map(message => node('p', 'muted', message)));
    const documents = node('ul', 'document-list');
    const preview = node('section', 'document-preview'); preview.hidden = true;
    for (const document of detail.documents) {
      const item = node('li', 'document-row'), title = node('p', '', document.label);
      item.append(title);
      if (document.status !== 'ok') item.append(node('p', 'muted', document.message || '文件暂不可读'));
      else {
        const actions = node('div', 'document-actions');
        if (document.kind !== 'pdf') {
          const view = node('button', 'text-button', '查看'); view.type = 'button';
          view.addEventListener('click', async () => {
            const reading = ++documentRequest;
            preview.hidden = false; preview.replaceChildren(node('p', 'muted', '正在读取文档…'));
            try {
              if (workspaceBlocked) throw new Error('服务已指向其他工作区，请重新打开');
              const response = await fetch(documentURL(detail.candidate.id, document.id), { cache: 'no-store', signal: AbortSignal.timeout(10000), headers: workspaceHeaders() });
              if (!response.ok) { const data = await response.json(); if (data.error?.code === 'WORKSPACE_MISMATCH') blockWorkspace(); throw new Error(data.error?.message ?? '文档读取失败'); }
              const text = await response.text();
              if (reading !== documentRequest || selectedCandidateId !== detail.candidate.id) return;
              preview.replaceChildren(node('h4', '', document.label), document.kind === 'markdown' ? markdownView(text) : node('pre', 'document-text', text));
            } catch (error) {
              if (reading === documentRequest && selectedCandidateId === detail.candidate.id) preview.replaceChildren(node('p', 'record-error', error.message));
            }
          });
          actions.append(view);
        }
        const link = node('a', 'text-button', document.kind === 'pdf' ? '打开 PDF' : '新窗口打开');
        link.href = documentURL(detail.candidate.id, document.id); link.target = '_blank'; link.rel = 'noopener noreferrer';
        const download = node('a', 'text-button', '下载'); download.href = documentURL(detail.candidate.id, document.id, true); download.download = '';
        actions.append(link, download); item.append(actions);
      }
      documents.append(item);
    }
    if (!detail.documents.length) documents.append(node('li', 'muted', '暂无已关联资料。'));
    content.replaceChildren(heading, facts, warnings, node('h4', '', '本地资料'), documents, preview, evaluation);
  } catch (error) {
    if (pending === recordRequest) content.replaceChildren(node('p', 'record-error', error.message));
  }
}

function updateManagedStatus() {
  const role = roleInfo?.roles.find(item => item.name === byId('managed-role').value);
  const known = roleInfo?.allowedStatuses.includes(role?.status);
  const values = roleInfo?.allowedStatuses.map(status => [status, status]) ?? [];
  if (!known) values.unshift(['', role?.status ? `请选择状态（当前：${role.status}）` : '请选择状态']);
  options(byId('managed-status'), values, known ? role.status : '');
}

async function openRoleManager() {
  const pending = ++roleRequest;
  const form = byId('role-manager');
  form.hidden = false; byId('cancel-role').disabled = false; byId('manage-roles').setAttribute('aria-expanded', 'true');
  byId('role-result').textContent = '正在读取当前岗位配置…';
  byId('save-role').disabled = true; roleInfo = null;
  try {
    const [info, session] = await Promise.all([jsonRequest('/api/roles'), jsonRequest('/api/session')]);
    if (pending !== roleRequest) return;
    roleInfo = info; csrfToken = session.csrfToken;
    const selected = info.roles.some(role => role.name === roleSelect.value) ? roleSelect.value : info.roles[0]?.name ?? '';
    options(byId('managed-role'), info.roles.map(role => [role.name, role.name]), selected);
    updateManagedStatus();
    byId('save-role').disabled = !info.roles.length;
    byId('role-result').textContent = info.roles.length ? '' : '当前标准表尚未配置岗位。';
    byId('managed-role').focus({ preventScroll: true });
  } catch (error) { if (pending === roleRequest) byId('role-result').textContent = error.message; }
}

function closeRoleManager() {
  roleRequest++; roleInfo = null;
  byId('role-manager').hidden = true; byId('manage-roles').setAttribute('aria-expanded', 'false');
  byId('manage-roles').focus({ preventScroll: true });
}

const stageButtons = new Map(STAGES.map(stage => {
  const button = byId('stage-template').content.firstElementChild.cloneNode(true);
  button.id = `stage-${stage.id}`;
  button.dataset.stage = stage.id;
  button.querySelector('.stage-name').textContent = stage.label;
  button.addEventListener('click', () => {
    if (candidateOrigin?.source === 'stage') closeCandidate();
    selectedStage = selectedStage === stage.id ? null : stage.id;
    if (snapshot) renderStages();
  });
  byId('stages').append(button);
  return [stage.id, button];
}));

function stepLabel(step, run) {
  if (step.status !== 'running') return STEP_LABELS[step.status];
  return { waiting: '当前 · 等待', cancelled: '已停止', failed: '已中断' }[run.status] ?? STEP_LABELS.running;
}

function selectedRun() {
  return snapshot?.runs?.find(run => run.id === taskSelection.runId);
}

function flash(element) {
  if (!document.hidden && pageActive && !motionQuery.matches) element.dataset.update = element.dataset.update === 'a' ? 'b' : 'a';
}

function resetActivity(runId) {
  activityRequest++; activityAbort?.abort(); activityAbort = null;
  activityState = freshActivity(runId);
  byId('activity-list').replaceChildren(); delete byId('activity-list').dataset.run; delete byId('activity-list').dataset.revision;
}

async function loadActivity(force = false) {
  const run = selectedRun();
  if (!run || document.hidden || !pageActive || disconnected || workspaceBlocked) return;
  const revision = run.resultSummary?.revision ?? 0, workspaceKey = expectedWorkspaceKey;
  if (!force && (activityState.status === 'loading' || activityState.requestedRevision === revision || Date.now() < activityState.retryAt)) return;
  const pending = ++activityRequest;
  activityAbort?.abort(); activityAbort = new AbortController();
  activityState.status = 'loading'; activityState.requestedRevision = revision;
  renderActivity(run);
  try {
    const response = await jsonRequest(`/api/runs/activity?${new URLSearchParams({ run: run.id })}`, { signal: AbortSignal.any([activityAbort.signal, AbortSignal.timeout(10000)]) });
    if (pending !== activityRequest || selectedRun()?.id !== run.id || workspaceKey !== expectedWorkspaceKey || workspaceBlocked) return;
    if (response.runId !== run.id || !Number.isSafeInteger(response.revision) || (response.items !== null && (!Array.isArray(response.items) || response.items.length > 3))) throw new Error('动态响应格式不兼容');
    for (const item of response.items ?? []) {
      const identity = JSON.parse(item.candidateId);
      if (!Array.isArray(identity) || identity.length !== 2 || identity.some(value => typeof value !== 'string')) throw new Error('动态中的姓名或原岗位格式无效');
    }
    const currentRevision = selectedRun().resultSummary?.revision ?? 0;
    if (response.revision < currentRevision) {
      activityState.status = 'stale'; activityState.requestedRevision = null; activityState.retryAt = Date.now() + 1000;
    } else if (response.revision > currentRevision) {
      activityState.status = 'ahead'; activityState.ahead = response;
    } else acceptActivity(response);
  } catch (error) {
    if (pending !== activityRequest || workspaceBlocked) return;
    activityState.status = 'error'; activityState.error = error.message;
    activityState.requestedRevision = null; activityState.retryAt = Date.now() + 2000;
  }
  if (pending === activityRequest) renderActivity(selectedRun());
}

function acceptActivity(response) {
  activityState.data = response.items; activityState.revision = response.revision;
  activityState.requestedRevision = response.revision; activityState.status = 'ready'; activityState.ahead = null;
}

function syncActivity(run) {
  if (!run) {
    if (activityState.status === 'loading') { activityRequest++; activityAbort?.abort(); activityState.status = 'idle'; activityState.requestedRevision = null; }
    return;
  }
  const revision = run.resultSummary?.revision ?? 0;
  if (activityState.ahead?.revision === revision) acceptActivity(activityState.ahead);
  else if (activityState.ahead && activityState.ahead.revision < revision) { activityState.ahead = null; activityState.requestedRevision = null; }
  renderActivity(run);
  if (byId('execution-records').open) void loadActivity();
}

function renderActivity(run) {
  byId('run-activity').hidden = !run;
  if (!run) return;
  const state = activityState, retained = state.data !== undefined;
  const sourceStale = snapshot.sources.runs.status === 'stale' || snapshot.sources.runs.stale === true;
  const message = disconnected ? retained ? '连接断开，以下是上次读取的动态。' : '连接断开，最近动态尚未成功读取。' : state.status === 'error' ? `动态读取失败：${state.error}${retained ? '；以下保留上次记录。' : '；可重试。'}` : state.status === 'stale' ? '动态版本较旧，正在重新读取。' : state.status === 'ahead' ? '新记录已写入，等待任务汇总同步。' : !retained ? '正在读取最近动态…' : sourceStale ? '任务源陈旧，以下保留上次记录。' : state.data === null ? '此任务尚未记录处理名单。' : !state.data.length ? '本轮已明确记录 0 条处理记录。' : '';
  text('activity-status', message); byId('activity-status').hidden = !message;
  if (byId('activity-status').dataset.state !== state.status) byId('activity-status').dataset.state = state.status;
  byId('retry-activity').hidden = !['error', 'stale'].includes(state.status);
  const list = byId('activity-list');
  if (state.data?.length && (list.contains(document.activeElement) || candidateOrigin?.source === 'activity') && list.dataset.revision !== String(state.revision)) {
    text('activity-status', '最近动态已有更新，返回后显示。'); byId('activity-status').hidden = false; return;
  }
  const previous = new Map([...list.children].map(item => [item.dataset.receipt, item]));
  const baseline = list.dataset.run === run.id && list.dataset.revision !== undefined;
  const changed = baseline && list.dataset.revision !== String(state.revision);
  const items = (state.data ?? []).map(receipt => {
    const [name, rawRole] = JSON.parse(receipt.candidateId);
    const candidate = snapshot.candidates?.find(value => value.id === receipt.candidateId);
    const signature = JSON.stringify([receipt, Boolean(candidate)]);
    let item = previous.get(receipt.id);
    if (!item) { item = node('li', 'activity-item'); item.dataset.receipt = receipt.id; }
    if (item.dataset.content !== signature) {
      let button = item.querySelector('button');
      if (!button) {
        button = node('button', 'person-name candidate-link'); button.type = 'button';
        button.addEventListener('click', () => { const current = snapshot.candidates?.find(value => value.id === button.dataset.candidate); if (current) void openCandidate(current, 'activity', button); else openRunResults('all'); });
        const heading = node('div', 'activity-person'); heading.append(button, node('span', 'result-attention'));
        item.append(heading, node('p', 'result-role'), node('p', 'activity-action'), node('p', 'activity-outcome'), node('p', 'activity-next'), node('time', 'result-time'));
      }
      button.textContent = name; button.dataset.candidate = receipt.candidateId;
      button.setAttribute('aria-label', `${candidate ? '查看候选资料' : '查看本轮完整记录'}：${name}`);
      item.dataset.attention = receipt.attention;
      item.querySelector('.result-attention').textContent = { decision: '需你确认', notice: '提醒', none: '已记录' }[receipt.attention];
      item.querySelector('.result-role').textContent = `原岗位：${rawRole}`;
      item.querySelector('.activity-action').textContent = receipt.action;
      item.querySelector('.activity-outcome').textContent = receipt.outcome;
      const next = item.querySelector('.activity-next'); next.textContent = receipt.nextAction ? `下一步：${receipt.nextAction}` : ''; next.hidden = !receipt.nextAction;
      const timestamp = item.querySelector('time'); timestamp.textContent = time(receipt.updatedAt); timestamp.dateTime = receipt.updatedAt;
      item.dataset.content = signature;
      if (changed) flash(item);
    }
    return item;
  });
  for (const item of previous.values()) if (!items.includes(item)) item.remove();
  let position = list.firstElementChild;
  for (const item of items) { if (item !== position) list.insertBefore(item, position); position = item.nextElementSibling; }
  if (list.dataset.run !== run.id) list.dataset.run = run.id;
  if (state.revision !== null && list.dataset.revision !== String(state.revision)) list.dataset.revision = String(state.revision);
}

function resultVersion(run) {
  return JSON.stringify([run.id, run.resultSummary?.revision ?? null]);
}

function resetRunResults(runId) {
  resultsRequest++;
  if (['results', 'decisions'].includes(candidateOrigin?.source)) closeCandidate();
  resultsState = freshResults(runId);
  for (const id of ['result-list', 'decision-list']) {
    byId(id).replaceChildren();
    delete byId(id).dataset.content;
  }
  byId('decisions-content').hidden = true;
}

function groupRunResults(results) {
  if (results === null) return null;
  const people = new Map(), attentionOrder = { decision: 0, notice: 1, none: 2 };
  const receipts = new Map(results.map((receipt, order) => [receipt.id, { ...receipt, order }]));
  for (const receipt of receipts.values()) {
    const identity = JSON.parse(receipt.candidateId);
    if (!Array.isArray(identity) || identity.length !== 2 || identity.some(value => typeof value !== 'string')) throw new Error('处理名单中的姓名或原岗位格式无效');
    const person = people.get(receipt.candidateId) ?? { candidateId: receipt.candidateId, name: identity[0], rawRole: identity[1], receipts: [] };
    person.receipts.push(receipt);
    people.set(person.candidateId, person);
  }
  const latestFirst = (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.order - a.order;
  for (const person of people.values()) {
    person.receipts.sort((a, b) => attentionOrder[a.attention] - attentionOrder[b.attention] || latestFirst(a, b));
    person.attention = person.receipts[0].attention;
  }
  return [...people.values()].sort((a, b) => attentionOrder[a.attention] - attentionOrder[b.attention] || latestFirst(a.receipts[0], b.receipts[0]));
}

async function loadRunResults() {
  const run = selectedRun();
  if (!run || resultsState.runId !== run.id || document.hidden || !pageActive || disconnected || workspaceBlocked) return;
  const pending = ++resultsRequest, version = resultVersion(run), workspaceKey = expectedWorkspaceKey;
  resultsState.status = 'loading'; resultsState.error = null; resultsState.requestedVersion = version;
  renderRunResults(run);
  try {
    const response = await jsonRequest(`/api/runs/results?${new URLSearchParams({ run: run.id })}`);
    if (pending !== resultsRequest || resultsState.runId !== run.id || workspaceKey !== expectedWorkspaceKey || workspaceBlocked) return;
    const current = selectedRun();
    if (!current || resultVersion(current) !== version) {
      resultsState.status = 'idle'; resultsState.requestedVersion = null;
      renderRunResults(current);
      return;
    }
    if (response.runId !== run.id || (response.results !== null && !Array.isArray(response.results))) throw new Error('处理名单响应格式不兼容');
    if (response.revision !== (run.resultSummary?.revision ?? 0)) throw new Error('处理记录版本已变化，等待任务汇总同步后重试');
    const data = groupRunResults(response.results);
    if (run.resultSummary && (!Array.isArray(data) || data.filter(person => person.attention === 'decision').length !== run.resultSummary.decisions)) throw new Error('确认名单与任务汇总不一致，请重试');
    resultsState.data = data; resultsState.updatedAt = response.updatedAt;
    resultsState.loadedVersion = version; resultsState.status = 'ready';
    renderRunResults(current);
  } catch (error) {
    if (pending !== resultsRequest || resultsState.runId !== run.id || workspaceBlocked) return;
    resultsState.status = 'error'; resultsState.error = error.message;
    renderRunResults(selectedRun());
  }
}

function receiptView(receipt, run, showNext = true) {
  const view = node('div', 'result-receipt');
  const action = node('p', 'result-action', receipt.action);
  const step = run.steps.find(step => step.id === receipt.stepId);
  action.append(node('span', 'result-step', ` · ${step?.label ?? receipt.stepId}`));
  view.append(action, node('p', 'result-outcome', receipt.outcome));
  if (showNext) view.append(node('p', 'result-next', `下一步：${receipt.nextAction ?? '未记录'}`));
  const timestamp = node('time', 'result-time', time(receipt.updatedAt)); timestamp.dateTime = receipt.updatedAt;
  view.append(timestamp);
  return view;
}

function renderResultList(run) {
  const list = byId('result-list'), data = resultsState.data;
  const signature = JSON.stringify([run.id, resultsState.loadedVersion, resultsState.filter, snapshot.candidates?.map(candidate => candidate.id)]);
  if (list.dataset.content === signature) return;
  list.dataset.content = signature;
  const active = list.contains(document.activeElement) ? document.activeElement.dataset.resultFocus : null;
  const people = data?.filter(person => resultsState.filter === 'all' || person.attention === resultsState.filter) ?? [];
  const items = people.map(person => {
    const item = node('li', 'result-person'); item.dataset.attention = person.attention;
    const heading = node('div', 'result-person-heading');
    const candidate = snapshot.candidates?.find(candidate => candidate.id === person.candidateId);
    let name;
    if (candidate) {
      name = node('button', 'person-name candidate-link result-candidate-link', person.name); name.type = 'button';
      name.dataset.candidate = person.candidateId; name.dataset.resultFocus = `name:${person.candidateId}`;
      name.setAttribute('aria-label', `查看 ${person.name} 的候选资料`);
      name.addEventListener('click', () => {
        const current = snapshot.candidates?.find(candidate => candidate.id === person.candidateId);
        if (current) void openCandidate(current, 'results', name);
      });
    } else name = node('strong', 'person-name', person.name);
    heading.append(name, node('span', 'result-attention', { decision: '需你确认', notice: '提醒', none: '已记录' }[person.attention]));
    item.append(heading, node('p', 'result-role', `原岗位：${person.rawRole}`));
    if (!candidate) item.append(node('p', 'result-unavailable', '尚无可打开的台账资料'));
    const receipts = resultsState.filter === 'decision' ? person.receipts.filter(receipt => receipt.attention === 'decision') : person.receipts;
    item.append(receiptView(receipts[0], run));
    if (receipts.length > 1) {
      const details = node('details', 'result-history'), summary = node('summary', 'result-history-summary', `查看其余 ${receipts.length - 1} 条处理记录`);
      summary.dataset.resultFocus = `history:${person.candidateId}`;
      details.open = resultsState.expanded.has(person.candidateId);
      details.append(summary, ...receipts.slice(1).map(receipt => receiptView(receipt, run)));
      details.addEventListener('toggle', () => {
        if (resultsState.runId !== run.id || !details.isConnected) return;
        if (details.open) resultsState.expanded.add(person.candidateId); else resultsState.expanded.delete(person.candidateId);
      });
      item.append(details);
    }
    return item;
  });
  if (!items.length && Array.isArray(data)) items.push(node('li', 'result-empty', data.length ? resultsState.filter === 'decision' ? '当前没有需要你确认的人选。' : '当前没有仅需提醒的人选；需确认事项请查看“需确认”。' : '本轮已明确记录 0 人。'));
  list.replaceChildren(...items);
  if (active) [...list.querySelectorAll('[data-result-focus]')].find(element => element.dataset.resultFocus === active)?.focus({ preventScroll: true });
}

function renderDecisionList(run, people) {
  const list = byId('decision-list'), state = resultsState;
  const signature = JSON.stringify([run.id, state.loadedVersion, state.showAllDecisions, people.map(person => snapshot.candidates?.find(candidate => candidate.id === person.candidateId))]);
  if (list.dataset.content === signature) return;
  if (candidateOrigin?.source === 'decisions') return;
  const active = list.contains(document.activeElement) ? document.activeElement.dataset.decisionFocus : null;
  const previous = new Map([...list.children].map(item => [item.dataset.candidate, item]));
  const items = (state.showAllDecisions ? people : people.slice(0, 5)).map(person => {
    const candidate = snapshot.candidates?.find(candidate => candidate.id === person.candidateId);
    const receipts = person.receipts.filter(receipt => receipt.attention === 'decision');
    const content = JSON.stringify([receipts, candidate, run.steps.map(step => [step.id, step.label])]);
    let item = previous.get(person.candidateId);
    if (!item) { item = node('li', 'decision-person'); item.dataset.candidate = person.candidateId; }
    if (item.dataset.content === content) return item;
    const heading = node('div', 'decision-person-heading');
    let name;
    if (candidate) {
      name = node('button', 'person-name candidate-link', person.name); name.type = 'button';
      name.dataset.candidate = person.candidateId; name.dataset.decisionFocus = `name:${person.candidateId}`;
      name.setAttribute('aria-label', `查看 ${person.name} 的候选资料`);
      name.addEventListener('click', () => {
        const current = snapshot.candidates?.find(candidate => candidate.id === person.candidateId);
        if (current) void openCandidate(current, 'decisions', name);
      });
    } else name = node('strong', 'person-name', person.name);
    const title = node('h3', 'decision-name'); title.append(name);
    const status = node('span', 'decision-status', candidate ? candidateStatus(candidate) : '原状态未知');
    status.title = candidate ? `台账原状态：${candidateStatus(candidate)}` : '尚无关联台账记录，原状态未知';
    status.setAttribute('aria-label', status.title);
    heading.append(title, status);
    const meta = node('p', 'decision-meta', candidate?.role ?? person.rawRole);
    const request = node('div', 'decision-request'), next = node('ul', 'decision-next');
    next.append(...receipts.map(receipt => node('li', '', receipt.nextAction || '尚未记录，请查看依据')));
    request.append(node('p', 'decision-label', '需要你决定'), next);
    const footer = node('div', 'decision-footer');
    if (candidate) {
      const view = node('button', 'secondary-button decision-profile', '查看资料'); view.type = 'button';
      view.dataset.candidate = person.candidateId; view.dataset.decisionFocus = `profile:${person.candidateId}`;
      view.setAttribute('aria-label', `查看 ${person.name} 的候选资料`);
      view.addEventListener('click', () => {
        const current = snapshot.candidates?.find(candidate => candidate.id === person.candidateId);
        if (current) void openCandidate(current, 'decisions', view);
      });
      footer.append(view);
    } else footer.append(node('p', 'decision-unavailable', '尚无可打开的台账资料'));
    const details = node('details', 'decision-evidence'), summary = node('summary', 'decision-evidence-summary', '查看依据');
    summary.dataset.decisionFocus = `evidence:${person.candidateId}`;
    summary.setAttribute('aria-label', `查看 ${person.name} 的依据，共 ${receipts.length} 条确认记录`);
    details.open = state.decisionExpanded.has(person.candidateId);
    details.append(summary, ...receipts.map(receipt => receiptView(receipt, run, false)));
    details.addEventListener('toggle', () => {
      if (resultsState !== state || !details.isConnected) return;
      if (details.open) state.decisionExpanded.add(person.candidateId); else state.decisionExpanded.delete(person.candidateId);
    });
    footer.append(details);
    item.replaceChildren(heading, meta, request, footer);
    item.dataset.content = content;
    return item;
  });
  for (const item of previous.values()) if (!items.includes(item)) item.remove();
  let position = list.firstElementChild;
  for (const item of items) { if (item !== position) list.insertBefore(item, position); position = item.nextElementSibling; }
  state.decisionExpanded = new Set([...state.decisionExpanded].filter(id => people.some(person => person.candidateId === id)));
  list.dataset.content = signature;
  if (active) [...list.querySelectorAll('[data-decision-focus]')].find(element => element.dataset.decisionFocus === active)?.focus({ preventScroll: true });
}

function renderRunResults(run) {
  const summary = byId('run-result-summary'), region = byId('run-results'), state = resultsState;
  const historical = run && snapshot?.runs?.some(value => value.createdAt > run.createdAt || (value.createdAt === run.createdAt && value.id < run.id));
  const round = historical ? '该任务' : '本轮';
  const stale = workspaceBlocked || disconnected || snapshot?.sources.runs.status !== 'ok' || snapshot?.sources.runs.stale === true;
  summary.hidden = !run; region.hidden = !run || !state.open;
  text('decisions-scope', historical ? `该任务记录 · ${shortTime(run.createdAt)}。有新任务，当前保留所选记录。` : '仅此任务 · 岗位筛选不改变本轮');
  text('run-results-heading', `${round}处理记录`);
  if (!run) {
    if (state.status === 'loading') { resultsRequest++; state.status = 'idle'; state.requestedVersion = null; }
    byId('decisions-content').hidden = true;
    byId('retry-decisions').hidden = true;
    byId('decisions-count').hidden = true;
    text('decisions-status', workspaceBlocked ? '工作区连接已变化，请重新打开看板。' : disconnected ? '连接断开，确认事项未知。' : taskSelection.runId ? '所选任务暂不可读，确认事项未知。' : snapshot?.runs === null ? '任务读取失败，确认事项未知。' : '尚无任务记录，确认事项未知。');
    byId('decisions-status').hidden = false;
    return;
  }
  const counts = run.resultSummary, version = resultVersion(run);
  if (state.status === 'loading' && state.requestedVersion !== version) { resultsRequest++; state.status = 'idle'; state.requestedVersion = null; }
  const decisions = Number.isSafeInteger(counts?.decisions) && counts.decisions >= 0 ? counts.decisions : null;
  const count = byId('decisions-count');
  count.hidden = stale || decisions === null || state.status === 'error';
  text(count, decisions === null ? '' : String(decisions));
  count.setAttribute('aria-label', `${round}需确认 ${decisions ?? '未知'} 人`);
  text('run-result-total', counts == null ? '未记录' : `${counts.total} 人`);
  text('run-result-decisions', decisions === null ? '未记录' : `${decisions} 人`);
  for (const id of ['show-run-results', 'show-run-decisions']) if (byId(id).getAttribute('aria-expanded') !== String(state.open)) byId(id).setAttribute('aria-expanded', String(state.open));
  byId('result-stale-note').hidden = !stale;
  text('result-stale-note', disconnected ? '连接断开，人数与名单以最近一次成功读取为准。' : '任务源陈旧，人数与名单以最近一次成功读取为准。');
  const current = state.loadedVersion === version && state.status === 'ready';
  const people = current && Array.isArray(state.data) ? state.data.filter(person => person.receipts.some(receipt => receipt.attention === 'decision')) : [];
  const decisionMessage = workspaceBlocked ? '工作区连接已变化，请重新打开看板；确认名单已停止更新。' : disconnected ? '连接断开，当前确认事项未知；重新连接后更新。' : stale ? '任务源暂不可用，当前确认事项未知；等待更新。' : counts === undefined ? '此版本未提供确认事项汇总，可在执行记录中查看已有记录。' : counts === null ? `${round}尚未记录确认事项。` : decisions === null ? `${round}确认事项数量未知，可在执行记录中查看已有记录。` : decisions === 0 ? `${round}没有需确认记录。` : state.status === 'error' ? `确认名单读取失败：${state.error}。请重试。` : !current ? `正在${state.data === undefined ? '读取' : '更新'}${round}确认名单…` : '';
  text('decisions-status', decisionMessage); byId('decisions-status').hidden = !decisionMessage;
  byId('decisions-status').dataset.state = stale || state.status === 'error' ? 'error' : state.status;
  byId('retry-decisions').hidden = stale || decisions === null || decisions === 0 || state.status !== 'error';
  byId('decisions-content').hidden = stale || decisions === null || decisions === 0 || !current || candidateOrigin?.source === 'decisions';
  if (decisions === 0 || counts == null) {
    state.decisionExpanded.clear(); state.showAllDecisions = false;
    if (byId('decision-list').contains(document.activeElement)) byId('decisions-heading').focus({ preventScroll: true });
    byId('decision-list').replaceChildren(); delete byId('decision-list').dataset.content;
  } else if (current) renderDecisionList(run, people);
  const more = byId('show-more-decisions');
  more.hidden = people.length <= 5;
  text(more, state.showAllDecisions ? '收起其余人选' : `查看其余 ${Math.max(0, people.length - 5)} 人`);
  more.setAttribute('aria-expanded', String(state.showAllDecisions));
  if (state.open) {
    for (const button of byId('results-filters').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.resultsFilter === state.filter));
    const status = byId('results-status');
    status.dataset.state = state.status;
    const message = state.status === 'loading' ? state.data === undefined ? '正在读取处理名单…' : '正在更新处理名单；以下保留上次读取的记录。' : state.status === 'error' ? `处理名单读取失败：${state.error}。${state.data !== undefined ? '以下是上次成功读取的记录（陈旧），未代表本次更新。' : '可重试读取。'}` : state.data === null ? '此任务尚未记录处理名单。' : state.data !== undefined ? `已读取 ${state.data.length} 人的处理记录${state.updatedAt ? ` · 收据更新 ${time(state.updatedAt)}` : ''}` : '等待读取处理名单。';
    text(status, message);
    byId('retry-results').hidden = state.status !== 'error';
    byId('results-filters').hidden = !Array.isArray(state.data) || !state.data.length;
    byId('result-list').hidden = !Array.isArray(state.data);
    byId('result-list').dataset.state = ['loading', 'error'].includes(state.status) ? 'stale' : 'ready';
    renderResultList(run);
  }
  if (!stale && (state.open || decisions > 0) && state.requestedVersion !== version) void loadRunResults();
}

function openRunResults(filter) {
  const run = selectedRun();
  if (!run) return;
  if (['results', 'decisions'].includes(candidateOrigin?.source)) closeCandidate();
  byId('execution-records').open = true;
  resultsState.open = true; resultsState.filter = filter;
  renderRunResults(run);
}

function renderRuns() {
  const runs = snapshot.runs === null ? null : [...snapshot.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const hold = Boolean(selectedCandidateId || selectedStage || resultsState.open || resultsState.decisionExpanded.size || resultsState.showAllDecisions || byId('execution-records').open || !byId('role-manager').hidden || byId('steps-detail').open || document.activeElement === runSelect);
  const choice = selectTask(runs, taskSelection, hold);
  if (hold && taskSelection.mode === 'live' && taskSelection.runId && choice.newerRunId) choice.selection = { mode: 'pinned', runId: taskSelection.runId };
  taskSelection = choice.selection;
  const run = choice.run, selectedRunId = taskSelection.runId;
  const labels = (runs ?? []).map(value => `${value.label}${value.role ? ` · ${value.role}` : ''}`);
  const values = (runs ?? []).map((value, index) => [value.id, `${labels[index]} · ${shortTime(value.createdAt)}${labels.filter(label => label === labels[index]).length > 1 ? ` · ${value.id}` : ''}`]);
  if (selectedRunId && !run) values.unshift([selectedRunId, runs === null ? '所选任务暂不可读' : '所选任务记录已移除']);
  if (!values.length) values.push(['', runs === null ? '进度读取失败' : '尚无任务进度记录']);
  options(runSelect, values, selectedRunId ?? ''); runSelect.disabled = !runs?.length;
  for (const [id, mode] of [['follow-live', 'live'], ['pin-run', 'pinned']]) if (byId(id).getAttribute('aria-pressed') !== String(taskSelection.mode === mode)) byId(id).setAttribute('aria-pressed', String(taskSelection.mode === mode));
  byId('latest-run').hidden = taskSelection.mode === 'live' && !choice.newerRunId;
  const notice = [selectionMessage, choice.newerRunId ? '新任务可查看；当前记录保持选定。' : taskSelection.mode === 'pinned' ? '已固定所选任务，自动读取该任务的更新。' : document.hidden ? '后台低频读取；返回后恢复跟随。' : '自动跟随最新创建的任务。'].filter(Boolean).join(' ');
  text('selection-note', notice); byId('selection-note').hidden = false; writeTaskURL();
  if (resultsState.runId !== selectedRunId) { closeCandidate(); resetRunResults(selectedRunId); resetActivity(selectedRunId); byId('steps-detail').open = false; }
  const transition = run ? JSON.stringify([run.status, run.steps.map(step => [step.id, step.status]), run.resultSummary?.revision ?? 0]) : null;
  if (run && displayedRun?.id === run.id && displayedRun.signature !== transition) flash(byId('task-card'));
  displayedRun = run ? { id: run.id, signature: transition } : null;
  renderRunResults(run); syncActivity(run); byId('run-activity').hidden = !run;
  text('run-id', run?.id ?? selectedRunId ?? '—'); text('run-owner', run?.ownerSessionId ?? '未绑定');
  byId('progress-area').hidden = !run; byId('workflow-name').hidden = !run;
  text('run-time', run ? `最后记录 ${time(run.updatedAt)}${snapshot.sources.runs.status === 'stale' ? ' · 陈旧记录' : ''}` : '任务更新时间未知');
  text('task-recorded', `最后记录 · ${run ? time(run.updatedAt) : '未知'}`);
  const sourceStale = snapshot.sources.runs.status === 'stale' || snapshot.sources.runs.stale === true;
  text('task-sync', disconnected ? '连接断开 · 保留记录' : document.hidden ? '后台低频读取' : sourceStale ? '读取正常 · 任务源陈旧' : snapshot.sources.runs.status === 'ok' ? '读取正常' : snapshot.sources.runs.status === 'missing' ? '读取正常 · 尚无任务' : '任务源读取异常');
  const syncing = String(Boolean(run?.status === 'running' && taskSelection.mode === 'live' && !disconnected && !sourceStale && snapshot.sources.runs.status === 'ok' && !document.hidden && pageActive));
  if (byId('task-card').dataset.syncing !== syncing) byId('task-card').dataset.syncing = syncing;
  const status = byId('run-state');
  if (!run) {
    const missing = selectedRunId !== null && runs !== null;
    text('run-state', runs === null ? '读取失败' : missing ? '记录已移除' : '无记录'); status.dataset.state = runs === null ? 'error' : 'missing';
    text('task-position', '工作区记录');
    text('current-step', runs === null ? '任务状态未知' : missing ? '所选记录已移除' : '尚无任务进度记录');
    text('task-reason', runs === null ? '无法读取任务进度，恢复后继续同步。' : missing ? '可在执行记录中选择其他任务。' : '工作流开始记录后会在这里显示步骤。');
    byId('task-reason').hidden = false;
    text('run-context', byId('task-reason').textContent); return;
  }
  text('run-state', RUN_LABELS[run.status]); status.dataset.state = run.status;
  text('workflow-name', `${run.label}${run.role ? ` · ${run.role}` : ''}`);
  text('run-context', run.ownerSessionId ? '工作区任务，已记录绑定会话；当前网页未核验会话归属。' : '工作区记录，尚未绑定当前会话。');
  const current = run.steps.find(step => step.status === 'running') ?? (run.status === 'failed' ? run.steps.find(step => step.status === 'failed') : null);
  const completed = run.steps.filter(step => step.status === 'completed').length, skipped = run.steps.filter(step => step.status === 'skipped').length;
  text('task-position', current ? `${run.status === 'waiting' ? '停留步骤' : run.status === 'running' ? '当前步骤' : '最后步骤'} ${run.steps.indexOf(current) + 1} / ${run.steps.length}` : `共 ${run.steps.length} 个步骤`);
  text('current-step', current?.label ?? (run.status === 'completed' ? '任务已完成' : '当前无执行中步骤'));
  const reason = run.reason ?? current?.reason ?? { waiting: '任务等待后续处理。', failed: '任务失败，保留最后记录。', cancelled: '任务已取消，保留最后记录。' }[run.status] ?? '';
  text('task-reason', reason); byId('task-reason').hidden = !reason;
  text('completion-count', `已完成 ${completed} / ${run.steps.length} · 已跳过 ${skipped}`);
  text('steps-summary', byId('steps-detail').open ? '收起全部步骤' : '查看全部步骤');
  const signature = JSON.stringify([run.id, run.status, run.steps]), track = byId('step-track'), steps = byId('steps');
  if (track.dataset.content === signature) return;
  const sameRun = track.dataset.run === run.id;
  if (!sameRun) { track.replaceChildren(); steps.replaceChildren(); }
  track.dataset.content = signature; track.dataset.run = run.id; track.dataset.runState = run.status; steps.dataset.runState = run.status;
  track.setAttribute('aria-label', `共 ${run.steps.length} 个步骤，已完成 ${completed}，已跳过 ${skipped}；${RUN_LABELS[run.status]}`);
  for (const [index, step] of run.steps.entries()) {
    let segment = track.children[index], item = steps.children[index];
    if (!segment) {
      segment = node('li', 'track-segment'); segment.append(node('span', 'sr-only')); track.append(segment);
      item = node('li', 'step-row step'); const content = node('div'); content.append(node('p', 'step-title'), node('p', 'step-reason'));
      const number = node('span', 'step-index step-number', String(index + 1)); number.setAttribute('aria-hidden', 'true');
      item.append(number, content, node('span', 'step-state')); steps.append(item);
    }
    if (sameRun && segment.dataset.state !== step.status) flash(item);
    segment.dataset.state = step.status; segment.title = `${index + 1}. ${step.label} · ${stepLabel(step, run)}`; segment.firstElementChild.textContent = segment.title;
    item.dataset.state = step.status;
    if (step.status === 'running') item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    item.querySelector('.step-title').textContent = step.label; item.querySelector('.step-reason').textContent = step.reason ?? '';
    item.querySelector('.step-reason').hidden = !step.reason; item.querySelector('.step-state').textContent = stepLabel(step, run);
  }
}

function renderStages(announce = false, view = currentRoleView()) {
  text('total', view.total === null ? '—' : String(view.total));
  const ledgerSource = snapshot.sources.ledger.status;
  text('ledger-state', ledgerSource === 'stale' ? '以下保留上次候选记录（陈旧）。' : view.total === null ? view.selectionMissing ? '所选岗位未在当前源中，记录数未知。' : '台账尚未成功读取，记录数未知。' : `台账更新 ${time(snapshot.ledgerUpdatedAt)} · ${view.label}`);
  const unclassified = view.stages.find(stage => stage.id === 'unclassified').count;
  const notes = unclassified > 0 ? [`含 ${unclassified} 条未归类候选记录，保留原状态。`] : [];
  if (view.total === null) notes.unshift(view.selectionMissing ? '所选岗位已不在当前源中，候选记录数未知。' : '候选记录数未知，等待成功读取台账。');
  else if (view.total === 0) notes.unshift(rolePreferences.role ? '这个岗位还没有候选记录。' : '当前岗位范围没有候选记录。');
  const noteSignature = JSON.stringify(notes);
  if (byId('candidate-notes').dataset.content !== noteSignature) {
    byId('candidate-notes').dataset.content = noteSignature;
    byId('candidate-notes').replaceChildren(...notes.map(message => node('p', '', message)));
  }
  for (const stage of view.stages) {
    const button = stageButtons.get(stage.id);
    const expanded = selectedStage === stage.id;
    text(button.querySelector('.stage-number'), stage.count === null ? '—' : String(stage.count));
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', `${stage.label}，${stage.count === null ? '候选记录数未知' : `${stage.count} 条候选记录`}，${expanded ? '收起' : '展开'}名单`);
  }
  const detail = byId('candidate-detail');
  detail.hidden = selectedStage === null;
  if (selectedStage !== null) {
    const stage = view.stages.find(stage => stage.id === selectedStage);
    const members = view.candidates?.filter(candidate => candidate.stage === selectedStage);
    text('detail-title', stage.label);
    text('detail-count', stage.count === null ? '记录数未知' : `${stage.count} 条候选记录`);
    const signature = JSON.stringify([rolePreferences.scope, rolePreferences.following, rolePreferences.role, selectedStage, stage.count, members]);
    const list = byId('candidate-list');
    if (list.dataset.content !== signature) {
      list.dataset.content = signature;
      const candidates = (members ?? []).map(candidate => {
        const item = node('li', 'candidate-row candidate');
        const body = node('div'), heading = node('div', 'person-heading candidate-heading');
        const name = node('button', 'person-name candidate-name candidate-link', candidate.name); name.type = 'button'; name.dataset.candidate = candidate.id;
        name.setAttribute('aria-label', `查看 ${candidate.name} 的候选资料`);
        name.addEventListener('click', () => { void openCandidate(candidate, 'stage', name); });
        heading.append(name);
        const status = node('span', 'person-status', candidateStatus(candidate));
        status.setAttribute('aria-label', `原始状态：${candidateStatus(candidate)}`);
        body.append(heading, node('p', 'person-role candidate-meta', candidate.role));
        if (candidate.rawRole && candidate.rawRole !== candidate.role) body.append(node('p', 'person-role', `原岗位：${candidate.rawRole}`));
        body.append(status);
        item.append(body); return item;
      });
      if (!candidates.length) candidates.push(node('li', 'empty-state', stage.count === null ? '台账未读取，记录数未知' : '此阶段暂无候选记录'));
      list.replaceChildren(...candidates);
    }
  }
  if (announce) byId('filter-announcement').textContent = `${view.label}，${view.total === null ? '候选记录数未知' : `共 ${view.total} 条候选记录`}；工作区任务保持选定。`;
}

function render() {
  text('workspace', snapshot.workspace);
  syncRolePreferences();
  const view = renderRoleControls();
  const ordinaryCodes = ['UNKNOWN_STATUS', 'DUPLICATE_KEY', 'ROLE_ALIAS_COLLISION'];
  const messages = snapshot.diagnostics.filter(item => !ordinaryCodes.includes(item.code)).map(item => item.message);
  if (snapshot.status === 'stale') messages.unshift('数据读取失败，以下保留上次成功记录（陈旧）。');
  if (disconnected) messages.unshift('连接已断开，以下是最后成功读取的数据。');
  const alerts = byId('alerts');
  const messageSignature = JSON.stringify(messages);
  alerts.hidden = messages.length === 0;
  alerts.dataset.state = disconnected || snapshot.status === 'error' || snapshot.status === 'stale' || snapshot.diagnostics.some(item => item.level === 'error') ? 'error' : 'warning';
  if (alerts.dataset.content !== messageSignature) {
    alerts.dataset.content = messageSignature;
    alerts.replaceChildren(...messages.map(message => node('p', '', message)));
  }
  const sync = byId('sync');
  text('sync', disconnected ? '连接断开' : document.hidden ? '后台低频读取' : { ok: '读取正常', partial: '有读取提示', error: '读取失败', stale: '数据源陈旧' }[snapshot.status]);
  text('refresh-board', disconnected ? '重新连接' : '刷新');
  sync.dataset.state = disconnected || ['error', 'stale'].includes(snapshot.status) ? 'error' : snapshot.status === 'partial' ? 'warning' : 'ok';
  byId('source-dot').dataset.state = sync.dataset.state;
  text('source-status', disconnected ? '本地文件 · 连接断开' : snapshot.status === 'stale' ? '本地文件 · 数据陈旧' : snapshot.status === 'error' ? '本地文件 · 读取失败' : snapshot.status === 'partial' ? '本地文件 · 有读取提示' : '本地台账 · 候选资料只读');
  text('updated', `最近读取 ${time(snapshot.generatedAt)}`);
  const diagnostics = byId('source-diagnostics');
  const config = snapshot.sources.config ?? { status: 'missing', updatedAt: null };
  const configLabel = { ok: '已加载', missing: '未配置，使用标准映射', error: '读取或校验失败', stale: '陈旧，保留上次记录' }[config.status];
  const diagnosticSignature = JSON.stringify([snapshot.diagnostics, config]);
  if (diagnostics.dataset.content !== diagnosticSignature) {
    diagnostics.dataset.content = diagnosticSignature;
    diagnostics.replaceChildren(node('p', '', `兼容配置：${configLabel}${config.updatedAt ? ` · ${time(config.updatedAt)}` : ''}`), ...snapshot.diagnostics.map(item => node('p', '', item.message)), node('p', '', '按姓名＋原岗位计数，同人不同原岗位不自动合并。'));
  }
  renderRuns(); renderStages(false, view);
}

byId('back-to-list').addEventListener('click', () => {
  const origin = candidateOrigin;
  closeCandidate();
  if (snapshot && !workspaceBlocked) renderRunResults(selectedRun());
  const list = byId({ decisions: 'decision-list', results: 'result-list', activity: 'activity-list', stage: 'candidate-list' }[origin?.source ?? 'stage']);
  const decisionFocus = origin?.trigger?.dataset.decisionFocus;
  const target = origin?.trigger?.isConnected ? origin.trigger : decisionFocus ? [...list.querySelectorAll('[data-decision-focus]')].find(button => button.dataset.decisionFocus === decisionFocus) : [...list.querySelectorAll('.candidate-link')].find(button => button.dataset.candidate === origin?.candidateId);
  const fallback = origin?.source === 'decisions' ? byId('decisions-heading') : origin?.source === 'stage' ? stageButtons.get(selectedStage) : byId(resultsState.filter === 'decision' ? 'show-run-decisions' : 'show-run-results');
  (target?.getClientRects().length ? target : fallback)?.focus({ preventScroll: true });
});
for (const scope of ROLE_SCOPES) {
  const button = node('button', '', scope.label); button.type = 'button'; button.dataset.scope = scope.id;
  button.setAttribute('aria-pressed', String(scope.id === rolePreferences.scope));
  button.addEventListener('click', () => {
    if (rolePreferences.scope === scope.id) return;
    if (candidateOrigin?.source === 'stage') closeCandidate();
    rolePreferences.scope = scope.id; rolePreferences.role = '';
    persistRolePreferences();
    if (snapshot) { const view = renderRoleControls(); renderStages(true, view); }
  });
  byId('role-scopes').append(button);
}
byId('role-query').addEventListener('input', () => { if (snapshot) { const view = renderRoleControls(); renderStages(false, view); } });
byId('choose-following').addEventListener('click', () => {
  const picker = byId('following-picker'); picker.hidden = !picker.hidden;
  byId('choose-following').setAttribute('aria-expanded', String(!picker.hidden));
  if (!picker.hidden && snapshot) { renderFollowingPicker(); byId('following-query').focus({ preventScroll: true }); }
});
byId('following-query').addEventListener('input', () => { if (snapshot) renderFollowingPicker(); });
byId('finish-following').addEventListener('click', () => {
  byId('following-picker').hidden = true; byId('choose-following').setAttribute('aria-expanded', 'false');
  byId('choose-following').focus({ preventScroll: true });
});
byId('show-run-results').addEventListener('click', () => openRunResults('all'));
byId('show-run-decisions').addEventListener('click', () => openRunResults('decision'));
for (const button of byId('results-filters').querySelectorAll('button')) button.addEventListener('click', () => {
  resultsState.filter = button.dataset.resultsFilter;
  renderRunResults(selectedRun());
});
byId('collapse-results').addEventListener('click', () => {
  if (candidateOrigin?.source === 'results') closeCandidate();
  const target = resultsState.filter === 'decision' ? 'show-run-decisions' : 'show-run-results';
  resultsState.open = false; renderRunResults(selectedRun()); byId(target).focus({ preventScroll: true });
});
byId('retry-results').addEventListener('click', () => { void loadRunResults(); });
byId('retry-decisions').addEventListener('click', () => { void loadRunResults(); });
byId('show-more-decisions').addEventListener('click', () => {
  resultsState.showAllDecisions = !resultsState.showAllDecisions;
  renderRunResults(selectedRun());
});
byId('execution-records').addEventListener('toggle', () => {
  if (!byId('execution-records').open) {
    if (['results', 'activity'].includes(candidateOrigin?.source)) closeCandidate();
    resultsState.open = false; byId('steps-detail').open = false;
  }
  if (snapshot && !workspaceBlocked) { renderRunResults(selectedRun()); syncActivity(selectedRun()); }
});
byId('candidate-stages').addEventListener('toggle', () => {
  if (byId('candidate-stages').open) return;
  if (candidateOrigin?.source === 'stage') closeCandidate();
  selectedStage = null;
  if (snapshot) renderStages();
});
byId('manage-roles').addEventListener('click', () => { if (byId('role-manager').hidden) void openRoleManager(); else closeRoleManager(); });
byId('cancel-role').addEventListener('click', closeRoleManager);
byId('managed-role').addEventListener('change', updateManagedStatus);
byId('role-manager').addEventListener('submit', async event => {
  event.preventDefault();
  if (!roleInfo || !csrfToken || byId('save-role').disabled) return;
  const pending = roleRequest;
  const role = byId('managed-role').value, status = byId('managed-status').value;
  byId('save-role').disabled = true; byId('cancel-role').disabled = true; byId('manage-roles').disabled = true;
  byId('managed-role').disabled = true; byId('managed-status').disabled = true;
  byId('role-result').textContent = '正在保存…';
  try {
    const result = await jsonRequest('/api/roles/status', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ role, status, revision: roleInfo.contextRevision }) });
    if (pending !== roleRequest) return;
    roleInfo = result;
    byId('role-result').textContent = result.message;
    await snapshotController.refresh({ invalidate: true });
  } catch (error) {
    if (pending === roleRequest) {
      byId('role-result').textContent = error.message;
      roleInfo = null;
      const retry = node('button', 'text-button', '重新读取岗位'); retry.type = 'button';
      retry.addEventListener('click', () => { void openRoleManager(); });
      byId('role-result').append(retry);
    }
  } finally {
    byId('manage-roles').disabled = false; byId('managed-role').disabled = false; byId('managed-status').disabled = false;
    if (pending === roleRequest) { byId('save-role').disabled = !roleInfo; byId('cancel-role').disabled = false; }
  }
});
roleSelect.addEventListener('change', () => {
  if (candidateOrigin?.source === 'stage') closeCandidate();
  rolePreferences.role = roleSelect.value; persistRolePreferences();
  if (snapshot) { const view = renderRoleControls(); renderStages(true, view); }
});
function chooseTask(selection, message = '') {
  const changed = taskSelection.runId !== selection.runId || selection.mode === 'live';
  if (changed) { closeCandidate(); resetRunResults(selection.runId); resetActivity(selection.runId); byId('steps-detail').open = false; }
  taskSelection = selection; selectionMessage = message; writeTaskURL();
  if (snapshot) renderRuns();
}
runSelect.addEventListener('change', () => chooseTask({ mode: 'pinned', runId: runSelect.value || null }));
byId('pin-run').addEventListener('click', () => { taskSelection.mode = 'pinned'; selectionMessage = ''; if (snapshot) renderRuns(); runSelect.focus({ preventScroll: true }); });
for (const id of ['follow-live', 'latest-run']) byId(id).addEventListener('click', () => {
  chooseTask({ mode: 'live', runId: null });
  if (id === 'latest-run') byId('follow-live').focus({ preventScroll: true });
});
window.addEventListener('popstate', () => { const selection = readTaskURL(); chooseTask(selection, selectionMessage); });
byId('steps-detail').addEventListener('toggle', () => { byId('steps-summary').textContent = byId('steps-detail').open ? '收起全部步骤' : '查看全部步骤'; });
byId('collapse-stage').addEventListener('click', () => {
  if (candidateOrigin?.source === 'stage') closeCandidate();
  const previous = selectedStage;
  selectedStage = null;
  if (snapshot) renderStages();
  stageButtons.get(previous)?.focus({ preventScroll: true });
});

const themeButton = byId('theme');
function setTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const label = dark ? '切换浅色主题' : '切换深色主题';
  themeButton.setAttribute('aria-pressed', String(dark));
  themeButton.setAttribute('aria-label', label);
  themeButton.title = label;
}
setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
themeButton.addEventListener('click', () => setTheme(document.documentElement.dataset.theme !== 'dark'));

function blockWorkspace() {
  workspaceBlocked = true; snapshotController.suspend(); activityRequest++; activityAbort?.abort();
  resultsRequest++; recordRequest++; documentRequest++; roleRequest++;
  text('activity-status', '工作区连接已变化，以下保留上次读取的动态。'); byId('activity-status').hidden = false;
  document.documentElement.dataset.workspaceBlocked = 'true';
  text('sync', '工作区连接已变化'); byId('sync').dataset.state = 'error';
  text('task-sync', '工作区连接已变化'); byId('task-card').dataset.syncing = 'false';
  text('decisions-status', '工作区连接已变化，请重新打开看板；确认名单已停止更新。');
  byId('decisions-status').hidden = false; byId('decisions-status').dataset.state = 'error';
  byId('decisions-content').hidden = true; byId('retry-decisions').hidden = true; byId('decisions-count').hidden = true;
  const alerts = byId('alerts'); alerts.hidden = false; alerts.dataset.state = 'error';
  const reopen = node('a', 'text-button', '重新打开看板'); reopen.href = '/';
  alerts.replaceChildren(node('p', '', initialWorkspace !== null && !/^[a-f0-9]{64}$/i.test(initialWorkspace) ? '工作区链接格式无效，请重新打开看板。' : '服务已指向其他工作区，请重新打开；当前保留上次记录。'), reopen);
  byId('refresh-board').disabled = true; byId('save-role').disabled = true;
}

const snapshotController = createSnapshotController({
  isVisible: () => !document.hidden,
  load: async signal => {
    const next = await jsonRequest('/api/snapshot', { signal });
    if (next.schemaVersion !== 1 || !next.sources) throw new Error('快照格式不兼容');
    if (expectedWorkspaceKey && next.workspaceKey !== expectedWorkspaceKey) { blockWorkspace(); throw new Error('服务已指向其他工作区，请重新打开'); }
    if (!expectedWorkspaceKey && next.workspaceKey) expectedWorkspaceKey = next.workspaceKey;
    return next;
  },
  onSnapshot: next => { snapshot = next; disconnected = false; render(); },
  onError: () => {
    if (workspaceBlocked) return;
    disconnected = true;
    if (snapshot) render();
    else {
      text('sync', '连接失败'); byId('sync').dataset.state = 'error';
      text('refresh-board', '重新连接'); text('task-sync', '连接失败');
      const alerts = byId('alerts'); alerts.hidden = false; alerts.dataset.state = 'error';
      if (alerts.dataset.content !== 'disconnected') { alerts.dataset.content = 'disconnected'; alerts.replaceChildren(node('p', '', '无法连接本机看板，尚无成功读取的数据。页面会继续重试。')); }
      text('run-state', '读取失败'); byId('run-state').dataset.state = 'error';
      text('current-step', '任务状态未知'); text('task-reason', '无法连接本机看板，等待恢复读取。');
      byId('task-reason').hidden = false;
      text('decisions-status', '连接失败，确认事项未知；重新连接后更新。');
      byId('decisions-status').hidden = false; byId('decisions-status').dataset.state = 'error';
      byId('decisions-content').hidden = true;
      text('run-context', '进度未知，等待恢复读取。'); text('ledger-state', '候选记录数未知，等待恢复读取。');
      text('source-status', '本地文件 · 连接失败'); byId('source-dot').dataset.state = 'error';
    }
  }
});
byId('retry-activity').addEventListener('click', () => { void loadActivity(true); });
byId('refresh-board').addEventListener('click', () => { void snapshotController.refresh({ invalidate: true }); });
function resumeReading() {
  pageActive = true; document.documentElement.dataset.pageVisible = String(!document.hidden);
  if (workspaceBlocked) return;
  if (snapshot) renderRuns();
  void snapshotController.resume();
}
document.addEventListener('visibilitychange', () => {
  document.documentElement.dataset.pageVisible = String(!document.hidden);
  if (snapshot && !workspaceBlocked) renderRuns();
  if (!document.hidden) resumeReading();
});
window.addEventListener('focus', resumeReading);
window.addEventListener('pageshow', resumeReading);
window.addEventListener('pagehide', () => {
  pageActive = false; document.documentElement.dataset.pageVisible = 'false'; snapshotController.suspend();
  activityRequest++; activityAbort?.abort(); activityState.status = 'idle'; activityState.requestedRevision = null;
  resultsRequest++; if (resultsState.status === 'loading') { resultsState.status = 'idle'; resultsState.requestedVersion = null; }
});
if (workspaceBlocked) blockWorkspace(); else resumeReading();
