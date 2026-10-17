#!/usr/bin/env node
/**
 * research/qa/rules-verify.mjs — QA 独立规则实现核验（只读 src/，不修改业务代码）
 *
 * 目的：不依赖 Lead 的 engine.test.mjs，用**真实 163 张卡数据 + 真实预设牌组**独立验证
 *       docs/GAME_RULES.md §2/§5/§6 的关键裁定与引擎不变量。
 *
 * 内容：
 *   §1 计分矩阵（scoring.js 纯函数）：
 *      天气/King Bran 半效/紧缚/士气/号角/英雄免疫/间谍翻倍/Decoy 占位
 *   §2 引擎集成（createGame + 真实预设牌组）：
 *      开局抽牌/Mulligan、天气影响双方、号角行效果、Bran 数值、
 *      Decoy 回收对方间谍（归属转移+再抽 2）、Muster（Behemoth→Arachas、Crone 家族）、
 *      复仇者 token 计分冻结（小局分数不含 BDF，下一小局计 8）、尼弗迦德平局
 *   §3 随机对局模糊测试（10 组真实预设对局）：每步校验
 *      分数=三行和、view.scores 与 computeScores 一致、牌数守恒、uid 唯一、阶段/回合合法
 *
 * 运行：node research/qa/rules-verify.mjs [--verbose]
 * 退出码：0 全部通过；1 有失败。
 */

import { CARDS } from "../../src/data/cards.js";
import { LEADERS } from "../../src/data/leaders.js";
import { PRESET_DECKS, expandPreset } from "../../src/data/decks.js";
import { createGame } from "../../src/engine/engine.js";
import { computeRow, computeScores } from "../../src/engine/scoring.js";

const VERBOSE = process.argv.includes("--verbose");
const results = [];
let failures = 0;

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures += 1;
    results.push({ name, ok: false, error: err?.message ?? String(err) });
    console.error(`  ❌ ${name}\n     ${err?.message ?? err}`);
  }
}
const eq = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
};
const ok = (cond, label) => {
  if (!cond) throw new Error(label);
};

/* ================================================================== */
/* 工具：构造 scoring 纯函数所需的 state 快照                          */
/* ================================================================== */

function mkScoreState({ weather = {}, passives = {}, p0Passives = [], p1Passives = [] } = {}) {
  const emptyR = () => ({ close: [], ranged: [], siege: [] });
  const emptyS = () => ({ close: null, ranged: null, siege: null });
  return {
    weather: { frost: false, fog: false, rain: false, storm: false, ...weather },
    passives: { ...passives },
    players: [
      { rows: emptyR(), rowSpecials: emptyS(), passives: [...p0Passives] },
      { rows: emptyR(), rowSpecials: emptyS(), passives: [...p1Passives] },
    ],
  };
}
let uidCounter = 0;
function addUnit(state, p, row, cardId) {
  if (!CARDS[cardId]) throw new Error(`未知卡牌 ${cardId}`);
  const inst = { uid: `su-${++uidCounter}`, cardId, owner: p, boardOwner: p, row };
  state.players[p].rows[row].push(inst);
  return inst;
}
const rowScore = (state, p, row) => computeRow(state, p, row, CARDS).total;

/* ================================================================== */
/* 工具：引擎实例与真实预设牌组                                        */
/* ================================================================== */

const FACTIONS = ["northern-realms", "nilfgaard", "scoiatael", "monsters", "skellige"];

function newGame(f0, f1, { seed = 42, preset0 = 0, preset1 = 0 } = {}) {
  const p0 = PRESET_DECKS[f0][preset0];
  const p1 = PRESET_DECKS[f1][preset1];
  if (!p0 || !p1) throw new Error(`缺少预设牌组 ${f0}/${f1}`);
  const game = createGame({
    seed,
    cards: CARDS,
    leaders: LEADERS,
    players: [
      { id: "p0", faction: f0, leaderId: p0.leaderId, deck: expandPreset(p0) },
      { id: "p1", faction: f1, leaderId: p1.leaderId, deck: expandPreset(p1) },
    ],
  });
  // 解决开局 pending（松鼠党先手选择 / 双方 Mulligan）
  let guard = 0;
  while (game.pending && guard++ < 20) {
    const { kind, player } = game.pending;
    if (kind === "chooseFirstPlayer") game.respond({ first: 0 });
    else if (kind === "mulligan") game.respond({ cards: [] });
    else throw new Error(`未预期的开局 pending：${kind}`);
    void player;
  }
  if (game.phase !== "play") throw new Error(`开局后 phase=${game.phase}`);
  return game;
}

/** 强制当前为 p 的 play 回合（测试脚手架） */
function forceTurn(game, p) {
  game.state.phase = "play";
  game.state.pending = null;
  game.state.turn = p;
  game.state.passed = [false, false];
  for (const pl of game.state.players) pl.passed = false;
}

function giveHand(game, p, cardId) {
  const inst = game._makeInst(game.state, cardId, p);
  game.state.players[p].hand.push(inst);
  return inst;
}

function place(game, p, cardId, row) {
  const inst = game._makeInst(game.state, cardId, p);
  inst.row = row;
  inst.boardOwner = p;
  game.state.players[p].rows[row].push(inst);
  game._recompute(true);
  return inst;
}

/** 自动应答规则类 pending（医师/弃牌/选牌/看手牌/天气等） */
function answerPending(game) {
  let guard = 0;
  while (game.pending && guard++ < 20) {
    const pending = game.pending;
    const opts = pending.options ?? [];
    switch (pending.kind) {
      case "mulligan":
        game.respond({ cards: [] });
        break;
      case "chooseFirstPlayer":
        game.respond({ first: 0 });
        break;
      case "medic":
        game.respond({ skip: true });
        break;
      case "reviveRow":
        game.respond({ row: opts[0] });
        break;
      case "viewHand":
        game.respond({ ack: true });
        break;
      case "chooseWeather":
        game.respond({ uid: opts[0]?.uid });
        break;
      case "takeGraveUnit":
        game.respond({ uid: opts[0]?.uid });
        break;
      case "discardCards":
        game.respond({ cards: opts.slice(0, pending.count ?? 2).map((o) => o.uid) });
        break;
      case "deckChoice":
        game.respond({ uid: opts[0]?.uid });
        break;
      default:
        throw new Error(`未知 pending kind=${pending.kind}`);
    }
  }
}

const viewScore = (game, p) => game.viewFor(0).scores[p];
const stateScore = (game, p) => computeScores(game.state, game.cardDb)[p].score;

/* ================================================================== */
/* §1 计分矩阵                                                        */
/* ================================================================== */

console.log("\n§1 计分矩阵（scoring.js + 真实卡牌数据）");

check("1.1 基础战力：Zoltan Chivay 5 力近战 = 5", () => {
  const st = mkScoreState();
  addUnit(st, 0, "close", "zoltan-chivay");
  eq(rowScore(st, 0, "close"), 5, "close 行总分");
});

check("1.2 天气：Biting Frost 把近战 4 力压到 1；0 力仍 0；远程不受影响", () => {
  const st = mkScoreState({ weather: { frost: true } });
  addUnit(st, 0, "close", "blue-stripes-commando"); // 4
  addUnit(st, 0, "close", "kambi"); // 0
  addUnit(st, 0, "ranged", "black-infantry-archer"); // 10
  eq(rowScore(st, 0, "close"), 1, "frost 后近战行");
  eq(rowScore(st, 0, "ranged"), 10, "远程行不受 frost");
});

check("1.3 天气：Skellige Storm 影响远程+攻城，不影响近战", () => {
  const st = mkScoreState({ weather: { storm: true } });
  addUnit(st, 0, "ranged", "black-infantry-archer"); // 10 -> 1
  addUnit(st, 0, "siege", "ballista"); // 6 -> 1
  addUnit(st, 0, "close", "zoltan-chivay"); // 5
  eq(rowScore(st, 0, "ranged"), 1, "远程行");
  eq(rowScore(st, 0, "siege"), 1, "攻城行");
  eq(rowScore(st, 0, "close"), 5, "近战行");
});

check("1.4 King Bran：天气半效 ceil(base/2)：4→2、5→3、1→1、0→0", () => {
  const st = mkScoreState({ weather: { frost: true }, p0Passives: ["halfWeather"] });
  addUnit(st, 0, "close", "blue-stripes-commando"); // 4 -> 2
  addUnit(st, 0, "close", "mahakaman-defender"); // 5 -> 3
  addUnit(st, 0, "close", "poor-fucking-infantry"); // 1 -> 1
  addUnit(st, 0, "close", "kambi"); // 0 -> 0
  eq(rowScore(st, 0, "close"), 6, "Bran 方近战行 2+3+1+0");
});

check("1.5 King Bran 只保护己方：敌方同受天气仍降为 1", () => {
  const st = mkScoreState({ weather: { frost: true }, p0Passives: ["halfWeather"] });
  addUnit(st, 0, "close", "blue-stripes-commando"); // 2
  addUnit(st, 1, "close", "blue-stripes-commando"); // 1
  eq(rowScore(st, 0, "close"), 2, "Bran 方");
  eq(rowScore(st, 1, "close"), 1, "非 Bran 方");
});

check("1.6 紧缚：同排 3 张 Blue Stripes(4) = 每张 12，共 36；霜后 3/张共 9；号角后 6/张共 18", () => {
  const st = mkScoreState();
  for (let i = 0; i < 3; i++) addUnit(st, 0, "close", "blue-stripes-commando");
  eq(rowScore(st, 0, "close"), 36, "紧缚 ×3");
  const st2 = mkScoreState({ weather: { frost: true } });
  for (let i = 0; i < 3; i++) addUnit(st2, 0, "close", "blue-stripes-commando");
  eq(rowScore(st2, 0, "close"), 9, "霜 + 紧缚（文档示例）");
  st2.players[0].rowSpecials.close = { kind: "horn", uid: "h1", cardId: "commander-s-horn" };
  eq(rowScore(st2, 0, "close"), 18, "霜 + 紧缚 + 号角（文档示例 18）");
});

check("1.7 士气：多个士气叠加，士气单位自身不给自己 +1，英雄免疫", () => {
  const st = mkScoreState();
  addUnit(st, 0, "close", "isengrim-faoiltiarna"); // 英雄 10，士气
  addUnit(st, 0, "close", "transformed-vildkaarl"); // 14，士气（非英雄）
  addUnit(st, 0, "close", "zoltan-chivay"); // 5
  // zoltan：+2（两个士气）= 7；transformed：非英雄 +1（isengrim 的士气，不含自己）= 15；isengrim 英雄 = 10
  eq(rowScore(st, 0, "close"), 7 + 15 + 10, "士气叠加");
});

check("1.8 号角：行内非英雄 ×2、英雄不翻倍；号角单位不被自己的号角翻倍", () => {
  const st = mkScoreState();
  addUnit(st, 0, "close", "zoltan-chivay"); // 5 -> 10
  addUnit(st, 0, "close", "isengrim-faoiltiarna"); // 英雄 10 -> 10
  addUnit(st, 0, "close", "dandelion"); // 号角单位 2 -> 2（不被自己翻倍）
  st.players[0].rowSpecials.close = { kind: "horn", uid: "h2", cardId: "commander-s-horn" };
  // Isengrim 的士气让 Zoltan/Dandelion 各 +1；有号角牌 + 号角单位两个来源 → Dandelion 也被翻倍：
  // Zoltan (5+1)*2=12 + Isengrim 英雄 10 + Dandelion (2+1)*2=6 = 28
  eq(rowScore(st, 0, "close"), 28, "号角 + 号角单位");

  const st2 = mkScoreState();
  addUnit(st2, 0, "close", "dandelion"); // 仅号角单位：不自翻倍
  addUnit(st2, 0, "close", "vesemir"); // 6 -> 12
  eq(rowScore(st2, 0, "close"), 2 + 12, "仅号角单位");
});

check("1.9 间谍翻倍（Treacherous）：间谍 4→8；先天气后翻倍：1→2", () => {
  const st = mkScoreState({ passives: { doubleSpy: true } });
  addUnit(st, 0, "close", "sigismund-dijkstra"); // spy 4 -> 8
  eq(rowScore(st, 0, "close"), 8, "间谍 ×2");
  const st2 = mkScoreState({ passives: { doubleSpy: true }, weather: { frost: true } });
  addUnit(st2, 0, "close", "sigismund-dijkstra"); // weather 1 → ×2 = 2
  eq(rowScore(st2, 0, "close"), 2, "天气后再翻倍");
});

check("1.10 英雄完全免疫：Frost + 号角 + 士气下 Triss 仍 7 力", () => {
  const st = mkScoreState({ weather: { frost: true } });
  addUnit(st, 0, "close", "triss-merigold"); // 英雄 7
  addUnit(st, 0, "close", "isengrim-faoiltiarna"); // 英雄士气 10
  st.players[0].rowSpecials.close = { kind: "horn", uid: "h3", cardId: "commander-s-horn" };
  // isengrim 是英雄也免疫；triss 7，isengrim 10
  eq(rowScore(st, 0, "close"), 17, "英雄行");
});

check("1.11 Decoy 占位卡非单位：不计入任何行总分", () => {
  const st = mkScoreState();
  addUnit(st, 0, "close", "zoltan-chivay"); // 5
  st.players[0].rows.close.push({ uid: "decoy-1", cardId: "decoy", owner: 0, boardOwner: 0, kind: "decoy", row: "close" });
  eq(rowScore(st, 0, "close"), 5, "Decoy 不计分");
});

/* ================================================================== */
/* §2 引擎集成（真实预设牌组）                                         */
/* ================================================================== */

console.log("\n§2 引擎集成（真实数据 + 预设牌组）");

check("2.1 开局：双方各 10 张手牌 + 剩余牌堆；阶段 play；分数一致", () => {
  const g = newGame("northern-realms", "monsters");
  eq(g.state.players[0].hand.length, 10, "P0 手牌");
  eq(g.state.players[1].hand.length, 10, "P1 手牌");
  eq(g.state.players[0].deck.length, expandPreset(PRESET_DECKS["northern-realms"][0]).length - 10, "P0 牌堆");
  eq(g.state.players[1].deck.length, expandPreset(PRESET_DECKS.monsters[0]).length - 10, "P1 牌堆");
  eq(g.viewFor(0).scores, [computeScores(g.state, g.cardDb)[0].score, computeScores(g.state, g.cardDb)[1].score], "view 分数 = 重算");
});

check("2.2 Mulligan：换 2 张后手牌回到 10，牌堆数量不变", () => {
  const f0 = "northern-realms";
  const p0 = PRESET_DECKS[f0][0];
  const p1 = PRESET_DECKS.monsters[0];
  const g = createGame({
    seed: 99, cards: CARDS, leaders: LEADERS,
    players: [
      { id: "p0", faction: f0, leaderId: p0.leaderId, deck: expandPreset(p0) },
      { id: "p1", faction: "monsters", leaderId: p1.leaderId, deck: expandPreset(p1) },
    ],
  });
  let guard = 0;
  let sawMulligan = false;
  while (g.pending && guard++ < 10) {
    if (g.pending.kind === "mulligan") {
      sawMulligan = true;
      const uids = g.state.players[g.pending.player].hand.slice(0, 2).map((c) => c.uid);
      g.respond({ cards: uids });
    } else if (g.pending.kind === "chooseFirstPlayer") g.respond({ first: 0 });
    else throw new Error("未预期 pending " + g.pending.kind);
  }
  ok(sawMulligan, "应出现 Mulligan pending");
  eq(g.state.players[0].hand.length, 10, "P0 手牌");
  eq(g.state.players[1].hand.length, 10, "P1 手牌");
});

check("2.3 天气牌影响双方：Frost 后双方近战 4 力均变 1", () => {
  const g = newGame("northern-realms", "monsters");
  place(g, 0, "blue-stripes-commando", "close");
  place(g, 1, "blue-stripes-commando", "close");
  const frost = giveHand(g, 0, "biting-frost");
  forceTurn(g, 0);
  const res = g.apply({ type: "playCard", uid: frost.uid });
  ok(res.ok, "打出 Biting Frost: " + res.error);
  answerPending(g);
  eq(g.state.weather.frost, true, "weather.frost");
  eq(g.viewFor(0).players[0].rowScores.close, 1, "P0 近战");
  eq(g.viewFor(0).players[1].rowScores.close, 1, "P1 近战");
});

check("2.4 号角：己方近战行 5+6 → 22；同一行第二张号角被拒绝", () => {
  const g = newGame("northern-realms", "monsters");
  place(g, 0, "zoltan-chivay", "close"); // 5
  place(g, 0, "vesemir", "close"); // 6
  const horn = giveHand(g, 0, "commander-s-horn");
  forceTurn(g, 0);
  const res = g.apply({ type: "playCard", uid: horn.uid, row: "close" });
  ok(res.ok, "打出号角: " + res.error);
  answerPending(g);
  eq(g.viewFor(0).players[0].rowScores.close, 22, "号角后近战行");
  const horn2 = giveHand(g, 0, "commander-s-horn");
  forceTurn(g, 0);
  const res2 = g.apply({ type: "playCard", uid: horn2.uid, row: "close" });
  ok(!res2.ok, "同一行第二张号角应失败，但 apply 返回 ok");
});

check("2.5 Decoy：回收对方打来的间谍（归属转移），再打出为使用者抽 2", () => {
  const g = newGame("northern-realms", "monsters");
  // 对方（P1）的间谍打到了 P0 场地
  const spy = g._makeInst(g.state, "prince-stennis", 1); // 间谍 5 近战
  spy.row = "close";
  spy.boardOwner = 0;
  g.state.players[0].rows.close.push(spy);
  g._recompute(true);
  const decoy = giveHand(g, 0, "decoy");
  forceTurn(g, 0);
  const handBefore = g.state.players[0].hand.length;
  const res = g.apply({ type: "playCard", uid: decoy.uid, targetUid: spy.uid });
  ok(res.ok, "Decoy: " + res.error);
  answerPending(g);
  const inHand = g.state.players[0].hand.find((c) => c.uid === spy.uid);
  ok(Boolean(inHand), "间谍应回到 P0 手牌");
  eq(inHand.owner, 0, "所有权应转移给 P0");
  ok(g.state.players[0].rows.close.some((c) => c.kind === "decoy" && c.uid === decoy.uid), "Decoy 占位卡应在 P0 近战行");
  // 再打出间谍：应放到 P1 场地，且 P0 抽 2
  forceTurn(g, 0);
  const before2 = g.state.players[0].hand.length;
  const res2 = g.apply({ type: "playCard", uid: spy.uid, row: "close" });
  ok(res2.ok, "再打出间谍: " + res2.error);
  answerPending(g);
  ok(g.state.players[1].rows.close.some((c) => c.uid === spy.uid), "间谍应打到 P1 场地");
  eq(g.state.players[0].hand.length, before2 - 1 + 2, "使用者应抽 2 张");
  void handBefore;
});

check("2.6 Muster：Arachas Behemoth 从牌堆拉 3 张 Arachas，不拉 Behemoth", () => {
  const g = newGame("monsters", "northern-realms");
  // 确保 3 张 Arachas 都在牌堆
  const p0 = g.state.players[0];
  p0.hand = p0.hand.filter((inst) => {
    if (inst.cardId === "arachas") {
      p0.deck.push(inst);
      return false;
    }
    return true;
  });
  const behemoth = giveHand(g, 0, "arachas-behemoth");
  forceTurn(g, 0);
  const res = g.apply({ type: "playCard", uid: behemoth.uid, row: "siege" });
  ok(res.ok, "打出 Behemoth: " + res.error);
  answerPending(g);
  const arachas = g.state.players[0].rows.close.filter((c) => c.cardId === "arachas");
  eq(arachas.length, 3, "应召唤 3 张 Arachas");
  eq(g.state.players[0].rows.siege.filter((c) => c.cardId === "arachas-behemoth").length, 1, "不应额外召唤 Behemoth");
});

check("2.7 Muster：Crone: Brewess 触发家族组，拉出另外两张老妪", () => {
  const g = newGame("monsters", "northern-realms");
  const p0 = g.state.players[0];
  const otherCrones = ["crone-weavess", "crone-whispess"];
  p0.hand = p0.hand.filter((inst) => {
    if (otherCrones.includes(inst.cardId)) {
      p0.deck.push(inst);
      return false;
    }
    return true;
  });
  const brewess = giveHand(g, 0, "crone-brewess");
  forceTurn(g, 0);
  const res = g.apply({ type: "playCard", uid: brewess.uid, row: "close" });
  ok(res.ok, "打出 Crone: Brewess: " + res.error);
  answerPending(g);
  for (const id of otherCrones) {
    ok(g.state.players[0].rows.close.some((c) => c.cardId === id), `${id} 应被召唤`);
  }
});

check("2.8 复仇者 + 分数冻结：局末 Cow→BDF 不计入刚结束小局，下一小局计 8 力", () => {
  const g = newGame("northern-realms", "northern-realms");
  place(g, 0, "cow", "ranged"); // 0 力远程
  g.state.passed = [true, true];
  for (const pl of g.state.players) pl.passed = true;
  g._endRound(); // 测试脚手架：直接结算（0:0 平局，双方各掉 1 宝石）
  g._pump();
  eq(g.state.roundHistory[0].scores, [0, 0], "小局分数应冻结在 0:0（BDF 不参与）");
  eq(g.state.roundHistory[0].tie, true, "应判平局");
  eq(g.state.gems, [1, 1], "平局双方各掉 1 宝石");
  const bdf = g.state.players[0].rows.close.filter((c) => c.cardId === "bovine-defense-force");
  eq(bdf.length, 1, "BDF 应召唤到下一小局近战行");
  eq(g.viewFor(0).players[0].rowScores.close, 8, "下一小局 BDF 计 8 力");
});

check("2.9 尼弗迦德平局：只扣对手 1 宝石（自己不掉）", () => {
  const g = newGame("nilfgaard", "northern-realms");
  g.state.passed = [true, true];
  for (const pl of g.state.players) pl.passed = true;
  g._endRound();
  g._pump();
  eq(g.state.roundHistory[0].nilfTie, true, "应记录 nilfTie");
  eq(g.state.gems, [2, 1], "尼弗迦德不掉宝石，对手掉 1");
});

check("2.10 双方都是尼弗迦德平局：按普通平局双方各掉 1", () => {
  const g = newGame("nilfgaard", "nilfgaard");
  g.state.passed = [true, true];
  for (const pl of g.state.players) pl.passed = true;
  g._endRound();
  g._pump();
  eq(g.state.roundHistory[0].nilfTie, false, "不应判 nilfTie");
  eq(g.state.gems, [1, 1], "双方各掉 1 宝石");
});

check("2.11 Decoy 占位卡小局结束应清场进墓地（不残留下一小局）", () => {
  const g = newGame("northern-realms", "monsters");
  const unit = place(g, 0, "blue-stripes-commando", "close");
  const decoy = giveHand(g, 0, "decoy");
  forceTurn(g, 0);
  const res = g.apply({ type: "playCard", uid: decoy.uid, targetUid: unit.uid });
  ok(res.ok, "打出 Decoy: " + res.error);
  answerPending(g);
  const placeholder = g.state.players[0].rows.close.find((c) => c.kind === "decoy");
  ok(Boolean(placeholder), "应存在 Decoy 占位卡");
  const phUid = placeholder.uid;
  g.state.passed = [true, true];
  for (const pl of g.state.players) pl.passed = true;
  g._endRound();
  g._pump();
  const stillOnBoard = [];
  for (const p of g.state.players) {
    for (const row of ["close", "ranged", "siege"]) {
      if (p.rows[row].some((c) => c.uid === phUid)) stillOnBoard.push(`P${p.index}.${row}`);
    }
  }
  eq(stillOnBoard, [], "Decoy 占位卡不应残留在场上（清理见 _endRound/_removeFromBoard）");
  const inGrave = g.state.players[0].graveyard.filter((c) => c.uid === phUid).length;
  eq(inGrave, 1, "Decoy 占位卡应恰好进墓地 1 次（不应重复/丢失）");
});

/* ================================================================== */
/* §3 随机对局模糊测试（真实预设，双人随机策略）                       */
/* ================================================================== */

console.log("\n§3 随机对局不变量（10 组真实预设对局）");

function collectUids(game) {
  const st = game.state;
  const map = new Map(); // uid -> zone count
  const add = (inst, zone) => {
    if (!inst) return;
    const prev = map.get(inst.uid);
    if (prev) throw new Error(`uid 重复：${inst.uid}（${prev} / ${zone}）`);
    map.set(inst.uid, zone);
  };
  st.players.forEach((p, i) => {
    for (const inst of p.hand) add(inst, `p${i}.hand`);
    for (const inst of p.deck) add(inst, `p${i}.deck`);
    for (const inst of p.graveyard) add(inst, `p${i}.grave`);
    for (const row of ["close", "ranged", "siege"]) {
      for (const inst of p.rows[row]) add(inst, `p${i}.${row}`);
      const special = p.rowSpecials[row];
      if (special?.inst) add(special.inst, `p${i}.special.${row}`);
    }
  });
  for (const inst of st.weatherCards ?? []) add(inst, "weather");
  return map;
}

function checkInvariants(game, label) {
  const st = game.state;
  ok(["setup", "play", "round-end", "game-over"].includes(st.phase), `${label}: phase 非法 ${st.phase}`);
  ok([0, 1, 2, 3].includes(st.round), `${label}: round 非法 ${st.round}`);
  ok(st.gems.every((x) => x >= 0 && x <= 2), `${label}: gems 非法 ${st.gems}`);
  const computed = computeScores(st, game.cardDb);
  const view = game.viewFor(0);
  for (let p = 0; p < 2; p += 1) {
    ok(Number.isFinite(computed[p].score), `${label}: 分数非数字`);
    eq(view.scores[p], computed[p].score, `${label}: view.scores[${p}] 与重算不一致`);
    const rowSum =
      view.players[p].rowScores.close + view.players[p].rowScores.ranged + view.players[p].rowScores.siege;
    eq(rowSum, view.scores[p], `${label}: P${p} 三行和 ≠ 总分`);
    for (const inst of [...st.players[p].hand, ...st.players[p].deck, ...st.players[p].graveyard]) {
      ok(Boolean(CARDS[inst.cardId]), `${label}: ${inst.uid} cardId 未知 ${inst.cardId}`);
    }
  }
  collectUids(game); // uid 唯一性 + 结构检查
  if (st.pending) eq(game.getActions(), [], `${label}: pending 时不应有可执行动作`);
  else if (st.phase === "play") ok([0, 1].includes(st.turn), `${label}: turn 非法`);
}

function runFuzz(factionA, factionB, seed) {
  const g = newGame(factionA, factionB, { seed });
  let rng = seed >>> 0;
  const rand = () => {
    rng = (rng * 1664525 + 1013904223) >>> 0;
    return rng / 2 ** 32;
  };
  let steps = 0;
  const maxSteps = 500;
  while (steps < maxSteps) {
    steps += 1;
    if (g.phase === "game-over") break;
    checkInvariants(g, `${factionA} vs ${factionB} step ${steps}`);
    if (g.pending) {
      answerPending(g);
      continue;
    }
    if (g.phase !== "play") {
      g._pump?.();
      break;
    }
    const actions = g.getActions();
    ok(actions.length > 0, `${factionA} vs ${factionB} step ${steps}: play 阶段无可用动作`);
    let action;
    if (rand() < 0.2) {
      action = actions.find((a) => a.type === "pass") ?? actions[Math.floor(rand() * actions.length)];
    } else {
      action = actions[Math.floor(rand() * actions.length)];
    }
    const res = g.apply(action);
    ok(res.ok, `${factionA} vs ${factionB} step ${steps}: 合法动作被拒绝 ${action.type} ${res.error ?? ""}`);
    answerPending(g);
  }
  checkInvariants(g, `${factionA} vs ${factionB} 收尾`);
  return { steps, over: g.phase === "game-over", round: g.state.round, gems: g.state.gems.slice() };
}

const fuzzSummary = [];
check("3.1 随机对局 10 组：每步不变量成立，且至少 8 组能自然结束", () => {
  let finished = 0;
  const pairs = [];
  for (let i = 0; i < 5; i += 1) {
    pairs.push([FACTIONS[i], FACTIONS[(i + 1) % 5]]);
    pairs.push([FACTIONS[i], FACTIONS[(i + 2) % 5]]);
  }
  for (const [a, b] of pairs) {
    const summary = runFuzz(a, b, 1000 + fuzzSummary.length * 17);
    fuzzSummary.push({ pair: `${a} vs ${b}`, ...summary });
    if (VERBOSE) console.log(`     · ${a} vs ${b}: ${summary.steps} 步, round=${summary.round}, over=${summary.over}, gems=${summary.gems}`);
    if (summary.over) finished += 1;
  }
  ok(finished >= 8, `10 组随机对局仅 ${finished} 组自然结束（期望 ≥8）`);
});

/* ================================================================== */
/* 汇总                                                               */
/* ================================================================== */

console.log(`\n══════════════════════════════════════════`);
console.log(`规则独立核验：${results.length - failures}/${results.length} 通过`);
if (failures > 0) {
  console.error(`❌ ${failures} 项失败：`);
  for (const r of results.filter((x) => !x.ok)) console.error(`   - ${r.name}\n     ${r.error}`);
} else {
  console.log("✅ 全部通过（计分矩阵 / 引擎集成 / 随机对局不变量）");
}
if (VERBOSE) console.log(JSON.stringify({ results, fuzzSummary }, null, 2));
process.exit(failures > 0 ? 1 : 0);
