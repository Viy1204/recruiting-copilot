import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEDGER_COLUMNS, ROLE_ID_PATTERN, readRoles, selectRoles } from '../skills/recruit-board/model.mjs';
import {
  buildRoleContext,
  extractGlobalContext,
  sliceInternalDoc
} from '../skills/recruit-board/scripts/role-context.mjs';
import {
  generateRoleId,
  migrateWorkspace,
  validateWorkspace
} from '../skills/recruit-board/scripts/workspace.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roleContextScript = path.join(repoRoot, 'skills/recruit-board/scripts/role-context.mjs');
const workspaceScript = path.join(repoRoot, 'skills/recruit-board/scripts/workspace.mjs');

async function makeTempWorkspace(prefix = 'rc-ws-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeRoundsTable(rounds, { ascending = true } = {}) {
  const ordered = ascending ? rounds : [...rounds].reverse();
  const lines = [
    '# UE5 TA — JD 对内笔记',
    '',
    '## 硬约束',
    '- 必须卡：图形学基础与 Shader 调试能力',
    '',
    '## 关键词迭代表',
    '',
    '> 每轮寻源后回填。',
    '',
    '| 轮次 | 日期 | 有效词 | 无效词 | 积极信号 | 拒绝模式 |',
    '|---|---|---|---|---|---|',
    ...ordered.map(n => `| R${n} | 2026-10-${String(n).padStart(2, '0')} | 词${n} | 噪${n} | 信号${n} | 拒绝${n} |`),
    '',
    '## 排除信号',
    '- 纯外包贴图'
  ];
  return `${lines.join('\n')}\n`;
}

test('extractGlobalContext 仅保留通用规则章节，剔除岗位表与历史决策流水', () => {
  const fatContext = [
    '# CONTEXT.md —— 工作区唯一事实源',
    '',
    '> 全局提示',
    '',
    '## 一、公司与业务背景',
    '做 3D 动作游戏。',
    '',
    '### 产品与商业化',
    '核心项目已过立项。',
    '',
    '## 二、团队现状与招聘底层方法论',
    '- 深度 > 广度',
    '',
    '## 三、初筛硬规则',
    '- 绝不自动点不合适',
    '',
    '## 四、在招岗位与优先级',
    '| 岗位 | 优先级 | 状态 | 对外 JD | 对内笔记 |',
    '|---|---|---|---|---|',
    '| UE5 TA | P0 | 在招 | `01-jd/ue5-ta.md` | `01-jd/_internal/ue5-ta.md` |',
    '| 合成动画师 | P2 | 已关闭 | `01-jd/anim.md` | `01-jd/_internal/anim.md` |',
    '',
    '## 五、术语表',
    '| 术语 | 含义 |',
    '|---|---|',
    '| TA | 技术美术 |',
    '',
    '## 六、已对齐决策',
    '- 2026-10-01 合成动画师关闭',
    '',
    '## 七、待定决策清单',
    '- 待老板确认薪资带宽',
    '',
    '## 八、工作方式约定',
    '- 本地台账为唯一事实源',
    '',
    '## 九、面捕与寻源工作流记录',
    '- 2026-10-05 产出 10 份简历'
  ].join('\n');

  const extracted = extractGlobalContext(fatContext);
  assert.match(extracted, /一、公司与业务背景/);
  assert.match(extracted, /产品与商业化/);
  assert.match(extracted, /二、团队现状与招聘底层方法论/);
  assert.match(extracted, /三、初筛硬规则/);
  assert.match(extracted, /五、术语表/);
  assert.match(extracted, /八、工作方式约定/);

  assert.doesNotMatch(extracted, /在招岗位与优先级/);
  assert.doesNotMatch(extracted, /合成动画师/);
  assert.doesNotMatch(extracted, /已对齐决策/);
  assert.doesNotMatch(extracted, /待定决策清单/);
  assert.doesNotMatch(extracted, /面捕/);
  assert.doesNotMatch(extracted, /产出 10 份简历/);
});

test('sliceInternalDoc 对 R1..R10 升序与 R10..R1 降序均只保留最近 2 轮并附省略提示', () => {
  const nums = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const asc = sliceInternalDoc(makeRoundsTable(nums, { ascending: true }), { maxRounds: 2 });
  assert.equal(asc.totalRounds, 10);
  assert.equal(asc.omittedRounds, 8);
  assert.match(asc.text, /> 已自动省略 8 轮历史关键词记录（仅保留最近 2 轮）。/);
  assert.match(asc.text, /\| R9 \|/);
  assert.match(asc.text, /\| R10 \|/);
  assert.doesNotMatch(asc.text, /\| R1 \|/);
  assert.doesNotMatch(asc.text, /\| R8 \|/);
  assert.match(asc.text, /## 排除信号/);

  const desc = sliceInternalDoc(makeRoundsTable(nums, { ascending: false }), { maxRounds: 2 });
  assert.equal(desc.totalRounds, 10);
  assert.equal(desc.omittedRounds, 8);
  assert.match(desc.text, /\| R10 \|/);
  assert.match(desc.text, /\| R9 \|/);
  assert.doesNotMatch(desc.text, /\| R8 \|/);
  assert.doesNotMatch(desc.text, /\| R1 \|/);

  const shortDoc = sliceInternalDoc(makeRoundsTable([1, 2], { ascending: true }), { maxRounds: 2 });
  assert.equal(shortDoc.totalRounds, 2);
  assert.equal(shortDoc.omittedRounds, 0);
  assert.doesNotMatch(shortDoc.text, /已自动省略/);
});

test('buildRoleContext 支持 role_id / 岗位名 / 别名解析、缺失对内档案降级、寻源日志探测与路径穿越拦截', async t => {
  const ws = await makeTempWorkspace('rc-ctx-');
  t.after(() => rm(ws, { recursive: true, force: true }));

  await mkdir(path.join(ws, '01-jd/_internal/logs'), { recursive: true });
  await mkdir(path.join(ws, '_shared'), { recursive: true });

  const contextMd = [
    '# CONTEXT.md',
    '',
    '## 一、公司与业务背景',
    '专注主机动作游戏研发。',
    '',
    '## 三、初筛硬规则',
    '- 必须看作品集。',
    '',
    '## 四、在招岗位与优先级',
    '| role_id | 岗位 | 优先级 | 状态 | 对外 JD | 对内档案 | 最近变更 |',
    '|---|---|---|---|---|---|---|',
    '| UE5-TA | UE5 技术美术 | P0 | 在招 | `01-jd/ue5-ta.md` | `01-jd/_internal/ue5-ta.md` | 2026-11-01 开放 |',
    '| ANIM-01 | 动作设计师 | P1 | 在招 | `01-jd/anim.md` | `01-jd/_internal/missing-anim.md` | — |',
    '| BAD-PATH | 越界测试岗 | P2 | 暂停 | `01-jd/bad.md` | `../../secret.md` | — |',
    '',
    '## 六、已对齐决策',
    '- 2026-10-15 动作设计师暂缓加薪'
  ].join('\n');

  await writeFile(path.join(ws, 'CONTEXT.md'), contextMd, 'utf8');
  await writeFile(
    path.join(ws, '_shared/recruit-board.config.json'),
    JSON.stringify({ schemaVersion: 1, statusStages: {}, roleAliases: { 旧TA岗: 'UE5 技术美术' } }),
    'utf8'
  );
  await writeFile(
    path.join(ws, '01-jd/_internal/ue5-ta.md'),
    makeRoundsTable([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { ascending: true }),
    'utf8'
  );
  await writeFile(path.join(ws, '01-jd/_internal/logs/ue5-ta-sourcing-log.md'), '# sourcing log\n', 'utf8');

  const byId = await buildRoleContext({ workspace: ws, role: 'UE5-TA', maxRounds: 2 });
  assert.equal(byId.role.name, 'UE5 技术美术');
  assert.equal(byId.role.roleId, 'UE5-TA');
  assert.equal(byId.internal.status, 'ok');
  assert.equal(byId.internal.omittedRounds, 8);
  assert.equal(byId.stats.omittedRounds, 8);
  assert.deepEqual(byId.sourcingLog, { path: '01-jd/_internal/logs/ue5-ta-sourcing-log.md', exists: true });
  assert.match(byId.markdown, /专注主机动作游戏研发/);
  assert.doesNotMatch(byId.markdown, /动作设计师暂缓加薪/);

  const byName = await buildRoleContext({ workspace: ws, role: 'UE5 技术美术' });
  assert.equal(byName.role.roleId, 'UE5-TA');

  const byAlias = await buildRoleContext({ workspace: ws, role: '旧TA岗' });
  assert.equal(byAlias.role.name, 'UE5 技术美术');

  const missingInternal = await buildRoleContext({ workspace: ws, role: 'ANIM-01' });
  assert.equal(missingInternal.internal.status, 'missing');
  assert.equal(missingInternal.sourcingLog.exists, false);

  await assert.rejects(
    () => buildRoleContext({ workspace: ws, role: 'NO-SUCH-ROLE' }),
    err => err.code === 'ROLE_CONTEXT_NOT_FOUND' && err.status === 404
  );

  await assert.rejects(
    () => buildRoleContext({ workspace: ws, role: 'BAD-PATH' }),
    err => err.code === 'UNSAFE_WORKSPACE_PATH'
  );
});

test('validateWorkspace 校验规范工作区、悬空指针、体积告警、历史状态与看板一致性', async t => {
  const ws = await makeTempWorkspace('rc-val-');
  t.after(() => rm(ws, { recursive: true, force: true }));

  await mkdir(path.join(ws, '01-jd/_internal'), { recursive: true });
  await mkdir(path.join(ws, '01-jd/legacy-dir'), { recursive: true });
  await mkdir(path.join(ws, '02-sourcing'), { recursive: true });
  await mkdir(path.join(ws, 'docs'), { recursive: true });

  await writeFile(path.join(ws, '01-jd/ue5-ta.md'), '# UE5 TA JD\n', 'utf8');
  await writeFile(path.join(ws, '01-jd/_internal/ue5-ta.md'), '# UE5 TA Internal\n', 'utf8');
  await writeFile(path.join(ws, 'docs/CHANGELOG.md'), '# Changelog\n', 'utf8');
  await writeFile(
    path.join(ws, '02-sourcing/dedup-ledger.csv'),
    `${LEDGER_COLUMNS.join(',')}\n1,张三,UE5 技术美术,背景,A,已回复,R1,,\n`,
    'utf8'
  );

  const cleanContext = [
    '# CONTEXT.md',
    '',
    '## 四、在招岗位与优先级',
    '| role_id | 岗位 | 优先级 | 状态 | 对外 JD | 对内档案 | 最近变更 |',
    '|---|---|---|---|---|---|---|',
    '| UE5-TA | UE5 技术美术 | P0 | 在招 | `01-jd/ue5-ta.md` | `01-jd/_internal/ue5-ta.md` | — |',
    '| LEGACY-01 | 老岗位 | P3 | 历史复合岗 | `01-jd/legacy-dir/` | — | — |'
  ].join('\n');
  await writeFile(path.join(ws, 'CONTEXT.md'), cleanContext, 'utf8');

  const clean = await validateWorkspace(ws);
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.errors, []);
  assert.ok(clean.warnings.some(w => w.code === 'UNKNOWN_ROLE_STATUS'));
  assert.equal(clean.stats.totalRoles, 2);
  assert.equal(clean.stats.activeRoles, 1);
  assert.equal(clean.stats.activeCandidates, 1);
  assert.equal(
    clean.stats.activeRoles,
    selectRoles({ roles: readRoles(cleanContext), candidates: [] }, { scope: 'active' }).roles.length
  );

  await rm(path.join(ws, '01-jd/_internal/ue5-ta.md'));
  const broken = await validateWorkspace(ws, { maxContextBytes: 50, maxInternalBytes: 5 });
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.some(e => e.code === 'DANGLING_POINTER'));
  assert.ok(broken.warnings.some(w => w.code === 'CONTEXT_OVERSIZED'));

  await writeFile(path.join(ws, '01-jd/_internal/ue5-ta.md'), 'A'.repeat(250), 'utf8');
  const oversized = await validateWorkspace(ws, { maxContextBytes: 100, maxInternalBytes: 100 });
  assert.equal(oversized.ok, true);
  assert.ok(oversized.warnings.some(w => w.code === 'CONTEXT_OVERSIZED'));
  assert.ok(oversized.warnings.some(w => w.code === 'INTERNAL_OVERSIZED'));
});

test('migrateWorkspace 支持 dry-run、保留 BOM/CRLF 与非表格正文、幂等升级及预提交校验', async t => {
  const ws = await makeTempWorkspace('rc-mig-');
  t.after(() => rm(ws, { recursive: true, force: true }));

  const proseBefore = [
    '# CONTEXT.md —— 招聘工作区',
    '',
    '> 顶部说明必须原封不动保留。',
    '',
    '## 一、公司与业务背景',
    '做高品质动作游戏。',
    '',
    '## 四、在招岗位与优先级',
    '',
    '> 表格前注释保持不变。',
    ''
  ].join('\r\n');

  const legacyTable = [
    '| 岗位 | 优先级 | 状态 | 对外 JD | 对内笔记 | 备注列 |',
    '|---|---|---|---|---|---|',
    '| UE5 技术美术 | P0 | 在招（2026-11-09 恢复） | `01-jd/ue5-ta.md` | `01-jd/_internal/ue5-ta.md` | 急招 |',
    '| 合成程序岗 | P1 | 暂停 | `01-jd/prog.md` | `01-jd/_internal/prog.md` | — |',
    '| （待梳理） | | | `01-jd/<role>.md` | `01-jd/_internal/<role>.md` | |'
  ].join('\r\n');

  const proseAfter = [
    '',
    '## 六、已对齐决策',
    '- 2026-10-20 保留原样决策记录。',
    ''
  ].join('\r\n');

  const rawText = proseBefore + legacyTable + proseAfter;
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const initialBytes = Buffer.concat([bom, Buffer.from(rawText, 'utf8')]);
  await writeFile(path.join(ws, 'CONTEXT.md'), initialBytes);

  const dry = await migrateWorkspace(ws, { dryRun: true, now: '2026-11-27T00:00:00.000Z' });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.changed, true);
  assert.equal(dry.contextChanged, true);
  assert.equal(dry.createChangelog, true);
  assert.equal(dry.createLogsDir, true);
  assert.equal(dry.addedRoleIds.length, 2);
  assert.equal(dry.normalizedStatuses.length, 1);
  assert.deepEqual(await readFile(path.join(ws, 'CONTEXT.md')), initialBytes);
  await assert.rejects(() => stat(path.join(ws, 'docs/CHANGELOG.md')));
  await assert.rejects(() => stat(path.join(ws, '01-jd/_internal/logs')));

  const first = await migrateWorkspace(ws, { now: '2026-11-27T00:00:00.000Z' });
  assert.equal(first.dryRun, false);
  assert.equal(first.changed, true);
  assert.equal(first.contextChanged, true);
  assert.ok(first.backup && first.backup.startsWith('runtime/recruit-board/roles/CONTEXT-migrate-'));
  for (const item of first.addedRoleIds) {
    assert.match(item.roleId, ROLE_ID_PATTERN);
  }
  assert.equal(generateRoleId('合成程序岗', new Set()), first.addedRoleIds.find(r => r.role === '合成程序岗').roleId);

  const migratedBytes = await readFile(path.join(ws, 'CONTEXT.md'));
  assert.equal(migratedBytes.subarray(0, 3).equals(bom), true);
  const migratedText = migratedBytes.subarray(3).toString('utf8');
  assert.equal(migratedText.includes('\r\n'), true);
  assert.equal(migratedText.startsWith(proseBefore), true);
  assert.equal(migratedText.endsWith(proseAfter), true);
  assert.match(migratedText, /\| role_id \| 岗位 \| 优先级 \| 状态 \| 对外 JD \| 对内档案 \| 最近变更 \| 备注列 \|/);
  assert.match(migratedText, /\| 在招 \| `01-jd\/ue5-ta\.md` \| `01-jd\/_internal\/ue5-ta\.md` \| 2026-11-09 恢复 \| 急招 \|/);
  assert.match(migratedText, /\| （待梳理） \|/);

  assert.equal((await stat(path.join(ws, 'docs/CHANGELOG.md'))).isFile(), true);
  assert.equal((await stat(path.join(ws, '01-jd/_internal/logs'))).isDirectory(), true);
  const rolesBackupDir = path.join(ws, 'runtime/recruit-board/roles');
  const backupsAfterFirst = (await readdir(rolesBackupDir)).filter(f => f.startsWith('CONTEXT-migrate-'));
  assert.equal(backupsAfterFirst.length, 1);

  const second = await migrateWorkspace(ws, { now: '2026-11-27T00:05:00.000Z' });
  assert.equal(second.changed, false);
  assert.equal(second.contextChanged, false);
  assert.equal(second.backup, null);
  assert.deepEqual(await readFile(path.join(ws, 'CONTEXT.md')), migratedBytes);
  const backupsAfterSecond = (await readdir(rolesBackupDir)).filter(f => f.startsWith('CONTEXT-migrate-'));
  assert.equal(backupsAfterSecond.length, 1);
});

test('CLI 调用 role-context.mjs 与 workspace.mjs（含退出码与路径脱敏错误）', async t => {
  const ws = await makeTempWorkspace('rc-cli-');
  t.after(() => rm(ws, { recursive: true, force: true }));

  await mkdir(path.join(ws, '01-jd/_internal'), { recursive: true });
  await writeFile(path.join(ws, '01-jd/ue5.md'), '# UE5 JD\n', 'utf8');
  await writeFile(path.join(ws, '01-jd/_internal/ue5.md'), makeRoundsTable([1, 2, 3, 4], { ascending: true }), 'utf8');
  await writeFile(
    path.join(ws, 'CONTEXT.md'),
    [
      '# CONTEXT.md',
      '',
      '## 一、公司与业务背景',
      '游戏研发工作室。',
      '',
      '## 四、在招岗位与优先级',
      '| 岗位 | 优先级 | 状态 | 对外 JD | 对内笔记 |',
      '|---|---|---|---|---|',
      '| UE5 工程师 | P0 | 在招 | `01-jd/ue5.md` | `01-jd/_internal/ue5.md` |'
    ].join('\n'),
    'utf8'
  );

  const dryRes = await execFileAsync(process.execPath, [workspaceScript, 'migrate', '--workspace', ws, '--dry-run']);
  const dryJson = JSON.parse(dryRes.stdout);
  assert.equal(dryJson.dryRun, true);
  assert.equal(dryJson.changed, true);

  const migRes = await execFileAsync(process.execPath, [workspaceScript, 'migrate', '--workspace', ws]);
  const migJson = JSON.parse(migRes.stdout);
  assert.equal(migJson.changed, true);
  const ue5Id = migJson.addedRoleIds[0].roleId;

  const valRes = await execFileAsync(process.execPath, [workspaceScript, 'validate', '--workspace', ws]);
  const valJson = JSON.parse(valRes.stdout);
  assert.equal(valJson.ok, true);

  const mdRes = await execFileAsync(process.execPath, [roleContextScript, '--workspace', ws, '--role', ue5Id]);
  assert.match(mdRes.stdout, /游戏研发工作室/);
  assert.match(mdRes.stdout, /已自动省略 2 轮历史关键词记录/);

  const jsonRes = await execFileAsync(process.execPath, [
    roleContextScript, '--workspace', ws, '--role', 'UE5 工程师', '--format', 'json', '--max-rounds', '1'
  ]);
  const parsedRoleCtx = JSON.parse(jsonRes.stdout);
  assert.equal(parsedRoleCtx.role.roleId, ue5Id);
  assert.equal(parsedRoleCtx.stats.omittedRounds, 3);

  await rm(path.join(ws, '01-jd/ue5.md'));
  await assert.rejects(
    () => execFileAsync(process.execPath, [workspaceScript, 'validate', '--workspace', ws]),
    err => {
      assert.equal(err.code, 1);
      const out = JSON.parse(err.stdout);
      assert.equal(out.ok, false);
      assert.ok(out.errors.some(e => e.code === 'DANGLING_POINTER'));
      return true;
    }
  );

  const missingWs = path.join(ws, 'does-not-exist');
  await assert.rejects(
    () => execFileAsync(process.execPath, [workspaceScript, 'validate', '--workspace', missingWs]),
    err => {
      assert.equal(err.code, 1);
      assert.equal(err.stderr.includes(ws), false);
      const parsedErr = JSON.parse(err.stderr);
      assert.ok(parsedErr.error?.code);
      return true;
    }
  );
});

test('validateWorkspace 检出未映射历史台账状态（UNMAPPED_LEDGER_STATUS）与旧版 AGENTS.md（LEGACY_AGENTS_MD）', async t => {
  const ws = await makeTempWorkspace('rc-upgrade-warn-');
  t.after(() => rm(ws, { recursive: true, force: true }));

  await mkdir(path.join(ws, '01-jd/_internal'), { recursive: true });
  await mkdir(path.join(ws, '02-sourcing'), { recursive: true });
  await mkdir(path.join(ws, 'docs'), { recursive: true });
  await writeFile(path.join(ws, '01-jd/ue5-ta.md'), '# JD\n', 'utf8');
  await writeFile(path.join(ws, '01-jd/_internal/ue5-ta.md'), '# Internal\n', 'utf8');
  await writeFile(path.join(ws, 'docs/CHANGELOG.md'), '# Changelog\n', 'utf8');
  await writeFile(
    path.join(ws, 'CONTEXT.md'),
    [
      '# CONTEXT.md',
      '## 四、在招岗位与优先级',
      '| role_id | 岗位 | 优先级 | 状态 | 对外 JD | 对内档案 | 最近变更 |',
      '|---|---|---|---|---|---|---|',
      '| UE5-TA | UE5 技术美术 | P0 | 在招 | `01-jd/ue5-ta.md` | `01-jd/_internal/ue5-ta.md` | — |'
    ].join('\n'),
    'utf8'
  );
  await writeFile(
    path.join(ws, '02-sourcing/dedup-ledger.csv'),
    `${LEDGER_COLUMNS.join(',')}\n1,张三,UE5 技术美术,背景,⭐,已排除-学院硬卡,R1,,\n`,
    'utf8'
  );
  await writeFile(path.join(ws, 'AGENTS.md'), '# AGENTS\n修改后运行 node tools/validate-context.mjs\n', 'utf8');

  const res = await validateWorkspace(ws);
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some(w => w.code === 'UNMAPPED_LEDGER_STATUS' && w.count === 1));
  assert.ok(res.warnings.some(w => w.code === 'LEGACY_AGENTS_MD'));

  await writeFile(
    path.join(ws, 'AGENTS.md'),
    '# AGENTS\n运行 node skills/recruit-board/scripts/workspace.mjs validate --workspace .\n',
    'utf8'
  );
  const resAfter = await validateWorkspace(ws);
  assert.ok(!resAfter.warnings.some(w => w.code === 'LEGACY_AGENTS_MD'));
});

test('validateWorkspace 与 migrateWorkspace 处理岗位表空行断表、非表格打断拒迁、内容体检与代码围栏隔离', async t => {
  const ws = await makeTempWorkspace('rc-hygiene-');
  t.after(() => rm(ws, { recursive: true, force: true }));

  await mkdir(path.join(ws, '01-jd/_internal'), { recursive: true });
  await mkdir(path.join(ws, 'docs'), { recursive: true });
  await writeFile(path.join(ws, '01-jd/a.md'), '# A\n', 'utf8');
  await writeFile(path.join(ws, '01-jd/_internal/a.md'), '# A internal\n', 'utf8');
  await writeFile(path.join(ws, '01-jd/b.md'), '# B\n', 'utf8');
  await writeFile(path.join(ws, '01-jd/_internal/b.md'), '# B internal\n', 'utf8');
  await writeFile(path.join(ws, 'docs/CHANGELOG.md'), '# Changelog\n', 'utf8');
  await writeFile(path.join(ws, 'AGENTS.md'), 'node skills/recruit-board/scripts/workspace.mjs validate --workspace .\n', 'utf8');

  const pollutedContext = [
    '# CONTEXT.md',
    '',
    '## 一、公司与业务背景',
    '正常业务描述。',
    '```markdown',
    '## 假章节（围栏内不触发告警）',
    '冲突时以本节为准；2026-11-20 BOSS 批量打招呼 15 人；AI 一律不执行；CONTEXT.bak-001',
    '```',
    '',
    '## 三、初筛硬规则',
    '- 冲突时以本节为准，覆写下文旧口径。',
    '- 年龄上限 38（AI 不执行，待用户确认后删除）。',
    '- 2026-11-26 BOSS 打招呼 12 人，今日战报已归档至 report.bak-20261126。',
    '',
    '## 四、在招岗位与优先级',
    '| 岗位 | 优先级 | 状态 | 对外 JD | 对内笔记 |',
    '|---|---|---|---|---|',
    '| 岗位A | 最高 | 在招 | `01-jd/a.md` | `01-jd/_internal/a.md` |',
    '',
    '| 岗位B | 急岗 | 在招（2026-11-20 恢复） | `01-jd/b.md` | `01-jd/_internal/b.md` |',
    '',
    '## 六、已对齐决策',
    '- 2026-10-01 决定提高岗位A薪资上限',
    '- 2026-10-12 决定岗位B优先一线大厂'
  ].join('\n');
  await writeFile(path.join(ws, 'CONTEXT.md'), pollutedContext, 'utf8');

  const before = await validateWorkspace(ws, { maxContextLines: 10 });
  assert.equal(before.ok, false);
  assert.equal(before.stats.totalRoles, 2);
  assert.equal(before.stats.activeRoles, 2);
  assert.ok(Array.isArray(before.stats.contextSections) && before.stats.contextSections.length >= 4);
  assert.ok(before.errors.some(e => e.code === 'ROLES_TABLE_TRUNCATED' && e.trailingRows === 1 && e.blankSplitLines.length === 1));
  assert.ok(before.warnings.some(w => w.code === 'OVERRIDE_LAYER_STACK'));
  assert.ok(before.warnings.some(w => w.code === 'EXECUTION_LOG_POLLUTION'));
  assert.ok(before.warnings.some(w => w.code === 'DEPRECATED_RULE_RESIDUE'));
  assert.ok(before.warnings.some(w => w.code === 'LEGACY_ALIGNED_DECISIONS' && w.count === 2));
  assert.ok(before.warnings.some(w => w.code === 'CONTEXT_LINE_BUDGET'));

  const dry = await migrateWorkspace(ws, { dryRun: true, now: '2026-11-27T00:00:00.000Z' });
  assert.equal(dry.changed, true);
  assert.ok(dry.actions.includes('repair_role_table_splits'));
  assert.equal(dry.repairedBlankSplits.length, 1);
  assert.equal(dry.addedRoleIds.length, 2);
  assert.equal(dry.normalizedStatuses.length, 1);

  const migrated = await migrateWorkspace(ws, { now: '2026-11-27T00:00:00.000Z' });
  assert.equal(migrated.changed, true);
  assert.equal(migrated.addedRoleIds.length, 2);
  const migratedSecond = await migrateWorkspace(ws, { now: '2026-11-27T00:05:00.000Z' });
  assert.equal(migratedSecond.changed, false);

  const after = await validateWorkspace(ws);
  assert.equal(after.ok, true);
  assert.equal(after.stats.totalRoles, 2);
  assert.equal(after.stats.activeRoles, 2);
  assert.ok(!after.errors.some(e => e.code === 'ROLES_TABLE_TRUNCATED'));

  const proseInterrupted = [
    '# CONTEXT.md',
    '## 四、在招岗位与优先级',
    '| role_id | 岗位 | 优先级 | 状态 | 对外 JD | 对内档案 | 最近变更 |',
    '|---|---|---|---|---|---|---|',
    '| ROLE-A | 岗位A | 最高 | 在招 | `01-jd/a.md` | `01-jd/_internal/a.md` | — |',
    '> 这里夹了一段正文说明',
    '| ROLE-B | 岗位B | 急岗 | 在招 | `01-jd/b.md` | `01-jd/_internal/b.md` | — |'
  ].join('\n');
  await writeFile(path.join(ws, 'CONTEXT.md'), proseInterrupted, 'utf8');
  const proseVal = await validateWorkspace(ws);
  assert.equal(proseVal.ok, false);
  assert.ok(proseVal.errors.some(e => e.code === 'ROLES_TABLE_TRUNCATED' && e.nonBlankBreakLines.length === 1));
  await assert.rejects(
    () => migrateWorkspace(ws),
    err => err.code === 'ROLES_TABLE_TRUNCATED' && err.status === 422
  );

  const templateText = await readFile(path.join(repoRoot, 'skills/recruit-init/templates/CONTEXT.md'), 'utf8');
  await writeFile(path.join(ws, 'CONTEXT.md'), templateText, 'utf8');
  const tplVal = await validateWorkspace(ws);
  assert.equal(tplVal.ok, true);
  for (const code of ['ROLES_TABLE_TRUNCATED', 'OVERRIDE_LAYER_STACK', 'EXECUTION_LOG_POLLUTION', 'DEPRECATED_RULE_RESIDUE', 'LEGACY_ALIGNED_DECISIONS', 'CONTEXT_LINE_BUDGET']) {
    assert.ok(!tplVal.warnings.some(w => w.code === code) && !tplVal.errors.some(e => e.code === code), `模板不应误报 ${code}`);
  }
});
