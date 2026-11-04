import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LEDGER_COLUMNS } from '../skills/recruit-board/model.mjs';
import { readCandidateDetail } from '../skills/recruit-board/scripts/records.mjs';

test('台账明确引用的历史在线简历文本保留简历类别，评估档案不能替代原件', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'material-category-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of ['02-sourcing', 'runtime/artifacts/resumes']) await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(path.join(root, 'CONTEXT.md'), '## 在招岗位与优先级\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| 合成岗位 | P0 | 在招 |\n');
  for (const extension of ['txt', 'md']) {
    const relative = `runtime/artifacts/resumes/example.${extension}`;
    await writeFile(path.join(root, relative), '合成资料正文');
    await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), `${LEDGER_COLUMNS.join(',')}\n1,合成甲,合成岗位,,A,面试中,合成来源,${relative},\n`);
    const detail = await readCandidateDetail(root, JSON.stringify(['合成甲', '合成岗位']));
    assert.equal(detail.documents[0].category, extension === 'txt' ? 'resume' : 'other');
    assert.equal(detail.warnings.some(value => /原始简历未获取/.test(value)), extension === 'md');
  }
});
