import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditContext, planDecisionArchive } from '../skills/recruit-board/context-hygiene-domain.mjs';
import {
  archiveContextDecisions,
  auditContextWorkspace,
  contextHygieneCLI,
  contextHygieneError,
  listDecisionArchives,
  logColdDecision
} from '../skills/recruit-board/scripts/context-hygiene.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const healthyContext = [
  '# CONTEXT.md —— 虚构招聘工作区',
  '',
  '## 一、公司与业务背景',
  '虚构研发团队，主攻模拟测试设备。',
  '',
  '## 三、初筛硬规则',
  '- 学历：本科及以上。',
  '',
  '## 四、在招岗位与优先级',
  '| 岗位 | 优先级 | 状态 | 对外 JD | 对内笔记 |',
  '|---|---|---|---|---|',
  '| 星图程序岗 | P0 | 在招 | `01-jd/星图程序岗.md` | `01-jd/_internal/星图程序岗.md` |',
  '| 云帆测试岗 | P1 | 暂停 | `01-jd/云帆测试岗.md` | `01-jd/_internal/云帆测试岗.md` |',
  '',
  '## 六、已对齐决策',
  '- 2026-11-20 星图程序岗年龄上限调整为 35 岁。',
  '- 2026-11-25 云帆测试岗暂停主动寻源。',
  ''
].join('\n');

async function createWorkspace(t, contextText = healthyContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruit-context-hygiene-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (contextText !== null) await writeFile(path.join(root, 'CONTEXT.md'), contextText);
  return root;
}

test('精简健康的 CONTEXT.md 通过 audit 且无告警', () => {
  const report = auditContext(healthyContext);
  assert.equal(report.status, 'ok');
  assert.equal(report.healthy, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.metrics.decisionCount, 2);
  assert.equal(report.metrics.rolesTable.found, true);
  assert.equal(report.metrics.rolesTable.truncated, false);
  assert.equal(report.metrics.rolesTable.parsedRows, 2);
});

test('audit 精准检出岗位表空行截断、预算超标、多层覆写、战报污染与失效条款残留', () => {
  const polluted = [
    '# CONTEXT.md',
    '',
    '## 〇、当前生效口径',
    '> 本节与下文任何段落冲突 → 以本节为准。',
    '- 临时补丁备份见 chat.js.bak-fullshot-20261126',
    '',
    '## 三、初筛硬规则',
    '| 年龄 | 35 岁以内；旧条款（AI 不执行，待用户确认后删除） |',
    '',
    '## 四、在招岗位与优先级',
    '| 岗位 | 优先级 | 状态 |',
    '|---|---|---|',
    '| 星图程序岗 | P0 | 在招 |',
    '',
    '| 云帆测试岗 | P1 | 在招 |',
    '| 凌云算法岗 | P1 | 在招 |',
    '',
    '## 六、已对齐决策',
    '- 2026-11-10 12:00 BOSS 主攻：批量打招呼 **21 人**，批次全部「成功 21/失败 0」。',
    '- 2026-11-11 决策二',
    '- 2026-11-12 决策三',
    '- 2026-11-13 决策四',
    '',
    '## 九、看板确认口径',
    '> 冲突时，以本节最新日期的口径为准。',
    ''
  ].join('\n');

  const report = auditContext(polluted, { maxBytes: 400, maxLines: 15, maxDecisions: 2 });
  assert.equal(report.status, 'error');
  assert.equal(report.healthy, false);
  const codes = new Set(report.findings.map(item => item.code));
  assert.ok(codes.has('ROLES_TABLE_TRUNCATED'));
  assert.ok(codes.has('CONTEXT_SIZE_BUDGET'));
  assert.ok(codes.has('CONTEXT_LINE_BUDGET'));
  assert.ok(codes.has('DECISIONS_UNARCHIVED'));
  assert.ok(codes.has('OVERRIDE_LAYER_STACK'));
  assert.ok(codes.has('EXECUTION_LOG_POLLUTION'));
  assert.ok(codes.has('DEPRECATED_RULE_RESIDUE'));

  const tableFinding = report.findings.find(item => item.code === 'ROLES_TABLE_TRUNCATED');
  assert.equal(tableFinding.level, 'error');
  assert.equal(tableFinding.parsedRows, 1);
  assert.equal(tableFinding.trailingRows, 2);
});

test('archive-decisions 按月归档旧决策到冷日志，保留最近条目、CRLF 换行与原文备份，且拒绝过期 revision', async t => {
  const crlfContext = [
    '# CONTEXT.md',
    '',
    '## 四、在招岗位与优先级',
    '| 岗位 | 优先级 | 状态 |',
    '|---|---|---|',
    '| 星图程序岗 | P0 | 在招 |',
    '',
    '## 六、已对齐决策',
    '',
    '> 仅保留近期摘要。',
    '',
    '- 2026-10-18 旧决策甲（十月）',
    '  补充背景行一',
    '- 2026-11-02 旧决策乙（十一月初）',
    '- 2026-11-12 旧决策丙（十一月中）',
    '- 2026-11-25 新决策丁（保留）',
    '',
    '## 七、待定决策清单',
    '- （无）',
    ''
  ].join('\r\n');

  const root = await createWorkspace(t, crlfContext);
  const beforeBytes = await readFile(path.join(root, 'CONTEXT.md'));
  const audited = await auditContextWorkspace(root);
  assert.equal(audited.revision, digest(beforeBytes));
  assert.equal(audited.metrics.decisionCount, 4);

  const archived = await archiveContextDecisions({
    workspace: root,
    expectedRevision: audited.revision,
    keepRecent: 1
  });
  assert.equal(archived.changed, true);
  assert.equal(archived.archivedCount, 3);
  assert.equal(archived.keptCount, 1);
  assert.deepEqual(archived.archiveFiles, ['runtime/decisions-log/2026-10.md', 'runtime/decisions-log/2026-11.md']);
  assert.deepEqual(await readFile(path.join(root, archived.backup)), beforeBytes);

  const updatedText = await readFile(path.join(root, 'CONTEXT.md'), 'utf8');
  assert.ok(updatedText.includes('\r\n'));
  assert.ok(updatedText.includes('runtime/decisions-log/'));
  assert.ok(updatedText.includes('2026-11-25 新决策丁（保留）'));
  assert.ok(!updatedText.includes('2026-10-18 旧决策甲'));
  assert.ok(updatedText.includes('## 七、待定决策清单'));

  const octLog = await readFile(path.join(root, 'runtime/decisions-log/2026-10.md'), 'utf8');
  assert.ok(octLog.includes('旧决策甲（十月）'));
  assert.ok(octLog.includes('补充背景行一'));
  const novLog = await readFile(path.join(root, 'runtime/decisions-log/2026-11.md'), 'utf8');
  assert.ok(novLog.includes('旧决策乙（十一月初）'));
  assert.ok(novLog.includes('旧决策丙（十一月中）'));

  // 过期 revision 被 409 拒绝
  await assert.rejects(
    archiveContextDecisions({ workspace: root, expectedRevision: audited.revision, keepRecent: 0 }),
    error => error.code === 'CONTEXT_CONFLICT' && error.status === 409
  );

  // 再次归档 keepRecent=1 为幂等无变更
  const noop = await archiveContextDecisions({ workspace: root, expectedRevision: archived.revision, keepRecent: 1 });
  assert.equal(noop.changed, false);
  assert.equal(noop.backup, null);

  // planDecisionArchive 支持按日期截止归档
  const byDate = planDecisionArchive(crlfContext, { beforeDate: '2026-11-10' });
  assert.equal(byDate.archivedCount, 2);
  assert.equal(byDate.keptCount, 2);
});

test('log-decision 只追加冷审计日志、不改动 CONTEXT.md 且按 ID 幂等重放', async t => {
  const root = await createWorkspace(t);
  const beforeContext = await readFile(path.join(root, 'CONTEXT.md'), 'utf8');

  const first = await logColdDecision({
    workspace: root,
    decision: {
      id: 'D-20261127-01',
      date: '2026-11-27',
      scope: 'role',
      summary: '星图程序岗年龄上限放宽',
      previousValue: '<=32',
      newValue: '<=35',
      reason: '市场盘点样本集中在 33–35 岁',
      authority: '虚构负责人',
      targetFile: '01-jd/_internal/星图程序岗.md'
    }
  });
  assert.equal(first.changed, true);
  assert.equal(first.replayed, false);
  assert.equal(first.path, 'runtime/decisions-log/2026-11.md');
  assert.equal(await readFile(path.join(root, 'CONTEXT.md'), 'utf8'), beforeContext);

  const logText = await readFile(path.join(root, first.path), 'utf8');
  assert.ok(logText.includes('**[D-20261127-01]**'));
  assert.ok(logText.includes('变更：<=32 → <=35'));
  assert.ok(logText.includes('拍板人：虚构负责人'));

  // 同 ID 重放不重复写入
  const replay = await logColdDecision({
    workspace: root,
    decision: {
      id: 'D-20261127-01',
      date: '2026-11-27',
      scope: 'role',
      summary: '星图程序岗年龄上限放宽',
      reason: '市场盘点样本集中在 33–35 岁'
    }
  });
  assert.equal(replay.changed, false);
  assert.equal(replay.replayed, true);
  assert.equal(await readFile(path.join(root, first.path), 'utf8'), logText);

  const listed = await listDecisionArchives(root);
  assert.equal(listed.files.length, 1);
  assert.equal(listed.files[0].entries, 1);
});

test('CLI 命令端到端可用，并拒绝工作区外符号链接与非法参数', async t => {
  const root = await createWorkspace(t);
  const auditOut = await contextHygieneCLI(['audit', '--workspace', root]);
  assert.equal(auditOut.healthy, true);

  const logOut = await contextHygieneCLI([
    'log-decision',
    '--workspace', root,
    '--input', JSON.stringify({ date: '2026-11-27', scope: 'policy', summary: '测试冷日志记录', reason: 'CLI 回归验证' })
  ]);
  assert.equal(logOut.changed, true);

  const listOut = await contextHygieneCLI(['list-archive', '--workspace', root]);
  assert.equal(listOut.files.length, 1);

  await assert.rejects(contextHygieneCLI(['bad-cmd', '--workspace', root]), error => {
    const formatted = contextHygieneError(error);
    assert.equal(formatted.error.code, 'CONTEXT_HYGIENE_INPUT_INVALID');
    return true;
  });

  // 符号链接指向工作区外 CONTEXT.md 必须拦截
  const outside = await mkdtemp(path.join(tmpdir(), 'recruit-outside-ctx-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'CONTEXT.md'), healthyContext);
  await rm(path.join(root, 'CONTEXT.md'));
  await symlink(path.join(outside, 'CONTEXT.md'), path.join(root, 'CONTEXT.md'));
  await assert.rejects(auditContextWorkspace(root), error => error.code === 'CONTEXT_UNSAFE' && error.status === 403);
});
