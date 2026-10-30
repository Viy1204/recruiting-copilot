import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, LEDGER_COLUMNS, validateRun } from '../skills/recruit-board/model.mjs';

const audit = fileURLToPath(new URL('../.audit/', import.meta.url));
await mkdir(audit, { recursive: true });
const root = await mkdtemp(path.join(audit, 'workbench-preview-'));
await Promise.all(['02-sourcing', 'runtime/recruit-board/runs', 'runtime/resumes', '_shared'].map(name => mkdir(path.join(root, name), { recursive: true })));
const context = '# 轻量工作台合成预览\n\n全部岗位、人选和任务仅用于界面验证，均为合成数据。\n\n## 在招岗位与优先级\n\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| 预览研发岗 | P0 | 在招 |\n| 预览设计岗 | P1 | 在招 |\n| 预览历史岗 | P2 | 已关闭 |\n| 预览空岗 | P2 | 在招 |\n';
const people = [
  ['合成林沐', '预览研发岗', '待确认'],
  ['合成林沐', '预览历史岗', '已拒'],
  ['合成林沐', '预览旧研发岗', '已回复'],
  ['合成林沐川', '预览设计岗', '面试中'],
  ['合成周霁', '预览历史岗', '已排除'],
  ['Ａｌｅｘ Ｃｈｅｎ', '预览设计岗', '已回复'],
  ['合成[甲]+', '预览研发岗', '待初筛'],
  ...Array.from({ length: 24 }, (_, index) => [`合成人选${String(index + 1).padStart(2, '0')}`, index % 2 ? '预览设计岗' : '预览研发岗', index % 3 ? '已回复' : '初筛通过'])
];
const csvCell = value => `"${String(value).replaceAll('"', '""')}"`;
const ledger = `${LEDGER_COLUMNS.join(',')}\n${people.map(([name, role, status], index) => [index + 1, name, role, '合成背景摘要，仅供界面测试', 'A', status, 'synthetic-workbench', index === 0 ? 'runtime/resumes/synthetic-profile.txt' : '', '仅用于界面验证，不是真实候选人'].map(csvCell).join(',')).join('\n')}\n`;
const timestamp = minute => `2026-10-29T01:${String(minute).padStart(2, '0')}:00.000Z`;
const specs = [
  { id: 'wb-unknown', state: 'completed', label: '未记录确认事项', minute: 0 },
  { id: 'wb-running', state: 'running', label: '执行中', minute: 10 },
  { id: 'wb-failed', state: 'failed', label: '失败原因', minute: 20, reason: '合成失败：资料文件暂不可读，需恢复后重试。' },
  { id: 'wb-waiting', state: 'waiting', label: '等待原因', minute: 30, reason: '合成等待：本轮资料待补充，等待你确认补充范围。' },
  { id: 'wb-decisions', state: 'completed', label: '六人需确认', minute: 40 },
  { id: 'wb-empty', state: 'completed', label: '无待确认', minute: 50 }
];
for (const spec of specs) {
  const now = timestamp(spec.minute);
  const run = createRun({ id: spec.id, workflow: 'daily', role: '预览研发岗', now });
  run.status = spec.state;
  run.reason = spec.reason ?? null;
  if (spec.state === 'completed') run.steps = run.steps.map(step => ({ ...step, status: 'completed' }));
  else {
    run.steps[0].status = 'completed';
    run.steps[1].status = spec.state === 'failed' ? 'failed' : 'running';
    run.steps[1].reason = spec.state === 'failed' ? spec.reason : null;
  }
  if (spec.id === 'wb-unknown') run.results = null;
  if (spec.id === 'wb-decisions') {
    run.results = [0, 3, 7, 8, 9, 10].map((personIndex, index) => ({
      id: `decision-${index + 1}`, stepId: 'screen', candidateId: JSON.stringify(people[personIndex].slice(0, 2)),
      action: '完成合成资料核对', outcome: '基础信息已记录，下一步安排需要确认。', attention: 'decision',
      nextAction: index === 0 ? '确认是否安排进一步沟通，或继续补充项目材料。' : '确认下一轮沟通安排。', updatedAt: now
    }));
    run.results.push({ id: 'decision-extra', stepId: 'screen', candidateId: JSON.stringify(people[0].slice(0, 2)), action: '补充合成评估依据', outcome: '保留第二条独立确认事项，用于验证资料与依据入口。', attention: 'decision', nextAction: '确认需要补充的作品范围。', updatedAt: now });
    run.resultsRevision = run.results.length;
  }
  await writeFile(path.join(root, `runtime/recruit-board/runs/${spec.id}.json`), `${JSON.stringify(validateRun(run), null, 2)}\n`);
}
await Promise.all([
  writeFile(path.join(root, 'CONTEXT.md'), context),
  writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), ledger),
  writeFile(path.join(root, '_shared/recruit-board.config.json'), JSON.stringify({ schemaVersion: 1, statusStages: {}, roleAliases: { 预览旧研发岗: '预览研发岗' } }, null, 2)),
  writeFile(path.join(root, 'runtime/resumes/synthetic-profile.txt'), '合成林沐\n此资料仅用于工作台界面的搜索与详情返回验证。\n')
]);
const workspace = process.argv[2];
if (workspace) {
  const relatives = ['skills', '.claude/skills', '.agents/skills', '.qoder/skills'].flatMap(entry => ['model.mjs', 'public/app.js', 'public/index.html', 'public/style.css', 'types/index.d.ts', 'recruiting-board.test.ts', ...(entry === '.claude/skills' ? [] : ['hooks/register.tsx'])].map(file => `${entry}/recruit-board/${file}`));
  const hashes = Object.fromEntries(await Promise.all(relatives.map(async relative => [relative, createHash('sha256').update(await readFile(path.join(workspace, relative))).digest('hex')])));
  await writeFile(path.join(root, 'installed-before.json'), JSON.stringify({ workspace, hashes }, null, 2));
}
console.log(JSON.stringify({ workspace: root, candidates: people.length, scenarios: specs.map(({ id, label }) => ({ id, label })) }, null, 2));
