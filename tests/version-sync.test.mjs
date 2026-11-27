/**
 * 版本号一致性：`package.json` 与 `.claude-plugin/plugin.json` 必须同号。
 *
 *   node --test tests/
 *
 * 为什么要守这条：Claude Code 按 **plugin.json 的 version** 识别已装插件，连缓存目录
 * 都用它命名（`~/.claude/plugins/cache/<market>/<plugin>/<version>/`，见
 * `installed_plugins.json`）。plugin.json 不动，用户那边的版本号就永远不变，
 * **收不到更新提示**——哪怕仓库已经发了好几版。
 *
 * 实际踩过：plugin.json 停在 0.4.2 跨过了 v0.6.0 / v0.6.1 / v0.6.2 三次发版，
 * 期间装机用户一直停在老版本。2026-09-21 补齐并加了本测试。
 *
 * 发版时两个文件一起改，别只 `npm version`。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readText = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");
const readJson = (rel) => JSON.parse(readText(rel));

test("主包、lockfile 与主插件版本号一致", () => {
  const pkg = readJson("package.json");
  const pkgLock = readJson("package-lock.json");
  const plugin = readJson(path.join(".claude-plugin", "plugin.json"));
  assert.equal(
    plugin.version,
    pkg.version,
    `plugin.json=${plugin.version} 与 package.json=${pkg.version} 不一致：` +
      "装机用户按 plugin.json 判断版本，不同步就收不到更新提示",
  );
  assert.equal(
    pkgLock.version,
    pkg.version,
    `package-lock.json version=${pkgLock.version} 与 package.json=${pkg.version} 不一致`,
  );
  assert.equal(
    pkgLock.packages?.[""]?.version,
    pkg.version,
    `package-lock.json packages[""].version=${pkgLock.packages?.[""]?.version} 与 package.json=${pkg.version} 不一致`,
  );
});

test("marketplace 只发布主插件，网页看板保留共享入口且不注册原生界面", () => {
  const plugin = readJson(path.join(".claude-plugin", "plugin.json"));
  const market = readJson(path.join(".claude-plugin", "marketplace.json"));
  assert.deepEqual(market.plugins.map((entry) => [entry.name, entry.source]), [[plugin.name, "./"]]);
  const board = path.join(repoRoot, "skills/recruit-board");
  for (const relative of [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/register.tsx", "recruiting-board.test.ts"]) {
    assert.equal(existsSync(path.join(board, relative)), false, `原生入口已退役：${relative}`);
  }
  for (const relative of ["SKILL.md", "model.mjs", "types/index.d.ts", "public/index.html", "scripts/connect.mjs", "scripts/server.mjs", "scripts/actions.mjs", "scripts/progress.mjs", "scripts/decisions.mjs"]) {
    assert.equal(existsSync(path.join(board, relative)), true, `网页及共享能力必须保留：${relative}`);
  }
});

test("skills 与各 Agent 软链目录及 commands 入口保持一致", () => {
  const skills = readdirSync(path.join(repoRoot, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(repoRoot, "skills", entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
  assert.ok(skills.length >= 8, `skills 目录应至少包含 8 个技能，实际 ${skills.length}`);
  const commandAlias = { "market-talent-mapping": "recruit-mapping" };
  for (const skill of skills) {
    for (const hostDir of [".claude/skills", ".agents/skills", ".qoder/skills"]) {
      const target = path.join(repoRoot, hostDir, skill);
      assert.equal(existsSync(target), true, `${hostDir} 缺少技能入口：${skill}`);
    }
    const commandName = commandAlias[skill] ?? skill;
    assert.equal(
      existsSync(path.join(repoRoot, "commands", `${commandName}.md`)),
      true,
      `commands 缺少命令入口：${commandName}.md`,
    );
  }
});

test("README、初始化说明、发版文档与默认 BOSS CLI 版本保持同步", () => {
  const pkg = readJson("package.json");
  const releaseTag = `v${pkg.version}`;
  const releaseDoc = `docs/releases/${releaseTag}.md`;
  assert.equal(
    existsSync(path.join(repoRoot, releaseDoc)),
    true,
    `缺少当前正式版说明文档：${releaseDoc}`,
  );

  const installer = readText(path.join("skills", "recruit-init", "scripts", "install-dependencies.sh"));
  const bossSourceMatch = installer.match(/^BOSS_CLI_SOURCE=\$\{BOSS_CLI_SOURCE:-([^}]+)\}/m);
  assert.ok(bossSourceMatch, "install-dependencies.sh 缺少默认 BOSS_CLI_SOURCE 定义");
  const bossCliSource = bossSourceMatch[1];
  const bossVersionMatch = bossCliSource.match(/^@viyzhu\/boss-cli-fork@(\d+\.\d+\.\d+)$/);
  assert.ok(bossVersionMatch, `默认 BOSS_CLI_SOURCE 格式不符合预期：${bossCliSource}`);
  const bossCliVersion = bossVersionMatch[1];

  const syncChecks = [
    { file: "README.md", label: "顶部当前正式版声明", pattern: `当前正式版为 **${releaseTag}**` },
    { file: "README.md", label: "git clone 固定版本分支", pattern: `git clone --branch ${releaseTag}` },
    {
      file: "README.md",
      label: "DeepSeek Harness 插件安装版本",
      pattern: `dsh plugin --profile web add git+https://github.com/Viy1204/recruiting-copilot.git#${releaseTag}`,
    },
    { file: "README.md", label: "正式版说明文档链接", pattern: releaseDoc },
    { file: path.join("skills", "recruit-init", "SKILL.md"), label: "初始化技能默认 BOSS CLI", pattern: bossCliSource },
    { file: "README.md", label: "README 默认依赖安装器 BOSS CLI", pattern: bossCliSource },
    { file: "README.md", label: "README Step 3 默认已安装 BOSS CLI", pattern: `默认依赖安装器已安装 BOSS CLI ${bossCliVersion}` },
    { file: "README.md", label: "README 单独升级 BOSS CLI 命令", pattern: `npm install -g ${bossCliSource}` },
    { file: "README.md", label: "README boss version 预期输出", pattern: `版本为 \`${bossCliVersion}\`` },
  ];

  const fileCache = new Map();
  for (const { file, label, pattern } of syncChecks) {
    if (!fileCache.has(file)) fileCache.set(file, readText(file));
    assert.equal(
      fileCache.get(file).includes(pattern),
      true,
      `${file} 的${label}未同步，预期包含：${pattern}`,
    );
  }
});
