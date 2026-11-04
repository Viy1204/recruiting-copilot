import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [workspaceArgument, mode = 'check'] = process.argv.slice(2);
if (!workspaceArgument || !['check', 'apply'].includes(mode)) throw new Error('用法：deploy-local-board.mjs <已确认招聘工作区绝对路径> [check|apply]');
const workspace = await realpath(workspaceArgument);
const source = fileURLToPath(new URL('../', import.meta.url));
if (workspace === await realpath(source)) throw new Error('部署目标不能是源码仓库');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const missing = async file => { try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const roots = ['skills', '.claude/skills', '.agents/skills', '.qoder/skills'];
const changes = [];
const add = async (relative, bytes) => {
  const target = path.join(workspace, relative);
  const info = await missing(target);
  if (info?.isSymbolicLink() || info && !info.isFile()) throw new Error(`目标不是普通文件：${relative}`);
  const old = info ? await readFile(target) : null;
  if (old?.equals(bytes)) return;
  changes.push({ relative, old, bytes, before: old ? hash(old) : null, after: hash(bytes) });
};
const boardSource = path.join(source, 'skills/recruit-board');
const boardFiles = [];
async function listFiles(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`源码不应包含符号链接：${child}`);
    if (entry.isDirectory()) await listFiles(path.join(directory, entry.name), child);
    else if (entry.isFile()) boardFiles.push(child);
  }
}
await listFiles(boardSource);
for (const root of roots) {
  const rootInfo = await missing(path.join(workspace, root));
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`本次部署只更新已核对的独立目录：${root}`);
  for (const relative of boardFiles) {
    await add(path.join(root, 'recruit-board', relative), await readFile(path.join(boardSource, relative)));
  }
}
const workflows = ['recruit-init', 'recruit-grill', 'recruit-daily', 'resume-review', 'interview-schedule', 'market-talent-mapping'];
for (const workflow of workflows) {
  const incoming = await readFile(path.join(source, 'skills', workflow, 'SKILL.md'), 'utf8');
  const marker = incoming.indexOf('网页开工（默认）：');
  if (marker < 0) throw new Error(`源码缺少网页开工约定：${workflow}`);
  const tail = incoming.slice(marker).split(/\r?\n/);
  const paragraphs = [tail[0]];
  if (['recruit-daily', 'resume-review', 'interview-schedule', 'market-talent-mapping'].includes(workflow)) {
    const result = tail.find(line => /^在 (?:unread|evaluate|calendar)/.test(line) || /^仅为 deep-dive/.test(line) || /^在 deep-dive/.test(line));
    if (result) paragraphs.push(result);
  }
  for (const root of roots) {
    const relative = path.join(root, workflow, 'SKILL.md');
    const existing = await readFile(path.join(workspace, relative), 'utf8');
    const newline = existing.includes('\r\n') ? '\r\n' : '\n';
    const entry = existing.indexOf(`${newline}## `);
    if (entry < 0) throw new Error(`未找到安全插入位置：${relative}`);
    const oldHead = existing.slice(0, entry);
    const body = existing.slice(entry);
    const qualification = workflow === 'recruit-daily' || workflow === 'market-talent-mapping' ? '本工作区操作平台前仍先按根目录 AGENTS.md 和本地定时 reference 取得共用锁、核对执行资格；只有实际开工后才 start。定时轮次继续读取根目录 `_shared/recruit-board-progress.md`，不因看板扩大业务授权或绕过预算。' : '';
    const head = oldHead.split(/\r?\n/).filter(line => line !== qualification && !/^(?:进度记录（可选）：|网页开工（默认）：|启用后，|在 (?:unread|evaluate|calendar)|仅为 deep-dive)/.test(line)).join(newline).trimEnd();
    const additions = [...paragraphs, ...(qualification ? [qualification] : [])];
    const rebuilt = `${head}${newline}${newline}${additions.join(`${newline}${newline}`)}${newline}${body}`;
    await add(relative, Buffer.from(rebuilt));
  }
}
for (const root of roots) {
  const relative = path.join(root, 'ask-viy/SKILL.md');
  const existing = await readFile(path.join(workspace, relative), 'utf8');
  const newline = existing.includes('\r\n') ? '\r\n' : '\n';
  const note = '看板统一入口：所有 Agent 按 `../recruit-board/references/hosts.md` 打开或复用同一网页并记录本轮；查看任务动态、候选阶段、资料或待确认事项走 `../recruit-board/SKILL.md`。原生入口已退役，已安装副本的停用与升级见宿主指引；此同步不自动卸载。';
  const oldNote = '看板统一入口：招聘执行开工默认按 `../recruit-board/references/hosts.md` 打开或复用网页并记录本轮；查看任务动态、候选阶段、资料或待确认事项走 `../recruit-board/SKILL.md`。Claude 原生面板为可选手动入口，不自动打开两份界面。';
  if (existing.includes(oldNote)) await add(relative, Buffer.from(existing.replace(oldNote, note)));
  else if (!existing.includes(note)) await add(relative, Buffer.from(existing.replace(/(\r?\n)(## )/, `${newline}${note}${newline}${newline}$2`)));
}
const agentsRelative = 'AGENTS.md';
let agents = await readFile(path.join(workspace, agentsRelative), 'utf8');
const agentsOld = '| 招聘看板 / 各阶段人数 / 候选资料 | `skills/recruit-board/SKILL.md` | Claude 原生面板用 `/recruiting-board`；Codex / WorkBuddy 使用本机网页 |';
const agentsPrevious = '| 招聘看板 / 任务动态 / 各阶段人数 / 候选资料 | `skills/recruit-board/SKILL.md` | 三端默认统一网页，开工按 `skills/recruit-board/references/hosts.md` 接入；Claude 原生面板手动可选 |';
const agentsNew = '| 招聘看板 / 任务动态 / 各阶段人数 / 候选资料 | `skills/recruit-board/SKILL.md` | 所有 Agent 共用网页，开工按 `skills/recruit-board/references/hosts.md` 接入；原生停用与升级见同一指引 |';
if (agents.includes(agentsOld)) agents = agents.replace(agentsOld, agentsNew);
else if (agents.includes(agentsPrevious)) agents = agents.replace(agentsPrevious, agentsNew);
else if (!agents.includes(agentsNew)) throw new Error('AGENTS看板路由与已核对结构不符，拒绝替换');
await add(agentsRelative, Buffer.from(agents));
const localProgressRelative = '_shared/recruit-board-progress.md';
let localProgress = await readFile(path.join(workspace, localProgressRelative), 'utf8');
localProgress = localProgress.replace('不为每个候选人反复记录九步，避免加重轮次。', '不为每个候选人反复记录九步；逐人处理结论另按下方result收据及时记录。');
const localMarker = '\n## 新版网页与逐人结果\n';
if (!localProgress.includes(localMarker)) localProgress += `${localMarker}\n取得本轮共用锁并确认可执行后，先按实际阶段start和step，再按本工作区 \`skills/recruit-board/references/hosts.md\` 探测并打开或复用网页。默认实时跟随首页，明确本轮链接保持run固定；保留connect返回的完整workspace参数。页面已有历史固定或正在阅读、编辑时不强制导航。看板无法打开或记录失败时说明原因并安全继续原流程，不增加平台调用、飞书推送或购买。\n\n每处理完一位且动作、结论已核实后，按 \`skills/recruit-board/references/progress.md\` 及时记result，不等轮次结束。阶段进度仍按原约定，不为每人重复九步。原姓名与原应聘岗位决定候选身份；稳定收据ID本轮复用，同内容重试不重复记人。需要拍板的先记decision和明确下一步，再wait；用户拍板后明确更新原收据，其他普通记录不能消解待确认。只写短结论，不抄联系方式、简历正文或本机路径。\n\n定时begin未获资格、已有锁、预算或状态错误时仍不创建run；轻量跳步、时段、预算、只通知新故障和释放自己的锁继续以原reference为准。旧任务没有收据只显示未记录，不从旧台账或日报倒填人选。\n`;
await add(localProgressRelative, Buffer.from(localProgress));
const launchRelative = '.claude/launch.json';
const launchOriginal = await readFile(path.join(workspace, launchRelative), 'utf8');
const launch = JSON.parse(launchOriginal);
for (const config of launch.configurations ?? []) {
  if (['recruit-board-records-live', 'recruit-board-live'].includes(config.name)) config.runtimeArgs[0] = path.join(workspace, 'skills/recruit-board/scripts/server.mjs').replaceAll('\\', '/');
}
await add(launchRelative, Buffer.from(`${JSON.stringify(launch, null, 2)}\n`));
const protectedFiles = ['CONTEXT.md', '02-sourcing/dedup-ledger.csv', '02-sourcing/candidate-pool.md', '_shared/recruit-board.config.json', '_shared/recruit-board.files.json', ...roots.flatMap(root => [path.join(root, 'recruit-daily/references/scheduled-cycle.md'), path.join(root, 'recruit-daily/scripts/cycle_guard.py')])];
const protectedHashes = {};
for (const relative of protectedFiles) if (await missing(path.join(workspace, relative))) protectedHashes[relative] = hash(await readFile(path.join(workspace, relative)));
const manifest = changes.map(({ relative, before, after }) => ({ file: relative.replaceAll('\\', '/'), before, after }));
if (mode === 'check') {
  console.log(JSON.stringify({ mode, workspace, changedFiles: changes.length, boards: roots.map(root => ({ root, files: changes.filter(item => item.relative.startsWith(path.join(root, 'recruit-board') + path.sep)).length })), documents: changes.filter(item => !item.relative.includes(`${path.sep}recruit-board${path.sep}`)).map(item => item.relative.replaceAll('\\', '/')), protectedFiles: Object.keys(protectedHashes), bytes: changes.reduce((n, item) => n + item.bytes.length, 0) }, null, 2));
} else {
  const id = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const backup = path.join(workspace, 'runtime/recruit-board/deployments', id);
  await mkdir(backup, { recursive: true });
  await writeFile(path.join(backup, 'manifest.json'), `${JSON.stringify({ id, createdAt: new Date().toISOString(), source, files: manifest, protectedBefore: protectedHashes }, null, 2)}\n`);
  for (const item of changes) if (item.old) {
    const target = path.join(backup, 'previous', item.relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, item.old, { flag: 'wx' });
  }
  for (const item of changes) {
    const target = path.join(workspace, item.relative);
    const current = await missing(target);
    const digest = current ? hash(await readFile(target)) : null;
    if (digest !== item.before) throw new Error(`文件在备份后变化，停止部署：${item.relative}`);
  }
  for (const item of changes) {
    const target = path.join(workspace, item.relative);
    const current = await missing(target);
    if ((current ? hash(await readFile(target)) : null) !== item.before) throw new Error(`写入前文件已变化，停止部署：${item.relative}`);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), `.deploy-${randomUUID()}.tmp`);
    try { await writeFile(temporary, item.bytes, { flag: 'wx' }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
    if (hash(await readFile(target)) !== item.after) throw new Error(`写入校验失败：${item.relative}`);
  }
  const protectedAfter = {};
  for (const relative of Object.keys(protectedHashes)) protectedAfter[relative] = hash(await readFile(path.join(workspace, relative)));
  const protectedUnchanged = Object.keys(protectedHashes).every(relative => protectedHashes[relative] === protectedAfter[relative]);
  await writeFile(path.join(backup, 'result.json'), `${JSON.stringify({ completedAt: new Date().toISOString(), changedFiles: changes.length, protectedAfter, protectedUnchanged }, null, 2)}\n`);
  if (!protectedUnchanged) throw new Error('部署期间业务或定制规则文件发生变化，请核对并行工作');
  console.log(JSON.stringify({ mode, backup, changedFiles: changes.length, protectedUnchanged, verifiedFiles: manifest.length }, null, 2));
}
