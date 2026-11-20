import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = path.resolve(process.env.FORMAL_SOURCE_ROOT || repoRoot);
const fromSource = relative => import(pathToFileURL(path.join(sourceRoot, relative)).href);
const [{ LEDGER_COLUMNS }, { readCandidateDetail, readCandidateDocument }, { listCandidateMaterials, setCandidateMaterials, importCandidateMaterial }] = await Promise.all([
  fromSource('skills/recruit-board/model.mjs'),
  fromSource('skills/recruit-board/scripts/records.mjs'),
  fromSource('skills/recruit-board/scripts/materials.mjs'),
]);
const firstId = JSON.stringify(['虚构同名', '虚构甲岗']);
const secondId = JSON.stringify(['虚构同名', '虚构乙岗']);
const manifest = '_shared/recruit-board.files.json';
const firstPath = 'runtime/resumes/first.txt';
const secondPath = 'runtime/resumes/second.txt';
const archivePath = '03-interview/虚构同名.md';
const row = role => ['1', '虚构同名', role, '虚构背景', 'A', '面试中', '虚构来源', '', ''].join(',');
const ledger = roles => `${LEDGER_COLUMNS.join(',')}\n${roles.map(row).join('\n')}\n`;
const selection = file => ({ path: file, category: 'resume' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function withWorkspace(operation) {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'recruit-formal-materials-'));
  const workspace = path.join(sandbox, 'workspace');
  const incoming = path.join(sandbox, 'incoming');
  try {
    for (const folder of ['02-sourcing', '_shared', '03-interview', 'runtime/resumes']) await mkdir(path.join(workspace, folder), { recursive: true });
    await mkdir(incoming);
    await writeFile(path.join(workspace, 'CONTEXT.md'), '# 虚构验证工作区\n## 在招岗位与优先级\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| 虚构甲岗 | P0 | 在招 |\n| 虚构乙岗 | P1 | 在招 |\n');
    await writeFile(path.join(workspace, '02-sourcing/dedup-ledger.csv'), ledger(['虚构甲岗', '虚构乙岗']));
    await writeFile(path.join(workspace, firstPath), '虚构甲的简历文本\n');
    await writeFile(path.join(workspace, secondPath), '虚构乙的简历文本\n');
    await writeFile(path.join(workspace, archivePath), '# 面试档案 — 虚构同名\n- 姓名：虚构同名\n- 应聘岗位：虚构甲岗\n');
    const sourcePath = path.join(incoming, 'synthetic-original.txt');
    await writeFile(sourcePath, '仅用于形式化合同的虚构导入文本\n');
    return await operation(workspace, sourcePath);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

test('旧版保存请求不能覆盖新清单，候选资料和文档标识按原人岗隔离', async () => {
  await withWorkspace(async workspace => {
    const initial = await listCandidateMaterials(workspace, firstId);
    const saved = await setCandidateMaterials({ workspace, candidateId: firstId, revision: initial.revision, files: [selection(firstPath)] });
    const before = await readFile(path.join(workspace, manifest));
    await assert.rejects(
      setCandidateMaterials({ workspace, candidateId: firstId, revision: initial.revision, files: [selection(secondPath)] }),
      error => error.code === 'MATERIALS_CONFLICT' && error.status === 409,
      'MATERIALS_STALE_SET_REJECTED',
    );
    assert.deepEqual(await readFile(path.join(workspace, manifest)), before, 'MATERIALS_STALE_SET_PRESERVES_NEW_MAPPING');
    const other = await setCandidateMaterials({ workspace, candidateId: secondId, revision: saved.revision, files: [selection(secondPath)] });
    assert.equal(other.changed, true);
    const first = await readCandidateDetail(workspace, firstId);
    const second = await readCandidateDetail(workspace, secondId);
    assert.deepEqual(first.documents.map(file => file.path), [firstPath], 'MATERIALS_CANDIDATE_MAPPING_ISOLATED');
    assert.deepEqual(second.documents.map(file => file.path), [secondPath], 'MATERIALS_CANDIDATE_MAPPING_ISOLATED');
    assert.equal((await readCandidateDocument(workspace, firstId, first.documents[0].id)).text, '虚构甲的简历文本\n');
    await assert.rejects(readCandidateDocument(workspace, secondId, first.documents[0].id), error => error.code === 'DOCUMENT_NOT_FOUND', 'MATERIALS_DOCUMENT_ID_ISOLATED');
  });
});

test('旧版导入请求不能在新清单上复活资料，成功归档可读且内容改变后阻断', async () => {
  await withWorkspace(async (workspace, sourcePath) => {
    const initial = await listCandidateMaterials(workspace, firstId);
    const saved = await setCandidateMaterials({ workspace, candidateId: firstId, revision: initial.revision, files: [selection(firstPath)] });
    const cleared = await setCandidateMaterials({ workspace, candidateId: firstId, revision: saved.revision, files: [] });
    const before = await readFile(path.join(workspace, manifest));
    await assert.rejects(
      importCandidateMaterial({ workspace, candidateId: firstId, sourcePath, revision: saved.revision }),
      error => error.code === 'MATERIALS_CONFLICT' && error.status === 409,
      'MATERIALS_STALE_IMPORT_REJECTED',
    );
    assert.deepEqual(await readFile(path.join(workspace, manifest)), before, 'MATERIALS_STALE_IMPORT_PRESERVES_NEW_MAPPING');
    const sourceBytes = await readFile(sourcePath);
    const imported = await importCandidateMaterial({ workspace, candidateId: secondId, sourcePath, revision: cleared.revision });
    assert.equal(imported.sha256, digest(sourceBytes), 'MATERIALS_IMPORTED_CONTENT_VERIFIED');
    assert.deepEqual(await readFile(sourcePath), sourceBytes, 'MATERIALS_IMPORT_PRESERVES_SOURCE');
    assert.deepEqual(await readFile(path.join(workspace, imported.path)), sourceBytes, 'MATERIALS_IMPORTED_CONTENT_VERIFIED');
    assert.deepEqual((await readCandidateDetail(workspace, firstId)).documents, [], 'MATERIALS_CANDIDATE_MAPPING_ISOLATED');
    const detail = await readCandidateDetail(workspace, secondId);
    const document = detail.documents.find(file => file.path === imported.path);
    assert.equal(document.status, 'ok', 'MATERIALS_IMPORTED_CONTENT_VERIFIED');
    assert.deepEqual((await readCandidateDocument(workspace, secondId, document.id)).bytes, sourceBytes, 'MATERIALS_IMPORTED_CONTENT_VERIFIED');
    await writeFile(path.join(workspace, imported.path), Buffer.concat([sourceBytes, Buffer.from('虚构篡改\n')]));
    const tampered = (await readCandidateDetail(workspace, secondId)).documents.find(file => file.path === imported.path);
    assert.equal(tampered.status, 'blocked', 'MATERIALS_TAMPERED_ARCHIVE_BLOCKED');
    await assert.rejects(readCandidateDocument(workspace, secondId, document.id), error => error.code === 'DOCUMENT_UNAVAILABLE' && error.status === 403, 'MATERIALS_TAMPERED_ARCHIVE_BLOCKED');
  });
});

test('同名跨原岗未确认时不自动串档，用户确认清空后不恢复隐式档案', async () => {
  await withWorkspace(async workspace => {
    for (const id of [firstId, secondId]) assert.deepEqual((await readCandidateDetail(workspace, id)).documents, [], 'MATERIALS_AMBIGUOUS_IDENTITY_ISOLATED');
    const initial = await listCandidateMaterials(workspace, firstId);
    const confirmed = await setCandidateMaterials({ workspace, candidateId: firstId, revision: initial.revision, files: [{ path: archivePath, category: 'archive' }] });
    assert.deepEqual((await readCandidateDetail(workspace, firstId)).documents.map(file => file.path), [archivePath]);
    assert.deepEqual((await readCandidateDetail(workspace, secondId)).documents, [], 'MATERIALS_AMBIGUOUS_IDENTITY_ISOLATED');
    await setCandidateMaterials({ workspace, candidateId: firstId, revision: confirmed.revision, files: [] });
    await writeFile(path.join(workspace, '02-sourcing/dedup-ledger.csv'), ledger(['虚构甲岗']));
    assert.deepEqual((await readCandidateDetail(workspace, firstId)).documents, [], 'MATERIALS_CONFIRMED_EMPTY_STAYS_EMPTY');
    assert.equal((await listCandidateMaterials(workspace, firstId)).confirmed, true, 'MATERIALS_CONFIRMED_EMPTY_STAYS_EMPTY');
  });
});

test('同版保存和导入争用同一清单写锁，最多一个请求提交', async () => {
  await withWorkspace(async (workspace, sourcePath) => {
    const initial = await listCandidateMaterials(workspace, firstId);
    const results = await Promise.allSettled([
      setCandidateMaterials({ workspace, candidateId: firstId, revision: initial.revision, files: [selection(firstPath)] }),
      importCandidateMaterial({ workspace, candidateId: secondId, sourcePath, revision: initial.revision }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'MATERIALS_ONE_SAME_VERSION_WINNER');
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1, 'MATERIALS_ONE_SAME_VERSION_WINNER');
    const mapped = JSON.parse(await readFile(path.join(workspace, manifest), 'utf8'));
    assert.deepEqual(Object.keys(mapped.candidates), [results[0].status === 'fulfilled' ? firstId : secondId], 'MATERIALS_ONE_SAME_VERSION_WINNER');
  });
});
