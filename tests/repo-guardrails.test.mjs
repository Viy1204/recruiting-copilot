import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkRepoGuardrails } from '../scripts/check-repo-guardrails.mjs';

async function makeFixtureRepo(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rc-guardrails-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'tests/helpers'), { recursive: true });
  await mkdir(path.join(root, 'skills/recruit-board/scripts'), { recursive: true });
  await mkdir(path.join(root, 'docs/adr'), { recursive: true });
  await mkdir(path.join(root, 'verification/formal'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), '# Repo\n\nSee [ADR](docs/adr/0001-init.md).\n', 'utf8');
  await writeFile(path.join(root, 'docs/adr/0001-init.md'), '# ADR 0001\n', 'utf8');
  return root;
}

test('当前仓库通过全部确定性防呆检查', () => {
  const result = checkRepoGuardrails();
  assert.equal(
    result.ok,
    true,
    `Expected zero guardrail violations, got:\n${result.violations.map(v => `[${v.rule}] ${v.file}:${v.line}: ${v.message}`).join('\n')}`
  );
});

test('反例 1（PR #81 #1）：测试文件直接调用 symlink 在 Windows 易 EPERM，防呆检查必须拦截并指明 helpers/symlink.mjs', async t => {
  const root = await makeFixtureRepo(t);
  await writeFile(
    path.join(root, 'tests/recruit-board-listings-cli.test.mjs'),
    "import { symlink } from 'node:fs/promises';\nawait symlink('/tmp/a', '/tmp/b');\n",
    'utf8'
  );
  const result = checkRepoGuardrails(root);
  assert.equal(result.ok, false);
  const hit = result.violations.find(v => v.rule === 'no-raw-symlink-in-tests');
  assert.ok(hit);
  assert.match(hit.message, /helpers\/symlink\.mjs/);
});

test('反例 2（PR #81 #2/#3）：新脚本手写 lstat/readFile/TextDecoder 必须被拦截并指明 workspace-io.mjs', async t => {
  const root = await makeFixtureRepo(t);
  await writeFile(
    path.join(root, 'skills/recruit-board/scripts/listings.mjs'),
    "import { lstat, readFile } from 'node:fs/promises';\nconst text = new TextDecoder('utf-8').decode(await readFile('x'));\n",
    'utf8'
  );
  const result = checkRepoGuardrails(root);
  assert.equal(result.ok, false);
  const hits = result.violations.filter(v => v.rule === 'no-adhoc-workspace-io');
  assert.equal(hits.length, 2);
  assert.match(hits[0].message, /workspace-io\.mjs/);
});

test('反例 3（PR #75/#77）：新建未登记锁文件（如 context-hygiene.lock）必须被拦截', async t => {
  const root = await makeFixtureRepo(t);
  await writeFile(
    path.join(root, 'skills/recruit-board/scripts/hygiene.mjs'),
    "const lockFile = path.join(dir, 'context-hygiene.lock');\n",
    'utf8'
  );
  const result = checkRepoGuardrails(root);
  assert.equal(result.ok, false);
  const hit = result.violations.find(v => v.rule === 'no-rogue-lock-files');
  assert.ok(hit);
  assert.match(hit.message, /withWorkspaceLock/);
});

test('反例 4（PR #75/#79/#80）：重复手写岗位表解析器或引入已否决的 _shared/roles.json 必须被拦截', async t => {
  const root = await makeFixtureRepo(t);
  await writeFile(
    path.join(root, 'skills/recruit-board/scripts/screen-gate.mjs'),
    "const heading = '在招岗位与优先级';\nconst cols = ['岗位', '优先级', '状态'];\nconst p = '_shared/roles.json';\n",
    'utf8'
  );
  const result = checkRepoGuardrails(root);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.rule === 'no-duplicate-role-table-parser' && /model\.mjs/.test(v.message)));
  assert.ok(result.violations.some(v => v.rule === 'no-rejected-dual-source' && /ADR 0007/.test(v.message)));
});

test('反例 5（PR #75/#79）：ADR 重号或跳号必须被拦截', async t => {
  const root = await makeFixtureRepo(t);
  await writeFile(path.join(root, 'docs/adr/0001-duplicate.md'), '# dup\n', 'utf8');
  await writeFile(path.join(root, 'docs/adr/0003-gap.md'), '# gap\n', 'utf8');
  const result = checkRepoGuardrails(root);
  assert.equal(result.ok, false);
  const adrViolations = result.violations.filter(v => v.rule === 'adr-sequence-valid');
  assert.ok(adrViolations.some(v => /Duplicate ADR number 0001/.test(v.message)));
  assert.ok(adrViolations.some(v => /expected 0002 before 0003/.test(v.message)));
});

test('反例 6（AGENTS.md 红线 #1）：用户工作区文件落入模板仓库根目录必须被拦截', async t => {
  const root = await makeFixtureRepo(t);
  await writeFile(path.join(root, 'CONTEXT.md'), '# leaked workspace\n', 'utf8');
  const result = checkRepoGuardrails(root);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.rule === 'template-repo-clean-root' && v.file === 'CONTEXT.md'));
});

test('反例 7（PR #64）：文档中失效的相对 Markdown 链接必须被拦截', async t => {
  const root = await makeFixtureRepo(t);
  await writeFile(path.join(root, 'README.md'), '# Repo\n\nSee [Broken](docs/missing-guide.md).\n', 'utf8');
  const result = checkRepoGuardrails(root);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.rule === 'markdown-local-links-exist' && v.message.includes('docs/missing-guide.md')));
});

test('反例 8（PR #76/#80）：形式化验证受控源码改动但未同步验证基线时，无需 Java 即可提前报漂移', async t => {
  const root = await makeFixtureRepo(t);
  await writeFile(path.join(root, 'skills/recruit-board/model.mjs'), 'export const v = 2;\n', 'utf8');
  const staleHash = createHash('sha256').update('export const v = 1;\n').digest('hex');
  await writeFile(
    path.join(root, 'verification/formal/coverage.json'),
    JSON.stringify({ subsystems: { roles: 'coverage-roles.json' } }),
    'utf8'
  );
  await writeFile(
    path.join(root, 'verification/formal/coverage-roles.json'),
    JSON.stringify({ sources: [{ path: 'skills/recruit-board/model.mjs', sha256: staleHash }] }),
    'utf8'
  );
  const result = checkRepoGuardrails(root);
  assert.equal(result.ok, false);
  const hit = result.violations.find(v => v.rule === 'formal-coverage-sha256-sync');
  assert.ok(hit);
  assert.match(hit.message, /verify-recruit-roles\/SKILL\.md/);
});

test('行内例外必须携带原因、未过期日期与人类审批人，过期或格式残缺时自动失败', async t => {
  const root = await makeFixtureRepo(t);
  const file = path.join(root, 'skills/recruit-board/scripts/temp.mjs');

  await writeFile(
    file,
    "const lockFile = 'temp.lock'; // guardrail-allow: no-rogue-lock-files | reason: migration bridge | expires: 2027-01-01 | approved: @Viy1204\n",
    'utf8'
  );
  assert.equal(checkRepoGuardrails(root, { today: '2026-11-27' }).ok, true);

  const expired = checkRepoGuardrails(root, { today: '2027-01-02' });
  assert.equal(expired.ok, false);
  assert.ok(expired.violations.some(v => v.rule === 'guardrail-exception-expired'));

  await writeFile(file, "const lockFile = 'temp.lock'; // guardrail-allow: no-rogue-lock-files\n", 'utf8');
  const malformed = checkRepoGuardrails(root, { today: '2026-11-27' });
  assert.equal(malformed.ok, false);
  assert.ok(malformed.violations.some(v => v.rule === 'guardrail-exception-malformed'));
});
