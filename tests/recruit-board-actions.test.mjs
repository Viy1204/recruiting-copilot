import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRun, LEDGER_COLUMNS, transitionRun } from '../skills/recruit-board/model.mjs';
import { readRunActivity, readRunResults } from '../skills/recruit-board/scripts/results.mjs';
import { readCandidateDetail, readCandidateDocument } from '../skills/recruit-board/scripts/records.mjs';
import { readRoleInfo, replaceRoleStatus, setRoleStatus } from '../skills/recruit-board/scripts/roles.mjs';
import { actionsCLI } from '../skills/recruit-board/scripts/actions.mjs';
import { MAX_FILE_BYTES, readSnapshot } from '../skills/recruit-board/scripts/reader.mjs';
import { createBoardServer } from '../skills/recruit-board/scripts/server.mjs';

const header = `${LEDGER_COLUMNS.join(',')}\n`;
const key = (name = '合成甲', role = '合成岗位') => JSON.stringify([name, role]);
const row = (name = '合成甲', role = '合成岗位', resume = 'runtime/resumes/resume.txt') => ['1', name, role, '合成背景', 'A', '已回复', '合成来源', resume, '<script>合成私密备注</script>'].join(',');
const context = '# 合成工作区\r\n\r\n## 在招岗位与优先级\r\n| 优先级 | 岗位 | 状态 | 对外 JD |\r\n|---|---|---|---|\r\n| P0 | 合成岗位 |  在招  | x |\r\n| P1 | 另一岗位 | 已关闭 | y |\r\n\r\n## 历史\r\n| 岗位 | 状态 |\r\n| 合成岗位 | 在招 |\r\n尾部保留\r\n';
async function fixture(t, csv = header + row()) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruit-actions-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['02-sourcing', '03-interview', 'runtime/resumes', '_shared']) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, 'CONTEXT.md'), context);
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), csv);
  await writeFile(path.join(root, 'runtime/resumes/resume.txt'), '<img src=x onerror=alert(1)>\n合成简历文本');
  await writeFile(path.join(root, 'runtime/resumes/resume.pdf'), '%PDF-1.4\n合成测试字节');
  return root;
}

const request = (port, pathname, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.once('error', reject);
  req.end(body);
});
async function serve(t, root) {
  const server = await createBoardServer({ workspace: root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

function encodedContext(text, encoding) {
  if (encoding === 'utf8') return Buffer.from(text);
  if (encoding === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
  const body = Buffer.from(text, 'utf16le');
  if (encoding === 'utf16be') body.swap16();
  return Buffer.concat([Buffer.from(encoding === 'utf16be' ? [0xfe, 0xff] : [0xff, 0xfe]), body]);
}

test('候选详情按原ID读取私密列，唯一同名同岗位档案及其相对附件才能关联', async t => {
  const root = await fixture(t, header + row('合成甲', '合成旧岗'));
  await writeFile(path.join(root, '_shared/recruit-board.config.json'), JSON.stringify({ schemaVersion: 1, statusStages: {}, roleAliases: { 合成旧岗: '合成岗位' } }));
  const archive = '# 面试档案 — 合成甲\n- **姓名**：合成甲\n- **应聘岗位**：合成岗位（合成附注）\n\n## 评价\n<script>不执行</script>\n[PDF](../runtime/resumes/resume.pdf)';
  await writeFile(path.join(root, '03-interview/合成甲.md'), archive);
  const detail = await readCandidateDetail(root, key('合成甲', '合成旧岗'));
  assert.equal(detail.candidate.role, '合成岗位');
  assert.equal(detail.candidate.rawRole, '合成旧岗');
  assert.equal(detail.background, '合成背景');
  assert.equal(detail.notes, '<script>合成私密备注</script>');
  assert.equal(detail.sourceRound, '合成来源');
  assert.deepEqual(detail.documents.map(doc => [doc.kind, doc.status]), [['text', 'ok'], ['markdown', 'ok'], ['pdf', 'ok']]);
  const document = detail.documents.find(doc => doc.kind === 'markdown');
  const opened = await readCandidateDocument(root, detail.candidate.id, document.id);
  assert.equal(opened.text, archive);
  assert.equal(opened.absolutePath, path.join(root, '03-interview/合成甲.md'));
  const snapshot = await readSnapshot(root);
  assert.ok(!JSON.stringify(snapshot).includes('合成背景'));
  assert.ok(!JSON.stringify(snapshot).includes('合成私密备注'));
  assert.ok(!JSON.stringify(detail).includes(root));
  await assert.rejects(readCandidateDocument(root, key('合成乙'), document.id), /未找到/);
  await assert.rejects(readCandidateDetail(root, 'not-json'), /标识无效/);
});

test('跨原岗同名、称谓打码或档案岗位不符不自动泄露档案；显式映射可消歧', async t => {
  const root = await fixture(t, header + [row(), row('合成甲', '另一岗位')].join('\n'));
  await writeFile(path.join(root, '03-interview/合成甲.md'), '- **应聘岗位**：合成岗位\n档案私密哨兵');
  const ambiguous = await readCandidateDetail(root, key());
  assert.ok(ambiguous.warnings.some(message => /同名跨原岗位/.test(message)));
  assert.ok(!ambiguous.documents.some(doc => doc.kind === 'markdown'));
  await writeFile(path.join(root, '_shared/recruit-board.files.json'), JSON.stringify({ schemaVersion: 1, candidates: { [key()]: { files: [{ path: '03-interview/合成甲.md', label: '明确指定档案', kind: 'markdown' }] } } }));
  const explicit = await readCandidateDetail(root, key());
  assert.ok(explicit.documents.some(doc => doc.label === '明确指定档案' && doc.status === 'ok'));
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), header + row());
  await rm(path.join(root, '_shared/recruit-board.files.json'));
  await writeFile(path.join(root, '03-interview/合成甲.md'), '- **应聘岗位**：另一岗位\n档案私密哨兵');
  const wrongRole = await readCandidateDetail(root, key());
  assert.ok(!wrongRole.documents.some(doc => doc.kind === 'markdown'));
  assert.ok(wrongRole.warnings.some(message => /无法唯一核对/.test(message)));
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), header + row('合成先生'));
  await writeFile(path.join(root, '03-interview/合成先生.md'), '- **应聘岗位**：合成岗位\n档案私密哨兵');
  assert.ok(!(await readCandidateDetail(root, key('合成先生'))).documents.some(doc => doc.kind === 'markdown'));
});

test('括号属于岗位本体时先完整匹配，缺身份字段或标题不符不自动关联', async t => {
  const root = await fixture(t, header + row('合成甲', '合成岗位（核心）'));
  await writeFile(path.join(root, 'CONTEXT.md'), context.replaceAll('合成岗位', '合成岗位（核心）'));
  const archive = path.join(root, '03-interview/合成甲.md');
  await writeFile(archive, '# 面试档案 — 合成甲（合成岗位）\n- **应聘岗位**：合成岗位（核心）\n');
  const detail = await readCandidateDetail(root, key('合成甲', '合成岗位（核心）'));
  assert.ok(detail.documents.some(doc => doc.kind === 'markdown' && doc.status === 'ok'));
  await writeFile(archive, '- **应聘岗位**：合成岗位（核心）\n身份信息未填写');
  assert.ok(!(await readCandidateDetail(root, key('合成甲', '合成岗位（核心）'))).documents.some(doc => doc.kind === 'markdown'));
  await writeFile(archive, '# 面试档案 — 合成乙\n- **应聘岗位**：合成岗位（核心）\n');
  assert.ok(!(await readCandidateDetail(root, key('合成甲', '合成岗位（核心）'))).documents.some(doc => doc.kind === 'markdown'));
});

test('带括号的另一个正式岗位或别名不能剥成当前岗位而串档', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'CONTEXT.md'), context.replace('| P1 | 另一岗位 | 已关闭 | y |', '| P1 | 合成岗位（绑定） | 在招 | y |'));
  const archive = path.join(root, '03-interview/合成甲.md');
  await writeFile(archive, '# 面试档案 — 合成甲\n- **应聘岗位**：合成岗位（绑定）\n另一岗位档案哨兵');
  const wrong = await readCandidateDetail(root, key());
  assert.ok(!wrong.documents.some(doc => doc.kind === 'markdown'));
  await writeFile(path.join(root, '_shared/recruit-board.config.json'), JSON.stringify({ schemaVersion: 1, statusStages: {}, roleAliases: { '合成岗位（别名）': '合成岗位（绑定）' } }));
  await writeFile(archive, '# 面试档案 — 合成甲\n- **应聘岗位**：合成岗位（别名）\n另一岗位档案哨兵');
  assert.ok(!(await readCandidateDetail(root, key())).documents.some(doc => doc.kind === 'markdown'));
});

test('匹配档案的Markdown附件支持平衡括号、转义括号与尖括号路径', async t => {
  const root = await fixture(t);
  for (const [file, text] of [['作品集(终版).md', '# 合成作品'], ['resume(最终).pdf', '%PDF-1.4\n合成PDF'], ['简历 (新).txt', '合成TXT']]) await writeFile(path.join(root, 'runtime/resumes', file), text);
  await writeFile(path.join(root, '03-interview/合成甲.md'), '# 面试档案 — 合成甲\n- **应聘岗位**：合成岗位\n[作品](../runtime/resumes/作品集(终版).md)\n[PDF](../runtime/resumes/resume\\(最终\\).pdf)\n[TXT](<../runtime/resumes/简历 (新).txt>)');
  const detail = await readCandidateDetail(root, key());
  for (const [label, kind] of [['作品', 'markdown'], ['PDF', 'pdf'], ['TXT', 'text']]) {
    const doc = detail.documents.find(document => document.label === label);
    assert.ok(doc, label);
    assert.equal(doc.kind, kind);
    assert.equal(doc.status, 'ok');
    assert.equal((await readCandidateDocument(root, key(), doc.id)).document.status, 'ok');
  }
});

test('资料入口拒外部、可执行、伪PDF与原路径参数，缺失和混合说明不猜拆', async t => {
  const root = await fixture(t);
  const other = await mkdtemp(path.join(tmpdir(), 'recruit-outside-test-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  await writeFile(path.join(other, 'outside.txt'), '禁止读取');
  await writeFile(path.join(root, 'runtime/resumes/tool.exe'), 'not executable');
  await writeFile(path.join(root, 'runtime/resumes/fake.pdf'), 'not pdf');
  const paths = [path.join(other, 'outside.txt'), pathToFileURL(path.join(other, 'outside.txt')).href, 'https://example.com/resume.pdf', 'runtime/resumes/tool.exe', 'runtime/resumes/fake.pdf', 'runtime/resumes/missing.txt', 'runtime/resumes/resume.txt;runtime/resumes/resume.pdf'];
  await writeFile(path.join(root, '_shared/recruit-board.files.json'), JSON.stringify({ schemaVersion: 1, candidates: { [key()]: { files: paths.map(file => ({ path: file })) } } }));
  const detail = await readCandidateDetail(root, key());
  assert.deepEqual(detail.documents.slice(1).map(doc => doc.status), ['blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'missing', 'missing']);
  for (const doc of detail.documents.slice(1)) await assert.rejects(readCandidateDocument(root, key(), doc.id));
  await assert.rejects(readCandidateDocument(root, key(), 'runtime/resumes/resume.txt'), /标识无效/);
  const inside = detail.documents[0];
  assert.equal((await readCandidateDocument(root, key(), inside.id)).text, '<img src=x onerror=alert(1)>\n合成简历文本');
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), header + row('合成乙'));
  await assert.rejects(readCandidateDocument(root, key('合成乙'), inside.id), /未关联/);
});

test('工作区内目录符号链接指向外部时资料不开放', async t => {
  const root = await fixture(t);
  const other = await mkdtemp(path.join(tmpdir(), 'recruit-link-test-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  await writeFile(path.join(other, 'outside.txt'), '禁止读取');
  await symlink(other, path.join(root, 'runtime/external'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), header + row('合成甲', '合成岗位', 'runtime/external/outside.txt'));
  assert.equal((await readCandidateDetail(root, key())).documents[0].status, 'blocked');
});

test('岗位保存只改标准表状态，保留其他字节、换行与编码，并写原文备份', async t => {
  const root = await fixture(t);
  for (const encoding of ['utf8', 'utf8bom', 'utf16le', 'utf16be']) {
    const before = encodedContext(context, encoding);
    await writeFile(path.join(root, 'CONTEXT.md'), before);
    const info = await readRoleInfo(root);
    const snapshot = await readSnapshot(root);
    assert.equal(snapshot.contextRevision, info.contextRevision);
    const saved = await setRoleStatus({ workspace: root, role: '合成岗位', status: '暂停', revision: info.contextRevision });
    assert.equal(saved.changed, true);
    assert.deepEqual(await readFile(path.join(root, 'CONTEXT.md')), encodedContext(context.replace('|  在招  |', '|  暂停  |'), encoding));
    assert.deepEqual(await readFile(path.join(root, saved.backup)), before);
    assert.equal(saved.roles.find(role => role.name === '合成岗位').status, '暂停');
    const unchanged = await setRoleStatus({ workspace: root, role: '合成岗位', status: '暂停', revision: saved.contextRevision });
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.backup, null);
  }
});

test('岗位 revision冲突、锁、非法枚举与非配置岗位均拒绝且不覆盖正文', async t => {
  const root = await fixture(t);
  const info = await readRoleInfo(root);
  const file = path.join(root, 'CONTEXT.md');
  await writeFile(file, context + '外部编辑\r\n');
  const input = { workspace: root, role: '合成岗位', status: '已关闭', revision: info.contextRevision };
  await assert.rejects(setRoleStatus(input), error => error.code === 'CONTEXT_CONFLICT' && error.status === 409);
  assert.equal(await readFile(file, 'utf8'), context + '外部编辑\r\n');
  const current = await readRoleInfo(root);
  await assert.rejects(setRoleStatus({ ...input, revision: current.contextRevision, status: '随意状态' }), /状态或配置版本无效/);
  await assert.rejects(setRoleStatus({ ...input, revision: current.contextRevision, role: '历史岗位' }), error => error.code === 'ROLE_NOT_CONFIGURED');
  const lock = await open(path.join(root, 'runtime/recruit-board/roles/context.lock'), 'wx');
  await assert.rejects(setRoleStatus({ ...input, revision: current.contextRevision }), error => error.code === 'ROLE_LOCKED');
  await lock.close();
  await rm(path.join(root, 'runtime/recruit-board/roles/context.lock'));
  const results = await Promise.allSettled([setRoleStatus({ ...input, revision: current.contextRevision }), setRoleStatus({ ...input, revision: current.contextRevision, status: '已下架' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await readdir(path.join(root, 'runtime/recruit-board/roles'))).filter(name => name.endsWith('.md')).length, 1);
  assert.match(replaceRoleStatus(context, '合成岗位', '待核'), /\|  待核  \|/);
  assert.equal(replaceRoleStatus(context.replace('|  在招  |', '|   |'), '合成岗位', '在招'), context.replace('|  在招  |', '|   在招|'));
});

test('HTTP详情按需、文本安全类型、PDF内联下载；岗位保存需要同源令牌和revision', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, '_shared/recruit-board.files.json'), JSON.stringify({ schemaVersion: 1, candidates: { [key()]: { files: [{ path: 'runtime/resumes/resume.pdf' }] } } }));
  const port = await serve(t, root);
  const detailURL = `/api/candidates/detail?candidate=${encodeURIComponent(key())}`;
  const detail = JSON.parse((await request(port, detailURL)).body);
  const pdf = detail.documents.find(doc => doc.kind === 'pdf');
  const text = detail.documents.find(doc => doc.kind === 'text');
  const docURL = doc => `/api/candidates/document?candidate=${encodeURIComponent(key())}&document=${doc.id}`;
  const pdfResponse = await request(port, docURL(pdf));
  assert.equal(pdfResponse.status, 200);
  assert.equal(pdfResponse.headers['content-type'], 'application/pdf');
  assert.match(pdfResponse.headers['content-disposition'], /^inline;/);
  assert.match((await request(port, `${docURL(pdf)}&download=1`)).headers['content-disposition'], /^attachment;/);
  assert.equal((await request(port, docURL(text))).headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal((await request(port, `${docURL(text)}&path=CONTEXT.md`)).status, 400);
  assert.equal((await request(port, '/_shared/recruit-board.files.json')).status, 404);
  assert.equal((await request(port, '/api/candidates/detail', { method: 'POST' })).status, 405);
  const session = JSON.parse((await request(port, '/api/session')).body);
  const info = JSON.parse((await request(port, '/api/roles')).body);
  const body = JSON.stringify({ role: '合成岗位', status: '已下架', revision: info.contextRevision });
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, Origin: `http://127.0.0.1:${port}` };
  assert.equal((await request(port, '/api/roles/status', { method: 'POST', body, headers: { ...headers, 'X-CSRF-Token': 'é'.repeat(64) } })).status, 403);
  assert.equal((await request(port, 'http://[invalid')).status, 400);
  assert.equal((await request(port, '/api/roles/status', { method: 'POST', body })).status, 403);
  assert.equal((await request(port, '/api/roles/status', { method: 'POST', body, headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request(port, '/api/roles/status', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken } })).status, 403);
  assert.equal((await request(port, '/api/roles/status', { method: 'POST', body, headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
  const saved = await request(port, '/api/roles/status', { method: 'POST', body, headers });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.body).backup, undefined);
  assert.equal(saved.body.includes(root), false);
  assert.equal((await request(port, '/api/roles/status', { method: 'POST', body, headers })).status, 409);
  assert.equal((await request(port, '/api/snapshot', { method: 'POST', headers, body })).status, 405);
  const after = JSON.parse((await request(port, '/api/snapshot')).body);
  assert.equal(after.roles.find(role => role.name === '合成岗位').status, '已下架');
  assert.equal(after.candidates.length, 1);
});

test('共用CLI返回直接data JSON，错误为JSON且exit1，不回显绝对路径', async t => {
  const root = await fixture(t);
  const detail = await actionsCLI(['candidate', '--workspace', root, '--candidate', key()]);
  const document = await actionsCLI(['document', '--workspace', root, '--candidate', key(), '--document', detail.documents[0].id]);
  assert.match(document.text, /合成简历/);
  assert.equal(document.absolutePath, path.join(root, 'runtime/resumes/resume.txt'));
  const info = await actionsCLI(['role-info', '--workspace', root]);
  const saved = await actionsCLI(['role-set', '--workspace', root, '--role', '合成岗位', '--status', '待核', '--revision', info.contextRevision]);
  assert.equal(saved.status, '待核');
  const cli = new URL('../skills/recruit-board/scripts/actions.mjs', import.meta.url);
  const { stdout } = await promisify(execFile)(process.execPath, [cli.pathname.replace(/^\/(\w:)/, '$1'), 'candidate', '--workspace', root, '--candidate', key()]);
  assert.equal(JSON.parse(stdout).candidate.id, key());
  await assert.rejects(promisify(execFile)(process.execPath, [cli.pathname.replace(/^\/(\w:)/, '$1'), 'candidate', '--workspace', root, '--candidate', 'bad']), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stderr).error.code, 'CANDIDATE_INVALID');
    assert.equal(error.stderr.includes(root), false);
    return true;
  });
});

const progressTime = '2026-10-22T01:00:00.000Z';
async function runFixture(root, id = 'results-read') {
  let run = createRun({ id, workflow: 'daily', now: progressTime });
  run = transitionRun(run, { type: 'result', result: { id: 'screen-1', stepId: 'screen', candidateId: key('未入台账合成乙', '原岗位'), action: '结果动作私密哨兵', outcome: '结果结论私密哨兵', attention: 'decision', nextAction: '结果下一步私密哨兵' } }, progressTime);
  const directory = path.join(root, 'runtime/recruit-board/runs');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${id}.json`);
  await writeFile(file, JSON.stringify(run));
  return { run, file, directory };
}

test('结果按需读取与CLI共享公开返回，旧null与新空记录保留区别且不依赖台账', async t => {
  const root = await fixture(t);
  const { run, file, directory } = await runFixture(root);
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), 'bad ledger must not be scanned');
  const expected = { runId: run.id, updatedAt: progressTime, results: run.results, revision: 1 };
  assert.deepEqual(await readRunResults(root, run.id), expected);
  assert.deepEqual(await actionsCLI(['run-results', '--workspace', root, '--run', run.id]), expected);
  const cli = new URL('../skills/recruit-board/scripts/actions.mjs', import.meta.url);
  const executable = cli.pathname.replace(/^\/(\w:)/, '$1');
  const { stdout } = await promisify(execFile)(process.execPath, [executable, 'run-results', '--workspace', root, '--run', run.id]);
  assert.deepEqual(JSON.parse(stdout), expected);
  assert.equal(stdout.includes(root), false);
  const { results, resultsRevision, ...old } = run;
  await writeFile(file, JSON.stringify(old));
  assert.deepEqual(await readRunResults(root, run.id), { runId: run.id, updatedAt: progressTime, results: null, revision: 0 });
  const empty = createRun({ id: 'empty-results', workflow: 'daily', now: progressTime });
  await writeFile(path.join(directory, 'empty-results.json'), JSON.stringify(empty));
  assert.deepEqual(await readRunResults(root, empty.id), { runId: empty.id, updatedAt: progressTime, results: [], revision: 0 });
  await assert.rejects(actionsCLI(['run-results', '--workspace', root]), error => error.code === 'ACTION_INPUT_INVALID');
  await assert.rejects(actionsCLI(['run-results', '--workspace', root, '--run', run.id, '--run', run.id]), error => error.code === 'ACTION_INPUT_INVALID');
  await assert.rejects(promisify(execFile)(process.execPath, [executable, 'run-results', '--workspace', root, '--run', '../bad']), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stderr).error.code, 'RUN_INPUT_INVALID');
    assert.match(JSON.parse(error.stderr).error.message, /runId/);
    assert.equal(error.stderr.includes(root), false);
    return true;
  });
});

test('结果读取固定run路径，输入/缺失/损坏/超限均返回受控400、404、422且不泄漏路径', async t => {
  const root = await fixture(t);
  const { run, file } = await runFixture(root);
  for (const id of ['../results-read', '/absolute', 'results-read.json', 'x/y', 'x\\y', '', 'a'.repeat(65)]) await assert.rejects(readRunResults(root, id), error => error.code === 'RUN_INPUT_INVALID' && error.status === 400 && !error.message.includes(root));
  await assert.rejects(readRunResults(root, 'missing'), error => error.code === 'RUN_NOT_FOUND' && error.status === 404);
  await assert.rejects(readRunResults(undefined, run.id), error => error.code === 'RUN_WORKSPACE_INVALID' && error.status === 400);
  await assert.rejects(readRunResults(path.join(root, 'missing-workspace'), run.id), error => error.code === 'RUN_WORKSPACE_INVALID' && error.status === 404 && !error.message.includes(root));
  for (const text of [`{"path":"${root.replaceAll('\\', '\\\\')}"`, JSON.stringify({ ...run, id: 'different-id' }), JSON.stringify({ ...run, results: [{ ...run.results[0], candidateId: 'bad' }] })]) {
    await writeFile(file, text);
    await assert.rejects(readRunResults(root, run.id), error => error.code === 'RUN_INVALID' && error.status === 422 && !error.message.includes(root));
  }
  await writeFile(file, 'x'.repeat(MAX_FILE_BYTES + 1));
  await assert.rejects(readRunResults(root, run.id), error => error.code === 'RUN_TOO_LARGE' && error.status === 422);
  await rm(file);
  await mkdir(file);
  await assert.rejects(readRunResults(root, run.id), error => error.code === 'RUN_PATH_UNSAFE' && error.status === 422);
});

test('结果目录的每层realpath限制工作区，最终文件拒绝符号链接且不会读到外部正文', async t => {
  const root = await fixture(t);
  const { run, file } = await runFixture(root);
  const other = await mkdtemp(path.join(tmpdir(), 'recruit-result-outside-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  const outside = path.join(other, 'outside.json');
  await writeFile(outside, JSON.stringify(run));
  await rm(file);
  await symlink(other, file, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readRunResults(root, run.id), error => error.code === 'RUN_PATH_UNSAFE' && error.status === 422);
  await rm(file);
  let fileLinked = true;
  try { await symlink(outside, file, 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    fileLinked = false;
    t.diagnostic('当前 Windows 未授予普通文件 symlink 权限；目录 junction 和各层工作区边界已验证');
  }
  if (fileLinked) {
    await assert.rejects(readRunResults(root, run.id), error => error.code === 'RUN_PATH_UNSAFE' && error.status === 422);
    await rm(file);
  }
  const parent = await mkdtemp(path.join(tmpdir(), 'recruit-result-junctions-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const tests = [
    { link: 'runtime', target: path.join(other, 'runtime'), suffix: 'recruit-board/runs' },
    { link: 'runtime/recruit-board', target: path.join(other, 'board'), suffix: 'runs' },
    { link: 'runtime/recruit-board/runs', target: path.join(other, 'runs'), suffix: '' }
  ];
  for (let index = 0; index < tests.length; index++) {
    const item = tests[index];
    const workspace = path.join(parent, `workspace-${index}`);
    const targetRuns = path.join(item.target, item.suffix);
    await mkdir(targetRuns, { recursive: true });
    await writeFile(path.join(targetRuns, `${run.id}.json`), JSON.stringify(run));
    await mkdir(path.dirname(path.join(workspace, item.link)), { recursive: true });
    await symlink(item.target, path.join(workspace, item.link), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readRunResults(workspace, run.id), error => error.code === 'RUN_PATH_UNSAFE' && error.status === 422 && !error.message.includes(other));
  }
});

test('HTTP结果按需可读仅允许一个run参数，遵守Host/Origin/no-store与只读策略', async t => {
  const root = await fixture(t);
  const { run, file, directory } = await runFixture(root);
  const port = await serve(t, root);
  const endpoint = `/api/runs/results?run=${run.id}`;
  const response = await request(port, endpoint);
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(JSON.parse(response.body), { runId: run.id, updatedAt: progressTime, results: run.results, revision: 1 });
  assert.equal(response.body.includes(root), false);
  const snapshot = await request(port, '/api/snapshot');
  assert.equal(JSON.parse(snapshot.body).runs[0].resultSummary.decisions, 1);
  for (const text of ['结果动作私密哨兵', '结果结论私密哨兵', '结果下一步私密哨兵', 'candidateId', '"results"']) assert.equal(snapshot.body.includes(text), false, text);
  assert.equal((await request(port, endpoint, { method: 'HEAD' })).body, '');
  assert.equal((await request(port, endpoint, { method: 'POST' })).status, 405);
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await request(port, endpoint, { headers })).status, 403);
  assert.equal((await request(port, endpoint, { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
  for (const query of ['', '?run=', '?run=../bad', '?run=x&run=y', '?run=results-read&file=CONTEXT.md', '?path=runtime/recruit-board/runs/results-read.json']) {
    const invalid = await request(port, `/api/runs/results${query}`);
    assert.equal(invalid.status, 400, query);
    assert.equal(JSON.parse(invalid.body).error.code, 'RUN_INPUT_INVALID');
    assert.equal(invalid.body.includes(root), false);
  }
  assert.equal((await request(port, '/api/runs/results?run=missing')).status, 404);
  const { results, resultsRevision, ...old } = run;
  await writeFile(file, JSON.stringify(old));
  assert.deepEqual(JSON.parse((await request(port, endpoint)).body), { runId: run.id, updatedAt: progressTime, results: null, revision: 0 });
  await writeFile(path.join(directory, 'empty-http.json'), JSON.stringify(createRun({ id: 'empty-http', workflow: 'daily', now: progressTime })));
  assert.deepEqual(JSON.parse((await request(port, '/api/runs/results?run=empty-http')).body).results, []);
  await writeFile(file, JSON.stringify({ ...run, results: [{ ...run.results[0], stepId: 'wrong' }] }));
  const invalid = await request(port, endpoint);
  assert.equal(invalid.status, 422);
  assert.equal(JSON.parse(invalid.body).error.code, 'RUN_INVALID');
  assert.match(JSON.parse(invalid.body).error.message, /结果步骤/);
  assert.equal(invalid.body.includes(root), false);
});

test('最近动态按需给最近3条收据，同时间后条优先且同人多条保留，版本变化可见且正文不入快照', async t => {
  const root = await fixture(t);
  const { run, file } = await runFixture(root, 'activity-read');
  const records = [
    { ...run.results[0], id: 'oldest', updatedAt: progressTime },
    { ...run.results[0], id: 'tie-first', updatedAt: '2026-10-22T01:01:00.000Z' },
    { ...run.results[0], id: 'newest', updatedAt: '2026-10-22T01:02:00.000Z' },
    { ...run.results[0], id: 'tie-last', updatedAt: '2026-10-22T01:01:00.000Z' },
    { ...run.results[0], id: 'older-late-index', updatedAt: progressTime }
  ];
  const updated = { ...run, results: records, updatedAt: '2026-10-22T01:02:00.000Z', resultsRevision: 5 };
  await writeFile(file, JSON.stringify(updated));
  const before = await readFile(file);
  await rm(path.join(root, '02-sourcing'), { recursive: true });
  await rm(path.join(root, 'CONTEXT.md'));
  const expected = { runId: run.id, revision: 5, updatedAt: updated.updatedAt, items: [records[2], records[3], records[1]] };
  assert.deepEqual(await readRunActivity(root, run.id), expected);
  assert.deepEqual(await actionsCLI(['run-activity', '--workspace', root, '--run', run.id]), expected);
  assert.equal(new Set(expected.items.map(item => item.candidateId)).size, 1);
  const executable = new URL('../skills/recruit-board/scripts/actions.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  const { stdout } = await promisify(execFile)(process.execPath, [executable, 'run-activity', '--workspace', root, '--run', run.id]);
  assert.deepEqual(JSON.parse(stdout), expected);
  assert.deepEqual(await readFile(file), before);
  const port = await serve(t, root);
  const endpoint = `/api/runs/activity?run=${run.id}`;
  const response = await request(port, endpoint);
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(JSON.parse(response.body), expected);
  await writeFile(file, JSON.stringify({ ...updated, results: records.map(record => record.id === 'newest' ? { ...record, outcome: '同毫秒更正可见' } : record), resultsRevision: 6 }));
  const changed = JSON.parse((await request(port, endpoint)).body);
  assert.equal(changed.updatedAt, expected.updatedAt);
  assert.equal(changed.revision, 6);
  assert.equal(changed.items[0].outcome, '同毫秒更正可见');
  const snapshot = await request(port, '/api/snapshot');
  for (const text of ['candidateId', '结果动作私密哨兵', '结果结论私密哨兵', '结果下一步私密哨兵', '同毫秒更正可见', '未入台账合成乙']) assert.equal(snapshot.body.includes(text), false, text);
  assert.equal(JSON.parse(snapshot.body).runs[0].resultSummary.total, 1);
});

test('动态旧null、新空和不足3条保持原义，HTTP与CLI拒绝扩展参数并沿用安全读取', async t => {
  const root = await fixture(t);
  const { run, file, directory } = await runFixture(root, 'activity-boundary');
  const { results, resultsRevision, ...old } = run;
  await writeFile(file, JSON.stringify(old));
  assert.deepEqual(await readRunActivity(root, run.id), { runId: run.id, revision: 0, updatedAt: progressTime, items: null });
  const port = await serve(t, root);
  const endpoint = `/api/runs/activity?run=${run.id}`;
  assert.deepEqual(JSON.parse((await request(port, endpoint)).body).items, null);
  const empty = createRun({ id: 'empty-activity', workflow: 'daily', now: progressTime });
  await writeFile(path.join(directory, `${empty.id}.json`), JSON.stringify(empty));
  assert.deepEqual(await readRunActivity(root, empty.id), { runId: empty.id, revision: 0, updatedAt: progressTime, items: [] });
  await writeFile(file, JSON.stringify(run));
  assert.deepEqual((await readRunActivity(root, run.id)).items, run.results);
  assert.equal((await request(port, endpoint, { method: 'HEAD' })).body, '');
  assert.equal((await request(port, endpoint, { method: 'POST' })).status, 405);
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await request(port, endpoint, { headers })).status, 403);
  assert.equal((await request(port, endpoint, { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
  for (const query of ['', '?run=', '?run=../bad', '?run=x&run=y', '?run=activity-boundary&limit=3', '?run=activity-boundary&file=CONTEXT.md']) {
    const invalid = await request(port, `/api/runs/activity${query}`);
    assert.equal(invalid.status, 400, query);
    assert.equal(JSON.parse(invalid.body).error.code, 'RUN_INPUT_INVALID');
    assert.equal(invalid.body.includes(root), false);
  }
  for (const extra of [[], ['--limit', '3'], ['--run', run.id]]) {
    const args = ['run-activity', '--workspace', root, ...(extra.length ? ['--run', run.id, ...extra] : [])];
    await assert.rejects(actionsCLI(args), error => error.code === 'ACTION_INPUT_INVALID');
  }
  assert.equal((await request(port, '/api/runs/activity?run=missing')).status, 404);
  await assert.rejects(readRunActivity(root, '../bad'), error => error.code === 'RUN_INPUT_INVALID');
  await assert.rejects(readRunActivity(root, 'missing'), error => error.code === 'RUN_NOT_FOUND');
  await writeFile(file, '{');
  const invalid = await request(port, endpoint);
  assert.equal(invalid.status, 422);
  assert.equal(JSON.parse(invalid.body).error.code, 'RUN_INVALID');
});

test('工作区fence覆盖附件query与岗位写入口，拒绝错工作区前不改文件和revision冲突行为', async t => {
  const root = await fixture(t);
  const port = await serve(t, root);
  const workspaceKey = JSON.parse((await request(port, '/api/health')).body).workspaceKey;
  const wrong = workspaceKey === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
  const detailURL = `/api/candidates/detail?candidate=${encodeURIComponent(key())}`;
  const detail = JSON.parse((await request(port, `${detailURL}&workspace=${workspaceKey}`)).body);
  const docURL = `/api/candidates/document?candidate=${encodeURIComponent(key())}&document=${detail.documents[0].id}`;
  assert.equal((await request(port, `${docURL}&workspace=${workspaceKey}`)).status, 200);
  const rejected = await request(port, `${docURL}&workspace=${wrong}`);
  assert.equal(rejected.status, 409);
  assert.equal(JSON.parse(rejected.body).error.code, 'WORKSPACE_MISMATCH');
  assert.equal(rejected.body.includes('合成简历文本'), false);
  const info = JSON.parse((await request(port, `/api/roles?workspace=${workspaceKey}`)).body);
  const session = JSON.parse((await request(port, '/api/session', { headers: { 'X-Workspace-Key': workspaceKey } })).body);
  const file = path.join(root, 'CONTEXT.md');
  const before = await readFile(file);
  const body = JSON.stringify({ role: '合成岗位', status: '暂停', revision: info.contextRevision });
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, Origin: `http://127.0.0.1:${port}`, 'X-Workspace-Key': workspaceKey };
  const wrongSave = await request(port, '/api/roles/status', { method: 'POST', body, headers: { ...headers, 'X-Workspace-Key': wrong } });
  assert.equal(wrongSave.status, 409);
  assert.equal(JSON.parse(wrongSave.body).error.code, 'WORKSPACE_MISMATCH');
  assert.deepEqual(await readFile(file), before);
  assert.equal((await request(port, `/api/roles/status?workspace=${workspaceKey}`, { method: 'POST', body, headers })).status, 200);
  const conflict = await request(port, '/api/roles/status', { method: 'POST', body, headers });
  assert.equal(conflict.status, 409);
  assert.equal(JSON.parse(conflict.body).error.code, 'CONTEXT_CONFLICT');
});
