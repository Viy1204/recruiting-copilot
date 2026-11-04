import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const deploy = fileURLToPath(new URL('./deploy-rounds.mjs', import.meta.url));
const uiFiles = ['SKILL.md', 'public/app.js', 'public/index.html', 'public/style.css', 'types/index.d.ts'];
const roots = ['skills', '.claude/skills', '.agents/skills', '.qoder/skills'];
const owner = 'ui-deploy-test';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'board-ui-deploy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originals = new Map();
  const put = async (relative, text) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text); originals.set(relative, text);
  };
  for (const prefix of roots) {
    for (const file of uiFiles) {
      await put(`${prefix}/recruit-board/${file}`, `old synthetic interface: ${file}\n`);
    }
    if (prefix !== '.claude/skills') {
      await put(`${prefix}/recruit-board/.claude-plugin/plugin.json`, '{"name":"synthetic-board"}\n');
      await put(`${prefix}/recruit-board/hooks/register.tsx`, 'legacy native module stays until explicitly disabled\n');
    }
    await put(`${prefix}/recruit-daily/scripts/cycle_guard.py`, 'synthetic guard, must remain unchanged\n');
    await put(`${prefix}/recruit-daily/SKILL.md`, 'local authority stays here\n');
  }
  await put('AGENTS.md', 'synthetic local work rules\n');
  await put('CONTEXT.md', 'synthetic job requirements\n');
  await put('02-sourcing/dedup-ledger.csv', 'synthetic private data\n');
  await put('runtime/recruit-board/runs/example.json', '{"synthetic":"run"}\n');
  await put('runtime/recruit-board/decisions/example.json', '{"synthetic":"decision"}\n');
  await put('runtime/recruit-cycle.lock/owner.json', JSON.stringify({ owner }));
  const run = async (mode, backup = '-') => {
    const { stdout } = await execute(process.execPath, [deploy, root, mode, backup, owner], { maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  };
  return { root, originals, run };
}

test('网页部署只更新白名单文件，保留已装原生副本且备份可回滚、业务资料不变', async t => {
  const { root, originals, run } = await fixture(t);
  const prepared = await run('prepare-ui');
  assert.equal(prepared.changedFiles, roots.length * uiFiles.length);
  const manifest = JSON.parse(await readFile(path.join(prepared.backup, 'manifest.json'), 'utf8'));
  assert.equal(manifest.scope, 'interface-only');
  assert(manifest.files.every(file => uiFiles.some(suffix => file.relative.endsWith(`/recruit-board/${suffix}`))));
  assert(Object.hasOwn(manifest.protectedBefore, 'runtime/recruit-board/decisions/example.json'));
  assert.equal(await readFile(path.join(root, 'skills/recruit-board/public/app.js'), 'utf8'), originals.get('skills/recruit-board/public/app.js'));
  const applied = await run('apply', prepared.backup);
  assert.equal(applied.applied, roots.length * uiFiles.length);
  assert.equal(applied.protectedUnchanged, true);
  assert.equal((await run('verify', prepared.backup)).matchedFiles, roots.length * uiFiles.length);
  for (const [relative, text] of originals) {
    if (manifest.files.some(file => file.relative === relative)) continue;
    assert.equal(await readFile(path.join(root, relative), 'utf8'), text, relative);
  }
  await assert.rejects(readFile(path.join(root, '.claude/skills/recruit-board/hooks/register.tsx')));
  await run('rollback', prepared.backup);
  for (const [relative, text] of originals) assert.equal(await readFile(path.join(root, relative), 'utf8'), text, relative);
});

test('单网页升级备份并移除原生入口，保留业务与定制正文，可完整回滚', async t => {
  const { root, originals, run } = await fixture(t);
  const workflows = ['recruit-init', 'recruit-grill', 'recruit-daily', 'resume-review', 'interview-schedule', 'market-talent-mapping'];
  for (const prefix of roots) {
    for (const workflow of workflows) {
      const file = path.join(root, prefix, workflow, 'SKILL.md');
      await mkdir(path.dirname(file), { recursive: true });
      const local = `# ${workflow}\n\n本地已确认授权必须保留。\n\n## 本地规则\n\n业务门槛及预算不改变。\n`;
      await writeFile(file, local); originals.set(`${prefix}/${workflow}/SKILL.md`, local);
    }
    for (const [file, content] of [['ask-viy/SKILL.md', '# 总目录\n\nClaude 原生面板为可选手动入口，不自动打开两份界面。\n'], ['recruit-daily/references/scheduled-cycle.md', '本地定时预算和锁规则原文\n']]) {
      const relative = `${prefix}/${file}`;
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), content); originals.set(relative, content);
    }
  }
  await mkdir(path.join(root, '_shared'), { recursive: true });
  await writeFile(path.join(root, '_shared/recruit-board-progress.md'), '# 本地进度\n\n原授权不变。\n');
  originals.set('_shared/recruit-board-progress.md', '# 本地进度\n\n原授权不变。\n');
  const prepared = await run('prepare-web');
  const manifest = JSON.parse(await readFile(path.join(prepared.backup, 'manifest.json'), 'utf8'));
  assert.equal(manifest.scope, 'web-only-upgrade');
  assert.ok(manifest.files.some(item => item.after === null && item.relative.endsWith('hooks/register.tsx')));
  const applied = await run('apply', prepared.backup);
  assert.equal(applied.protectedUnchanged, true);
  await run('verify', prepared.backup);
  for (const prefix of roots) {
    await assert.rejects(readFile(path.join(root, prefix, 'recruit-board/hooks/register.tsx')), { code: 'ENOENT' });
    assert.match(await readFile(path.join(root, prefix, 'recruit-daily/SKILL.md'), 'utf8'), /本地已确认授权必须保留。[\s\S]*业务门槛及预算不改变。/);
    assert.equal(await readFile(path.join(root, prefix, 'recruit-daily/references/scheduled-cycle.md'), 'utf8'), '本地定时预算和锁规则原文\n');
  }
  await run('rollback', prepared.backup);
  for (const [relative, text] of originals) assert.equal(await readFile(path.join(root, relative), 'utf8'), text, relative);
});

test('备份后数据变化或锁归属变化时拒绝写界面', async t => {
  const { root, originals, run } = await fixture(t);
  const prepared = await run('prepare-ui');
  await writeFile(path.join(root, 'runtime/recruit-board/decisions/example.json'), '{"synthetic":"new decision"}\n');
  await assert.rejects(run('apply', prepared.backup), /业务文件或原轮次发生变化/);
  assert.equal(await readFile(path.join(root, 'skills/recruit-board/public/app.js'), 'utf8'), originals.get('skills/recruit-board/public/app.js'));
  await writeFile(path.join(root, 'runtime/recruit-cycle.lock/owner.json'), JSON.stringify({ owner: 'other-owner' }));
  await assert.rejects(run('verify', prepared.backup), /没有本次部署持有的共用锁/);
});
