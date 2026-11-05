import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import * as model from '../skills/recruit-board/model.mjs';
import { createSnapshotController } from '../skills/recruit-board/public/live.mjs';

const [html, script] = await Promise.all([
  readFile(new URL('../skills/recruit-board/public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../skills/recruit-board/public/app.js', import.meta.url), 'utf8')
]);
const key = 'a'.repeat(64), now = '2026-11-05T04:00:00.000Z', earlier = '2026-11-04T03:00:00.000Z';
const candidateId = JSON.stringify(['合成人选', '测试在招岗']);
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const visible = element => {
  if (!element || element.closest('[hidden]')) return false;
  for (let parent = element; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) return false;
  return true;
};

function decision(id, state = 'open') {
  const actions = state === 'decided' ? [{ id: 'sync', kind: 'sync', label: '同步已确认标准', status: 'pending', updatedAt: now }] : [];
  return {
    id, title: `核对事项 ${id}`, state, effectiveState: state,
    identity: { subjectKey: candidateId, questionKey: id, scope: '测试范围' },
    context: { scope: 'candidate', candidateId }, createdAt: earlier, updatedAt: now,
    deadline: null, blocking: false, snoozedUntil: null, reason: `事项依据 ${id}`,
    sources: [{ runId: 'current', recordedAt: earlier }], actions, history: [],
    decision: state === 'decided' ? { text: '已明确采用此标准', scope: '测试范围', recordedAt: now } : null,
    followUp: { status: state === 'decided' ? 'pending' : 'none' }
  };
}

function highlight(id, extra = {}) {
  return {
    eventKey: id, text: `已核实进展 ${id}`, evidence: '已核对档案',
    runId: 'current', context: { scope: 'candidate', candidateId },
    occurredAt: earlier, updatedAt: now, ...extra
  };
}

async function page(t, { decisions = [], highlights = [], overviewStatus = 'ok', rows = [], pinned = false, nativeDialog = false, candidateActivity = [], deferOverview = false } = {}) {
  const run = model.createRun({ id: 'current', workflow: 'daily', now: earlier });
  const older = model.createRun({ id: 'older', workflow: 'resume-review', now: '2026-11-03T03:00:00.000Z' });
  const runs = new Map([[run.id, run], [older.id, older]]);
  const snapshot = model.buildSnapshot({
    workspace: '合成工作台验收', generatedAt: now,
    ledger: { status: 'ok', text: [model.LEDGER_COLUMNS.join(','), '1,合成人选,测试在招岗,,A,已回复,测试来源,,', '2,合成人选,测试历史岗,,B,面试中,测试来源,,', '3,合成乙,台账旧称,,C,待初筛,测试来源,,', '4,合成长姓名用于验证名单阅读,测试在招岗,,A,待初筛,测试来源,,', ...rows].join('\n') + '\n', updatedAt: now },
    context: { status: 'ok', text: '## 在招岗位与优先级\n\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| 测试在招岗 | P0 | 在招 |\n| 测试历史岗 | P1 | 已关闭 |\n', updatedAt: now },
    runFiles: { status: 'ok', files: [] }
  });
  snapshot.workspaceKey = key; snapshot.runs = [...runs.values()].map(model.runSummary);
  const overview = {
    status: overviewStatus, updatedAt: now, revision: '1',
    decisions: overviewStatus === 'ok' ? decisions : null,
    highlights: overviewStatus === 'ok' ? highlights : null,
    candidateActivity: overviewStatus === 'ok' ? candidateActivity : null,
    counts: overviewStatus === 'ok' ? { open: decisions.filter(item => item.effectiveState === 'open').length, snoozed: decisions.filter(item => item.effectiveState === 'snoozed').length, history: decisions.filter(item => item.effectiveState === 'history_review').length, followUp: decisions.filter(item => item.state === 'decided').length } : { open: null, snoozed: null, history: null, followUp: null }, diagnostics: []
  };
  let releaseOverview = () => {};
  const overviewGate = deferOverview ? new Promise(resolve => { releaseOverview = resolve; }) : null;
  const errors = [], requests = [], scrolls = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, { url: `http://localhost:4401/?workspace=${key}${pinned ? '&run=current' : ''}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window;
  if (nativeDialog) {
    w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    w.HTMLDialogElement.prototype.close = function () {
      if (!this.open) return;
      this.open = false;
      setTimeout(() => this.dispatchEvent(new w.Event('close')), 0);
    };
  }
  w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () { scrolls.push(this.id); };
  w.HTMLElement.prototype.getClientRects = function () { return visible(this) ? [{}] : []; };
  let scrollY = 0;
  Object.defineProperty(w, 'scrollY', { get: () => scrollY });
  w.scrollTo = (x, y) => { scrollY = y; }; w.scrollBy = (x, y) => { scrollY += y; };
  w.AbortController = AbortController; w.AbortSignal = AbortSignal; w.__model = model;
  const controllers = [];
  w.__controller = settings => { const controller = createSnapshotController({ ...settings, setTimer: () => 1, clearTimer() {} }); controllers.push(controller); return controller; };
  w.fetch = async (resource, init = {}) => {
    const url = new URL(resource, w.location.href);
    requests.push({ url, method: init.method ?? 'GET', headers: init.headers });
    if (url.pathname === '/api/snapshot') return Response.json(snapshot);
    if (url.pathname === '/api/workspace/overview') { if (overviewGate) await overviewGate; return Response.json(overview); }
    if (url.pathname === '/api/candidates/detail') {
      const candidate = snapshot.candidates.find(item => item.id === url.searchParams.get('candidate'));
      assert.ok(candidate);
      return Response.json({ candidate, background: '已读取背景', notes: '已核实备注', warnings: [], documents: [
        { id: 'd'.repeat(64), label: '原始简历', category: 'resume', status: 'ok', kind: 'pdf' },
        { id: 'c'.repeat(64), label: '面试档案', category: 'archive', status: 'ok', kind: 'markdown' },
        { id: 'e'.repeat(64), label: 'Word 原件', category: 'resume', status: 'ok', kind: 'docx', downloadOnly: true }
      ], progress: { status: 'ok', records: [{ documentId: 'c'.repeat(64), label: '面试档案', currentStatus: '面试已安排', interviews: [{ round: '一面', time: '2026-11-06 10:00–11:00', format: '视频', interviewers: '合成面试官', status: '已约' }], nextAction: '回收面试反馈', conclusion: '待面试' }] } });
    }
    if (url.pathname === '/api/roles') return Response.json({ roles: snapshot.roles.filter(role => role.configured), allowedStatuses: ['在招', '已关闭', '暂停'], unconfiguredRoles: [{ name: '台账旧称' }], roleAliases: {}, contextRevision: 'b'.repeat(64), configRevision: 'c'.repeat(64) });
    if (url.pathname === '/api/session') return Response.json({ csrfToken: 'f'.repeat(64) });
    const selected = runs.get(url.searchParams.get('run'));
    assert.ok(selected, url.pathname);
    if (url.pathname === '/api/runs/results') return Response.json({ runId: selected.id, results: selected.results, revision: selected.resultsRevision, updatedAt: selected.updatedAt });
    if (url.pathname === '/api/runs/highlights') return Response.json({ runId: selected.id, highlights: selected.highlights, revision: selected.highlightsRevision, updatedAt: selected.updatedAt });
    throw new Error(`未预期请求 ${url.pathname}`);
  };
  const executable = script.replace(/^import .* from '\/model\.mjs';\r?\n/, 'const { candidateStatus, candidateSubject, validateContext, ROLE_SCOPES, RUN_LABELS, searchCandidates, selectRoles, selectTask, STAGES, STEP_LABELS } = window.__model;\n').replace(/^import .* from '\/live\.mjs';\r?\n/m, 'const createSnapshotController = window.__controller;\n');
  w.eval(`(() => {${executable}\n})();`);
  t.after(() => { w.dispatchEvent(new w.Event('pagehide')); w.close(); assert.deepEqual(errors, []); });
  await settle();
  return {
    w, $: selector => w.document.querySelector(selector), all: selector => [...w.document.querySelectorAll(selector)],
    snapshot, overview, runs, requests, scrolls, releaseOverview,
    refresh: async () => { await Promise.all(controllers.map(controller => controller.refresh({ invalidate: true }))); await settle(); },
    input: (selector, value) => { const element = w.document.querySelector(selector); element.value = value; element.dispatchEvent(new w.Event('input', { bubbles: true })); },
    select: (selector, value) => { const element = w.document.querySelector(selector); element.value = value; element.dispatchEvent(new w.Event('change', { bubbles: true })); }
  };
}

const navigate = async (p, view) => { p.$(`[data-nav-target="${view}"]`).click(); await settle(); };

test('总览最多三条摘要，后续执行和历史各有真实入口，决定与执行状态分开', async t => {
  const items = [1, 2, 3, 4].map(id => decision(`open-${id}`));
  items.push(decision('history-1', 'history_review'), decision('history-2', 'history_review'), decision('follow', 'decided'), decision('later', 'snoozed'));
  const p = await page(t, { decisions: items, highlights: [1, 2, 3, 4].map(id => highlight(`event-${id}`)) });
  assert.equal(p.all('#workspace-decision-list > li').length, 3);
  assert.equal(p.all('#workspace-highlight-list > li').length, 3);
  assert.match(p.$('#workspace-decisions-count').textContent, /^4$/);
  assert.match(p.$('#workspace-all-decisions').textContent, /8/);
  assert.equal(p.$('[data-overview-filter="followUp"]').hidden, false);
  assert.equal(p.$('#workspace-followup-link').hidden, false);
  p.$('[data-overview-filter="followUp"]').click(); await settle();
  assert.equal(p.all('#workspace-decision-list > li').length, 1);
  assert.match(p.$('#workspace-decision-list').textContent, /已决定/);
  assert.match(p.$('#workspace-decision-list').textContent, /待执行/);
  p.$('#workspace-decision-list button').click(); await settle();
  assert.ok(p.$('#workspace-drawer').open);
  assert.match(p.$('#workspace-drawer-detail').textContent, /已明确采用此标准/);
  assert.match(p.$('#workspace-drawer-detail').textContent, /资料待同步/);
  p.$('#workspace-drawer-close').click();
  await navigate(p, 'roles'); await navigate(p, 'overview');
  assert.equal(p.$('[data-overview-filter="followUp"]').getAttribute('aria-pressed'), 'true');
  p.$('#workspace-all-decisions').click(); await settle();
  p.select('#workspace-drawer-filter', 'all');
  assert.equal(p.all('#workspace-drawer-list [data-decision]').length, 8);
  assert.ok(p.$('#workspace-drawer-list [data-role-group="测试在招岗"]'));
  assert.ok(p.requests.every(request => request.method === 'GET'));
});

test('没有当前待回答时直接显示历史待核对，正常空、未接入与失败不能混为零', async t => {
  const history = await page(t, { decisions: [decision('old', 'history_review')] });
  assert.match(history.$('#workspace-decision-list').textContent, /核对事项 old/);
  assert.match(history.$('#workspace-decision-caption').textContent, /当前没有待回答事项/);
  assert.equal(history.$('[data-overview-filter="open"]').hidden, true);
  const empty = await page(t);
  assert.match(empty.$('#workspace-decision-empty').textContent, /当前没有待回答事项/);
  assert.equal(empty.$('#workspace-decision-filters').hidden, true);
  const missing = await page(t, { overviewStatus: 'missing' });
  assert.match(missing.$('#workspace-overview-status').textContent, /尚未接入/);
  assert.match(missing.$('#workspace-all-decisions').textContent, /未知/);
  assert.equal(missing.$('#workspace-decision-empty').hidden, true);
  const failed = await page(t, { overviewStatus: 'error' });
  assert.match(failed.$('#workspace-overview-status').textContent, /数量未知/);
  assert.equal(failed.$('#retry-workspace-overview').hidden, false);
});

test('名单默认显示当前范围，阶段点击可见，姓名搜索跨历史岗位且不扩展成岗位匹配', async t => {
  const p = await page(t);
  await navigate(p, 'roles');
  assert.equal(visible(p.$('#candidate-detail')), true);
  assert.equal(p.all('#candidate-list > [data-candidate]').length, 2);
  p.$('#stage-talking').click(); await settle();
  assert.equal(p.all('#candidate-list > [data-candidate]').length, 1);
  assert.equal(p.w.document.activeElement, p.$('#detail-title'));
  assert.ok(p.scrolls.includes('detail-title'));
  p.input('#candidate-query', '合成人选'); await settle();
  assert.equal(p.all('#candidate-search-list > [data-candidate]').length, 2);
  assert.match(p.$('#candidate-search-list').textContent, /测试历史岗/);
  assert.equal(new URL(p.w.location.href).searchParams.has('query'), false);
  p.input('#candidate-query', '测试在招岗'); await settle();
  assert.equal(p.all('#candidate-search-list > [data-candidate]').length, 0);
  assert.match(p.$('#candidate-search-list').textContent, /未找到匹配的人选/);
  p.$('#clear-candidate-search').click(); await settle();
  assert.equal(p.$('#stage-talking').getAttribute('aria-expanded'), 'true');
  assert.equal(p.all('#candidate-list > [data-candidate]').length, 1);
});

test('范围、关注、未知提醒、岗位搜索与管理均保留真实岗位语义', async t => {
  const p = await page(t);
  await navigate(p, 'roles');
  assert.equal(p.$('#unknown-roles-link').hidden, false);
  p.$('#unknown-roles-link').click(); await settle();
  assert.equal(p.$('[data-scope="all"]').getAttribute('aria-pressed'), 'true');
  assert.equal(p.$('#unknown-roles').hidden, false);
  p.$('#unknown-role-list button').click();
  assert.equal(p.$('#role').value, '台账旧称');
  assert.match(p.$('#role-note').textContent, /仅见于台账/);
  p.$('[data-scope="active"]').click();
  assert.equal(p.$('#role').value, '');
  assert.match(p.$('#role-range-message').textContent, /不在在招范围/);
  p.$('#choose-following').click(); await settle();
  const choice = p.all('#following-list input').find(element => element.dataset.role === '测试历史岗');
  assert.ok(choice); choice.click();
  p.$('#finish-following').click(); await settle();
  assert.equal(p.w.document.activeElement, p.$('#choose-following'));
  p.$('[data-scope="following"]').click(); p.select('#role', '测试历史岗');
  p.$('#show-all-stage-candidates').click();
  assert.equal(p.all('#candidate-list > [data-candidate]').length, 1);
  p.input('#role-query', '没有此岗位');
  assert.equal(p.$('#role').value, '测试历史岗');
  assert.match(p.$('#candidate-total-summary').textContent, /1 条/);
  assert.match(p.$('#role-options-note').textContent, /保留所选岗位/);
  p.$('#manage-roles').click(); await settle();
  assert.equal(p.$('#role-manager').hidden, false);
  assert.equal(p.$('#role-alias-manager').hidden, false);
  assert.equal(p.w.document.activeElement, p.$('#managed-role'));
  assert.ok(p.requests.every(request => request.method === 'GET'));
});

test('人选从名单即时进入同一面板，返回恢复筛选、名单、滚动与焦点，原件和更正入口可达', async t => {
  const p = await page(t);
  await navigate(p, 'roles'); p.$('#stage-talking').click();
  const trigger = p.$('#candidate-list button'); trigger.focus(); p.w.scrollTo(0, 320); trigger.click();
  assert.equal(p.$('#workspace-drawer').open, true);
  assert.match(p.$('#record-content').textContent, /正在读取候选资料/);
  await settle();
  assert.match(p.$('#candidate-progress').textContent, /回收面试反馈/);
  assert.ok(visible(p.$('#candidate-progress')));
  const links = p.all('#record-content .document-actions a');
  assert.ok(links.some(link => link.textContent === '打开 PDF' && link.href.includes('workspace=' + key)));
  assert.ok(links.some(link => link.textContent === '下载原件' && new URL(link.href).searchParams.get('download') === '1'));
  assert.ok(p.all('#record-content button').some(button => button.textContent === '关联资料'));
  p.$('#workspace-drawer-back').click(); await settle();
  assert.equal(p.$('#workspace-drawer').open, false);
  assert.equal(p.$('#stage-talking').getAttribute('aria-expanded'), 'true');
  assert.equal(p.w.document.activeElement, trigger);
  assert.equal(p.w.scrollY, 320);
  assert.equal(visible(p.$('#candidate-list')), true);
});

test('进展到事项再到资料逐层返回，保留各层展开、滚动与焦点，Esc 回到初始入口', async t => {
  const item = decision('linked');
  const p = await page(t, { decisions: [item], highlights: [highlight('event', { decisionId: item.id })] });
  const trigger = p.$('#workspace-highlight-list button'); trigger.focus(); p.w.scrollTo(0, 180); trigger.click(); await settle();
  const evidence = p.$('#workspace-drawer-detail details'); evidence.querySelector('summary').click(); await settle();
  p.$('#workspace-drawer-content').scrollTop = 140;
  p.$('#workspace-drawer-detail [data-linked-item]').click(); await settle();
  const sources = p.all('#workspace-drawer-detail details').find(element => element.textContent.includes('来源与记录信息'));
  sources.querySelector('summary').click(); await settle(); p.$('#workspace-drawer-content').scrollTop = 210;
  p.$('#workspace-drawer-detail [data-subject]').click(); await settle();
  assert.match(p.$('#record-content').textContent, /合成人选/);
  p.$('#workspace-drawer-back').click(); await settle();
  assert.equal(p.$('#workspace-drawer-content').scrollTop, 210);
  assert.equal(p.w.document.activeElement.dataset.subject, candidateId);
  assert.ok(p.all('#workspace-drawer-detail details').some(element => element.open && element.textContent.includes('来源与记录信息')));
  p.$('#workspace-drawer-back').click(); await settle();
  assert.equal(p.$('#workspace-drawer-content').scrollTop, 140);
  assert.equal(p.w.document.activeElement.dataset.linkedItem, item.id);
  assert.equal(p.$('#workspace-drawer-detail details').open, true);
  p.$('#workspace-drawer').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
  assert.equal(p.$('#workspace-drawer').open, false);
  assert.equal(p.w.document.activeElement, trigger);
  assert.equal(p.w.scrollY, 180);
});

test('阅读时保留可信内容、提示真实更新，新任务不抢占，失败仍保留时间与重试', async t => {
  const p = await page(t, { decisions: [decision('reading')] });
  p.$('#workspace-decision-list button').click(); await settle();
  p.$('#workspace-drawer-content').scrollTop = 190;
  p.overview.decisions[0].title = '已核实的新问题'; p.overview.revision = '2';
  const newer = model.createRun({ id: 'newer', workflow: 'interview-schedule', now: '2026-11-05T06:00:00.000Z' });
  p.runs.set(newer.id, newer); p.snapshot.runs.unshift(model.runSummary(newer));
  await p.refresh();
  assert.match(p.$('#workspace-drawer-detail').textContent, /核对事项 reading/);
  assert.doesNotMatch(p.$('#workspace-drawer-detail').textContent, /已核实的新问题/);
  assert.equal(p.$('#workspace-drawer-content').scrollTop, 190);
  assert.equal(p.$('#workspace-drawer-update').hidden, false);
  assert.equal(p.$('#run').value, 'current');
  assert.equal(p.$('#workspace-return-overview').hidden, false);
  p.$('#workspace-drawer-update').click(); await settle();
  assert.match(p.$('#workspace-drawer-detail').textContent, /已核实的新问题/);
  p.overview.status = 'error'; p.overview.decisions = null; p.overview.highlights = null;
  p.overview.counts = { open: null, snoozed: null, history: null, followUp: null };
  p.overview.diagnostics = [{ message: '事项源暂不可读' }];
  await p.refresh();
  assert.match(p.$('#workspace-drawer-detail').textContent, /已核实的新问题/);
  assert.match(p.$('#workspace-drawer-notice').textContent, /保留最后成功读取/);
  assert.match(p.$('#workspace-overview-recorded').textContent, /最后成功读取/);
  assert.equal(p.$('#retry-workspace-overview').hidden, false);
  p.$('#workspace-drawer-close').click();
  p.$('#workspace-return-overview').click(); await settle();
  assert.equal(p.$('#run').value, 'newer');
});

test('三视图共享导航但不重置查询与固定轮次，切换主题仍保留原人岗身份', async t => {
  const p = await page(t, { pinned: true });
  assert.equal(visible(p.$('#tasks')), true);
  assert.equal(p.$('#pin-run').getAttribute('aria-pressed'), 'true');
  p.select('#run', 'older');
  await navigate(p, 'roles'); p.input('#candidate-query', '合成人选'); await settle();
  await navigate(p, 'overview'); await navigate(p, 'roles');
  assert.equal(p.$('#candidate-query').value, '合成人选');
  assert.equal(p.all('#candidate-search-list > [data-candidate]').length, 2);
  assert.equal(p.$('#run').value, 'older');
  assert.equal(new URL(p.w.location.href).searchParams.get('run'), 'older');
  p.$('#theme').click();
  assert.equal(p.w.document.documentElement.dataset.theme, 'light');
  assert.equal(new Set(p.all('#candidate-search-list > [data-candidate]').map(row => row.dataset.candidate)).size, 2);
  await navigate(p, 'tasks'); p.$('#follow-live').click(); await settle();
  assert.equal(p.$('#run').value, 'current');
  assert.equal(new URL(p.w.location.href).searchParams.has('run'), false);
});

test('当前名单按需展开，切视图保留展开数量且不额外读取候选正文', async t => {
  const rows = Array.from({ length: 23 }, (_, index) => `${index + 5},合成批次${index},测试在招岗,,B,待初筛,测试来源,,`);
  const p = await page(t, { rows });
  await navigate(p, 'roles');
  assert.equal(p.all('#candidate-list > [data-candidate]').length, 20);
  assert.equal(p.$('#show-more-stage-candidates').hidden, false);
  p.$('#show-more-stage-candidates').click(); await settle();
  assert.equal(p.all('#candidate-list > [data-candidate]').length, 25);
  await navigate(p, 'overview'); await navigate(p, 'roles');
  assert.equal(p.all('#candidate-list > [data-candidate]').length, 25);
  assert.equal(p.requests.filter(request => request.url.pathname === '/api/candidates/detail').length, 0);
});

test('名单按最近已核实进展倒序，先排序后分页，阶段、岗位与搜索一致，无可靠时间排后', async t => {
  const rows = Array.from({ length: 23 }, (_, index) => `${index + 5},合成批次${index},测试在招岗,,B,待初筛,测试来源,,`);
  const batch = JSON.stringify(['合成批次22', '测试在招岗']);
  const longName = JSON.stringify(['合成长姓名用于验证名单阅读', '测试在招岗']);
  const history = JSON.stringify(['合成人选', '测试历史岗']);
  const active = JSON.stringify(['合成人选', '测试在招岗']);
  const p = await page(t, { rows, candidateActivity: [
    { candidateId: batch, at: '2026-11-05T02:30:00.000Z', precision: 'instant', sourceKind: 'archive' },
    { candidateId: longName, at: '2026-11-04T09:00:00.000Z', precision: 'instant', sourceKind: 'result' },
    { candidateId: history, at: '2026-11-04T00:00:00.000Z', precision: 'day', sourceKind: 'archive' }
  ] });
  await navigate(p, 'roles');
  const ids = selector => p.all(`${selector} > [data-candidate]`).map(row => row.dataset.candidate);
  const rowOf = (selector, id) => p.all(`${selector} > [data-candidate]`).find(row => row.dataset.candidate === id);
  assert.deepEqual(ids('#candidate-list').slice(0, 3), [batch, longName, active]);
  assert.equal(ids('#candidate-list').length, 20);
  assert.equal(ids('#candidate-list').includes(JSON.stringify(['合成批次17', '测试在招岗'])), false);
  assert.match(rowOf('#candidate-list', batch).querySelector('.candidate-activity-value').textContent, /^11-05 .+ · 档案事件$/);
  assert.match(rowOf('#candidate-list', longName).querySelector('.candidate-activity-value').textContent, /^11-04 .+ · 处理记录$/);
  assert.equal(rowOf('#candidate-list', active).querySelector('.candidate-activity-value').textContent, '无可核实时间');
  p.$('#show-more-stage-candidates').click(); await settle();
  assert.equal(ids('#candidate-list').length, 25);
  assert.ok(ids('#candidate-list').includes(JSON.stringify(['合成批次17', '测试在招岗'])));
  p.$('#stage-screen').click(); await settle();
  assert.deepEqual(ids('#candidate-list').slice(0, 2), [batch, longName]);
  p.$('#show-all-stage-candidates').click(); await settle();
  p.select('#role', '测试在招岗'); await settle();
  assert.deepEqual(ids('#candidate-list').slice(0, 2), [batch, longName]);
  p.$('[data-scope="all"]').click(); await settle();
  p.select('#role', ''); await settle();
  assert.deepEqual(ids('#candidate-list').slice(0, 3), [batch, longName, history]);
  assert.equal(rowOf('#candidate-list', history).querySelector('.candidate-activity-value').textContent, '2026-11-04 · 档案事件');
  p.input('#candidate-query', '合成'); await settle();
  assert.deepEqual(ids('#candidate-search-list').slice(0, 3), [batch, longName, history]);
  assert.equal(rowOf('#candidate-search-list', history).querySelector('.candidate-activity-value').textContent, '2026-11-04 · 档案事件');
  p.input('#candidate-query', '合成人选'); await settle();
  assert.deepEqual(ids('#candidate-search-list'), [history, active]);
});

test('首页可信的日期级邀约也在人选名单靠前，名单与搜索不补造时分', async t => {
  const invited = JSON.stringify(['合成长姓名用于验证名单阅读', '测试在招岗']);
  const at = '2026-11-05T00:00:00.000Z';
  const p = await page(t, {
    highlights: [highlight('restored-invitation', { text: '候选人邀约已发出', context: { scope: 'candidate', candidateId: invited }, occurredAt: at, updatedAt: at, timePrecision: 'day', sourceKind: 'archive', sourceDocumentId: 'c'.repeat(64), recovered: true, runId: null, sourceRunIds: [] })],
    candidateActivity: [{ candidateId: invited, at, precision: 'day', sourceKind: 'archive' }]
  });
  assert.match(p.$('#workspace-highlight-list').textContent, /候选人邀约已发出/);
  assert.match(p.$('#workspace-highlight-list').textContent, /2026-11-05（当日，未记时分）/);
  await navigate(p, 'roles');
  const row = p.$('#candidate-list > [data-candidate]');
  assert.equal(row.dataset.candidate, invited);
  assert.equal(row.querySelector('.candidate-activity-value').textContent, '2026-11-05 · 档案事件');
  const unknown = p.all('#candidate-list > [data-candidate]').find(item => item.dataset.candidate === candidateId);
  assert.equal(unknown.querySelector('.candidate-activity-value').textContent, '无可核实时间');
  p.input('#candidate-query', '合成'); await settle();
  const match = p.$('#candidate-search-list > [data-candidate]');
  assert.equal(match.dataset.candidate, invited);
  assert.equal(match.querySelector('.candidate-activity-value').textContent, '2026-11-05 · 档案事件');
});

test('时间来源异常且活动数组未变时在人选页提示上次记录，恢复后清除且名单与焦点稳定', async t => {
  const recent = JSON.stringify(['合成长姓名用于验证名单阅读', '测试在招岗']);
  const p = await page(t, { candidateActivity: [
    { candidateId: recent, at: '2026-11-05T00:00:00.000Z', precision: 'day', sourceKind: 'archive' },
    { candidateId, at: '2026-11-04T03:00:00.000Z', precision: 'instant', sourceKind: 'result' }
  ] });
  await navigate(p, 'roles');
  const notice = () => p.$('#candidate-activity-status');
  assert.equal(visible(notice()), false);
  const rows = p.all('#candidate-list > [data-candidate]'), trigger = rows[0].querySelector('button');
  const dates = rows.map(row => row.querySelector('.candidate-activity-value').textContent);
  trigger.focus(); p.w.scrollTo(0, 260);
  p.overview.status = 'stale'; p.overview.diagnostics = [{ message: '进展来源暂不可读，保留记录' }];
  await p.refresh();
  assert.equal(visible(notice()), true);
  assert.match(notice().textContent, /上次.*记录/);
  assert.match(notice().textContent, /来源待核验/);
  assert.deepEqual(p.all('#candidate-list > [data-candidate]'), rows);
  assert.deepEqual(rows.map(row => row.querySelector('.candidate-activity-value').textContent), dates);
  assert.equal(p.w.document.activeElement, trigger);
  assert.equal(p.w.scrollY, 260);
  p.overview.status = 'ok'; p.overview.diagnostics = [];
  await p.refresh();
  assert.equal(visible(notice()), false);
  assert.equal(notice().textContent, '');
  assert.equal(p.w.document.activeElement, trigger);
  p.input('#candidate-query', '合成'); await settle();
  const searchRows = p.all('#candidate-search-list > [data-candidate]'), searchTrigger = searchRows[0].querySelector('button');
  searchTrigger.focus(); p.w.scrollTo(0, 260);
  const originalFetch = p.w.fetch;
  p.w.fetch = (resource, init) => new URL(resource, p.w.location.href).pathname === '/api/workspace/overview' ? Promise.reject(new Error('进展时间源暂不可读')) : originalFetch(resource, init);
  await p.refresh();
  assert.equal(visible(notice()), true);
  assert.match(notice().textContent, /上次.*记录/);
  assert.match(notice().textContent, /来源待核验/);
  assert.deepEqual(p.all('#candidate-search-list > [data-candidate]'), searchRows);
  assert.equal(p.w.document.activeElement, searchTrigger);
  assert.equal(p.w.scrollY, 260);
  p.w.fetch = originalFetch;
  await p.refresh();
  assert.equal(visible(notice()), false);
  assert.equal(notice().textContent, '');
  assert.deepEqual(p.all('#candidate-search-list > [data-candidate]'), searchRows);
  assert.equal(p.w.document.activeElement, searchTrigger);
});

test('人选页先到时索引到达即初次排序，阅读中的后续更新保持顺序并可显式应用', async t => {
  const first = JSON.stringify(['合成人选', '测试在招岗']);
  const longName = JSON.stringify(['合成长姓名用于验证名单阅读', '测试在招岗']);
  const p = await page(t, { deferOverview: true, candidateActivity: [
    { candidateId: longName, at: '2026-11-05T02:00:00.000Z', precision: 'instant', sourceKind: 'archive' }
  ] });
  await navigate(p, 'roles');
  const ids = () => p.all('#candidate-list > [data-candidate]').map(row => row.dataset.candidate);
  assert.equal(ids()[0], first);
  p.releaseOverview(); await settle();
  assert.equal(ids()[0], longName);
  const trigger = p.$('#candidate-list > [data-candidate] button'); trigger.focus(); trigger.click(); await settle();
  assert.equal(p.$('#workspace-drawer').open, true);
  const record = p.$('#record-content').textContent;
  p.overview.candidateActivity = [
    { candidateId: longName, at: '2026-11-05T02:00:00.000Z', precision: 'instant', sourceKind: 'archive' },
    { candidateId: first, at: '2026-11-05T03:00:00.000Z', precision: 'instant', sourceKind: 'result' }
  ];
  await p.refresh();
  assert.equal(ids()[0], longName);
  assert.equal(p.$('#workspace-drawer').open, true);
  assert.equal(p.$('#record-content').textContent, record);
  assert.equal(p.$('#workspace-drawer-update').hidden, false);
  p.$('#workspace-drawer-update').click(); await settle();
  assert.equal(ids()[0], first);
  assert.equal(p.$('#workspace-drawer').open, true);
  assert.equal(p.$('#record-content').textContent, record);
  assert.equal(p.w.document.activeElement, p.$('#workspace-drawer-title'));
});

test('名单与姓名搜索阅读时更新入口在当前视图可见，主动显示后应用新排序', async t => {
  const first = candidateId, recent = JSON.stringify(['合成长姓名用于验证名单阅读', '测试在招岗']);
  for (const search of [false, true]) {
    const p = await page(t, { candidateActivity: [
      { candidateId: recent, at: '2026-11-05T02:00:00.000Z', precision: 'instant', sourceKind: 'archive' },
      { candidateId: first, at: '2026-11-04T03:00:00.000Z', precision: 'instant', sourceKind: 'result' }
    ] });
    await navigate(p, 'roles');
    if (search) { p.input('#candidate-query', '合成'); await settle(); }
    const list = search ? '#candidate-search-list' : '#candidate-list';
    const ids = () => p.all(`${list} > [data-candidate]`).map(row => row.dataset.candidate);
    const trigger = p.$(`${list} button`); trigger.focus(); p.w.scrollTo(0, 260);
    const before = ids();
    p.overview.candidateActivity = [
      { candidateId: recent, at: '2026-11-05T02:00:00.000Z', precision: 'instant', sourceKind: 'archive' },
      { candidateId: first, at: '2026-11-05T03:00:00.000Z', precision: 'instant', sourceKind: 'result' }
    ];
    await p.refresh();
    assert.deepEqual(ids(), before);
    assert.equal(p.w.document.activeElement, trigger);
    assert.equal(p.w.scrollY, 260);
    assert.equal(p.$('#workspace-drawer').open, false);
    assert.ok(visible(p.$('#candidate-reading-notice')));
    const update = p.$('#candidate-apply-updates');
    assert.ok(visible(update));
    update.click(); await settle();
    assert.deepEqual(ids().slice(0, 2), [first, recent]);
    assert.equal(p.$('#candidate-reading-notice').hidden, true);
    assert.equal(p.w.document.activeElement, p.$('#candidates-heading'));
    assert.equal(p.w.scrollY, 260);
    assert.ok(p.requests.every(request => request.method === 'GET'));
  }
});

test('同名异岗的搜索入口分别读取原身份，关闭后回到该条搜索记录', async t => {
  const p = await page(t);
  p.input('#candidate-query', '合成人选'); await settle();
  const id = JSON.stringify(['合成人选', '测试历史岗']);
  const row = p.all('#candidate-search-list > [data-candidate]').find(element => element.dataset.candidate === id);
  const trigger = row.querySelector('button'); trigger.focus(); p.w.scrollTo(0, 240); trigger.click(); await settle();
  const request = p.requests.filter(request => request.url.pathname === '/api/candidates/detail').at(-1);
  assert.equal(request.url.searchParams.get('candidate'), id);
  assert.match(p.$('#record-content').textContent, /测试历史岗/);
  p.$('#workspace-drawer-close').click(); await settle();
  assert.equal(p.$('#candidate-query').value, '合成人选');
  assert.equal(p.all('#candidate-search-list > [data-candidate]').length, 2);
  assert.equal(p.w.document.activeElement, trigger);
  assert.equal(p.w.scrollY, 240);
});

test('关闭后立即打开另一份资料，迟到的原生 close 不关闭新面板，真正关闭仍清理资料并恢复焦点', async t => {
  const p = await page(t, { nativeDialog: true });
  p.input('#candidate-query', '合成人选'); await settle();
  const [first, second] = p.all('#candidate-search-list .candidate-row button');
  second.focus(); second.click(); await settle();
  const dialog = p.$('#workspace-drawer');
  assert.equal(dialog.open, true);
  assert.match(p.$('#record-content').textContent, /测试历史岗/);
  let closeEvents = 0;
  dialog.addEventListener('close', () => { closeEvents++; });
  p.$('#workspace-drawer-close').click();
  assert.equal(dialog.open, false);
  assert.equal(closeEvents, 0);
  first.focus(); first.click();
  assert.equal(dialog.open, true);
  await settle();
  assert.equal(dialog.open, true);
  assert.equal(closeEvents, 1);
  assert.match(p.$('#record-content').textContent, /测试在招岗/);
  assert.doesNotMatch(p.$('#record-content').textContent, /测试历史岗/);
  assert.equal(p.w.document.activeElement, p.$('#workspace-drawer-title'));
  assert.equal(p.w.document.documentElement.classList.contains('drawer-open'), true);
  const request = p.requests.filter(item => item.url.pathname === '/api/candidates/detail').at(-1);
  assert.equal(request.url.searchParams.get('candidate'), first.dataset.candidate);
  dialog.close(); await settle();
  assert.equal(closeEvents, 2);
  assert.equal(dialog.open, false);
  assert.equal(p.$('#record-content').textContent, '');
  assert.equal(p.w.document.activeElement, first);
  assert.equal(p.w.document.documentElement.classList.contains('drawer-open'), false);
});

test('布局设置仍可从紧凑工具入口显式打开、排序及还原，退出后只显示当前视图', async t => {
  const p = await page(t);
  assert.equal(p.$('#layout-editor').hidden, true);
  p.$('#edit-layout').click(); await settle();
  assert.equal(p.$('#edit-layout').getAttribute('aria-expanded'), 'true');
  assert.ok(['#assistant', '#role-browser', '#tasks'].every(selector => visible(p.$(selector))));
  p.$('button[aria-label="上移任务与记录"]').click(); await settle();
  assert.deepEqual(p.all('#layout-root > [data-layout-item]').map(element => element.dataset.layoutItem), ['assistant', 'tasks', 'roles']);
  p.$('#finish-layout').click(); await settle();
  assert.equal(p.$('#layout-editor').hidden, true);
  assert.equal(visible(p.$('#role-browser')), false);
  assert.equal(visible(p.$('#tasks')), false);
  assert.equal(p.w.document.activeElement, p.$('#edit-layout'));
  p.$('#edit-layout').click(); p.$('#reset-layout').click(); await settle();
  assert.deepEqual(p.all('#layout-root > [data-layout-item]').map(element => element.dataset.layoutItem), ['assistant', 'roles', 'tasks']);
});
