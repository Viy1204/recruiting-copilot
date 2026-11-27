import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { linkDir, tryLinkFile } from './helpers/symlink.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  decodeTextWithMeta,
  ensureSafeDirectory,
  inspectRelativePath,
  readSafeWorkspaceFile,
  readWorkspaceInputJSON,
  withWorkspaceLock,
  WORKSPACE_LOCK_FILES,
  writeAtomicFile
} from '../skills/recruit-board/scripts/workspace-io.mjs';

async function makeTempDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('inspectRelativePath 与 readSafeWorkspaceFile 在父目录为符号链接且子文件缺失时返回 unsafe 而非 missing', async t => {
  const root = await makeTempDir(t, 'rc-wsio-root-');
  const outside = await makeTempDir(t, 'rc-wsio-out-');
  await linkDir(outside, path.join(root, '_shared'));

  const inspected = await inspectRelativePath(root, '_shared/listings.json');
  assert.equal(inspected.status, 'unsafe');
  assert.equal(inspected.code, 'SYMLINK_ESCAPE');

  const read = await readSafeWorkspaceFile(root, '_shared/listings.json');
  assert.equal(read.status, 'unsafe');
  assert.equal(read.code, 'SYMLINK_ESCAPE');

  const root2 = await makeTempDir(t, 'rc-wsio-internal-');
  await mkdir(path.join(root2, 'real-dir'));
  await writeFile(path.join(root2, 'real-dir/listings.json'), '{"ok":true}', 'utf8');
  await linkDir(path.join(root2, 'real-dir'), path.join(root2, '_shared'));

  const internalLink = await readSafeWorkspaceFile(root2, '_shared/listings.json');
  assert.equal(internalLink.status, 'unsafe');
  assert.equal(internalLink.code, 'SYMLINK_ESCAPE');

  const root3 = await makeTempDir(t, 'rc-wsio-filelink-');
  await mkdir(path.join(root3, '_shared'));
  await writeFile(path.join(outside, 'escape.json'), '{"bad":true}', 'utf8');
  if (await tryLinkFile(t, path.join(outside, 'escape.json'), path.join(root3, '_shared/listings.json'))) {
    const fileLink = await readSafeWorkspaceFile(root3, '_shared/listings.json');
    assert.equal(fileLink.status, 'unsafe');
    assert.equal(fileLink.code, 'SYMLINK_ESCAPE');
  }
});

test('readWorkspaceInputJSON 按工作区 root 解析相对路径、去 UTF-8 BOM、预检大小并拒绝目录和符号链接', async t => {
  const root = await makeTempDir(t, 'rc-wsio-input-');
  const outside = await makeTempDir(t, 'rc-wsio-input-out-');
  await mkdir(path.join(root, 'tmp'), { recursive: true });

  const bomPayload = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify({ platform: 'boss', roleId: 'UE-TA' }), 'utf8')
  ]);
  await writeFile(path.join(root, 'tmp/input.json'), bomPayload);

  const parsed = await readWorkspaceInputJSON(root, 'tmp/input.json');
  assert.deepEqual(parsed, { platform: 'boss', roleId: 'UE-TA' });

  await writeFile(path.join(root, 'tmp/big.json'), JSON.stringify({ pad: 'x'.repeat(256) }), 'utf8');
  await assert.rejects(
    readWorkspaceInputJSON(root, 'tmp/big.json', { maxBytes: 64 }),
    error => error.code === 'INPUT_FILE_INVALID' && error.status === 422
  );

  await assert.rejects(
    readWorkspaceInputJSON(root, 'tmp'),
    error => error.code === 'INPUT_FILE_INVALID' && error.status === 422
  );

  await writeFile(path.join(outside, 'escape.json'), '{"a":1}', 'utf8');
  await assert.rejects(
    readWorkspaceInputJSON(root, path.join(outside, 'escape.json')),
    error => error.code === 'INPUT_FILE_INVALID' && error.status === 400
  );

  await linkDir(outside, path.join(root, 'linked'));
  await assert.rejects(
    readWorkspaceInputJSON(root, 'linked/escape.json'),
    error => error.code === 'INPUT_FILE_INVALID' && error.status === 403
  );
});

test('decodeTextWithMeta 无损保留 UTF-8 BOM 与 UTF-16LE/BE 编码', () => {
  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好\r\n', 'utf8')]);
  const d8 = decodeTextWithMeta(utf8Bom);
  assert.equal(d8.text, '你好\r\n');
  assert.deepEqual(d8.encode('世界\r\n'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('世界\r\n', 'utf8')]));

  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('测试', 'utf16le')]);
  const d16 = decodeTextWithMeta(utf16le);
  assert.equal(d16.text, '测试');
  assert.deepEqual(d16.encode('更新'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('更新', 'utf16le')]));
});

test('writeAtomicFile 在 sync 后、rename 前执行 beforeRename 复验并在失败时清理临时文件', async t => {
  const root = await makeTempDir(t, 'rc-wsio-atomic-');
  const target = path.join(root, 'state.json');
  await writeFile(target, '{"rev":1}\n', 'utf8');

  await assert.rejects(
    writeAtomicFile(target, '{"rev":2}\n', {
      beforeRename: async () => {
        throw Object.assign(new Error('conflict'), { code: 'CONFLICT', status: 409 });
      }
    }),
    error => error.code === 'CONFLICT'
  );

  assert.equal(await readFile(target, 'utf8'), '{"rev":1}\n');
  assert.deepEqual(await readdir(root), ['state.json']);

  await writeAtomicFile(target, '{"rev":2}\n');
  assert.equal(await readFile(target, 'utf8'), '{"rev":2}\n');
});

test('withWorkspaceLock 与 ensureSafeDirectory 共享标准锁名并拒绝并发占用', async t => {
  const root = await makeTempDir(t, 'rc-wsio-lock-');
  const dir = await ensureSafeDirectory(root, ['_shared'], { create: false });
  assert.equal(dir, null);

  await withWorkspaceLock(root, WORKSPACE_LOCK_FILES.context, async () => {
    await assert.rejects(
      withWorkspaceLock(root, WORKSPACE_LOCK_FILES.context, async () => {}, { lockedCode: 'ROLE_LOCKED' }),
      error => error.code === 'ROLE_LOCKED' && error.status === 409
    );
  });

  const lockFiles = await readdir(path.join(root, 'runtime/recruit-board/roles'));
  assert.equal(lockFiles.includes('context.lock'), false);
});
