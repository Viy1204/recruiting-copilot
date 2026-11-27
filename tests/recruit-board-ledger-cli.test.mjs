import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { linkDir } from './helpers/symlink.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_LEDGER_STATUSES, LEDGER_COLUMNS, parseCSV } from '../skills/recruit-board/model.mjs';
import {
  ledgerCLI,
  listStatuses,
  lookupCandidates,
  serializeCSV,
  upsertCandidate
} from '../skills/recruit-board/scripts/ledger.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../skills/recruit-board/scripts/ledger.mjs', import.meta.url));

const contextDoc = [
  '# 合成工作区',
  '',
  '## 在招岗位与优先级',
  '| role_id | 岗位 | 优先级 | 状态 |',
  '|---|---|---|---|',
  '| UE-TA | 技术美术TA（UE5） | P0 | 在招 |',
  '| CLIENT-DEV | 客户端程序 | P1 | 在招 |',
  '| ART-LEAD | 主美 | P2 | 暂停 |',
  ''
].join('\n');

const defaultConfig = {
  schemaVersion: 1,
  statusStages: {
    '已放弃-offer后未入职': 'ended',
    '已沟通-待答复': 'talking'
  },
  roleAliases: {
    '旧岗位名': '技术美术TA（UE5）',
    '旧客户端岗': '客户端程序'
  }
};

async function createWorkspace(t, { csvBytes = null, config = defaultConfig, context = contextDoc } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruit-ledger-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '02-sourcing'), { recursive: true });
  await writeFile(path.join(root, 'CONTEXT.md'), context, 'utf8');
  if (config !== null) {
    await mkdir(path.join(root, '_shared'), { recursive: true });
    await writeFile(path.join(root, '_shared/recruit-board.config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
  }
  const initial = csvBytes ?? Buffer.from(serializeCSV(LEDGER_COLUMNS, [], { bom: true, eol: '\r\n' }), 'utf8');
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), initial);
  return root;
}

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf8',
      windowsHide: true
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? ''
    };
  }
}

test('statuses 返回全部标准状态且无 unclassified 阶段，并合并本地终端映射判断', async t => {
  const root = await createWorkspace(t);
  const result = await listStatuses(root);
  assert.equal(result.statuses.length, CANONICAL_LEDGER_STATUSES.length);
  assert.deepEqual(
    result.statuses.map(item => item.status),
    [...CANONICAL_LEDGER_STATUSES]
  );
  assert.ok(result.statuses.every(item => item.stage !== 'unclassified'));
  assert.equal(result.statuses.find(item => item.status === '已排除').terminal, true);
  assert.equal(result.statuses.find(item => item.status === '已入职').terminal, true);
  assert.equal(result.statuses.find(item => item.status === '已回复').terminal, false);
});

test('upsert 通过 role_id 新增候选人，写入标准岗位名、递增序号、保留 BOM/CRLF、正确转义并创建备份', async t => {
  const existing = serializeCSV(
    LEDGER_COLUMNS,
    [['3', '合成甲', '客户端程序', '5年UE', 'A', '已回复', '20261101boss', '', '初始备注']],
    { bom: true, eol: '\r\n' }
  );
  const root = await createWorkspace(t, { csvBytes: Buffer.from(existing, 'utf8') });

  const res = await upsertCandidate({
    workspace: root,
    role: 'UE-TA',
    name: '合成,乙"测试',
    status: '初筛通过',
    bg: '6年TA，擅长Shader,HLSL',
    rating: '⭐⭐⭐',
    round: '20261127boss推荐',
    note: '核心信号："渲染管线"\n待约面'
  });

  assert.equal(res.ok, true);
  assert.equal(res.action, 'insert');
  assert.equal(res.seq, '4');
  assert.equal(res.roleId, 'UE-TA');
  assert.equal(res.canonicalRole, '技术美术TA（UE5）');
  assert.equal(res.rawRole, '技术美术TA（UE5）');
  assert.equal(res.candidateId, JSON.stringify(['合成,乙"测试', '技术美术TA（UE5）']));
  assert.equal(res.totalRows, 2);
  assert.ok(res.backup && res.backup.startsWith('runtime/recruit-board/backups/dedup-ledger-'));

  const backupBytes = await readFile(path.join(root, res.backup));
  assert.deepEqual(backupBytes, Buffer.from(existing, 'utf8'));

  const savedBytes = await readFile(path.join(root, '02-sourcing/dedup-ledger.csv'));
  assert.deepEqual(savedBytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  const savedText = savedBytes.toString('utf8');
  assert.ok(savedText.startsWith('\uFEFF序号,姓名,应聘岗位,现职/背景,评级,状态,来源轮次,简历路径,备注\r\n'));

  const parsed = parseCSV(savedText);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[1], [
    '4',
    '合成,乙"测试',
    '技术美术TA（UE5）',
    '6年TA，擅长Shader,HLSL',
    '⭐⭐⭐',
    '初筛通过',
    '20261127boss推荐',
    '',
    '核心信号："渲染管线"\n待约面'
  ]);
});

test('upsert 保留原始无 BOM 与 LF 行尾格式', async t => {
  const existing = serializeCSV(
    LEDGER_COLUMNS,
    [['1', '合成甲', '客户端程序', '3年', 'A', '待初筛', 'test', '', '']],
    { bom: false, eol: '\n' }
  );
  const root = await createWorkspace(t, { csvBytes: Buffer.from(existing, 'utf8') });

  await upsertCandidate({
    workspace: root,
    role: 'UE-TA',
    name: '合成乙',
    status: '已打招呼',
    bg: '4年TA'
  });

  const bytes = await readFile(path.join(root, '02-sourcing/dedup-ledger.csv'));
  assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  const text = bytes.toString('utf8');
  assert.equal(text.includes('\r\n'), false);
  assert.equal(parseCSV(text).length, 2);
});

test('upsert 拒绝自由文本状态（如 已排除-学历不符）且不修改 CSV 或产生备份', async t => {
  const existing = serializeCSV(
    LEDGER_COLUMNS,
    [['1', '合成甲', '技术美术TA（UE5）', '3年', 'A', '已回复', 'test', '', '原备注']],
    { bom: true, eol: '\r\n' }
  );
  const root = await createWorkspace(t, { csvBytes: Buffer.from(existing, 'utf8') });

  await assert.rejects(
    upsertCandidate({
      workspace: root,
      role: 'UE-TA',
      name: '合成甲',
      status: '已排除-学历不符'
    }),
    error => error.code === 'LEDGER_STATUS_INVALID' && error.status === 400
  );

  assert.equal(await readFile(path.join(root, '02-sourcing/dedup-ledger.csv'), 'utf8'), existing);
  assert.equal((await readdir(root)).includes('runtime'), false);
});

test('跨别名去重：命中旧岗位名行时保留原 rawRole 维持 candidateId，非终态合并备注，终态阻断除非 forceUpdate', async t => {
  const existing = serializeCSV(
    LEDGER_COLUMNS,
    [
      ['1', '合成甲', '旧岗位名', '5年UE', 'A', '已回复', '20261001boss', 'resumes/a.pdf', '初面不错'],
      ['2', '合成乙', '旧岗位名', '4年UE', 'B', '已排除', '20261001boss', '', '年龄不符'],
      ['3', '合成丙', '旧岗位名', '6年UE', 'A', '已放弃-offer后未入职', '20261001boss', '', '薪资未谈拢']
    ],
    { bom: true, eol: '\r\n' }
  );
  const root = await createWorkspace(t, { csvBytes: Buffer.from(existing, 'utf8') });

  const updated = await upsertCandidate({
    workspace: root,
    role: 'UE-TA',
    name: '合成甲',
    status: '已约谈',
    note: '约下周二二面'
  });

  assert.equal(updated.action, 'update');
  assert.equal(updated.rawRole, '旧岗位名');
  assert.equal(updated.canonicalRole, '技术美术TA（UE5）');
  assert.equal(updated.candidateId, JSON.stringify(['合成甲', '旧岗位名']));
  assert.equal(updated.row.bg, '5年UE');
  assert.equal(updated.row.rating, 'A');
  assert.equal(updated.row.resume, 'resumes/a.pdf');
  assert.equal(updated.row.note, '初面不错；约下周二二面');

  await assert.rejects(
    upsertCandidate({
      workspace: root,
      role: 'UE-TA',
      name: '合成乙',
      status: '待初筛',
      note: '误捞'
    }),
    error => error.code === 'LEDGER_TERMINAL_BLOCKED' && error.status === 409 && error.exitCode === 3
  );

  await assert.rejects(
    upsertCandidate({
      workspace: root,
      role: 'UE-TA',
      name: '合成丙',
      status: '已约谈'
    }),
    error => error.code === 'LEDGER_TERMINAL_BLOCKED' && error.status === 409 && error.exitCode === 3
  );

  const forced = await upsertCandidate({
    workspace: root,
    role: 'UE-TA',
    name: '合成丙',
    status: '已回复',
    note: '候选人重新联系',
    replaceNote: true,
    forceUpdate: true
  });
  assert.equal(forced.action, 'update');
  assert.equal(forced.rawRole, '旧岗位名');
  assert.equal(forced.status, '已回复');
  assert.equal(forced.row.note, '候选人重新联系');
});

test('dry-run 返回完整预览但不写盘、不建锁、不产生备份', async t => {
  const existing = serializeCSV(
    LEDGER_COLUMNS,
    [['1', '合成甲', '客户端程序', '5年', 'A', '已约谈', '20261001', '', '']],
    { bom: true, eol: '\r\n' }
  );
  const root = await createWorkspace(t, { csvBytes: Buffer.from(existing, 'utf8') });

  const preview = await upsertCandidate({
    workspace: root,
    role: 'UE-TA',
    name: '合成甲',
    status: '待初筛',
    bg: '5年TA/客户端',
    dryRun: true
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.action, 'insert');
  assert.equal(preview.seq, '2');
  assert.equal(preview.backup, null);
  assert.equal(preview.otherRoleMatches.length, 1);
  assert.equal(preview.otherRoleMatches[0].canonicalRole, '客户端程序');

  assert.equal(await readFile(path.join(root, '02-sourcing/dedup-ledger.csv'), 'utf8'), existing);
  assert.equal((await readdir(root)).includes('runtime'), false);
});

test('lookup 支持跨别名、NFKC/大小写模糊查人以及跨岗历史返回', async t => {
  const existing = serializeCSV(
    LEDGER_COLUMNS,
    [
      ['1', 'Alice  Wang', '旧岗位名', '5年TA', 'A', '已约谈', '20261001', '', ''],
      ['2', 'ＡＬＩＣＥ　Ｚｈａｎｇ', '技术美术TA（UE5）', '4年TA', 'B', '待初筛', '20261002', '', ''],
      ['3', 'Alice  Wang', '客户端程序', '5年客户端', 'A', '已排除', '20260901', '', '跨岗已淘汰']
    ],
    { bom: true, eol: '\r\n' }
  );
  const root = await createWorkspace(t, { csvBytes: Buffer.from(existing, 'utf8') });

  const byRoleAndName = await lookupCandidates({ workspace: root, role: 'UE-TA', name: ' ａｌｉｃｅ ' });
  assert.equal(byRoleAndName.count, 2);
  assert.equal(byRoleAndName.hasTerminalOrContacted, true);
  assert.deepEqual(
    byRoleAndName.matches.map(m => [m.name, m.rawRole, m.canonicalRole, m.roleId]),
    [
      ['Alice  Wang', '旧岗位名', '技术美术TA（UE5）', 'UE-TA'],
      ['ＡＬＩＣＥ　Ｚｈａｎｇ', '技术美术TA（UE5）', '技术美术TA（UE5）', 'UE-TA']
    ]
  );

  const byNameOnly = await lookupCandidates({ workspace: root, name: 'alice wang' });
  assert.equal(byNameOnly.count, 2);
  assert.equal(byNameOnly.hasTerminalOrContacted, true);

  const upsertPreview = await upsertCandidate({
    workspace: root,
    role: 'UE-TA',
    name: 'Alice  Wang',
    status: '面试中',
    dryRun: true
  });
  assert.equal(upsertPreview.action, 'update');
  assert.equal(upsertPreview.otherRoleMatches.length, 1);
  assert.equal(upsertPreview.otherRoleMatches[0].canonicalRole, '客户端程序');
  assert.equal(upsertPreview.otherRoleMatches[0].terminal, true);
});

test('CLI 进程调用覆盖退出码 0 / 1 / 2 / 3，且 stderr 绝不泄漏工作区绝对路径', async t => {
  const existing = serializeCSV(
    LEDGER_COLUMNS,
    [
      ['1', '合成重复', '旧岗位名', '5年', 'A', '已回复', 'r1', '', ''],
      ['2', '合成重复', '技术美术TA（UE5）', '5年', 'A', '待初筛', 'r2', '', ''],
      ['3', '合成终态', '旧岗位名', '5年', 'A', '已排除', 'r3', '', '硬条件不符']
    ],
    { bom: true, eol: '\r\n' }
  );
  const root = await createWorkspace(t, { csvBytes: Buffer.from(existing, 'utf8') });

  const okStatuses = await runCli(['statuses', '--workspace', root]);
  assert.equal(okStatuses.exitCode, 0);
  assert.equal(JSON.parse(okStatuses.stdout).statuses.length, CANONICAL_LEDGER_STATUSES.length);

  const okInsert = await runCli([
    'upsert', '--workspace', root, '--role-id', 'CLIENT-DEV',
    '--name', '合成新客', '--status', '待初筛', '--bg', '4年C++', '--dry-run'
  ]);
  assert.equal(okInsert.exitCode, 0);
  assert.equal(JSON.parse(okInsert.stdout).canonicalRole, '客户端程序');

  const badRole = await runCli([
    'upsert', '--workspace', root, '--role', 'NO-SUCH-ROLE',
    '--name', '合成新客', '--status', '待初筛', '--bg', '4年'
  ]);
  assert.equal(badRole.exitCode, 1);
  const badRoleErr = JSON.parse(badRole.stderr);
  assert.equal(badRoleErr.error.code, 'LEDGER_ROLE_UNKNOWN');
  assert.equal(badRole.stderr.includes(root), false);

  const missingWs = await runCli(['statuses', '--workspace', path.join(root, 'does-not-exist')]);
  assert.equal(missingWs.exitCode, 1);
  assert.equal(missingWs.stderr.includes(root), false);

  const dupErr = await runCli([
    'upsert', '--workspace', root, '--role-id', 'UE-TA',
    '--name', '合成重复', '--status', '已约谈'
  ]);
  assert.equal(dupErr.exitCode, 2);
  assert.equal(JSON.parse(dupErr.stderr).error.code, 'LEDGER_DUPLICATE_EXISTS');
  assert.equal(dupErr.stderr.includes(root), false);

  const termErr = await runCli([
    'upsert', '--workspace', root, '--role-id', 'UE-TA',
    '--name', '合成终态', '--status', '已约谈'
  ]);
  assert.equal(termErr.exitCode, 3);
  assert.equal(JSON.parse(termErr.stderr).error.code, 'LEDGER_TERMINAL_BLOCKED');
  assert.equal(termErr.stderr.includes(root), false);
});

test('存在写入锁时返回 LEDGER_LOCKED (409) 且不破坏台账', async t => {
  const root = await createWorkspace(t);
  const rolesDir = path.join(root, 'runtime/recruit-board/roles');
  await mkdir(rolesDir, { recursive: true });
  const lockHandle = await open(path.join(rolesDir, 'ledger.lock'), 'wx');
  await lockHandle.close();

  await assert.rejects(
    ledgerCLI(['upsert', '--workspace', root, '--role', 'UE-TA', '--name', '合成甲', '--status', '待初筛', '--bg', '3年']),
    error => error.code === 'LEDGER_LOCKED' && error.status === 409
  );
});

test('符号链接跨工作区保护：拒绝 symlink/junction 读写', async t => {
  const outside = await mkdtemp(path.join(tmpdir(), 'recruit-ledger-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'dedup-ledger.csv'), serializeCSV(LEDGER_COLUMNS, []), 'utf8');
  await writeFile(path.join(outside, 'CONTEXT.md'), contextDoc, 'utf8');

  const root = await createWorkspace(t);
  await rm(path.join(root, '02-sourcing'), { recursive: true });
  await linkDir(outside, path.join(root, '02-sourcing'));

  await assert.rejects(
    lookupCandidates({ workspace: root, name: '甲' }),
    error => error.code === 'WORKSPACE_PATH_UNSAFE'
  );
  await assert.rejects(
    upsertCandidate({ workspace: root, role: 'UE-TA', name: '甲', status: '待初筛', bg: '3年' }),
    error => error.code === 'WORKSPACE_PATH_UNSAFE'
  );

  const root2 = await createWorkspace(t);
  await mkdir(path.join(root2, 'runtime/recruit-board'), { recursive: true });
  await linkDir(outside, path.join(root2, 'runtime/recruit-board/backups'));
  await assert.rejects(
    upsertCandidate({ workspace: root2, role: 'UE-TA', name: '甲', status: '待初筛', bg: '3年' }),
    error => error.code === 'WORKSPACE_PATH_UNSAFE'
  );
});

test('未映射的历史自由文本终态（如 已排除-学院硬卡、初筛不合适-异地）仍触发终态兜底拦截', async t => {
  const csvBytes = Buffer.from(
    serializeCSV(LEDGER_COLUMNS, [
      ['1', '合成旧排', '技术美术TA（UE5）', '某厂', '⭐', '已排除-学院硬卡', 'R1', '', '旧记录'],
      ['2', '合成旧拒', '技术美术TA（UE5）', '某厂', '⭐', '初筛不合适-异地', 'R2', '', '旧记录']
    ]),
    'utf8'
  );
  const root = await createWorkspace(t, { csvBytes });

  const found = await lookupCandidates({ workspace: root, name: '合成旧' });
  assert.equal(found.count, 2);
  assert.equal(found.hasTerminalOrContacted, true);
  assert.ok(found.matches.every(m => m.stage === 'unclassified' && m.terminal === true));

  for (const name of ['合成旧排', '合成旧拒']) {
    await assert.rejects(
      upsertCandidate({ workspace: root, role: 'UE-TA', name, status: '已打招呼' }),
      error => error.code === 'LEDGER_TERMINAL_BLOCKED' && error.exitCode === 3
    );
  }

  const forced = await upsertCandidate({
    workspace: root,
    role: 'UE-TA',
    name: '合成旧排',
    status: '观望',
    forceUpdate: true
  });
  assert.equal(forced.action, 'update');
  assert.equal(forced.status, '观望');
  assert.equal(forced.previousStatus, '已排除-学院硬卡');
});
