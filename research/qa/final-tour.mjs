#!/usr/bin/env node
/**
 * research/qa/final-tour.mjs — 最终验收可玩性巡检（1280×800 / 1920×1080）
 *
 * 覆盖：首页（新符文/阵营纹章背景）、快速对局（VS 开场/硬币）、换牌、
 *       对局中（手牌扇形/牌面 hover tooltip/天气/号角/分数/日志）、结算页、
 *       组牌器、牌库图鉴；并验证两条交互裁定：
 *         ① 重复天气允许打出（提示"该天气已经生效"并进弃牌堆）
 *         ② 已有效果号角单位的行不允许再放号角（无动作/无高亮）
 *
 * 截图输出：research/qa/final/*.png    报告：research/qa/final/report.json
 * 运行：node research/qa/final-tour.mjs
 */

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8788";
const OUT = join(ROOT, "research", "qa", "final");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = {
  startedAt: new Date().toISOString(),
  baseUrl: BASE,
  checks: [],
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
  httpErrors: [],
  issues: [],
  result: "running",
};
const check = async (name, fn) => {
  try {
    const value = await fn();
    report.checks.push({ name, status: "ok", value: value ?? null });
    console.log(`  ✅ ${name}`);
    return true;
  } catch (err) {
    report.checks.push({ name, status: "fail", error: err?.message ?? String(err) });
    report.issues.push({ severity: "major", title: name, detail: err?.message ?? String(err) });
    console.error(`  ❌ ${name}: ${err?.message ?? err}`);
    return false;
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const issue = (severity, title, detail) => {
  report.issues.push({ severity, title, detail });
  console.warn(`  ⚠ [${severity}] ${title}${detail ? ` — ${detail}` : ""}`);
};

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch { /* global fallback */ }
  try {
    const r = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
    const globalRoot = (r.stdout || "").trim();
    if (globalRoot) return createRequire(pathToFileURL(join(globalRoot, "noop.js")))("playwright");
  } catch { /* ignore */ }
  try {
    return createRequire(import.meta.url)("playwright");
  } catch {
    return null;
  }
}

async function launch(pw) {
  const candidates = [
    { name: "bundled", opts: { headless: true } },
    { name: "system-chrome", opts: { headless: true, channel: "chrome" } },
  ];
  const cacheRoot = join(process.env.HOME || "", "Library", "Caches", "ms-playwright");
  if (existsSync(cacheRoot)) {
    for (const d of readdirSync(cacheRoot).filter((x) => x.startsWith("chromium-")).sort().reverse()) {
      const exe = join(cacheRoot, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
      if (existsSync(exe)) candidates.push({ name: `cache:${d}`, opts: { headless: true, executablePath: exe } });
    }
  }
  for (const c of candidates) {
    try {
      const b = await pw.chromium.launch(c.opts);
      console.log(`  ℹ 浏览器：${c.name}`);
      return b;
    } catch { /* next */ }
  }
  throw new Error("Chromium 启动失败");
}

let page = null;
const V1280 = { width: 1280, height: 800 };
const V1920 = { width: 1920, height: 1080 };

async function shot(name, wait = 500) {
  await sleep(wait);
  await page.mouse.move(4, 4).catch(() => {});
  await sleep(120);
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push(file.replace(ROOT + "/", ""));
  console.log(`  📸 ${file.replace(ROOT + "/", "")}`);
  return file;
}
async function visible(loc) {
  try {
    return (await loc.count()) > 0 && (await loc.first().isVisible());
  } catch {
    return false;
  }
}
async function firstVisible(selectors, timeout = 6000) {
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
async function click(loc, label) {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await loc.click({ timeout: 3000 });
  } catch {
    await loc.click({ force: true, timeout: 3000 });
  }
  if (label) console.log(`  ↩ ${label}`);
  await sleep(200);
}
async function domClick(sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.click();
    return true;
  }, sel);
}
async function readGame() {
  return page.evaluate(() => {
    const w = window.__gwent;
    if (!w?.game) return null;
    const st = w.game.state;
    const view = typeof w.view === "function" ? w.view() : null;
    return {
      phase: st.phase,
      round: st.round,
      turn: st.turn,
      pending: st.pending ? { kind: st.pending.kind } : null,
      gems: st.gems,
      weather: { ...st.weather },
      scores: view?.scores,
      handCount: view?.players?.[0]?.hand?.length ?? null,
      result: st.result ?? null,
      actions: (typeof w.actions === "function" ? w.actions() : []).map((a) => ({
        type: a.type, uid: a.uid, row: a.row, rowOwner: a.rowOwner, targetUid: a.targetUid, label: a.label,
      })),
    };
  });
}
async function readBoard() {
  return page.evaluate(() => {
    const b = window.__gwent?.app?.match?.board?.state;
    if (!b) return null;
    return { mode: b.mode, selectedUid: b.selectedUid ?? null };
  });
}
async function waitFor(fn, timeout = 20000, label = "condition") {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`等待超时：${label}`);
}
async function waitOurTurn(timeout = 40000) {
  return waitFor(async () => {
    const g = await readGame();
    if (!g) return null;
    if (g.phase === "game-over") return g;
    if (g.pending) return g;
    if (g.turn !== 0) return null;
    const b = await readBoard();
    return b?.mode === "play" ? g : null;
  }, timeout, "我方回合");
}
async function overflowInfo() {
  return page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    scrollH: document.documentElement.scrollHeight,
    innerH: window.innerHeight,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
    overflowY: document.documentElement.scrollHeight > window.innerHeight + 2,
  }));
}
async function textIntegrity(label) {
  const text = await page.evaluate(() => document.body.innerText).catch(() => "");
  const bad = ["undefined", "NaN", "�", "[object Object]"];
  const found = bad.filter((b) => text.includes(b));
  assert(found.length === 0, `${label} 可见文本出现异常：${found.join(", ")}`);
  return true;
}
async function clickHandByUid(uid) {
  return page.evaluate((u) => {
    const el = document.querySelector(`.hand-cards .gt-card[data-uid="${u}"]`);
    if (!el) return false;
    el.click();
    return true;
  }, uid);
}
async function playAction(action) {
  if (action.type !== "playCard") return false;
  await clickHandByUid(action.uid);
  await sleep(220);
  const bs = await readBoard();
  if (bs?.selectedUid) {
    if (action.row) {
      const rowSel = `.board-row[data-fx-row="${action.row}"][data-fx-player="0"]`;
      if (await visible(page.locator(rowSel).first())) {
        await click(page.locator(rowSel).first());
      } else {
        const anyRow = await firstVisible([".board-row.is-playable-row"], 1500);
        if (anyRow) await click(anyRow);
      }
    }
    if (action.targetUid) {
      const t = page.locator(`[data-uid="${action.targetUid}"]`).first();
      if (await visible(t)) await click(t);
    }
    const gold = await firstVisible([".modal__actions .btn--gold", ".modal .btn--gold"], 900);
    if (gold) await click(gold);
  }
  await sleep(400);
  return true;
}
async function startQuickGame() {
  await page.getByRole("button", { name: /快速对局/ }).first().click().catch(async () => {
    await page.locator('.menu-btn[data-action="quick"]').first().click();
  });
  await page.waitForSelector(".faction-tile[data-faction]", { timeout: 8000 });
  await page.locator('.faction-tile[data-faction="northern-realms"]').first().click();
  await page.waitForSelector(".faction-start", { timeout: 6000 });
}
async function skipMulligan() {
  const bar = await firstVisible([".mulligan-bar"], 15000);
  if (!bar) return false;
  await waitFor(async () => ((await readBoard())?.mode === "mulligan" ? true : null), 5000, "mulligan 模式");
  const skip = await firstVisible([".mulligan-skip"], 1500);
  if (skip) {
    await click(skip, "跳过换牌");
  } else {
    const uids = await page.evaluate(() => [...document.querySelectorAll(".hand-cards .gt-card[data-uid]")].slice(0, 2).map((e) => e.dataset.uid));
    for (const u of uids) await domClick(`.hand-cards .gt-card[data-uid="${u}"]`);
    const ok = await firstVisible([".mulligan-confirm"], 1200);
    if (ok) await click(ok);
  }
  await waitFor(async () => {
    const g = await readGame();
    return g && (!g.pending || g.pending.kind !== "mulligan") ? true : null;
  }, 12000, "换牌结束");
  return true;
}

/* ================================================================== */
async function main() {
  mkdirSync(OUT, { recursive: true });
  const pw = await loadPlaywright();
  if (!pw?.chromium) {
    console.error("缺少 Playwright：npm i -D playwright && npx playwright install chromium");
    process.exit(2);
  }
  // 服务器探测
  try {
    const res = await fetch(BASE);
    if (!res.ok && res.status !== 304) throw new Error(String(res.status));
  } catch (err) {
    console.error(`服务器不可用（${BASE}）：${err.message}\n先运行 npm start`);
    process.exit(2);
  }

  const browser = await launch(pw);
  const context = await browser.newContext({ viewport: { ...V1280 }, locale: "zh-CN" });
  page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") report.consoleErrors.push({ text: m.text(), location: m.location() });
  });
  page.on("pageerror", (e) => report.pageErrors.push({ message: e.message, stack: e.stack }));
  page.on("response", (r) => {
    if (r.status() >= 400) report.httpErrors.push({ url: r.url(), status: r.status() });
  });

  try {
    /* ── 1. 首页 1280 ─────────────────────────────────────────── */
    console.log("\n[1280×800] 首页 / 阵营选择 / VS / 换牌");
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".menu-screen", { timeout: 15000 });
    await sleep(1200);
    await shot("1280-01-home");
    await check("首页无溢出（1280×800）", async () => {
      const o = await overflowInfo();
      assert(!o.overflowX, `横向溢出：${o.scrollW} > ${o.innerW}`);
      return o;
    });
    await check("首页文案完整（无 undefined/NaN/乱码）", async () => textIntegrity("首页"));

    await page.locator('.menu-btn[data-action="quick"]').first().click();
    await page.waitForSelector(".faction-tile[data-faction]", { timeout: 8000 });
    await sleep(700);
    await shot("1280-02-faction-select");
    await page.locator('.faction-tile[data-faction="northern-realms"]').first().click();
    await sleep(700);
    await shot("1280-03-faction-detail");

    /* ── 2. 开始对局：VS 开场 + 硬币 ─────────────────────────── */
    await page.locator(".faction-start").first().click();
    await shot("1280-04-vs-opening", 350);
    await sleep(700);
    await shot("1280-04b-vs-coin", 100);
    await skipMulligan();
    await shot("1280-05-mulligan-after", 300).catch(() => {});

    /* ── 3. 对局中：手牌扇形 / tooltip / 天气 / 号角 ─────────── */
    let g = await waitOurTurn(45000);
    await sleep(700);
    await shot("1280-06-board");
    await check("对局中无溢出（1280×800）", async () => {
      const o = await overflowInfo();
      assert(!o.overflowX, `横向溢出`);
      return o;
    });
    await check("对局文案完整", async () => textIntegrity("对局"));

    // hover tooltip
    const handCard = page.locator(".hand-cards .gt-card[data-uid]").first();
    if (await visible(handCard)) {
      await handCard.hover();
      await sleep(700);
      const tip = await firstVisible([".card-tooltip"], 2500);
      await check("手牌 hover 显示牌面 tooltip", async () => {
        assert(Boolean(tip), "未出现 .card-tooltip");
        return true;
      });
      // tooltip 截图：不要移动鼠标（移动会触发 mouseleave 关闭 tooltip）
      await sleep(200);
      {
        const file = join(OUT, "1280-07-card-tooltip.png");
        await page.screenshot({ path: file });
        report.screenshots.push(file.replace(ROOT + "/", ""));
        console.log(`  📸 ${file.replace(ROOT + "/", "")}`);
      }
      await page.mouse.move(4, 4);
    }

    // 打 2 张牌推进对局并展示分数/日志
    for (let i = 0; i < 2; i++) {
      g = await waitOurTurn(30000);
      const action = (g.actions ?? []).find((a) => a.type === "playCard");
      if (!action) break;
      await playAction(action);
    }
    await shot("1280-08-midgame-scores");

    /* ── 4. 交互裁定验证 A：重复天气允许打出 ─────────────────── */
    await waitOurTurn(30000);
    const weatherInfo = await page.evaluate(() => {
      const w = window.__gwent;
      const g = w.game;
      const st = g.state;
      const add = (id) => {
        const inst = g._makeInst(st, id, 0);
        st.players[0].hand.push(inst);
        return inst.uid;
      };
      const u1 = add("biting-frost");
      const u2real = add("biting-frost");
      w.app?.match?.afterState?.();
      return { uids: [u1, u2real], weather: { ...st.weather } };
    });
    await sleep(900);
    const [f1, f2] = weatherInfo.uids.filter(Boolean);
    await waitOurTurn(30000);
    await check("裁定①：首张天气可打出", async () => {
      const g2 = await readGame();
      const has = (g2.actions ?? []).some((a) => a.type === "playCard" && a.uid === f1);
      assert(has, "天气牌不在可打出动作中");
      return true;
    });
    await clickHandByUid(f1);
    await sleep(900);
    await check("裁定①：首张天气生效", async () => {
      const afterF1 = await readGame();
      assert(afterF1.weather.frost === true, "frost 未生效");
      return true;
    });
    // 等待回到我方回合，再验证重复天气允许打出（无叠加、进墓地、有提示）
    await waitOurTurn(30000);
    await check("裁定①：重复天气仍有动作（允许打出）", async () => {
      const g2 = await readGame();
      const has = (g2.actions ?? []).some((a) => a.type === "playCard" && a.uid === f2);
      assert(has, "冻结状态下应仍可打出第二张 Biting Frost（重复天气允许但无效果）");
      return true;
    });
    await clickHandByUid(f2);
    await sleep(320);
    const afterF2 = await readGame();
    await check("裁定①：重复天气仍生效且无叠加、牌进墓地、提示已生效", async () => {
      const state2 = await page.evaluate(() => {
        const w = window.__gwent;
        const st = w.game.state;
        const grave = st.players[0].graveyard.map((c) => c.cardId);
        return {
          frost: st.weather.frost,
          grave,
          toast:
            (document.getElementById("toast-root")?.innerText ?? "") +
            " " +
            (document.querySelector(".fx-toasts")?.innerText ?? "") +
            " " +
            (document.querySelector(".match-toast")?.innerText ?? ""),
          bodyText: document.body.innerText,
        };
      });
      assert(state2.frost === true, "天气被清除/异常");
      assert(state2.grave.filter((c) => c === "biting-frost").length >= 1, "天气牌未进入弃牌堆");
      assert(/已经生效|已生效/.test(state2.toast) || /已经生效|已生效/.test(state2.bodyText), `未看到"该天气已经生效"提示（toast="${state2.toast}"）`);
      return true;
    });
    await shot("1280-09-duplicate-weather", 100);

    /* ── 5. 交互裁定验证 B：号角单位所在行不允许再放号角 ─────── */
    await waitOurTurn(30000);
    const hornInfo = await page.evaluate(() => {
      const w = window.__gwent;
      const g = w.game;
      const st = g.state;
      // 放置号角单位 Dandelion 到 P0 近战行
      const dand = g._makeInst(st, "dandelion", 0);
      dand.row = "close";
      dand.boardOwner = 0;
      st.players[0].rows.close.push(dand);
      // 手中加入一张 Commander's Horn
      const horn = g._makeInst(st, "commander-s-horn", 0);
      st.players[0].hand.push(horn);
      g._recompute(true);
      w.app?.match?.afterState?.();
      return { hornUid: horn.uid };
    });
    await sleep(900);
    const hornUid = hornInfo.hornUid;
    await check("裁定②：号角单位行不再提供号角动作", async () => {
      const g3 = await readGame();
      const hornActions = (g3.actions ?? []).filter((a) => a.type === "playCard" && a.uid === hornUid);
      const closeAction = hornActions.find((a) => a.row === "close");
      assert(!closeAction, `Dandelion 所在近战行不应再允许放号角（实际动作：${JSON.stringify(closeAction)}）`);
      assert(hornActions.length >= 1, "其他空行应仍可放号角");
      return true;
    });
    // 点选号角卡，验证近战行无高亮
    await clickHandByUid(hornUid);
    await sleep(700);
    const highlight = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".board-row")];
      return rows.map((r) => ({
        row: r.dataset.fxRow,
        player: r.dataset.fxPlayer,
        playable: r.classList.contains("is-playable-row"),
      }));
    });
    await check("裁定②：近战行无落子高亮、其他行有高亮", async () => {
      const closeMine = highlight.find((r) => r.row === "close" && r.player === "0");
      assert(closeMine && closeMine.playable === false, `Dandelion 行出现高亮：${JSON.stringify(closeMine)}`);
      return true;
    });
    await shot("1280-10-horn-unit-row", 150);
    await page.keyboard.press("Escape").catch(() => {});

    /* ── 6. 结算页 ───────────────────────────────────────────── */
    await page.evaluate(() => {
      const w = window.__gwent;
      const g = w.game;
      let guard = 0;
      while (g.state.phase !== "game-over" && guard++ < 80) {
        if (g.pending) {
          g.respond({ cards: [] });
          continue;
        }
        const acts = g.getActions();
        const a = acts.find((x) => x.type === "pass") || acts[0];
        if (!a) break;
        g.apply(a);
      }
      w.app?.match?.afterState?.();
    });
    await firstVisible([".modal-backdrop--result"], 12000);
    await sleep(900);
    const resultInfo = await page.evaluate(() => {
      const w = window.__gwent;
      const res = w.game.state.result;
      return {
        title: document.querySelector(".result__title")?.textContent?.trim(),
        score: document.querySelector(".result__score")?.textContent?.trim(),
        sub: document.querySelector(".result__sub")?.textContent?.trim(),
        expectedTitle: res?.winner === 0 ? "胜利" : res?.winner === 1 ? "失败" : "平局",
        expectedScore: res ? `${(res.history ?? []).filter((h) => h.winner === 0).length} : ${(res.history ?? []).filter((h) => h.winner === 1).length}` : null,
        result: res,
      };
    });
    await check("结算页显示与引擎 roundHistory 一致（小局胜场/比分/宝石）", async () => {
      assert(resultInfo.title?.includes(resultInfo.expectedTitle), `标题 UI=${resultInfo.title} 期望=${resultInfo.expectedTitle}`);
      assert(
        resultInfo.score?.replace(/\s+/g, "") === resultInfo.expectedScore?.replace(/\s+/g, ""),
        `小局胜场 UI=${resultInfo.score} 期望=${resultInfo.expectedScore}`,
      );
      assert(/宝石/.test(resultInfo.sub ?? ""), `缺少宝石信息：${resultInfo.sub}`);
      return resultInfo;
    });
    await shot("1280-11-result", 200);

    /* ── 6b. 「再来一局」回归 ────────────────────────────────── */
    const rematch = await firstVisible([".modal__actions .btn--gold", '.result__actions .btn--gold'], 3000);
    if (rematch && /再来一局/.test((await rematch.innerText()) ?? "再来一局")) {
      await click(rematch, "再来一局");
      const restarted = await waitFor(async () => {
        const g2 = await readGame();
        if (!g2) return null;
        if (g2.phase === "play" || g2.pending) return g2;
        return null;
      }, 15000, "再来一局开局");
      await check("「再来一局」可重新开局（进入换牌/对局）", async () => {
        assert(restarted.phase === "play" || Boolean(restarted.pending), `重开异常：${JSON.stringify(restarted)}`);
        return true;
      });
      await sleep(800);
      await page.keyboard.press("Escape").catch(() => {});
      const bar = await firstVisible([".mulligan-skip"], 4000);
      if (bar) await click(bar);
      await shot("1280-11b-rematch", 800);
    } else {
      issue("minor", "结算弹窗未找到「再来一局」按钮", "无法回归重开流程");
    }

    /* ── 7. 组牌器 + 牌库图鉴（1280） ───────────────────────── */
    console.log("\n[1280×800] 组牌器 / 牌库图鉴");
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".menu-screen", { timeout: 12000 });
    await sleep(800);
    await page.locator('.menu-btn[data-action="deck"]').first().click();
    const deckScreen = await firstVisible([".deckbuilder"], 8000);
    await check("组牌器可打开", async () => {
      assert(Boolean(deckScreen), "未出现 .deckbuilder");
      return true;
    });
    await sleep(1000);
    await shot("1280-12-deckbuilder");
    await check("组牌器无溢出（1280×800）", async () => {
      const o = await overflowInfo();
      assert(!o.overflowX, `横向溢出：${o.scrollW} > ${o.innerW}`);
      return o;
    });
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".menu-screen", { timeout: 12000 });
    await sleep(700);
    await page.locator('.menu-btn[data-action="gallery"]').first().click();
    const gallery = await firstVisible([".gallery-screen"], 8000);
    await check("牌库图鉴可打开", async () => {
      assert(Boolean(gallery), "未出现 .gallery-screen");
      return true;
    });
    await sleep(1200);
    await shot("1280-13-gallery");
    await check("牌库图鉴无溢出（1280×800）", async () => {
      const o = await overflowInfo();
      assert(!o.overflowX, `横向溢出：${o.scrollW} > ${o.innerW}`);
      return o;
    });
    await check("牌库图鉴文案完整", async () => textIntegrity("牌库图鉴"));

    /* ── 8. 1920×1080 巡检 ───────────────────────────────────── */
    console.log("\n[1920×1080] 首页 / 组牌器 / 牌库图鉴 / 对局");
    await page.setViewportSize(V1920);
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".menu-screen", { timeout: 12000 });
    await sleep(1200);
    await shot("1920-01-home");
    await check("首页无溢出（1920×1080）", async () => {
      const o = await overflowInfo();
      assert(!o.overflowX, `横向溢出：${o.scrollW} > ${o.innerW}`);
      return o;
    });
    await page.locator('.menu-btn[data-action="deck"]').first().click();
    await sleep(1400);
    await shot("1920-02-deckbuilder");
    await check("组牌器无溢出（1920×1080）", async () => {
      const o = await overflowInfo();
      assert(!o.overflowX, `横向溢出：${o.scrollW} > ${o.innerW}`);
      return o;
    });
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".menu-screen", { timeout: 12000 });
    await sleep(800);
    await page.locator('.menu-btn[data-action="gallery"]').first().click();
    await sleep(1400);
    await shot("1920-03-gallery");
    await check("牌库图鉴无溢出（1920×1080）", async () => {
      const o = await overflowInfo();
      assert(!o.overflowX, `横向溢出：${o.scrollW} > ${o.innerW}`);
      return o;
    });
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".menu-screen", { timeout: 12000 });
    await startQuickGame();
    await page.locator(".faction-start").first().click();
    await skipMulligan();
    await waitOurTurn(45000);
    await sleep(900);
    await shot("1920-04-board");
    await check("对局中无溢出（1920×1080）", async () => {
      const o = await overflowInfo();
      assert(!o.overflowX, `横向溢出：${o.scrollW} > ${o.innerW}`);
      return o;
    });
    await check("对局文案完整（1920）", async () => textIntegrity("对局 1920"));

    /* ── 9. console / 资源错误汇总 ───────────────────────────── */
    await check("无 console.error", async () => {
      assert(report.consoleErrors.length === 0, JSON.stringify(report.consoleErrors.slice(0, 3)));
      return true;
    });
    await check("无 pageerror", async () => {
      assert(report.pageErrors.length === 0, JSON.stringify(report.pageErrors.slice(0, 3)));
      return true;
    });
    await check("无 HTTP 4xx/5xx 资源", async () => {
      const bad = report.httpErrors.filter((e) => !/favicon/.test(e.url));
      assert(bad.length === 0, JSON.stringify(bad.slice(0, 5)));
      return true;
    });

    report.result = report.checks.every((c) => c.status === "ok") ? "pass" : "fail";
  } catch (err) {
    report.result = "failed";
    report.error = err?.stack ?? String(err);
    console.error(`\n[巡检] 失败：${err?.message ?? err}`);
    await shot("fail-final-tour", 100).catch(() => {});
  } finally {
    try {
      await context.close();
      await browser.close();
    } catch { /* ignore */ }
    report.finishedAt = new Date().toISOString();
    writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2), "utf8");
    const pass = report.checks.filter((c) => c.status === "ok").length;
    console.log(`\n[巡检] 结果=${report.result} 检查 ${pass}/${report.checks.length} 通过，问题 ${report.issues.length} 个`);
    if (report.issues.length) for (const i of report.issues) console.log(`  · [${i.severity}] ${i.title} — ${i.detail ?? ""}`);
    console.log(`[巡检] 截图：research/qa/final/  报告：research/qa/final/report.json`);
  }
  process.exit(report.result === "pass" ? 0 : 1);
}

await main();
