/**
 * tests/e2e.test.mjs — 浏览器烟测/全流程（包装 scripts/e2e.mjs）
 *
 * 默认跳过（避免 npm test 每次启动浏览器）：
 *   E2E=1       node --test tests/e2e.test.mjs   → 首页 smoke（约 10s）
 *   E2E_FULL=1  node --test tests/e2e.test.mjs   → 完整对局流程（约 1~3 分钟）
 *
 * 前提与详细说明见 research/qa/E2E.md；报告与截图在 research/qa/。
 * 截图目录：research/qa/screenshots/
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUN_SMOKE = process.env.E2E === "1" || process.env.E2E === "true";
const RUN_FULL = process.env.E2E_FULL === "1" || process.env.E2E_FULL === "true";

function runE2E(mode, timeout) {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", "e2e.mjs"), `--mode=${mode}`], {
    cwd: ROOT,
    encoding: "utf8",
    timeout,
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

test(
  "E2E smoke：首页可加载 + 1280×800/1920×1080 截图 + console 报告",
  { skip: RUN_SMOKE ? false : "SKIP：设置 E2E=1 运行（UI 可测后；scripts/e2e.mjs --mode=smoke）" },
  () => {
    const result = runE2E("smoke", 150_000);
    assert.equal(result.status, 0, "E2E smoke 失败：见上方输出 / research/qa/e2e-report.json");
  },
);

test(
  "E2E full：首页→选阵营→预设开局→换牌→出牌→Pass→AI 回合→小局结束→比赛结束",
  { skip: RUN_FULL ? false : "SKIP：设置 E2E_FULL=1 运行（UI 就绪后；scripts/e2e.mjs 约 1~3 分钟）" },
  () => {
    const result = runE2E("full", 360_000);
    assert.equal(result.status, 0, "E2E full 失败：见上方输出 / research/qa/e2e-report.json 与 research/qa/e2e-dom.txt");
  },
);
