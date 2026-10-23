import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { recordProgress } from '../skills/recruit-board/scripts/progress.mjs';
import { assertRunId, validateRun } from '../skills/recruit-board/model.mjs';

const workspace = fileURLToPath(new URL('./recruit-board-demo/', import.meta.url));
const [command, providedId] = process.argv.slice(2);
const id = command === 'start' ? `verify-live-${randomUUID()}` : assertRunId(providedId);
if (!id.startsWith('verify-live-')) throw new Error('只允许修改本脚本创建的合成验证任务');
const record = action => recordProgress({ workspace, id, workflow: 'daily', role: '测试研发岗', ownerSessionId: 'verification-live', action });
let run;
if (command === 'start') {
  run = await record({ type: 'start' });
  run = await record({ type: 'step', step: 'unread' });
} else if (command === 'screen') {
  run = await record({ type: 'complete', step: 'unread' });
  for (const step of ['priorities', 'sourcing']) run = await record({ type: 'skip', step, reason: '合成演示不连接招聘平台' });
  run = await record({ type: 'step', step: 'screen' });
} else if (command === 'result' || command === 'decision' || command === 'resolve') {
  const decision = command === 'decision';
  run = await record({ type: 'result', result: { id: 'synthetic-a-screen', stepId: 'screen', candidateId: JSON.stringify(['演示候选人甲', '测试研发岗']), action: '初筛记录', outcome: decision ? '核心经历已核对，地点安排待确认。' : command === 'resolve' ? '地点安排已确认，可继续推进。' : '已核对合成材料，记录首次处理结论。', attention: decision ? 'decision' : 'none', nextAction: decision ? '是否按本地到岗安排继续沟通？' : null } });
  if (decision) run = await record({ type: 'wait', reason: '等待确认合成人选安排' });
} else if (command === 'finish') {
  const file = path.join(workspace, 'runtime/recruit-board/runs', `${id}.json`);
  run = validateRun(JSON.parse(await readFile(file, 'utf8')), id);
  for (const step of run.steps) {
    if (step.status === 'running') run = await record({ type: 'complete', step: step.id });
    else if (step.status === 'pending') run = await record({ type: 'skip', step: step.id, reason: '合成演示未执行该业务步骤' });
  }
  run = await record({ type: 'complete' });
} else if (command === 'remove') {
  await rm(path.join(workspace, 'runtime/recruit-board/runs', `${id}.json`));
  console.log(JSON.stringify({ removed: id }));
} else throw new Error('用法：start | screen/result/decision/resolve/finish/remove <start返回的runId>');
if (run) console.log(JSON.stringify({ id: run.id, status: run.status, revision: run.resultsRevision, step: run.steps.find(step => step.status === 'running')?.id ?? null }));
