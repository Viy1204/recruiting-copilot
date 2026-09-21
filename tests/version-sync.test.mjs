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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(path.join(repoRoot, rel), "utf8"));

test("package.json 与 .claude-plugin/plugin.json 版本号一致", () => {
  const pkg = readJson("package.json");
  const plugin = readJson(path.join(".claude-plugin", "plugin.json"));
  assert.equal(
    plugin.version,
    pkg.version,
    `plugin.json=${plugin.version} 与 package.json=${pkg.version} 不一致：` +
      "装机用户按 plugin.json 判断版本，不同步就收不到更新提示",
  );
});

test("两个清单里的插件名一致", () => {
  const plugin = readJson(path.join(".claude-plugin", "plugin.json"));
  const market = readJson(path.join(".claude-plugin", "marketplace.json"));
  assert.ok(
    market.plugins.some((p) => p.name === plugin.name),
    `marketplace.json 里没有名为 ${plugin.name} 的条目`,
  );
});
