import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import * as model from '../skills/recruit-board/model.mjs';
import { createSnapshotController } from '../skills/recruit-board/public/live.mjs';
import * as uiSdkCore from '../skills/recruit-board/public/vendor/ui-sdk-core/index.js';

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
    id, title: `核对事项 ${id}`, state, effectiveState: state, revision: 1,
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

async function page(t, { decisions = [], highlights = [], overviewStatus = 'ok', rows = [], pinned = false, nativeDialog = false, candidateActivity = [], deferOverview = false, preview = null, workbenchWidth = null } = {}) {
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
  const query = [`workspace=${key}`, ...(pinned ? ['run=current'] : []), ...(preview ? [`preview=${preview}`] : [])].join('&');
  const dom = new JSDOM(html, { url: `http://localhost:4401/?${query}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window;
  const prevHtmlElement = globalThis.HTMLElement;
  globalThis.HTMLElement = w.HTMLElement;
  if (workbenchWidth !== null) w.__workbenchWidth = workbenchWidth;
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
  w.Element.prototype.checkVisibility ??= function () { return visible(this); };
  let scrollY = 0;
  Object.defineProperty(w, 'scrollY', { get: () => scrollY });
  w.scrollTo = (x, y) => { scrollY = y; }; w.scrollBy = (x, y) => { scrollY += y; };
  w.AbortController = AbortController; w.AbortSignal = AbortSignal; w.__model = model; w.__uiSdkCore = uiSdkCore;
  const controllers = [];
  w.__controller = settings => { const controller = createSnapshotController({ ...settings, setTimer: () => 1, clearTimer() {} }); controllers.push(controller); return controller; };
  const candidateDocs = [
    { id: 'd'.repeat(64), label: '原始简历', category: 'resume', status: 'ok', kind: 'pdf' },
    { id: 'c'.repeat(64), label: '面试档案', category: 'archive', status: 'ok', kind: 'markdown' },
    { id: 'e'.repeat(64), label: 'Word 原件', category: 'resume', status: 'ok', kind: 'docx', downloadOnly: true }
  ];
  w.fetch = async (resource, init = {}) => {
    const url = new URL(resource, w.location.href);
    requests.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (url.pathname === '/api/snapshot') return Response.json(snapshot);
    if (url.pathname === '/api/workspace/overview') { if (overviewGate) await overviewGate; return Response.json(overview); }
    if (url.pathname === '/api/candidates/detail') {
      const candidate = snapshot.candidates.find(item => item.id === url.searchParams.get('candidate'));
      assert.ok(candidate);
      return Response.json({ candidate, background: '已读取背景', notes: '已核实备注', warnings: [], documents: candidateDocs, progress: { status: 'ok', records: [{ documentId: 'c'.repeat(64), label: '面试档案', currentStatus: '面试已安排', interviews: [{ round: '一面', time: '2026-11-06 10:00–11:00', format: '视频', interviewers: '合成面试官', status: '已约' }], nextAction: '回收面试反馈', conclusion: '待面试' }] } });
    }
    if (url.pathname === '/api/candidates/materials') {
      if (init.method === 'POST') return Response.json({ changed: true, message: '资料关联已保存' });
      return Response.json({ revision: 'b'.repeat(64), files: [{ path: 'runtime/resumes/a.pdf', label: '原始简历', category: 'resume', status: 'ok' }], options: [{ path: 'runtime/resumes/extra.pdf', label: '补充简历', category: 'resume', status: 'ok' }] });
    }
    if (url.pathname === '/api/candidates/document') return new Response('# 面试记录\n\n- 候选人表达清晰\n', { status: 200, headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
    if (url.pathname === '/api/decisions' && init.method === 'POST') {
      const payload = JSON.parse(init.body);
      const target = overview.decisions?.find(d => d.id === payload.input?.id);
      if (!target) return Response.json({ error: { code: 'DECISION_NOT_FOUND', message: '事项不存在' } }, { status: 404 });
      if (payload.input.expectedRevision !== (target.revision ?? 1)) return Response.json({ error: { code: 'DECISION_REVISION_CONFLICT', message: '版本冲突' } }, { status: 409 });
      if (payload.operation === 'snooze') {
        target.state = 'snoozed'; target.effectiveState = 'snoozed'; target.snoozedUntil = payload.input.until; target.revision = (target.revision ?? 1) + 1;
      } else {
        assert.equal(payload.input.decision.scope, target.identity.scope);
        target.state = 'decided'; target.effectiveState = 'decided'; target.decision = { ...payload.input.decision, recordedAt: now };
        target.actions = (payload.input.actions ?? []).map(a => ({ ...a, status: 'pending', updatedAt: now }));
        target.followUp = { status: target.actions.length ? 'pending' : 'none' };
        target.revision = (target.revision ?? 1) + 1;
      }
      overview.counts = { open: overview.decisions.filter(i => i.effectiveState === 'open').length, snoozed: overview.decisions.filter(i => i.effectiveState === 'snoozed').length, history: overview.decisions.filter(i => i.effectiveState === 'history_review').length, followUp: overview.decisions.filter(i => i.state === 'decided').length };
      overview.revision = String(Number(overview.revision) + 1);
      return Response.json({ item: target, replayed: false, message: payload.operation === 'snooze' ? '事项已暂缓' : '已记录决定 · 待下一轮流程执行' });
    }
    if (url.pathname === '/api/roles') return Response.json({ roles: snapshot.roles.filter(role => role.configured), allowedStatuses: ['在招', '已关闭', '暂停'], unconfiguredRoles: [{ name: '台账旧称' }], roleAliases: {}, contextRevision: 'b'.repeat(64), configRevision: 'c'.repeat(64) });
    if (url.pathname === '/api/session') return Response.json({ csrfToken: 'f'.repeat(64) });
    const selected = runs.get(url.searchParams.get('run'));
    assert.ok(selected, url.pathname);
    if (url.pathname === '/api/runs/results') return Response.json({ runId: selected.id, results: selected.results, revision: selected.resultsRevision, updatedAt: selected.updatedAt });
    if (url.pathname === '/api/runs/highlights') return Response.json({ runId: selected.id, highlights: selected.highlights, revision: selected.highlightsRevision, updatedAt: selected.updatedAt });
    throw new Error(`未预期请求 ${url.pathname}`);
  };
  const executable = script.replace(/^import .* from '\/model\.mjs';\r?\n/, 'const { candidateStatus, candidateSubject, validateContext, ROLE_SCOPES, RUN_LABELS, searchCandidates, selectRoles, selectTask, STAGES, STEP_LABELS } = window.__model;\n').replace(/^import .* from '\/live\.mjs';\r?\n/m, 'const createSnapshotController = window.__controller;\n').replace(/^import \{([^}]+)\} from '\/vendor\/ui-sdk-core\/index\.js';\r?\n/m, 'const {$1} = window.__uiSdkCore;\n');
  w.eval(`(() => {${executable}\n})();`);
  t.after(() => { globalThis.HTMLElement = prevHtmlElement; w.dispatchEvent(new w.Event('pagehide')); w.close(); assert.deepEqual(errors, []); });
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

test('分拣队列展示全部待办，后续执行与全部事项均在工作台内联筛选，决定与执行状态分开', async t => {
  const items = [1, 2, 3, 4].map(id => decision(`open-${id}`));
  items.push(decision('history-1', 'history_review'), decision('history-2', 'history_review'), decision('follow', 'decided'), decision('later', 'snoozed'));
  const p = await page(t, { decisions: items, highlights: [1, 2, 3, 4].map(id => highlight(`event-${id}`)) });
  assert.equal(p.all('#workspace-decision-list > li').length, 4);
  assert.equal(p.all('#workspace-highlight-list > li').length, 3);
  assert.match(p.$('#workspace-decisions-count').textContent, /^4$/);
  assert.match(p.$('#workspace-all-decisions').textContent, /8/);
  assert.equal(p.$('[data-overview-filter="followUp"]').hidden, false);
  assert.equal(p.$('#workspace-followup-link').hidden, false);
  assert.equal(p.$('#triage-inspector').hidden, false);
  p.$('[data-overview-filter="followUp"]').click(); await settle();
  assert.equal(p.all('#workspace-decision-list > li').length, 1);
  assert.match(p.$('#workspace-decision-list').textContent, /已决定/);
  assert.match(p.$('#workspace-decision-list').textContent, /待执行/);
  p.$('#workspace-decision-list button').click(); await settle();
  assert.equal(p.$('#workspace-drawer').open, false);
  assert.match(p.$('#triage-inspector').textContent, /已明确采用此标准/);
  assert.match(p.$('#triage-inspector').textContent, /资料待同步/);
  await navigate(p, 'roles'); await navigate(p, 'overview');
  assert.equal(p.$('[data-overview-filter="followUp"]').getAttribute('aria-pressed'), 'true');
  p.$('#workspace-all-decisions').click(); await settle();
  assert.equal(p.$('#workspace-drawer').open, false);
  assert.equal(p.all('#workspace-decision-list [data-decision]').length, 8);
  assert.ok(p.$('#workspace-decision-list [data-role-group="测试在招岗"]'));
  assert.ok(p.requests.every(request => request.method === 'GET'));
});

test('没有当前待回答时直接显示历史待核对，正常空、未接入与失败不能混为零', async t => {
  const history = await page(t, { decisions: [decision('old', 'history_review')] });
  assert.equal(history.$('#triage-workbench').hidden, false);
  assert.match(history.$('#workspace-decision-list').textContent, /核对事项 old/);
  assert.match(history.$('#workspace-decision-caption').textContent, /当前没有待回答事项/);
  assert.equal(history.$('[data-overview-filter="open"]').hidden, true);
  const empty = await page(t);
  assert.equal(empty.$('#triage-workbench').hidden, true);
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

test('进展查看关联事项直达分拣台，右侧阅读原始档案打开抽屉并 Esc 回到原按钮', async t => {
  const item = decision('linked');
  const p = await page(t, { decisions: [item], highlights: [highlight('event', { decisionId: item.id })] });
  const trigger = p.$('#workspace-highlight-list button'); trigger.focus(); p.w.scrollTo(0, 180); trigger.click(); await settle();
  const evidence = p.$('#workspace-drawer-detail details'); evidence.querySelector('summary').click(); await settle();
  p.$('#workspace-drawer-content').scrollTop = 140;
  p.$('#workspace-drawer-detail [data-linked-item]').click(); await settle();
  assert.equal(p.$('#workspace-drawer').open, false);
  assert.match(p.$('#triage-inspector').textContent, /核对事项 linked/);
  const subjectBtn = p.$('#triage-inspector [data-subject]');
  subjectBtn.focus(); subjectBtn.click(); await settle();
  assert.equal(p.$('#workspace-drawer').open, true);
  assert.match(p.$('#record-content').textContent, /合成人选/);
  p.$('#workspace-drawer').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
  assert.equal(p.$('#workspace-drawer').open, false);
  assert.equal(p.w.document.activeElement.dataset.subject, candidateId);
});

test('阅读面板细节时保留可信内容、提示真实更新，新任务不抢占，失败仍保留时间与重试', async t => {
  const p = await page(t, { decisions: [decision('reading')] });
  const sources = p.all('#triage-inspector details').find(element => element.textContent.includes('来源与记录信息'));
  sources.querySelector('summary').click(); await settle();
  p.overview.decisions[0].title = '已核实的新问题'; p.overview.revision = '2';
  const newer = model.createRun({ id: 'newer', workflow: 'interview-schedule', now: '2026-11-05T06:00:00.000Z' });
  p.runs.set(newer.id, newer); p.snapshot.runs.unshift(model.runSummary(newer));
  await p.refresh();
  assert.match(p.$('#triage-inspector').textContent, /核对事项 reading/);
  assert.doesNotMatch(p.$('#triage-inspector').textContent, /已核实的新问题/);
  assert.equal(p.$('#workspace-apply-updates').hidden, false);
  assert.equal(p.$('#run').value, 'current');
  assert.equal(p.$('#workspace-return-overview').hidden, false);
  p.$('#workspace-apply-updates').click(); await settle();
  assert.match(p.$('#triage-inspector').textContent, /已核实的新问题/);
  p.overview.status = 'error'; p.overview.decisions = null; p.overview.highlights = null;
  p.overview.counts = { open: null, snoozed: null, history: null, followUp: null };
  p.overview.diagnostics = [{ message: '事项源暂不可读' }];
  await p.refresh();
  assert.match(p.$('#triage-inspector').textContent, /已核实的新问题/);
  assert.match(p.$('#workspace-overview-status').textContent, /保留最后成功读取/);
  assert.match(p.$('#workspace-overview-recorded').textContent, /最后成功读取/);
  assert.equal(p.$('#retry-workspace-overview').hidden, false);
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

test('被动切换到岗位与人选时不冻结总览更新，点击具体阶段筛选后仍缓冲提示显示更新', async t => {
  const p = await page(t, { decisions: [decision('open-1')] });
  assert.equal(p.$('#workspace-decisions-count').textContent, '1');
  await navigate(p, 'roles');
  p.overview.decisions.push(decision('open-2'));
  p.overview.counts.open = 2;
  p.overview.revision = '2';
  await p.refresh();
  assert.equal(p.$('#workspace-reading-notice').hidden, true);
  assert.equal(p.$('#workspace-decisions-count').textContent, '2');
  assert.equal(p.all('#workspace-decision-list > li').length, 2);

  p.$('#stage-talking').click(); await settle();
  p.overview.decisions.push(decision('open-3'));
  p.overview.counts.open = 3;
  p.overview.revision = '3';
  await p.refresh();
  assert.equal(p.$('#workspace-reading-notice').hidden, false);
  assert.equal(p.$('#workspace-decisions-count').textContent, '2');
  assert.equal(p.all('#workspace-decision-list > li').length, 2);
  p.$('#workspace-apply-updates').click(); await settle();
  assert.equal(p.$('#workspace-reading-notice').hidden, true);
  assert.equal(p.$('#workspace-decisions-count').textContent, '3');
  assert.equal(p.all('#workspace-decision-list > li').length, 3);
});

test('Split B 漫游焦点、单键 1/S 提交推进、输入护栏与 Shift 批量暂缓', async t => {
  const items = [1, 2, 3].map(i => decision(`d-${i}`));
  const p = await page(t, { decisions: items });
  assert.equal(p.$('#triage-queue-head').hidden, false);
  assert.match(p.$('#triage-queue-title').textContent, /分拣队列 \(3\)/);
  assert.equal(p.all('#triage-inspector .triage-fact-grid .triage-fact-box').length, 3);
  assert.match(p.$('#triage-inspector .triage-fact-grid').textContent, /沟通中 · A 级/);
  assert.ok(p.$('#triage-inspector .evidence-callout'));
  assert.ok(p.$('#triage-inspector .dossier-archive-bar [data-subject]'));
  const rows = p.all('#workspace-decision-list [data-triage-row]');
  assert.equal(rows[0].getAttribute('tabindex'), '0');
  assert.equal(rows[1].getAttribute('tabindex'), '-1');
  rows[0].focus();
  rows[0].dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await settle();
  assert.equal(p.w.document.activeElement, rows[1]);
  assert.match(p.$('#triage-inspector').textContent, /核对事项 d-2/);

  const composerInput = p.$('#triage-inspector .decision-composer-input');
  composerInput.focus();
  const inputKey = new p.w.KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true });
  composerInput.dispatchEvent(inputKey);
  assert.equal(inputKey.defaultPrevented, false);
  assert.equal(p.requests.filter(r => r.url.pathname === '/api/decisions').length, 0);

  p.$('#workspace-decisions-heading').focus();
  p.w.document.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
  await settle();
  const post1 = p.requests.filter(r => r.url.pathname === '/api/decisions').at(-1);
  assert.equal(post1.body.operation, 'decide');
  assert.equal(post1.body.input.id, 'd-2');
  assert.equal(post1.body.input.decision.scope, '测试范围');
  assert.equal(p.$('#workspace-drawer').open, false);
  assert.match(p.$('#triage-inspector').textContent, /核对事项 d-1/);

  const remaining = p.all('#workspace-decision-list [data-triage-row]');
  assert.equal(remaining.length, 2);
  remaining[0].focus();
  remaining[0].dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true }));
  await settle();
  assert.equal(p.$('#triage-batch-bar').hidden, false);
  p.$('#triage-batch-bar button').click();
  await settle();
  const snoozes = p.requests.filter(r => r.url.pathname === '/api/decisions' && r.body.operation === 'snooze');
  assert.equal(snoozes.length, 2);
  assert.match(p.$('#workspace-snoozed-link').textContent, /已暂缓 · 2/);
  p.$('[data-overview-filter="followUp"]').click(); await settle();
  p.$('#workspace-snoozed-link').click(); await settle();
  assert.equal(p.all('#workspace-decision-list > li').length, 2);
});

test('Inline C 窄窗口内联展开、切换宽度保留草稿以及提交后折叠回执与推进', async t => {
  const items = [decision('c-1'), decision('c-2')];
  const p = await page(t, { decisions: items, preview: 'narrow' });
  assert.equal(p.$('#triage-inspector').hidden, true);
  assert.equal(p.$('#triage-queue-head').hidden, true);
  assert.ok(p.$('[data-decision="c-1"].triage-stream-card.is-expanded'));
  assert.ok(p.$('[data-decision="c-1"] .triage-inline-body'));
  assert.ok(p.$('[data-decision="c-1"] .triage-inline-body .triage-fact-grid'));
  assert.ok(p.$('[data-decision="c-1"] .triage-inline-body .evidence-callout'));
  assert.equal(p.$('[data-decision="c-1"] .triage-inline-body h3'), null);
  assert.equal(p.$('[data-decision="c-2"] .triage-inline-body'), null);

  p.input('[data-decision="c-1"] .decision-composer-input', '先问清到岗时间');
  p.$('[data-preview-mode="wide"]').click();
  await settle();
  assert.equal(p.$('#triage-inspector').hidden, false);
  assert.equal(p.$('#triage-inspector .decision-composer-input').value, '先问清到岗时间');

  p.$('[data-preview-mode="narrow"]').click();
  await settle();
  assert.equal(p.$('[data-decision="c-1"] .decision-composer-input').value, '先问清到岗时间');

  p.$('#workspace-all-decisions').click(); await settle();
  p.$('[data-decision="c-1"] [data-preset="1"]').click(); await settle();
  assert.ok(p.$('[data-decision="c-1"].triage-decided-compact'));
  assert.match(p.$('[data-decision="c-1"]').textContent, /已决定 · 待下一轮执行/);
  assert.ok(p.$('[data-decision="c-2"] .triage-inline-body'));
});

test('资料弹窗嵌套 Esc 逐层剥离与原地保存均保留已展开文档预览与抽屉滚动位置', async t => {
  const p = await page(t, { decisions: [decision('archive-link')] });
  p.$('#triage-inspector [data-subject]').click(); await settle();
  assert.equal(p.$('#workspace-drawer').open, true);
  p.all('#record-content button').find(b => b.textContent === '查看').click(); await settle();
  assert.equal(p.$('#record-content .document-preview').hidden, false);
  assert.match(p.$('#record-content .document-preview').textContent, /候选人表达清晰/);
  const content = p.$('#workspace-drawer-content');
  content.scrollTop = 240;
  const trigger = p.all('#record-content button').find(b => b.textContent === '关联资料');
  trigger.click(); await settle();
  assert.ok(p.$('#material-picker'));
  assert.equal(content.scrollTop, 240);

  p.$('#material-picker').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await settle();
  assert.equal(p.$('#material-picker'), null);
  assert.equal(p.$('#workspace-drawer').open, true);
  assert.equal(p.$('#record-content .document-preview').hidden, false);
  assert.equal(content.scrollTop, 240);
  assert.equal(p.w.document.activeElement, trigger);

  trigger.click(); await settle();
  const cbs = p.all('#material-picker input[type="checkbox"]');
  cbs[1].click();
  p.$('#material-picker .primary-button').click(); await settle();
  assert.equal(p.$('#material-picker'), null);
  assert.equal(p.$('#workspace-drawer').open, true);
  assert.equal(p.$('#record-content .document-preview').hidden, false);
  assert.match(p.$('#record-content .document-preview').textContent, /候选人表达清晰/);
  assert.equal(content.scrollTop, 240);

  p.$('#workspace-drawer').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await settle();
  assert.equal(p.$('#workspace-drawer').open, false);
});

test('布局调整键盘抓起方向键移动并 Enter 提交持久化至 localStorage', async t => {
  const p = await page(t);
  p.$('#edit-layout').click(); await settle();
  const handle = p.$('#layout-handle-tasks');
  handle.focus();
  handle.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(p.all('#layout-root > [data-layout-item]').map(el => el.dataset.layoutItem), ['assistant', 'tasks', 'roles']);
  handle.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle();
  const saved = JSON.parse(p.w.localStorage.getItem(`recruiting-board:layout:v1:${key}`));
  assert.deepEqual(saved.orders.board, ['assistant', 'tasks', 'roles']);
});

test('布局调整指针拖拽排序更新 DOM 并持久化至 localStorage', async t => {
  const p = await page(t);
  p.$('#edit-layout').click(); await settle();
  const rectByItem = { assistant: { top: 0, bottom: 100, height: 100, left: 0, right: 400 }, roles: { top: 100, bottom: 200, height: 100, left: 0, right: 400 }, tasks: { top: 200, bottom: 300, height: 100, left: 0, right: 400 } };
  for (const el of p.all('#layout-root > [data-layout-item]')) el.getBoundingClientRect = () => rectByItem[el.dataset.layoutItem];
  const handle = p.$('#layout-handle-tasks');
  const pointer = (type, clientY, buttons = 1) => Object.assign(new p.w.Event(type, { bubbles: true, cancelable: true }), { button: 0, buttons, isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: 20, clientY });
  handle.dispatchEvent(pointer('pointerdown', 220, 1));
  p.w.document.dispatchEvent(pointer('pointermove', 20, 1));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(p.all('#layout-root > [data-layout-item]').map(el => el.dataset.layoutItem), ['tasks', 'assistant', 'roles']);
  p.w.document.dispatchEvent(pointer('pointerup', 20, 0));
  await settle();
  const saved = JSON.parse(p.w.localStorage.getItem(`recruiting-board:layout:v1:${key}`));
  assert.deepEqual(saved.orders.board, ['tasks', 'assistant', 'roles']);
});

test('星级与文本评级不附加级字，已关闭历史事项隐藏历史收据待核对标签', async t => {
  const starId = JSON.stringify(['星级人选', '测试在招岗']);
  const textId = JSON.stringify(['文本人选', '测试在招岗']);
  const starOpen = { ...decision('star-open', 'open'), identity: { subjectKey: starId, questionKey: 'star', scope: '测试范围' }, context: { scope: 'candidate', candidateId: starId } };
  const textOpen = { ...decision('text-open', 'open'), identity: { subjectKey: textId, questionKey: 'text', scope: '测试范围' }, context: { scope: 'candidate', candidateId: textId } };
  const letterOpen = decision('letter-open', 'open');
  const legacyClosed = { ...decision('legacy-closed', 'closed'), identity: { subjectKey: candidateId, questionKey: 'legacy', scope: '历史收据待核对' }, decision: { text: '已确认推进', scope: '历史收据待核对', recordedAt: now } };
  const legacyReview = { ...decision('legacy-review', 'history_review'), identity: { subjectKey: candidateId, questionKey: 'legacy-rev', scope: '历史收据待核对' } };
  const p = await page(t, {
    decisions: [starOpen, textOpen, letterOpen, legacyClosed, legacyReview],
    rows: [
      '5,星级人选,测试在招岗,,⭐⭐⭐⭐,已回复,测试来源,,',
      '6,文本人选,测试在招岗,,不推进,已回复,测试来源,,'
    ]
  });
  const starText = p.$('[data-decision="star-open"]').textContent;
  assert.match(starText, /星级人选 · ⭐⭐⭐⭐/);
  assert.doesNotMatch(starText, /⭐⭐⭐⭐级/);
  assert.match(p.$('#triage-inspector .triage-fact-grid').textContent, /沟通中 · ⭐⭐⭐⭐/);
  assert.doesNotMatch(p.$('#triage-inspector .triage-fact-grid').textContent, /⭐⭐⭐⭐ 级/);

  p.$('[data-decision="text-open"] [data-triage-row]').click(); await settle();
  const textRow = p.$('[data-decision="text-open"]').textContent;
  assert.match(textRow, /文本人选 · 不推进/);
  assert.doesNotMatch(textRow, /不推进级/);
  assert.match(p.$('#triage-inspector .triage-fact-grid').textContent, /沟通中 · 不推进/);

  p.$('[data-decision="letter-open"] [data-triage-row]').click(); await settle();
  assert.match(p.$('[data-decision="letter-open"]').textContent, /合成人选 · A级/);
  assert.match(p.$('#triage-inspector .triage-fact-grid').textContent, /沟通中 · A 级/);

  p.$('#workspace-all-decisions').click(); await settle();
  assert.doesNotMatch(p.$('[data-decision="legacy-closed"] .triage-row-role').textContent, /历史收据待核对/);
  assert.match(p.$('[data-decision="legacy-closed"] .triage-row-role').textContent, /^测试在招岗$/);
  p.$('[data-decision="legacy-closed"] [data-triage-row]').click(); await settle();
  assert.doesNotMatch(p.$('#triage-inspector .triage-fact-grid').textContent, /历史收据待核对/);
  assert.match(p.$('[data-decision="legacy-review"] .triage-row-role').textContent, /历史收据待核对/);
});
