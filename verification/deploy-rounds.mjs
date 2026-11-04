import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [workspaceArgument, mode = 'prepare', backupArgument, owner = 'board-rounds-deploy-632c4547'] = process.argv.slice(2);
if (!workspaceArgument || !['prepare', 'prepare-ui', 'prepare-web', 'apply', 'verify', 'import', 'rollback'].includes(mode)) throw new Error('用法：deploy-rounds.mjs <workspace> prepare|prepare-ui|prepare-web|apply|verify|import|rollback [backup] [lock-owner]');
const workspace = await realpath(workspaceArgument);
const source = await realpath(fileURLToPath(new URL('../', import.meta.url)));
if (workspace === source) throw new Error('真实工作区不能是源码仓库');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async file => { try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
async function safeTarget(relative) {
  const file = path.resolve(workspace, relative);
  if (!inside(workspace, file)) throw new Error('目标路径越出工作区');
  let parent = path.dirname(file);
  while (!(await exists(parent))) parent = path.dirname(parent);
  if (!inside(workspace, await realpath(parent))) throw new Error(`目标父目录链接到工作区外：${relative}`);
  const info = await exists(file);
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`目标不是普通文件：${relative}`);
  return file;
}
async function requireLock() {
  const lock = JSON.parse(await readFile(path.join(workspace, 'runtime/recruit-cycle.lock/owner.json'), 'utf8'));
  if (lock.owner !== owner) throw new Error('没有本次部署持有的共用锁');
}
async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function filesUnder(directory, relative = '') {
  const result = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`不自动遍历符号链接：${child}`);
    if (entry.isDirectory()) result.push(...await filesUnder(directory, child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}
async function atomic(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.rounds-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
const roots = ['skills', '.claude/skills', '.agents/skills', '.qoder/skills'];
const workflows = ['recruit-init', 'recruit-grill', 'recruit-daily', 'resume-review', 'interview-schedule', 'market-talent-mapping'];
const businessFiles = ['CONTEXT.md', '_shared/recruit-board.config.json', '_shared/recruit-board.files.json', 'runtime/recruit-cycle-state.json'];
async function protectedHashes(includeDecisions = ['prepare-ui', 'prepare-web'].includes(mode)) {
  const files = [...businessFiles];
  for (const directory of ['01-jd', '02-sourcing', '03-interview', '04-offer', '05-onboarding']) {
    if (await exists(path.join(workspace, directory))) files.push(...(await filesUnder(path.join(workspace, directory))).map(file => path.join(directory, file)));
  }
  for (const root of roots) {
    files.push(path.join(root, 'recruit-daily/scripts/cycle_guard.py'));
    if (includeDecisions) files.push(path.join(root, 'recruit-daily/references/scheduled-cycle.md'));
  }
  for (const directory of ['runtime/recruit-board/runs', ...(includeDecisions ? ['runtime/recruit-board/decisions'] : [])]) {
    if (await exists(path.join(workspace, directory))) files.push(...(await filesUnder(path.join(workspace, directory))).map(file => path.join(directory, file)));
  }
  const result = {};
  for (const relative of files) {
    const file = await safeTarget(relative);
    if (await exists(file)) result[relative.replaceAll('\\', '/')] = await fileHash(file);
  }
  return result;
}
const localAuthority = '本工作区持续授权、时段、预算、共用锁和邮箱手动触发规则仍以根目录 AGENTS.md 与 recruit-daily/references/scheduled-cycle.md 为准。普通单轮授权不跨轮继承；已明确记录的定时持续授权在原范围内有效。看板记录不增加也不撤销业务授权。';
const updateOnce = (text, old, next, label) => {
  if (text.includes(next)) return text;
  if (!text.includes(old) || text.indexOf(old) !== text.lastIndexOf(old)) throw new Error(`目标文档结构不符合已核对内容：${label}`);
  return text.replace(old, next);
};

await requireLock();
if (['prepare', 'prepare-ui', 'prepare-web'].includes(mode)) {
  const changes = [];
  const add = async (relative, bytes) => {
    const target = await safeTarget(relative);
    const old = await exists(target) ? await readFile(target) : null;
    if (old === null && bytes === null || bytes !== null && old?.equals(bytes)) return;
    changes.push({ relative: relative.replaceAll('\\', '/'), old, bytes, before: old === null ? null : digest(old), after: bytes === null ? null : digest(bytes) });
  };
  const boardSource = path.join(source, 'skills/recruit-board');
  const uiFiles = new Set(['SKILL.md', 'public/app.js', 'public/index.html', 'public/style.css', 'types/index.d.ts']);
  const boardFiles = (await filesUnder(boardSource)).filter(file => mode !== 'prepare-ui' || uiFiles.has(file.replaceAll('\\', '/')));
  for (const root of roots) {
    const rootPath = path.join(workspace, root);
    const info = await lstat(rootPath);
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(workspace, await realpath(rootPath))) throw new Error(`本次只更新已核对的工作区独立技能目录：${root}`);
    for (const relative of boardFiles) {
      const portable = relative.replaceAll('\\', '/');
      let bytes = await readFile(path.join(boardSource, relative));
      if (portable === 'references/decisions.md') {
        let text = bytes.toString('utf8');
        text = text.replace('每日招聘的“合适的直接打”本轮持续授权不会因保存事项而延续到下轮，缺有效授权重新提请确认。', '普通单轮“合适的直接打”授权不会因保存事项而延续到下轮；本工作区已有的定时持续授权按根目录 AGENTS.md 与 scheduled-cycle.md 的范围和预算执行，缺有效授权重新提请确认。');
        text = text.replace('## 开工与收尾', `${localAuthority}\n\n## 开工与收尾`);
        bytes = Buffer.from(text);
      }
      await add(path.join(root, 'recruit-board', relative), bytes);
    }
    if (mode === 'prepare-ui') continue;
    if (mode === 'prepare-web') {
      for (const file of ['hooks/register.tsx', 'hooks/hooks.json', '.claude-plugin/plugin.json', 'recruiting-board.test.ts']) await add(path.join(root, 'recruit-board', file), null);
    }
    for (const workflow of workflows) {
      const relative = path.join(root, workflow, 'SKILL.md');
      const existing = await readFile(await safeTarget(relative), 'utf8');
      const newline = existing.includes('\r\n') ? '\r\n' : '\n';
      const split = existing.indexOf(`${newline}## `);
      if (split < 0) throw new Error(`未找到工作流正文：${relative}`);
      const incoming = await readFile(path.join(source, 'skills', workflow, 'SKILL.md'), 'utf8');
      const incomingHead = incoming.split('\n## ')[0];
      const paragraphs = incomingHead.split(/\r?\n/).filter(line => /^网页开工（默认）：|^在 (?:unread|evaluate|calendar)|^仅为 deep-dive|^按 \[`跨轮事项与重点`\]|^工作区建立后按/.test(line));
      if (paragraphs.length < 2) throw new Error(`源码未提供完整联动入口：${workflow}`);
      const oldHead = existing.slice(0, split);
      const head = oldHead.split(/\r?\n/).filter(line => !/^网页开工（默认）：|^在 (?:unread|evaluate|calendar)|^仅为 deep-dive|^按 \[`跨轮事项与重点`\]|^工作区建立后按/.test(line)).join(newline).trimEnd();
      let next = `${head}${newline}${newline}${paragraphs.join(`${newline}${newline}`)}${newline}${existing.slice(split)}`;
      if (workflow === 'recruit-daily' && mode !== 'prepare-web') {
        const old = '进度显示：本工作区开工读取一次根目录 `_shared/recruit-board-progress.md`，只按实际完成判据记录步骤；该文件缺失或记录失败时说明原因并继续原流程安全收尾，不扩大对外授权。';
        const revised = '进度显示：取得原共用锁后先读取根目录 `_shared/recruit-board-progress.md` 与看板 references/decisions.md，读取现有事项和待执行，再 start（定时传 --trigger scheduled）。逐人收据关联独立事项，重要事实写 highlight，收尾在结束 run 前写 summary。只暂停依赖确认的动作；定时专属授权和预算不变。看板失败明确报告并安全收尾，不扩大对外授权。';
        next = updateOnce(next, old, revised, relative);
      }
      await add(relative, Buffer.from(next));
    }
    if (mode === 'prepare-web') {
      const relative = path.join(root, 'ask-viy/SKILL.md');
      const text = await readFile(await safeTarget(relative), 'utf8');
      await add(relative, Buffer.from(text.replace('Claude 原生面板为可选手动入口，不自动打开两份界面。', '只维护网页看板；已安装原生入口的停用与升级见宿主指引。')));
      continue;
    }
    const scheduledRelative = path.join(root, 'recruit-daily/references/scheduled-cycle.md');
    if (await exists(path.join(workspace, scheduledRelative))) {
      let text = await readFile(await safeTarget(scheduledRelative), 'utf8');
      const newline = text.includes('\r\n') ? '\r\n' : '\n';
      const old = '本轮取得原共用锁并确认可执行后，读取根目录 `_shared/recruit-board-progress.md`，按定时轻量模式记录实际步骤、等待和跳过；不补造历史轮次，不为显示进度追加平台调用或推送。看板记录失败不能阻止业务安全收尾和释放自己的锁。';
      const next = ['本轮取得原共用锁并确认可执行后，读取根目录 `_shared/recruit-board-progress.md` 与 `../../recruit-board/references/decisions.md`。先用工作区 `skills/recruit-board/scripts/actions.mjs workspace-overview` 读取未解决事项与后续执行，再 start 并传 `--trigger scheduled`，按定时轻量模式记录真实步骤。', '需要用户决定的问题登记独立事项并关联收据，复用同一对象、问题和范围；普通候选跟进不全部变成待确认。核实后的重要进展及时写 highlight，结束 run 前明确写 summary；无重要变化仅在实际检查完成后写 no_change。只有依赖该决定的动作暂停，其余原授权内工作继续。用户在聊天里回复旧事项时，更新独立事项而不重开终态 run。', '本节不改变上方持续授权、时段、共用锁、日预算和通知规则，不增加平台动作。续办先核实际结果和授权范围，不能盲重发。业务 guard 的 finish(status/unresolved) 判据仍照旧；看板 run 可在步骤完成或明确跳过后结束，未解决事项继续保留。看板失败不能阻止原业务安全收尾和释放自己的锁。'].join(`${newline}${newline}`);
      text = updateOnce(text, old, next, scheduledRelative);
      await add(scheduledRelative, Buffer.from(text));
    }
    const reportRelative = path.join(root, 'recruit-daily/references/ledger-and-report.md');
    let report = await readFile(await safeTarget(reportRelative), 'utf8');
    const incomingReport = await readFile(path.join(source, 'skills/recruit-daily/references/ledger-and-report.md'), 'utf8');
    const summaryLine = incomingReport.split(/\r?\n/).find(line => line.startsWith('6. 待办与待确认：'));
    report = updateOnce(report, '6. 待办与待确认（等用户拍板的排除名单、待授权的打招呼、CONTEXT 待定决策清单）', summaryLine, reportRelative);
    await add(reportRelative, Buffer.from(report));
  }
  if (mode === 'prepare-web') {
    const agents = await readFile(await safeTarget('AGENTS.md'), 'utf8');
    await add('AGENTS.md', Buffer.from(agents.replace('三端默认统一网页，开工按 `skills/recruit-board/references/hosts.md` 接入；Claude 原生面板手动可选', '所有 Agent 共用网页，开工按 `skills/recruit-board/references/hosts.md` 接入；不再使用原生面板')));
    const progressFile = '_shared/recruit-board-progress.md';
    const text = await readFile(await safeTarget(progressFile), 'utf8');
    const note = '新增事项和重点提供已核实的 context；人选用规范的姓名＋原岗位 candidateId，岗位或工作区事项用对应 scope。面试时间与面试官等事件细节按需写 details，更新时间不替代预约时间。旧记录只沿可靠来源补充展示，不猜测或改写历史事实。';
    if (!text.includes(note)) await add(progressFile, Buffer.from(`${text.trimEnd()}\n\n## 结构化对象与单网页\n\n${note}\n\n所有 Agent 使用同一网页入口；原生专用界面已退役。本次升级不改变持续授权、时段、锁与预算。\n`));
  }
  if (mode === 'prepare') {
    let agents = await readFile(await safeTarget('AGENTS.md'), 'utf8');
    const route = '| 招聘看板 / 任务动态 / 各阶段人数 / 候选资料 | `skills/recruit-board/SKILL.md` | 三端默认统一网页，开工按 `skills/recruit-board/references/hosts.md` 接入；Claude 原生面板手动可选 |';
    const webRoute = '| 招聘看板 / 任务动态 / 各阶段人数 / 候选资料 | `skills/recruit-board/SKILL.md` | 所有 Agent 共用网页，开工按 `skills/recruit-board/references/hosts.md` 接入；原生停用与升级见同一指引 |';
    agents = updateOnce(agents, route, webRoute, 'AGENTS网页路由');
    agents = updateOnce(agents, webRoute, `${webRoute}\n| 回答 / 暂缓 / 取消 / 修订待确认事项，查看未落实的决定 | \`skills/recruit-board/SKILL.md\` + \`skills/recruit-board/references/decisions.md\` | 不要求原轮次仍在运行；先对应对象和范围，资料同步与实际动作分开记录 |`, 'AGENTS事项路由');
    const boardNote = '2026-10-22 起，本工作区的招聘执行流程同时读取 `_shared/recruit-board-progress.md`，按实际阶段记录本轮进度。候选阶段与岗位别名配置在 `_shared/recruit-board.config.json`；它只影响看板显示，原始台账和业务授权不变。历史任务未记录的不补造；看板写入失败不阻止原流程安全收尾。看板与配置维护不属于平台招聘动作，不启动 Boss／猎聘浏览器。';
    const note = '2026-11-04 起接入跨轮事项：开工先读未解决事项及待执行动作；手动和定时使用同一记录协议并标来源，核实重点及时写入，结束前记录摘要。聊天中的决定更新独立事项，不因换轮、重启或无回复丢失。历史旧标记先进入“历史待核对”，不自动批准；根目录已有持续授权和锁／预算规则保持不变。';
    agents = updateOnce(agents, boardNote, `${boardNote}\n\n${note}`, 'AGENTS联动说明');
    agents = updateOnce(agents, '- `runtime/` = 每轮原始素材（简历/日志/当轮 brief），可删可重建。', '- `runtime/recruit-board/` 的轮次、跨轮事项与决定历史，以及 `runtime/resumes/` 的已引用简历与去重索引，都需要随台账保留和备份。其他可重建的临时日志按原规则管理；不能将整个 runtime 当缓存删除。', 'AGENTS保留规则');
    await add('AGENTS.md', Buffer.from(agents));
    const progressText = `# 本工作区招聘看板进度接入\n\n本文件只负责每轮重点与跨轮事项显示，不改变根目录 AGENTS.md 和定时 reference 的持续授权、时段、共用锁、日预算、筛选标准与通知规则。看板不执行平台动作。\n\n## 固定入口\n\n使用本工作区 \`skills/recruit-board/\`；工作区参数为当前真实根目录的绝对路径，不使用旧副本或源码仓库。记录协议见该目录 \`references/progress.md\` 和 \`references/decisions.md\`，网页启动见 \`references/hosts.md\`。缺脚本或写入失败明确说明，不伪造已记录或无变化。\n\n## 日常轮次\n\n1. 先按既有 scheduled-cycle.md / cycle_guard.py 取得共用锁和执行资格。begin 未获资格、已有锁或状态错误时不创建 run、不补跑业务。\n2. 用 \`actions.mjs workspace-overview --workspace <根目录>\` 读取未解决事项、现行决定和待执行动作；核对当前 CONTEXT 与目标岗位标准。\n3. 实际开工才 \`progress.mjs start\`，定时用 \`--trigger scheduled\`，主动用 \`--trigger manual\`；可确认会话ID时带 --session，保存返回runId并进入真实step。\n4. 探测原服务时带 \`connect.mjs --require workspace-overview,run-highlights\`，只复用匹配工作区且能力兼容的服务。首次打开live首页，主动固定历史时保持阅读位置；不每步重开窗口。\n5. 核实一人的处理结果及时写result。必须由用户决定的事项独立登记，result用 --decision 关联；岗位问题直接建事项，不伪造候选人。多轮同一问题复用身份；仅新证据才追加，不每轮复制提醒。普通跟进留在候选进展。\n6. 核实的重要变化写highlight，收尾前写summary（highlights或明确no_change）；失败、未记录和无变化分别说明。重点更正带事件revision和稳定request，保留前后依据。\n7. 只暂停依赖未决事项的动作，其他已授权工作继续。全轮无法继续时才wait。所有步骤已完成或有真实理由skip后结束看板run，独立事项仍保留。\n\n原业务guard的finish/status/unresolved规则不变；看板run完成不等于所有决定已经落实。先保证业务收尾与释放自己的共用锁，不能因看板失败留锁。轻量巡检不为凑满流程追加平台调用、完整日报、卡片或推送。\n\n## 聊天确认与历史\n\n用户回答、暂缓、取消或修订旧问题时走 \`references/decisions.md\`：读取当前版本，确认对应对象和范围，记录决定，实际更新标准／资料和动作后分别记录结果。不重开终态run，不扩大授权。普通单轮授权不跨轮；本工作区已明确的定时持续授权只在原范围和预算内有效。\n\n旧run的decision收据显式import-history，先进入历史待核对，来源原文保留。没有明确处理证据不自动归档；不从台账、旧日报补造轮次或重点。\n\n## 保留与故障\n\n\`runtime/recruit-board/\` 需保留和备份。读取失败显示未知或最后可信状态，不显示零待确认；原run已结束也可以处理关联事项。升级和导入维护不建立假业务轮次、不启动招聘平台、不发送候选消息。\n`;
    await add('_shared/recruit-board-progress.md', Buffer.from(progressText));
  }
  const protectedBefore = await protectedHashes();
  const stamp = `${new Date().toISOString().replaceAll(':', '-')}-rounds-${randomUUID().slice(0, 8)}`;
  const backup = path.join(workspace, 'runtime/recruit-board/deployments', stamp);
  await mkdir(path.dirname(backup), { recursive: true });
  if (!inside(workspace, await realpath(path.dirname(backup)))) throw new Error('部署备份目录必须位于工作区内');
  await mkdir(backup, { recursive: false });
  const manifest = { id: stamp, createdAt: new Date().toISOString(), source, workspace, owner, scope: mode === 'prepare-ui' ? 'interface-only' : mode === 'prepare-web' ? 'web-only-upgrade' : 'rounds-integration', files: changes.map(({ relative, before, after }) => ({ relative, before, after })), protectedBefore };
  await writeFile(path.join(backup, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  for (const item of changes) {
    if (item.old !== null) { const file = path.join(backup, 'previous', item.relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, item.old, { flag: 'wx' }); }
    if (item.bytes !== null) {
      const staged = path.join(backup, 'incoming', item.relative); await mkdir(path.dirname(staged), { recursive: true }); await writeFile(staged, item.bytes, { flag: 'wx' });
    }
  }
  for (const relative of Object.keys(protectedBefore).filter(file => file.startsWith('runtime/recruit-board/runs/'))) {
    const file = path.join(backup, 'records-before', relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, await readFile(path.join(workspace, relative)), { flag: 'wx' });
  }
  for (const relative of ['.claude/launch.json', 'runtime/recruit-cycle-state.json']) {
    if (await exists(path.join(workspace, relative))) { const file = path.join(backup, 'context-before', relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, await readFile(path.join(workspace, relative)), { flag: 'wx' }); }
  }
  if (await exists(path.join(workspace, 'runtime/recruit-board/decisions'))) {
    for (const relative of await filesUnder(path.join(workspace, 'runtime/recruit-board/decisions'))) { const file = path.join(backup, 'decisions-before', relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, await readFile(path.join(workspace, 'runtime/recruit-board/decisions', relative)), { flag: 'wx' }); }
  }
  await requireLock();
  for (const item of changes) {
    if (item.after !== null && digest(await readFile(path.join(backup, 'incoming', item.relative))) !== item.after) throw new Error('暂存文件校验失败');
    if (item.before !== null && digest(await readFile(path.join(backup, 'previous', item.relative))) !== item.before) throw new Error('备份文件校验失败');
  }
  console.log(JSON.stringify({ mode, backup, changedFiles: changes.length, protectedFiles: Object.keys(protectedBefore).length, bytes: changes.reduce((total, item) => total + (item.bytes?.length ?? 0), 0), targetUnchanged: true }, null, 2));
} else {
  if (!backupArgument) throw new Error('必须指定本次备份目录');
  const backup = await realpath(backupArgument);
  if (!inside(path.join(workspace, 'runtime/recruit-board/deployments'), backup)) throw new Error('备份目录不属于当前工作区');
  const manifest = JSON.parse(await readFile(path.join(backup, 'manifest.json'), 'utf8'));
  if (await realpath(manifest.workspace) !== workspace || manifest.owner !== owner) throw new Error('备份身份不匹配');
  const journalFile = path.join(backup, 'applied.json');
  const assertProtected = async () => {
    const current = await protectedHashes(manifest.scope !== 'rounds-integration');
    const changed = Object.keys(manifest.protectedBefore).filter(file => manifest.protectedBefore[file] !== current[file]);
    const added = Object.keys(current).filter(file => !Object.hasOwn(manifest.protectedBefore, file));
    if (changed.length || added.length) throw new Error(`业务文件或原轮次发生变化；停止并核对。changed=${changed.length}, added=${added.length}`);
    return Object.keys(current).length;
  };
  if (mode === 'apply') {
    await assertProtected();
    for (const item of manifest.files) {
      const target = await safeTarget(item.relative);
      const before = await exists(target) ? await fileHash(target) : null;
      if (before !== item.before) throw new Error(`备份后文件变化，停止部署：${item.relative}`);
      if (item.after !== null && await fileHash(path.join(backup, 'incoming', item.relative)) !== item.after) throw new Error(`暂存校验失败：${item.relative}`);
    }
    const applied = [];
    await writeFile(journalFile, `${JSON.stringify({ applied }, null, 2)}\n`, { flag: 'wx' });
    for (const item of manifest.files) {
      await requireLock();
      const target = await safeTarget(item.relative);
      if ((await exists(target) ? await fileHash(target) : null) !== item.before) throw new Error(`写入前目标变化：${item.relative}`);
      if (item.after === null) await rm(target);
      else await atomic(target, await readFile(path.join(backup, 'incoming', item.relative)));
      if ((await exists(target) ? await fileHash(target) : null) !== item.after) throw new Error(`写入校验失败：${item.relative}`);
      applied.push(item.relative); await atomic(journalFile, `${JSON.stringify({ applied }, null, 2)}\n`);
    }
    const protectedCount = await assertProtected();
    await atomic(path.join(backup, 'result.json'), `${JSON.stringify({ at: new Date().toISOString(), applied: applied.length, protectedCount, protectedUnchanged: true }, null, 2)}\n`);
    console.log(JSON.stringify({ mode, backup, applied: applied.length, protectedCount, protectedUnchanged: true }, null, 2));
  } else if (mode === 'import') {
    await assertProtected();
    const { importLegacyDecisions } = await import(pathToFileURL(path.join(workspace, 'skills/recruit-board/scripts/import-history.mjs')).href);
    const { initializeDecisions } = await import(pathToFileURL(path.join(workspace, 'skills/recruit-board/scripts/decisions.mjs')).href);
    await initializeDecisions(workspace);
    const imports = [];
    const files = (await readdir(path.join(workspace, 'runtime/recruit-board/runs'))).filter(file => file.endsWith('.json')).sort();
    for (const file of files) {
      await requireLock();
      const run = JSON.parse(await readFile(path.join(workspace, 'runtime/recruit-board/runs', file), 'utf8'));
      if (!(run.results ?? []).some(result => result.attention === 'decision')) continue;
      const result = await importLegacyDecisions(workspace, run.id);
      imports.push(result);
      await atomic(path.join(backup, 'history-import.json'), `${JSON.stringify({ at: new Date().toISOString(), imports }, null, 2)}\n`);
      if (result.status !== 'ok') throw new Error('历史事项引入存在无法核对的关联，详情已保存在备份目录');
    }
    const protectedCount = await assertProtected();
    console.log(JSON.stringify({ mode, backup, imported: imports.reduce((n, row) => n + row.imported.length, 0), skipped: imports.reduce((n, row) => n + row.skipped.length, 0), runs: imports.length, protectedCount, originalRunsUnchanged: true }, null, 2));
  } else if (mode === 'verify') {
    for (const item of manifest.files) {
      const target = await safeTarget(item.relative);
      if ((await exists(target) ? await fileHash(target) : null) !== item.after) throw new Error(`部署内容不一致：${item.relative}`);
    }
    const protectedCount = await assertProtected();
    console.log(JSON.stringify({ mode, matchedFiles: manifest.files.length, protectedCount, protectedUnchanged: true }, null, 2));
  } else {
    const { applied } = JSON.parse(await readFile(journalFile, 'utf8'));
    for (const relative of [...applied].reverse()) {
      const item = manifest.files.find(item => item.relative === relative);
      const target = await safeTarget(relative);
      if ((await exists(target) ? await fileHash(target) : null) !== item.after) throw new Error(`部署后目标有新变更，不自动回滚：${relative}`);
      if (item.before === null) await rm(target);
      else await atomic(target, await readFile(path.join(backup, 'previous', relative)));
    }
    await atomic(path.join(backup, 'rollback.json'), `${JSON.stringify({ at: new Date().toISOString(), restored: applied.length, note: '仅回滚部署文件；独立事项及其历史保留' }, null, 2)}\n`);
    console.log(JSON.stringify({ mode, backup, restored: applied.length }, null, 2));
  }
}
