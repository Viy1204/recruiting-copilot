import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectDocument } from '../skills/recruit-board/scripts/records.mjs';

function officeZip() {
  const names = ['word\\theme/', 'word/document.xml', '[Content_Types].xml'];
  const entries = [], directory = [];
  let offset = 0;
  for (const value of names) {
    const name = Buffer.from(value), localName = Buffer.from(value === 'word/theme/' ? 'word\\theme/' : value), body = Buffer.from(value.endsWith('/') ? '' : '<xml/>');
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(localName.length, 26);
    entries.push(header, localName, body);
    const item = Buffer.alloc(46); item.writeUInt32LE(0x02014b50); item.writeUInt16LE(20, 4); item.writeUInt16LE(20, 6); item.writeUInt32LE(body.length, 20); item.writeUInt32LE(body.length, 24); item.writeUInt16LE(name.length, 28); item.writeUInt32LE(offset, 42);
    directory.push(item, name); offset += header.length + localName.length + body.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, central, end]);
}

test('办公软件生成的DOCX目录条目使用反斜杠时仍可下载，实际文件名不放宽', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'docx-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'runtime'));
  await writeFile(path.join(root, 'runtime/resume.docx'), officeZip());
  const file = await inspectDocument(root, { path: 'runtime/resume.docx', base: root });
  assert.equal(file.status, 'ok', file.message);
  assert.equal(file.kind, 'docx');
});
