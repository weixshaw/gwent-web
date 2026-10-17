#!/usr/bin/env node
/**
 * scripts/e2e.mjs — 浏览器 E2E（Playwright）一键复跑脚本 · v2（状态驱动）
 *
 * v2 起优先使用 Lead 提供的稳定 DOM 契约 + 调试钩子：
 *   window.__gwent.game           引擎实例（state.phase/round/turn/pending/result）
 *   window.__gwent.view()         玩家视图（scores/players/…）
 *   window.__gwent.actions()      当前合法动作
 * DOM 契约：
 *   快速对局 .menu-btn[data-action="quick"]
 *   阵营 .faction-tile[data-faction] / 开始 .faction-start
 *   换牌 .mulligan-bar / .mulligan-skip / .mulligan-confirm
 *   手牌 .hand-cards .gt-card[data-uid]
 *   行   .board-row[data-fx-row][data-fx-player]，可落子 .is-playable-row
 *   Pass .pass-btn；待决策 .modal；结算 .modal-backdrop--result
 *
 * 覆盖（--mode=full，默认）：首页 → 快速对局 → 选阵营 → 开始 → 换牌 →
 *   出牌（含行选择/目标/待决策）→ Pass → AI 回合 → 小局结束 → 比赛结束。
 * 采集 console error / pageerror / HTTP 4xx-5xx；截图到 research/qa/screenshots/；
 * 写出 research/qa/e2e-report.json 与 e2e-dom.txt。
 *
 * 用法：
 *   node scripts/e2e.mjs                 完整流程（UI 就绪后）
 *   node scripts/e2e.mjs --mode=smoke    只验首页 + 双分辨率截图
 *   node scripts/e2e.mjs --headed        有头观察
 *   E2E=1 / E2E_FULL=1 node --test tests/e2e.test.mjs
 *
 * 前提：Node ≥20；Playwright（项目内或全局，脚本自动回退系统 Chrome）；
 *       服务器 `node server.mjs`（8788，已在跑则复用，否则自动拉起并在结束后关闭）。
 *
 * 退出码：0 成功（流程到比赛结束且无 pageerror/console.error）；1 失败；2 环境不满足。
 */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const QA_DIR = join(ROOT, "research", "qa");
const SHOT_DIR = join(QA_DIR, "screenshots");
const REPORT_FILE = join(QA_DIR, "e2e-report.json");
const DOM_FILE = join(QA_DIR, "e2e-dom.txt");

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  if (hit.includes("=")) return hit.slice(hit.indexOf("=") + 1);
  return true;
};
const MODE = String(flag("mode", "full"));
const HEADED = Boolean(flag("headed", false));
const KEEP_SERVER = Boolean(flag("keep-server", false));
const NO_SERVER = Boolean(flag("no-server", false));
const BASE_URL = String(flag("base-url", process.env.E2E_BASE_URL || "http://127.0.0.1:8788")).replace(/\/$/, "");
const MAX_ACTIONS = Number(flag("max-actions", 200));
const ACTION_TIMEOUT = Number(flag("action-timeout", 3000));
const OVERALL_TIMEOUT_MS = Number(flag("timeout", 240000));
const PLAY_CARDS_PER_ROUND = Number(flag("cards-per-round", 6));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startedAt = new Date();

const report = {
  startedAt: startedAt.toISOString(),
  baseUrl: BASE_URL,
  mode: MODE,
  browser: null,
  steps: [],
  issues: [],
  screenshots: [],
  consoleErrors: [],
  consoleWarnings: [],
  pageErrors: [],
  httpErrors: [],
  actions: [],
  game: { rounds: [], roundsFinished: 0, gameOver: false, result: null, gems: null, scores: null },
  result: "running",
  error: null,
};

let page = null;
let browser = null;
let context = null;
let stepSeq = 0;
const viewport = { width: 1280, height: 800 };
const VIEWPORT_1920 = { width: 1920, height: 1080 };

function issue(severity, title, detail) {
  report.issues.push({ severity, title, detail, at: new Date().toISOString() });
  console.warn(`  ⚠ [${severity}] ${title}${detail ? ` — ${detail}` : ""}`);
}

async function step(name, fn, { optional = false } = {}) {
  stepSeq += 1;
  const label = `${String(stepSeq).padStart(2, "0")}-${name}`;
  try {
    const value = await fn();
    report.steps.push({ name: label, status: "ok" });
    console.log(`  ✅ ${label}`);
    return value;
  } catch (err) {
    report.steps.push({ name: label, status: "fail", error: err?.message ?? String(err) });
    console.error(`  ❌ ${label}: ${err?.message ?? err}`);
    issue("blocker", `步骤失败：${label}`, err?.message ?? String(err));
    await screenshot(`fail-${label}`, { quiet: true });
    if (!optional) throw err;
    return null;
  }
}

async function screenshot(name, { quiet = false } = {}) {
  if (!page) return null;
  const safe = name.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  const file = join(SHOT_DIR, `${safe}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false });
    if (!report.screenshots.includes(file)) report.screenshots.push(file);
    if (!quiet) console.log(`  📸 ${file.replace(ROOT + "/", "")}`);
    return file;
  } catch (err) {
    console.error(`  ⚠ 截图失败 ${name}: ${err.message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Playwright / 服务器                                                 */
/* ------------------------------------------------------------------ */

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch { /* global */ }
  try {
    const rootRes = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
    const globalRoot = (rootRes.stdout || "").trim();
    if (globalRoot) {
      const req = createRequire(pathToFileURL(join(globalRoot, "noop.js")));
      return req("playwright");
    }
  } catch { /* ignore */ }
  try {
    return createRequire(import.meta.url)("playwright");
  } catch {
    return null;
  }
}

async function launchBrowser(pw) {
  const attempts = [
    { name: "playwright-bundled", opts: { headless: !HEADED } },
    { name: "system-chrome", opts: { headless: !HEADED, channel: "chrome" } },
  ];
  const cacheRoot = join(process.env.HOME || "", "Library", "Caches", "ms-playwright");
  if (existsSync(cacheRoot)) {
    try {
      const dirs = readdirSync(cacheRoot).filter((d) => d.startsWith("chromium-")).sort().reverse();
      for (const d of dirs) {
        for (const rel of [
          "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ]) {
          const exe = join(cacheRoot, d, rel);
          if (existsSync(exe)) attempts.push({ name: `cache:${d}`, opts: { headless: !HEADED, executablePath: exe } });
        }
      }
    } catch { /* ignore */ }
  }
  let firstErr = null;
  for (const attempt of attempts) {
    try {
      const b = await pw.chromium.launch(attempt.opts);
      report.browser = attempt.name;
      console.log(`  ℹ 浏览器：${attempt.name}`);
      return b;
    } catch (err) {
      if (!firstErr) firstErr = err;
    }
  }
  throw new Error(`Chromium 启动失败：${firstErr?.message ?? "未知"}\n提示：npx playwright install chromium`);
}

async function isServerUp(url) {
  try {
    const res = await fetch(url);
    return res.status < 500;
  } catch {
    return false;
  }
}
async function ensureServer() {
  if (await isServerUp(BASE_URL)) {
    console.log(`  ℹ 复用已运行的服务器：${BASE_URL}`);
    return { spawned: null };
  }
  if (NO_SERVER) throw new Error(`--no-server 指定但 ${BASE_URL} 不可用`);
  console.log(`  ▶ 启动 node server.mjs（${BASE_URL}）…`);
  const child = spawn(process.execPath, ["server.mjs"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await isServerUp(BASE_URL)) return { spawned: child };
  }
  child.kill("SIGTERM");
  throw new Error(`服务器启动超时（${stderr.slice(-300)}）`);
}

/* ------------------------------------------------------------------ */
/* 页面工具                                                            */
/* ------------------------------------------------------------------ */

async function visible(locator) {
  try {
    return (await locator.count()) > 0 && (await locator.first().isVisible());
  } catch {
    return false;
  }
}

async function firstVisible(selectors, timeout = ACTION_TIMEOUT) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await visible(loc)) return loc;
    }
    await sleep(80);
  }
  return null;
}

async function clickLocator(locator, label) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.click({ timeout: ACTION_TIMEOUT });
  } catch {
    await locator.click({ force: true, timeout: ACTION_TIMEOUT });
  }
  report.actions.push({ label, at: Date.now() - startedAt.getTime() });
  await sleep(150);
}

/**
 * 安全点击：扇形手牌有旋转与重叠，默认中心点可能被相邻卡遮挡。
 * 依次尝试中心与若干偏置点，短超时快速失败；全部失败时用 DOM click 兜底。
 */
async function clickElementSafe(locator, label) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return false;
  const w = box.width;
  const h = box.height;
  // 扇形手牌：相邻卡会互相遮挡，优先尝试右侧/下侧可见区域，再试中心
  const points = [
    { x: w * 0.85, y: h * 0.55 },
    { x: w * 0.75, y: h * 0.7 },
    { x: w * 0.9, y: h * 0.35 },
    { x: w * 0.6, y: h * 0.7 },
    { x: w * 0.5, y: h * 0.5 },
  ];
  for (const point of points) {
    try {
      await locator.click({ position: point, timeout: 700 });
      report.actions.push({ label, at: Date.now() - startedAt.getTime() });
      await sleep(120);
      return true;
    } catch { /* try next */ }
  }
  return false;
}

/** 直接派发 DOM click（绕过扇形手牌遮挡；用于 E2E 交互兜底） */
async function domClick(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector);
}

/** 读取引擎/UI 状态（Lead 调试钩子） */
async function readGame() {
  try {
    return await page.evaluate(() => {
      const w = window.__gwent;
      if (!w || !w.game) return null;
      const st = w.game.state;
      const view = typeof w.view === "function" ? w.view() : null;
      const actions = typeof w.actions === "function" ? w.actions() : [];
      return {
        phase: st.phase,
        round: st.round,
        turn: st.turn,
        pending: st.pending ? { kind: st.pending.kind, player: st.pending.player } : null,
        gems: Array.isArray(st.gems) ? st.gems.slice() : null,
        result: st.result ?? null,
        scores: view?.scores ?? null,
        handCount: view?.players?.[0]?.hand ? view.players[0].hand.length : null,
        handUids: view?.players?.[0]?.hand ? view.players[0].hand.map((c) => c.uid) : [],
        actions: actions.map((a) => ({ type: a.type, uid: a.uid, row: a.row, targetUid: a.targetUid, label: a.label })),
        boardReady: Boolean(
          document.querySelector(".board-row[data-fx-row]") &&
          document.querySelector(".hand-cards .gt-card"),
        ),
        handDomCount: document.querySelectorAll(".hand-cards .gt-card[data-uid]").length,
        modalVisible: Boolean(document.querySelector(".modal, .modal-backdrop")),
      };
    });
  } catch {
    return null;
  }
}

/** 等待状态满足条件（轮询 state，而不是等动画） */
async function waitState(predicate, timeout = 15000, label = "state") {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await readGame();
    if (last && predicate(last)) return last;
    await sleep(120);
  }
  throw new Error(`等待状态超时（${label}）；最后状态：${JSON.stringify(last && { phase: last.phase, round: last.round, turn: last.turn, pending: last.pending })}`);
}

/** 关闭可能出现的确认弹窗（Pass/结果等） */
async function confirmModal() {
  const gold = await firstVisible(
    [".modal__actions .btn--gold", ".modal__actions .btn--primary", ".modal .btn--gold", ".modal .btn--primary"],
    800,
  );
  if (gold) {
    await clickLocator(gold, "modal-confirm");
    return true;
  }
  const btn = await firstVisible([".modal button", ".modal .btn", ".gt-modal button"], 400);
  if (btn) {
    await clickLocator(btn, "modal-any-button");
    return true;
  }
  return false;
}

/**
 * 手牌点击（按 uid）。
 * 手牌是扇形重叠布局：点击卡牌中心可能命中相邻卡，因此固定点左上角；
 * 若仍失败则用 DOM 原生 click 兜底（记录报告）。
 */
async function clickHandCard(uid) {
  const loc = page.locator(`.hand-cards .gt-card[data-uid="${uid}"]`).first();
  if (!(await visible(loc))) return false;
  const ok = await clickElementSafe(loc, `hand-card:${uid.slice(0, 12)}`);
  if (ok) return true;
  const domOk = await domClick(`.hand-cards .gt-card[data-uid="${uid}"]`);
  if (domOk) report.actions.push({ label: `hand-card-dom:${uid.slice(0, 12)}`, at: Date.now() - startedAt.getTime() });
  return domOk;
}

/** 截图前等待动画落定并将鼠标移开（避免 tooltip/翻转动画影响截图） */
async function settleAndShoot(name, wait = 900) {
  await sleep(wait);
  await page.mouse.move(4, 4).catch(() => {});
  await sleep(150);
  return screenshot(name);
}

/** 等待棋盘进入可操作态（mode === 'play'），避免动画期间点击被忽略 */
async function waitBoardInteractive(timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const b = await readBoardState();
    if (b && b.mode === "play") return true;
    await sleep(100);
  }
  return false;
}

/** 读取棋盘交互状态（选中卡/模式） */
async function readBoardState() {
  try {
    return await page.evaluate(() => {
      const b = window.__gwent?.app?.match?.board?.state;
      if (!b) return null;
      return {
        mode: b.mode,
        selectedUid: b.selectedUid ?? null,
        mulliganCount: b.mulliganCount ?? null,
        mulliganSelected: b.mulliganSelected ? b.mulliganSelected.size ?? b.mulliganSelected.length ?? null : 0,
      };
    });
  } catch {
    return null;
  }
}

/** 选择可落子行（优先 action.row，其次第一个 .is-playable-row） */
async function chooseRow(row) {
  const sels = [];
  if (row) sels.push(`.board-row[data-fx-row="${row}"].is-playable-row`, `.board-row[data-fx-row="${row}"]`);
  sels.push(".board-row.is-playable-row", ".board-row[data-fx-row]");
  const loc = await firstVisible(sels, 2000);
  if (loc) {
    await clickLocator(loc, `row:${row ?? "auto"}`);
    return true;
  }
  return false;
}

/** 兜底：直接走引擎（避免 UI 未响应导致流程卡死；会记录 issue） */
async function applyActionViaEngine(action) {
  const res = await page.evaluate((act) => {
    try {
      const w = window.__gwent;
      const r = w.game.apply(act);
      // 引擎兜底会绕过 app 的动画/回合调度：主动触发一次 afterState 让 AI 继续行动
      try {
        w.app?.match?.afterState?.();
      } catch { /* ignore */ }
      return { ok: r.ok !== false, error: r.error ?? null };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }, action);
  return res.ok;
}

/* ------------------------------------------------------------------ */
/* 对局动作                                                            */
/* ------------------------------------------------------------------ */

/** 换牌阶段：优先点 2 张 + 确认；否则跳过。返回 {picked, skipped, detected} */
async function doMulligan() {
  const bar = await firstVisible([".mulligan-bar"], 8000);
  if (!bar) return { picked: 0, skipped: true, detected: false };
  // 等待棋盘真正进入 mulligan 模式（点击在 mode != mulligan 时会被忽略）
  {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const b = await readBoardState();
      if (b?.mode === "mulligan") break;
      await sleep(100);
    }
  }
  await screenshot("04-mulligan");
  const handUids = await page.evaluate(() =>
    [...document.querySelectorAll(".hand-cards .gt-card[data-uid]")].map((el) => el.dataset.uid),
  );
  let picked = 0;
  for (const uid of handUids.slice(0, 2)) {
    // 先真实点击，失败再用 DOM click（扇形遮挡兜底）
    const loc = page.locator(`.hand-cards .gt-card[data-uid="${uid}"]`).first();
    await clickElementSafe(loc, `mulligan-card:${uid.slice(0, 12)}`);
    let bs = await readBoardState();
    if ((bs?.mulliganSelected ?? 0) < picked + 1) {
      await domClick(`.hand-cards .gt-card[data-uid="${uid}"]`);
      await sleep(150);
      bs = await readBoardState();
    }
    if (bs && typeof bs.mulliganSelected === "number") picked = bs.mulliganSelected;
    await sleep(150);
  }
  console.log(`  ℹ 换牌选中 ${picked}/2`);
  const confirm = await firstVisible([".mulligan-confirm"], 1200);
  if (confirm) {
    await clickLocator(confirm, "mulligan-confirm");
    return { picked, skipped: false, detected: true };
  }
  const skip = await firstVisible([".mulligan-skip"], 800);
  if (skip) {
    await clickLocator(skip, "mulligan-skip");
    return { picked: 0, skipped: true, detected: true };
  }
  return { picked, skipped: false, detected: true };
}

/** 待决策（医师/弃牌/看牌/天气等）：走引擎应答（UI 弹窗截图留证） */
async function resolvePending() {
  const state = await readGame();
  if (!state?.pending) return false;
  await screenshot(`pending-${state.pending.kind}`);
  report.actions.push({ label: `pending:${state.pending.kind}`, at: Date.now() - startedAt.getTime() });
  const answered = await page.evaluate(() => {
    const w = window.__gwent;
    const game = w.game;
    const p = game.pending;
    if (!p) return { ok: true, kind: null };
    const opts = p.options ?? [];
    try {
      switch (p.kind) {
        case "mulligan": game.respond({ cards: [] }); break;
        case "chooseFirstPlayer": game.respond({ first: 0 }); break;
        case "medic": game.respond(opts.length ? { uid: opts[0].uid } : { skip: true }); break;
        case "reviveRow": game.respond({ row: opts[0] }); break;
        case "viewHand": game.respond({ ack: true }); break;
        case "chooseWeather": game.respond({ uid: opts[0]?.uid }); break;
        case "takeGraveUnit": game.respond({ uid: opts[0]?.uid }); break;
        case "discardCards": game.respond({ cards: opts.slice(0, p.count ?? 2).map((o) => o.uid) }); break;
        case "deckChoice": game.respond({ uid: opts[0]?.uid }); break;
        default: return { ok: false, kind: p.kind, error: "未知 pending" };
      }
      return { ok: true, kind: p.kind };
    } catch (err) {
      return { ok: false, kind: p.kind, error: String(err?.message || err) };
    }
  });
  if (!answered.ok) {
    issue("major", `待决策应答失败：${answered.kind}`, answered.error);
    await confirmModal();
  }
  await sleep(250);
  return true;
}

/** 我方回合：出 1 张牌（UI 点击优先，引擎兜底）或 Pass */
async function takeTurn(state) {
  const actions = state.actions ?? [];
  const playActions = actions.filter((a) => a.type === "playCard");
  const passAction = actions.find((a) => a.type === "pass");
  const entry = report.game.rounds.find((r) => r.round === state.round);
  const roundPlayed = entry?.played ?? 0;

  if (playActions.length === 0 || roundPlayed >= PLAY_CARDS_PER_ROUND) {
    const passBtn = await firstVisible([".pass-btn", '[data-action="pass"]'], 1500);
    if (passBtn) {
      await clickLocator(passBtn, "pass");
      await sleep(250);
      await confirmModal();
      return "pass-ui";
    }
    if (passAction && (await applyActionViaEngine(passAction))) return "pass-engine";
    issue("major", "无法 Pass", "找不到 .pass-btn 且引擎 pass 失败");
    return "none";
  }

  const action = playActions[0];
  const advancedFn = (after) =>
    after &&
    (after.turn !== state.turn ||
      after.pending ||
      after.phase !== state.phase ||
      (after.handCount ?? 0) < (state.handCount ?? 0) ||
      JSON.stringify(after.scores) !== JSON.stringify(state.scores));

  // 动画/回合切换期间棋盘可能处于 waiting，点击会被忽略 → 先等可操作态
  await waitBoardInteractive(5000);
  let clicked = await clickHandCard(action.uid);
  if (!clicked) {
    issue("minor", "手牌 DOM 中找不到目标卡", `uid=${action.uid}`);
    return (await applyActionViaEngine(action)) ? "play-engine" : "none";
  }
  await sleep(240);

  // 需要玩家选行/选目标时，棋盘会进入选择态（selectedUid）
  let boardState = await readBoardState();
  if (boardState?.selectedUid) {
    if (action.row) await chooseRow(action.row);
    if (action.targetUid) {
      const target = page.locator(`[data-uid="${action.targetUid}"]`).first();
      if (await visible(target)) await clickLocator(target, `target:${action.targetUid.slice(0, 12)}`);
    }
    await confirmModal();
  }
  // 等待状态推进（动画 <4s）
  let advanced = false;
  try {
    await waitState(advancedFn, 4000, "出牌后状态推进");
    advanced = true;
  } catch {
    /* fallthrough */
  }
  // 重试一次（可能是等待可操作态后仍被动画吞掉）
  if (!advanced) {
    await waitBoardInteractive(2500);
    boardState = await readBoardState();
    if (boardState?.mode === "play") {
      const clickedAgain = await clickHandCard(action.uid);
      if (clickedAgain) {
        await sleep(260);
        const bs2 = await readBoardState();
        if (bs2?.selectedUid) {
          if (action.row) await chooseRow(action.row);
          if (action.targetUid) {
            const t2 = page.locator(`[data-uid="${action.targetUid}"]`).first();
            if (await visible(t2)) await clickLocator(t2, `target-retry:${action.targetUid.slice(0, 12)}`);
          }
          await confirmModal();
        }
        try {
          await waitState(advancedFn, 4000, "出牌后状态推进（重试）");
          advanced = true;
        } catch {
          /* fallthrough */
        }
      }
    }
  }
  if (!advanced) {
    issue("major", "UI 出牌点击无响应", `action=${action.label ?? action.uid}`);
    return (await applyActionViaEngine(action)) ? "play-engine" : "none";
  }
  return "play-ui";
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

let modeResultOverride = null;

async function run() {
  mkdirSync(SHOT_DIR, { recursive: true });

  const pw = await loadPlaywright();
  if (!pw?.chromium) {
    console.error("\n[E2E] 缺少 Playwright：npm i -D playwright && npx playwright install chromium\n");
    return 2;
  }
  const server = await ensureServer().catch((err) => {
    console.error(`\n[E2E] 服务器不可用：${err.message}\n`);
    return null;
  });
  if (!server) return 2;

  let exitCode = 0;
  let killedByTimeout = false;
  try {
    console.log(`\n[E2E] 启动 Chromium（${HEADED ? "headed" : "headless"}）…`);
    browser = await launchBrowser(pw);
    context = await browser.newContext({ viewport: { ...viewport }, locale: "zh-CN" });
    page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT);

    page.on("console", (msg) => {
      const entry = { type: msg.type(), text: msg.text(), location: msg.location() };
      if (msg.type() === "error") report.consoleErrors.push(entry);
      else if (msg.type() === "warning") report.consoleWarnings.push(entry);
    });
    page.on("pageerror", (err) => report.pageErrors.push({ message: err.message, stack: err.stack }));
    page.on("response", (res) => {
      if (res.status() >= 400) report.httpErrors.push({ url: res.url(), status: res.status() });
    });

    const overall = setTimeout(() => {
      killedByTimeout = true;
      console.error(`\n[E2E] 整体超时（>${OVERALL_TIMEOUT_MS}ms）`);
    }, OVERALL_TIMEOUT_MS);

    // ── 1. 首页
    await step("首页加载", async () => {
      const resp = await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (!resp || !resp.ok()) throw new Error(`首页 HTTP ${resp?.status()}`);
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      const menu = await firstVisible([".menu-screen", '.menu-btn[data-action="quick"]', "#app"], 10000);
      if (!menu) throw new Error("首页未挂载（.menu-screen/#app 均不可见）");
      await sleep(600);
    });
    await screenshot("01-home-1280x800");

    await step("首页 1920×1080 布局", async () => {
      await page.setViewportSize(VIEWPORT_1920);
      await sleep(400);
      await screenshot("01b-home-1920x1080");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
      if (overflow) issue("minor", "1920×1080 出现横向滚动条（布局溢出）");
    }, { optional: true });
    await page.setViewportSize(viewport);

    if (MODE === "smoke") {
      report.result = "smoke-ok";
      clearTimeout(overall);
      console.log("\n[E2E] smoke 模式完成。");
      return 0;
    }

    // ── 2. 快速对局 → 阵营 → 开始
    await step("快速对局 → 阵营选择", async () => {
      const quick = await firstVisible(['.menu-btn[data-action="quick"]'], 4000);
      if (!quick) throw new Error('找不到 .menu-btn[data-action="quick"]');
      await clickLocator(quick, "quick-play");
      const tile = await firstVisible([".faction-tile[data-faction]"], 5000);
      if (!tile) throw new Error("未出现 .faction-tile[data-faction]");
    });

    await step("选择阵营（北方领域）", async () => {
      const tile = await firstVisible(['.faction-tile[data-faction="northern-realms"]', ".faction-tile[data-faction]"], 3000);
      if (!tile) throw new Error("找不到阵营卡");
      await clickLocator(tile, "faction:northern-realms");
      await sleep(400);
      await screenshot("02-faction");
    });

    await step("开始对局（预设牌组 vs AI）", async () => {
      const start = await firstVisible([".faction-start"], 4000);
      if (!start) throw new Error("找不到 .faction-start");
      await clickLocator(start, "start-game");
      await waitState((s) => s && (s.phase !== "setup" || s.pending), 20000, "对局开始");
      await sleep(400);
      await screenshot("03-game-start");
    });

    // ── 3. 换牌
    await step("换牌（选 2 张 + 确认，或跳过）", async () => {
      const mulligan = await doMulligan();
      if (!mulligan.detected) {
        issue("major", "未检测到换牌界面（.mulligan-bar）", "引擎可能直接进入 play，或 UI 未渲染换牌条");
        return;
      }
      await waitState((s) => !s.pending || s.pending.kind !== "mulligan", 12000, "换牌结束");
      console.log(`  ℹ 换牌：选中 ${mulligan.picked} 张${mulligan.skipped ? "（跳过）" : ""}`);
    });

    // ── 4. 对局主循环
    await step("对局主循环（出牌/行选择/Pass/AI/小局结算/比赛结束）", async () => {
      let gameOver = false;
      let actionsTaken = 0;
      let aiTurns = 0;
      let lastRound = null;
      let stuckCount = 0;

      const recordRound = (state) => {
        if (!report.game.rounds.some((r) => r.round === state.round)) {
          report.game.rounds.push({ round: state.round, played: 0 });
        }
        return report.game.rounds.find((r) => r.round === state.round);
      };

      while (actionsTaken < MAX_ACTIONS) {
        if (killedByTimeout) throw new Error("整体超时");
        const state = await readGame();
        if (!state) {
          await sleep(300);
          if (++stuckCount > 20) throw new Error("无法读取 window.__gwent 状态（调试钩子缺失？）");
          continue;
        }
        report.game.scores = state.scores;
        report.game.gems = state.gems;

        if (state.phase === "game-over" || state.result) {
          gameOver = true;
          report.game.gameOver = true;
          report.game.result = state.result ?? null;
          report.game.finalRound = state.round;
          await screenshot("08-game-over-engine");
          // 结算动画/弹窗可能延迟出现（app 在 gameOver 后 sleep 500ms 再显示）
          const resultModal = await firstVisible([".modal-backdrop--result"], 8000);
          if (resultModal) {
            await sleep(400);
            await screenshot("08b-result-modal");
          } else {
            issue("major", "结算界面未出现 .modal-backdrop--result（8s）", "检查 app.showResult/结果弹窗逻辑");
            await screenshot("08c-game-over-no-modal");
          }
          break;
        }

        if (lastRound !== null && state.round !== lastRound) {
          report.game.roundsFinished = Math.max(report.game.roundsFinished, state.round - 1);
          console.log(`  ℹ 小局切换：${lastRound} → ${state.round}（gems=${JSON.stringify(state.gems)}）`);
          await screenshot(`05-round-${lastRound}-end`);
        }
        lastRound = state.round;
        recordRound(state);

        if (state.pending) {
          await resolvePending();
          continue;
        }

        if (state.phase === "play" && state.turn === 1) {
          aiTurns += 1;
          await waitState(
            (s) => !s || s.phase !== "play" || s.turn !== 1 || Boolean(s.pending) || Boolean(s.result),
            20000,
            `AI 回合（第 ${aiTurns} 次）`,
          );
          continue;
        }

        if (state.phase !== "play") {
          await sleep(250);
          if (++stuckCount > 20) throw new Error(`对局阶段异常：${state.phase}`);
          continue;
        }

        // 我方回合
        const entry = recordRound(state);
        const playedBefore = entry.played;
        const kind = await takeTurn(state);
        actionsTaken += 1;
        stuckCount = 0;
        if (kind.startsWith("play")) {
          recordRound(state).played = playedBefore + 1;
          if (actionsTaken === 1) await settleAndShoot("06-play-mid");
          if (actionsTaken === 4) {
            await page.setViewportSize(VIEWPORT_1920);
            await settleAndShoot("06b-play-1920x1080");
            await page.setViewportSize(viewport);
            await sleep(250);
          }
        }
      }

      if (gameOver) report.game.roundsFinished = lastRound ?? report.game.roundsFinished;
      else report.game.roundsFinished = Math.max(report.game.roundsFinished, (lastRound ?? 1) - 1);
      if (!gameOver) {
        issue("major", "对局未在动作上限内结束", `actions=${actionsTaken}, round=${lastRound}, MAX_ACTIONS=${MAX_ACTIONS}`);
        await screenshot("07-loop-ended");
      }
      console.log(`  ℹ 对局：${actionsTaken} 次我方动作，AI 回合 ${aiTurns} 次，小局 ${lastRound ?? "?"}`);
    });

    clearTimeout(overall);

    // ── 5. 结果校验
    const finalState = await readGame();

    // ── 结算弹窗内容校验（防止显示 0:0 等错误比分）
    await step("结算弹窗内容与引擎结果一致", async () => {
      const modal = await firstVisible([".modal-backdrop--result"], 3000);
      if (!modal) {
        issue("major", "未找到结算弹窗", "");
        return;
      }
      const text = await page.evaluate(() => ({
        title: document.querySelector(".result__title")?.textContent?.trim() ?? null,
        score: document.querySelector(".result__score")?.textContent?.trim() ?? null,
        sub: document.querySelector(".result__sub")?.textContent?.trim() ?? null,
      }));
      const result = finalState?.result;
      if (result) {
        const roundsWon = [0, 1].map((p) => (result.history ?? []).filter((h) => h.winner === p).length);
        const expectTitle = result.winner === 0 ? "胜利" : result.winner === 1 ? "失败" : "平局";
        if (text.title && !text.title.includes(expectTitle)) {
          issue("major", "结算标题与引擎结果不一致", `UI=${text.title} 期望=${expectTitle}`);
        }
        const expectScore = `${roundsWon[0]} : ${roundsWon[1]}`;
        if (text.score && text.score.replace(/\s+/g, "") !== expectScore.replace(/\s+/g, "")) {
          issue("major", "结算小局比分显示不一致", `UI=${text.score} 期望=${expectScore}（gems=${JSON.stringify(result.gems)}）`);
        }
      }
      console.log(`  ℹ 结算：${text.title ?? "?"} ${text.score ?? "?"}${text.sub ? " | " + text.sub : ""}`);
    }, { optional: true });

    if (finalState) {
      report.game.final = {
        phase: finalState.phase,
        round: finalState.round,
        gems: finalState.gems,
        result: finalState.result,
        scores: finalState.scores,
      };
      if (finalState.phase !== "game-over") issue("major", "结束状态不是 game-over", `phase=${finalState.phase}`);
      if (report.game.roundsFinished < 1) issue("major", "未完成任何小局", "");
      if (typeof finalState.handCount === "number" && finalState.phase === "play") {
        if (finalState.handDomCount !== finalState.handCount) {
          issue("minor", "手牌 DOM 数量与视图不一致", `dom=${finalState.handDomCount} view=${finalState.handCount}`);
        }
      }
    }

    if (report.pageErrors.length > 0) {
      report.result = "page-errors";
      exitCode = 1;
    } else if (report.consoleErrors.length > 0) {
      report.result = "console-errors";
      exitCode = 1;
    } else {
      report.result = report.game.gameOver ? "game-over-reached" : "flow-completed-without-gameover";
      exitCode = report.game.gameOver ? 0 : 1;
    }
    if (report.issues.some((i) => i.severity === "blocker")) exitCode = 1;
    if (modeResultOverride !== null) exitCode = modeResultOverride;

    if (page) {
      const html = await page.evaluate(() => document.documentElement.outerHTML).catch(() => "");
      writeFileSync(DOM_FILE, String(html).slice(0, 500_000), "utf8");
    }
  } catch (err) {
    report.result = "failed";
    report.error = err?.stack ?? String(err);
    console.error(`\n[E2E] 失败：${err?.message ?? err}`);
    await screenshot("fail-FINAL", { quiet: true });
    if (page) {
      const html = await page.evaluate(() => document.documentElement.outerHTML).catch(() => "");
      writeFileSync(DOM_FILE, String(html).slice(0, 500_000), "utf8");
    }
    exitCode = 1;
  } finally {
    try {
      await context?.close();
      await browser?.close();
    } catch { /* ignore */ }
    if (server?.spawned && !KEEP_SERVER) {
      try {
        server.spawned.kill("SIGTERM");
      } catch { /* ignore */ }
    }
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt.getTime();
    try {
      writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), "utf8");
      console.log(`\n[E2E] 结果=${report.result}  用时=${(report.durationMs / 1000).toFixed(1)}s`);
      console.log(`[E2E] 小局完成=${report.game.roundsFinished} 比赛结束=${report.game.gameOver} gems=${JSON.stringify(report.game.gems)}`);
      console.log(`[E2E] console.error=${report.consoleErrors.length} pageerror=${report.pageErrors.length} http>=400=${report.httpErrors.length} issues=${report.issues.length}`);
      if (report.issues.length) {
        console.log("[E2E] 问题清单：");
        for (const i of report.issues) console.log(`  · [${i.severity}] ${i.title}${i.detail ? ` — ${i.detail}` : ""}`);
      }
      console.log(`[E2E] 报告：${REPORT_FILE.replace(ROOT + "/", "")}`);
      for (const s of report.screenshots) console.log(`  📸 ${s.replace(ROOT + "/", "")}`);
    } catch { /* ignore */ }
  }
  return exitCode;
}

const code = await run();
process.exit(code);
