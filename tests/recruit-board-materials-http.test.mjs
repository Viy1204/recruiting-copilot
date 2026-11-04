import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LEDGER_COLUMNS } from '../skills/recruit-board/model.mjs';
import { createBoardServer } from '../skills/recruit-board/scripts/server.mjs';

const candidateId = JSON.stringify(['合成甲', '旧岗位']);

test('HTTP资料保存、类型响应及岗位归并使用工作区与同源版本校验', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'materials-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['02-sourcing', 'runtime/resumes', '03-interview']) await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, 'CONTEXT.md'), '## 在招岗位与优先级\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| 正式岗位 | P0 | 在招 |\n');
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), `${LEDGER_COLUMNS.join(',')}\n1,合成甲,旧岗位,,A,面试中,合成来源,,\n`);
  await writeFile(path.join(root, 'runtime/resumes/resume.pdf'), '%PDF-1.4\n合成原件');
  await writeFile(path.join(root, 'runtime/resumes/resume.rtf'), '{\\rtf1\\ansi synthetic}');
  const server = await createBoardServer({ workspace: root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async resource => { const response = await fetch(origin + resource); assert.equal(response.status, 200); return response.json(); };
  const session = await get('/api/session');
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken };
  const post = (resource, body, extra = {}) => fetch(origin + resource, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const info = await get('/api/roles');
  assert.deepEqual(info.unconfiguredRoles, [{ name: '旧岗位', count: 1 }]);
  const aliased = await post('/api/roles/alias', { role: '旧岗位', target: '正式岗位', revision: info.configRevision });
  assert.equal(aliased.status, 200); assert.equal((await aliased.json()).roleAliases.旧岗位, '正式岗位');
  const query = new URLSearchParams({ candidate: candidateId });
  const list = await get('/api/candidates/materials?' + query);
  const files = list.options.map(({ path }) => ({ path, category: 'resume' }));
  const body = { candidateId, revision: list.revision, files };
  assert.equal((await post('/api/candidates/materials', body, { 'X-CSRF-Token': '0'.repeat(64) })).status, 403);
  assert.equal((await post('/api/candidates/materials', body)).status, 200);
  assert.equal((await post('/api/candidates/materials', body)).status, 409);
  const detail = await get('/api/candidates/detail?' + query);
  assert.equal(detail.documents.length, 2);
  for (const file of detail.documents) {
    const response = await fetch(origin + '/api/candidates/document?' + new URLSearchParams({ candidate: candidateId, document: file.id }));
    assert.equal(response.status, 200);
    assert.ok((response.headers.get('content-disposition') ?? '').startsWith(file.kind === 'rtf' ? 'attachment' : 'inline'));
    assert.equal(response.headers.get('content-type'), file.mimeType);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(path.join(root, file.path)));
  }
  assert.equal((await fetch(origin + '/api/candidates/materials?candidate=' + encodeURIComponent(candidateId) + '&path=outside')).status, 400);
});
