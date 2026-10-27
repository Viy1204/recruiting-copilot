import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { recordProgress } from '../skills/recruit-board/scripts/progress.mjs';
import { assertRunId, validateRun } from '../skills/recruit-board/model.mjs';

const workspace = fileURLToPath(new URL('./recruit-board-demo/', import.meta.url));
const [command, providedId] = process.argv.slice(2);
const id = command === 'start' ? `verify-focus-${randomUUID()}` : assertRunId(providedId);
if (!id.startsWith('verify-focus-')) throw new Error('只操作本脚本创建的合成验证任务');
const file = path.join(workspace, 'runtime/recruit-board/runs', `${id}.json`);
const record = action => recordProgress({ workspace, id, workflow: 'daily', role: '测试研发岗', ownerSessionId: 'verification-focus', action });
const result = (receiptId, name, stepId, outcome, nextAction) => record({ type: 'result', result: { id: receiptId, stepId, candidateId: JSON.stringify([name, '测试研发岗']), action: '核对合成资料', outcome, attention: nextAction ? 'decision' : 'none', nextAction } });
let run;
if (command === 'start') {
  run = await record({ type: 'start' });
  for (const step of ['unread', 'priorities', 'sourcing']) run = await record({ type: 'skip', step, reason: '合成场景，不连接招聘平台' });
  run = await record({ type: 'step', step: 'screen' });
  run = await result('a-screen', '演示候选人甲', 'screen', '资料中尚未确认到岗地点，需在初筛结论前核实。', '是否继续核实这位人选的到岗地点？');
  run = await result('a-greet', '演示候选人甲', 'greet', '已准备沟通提纲，尚未发送。', '是否授权联系并确认到岗安排？');
  run = await result('d-screen', '演示候选人丁', 'screen', '现有评估支持进一步约谈，安排等待确认。', '是否安排首轮约谈？');
  run = await result('b-ledger', '演示候选人乙', 'ledger', '已核对合成台账，无需用户处理。', null);
  run = await record({ type: 'wait', reason: '等待确认本轮人选安排' });
} else if (command === 'many') {
  for (let index = 1; index <= 5; index++) run = await result(`extra-${index}`, `演示待确认${index}`, 'screen', '这是未入台账的合成记录，用于验证更多确认事项入口。', `是否继续核实第 ${index} 位演示人选的材料？`);
} else if (command === 'resolve') {
  const previous = validateRun(JSON.parse(await readFile(file, 'utf8')), id);
  for (const receipt of previous.results ?? []) {
    if (receipt.attention !== 'decision') continue;
    const { updatedAt, ...input } = receipt;
    run = await record({ type: 'result', result: { ...input, attention: 'none', nextAction: null, outcome: '合成验证已处理此确认事项，未执行任何平台动作。' } });
  }
  run = await record({ type: 'complete', step: 'screen' });
  run = await record({ type: 'step', step: 'ledger' });
} else if (command === 'remove') {
  validateRun(JSON.parse(await readFile(file, 'utf8')), id);
  await rm(file);
  console.log(JSON.stringify({ removed: id }));
} else throw new Error('用法：start | many/resolve/remove <start返回的runId>');
if (run) console.log(JSON.stringify({ id, status: run.status, revision: run.resultsRevision, decisions: new Set(run.results.filter(item => item.attention === 'decision').map(item => item.candidateId)).size }));
