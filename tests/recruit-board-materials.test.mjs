import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LEDGER_COLUMNS } from '../skills/recruit-board/model.mjs';
import { readCandidateDetail, readCandidateDocument } from '../skills/recruit-board/scripts/records.mjs';

const candidateId = JSON.stringify(['合成甲', '合成岗位']);
const otherId = JSON.stringify(['合成甲', '另一岗位']);
const mappingPath = '_shared/recruit-board.files.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const row = (name = '合成甲', role = '合成岗位', file = '') => ['1', name, role, '合成背景', 'A', '面试中', '本地合成来源', file, ''].join(',');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7xkAAAAASUVORK5CYII=', 'base64');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const doc = Buffer.alloc(1024);
Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(doc);
doc.writeUInt16LE(3, 26);
doc.writeUInt16LE(0xfffe, 28);
doc.writeUInt16LE(9, 30);
Buffer.from('WordDocument\0', 'utf16le').copy(doc, 512);

function docx() {
  const names = ['[Content_Types].xml', 'word/document.xml'];
  const local = [], central = [];
  let offset = 0;
  for (const value of names) {
    const name = Buffer.from(value), body = Buffer.from('<xml/>');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function fixture(t, rows = [row()]) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruit-materials-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of ['02-sourcing', '03-interview', 'runtime/resumes', '_shared']) await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(path.join(root, 'CONTEXT.md'), '# 合成工作区\n## 在招岗位与优先级\n| 优先级 | 岗位 | 状态 |\n|---|---|---|\n| P0 | 合成岗位 | 在招 |\n| P1 | 另一岗位 | 在招 |\n');
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), `${LEDGER_COLUMNS.join(',')}\n${rows.join('\n')}\n`);
  return root;
}

async function mapFiles(root, files, extra = {}) {
  const value = { schemaVersion: 1, candidates: { [candidateId]: { files, ...extra } } };
  await writeFile(path.join(root, mappingPath), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

const api = () => import('../skills/recruit-board/scripts/materials.mjs');
const selection = (file, category = 'resume') => ({ path: file, category });

test('原件按字节检查 PDF、PNG/JPG、DOC/DOCX/RTF，Office 只下载且保留原始 bytes', async t => {
  const root = await fixture(t);
  const cases = [
    ['resume.pdf', Buffer.from('%PDF-1.4\n合成原件'), 'pdf', 'application/pdf', false],
    ['resume.png', png, 'png', 'image/png', false],
    ['resume.jpg', jpeg, 'jpeg', 'image/jpeg', false],
    ['resume.jpeg', jpeg, 'jpeg', 'image/jpeg', false],
    ['resume.doc', doc, 'doc', 'application/msword', true],
    ['resume.docx', docx(), 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', true],
    ['resume.rtf', Buffer.from('{\\rtf1\\ansi 合成原件}'), 'rtf', 'application/rtf', true]
  ];
  for (const [name, bytes] of cases) await writeFile(path.join(root, 'runtime/resumes', name), bytes);
  await mapFiles(root, cases.map(([name]) => selection(`runtime/resumes/${name}`)));
  const detail = await readCandidateDetail(root, candidateId);
  assert.equal(detail.documents.length, cases.length);
  for (const [name, bytes, kind, mimeType, downloadOnly] of cases) {
    const reference = detail.documents.find(file => file.filename === name);
    assert.ok(reference, name);
    assert.equal(reference.status, 'ok', name);
    assert.equal(reference.category, 'resume');
    assert.equal(reference.kind, kind);
    assert.equal(reference.mimeType, mimeType);
    assert.equal(reference.downloadOnly, downloadOnly);
    const opened = await readCandidateDocument(root, candidateId, reference.id);
    assert.deepEqual(opened.bytes, bytes);
    assert.equal(opened.document.mimeType, mimeType);
    assert.equal(opened.document.downloadOnly, downloadOnly);
    assert.equal(opened.text, null);
  }
  assert.equal(JSON.stringify(detail).includes(root), false);
});

test('伪图片、伪 Office、任意 ZIP、二进制文本和超大原件均拒绝', async t => {
  const root = await fixture(t);
  const files = ['fake.png', 'fake.jpg', 'fake.doc', 'fake.docx', 'fake.rtf', 'binary.txt'];
  for (const name of files) await writeFile(path.join(root, 'runtime/resumes', name), name.endsWith('.txt') ? Buffer.from([0, 1, 2, 3]) : Buffer.from('MZ 假附件'));
  const huge = await open(path.join(root, 'runtime/resumes/huge.pdf'), 'w');
  await huge.truncate(24 * 1024 * 1024 + 1);
  await huge.close();
  files.push('huge.pdf');
  await mapFiles(root, files.map(name => ({ path: `runtime/resumes/${name}` })));
  const detail = await readCandidateDetail(root, candidateId);
  assert.ok(detail.documents.every(file => file.status === 'blocked'));
  for (const file of detail.documents) await assert.rejects(readCandidateDocument(root, candidateId, file.id), error => error.status === 403);
  const wrongZip = docx();
  wrongZip.write('evil/document.xml', wrongZip.indexOf('word/document.xml'), 'utf8');
  await writeFile(path.join(root, 'runtime/resumes/fake.docx'), wrongZip);
  assert.equal((await readCandidateDetail(root, candidateId)).documents.find(file => file.filename === 'fake.docx').status, 'blocked');
});

test('显式档案消歧后不重复空路径或核对警告，并单列尚未获取的原始简历', async t => {
  const root = await fixture(t, [row(), row('合成甲', '另一岗位')]);
  await writeFile(path.join(root, '03-interview/合成甲.md'), '# 待核对档案\n- 岗位：另一岗位\n');
  await writeFile(path.join(root, '03-interview/合成甲-brief.md'), '# 合成 brief\n');
  await mapFiles(root, [selection('03-interview/合成甲.md', 'archive'), selection('03-interview/合成甲-brief.md', 'brief')]);
  const detail = await readCandidateDetail(root, candidateId);
  assert.deepEqual(detail.documents.map(file => file.category), ['archive', 'brief']);
  assert.equal(detail.warnings.some(value => /未填写简历路径|同名跨原岗位|无法唯一核对/.test(value)), false);
  assert.ok(detail.warnings.some(value => /原始简历未获取/.test(value)));
  assert.equal((await readCandidateDetail(root, otherId)).documents.length, 0);
});

test('待选资料只来自既定目录；不按打码同名自动归属，不读链接外逃或其他私有目录', async t => {
  const root = await fixture(t, [row('李*')]);
  const id = JSON.stringify(['李*', '合成岗位']);
  await writeFile(path.join(root, '03-interview/李某.md'), '# 同名也不自动关联\n');
  await writeFile(path.join(root, 'runtime/resumes/可选.png'), png);
  await mkdir(path.join(root, 'private'));
  await writeFile(path.join(root, 'private/不得列出.pdf'), '%PDF-1.4');
  await writeFile(path.join(root, 'runtime/resumes/tool.exe'), 'MZ');
  const outside = await mkdtemp(path.join(tmpdir(), 'recruit-materials-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, '外部.txt'), '禁止读取');
  await symlink(outside, path.join(root, '03-interview/external'), process.platform === 'win32' ? 'junction' : 'dir');
  const { listCandidateMaterials } = await api();
  const listed = await listCandidateMaterials(root, id);
  assert.deepEqual(listed.options.map(file => file.path).sort(), ['03-interview/李某.md', 'runtime/resumes/可选.png']);
  assert.deepEqual(listed.files, []);
  assert.equal(listed.confirmed, false);
  assert.match(listed.revision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(listed).includes(root), false);
  await assert.rejects(listCandidateMaterials(root, JSON.stringify(['不存在', '合成岗位'])), error => error.status === 404);
});

test('确认清单跨读取持久化；完整替换和清空后不恢复台账或自动档案', async t => {
  const root = await fixture(t, [row('合成甲', '合成岗位', 'runtime/resumes/old.txt')]);
  await writeFile(path.join(root, 'runtime/resumes/old.txt'), '旧简历');
  await writeFile(path.join(root, '03-interview/合成甲.md'), '# 面试档案 — 合成甲\n- 应聘岗位：合成岗位\n');
  await writeFile(path.join(root, 'runtime/resumes/new.png'), png);
  const { listCandidateMaterials, setCandidateMaterials } = await api();
  const before = await listCandidateMaterials(root, candidateId);
  const saved = await setCandidateMaterials({ workspace: root, candidateId, revision: before.revision, files: [selection('runtime/resumes/new.png')] });
  assert.equal(saved.changed, true);
  const detail = await readCandidateDetail(root, candidateId);
  assert.deepEqual(detail.documents.map(file => file.path), ['runtime/resumes/new.png']);
  assert.equal((await listCandidateMaterials(root, candidateId)).confirmed, true);
  const unchanged = await setCandidateMaterials({ workspace: root, candidateId, revision: saved.revision, files: [selection('runtime/resumes/new.png')] });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.backup, null);
  const cleared = await setCandidateMaterials({ workspace: root, candidateId, revision: saved.revision, files: [] });
  assert.deepEqual((await readCandidateDetail(root, candidateId)).documents, []);
  assert.equal((await listCandidateMaterials(root, candidateId)).confirmed, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, cleared.backup), 'utf8')).candidates[candidateId].files.map(file => file.path), ['runtime/resumes/new.png']);
  assert.equal(await readFile(path.join(root, 'runtime/resumes/old.txt'), 'utf8'), '旧简历');
});

test('旧 schema 可读，更新保留其他候选和原文备份；冲突和并发写不丢失关联', async t => {
  const root = await fixture(t, [row(), row('合成甲', '另一岗位')]);
  await writeFile(path.join(root, 'runtime/resumes/one.txt'), '第一份');
  await writeFile(path.join(root, 'runtime/resumes/two.txt'), '第二份');
  const legacy = { schemaVersion: 1, candidates: { [otherId]: { files: [{ path: 'runtime/resumes/two.txt', label: '旧文件', kind: 'text' }] } } };
  const original = Buffer.from(`\uFEFF${JSON.stringify(legacy)}\r\n`);
  await writeFile(path.join(root, mappingPath), original);
  const { listCandidateMaterials, setCandidateMaterials } = await api();
  const initial = await listCandidateMaterials(root, candidateId);
  const input = { workspace: root, candidateId, revision: initial.revision, files: [selection('runtime/resumes/one.txt')] };
  const saved = await setCandidateMaterials(input);
  assert.deepEqual(await readFile(path.join(root, saved.backup)), original);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, mappingPath), 'utf8')).candidates[otherId], legacy.candidates[otherId]);
  await assert.rejects(setCandidateMaterials(input), error => error.status === 409 && error.code === 'MATERIALS_CONFLICT');
  const concurrent = await Promise.allSettled([
    setCandidateMaterials({ ...input, revision: saved.revision, files: [] }),
    setCandidateMaterials({ ...input, revision: saved.revision, files: [selection('runtime/resumes/two.txt')] })
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1);
  assert.equal((await readdir(path.join(root, '_shared'))).some(name => name.endsWith('.tmp')), false);
  assert.equal((await readdir(path.join(root, 'runtime/recruit-board/materials'))).some(name => name.endsWith('.lock')), false);
});

test('保存拒绝绝对路径、协议、越界、非资料目录、伪类型和不存在的文件且不改映射', async t => {
  const root = await fixture(t);
  const { listCandidateMaterials, setCandidateMaterials } = await api();
  const before = await listCandidateMaterials(root, candidateId);
  await writeFile(path.join(root, 'runtime/resumes/fake.png'), '不是图片');
  const paths = [path.join(root, 'CONTEXT.md'), 'file:///C:/private.pdf', 'https://example.com/a.pdf', '../outside.pdf', '03-interview/../CONTEXT.md', 'CONTEXT.md', 'runtime/resumes/fake.png', 'runtime/resumes/missing.txt'];
  for (const file of paths) await assert.rejects(setCandidateMaterials({ workspace: root, candidateId, revision: before.revision, files: [selection(file)] }));
  await assert.rejects(setCandidateMaterials({ workspace: root, candidateId, revision: before.revision, files: [{ path: '03-interview/a.md', category: 'invented' }] }));
  await assert.rejects(readFile(path.join(root, mappingPath)), error => error.code === 'ENOENT');
});

test('候选已有明确关联的其他工作区路径可保留，但不能新增任意目录文件', async t => {
  const known = 'runtime/artifacts/boss-cli/resumes/known.txt';
  const root = await fixture(t, [row('合成甲', '合成岗位', known)]);
  await mkdir(path.join(root, 'runtime/artifacts/boss-cli/resumes'), { recursive: true });
  await writeFile(path.join(root, known), '已知台账引用');
  await writeFile(path.join(root, 'runtime/artifacts/boss-cli/resumes/other.txt'), '同目录未关联文件');
  const { listCandidateMaterials, setCandidateMaterials } = await api();
  const before = await listCandidateMaterials(root, candidateId);
  assert.deepEqual(before.files.map(file => file.path), [known]);
  assert.ok(before.options.every(file => !file.path.startsWith('runtime/artifacts/')));
  const saved = await setCandidateMaterials({ workspace: root, candidateId, revision: before.revision, files: [selection(known)] });
  assert.equal(saved.files[0].path, known);
  assert.equal(saved.files[0].status, 'ok');
  await assert.rejects(setCandidateMaterials({ workspace: root, candidateId, revision: saved.revision, files: [selection('runtime/artifacts/boss-cli/resumes/other.txt')] }), error => error.status === 403);
  const again = await setCandidateMaterials({ workspace: root, candidateId, revision: saved.revision, files: [selection(known)] });
  assert.equal(again.changed, false);
});

test('资料目录、配置或控制目录的外部链接不能用于列出或写入', async t => {
  const { listCandidateMaterials, setCandidateMaterials } = await api();
  for (const target of ['03-interview', '_shared', 'runtime/recruit-board']) {
    const root = await fixture(t);
    const outside = await mkdtemp(path.join(tmpdir(), 'recruit-materials-link-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(root, 'runtime/resumes/safe.txt'), '合成材料');
    const initial = await listCandidateMaterials(root, candidateId);
    await rm(path.join(root, target), { force: true, recursive: true });
    await symlink(outside, path.join(root, target), process.platform === 'win32' ? 'junction' : 'dir');
    if (target === '03-interview') {
      const options = await listCandidateMaterials(root, candidateId);
      assert.ok(options.options.every(file => !file.path.startsWith('03-interview/')));
      await assert.rejects(setCandidateMaterials({ workspace: root, candidateId, revision: initial.revision, files: [selection('03-interview/outside.txt')] }));
    } else {
      await assert.rejects(setCandidateMaterials({ workspace: root, candidateId, revision: initial.revision, files: [selection('runtime/resumes/safe.txt')] }));
    }
    assert.deepEqual(await readdir(outside), []);
  }
});

test('资料读取接受本机绝对路径，外区和Windows盘符路径保持隔离', async t => {
  const root = await fixture(t, [row('合成甲', '合成岗位', path.join('runtime', 'resumes', 'original.txt'))]);
  const file = path.join(root, 'runtime/resumes/original.txt');
  await writeFile(file, '本机简历原件');
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), `${LEDGER_COLUMNS.join(',')}\n${row('合成甲', '合成岗位', file)}\n`);
  const detail = await readCandidateDetail(root, candidateId);
  assert.equal(detail.documents[0].status, 'ok');
  assert.equal((await readCandidateDocument(root, candidateId, detail.documents[0].id)).text, '本机简历原件');
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), `${LEDGER_COLUMNS.join(',')}\n${row('合成甲', '合成岗位', 'Z:/outside/resume.txt')}\n`);
  assert.equal((await readCandidateDetail(root, candidateId)).documents[0].status, 'blocked');
});

test('本地外部导入保留原件、hash、来源和相对路径，重复或同内容异名不重复归档', async t => {
  const root = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'recruit-materials-import-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sourcePath = path.join(outside, '合成截图.png');
  await writeFile(sourcePath, png);
  await writeFile(path.join(outside, '另一个名字.png'), png);
  const { importCandidateMaterial } = await api();
  const first = await importCandidateMaterial({ workspace: root, candidateId, sourcePath, category: 'resume' });
  assert.equal(first.changed, true);
  assert.equal(first.sha256, sha256(png));
  assert.match(first.path, /^runtime\/resumes\/local\/[^/]+--[a-f0-9]{12}\.png$/);
  assert.deepEqual(await readFile(sourcePath), png);
  assert.deepEqual(await readFile(path.join(root, first.path)), png);
  const second = await importCandidateMaterial({ workspace: root, candidateId, sourcePath, category: 'resume' });
  const third = await importCandidateMaterial({ workspace: root, candidateId, sourcePath: path.join(outside, '另一个名字.png'), category: 'resume' });
  assert.equal(second.path, first.path);
  assert.equal(third.path, first.path);
  assert.equal(second.changed, false);
  assert.equal(third.changed, false);
  assert.equal((await readdir(path.join(root, 'runtime/resumes/local'))).length, 1);
  const mapping = JSON.parse(await readFile(path.join(root, mappingPath), 'utf8'));
  const [file] = mapping.candidates[candidateId].files;
  assert.equal(file.sha256, sha256(png));
  assert.equal(file.source.type, 'local');
  assert.equal(file.source.path, await import('node:fs/promises').then(fs => fs.realpath(sourcePath)));
  assert.ok(Number.isFinite(Date.parse(file.source.importedAt)));
  assert.equal(JSON.stringify(mapping).includes('message_id'), false);
  const detail = await readCandidateDetail(root, candidateId);
  assert.equal(detail.documents[0].status, 'ok');
  assert.equal(JSON.stringify(detail).includes(outside), false);
  await writeFile(path.join(root, first.path), Buffer.concat([png, Buffer.from('changed')]));
  assert.equal((await readCandidateDetail(root, candidateId)).documents[0].status, 'blocked');
});

test('外部台账引用归档后先返回可用原件，旧引用不遮盖已获取的简历', async t => {
  const outside = await mkdtemp(path.join(tmpdir(), 'recruit-materials-available-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sourcePath = path.join(outside, 'known.png');
  await writeFile(sourcePath, png);
  const root = await fixture(t, [row('合成甲', '合成岗位', sourcePath)]);
  const { importCandidateMaterial } = await api();
  await importCandidateMaterial({ workspace: root, candidateId, sourcePath });
  const detail = await readCandidateDetail(root, candidateId);
  assert.equal(detail.documents[0].status, 'ok');
  assert.ok(detail.documents.some(file => file.status === 'blocked'));
  assert.equal(detail.warnings.some(value => /原始简历.*(?:未获取|不可用)/.test(value)), false);
});

test('跨候选复用同内容归档仍记录本次来源，保留原有显式资料的类别与文件', async t => {
  const root = await fixture(t, [row(), row('合成甲', '另一岗位')]);
  const outside = await mkdtemp(path.join(tmpdir(), 'recruit-materials-provenance-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const firstSource = path.join(outside, 'source-one.png'), secondSource = path.join(outside, 'source-two.png');
  await writeFile(firstSource, png);
  await writeFile(secondSource, png);
  await writeFile(path.join(root, '03-interview/confirmed.md'), '# 确认过的档案');
  const { importCandidateMaterial, listCandidateMaterials, setCandidateMaterials } = await api();
  const state = await listCandidateMaterials(root, otherId);
  await setCandidateMaterials({ workspace: root, candidateId: otherId, revision: state.revision, files: [selection('03-interview/confirmed.md', 'archive')] });
  const first = await importCandidateMaterial({ workspace: root, candidateId, sourcePath: firstSource });
  const second = await importCandidateMaterial({ workspace: root, candidateId: otherId, sourcePath: secondSource });
  assert.equal(first.path, second.path);
  assert.equal(second.reused, true);
  const mapping = JSON.parse(await readFile(path.join(root, mappingPath), 'utf8'));
  assert.equal(mapping.candidates[otherId].confirmed, true);
  const files = mapping.candidates[otherId].files;
  assert.deepEqual(files.map(file => file.category), ['archive', 'resume']);
  assert.equal(files[1].source.path, secondSource);
  const detail = await readCandidateDetail(root, otherId);
  assert.deepEqual(detail.documents.map(file => file.category), ['archive', 'resume']);
  assert.equal(detail.warnings.some(value => /未获取|核对|空路径/.test(value)), false);
});

test('外部导入拒绝未知候选、相对来源、外链和伪原件，且不触碰源文件', async t => {
  const root = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'recruit-materials-invalid-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sourcePath = path.join(outside, 'fake.pdf');
  await writeFile(sourcePath, 'MZ fake PDF');
  const { importCandidateMaterial } = await api();
  for (const input of [
    { candidateId: JSON.stringify(['不存在', '合成岗位']), sourcePath },
    { candidateId, sourcePath: 'relative.pdf' },
    { candidateId, sourcePath: 'https://example.com/a.pdf' },
    { candidateId, sourcePath }
  ]) await assert.rejects(importCandidateMaterial({ workspace: root, ...input }));
  assert.equal(await readFile(sourcePath, 'utf8'), 'MZ fake PDF');
  await assert.rejects(readFile(path.join(root, mappingPath)), error => error.code === 'ENOENT');
});
