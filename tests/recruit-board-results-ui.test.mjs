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
const key = 'a'.repeat(64), now = '2026-11-04T04:00:00.000Z', earlier = '2026-11-04T03:00:00.000Z';
const candidateId = JSON.stringify(['合成甲', '合成工程岗']);
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const visible = element => {
  if (!element || element.closest('[hidden]')) return false;
  for (let parent = element; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) return false;
  return true;
};

async function page(t, { decisions = [], decisionReceipt = false, configure = () => {}, respond = null } = {}) {
  const run = model.createRun({ id: 'fixture', workflow: 'daily', trigger: 'manual', now: earlier });
  run.results = [
    { id: 'older', stepId: 'screen', candidateId, action: '初步评估', outcome: '早期结论', attention: decisionReceipt ? 'decision' : 'none', nextAction: decisionReceipt ? '等待确认' : null, updatedAt: earlier, ...(decisionReceipt ? { decisionId: 'linked' } : {}) },
    { id: 'latest', stepId: 'screen', candidateId, action: '复核完成', outcome: '最新结论', attention: 'notice', nextAction: '安排下一步', updatedAt: now }
  ];
  run.resultsRevision = 2;
  run.highlights = [{ eventKey: 'evaluation', text: '最新结论及详细说明', evidence: '合成依据', context: { scope: 'candidate', candidateId }, subjectKey: candidateId, decisionId: null, occurredAt: now, updatedAt: now, correction: null }];
  run.highlightsRevision = 1;
  run.updatedAt = now;
  configure(run);
  const snapshot = model.buildSnapshot({
    workspace: '合成验收', generatedAt: now,
    ledger: { status: 'ok', text: `${model.LEDGER_COLUMNS.join(',')}\n1,合成甲,合成工程岗,,A,已回复,合成来源,,\n`, updatedAt: now },
    context: { status: 'ok', text: '## 在招岗位与优先级\n\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| 合成工程岗 | P0 | 在招 |\n', updatedAt: now },
    runFiles: { status: 'ok', files: [] }
  });
  snapshot.runs = [model.runSummary(run)]; snapshot.workspaceKey = key;
  const overview = { status: 'ok', updatedAt: now, revision: '1', decisions, highlights: [], counts: { open: decisions.filter(item => item.effectiveState === 'open').length, snoozed: 0, history: 0, followUp: 0 }, diagnostics: [] };
  const errors = [], scrolls = [], console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, { url: `http://localhost:4401/?workspace=${key}&run=fixture`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console });
  const w = dom.window;
  w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  if (!w.Element.prototype.replaceChildren) w.Element.prototype.replaceChildren = function (...children) { while (this.firstChild) this.removeChild(this.firstChild); this.append(...children); };
  w.HTMLElement.prototype.scrollIntoView = function () { scrolls.push(this.id); };
  w.HTMLElement.prototype.getClientRects = function () { return visible(this) ? [{}] : []; };
  w.scrollTo = () => {}; w.scrollBy = () => {};
  w.AbortController = AbortController; w.AbortSignal = AbortSignal; w.__model = model;
  const controllers = [];
  w.__controller = settings => { const controller = createSnapshotController({ ...settings, setTimer: () => 1, clearTimer() {} }); controllers.push(controller); return controller; };
  w.fetch = async (resource, init = {}) => {
    const url = new URL(resource, w.location.href);
    const payloads = {
      '/api/snapshot': snapshot, '/api/workspace/overview': overview,
      '/api/runs/results': { runId: run.id, results: run.results, revision: run.resultsRevision, updatedAt: now },
      '/api/runs/highlights': { runId: run.id, highlights: run.highlights, revision: run.highlightsRevision, updatedAt: now },
      '/api/runs/activity': { runId: run.id, items: run.results.slice(-3), revision: run.resultsRevision, updatedAt: now }
    };
    if (respond) { const response = await respond(url, init, payloads); if (response) return response; }
    assert.ok(Object.hasOwn(payloads, url.pathname), url.pathname);
    return Response.json(payloads[url.pathname]);
  };
  const executable = script.replace(/^import .* from '\/model\.mjs';\r?\n/, 'const { candidateStatus, candidateSubject, validateContext, ROLE_SCOPES, RUN_LABELS, searchCandidates, selectRoles, selectTask, STAGES, STEP_LABELS } = window.__model;\n').replace(/^import .* from '\/live\.mjs';\r?\n/m, 'const createSnapshotController = window.__controller;\n');
  w.eval(`(() => {${executable}\n})();`);
  t.after(() => { w.dispatchEvent(new w.Event('pagehide')); w.close(); assert.deepEqual(errors, []); });
  await settle();
  return { w, $: selector => w.document.querySelector(selector), all: selector => [...w.document.querySelectorAll(selector)], scrolls, run, overview, snapshot, refresh: async () => { await Promise.all(controllers.map(controller => controller.refresh({ invalidate: true }))); await settle(); } };
}

function decision(state) {
  return { schemaVersion: 1, id: 'linked', title: '合成确认事项', state, effectiveState: state, revision: 1, identity: { subjectKey: candidateId, questionKey: 'next', scope: '本轮' }, createdAt: earlier, updatedAt: now, deadline: null, blocking: false, snoozedUntil: null, reason: null, sources: [{ runId: 'fixture', resultId: 'older', recordedAt: earlier }], decision: null, actions: [], history: [], followUp: { status: 'none', counts: { pending: 0, running: 0, done: 0, failed: 0, uncertain: 0, cancelled: 0 } } };
}

test('同一人结果和重点归在一个默认可见条目，最新结论优先，过程可展开', async t => {
  const p = await page(t);
  assert.ok(visible(p.$('#run-results')));
  assert.equal(p.all('#result-list > .result-person').length, 1);
  assert.equal(p.all('#run-highlight-list > li').length, 0);
  assert.equal(visible(p.$('#run-activity')), false);
  assert.match(p.$('#result-list .result-outcome').textContent, /最新结论/);
  const history = p.$('#result-list .result-history');
  assert.ok(history); assert.equal(history.open, false);
  history.querySelector('summary').click(); await settle();
  assert.equal(history.open, true); assert.match(history.textContent, /早期结论/);
});

test('处理名单按钮把结果标题带到可见位置，零项待回答不显示按钮', async t => {
  const p = await page(t);
  p.$('#show-run-results').click(); await settle();
  assert.ok(p.scrolls.includes('run-results-heading'));
  assert.equal(p.w.document.activeElement, p.$('#run-results-heading'));
  assert.equal(p.$('#show-run-decisions').hidden, true);
});

test('已关闭事项不再因旧收据被算作当前待回答，历史仍可查', async t => {
  const p = await page(t, { decisions: [decision('closed')], decisionReceipt: true });
  assert.equal(p.$('#show-run-decisions').hidden, true);
  assert.match(p.$('#run-confirmation-note').textContent, /暂无待回答/);
  assert.match(p.$('#confirmation-history').textContent, /合成确认事项/);
  assert.equal(p.$('#confirmation-history').open, false);
});

test('当前待回答按关联事项计项并定位确认区域', async t => {
  const p = await page(t, { decisions: [decision('open')], decisionReceipt: true });
  assert.equal(p.$('#show-run-decisions').hidden, false);
  assert.match(p.$('#run-result-decisions').textContent, /1 项/);
  p.$('#show-run-decisions').click(); await settle();
  assert.equal(p.w.document.activeElement, p.$('#decisions-heading'));
  assert.match(p.$('#decision-list').textContent, /合成确认事项/);
});

test('重点先到、关联后到及后来产生歧义时不会重复或丢记录', async t => {
  let complete;
  const p = await page(t, {
    decisionReceipt: true,
    configure: run => { delete run.highlights[0].context; run.highlights[0].subjectKey = null; run.highlights[0].decisionId = 'linked'; run.highlights.push({ ...run.highlights[0], eventKey: 'workspace', text: '工作区记录', decisionId: null, context: { scope: 'workspace' } }); },
    respond: (url, init, payloads) => url.pathname === '/api/runs/results' && !complete ? new Promise(resolve => { complete = () => resolve(Response.json(payloads[url.pathname])); }) : null
  });
  assert.ok(p.$('#run-highlight-list [data-event="evaluation"]'));
  complete(); await settle();
  assert.equal(p.$('#run-highlight-list [data-event="evaluation"]'), null);
  assert.ok(p.$('#result-list [data-event="evaluation"]'));
  p.run.results.push({ ...p.run.results[0], id: 'different', candidateId: JSON.stringify(['合成乙', '合成工程岗']) });
  p.run.resultsRevision++;
  p.snapshot.runs = [model.runSummary(p.run)];
  await p.refresh();
  assert.ok(p.$('#run-highlight-list [data-event="evaluation"]'));
  assert.equal(p.$('#result-list [data-event="evaluation"]'), null);
});

test('处理历史保留旧下一步，新关联不被失效旧路径阻塞', async t => {
  const requests = [];
  const p = await page(t, {
    decisionReceipt: true,
    respond: (url, init) => {
      if (url.pathname === '/api/candidates/detail') return Response.json({ candidate: { id: candidateId, name: '合成甲', role: '合成工程岗', rawRole: '合成工程岗', rawStatus: '已回复', rating: 'A' }, documents: [], warnings: [] });
      if (url.pathname === '/api/candidates/materials') {
        if (init.method === 'POST') { requests.push(JSON.parse(init.body)); return Response.json({ changed: true }); }
        return Response.json({ revision: 'b'.repeat(64), files: [{ path: 'runtime/resumes/missing.pdf', label: '失效旧简历', category: 'resume', status: 'missing' }], options: [{ path: 'runtime/resumes/new.pdf', label: '新简历', category: 'resume' }] });
      }
      if (url.pathname === '/api/session') return Response.json({ csrfToken: 'c'.repeat(64) });
      return null;
    }
  });
  p.$('#result-list .result-history summary').click(); await settle();
  assert.match(p.$('#result-list .result-history').textContent, /等待确认/);
  p.$('#result-list .candidate-link').click(); await settle();
  p.$('#record-content .subsection-heading button').click(); await settle();
  const choices = p.all('#material-picker input[type="checkbox"]');
  assert.equal(choices[0].checked, false); assert.equal(choices[0].disabled, true);
  choices[1].click(); await settle();
  p.$('#material-picker .primary-button').click(); await settle();
  assert.deepEqual(requests[0].files, [{ path: 'runtime/resumes/new.pdf', label: '新简历', category: 'resume' }]);
});

test('打开人选即见面试进度，时间和下一步不藏在文件或背景折叠中', async t => {
  const p = await page(t, { respond: url => {
    if (url.pathname !== '/api/candidates/detail') return null;
    return Response.json({ candidate: { id: candidateId, name: '合成甲', role: '合成工程岗', rawRole: '合成工程岗', rawStatus: '已约谈', rating: 'A' }, documents: [], warnings: [], progress: { status: 'ok', message: null, records: [{ documentId: 'd'.repeat(64), label: '面试档案', currentStatus: '已约一面', conclusion: '待面', nextAction: '面后回收反馈', interviews: [{ round: '一面', time: '2026-11-06 10:30–11:30', format: '现场到面', interviewers: '合成面试官', status: '已约' }] }] } });
  } });
  p.$('#result-list .candidate-link').click(); await settle();
  const progress = p.$('#candidate-progress');
  assert.ok(visible(progress));
  assert.match(progress.textContent, /2026-11-06 10:30–11:30/);
  assert.match(progress.textContent, /合成面试官/);
  assert.match(progress.textContent, /面后回收反馈/);
  for (let parent = progress.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') assert.equal(parent.open, true);
  }
  const children = [...p.$('#record-content').children];
  assert.ok(children.indexOf(progress) < children.findIndex(element => element.classList.contains('document-list')));
});

test('普通聊天的档案事件可从近期进展打开人选与来源，不生成虚假任务链接', async t => {
  const p = await page(t, { respond: (url, init, payloads) => {
    if (url.pathname !== '/api/workspace/overview') return null;
    return Response.json({ ...payloads[url.pathname], highlights: [{ eventKey: 'archive-manual', text: '一面已安排', evidence: '已核对档案与用户确认', occurredAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', timePrecision: 'day', runId: null, sourceRunIds: [], sourceKind: 'archive', sourceDocumentId: 'd'.repeat(64), context: { scope: 'candidate', candidateId }, details: [{ label: '预约时段', value: '2026-11-06 10:30–11:30' }] }] });
  } });
  p.$('[data-nav-target="overview"]').click(); await settle();
  assert.match(p.$('#workspace-highlight-list').textContent, /一面已安排/);
  assert.match(p.$('#workspace-highlight-list').textContent, /当日，未记时分/);
  assert.doesNotMatch(p.$('#workspace-highlight-list').textContent, /00:00/);
  p.$('#workspace-highlight-list button').click(); await settle();
  assert.ok(p.$('#workspace-drawer-detail [data-subject]'));
  assert.equal(p.$('#workspace-drawer-detail .workspace-run-link'), null);
  assert.ok(p.all('#workspace-drawer-detail a').some(link => link.textContent === '打开来源档案'));
});

test('档案排期缺进展事件时首页显示可操作的覆盖提示', async t => {
  const p = await page(t, { respond: (url, init, payloads) => {
    if (url.pathname !== '/api/workspace/overview') return null;
    return Response.json({ ...payloads[url.pathname], diagnostics: [{ code: 'PROGRESS_EVENT_MISSING', source: 'candidate-progress', level: 'warning', message: '缺少对应时段的发生日期事件', candidateId }] });
  } });
  p.$('[data-nav-target="overview"]').click(); await settle();
  assert.equal(p.$('#progress-coverage').hidden, false);
  assert.match(p.$('#progress-coverage-summary').textContent, /1 份档案/);
  assert.match(p.$('#progress-coverage-list').textContent, /合成甲/);
  assert.ok(p.$('#progress-coverage-list button'));
});
