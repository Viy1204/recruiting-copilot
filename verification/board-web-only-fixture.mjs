import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, transitionRun, LEDGER_COLUMNS, WORKFLOWS } from '../skills/recruit-board/model.mjs';
import { applyDecisionCommand, initializeDecisions } from '../skills/recruit-board/scripts/decisions.mjs';
import { importLegacyDecisions } from '../skills/recruit-board/scripts/import-history.mjs';
import { readWorkspaceOverview } from '../skills/recruit-board/scripts/overview.mjs';

const audit = fileURLToPath(new URL('../.audit/', import.meta.url));
const [operation = 'create', inputRoot] = process.argv.slice(2);
const at = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const engineer = '合成引擎工程师', artist = '合成技术美术（角色表现与实时渲染方向）';
const personId = JSON.stringify(['合成林澈', engineer]);
const csv = value => `"${String(value).replaceAll('"', '""')}"`;
let root;
if (operation === 'create') {
  await mkdir(audit, { recursive: true });
  root = await mkdtemp(path.join(audit, 'board-web-only-'));
  await Promise.all(['02-sourcing', 'runtime/resumes', 'runtime/recruit-board/runs'].map(directory => mkdir(path.join(root, directory), { recursive: true })));
  await writeFile(path.join(root, 'CONTEXT.md'), `# 网页看板虚构验收工作区\n\n所有人选、岗位和结果仅用于测试。\n\n## 在招岗位与优先级\n\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| ${engineer} | P0 | 在招 |\n| ${artist} | P1 | 在招 |\n| 合成内容运营 | P2 | 暂停 |\n| 合成历史策划 | P2 | 已关闭 |\n| 合成下架岗 | P2 | 已下架 |\n| 合成待核岗 | P2 | 待核 |\n| 合成未标状态岗 | P2 | |\n`);
  const people = [
    ['合成林澈', engineer, '已约面', 'runtime/resumes/synthetic-profile.txt'],
    ['合成岑遥', artist, '待确认', ''],
    ['合成林澈', '合成历史策划', '已排除', ''],
    ['合成探索人选', '合成探索岗', '已回复', ''],
    ['合成长姓名用于窄屏文字换行验证', artist, '已回复', ''],
    ['合成运营人选', '合成内容运营', '已回复', '']
  ];
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), `${LEDGER_COLUMNS.join(',')}\n${people.map(([name, role, status, resume], index) => [index + 1, name, role, '完全虚构的验收经历', 'A', status, 'web-only-fixture', resume, '非真实候选人'].map(csv).join(',')).join('\n')}\n`);
  await writeFile(path.join(root, 'runtime/resumes/synthetic-profile.txt'), '合成林澈\n合成引擎工程师\n仅供交互验收的人选资料，不对应真实招聘记录。\n');
  await initializeDecisions(root);
  const save = run => writeFile(path.join(root, 'runtime/recruit-board/runs', `${run.id}.json`), JSON.stringify(run, null, 2));
  const finish = (run, when, summary = '虚构巡检已完成，无重要变化') => {
    for (const step of WORKFLOWS.daily.steps) run = transitionRun(run, { type: 'skip', step: step.id, reason: '隔离验收，不操作招聘平台' }, when);
    run = transitionRun(run, { type: 'summary', summaryState: run.highlights?.length ? 'highlights' : 'no_change', closingSummary: summary }, when);
    return transitionRun(run, { type: 'complete' }, when);
  };
  let main = createRun({ id: 'web-main', workflow: 'daily', trigger: 'manual', now: at(240) });
  main = transitionRun(main, { type: 'result', result: { id: 'person-main', stepId: 'screen', candidateId: personId, action: '核对面试安排', outcome: '虚构人选已确认时间，待确认面试重点', attention: 'decision', nextAction: '是否重点核实跨团队协作经历' } }, at(230));
  await save(main);
  const register = async (key, title, extra, created) => (await applyDecisionCommand(root, 'register', { requestId: key, expectedRevision: 0, identity: { subjectKey: key, questionKey: 'review', scope: '合成验收范围' }, title, source: { runId: main.id }, ...extra }, () => created)).item;
  const mainDecision = await register('synthetic-interview', '是否重点核实跨团队协作经历', { source: { runId: main.id, resultId: 'person-main' }, context: { scope: 'candidate', candidateId: personId }, evidence: '项目经历匹配，跨团队协作的职责范围仍需面试核实。', blocking: true }, at(220));
  await register('synthetic-role', '是否接受偏角色表现方向的作品集', { context: { scope: 'role', role: artist }, evidence: '作品质量符合预期，但角色表现与工具开发的工作占比需要明确。' }, at(210));
  const third = await register('synthetic-person', '是否进入下一步技术沟通', { context: { scope: 'candidate', candidateId: JSON.stringify(['合成岑遥', artist]) }, evidence: '具备相关实时渲染作品，需要确认是否接受岗位的工具开发工作。' }, at(200));
  const shared = await register('synthetic-workspace', '是否统一下一轮材料提交格式', { context: { scope: 'workspace' }, evidence: '不同岗位的材料格式不一致，需确认工作区统一约定。' }, at(190));
  await applyDecisionCommand(root, 'snooze', { id: shared.id, expectedRevision: shared.revision, requestId: 'snooze-shared', until: null, reason: '虚构场景：用户已暂缓' });
  main = transitionRun(main, { type: 'highlight', highlight: { eventKey: 'synthetic-interview-booked', text: '视频面试已约', context: { scope: 'candidate', candidateId: personId }, details: [{ label: '预约时段', value: '次日 14:00–15:00' }, { label: '面试官', value: '合成面试官' }], decisionId: mainDecision.id, evidence: '虚构候选人和面试官均已确认预约，待明确协作经历的追问重点。' } }, at(180));
  await save(finish(main, at(170), '已核实面试预约，并记录需要确认的问题'));
  const history = createRun({ id: 'web-history', workflow: 'daily', trigger: 'unknown', now: at(3000) });
  let legacy = history;
  for (const [index, name, role] of [[1, '合成林澈', '合成历史策划'], [2, '合成未入账人选', engineer]]) {
    legacy = transitionRun(legacy, { type: 'result', result: { id: `legacy-${index}`, stepId: 'screen', candidateId: JSON.stringify([name, role]), action: '历史初筛', outcome: '当时经历达到沟通门槛，历史记录仍需核对当前有效性。', attention: 'decision', nextAction: '是否继续推进沟通' } }, at(2900));
  }
  await save(finish(legacy, at(2800)));
  await importLegacyDecisions(root, legacy.id);
  await register('synthetic-unlinked', '旧问题的适用岗位仍需核对', { evidence: '旧记录没有可靠人岗引用，保留原始问题。' }, at(160));
  const latestTime = at(5);
  for (const id of ['a0000000-1111-4222-8333-444444444441', 'a0000000-1111-4222-8333-444444444442']) await save(finish(createRun({ id, workflow: 'daily', trigger: 'scheduled', now: latestTime }), latestTime));
  const marker = { kind: 'board-web-only', root, mainId: mainDecision.id, thirdId: third.id, personId, engineer, artist };
  await writeFile(path.join(root, 'web-only-fixture.json'), JSON.stringify(marker, null, 2));
  process.stdout.write(`${JSON.stringify(marker, null, 2)}\n`);
} else {
  root = await realpath(inputRoot);
  const relative = path.relative(await realpath(audit), root);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('仅允许隔离验收工作区');
  const marker = JSON.parse(await readFile(path.join(root, 'web-only-fixture.json'), 'utf8'));
  if (marker.kind !== 'board-web-only' || await realpath(marker.root) !== root) throw new Error('虚构工作区标记不符');
  if (operation === 'more-highlights') {
    let run = createRun({ id: 'web-more', workflow: 'daily', trigger: 'manual', now: at(1) });
    for (let index = 0; index < 4; index++) run = transitionRun(run, { type: 'highlight', highlight: { eventKey: `synthetic-extra-${index}`, text: `虚构旧格式进展 ${index + 1}：保留原文供核对`, evidence: '旧版记录无结构化对象，不能猜测人岗。' } }, at(1));
    await writeFile(path.join(root, 'runtime/recruit-board/runs/web-more.json'), JSON.stringify(run, null, 2));
  } else if (operation === 'all-active') {
    const file = path.join(root, 'CONTEXT.md');
    const original = await readFile(file, 'utf8');
    await writeFile(path.join(root, 'context-backup.txt'), original, { flag: 'wx' });
    await writeFile(file, original.replace(/\| P2 \|[^\n]*\|/g, '| P2 | 在招 |') + '| 合成探索岗 | P2 | 在招 |\n');
  } else if (operation === 'restore-context') {
    await writeFile(path.join(root, 'CONTEXT.md'), await readFile(path.join(root, 'context-backup.txt'), 'utf8'));
  } else if (operation !== 'overview') throw new Error('未知验收操作');
  process.stdout.write(`${JSON.stringify(await readWorkspaceOverview(root), null, 2)}\n`);
}
