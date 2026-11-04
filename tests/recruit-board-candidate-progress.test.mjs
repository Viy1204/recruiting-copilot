import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LEDGER_COLUMNS } from '../skills/recruit-board/model.mjs';
import { readCandidateDetail } from '../skills/recruit-board/scripts/records.mjs';

const candidateId = JSON.stringify(['合成甲', '合成工程岗']);
const archive = `# 面试档案 — 合成甲

## 基本信息
- **姓名**：合成甲
- **应聘岗位**：合成工程岗｜保留原备注
- **当前状态**：已约一面

## 初筛结论
- 结论：曾建议先核对经历
- 下一步：旧评估动作，不作为当前下一步

## 面试安排
| 轮次 | 时间 | 形式 | 面试官 | 状态 |
|---|---|---|---|---|
| 一面 | 2026-11-06 10:30–11:30 | 现场到面 | 合成面试官 | 已约（邀约已发出） |

## 决策
- 结论：待面。
- 下一步：面后回收反馈。
`;

async function fixture(t, { explicit = true, twoRoles = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'candidate-progress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['02-sourcing', '03-interview', '_shared']) await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, 'CONTEXT.md'), '## 在招岗位与优先级\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| 合成工程岗 | P0 | 在招 |\n| 另一岗位 | P1 | 在招 |\n');
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), `${LEDGER_COLUMNS.join(',')}\n1,合成甲,合成工程岗,,A,已约谈,合成来源,,\n${twoRoles ? '2,合成甲,另一岗位,,A,已回复,合成来源,,\n' : ''}`);
  await writeFile(path.join(root, '03-interview/合成甲.md'), archive);
  if (explicit) await writeFile(path.join(root, '_shared/recruit-board.files.json'), JSON.stringify({ schemaVersion: 1, candidates: { [candidateId]: { confirmed: true, files: [{ path: '03-interview/合成甲.md', category: 'archive', kind: 'markdown', label: '面试档案' }] } } }));
  return root;
}

test('已确认档案中的面试安排和当前下一步直接进入候选进度，不改台账状态', async t => {
  const root = await fixture(t);
  const detail = await readCandidateDetail(root, candidateId);
  assert.equal(detail.candidate.rawStatus, '已约谈');
  assert.equal(detail.progress.status, 'ok');
  assert.equal(detail.progress.records.length, 1);
  const progress = detail.progress.records[0];
  assert.equal(progress.documentId, detail.documents[0].id);
  assert.equal(progress.currentStatus, '已约一面');
  assert.equal(progress.conclusion, '待面。');
  assert.equal(progress.nextAction, '面后回收反馈。');
  assert.deepEqual(progress.interviews, [{ round: '一面', time: '2026-11-06 10:30–11:30', format: '现场到面', interviewers: '合成面试官', status: '已约（邀约已发出）' }]);
  assert.doesNotMatch(JSON.stringify(detail.progress), /旧评估动作|曾建议/);
});

test('自动核实的档案同样显示进度；同名异岗未确认档案不提取进度', async t => {
  const root = await fixture(t, { explicit: false });
  await writeFile(path.join(root, '03-interview/合成甲.md'), archive.replace('合成工程岗｜保留原备注', '合成工程岗'));
  assert.equal((await readCandidateDetail(root, candidateId)).progress.records.length, 1);
  const other = await fixture(t, { explicit: false, twoRoles: true });
  const detail = await readCandidateDetail(other, candidateId);
  assert.equal(detail.progress.status, 'missing');
  assert.deepEqual(detail.progress.records, []);
});

test('取消、改期及过去时间按原记录显示，空模板和介绍不能冒充已安排面试', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, '03-interview/合成甲.md'), archive.replace('已约一面', '已改期，等待确认').replace('| 已约（邀约已发出） |', '| 已取消 |'));
  const detail = await readCandidateDetail(root, candidateId);
  assert.equal(detail.progress.records[0].currentStatus, '已改期，等待确认');
  assert.equal(detail.progress.records[0].interviews[0].status, '已取消');
  await writeFile(path.join(root, '03-interview/合成甲.md'), '# 面试档案\n## 基本信息\n- 当前状态：〔已约谈 / 面试中〕\n## 面试安排\n| 轮次 | 时间 | 形式 | 面试官 | 状态 |\n|---|---|---|---|---|\n## 决策\n- 结论：\n- 下一步：\n');
  assert.equal((await readCandidateDetail(root, candidateId)).progress.status, 'missing');
  await writeFile(path.join(root, '_shared/recruit-board.files.json'), JSON.stringify({ schemaVersion: 1, candidates: { [candidateId]: { confirmed: true, files: [{ path: '03-interview/合成甲.md', category: 'brief' }] } } }));
  assert.deepEqual((await readCandidateDetail(root, candidateId)).progress.records, []);
});

test('关联档案读取失败与没有进度分别表达，其他可读进度保留', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, '_shared/recruit-board.files.json'), JSON.stringify({ schemaVersion: 1, candidates: { [candidateId]: { confirmed: true, files: [{ path: '03-interview/合成甲.md', category: 'archive' }, { path: '03-interview/missing.md', category: 'archive' }] } } }));
  const detail = await readCandidateDetail(root, candidateId);
  assert.equal(detail.progress.status, 'partial');
  assert.equal(detail.progress.records.length, 1);
  await rm(path.join(root, '03-interview/合成甲.md'));
  assert.equal((await readCandidateDetail(root, candidateId)).progress.status, 'error');
});
