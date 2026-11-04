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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(path.join(repoRoot, rel), "utf8"));

test("主包与主插件版本号一致", () => {
  const pkg = readJson("package.json");
  const plugin = readJson(path.join(".claude-plugin", "plugin.json"));
  assert.equal(
    plugin.version,
    pkg.version,
    `plugin.json=${plugin.version} 与 package.json=${pkg.version} 不一致：` +
      "装机用户按 plugin.json 判断版本，不同步就收不到更新提示",
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
