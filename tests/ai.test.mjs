/**
 * tests/ai.test.mjs — AI 对手测试（node --test）
 *
 * 运行：node --test tests/ai.test.mjs
 *
 * 覆盖：
 *  1. 真实卡牌数据 + PRESET_DECKS 的 AI vs AI 完整对局（各阵营组合、三档难度、固定 seed）：
 *     无异常、每步动作合法、pending 选择合法、对局能结束、步数 < 300；
 *  2. 作弊约束：把 engine.state 用 Proxy 封锁后仍能完整对局（AI 只能用 view + getActions/clone）；
 *  3. pending 全覆盖：mulligan / chooseFirstPlayer / medic / reviveRow / takeGraveUnit /
 *     discardCards / deckChoice / chooseWeather / viewHand；
 *  4. 关键启发式：单行灼烧（敌方行 ≥10）、特殊 Scorch、Pass/追分、间谍抽牌、领袖时机、Mulligan；
 *  5. 确定性（同 seed 同结果）与性能（normal 单次 <20ms、hard 单次 <60ms）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGame } from '../src/engine/engine.js';
import { CARDS } from '../src/data/cards.js';
import { LEADERS } from '../src/data/leaders.js';
import { PRESET_DECKS, expandPreset } from '../src/data/decks.js';
import { createAI } from '../src/engine/ai.js';

const FACTIONS = Object.keys(PRESET_DECKS);
const MAX_STEPS = 300;
const MULLIGAN_LIMIT = 2;

/* ================================================================== */
/* helpers                                                             */
/* ================================================================== */

function makeAI(playerIndex, difficulty = 'normal', seed = 1) {
  return createAI({ cards: CARDS, leaders: LEADERS, playerIndex, difficulty, seed });
}

function makeGame({
  seed = 1,
  f0 = 'northern-realms',
  f1 = 'monsters',
  p0idx = 0,
  p1idx = 0,
  leader0 = null,
  leader1 = null,
  resolve = true,
} = {}) {
  const p0 = PRESET_DECKS[f0][p0idx % PRESET_DECKS[f0].length];
  const p1 = PRESET_DECKS[f1][p1idx % PRESET_DECKS[f1].length];
  const game = createGame({
    seed,
    cards: CARDS,
    leaders: LEADERS,
    players: [
      { id: 'p0', faction: f0, leaderId: leader0 || p0.leaderId, deck: expandPreset(p0) },
      { id: 'p1', faction: f1, leaderId: leader1 || p1.leaderId, deck: expandPreset(p1) },
    ],
  });
  if (resolve) resolveSetup(game);
  return game;
}

function resolveSetup(game, { mulligan = [] } = {}) {
  let guard = 0;
  while (game.pending) {
    if (guard++ > 10) throw new Error('setup pending loop');
    const kind = game.pending.kind;
    if (kind === 'mulligan') game.respond({ cards: mulligan });
    else if (kind === 'chooseFirstPlayer') game.respond({ first: 0 });
    else throw new Error('unexpected setup pending: ' + kind);
  }
  return game;
}

function clearBoard(game) {
  for (const pl of game.state.players) {
    pl.rows = { close: [], ranged: [], siege: [] };
    pl.rowSpecials = { close: null, ranged: null, siege: null };
    pl.passed = false;
  }
  game.state.weather = { frost: false, fog: false, rain: false, storm: false };
  game.state.weatherCards = [];
  game.state.passed = [false, false];
  game.state.phase = 'play';
  game.state.pending = null;
  game._recompute(true);
}

function setHand(game, player, cardIds) {
  game.state.players[player].hand = cardIds.map((id) => game._makeInst(game.state, id, player));
}

function placeUnit(game, player, cardId, row) {
  const inst = game._makeInst(game.state, cardId, player);
  inst.row = row || CARDS[cardId].rows[0];
  inst.boardOwner = player;
  game.state.players[player].rows[inst.row].push(inst);
  game._recompute(true);
  return inst;
}

/** 模拟“对面打到我这边的间谍”（owner=对手，boardOwner=我）。 */
function placeEnemySpy(game, boardOwner, owner, cardId, row) {
  const inst = game._makeInst(game.state, cardId, owner);
  inst.row = row || CARDS[cardId].rows[0];
  inst.boardOwner = boardOwner;
  game.state.players[boardOwner].rows[inst.row].push(inst);
  game._recompute(true);
  return inst;
}

function giveGrave(game, player, cardIds) {
  const out = cardIds.map((id) => game._makeInst(game.state, id, player));
  game.state.players[player].graveyard.push(...out);
  return out;
}

function setTurn(game, player) {
  game.state.phase = 'play';
  game.state.pending = null;
  game.state.turn = player;
  game.state.passed = [false, false];
  for (const pl of game.state.players) pl.passed = false;
  game._recompute(true);
}

function setPassed(game, player) {
  game.state.players[player].passed = true;
  game.state.passed[player] = true;
}

/** 让 AI 做一次决策（当前轮到 player）。 */
function decide(game, player, ai) {
  const view = game.viewFor(player);
  const actions = game.getActions();
  const action = ai.chooseAction(view, game);
  return { view, actions, action };
}

function cardOfAction(view, player, action) {
  if (!action || action.type !== 'playCard') return null;
  const inst = (view.players[player].hand || []).find((h) => h.uid === action.uid);
  return inst ? CARDS[inst.cardId] : null;
}

function actionKey(action) {
  return [
    action.type,
    action.uid || '',
    action.row || '',
    action.rowOwner == null ? '' : action.rowOwner,
    action.targetUid || '',
  ].join('|');
}

function assertLegalAction(actions, action, message = '') {
  assert.ok(action && typeof action === 'object', `AI 未返回动作 ${message}`);
  const keys = new Set(actions.map(actionKey));
  assert.ok(keys.has(actionKey(action)),
    `AI 返回了非法动作 ${message}: ${JSON.stringify(action)}；合法动作=${JSON.stringify(actions.map(actionKey))}`);
}

/** 把真实 engine 包一层，禁止 AI 访问 state/config（防作弊测试用）。 */
function noPeekEngine(engine) {
  const wrapper = {
    getActions: () => engine.getActions(),
    viewFor: (pov) => engine.viewFor(pov),
    apply: (action) => engine.apply(action),
    respond: (choice) => engine.respond(choice),
    clone: () => noPeekEngine(engine.clone()),
    get pending() {
      return engine.pending;
    },
  };
  return new Proxy(wrapper, {
    get(target, prop) {
      if (prop === 'state' || prop === 'config') {
        throw new Error(`AI 试图读取 engine.${String(prop)}（作弊）`);
      }
      return Reflect.get(target, prop);
    },
  });
}

/**
 * 跑完整一局 AI vs AI。
 * @returns {{game:Object, steps:number, decisions:number, result:Object, times:number[]}}
 */
function playFullGame({
  seed = 1,
  f0 = 'northern-realms',
  f1 = 'monsters',
  p0idx = 0,
  p1idx = 0,
  d0 = 'normal',
  d1 = 'normal',
  maxSteps = MAX_STEPS,
  wrapEngine = false,
  timeDecisions = false,
} = {}) {
  const game = makeGame({ seed, f0, f1, p0idx, p1idx, resolve: false });
  const ais = [
    makeAI(0, d0, seed * 101 + 1),
    makeAI(1, d1, seed * 101 + 2),
  ];
  const engines = wrapEngine ? [noPeekEngine(game), noPeekEngine(game)] : [game, game];
  const times = [];
  let steps = 0;
  let decisions = 0;

  while (game.state.phase !== 'game-over' && steps < maxSteps) {
    const pending = game.pending;
    if (pending) {
      const player = pending.player;
      const view = game.viewFor(player);
      const started = timeDecisions ? performance.now() : 0;
      let choice;
      if (pending.kind === 'mulligan') {
        choice = ais[player].chooseMulligan(view, engines[player]);
        assert.ok(choice && Array.isArray(choice.cards), 'chooseMulligan 必须返回 {cards:[]}');
        assert.ok(choice.cards.length <= MULLIGAN_LIMIT, 'mulligan 最多换 2 张');
        const handUids = new Set((view.players[player].hand || []).map((h) => h.uid));
        assert.ok(choice.cards.every((uid) => handUids.has(uid)), 'mulligan 只能换手牌');
        assert.equal(new Set(choice.cards).size, choice.cards.length, 'mulligan 不能重复换同一张');
      } else {
        assert.equal(view.players[1 - player].hand, null, '对手手牌必须是 null（不可见）');
        choice = ais[player].choosePending(pending, view, engines[player]);
        assert.ok(choice && typeof choice === 'object', 'choosePending 必须返回对象');
      }
      if (timeDecisions) times.push(performance.now() - started);
      decisions += 1;
      const res = game.respond(choice);
      assert.ok(res.ok, `pending 应答失败（${pending.kind}）：${JSON.stringify(choice)} → ${res.error}`);
      continue;
    }

    const turn = game.state.turn;
    const view = game.viewFor(turn);
    const actions = game.getActions();
    assert.ok(actions.length > 0, '轮到 AI 时必须有合法动作');
    const started = timeDecisions ? performance.now() : 0;
    const action = ais[turn].chooseAction(view, engines[turn]);
    if (timeDecisions) times.push(performance.now() - started);
    decisions += 1;
    assertLegalAction(actions, action, `(seed=${seed}, P${turn}, round=${game.state.round})`);
    assert.equal(view.players[1 - turn].hand, null, '对手手牌必须是 null（不可见）');
    const res = game.apply(action);
    assert.ok(res.ok, `动作执行失败：${JSON.stringify(action)} → ${res.error}`);
    steps += 1;
  }

  return { game, steps, decisions, result: game.result(), times };
}

/** 以指定难度跑一局并返回 winner（用于难度强弱对比）。 */
function quickWinner({ seed, f0, f1, p0idx = 0, p1idx = 0, d0, d1 }) {
  return playFullGame({ seed, f0, f1, p0idx, p1idx, d0, d1 });
}

/* ================================================================== */
/* 1. AI vs AI 完整对局（真实数据）                                     */
/* ================================================================== */

test('AI vs AI：真实数据 12 局跨阵营对局，合法、可结束、步数 < 300', () => {
  const matchups = [
    ['northern-realms', 'nilfgaard'],
    ['monsters', 'scoiatael'],
    ['skellige', 'northern-realms'],
    ['nilfgaard', 'monsters'],
    ['scoiatael', 'skellige'],
    ['northern-realms', 'monsters'],
    ['nilfgaard', 'skellige'],
    ['monsters', 'northern-realms'],
    ['skellige', 'scoiatael'],
    ['scoiatael', 'nilfgaard'],
    ['northern-realms', 'skellige'],
    ['monsters', 'nilfgaard'],
  ];
  const difficulties = [
    ['normal', 'normal'],
    ['hard', 'normal'],
    ['normal', 'hard'],
    ['hard', 'hard'],
    ['easy', 'normal'],
    ['normal', 'easy'],
  ];
  const winners = [];
  matchups.forEach(([f0, f1], index) => {
    const [d0, d1] = difficulties[index % difficulties.length];
    const run = playFullGame({
      seed: 1000 + index,
      f0,
      f1,
      p0idx: index % 2,
      p1idx: (index + 1) % 2,
      d0,
      d1,
    });
    assert.ok(run.steps > 5, `对局步数过少（seed=${1000 + index}）`);
    assert.ok(run.steps < MAX_STEPS, `对局步数超限：${run.steps}（seed=${1000 + index}）`);
    assert.equal(run.game.state.phase, 'game-over', '对局应该结束');
    assert.ok(run.result, '对局结束应有 result');
    assert.ok([0, 1, null].includes(run.result.winner));
    assert.equal(run.result.history.length >= 1, true);
    winners.push(run.result.winner);
  });
  assert.ok(winners.length === 12);
});

test('AI vs AI：同 seed 确定性（结果/步数/小局历史一致）', () => {
  const opts = { seed: 77, f0: 'nilfgaard', f1: 'skellige', p0idx: 0, p1idx: 1, d0: 'hard', d1: 'normal' };
  const a = playFullGame(opts);
  const b = playFullGame(opts);
  assert.equal(a.steps, b.steps);
  assert.deepEqual(a.result, b.result);
  assert.deepEqual(a.game.state.roundHistory, b.game.state.roundHistory);
});

test('不得作弊：engine.state 被封死后仍可完成整局（只依赖 view + getActions/clone）', () => {
  const run = playFullGame({
    seed: 4242,
    f0: 'monsters',
    f1: 'northern-realms',
    d0: 'hard',
    d1: 'normal',
    wrapEngine: true,
  });
  assert.equal(run.game.state.phase, 'game-over');
  assert.ok(run.result);
  assert.ok(run.steps > 5 && run.steps < MAX_STEPS);
});

/* ================================================================== */
/* 2. pending 全覆盖                                                   */
/* ================================================================== */

test('pending/mulligan：换掉低价值/重复天气，保留间谍', () => {
  const game = makeGame({ seed: 12, f0: 'northern-realms', f1: 'monsters', resolve: false });
  assert.equal(game.pending.kind, 'mulligan');
  assert.equal(game.pending.player, 0);

  const ids = [
    'thaler',
    'biting-frost',
    'biting-frost',
    'villentretenmerth',
    'ballista',
    'keira-metz',
    'blue-stripes-commando',
    'crinfrid-reavers-dragon-hunter',
    'commander-s-horn',
    'scorch',
  ];
  setHand(game, 0, ids);
  const view = game.viewFor(0);
  const handByUid = new Map(view.players[0].hand.map((h) => [h.uid, h.cardId]));

  for (const difficulty of ['normal', 'hard']) {
    const ai = makeAI(0, difficulty, 5);
    const choice = ai.chooseMulligan(view, game);
    assert.ok(Array.isArray(choice.cards));
    assert.ok(choice.cards.length <= MULLIGAN_LIMIT);
    const outCards = choice.cards.map((uid) => handByUid.get(uid));
    assert.ok(!outCards.includes('thaler'), `${difficulty} AI 不应该换掉间谍`);
    assert.ok(outCards.length >= 1, `${difficulty} AI 应该会换掉低价值牌`);
    // 重复天气之一必然会被换掉（两张冰霜同名同天气，第二张无价值）
    assert.ok(outCards.includes('biting-frost'), `${difficulty} AI 应该换掉重复天气`);

    const viaPending = ai.choosePending(game.pending, view, game);
    assert.ok(Array.isArray(viaPending.cards));
  }

  const res = game.respond({ cards: [] });
  assert.ok(res.ok);
});

test('pending/chooseFirstPlayer：松鼠党 AI 让对手先手', () => {
  const game = makeGame({ seed: 13, f0: 'scoiatael', f1: 'monsters', resolve: false });
  assert.equal(game.pending.kind, 'chooseFirstPlayer');
  assert.equal(game.pending.player, 0);
  const ai = makeAI(0, 'normal', 1);
  const choice = ai.choosePending(game.pending, game.viewFor(0), game);
  assert.deepEqual(choice, { first: 1 }, 'AI 应选择让对手先手');
  const res = game.respond(choice);
  assert.ok(res.ok, res.error);
  assert.equal(game.pending.kind, 'mulligan');
});

test('pending/medic：优先复活间谍（抽 2 = 巨大手牌资源）', () => {
  const game = makeGame({ seed: 14, f0: 'northern-realms', f1: 'monsters' });
  clearBoard(game);
  setTurn(game, 0);
  giveGrave(game, 0, ['thaler', 'dol-blathanna-scout']);
  setHand(game, 0, ['dun-banner-medic', 'redanian-foot-soldier']);
  const medic = game.state.players[0].hand[0];
  const played = game.apply({ type: 'playCard', uid: medic.uid, row: 'siege' });
  assert.ok(played.ok, played.error);
  assert.equal(game.pending.kind, 'medic');

  for (const difficulty of ['normal', 'hard']) {
    // 每种难度重新构造一次 pending，避免互相消耗
    const scenario = makeGame({ seed: 14, f0: 'northern-realms', f1: 'monsters' });
    clearBoard(scenario);
    setTurn(scenario, 0);
    giveGrave(scenario, 0, ['thaler', 'dol-blathanna-scout']);
    setHand(scenario, 0, ['dun-banner-medic', 'redanian-foot-soldier']);
    const medicInst = scenario.state.players[0].hand[0];
    assert.ok(scenario.apply({ type: 'playCard', uid: medicInst.uid, row: 'siege' }).ok);
    assert.equal(scenario.pending.kind, 'medic');
    const ai = makeAI(0, difficulty, 21);
    const medicChoice = ai.choosePending(scenario.pending, scenario.viewFor(0), scenario);
    const picked = scenario.pending.options.find((o) => o.uid === medicChoice.uid);
    assert.ok(picked, 'medic 选择必须是合法 option');
    assert.equal(picked.cardId, 'thaler', `${difficulty} 医师应优先复活间谍`);
    const res = scenario.respond(medicChoice);
    assert.ok(res.ok, res.error);
    assert.equal(scenario.pending, null, 'thaler 是单行单位，复活后无需选行');
    const onBoard = Object.values(scenario.state.players[0].rows).flat().map((c) => c.cardId);
    assert.ok(onBoard.includes('thaler'), '复活的间谍应回到场上');
  }
});

test('pending/reviveRow：灵巧单位复活不丢牌（牌数守恒）', () => {
  const game = makeGame({ seed: 15, f0: 'northern-realms', f1: 'monsters' });
  clearBoard(game);
  setTurn(game, 0);
  const [agileInst] = giveGrave(game, 0, ['dol-blathanna-scout']);
  setHand(game, 0, ['dun-banner-medic', 'redanian-foot-soldier']);
  const medic = game.state.players[0].hand[0];
  assert.ok(game.apply({ type: 'playCard', uid: medic.uid, row: 'siege' }).ok);
  const ai = makeAI(0, 'hard', 22);
  const medicChoice = ai.choosePending(game.pending, game.viewFor(0), game);
  assert.equal(game.pending.options.find((o) => o.uid === medicChoice.uid)?.cardId, 'dol-blathanna-scout');
  assert.ok(game.respond(medicChoice).ok);
  assert.equal(game.pending.kind, 'reviveRow');
  const rowChoice = ai.choosePending(game.pending, game.viewFor(0), game);
  assert.ok(game.respond(rowChoice).ok);
  const alive = game.state.players[0].rows[agileInst.row].some((c) => c.uid === agileInst.uid)
    || Object.values(game.state.players[0].rows).flat().some((c) => c.uid === agileInst.uid);
  assert.ok(alive, '复活的灵巧单位必须留在场上');
  assert.ok(!game.state.players[0].graveyard.some((c) => c.uid === agileInst.uid), '不应留在墓地');
});

test('pending/takeGraveUnit：领袖从墓地取牌加入手牌', () => {
  const game = makeGame({ seed: 16, f0: 'monsters', f1: 'northern-realms', leader0: 'eredin-bringer-of-death' });
  setTurn(game, 0);
  giveGrave(game, 0, ['thaler', 'griffin']);
  const handBefore = game.state.players[0].hand.length;
  assert.ok(game.apply({ type: 'useLeader' }).ok);
  assert.equal(game.pending.kind, 'takeGraveUnit');
  const ai = makeAI(0, 'hard', 23);
  const choice = ai.choosePending(game.pending, game.viewFor(0), game);
  assert.ok(game.pending.options.some((o) => o.uid === choice.uid));
  assert.ok(game.respond(choice).ok);
  assert.equal(game.state.players[0].hand.length, handBefore + 1);
});

test('pending/discardCards + deckChoice：弃 2 抽 1 流程完整', () => {
  const game = makeGame({ seed: 17, f0: 'monsters', f1: 'northern-realms', leader0: 'eredin-destroyer-of-worlds' });
  setTurn(game, 0);
  setHand(game, 0, ['ghoul', 'nekker', 'arachas', 'fiend', 'werewolf']);
  const handBefore = game.state.players[0].hand.length;
  assert.ok(game.apply({ type: 'useLeader' }).ok);
  assert.equal(game.pending.kind, 'discardCards');
  const ai = makeAI(0, 'hard', 24);
  const discardChoice = ai.choosePending(game.pending, game.viewFor(0), game);
  assert.equal(discardChoice.cards.length, game.pending.count);
  assert.equal(new Set(discardChoice.cards).size, game.pending.count);
  const validUids = new Set(game.pending.options.map((o) => o.uid));
  assert.ok(discardChoice.cards.every((uid) => validUids.has(uid)));
  assert.ok(game.respond(discardChoice).ok);
  assert.equal(game.pending.kind, 'deckChoice');
  const deckChoice = ai.choosePending(game.pending, game.viewFor(0), game);
  assert.ok(game.pending.options.some((o) => o.uid === deckChoice.uid));
  assert.ok(game.respond(deckChoice).ok);
  assert.equal(game.state.players[0].hand.length, handBefore - 2 + 1);
});

test('pending/chooseWeather：从牌堆打出天气并生效', () => {
  const game = makeGame({ seed: 18, f0: 'monsters', f1: 'northern-realms', leader0: 'eredin-king-of-the-wild-hunt' });
  setTurn(game, 0);
  // 只留一张天气在牌堆里，保证 chooseWeather 只有一个选项
  game.state.players[0].deck = game.state.players[0].deck.filter((inst) => {
    const card = CARDS[inst.cardId];
    return !(card.type === 'weather');
  });
  game.state.players[0].deck.push(game._makeInst(game.state, 'biting-frost', 0));
  assert.ok(game.apply({ type: 'useLeader' }).ok);
  assert.equal(game.pending.kind, 'chooseWeather');
  const ai = makeAI(0, 'hard', 25);
  const choice = ai.choosePending(game.pending, game.viewFor(0), game);
  assert.ok(game.pending.options.some((o) => o.uid === choice.uid));
  assert.ok(game.respond(choice).ok);
  assert.equal(game.state.weather.frost, true, 'AI 选择的天气应生效');
});

test('pending/viewHand：信息类领袖能力正确应答', () => {
  const game = makeGame({
    seed: 19,
    f0: 'nilfgaard',
    f1: 'monsters',
    leader0: 'emhyr-var-emreis-emperor-of-nilfgaard',
  });
  setTurn(game, 0);
  assert.ok(game.apply({ type: 'useLeader' }).ok);
  assert.equal(game.pending.kind, 'viewHand');
  const ai = makeAI(0, 'normal', 26);
  const choice = ai.choosePending(game.pending, game.viewFor(0), game);
  assert.deepEqual(choice, { ack: true });
  assert.ok(game.respond(choice).ok);
});

/* ================================================================== */
/* 3. 关键启发式                                                       */
/* ================================================================== */

test('启发式：敌方近战行 ≥10 时，hard AI 会使用单行灼烧（Villentretenmerth）', () => {
  const game = makeGame({ seed: 31, f0: 'northern-realms', f1: 'monsters' });
  clearBoard(game);
  placeUnit(game, 1, 'fiend', 'close'); // 6
  placeUnit(game, 1, 'griffin', 'close'); // 5 → 近战行 11
  setHand(game, 0, ['villentretenmerth', 'redanian-foot-soldier', 'poor-fucking-infantry', 'ballista']);
  game.state.players[0].leaderUsed = true;
  setTurn(game, 0);
  const ai = makeAI(0, 'hard', 31);
  const { view, actions, action } = decide(game, 0, ai);
  assertLegalAction(actions, action);
  const card = cardOfAction(view, 0, action);
  assert.ok(card, 'AI 应该打出一张牌');
  assert.equal(card.id, 'villentretenmerth', '敌方近战行 ≥10 时应打出单行灼烧单位');
});

test('启发式：特殊 Scorch 会摧毁敌方最强单位', () => {
  const game = makeGame({ seed: 32, f0: 'northern-realms', f1: 'monsters' });
  clearBoard(game);
  placeUnit(game, 1, 'olaf', 'close'); // 12 战力（我方没有更强单位）
  setHand(game, 0, ['scorch', 'redanian-foot-soldier', 'poor-fucking-infantry', 'ballista']);
  game.state.players[0].leaderUsed = true;
  setTurn(game, 0);
  for (const difficulty of ['normal', 'hard']) {
    const ai = makeAI(0, difficulty, 32);
    const { view, actions, action } = decide(game, 0, ai);
    assertLegalAction(actions, action);
    assert.equal(cardOfAction(view, 0, action)?.id, 'scorch', `${difficulty} AI 应该打出 Scorch`);
  }
});

test('启发式：间谍优先（抽 2 张 = 手牌资源）', () => {
  const game = makeGame({ seed: 33, f0: 'northern-realms', f1: 'monsters' });
  clearBoard(game);
  setHand(game, 0, ['thaler', 'crinfrid-reavers-dragon-hunter', 'blue-stripes-commando', 'redanian-foot-soldier']);
  game.state.players[0].leaderUsed = true;
  setTurn(game, 0);
  for (const difficulty of ['normal', 'hard']) {
    const ai = makeAI(0, difficulty, 33);
    const { view, actions, action } = decide(game, 0, ai);
    assertLegalAction(actions, action);
    assert.equal(cardOfAction(view, 0, action)?.id, 'thaler', `${difficulty} AI 应先打间谍`);
  }
});

test('启发式：领先时 Pass、落后时继续出牌', () => {
  // 领先 20 分：应该 Pass 而不是继续浪费牌
  {
    const game = makeGame({ seed: 34, f0: 'northern-realms', f1: 'monsters' });
    clearBoard(game);
    placeUnit(game, 0, 'esterad-thyssen', 'close'); // 10 hero
    placeUnit(game, 0, 'john-natalis', 'close'); // 10 hero
    setHand(game, 0, ['redanian-foot-soldier', 'poor-fucking-infantry', 'ballista']);
    setTurn(game, 0);
    for (const difficulty of ['normal', 'hard']) {
      const ai = makeAI(0, difficulty, 34);
      const { actions, action } = decide(game, 0, ai);
      assertLegalAction(actions, action);
      assert.equal(action.type, 'pass', `${difficulty} AI 领先 20 分时应 Pass 保留手牌`);
    }
  }
  // 落后 5 分：不能 Pass，应该出牌
  {
    const game = makeGame({ seed: 35, f0: 'northern-realms', f1: 'monsters' });
    clearBoard(game);
    placeUnit(game, 1, 'griffin', 'close'); // 5
    setHand(game, 0, ['ballista', 'keira-metz', 'redanian-foot-soldier']);
    setTurn(game, 0);
    for (const difficulty of ['normal', 'hard']) {
      const ai = makeAI(0, difficulty, 35);
      const { actions, action } = decide(game, 0, ai);
      assertLegalAction(actions, action);
      assert.equal(action.type, 'playCard', `${difficulty} AI 落后时应继续出牌`);
    }
  }
});

test('启发式：非决胜局差距过大时战略性放弃；决胜局（自己 1 宝石）必须抢分', () => {
  const buildHopeless = () => {
    const game = makeGame({ seed: 41, f0: 'northern-realms', f1: 'monsters' });
    clearBoard(game);
    // 敌方 close 行 21 分，敌方手牌仅 3 张，我方手牌 5 张（第 1 小局，2:2 宝石）
    for (const id of ['fiend', 'griffin', 'werewolf', 'plague-maiden']) {
      placeUnit(game, 1, id, 'close');
    }
    game.state.players[1].hand = ['nekker', 'ghoul', 'foglet'].map((id) => game._makeInst(game.state, id, 1));
    setHand(game, 0, ['ballista', 'keira-metz', 'redanian-foot-soldier', 'poor-fucking-infantry', 'blue-stripes-commando']);
    setTurn(game, 0);
    game.state.round = 1;
    return game;
  };

  // 非决胜局：落后 20+ 且对手手牌很少 → 战略性 Pass 保留手牌
  {
    const game = buildHopeless();
    game.state.gems = [2, 2];
    game.state.round = 1;
    for (const difficulty of ['normal', 'hard']) {
      const ai = makeAI(0, difficulty, 41);
      const { actions, action } = decide(game, 0, ai);
      assertLegalAction(actions, action);
      assert.equal(action.type, 'pass', `${difficulty} AI 在无望的小局应战略性放弃`);
    }
  }

  // 决胜局（我方仅剩 1 宝石，输掉即输比赛）：必须继续抢分，不能放弃
  {
    const game = buildHopeless();
    game.state.gems = [1, 2];
    game.state.round = 2;
    for (const difficulty of ['normal', 'hard']) {
      const ai = makeAI(0, difficulty, 42);
      const { actions, action } = decide(game, 0, ai);
      assertLegalAction(actions, action);
      assert.equal(action.type, 'playCard', `${difficulty} AI 在决胜局不能放弃`);
    }
  }
});

test('启发式：对手已 Pass 时，落后会追分；反超后立刻 Pass 锁定小局', () => {
  const game = makeGame({ seed: 36, f0: 'northern-realms', f1: 'monsters' });
  clearBoard(game);
  placeUnit(game, 1, 'griffin', 'close'); // 敌方 5 分
  setPassed(game, 1);
  setHand(game, 0, ['milva', 'redanian-foot-soldier', 'poor-fucking-infantry']);
  setTurn(game, 0);
  setPassed(game, 1);
  const ai = makeAI(0, 'normal', 36);
  const first = decide(game, 0, ai);
  assertLegalAction(first.actions, first.action);
  assert.equal(first.action.type, 'playCard', '对手已 Pass 且落后时必须追分');
  const applied = game.apply(first.action);
  assert.ok(applied.ok, applied.error);
  assert.equal(game.state.turn, 0, '对手已 Pass，出牌后仍轮到 AI');
  assert.ok(game.state.scores[0].score > game.state.scores[1].score, '追分后应反超');
  const second = decide(game, 0, ai);
  assertLegalAction(second.actions, second.action);
  assert.equal(second.action.type, 'pass', '反超后应立即 Pass 锁定小局');
});

test('启发式：领袖时机——号角领袖等己方行成型、灼烧领袖等敌方行 ≥10', () => {
  // 攻城大师：己方攻城行 20 分 → 应该用领袖号角
  {
    const game = makeGame({ seed: 37, f0: 'northern-realms', f1: 'monsters', leader0: 'foltest-the-siegemaster' });
    clearBoard(game);
    placeUnit(game, 0, 'ballista', 'siege');
    placeUnit(game, 0, 'catapult', 'siege');
    placeUnit(game, 0, 'trebuchet', 'siege');
    placeUnit(game, 1, 'draug', 'close');
    placeUnit(game, 1, 'imlerith', 'close'); // 双方同分
    setHand(game, 0, ['redanian-foot-soldier', 'poor-fucking-infantry', 'commander-s-horn', 'blue-stripes-commando']);
    setTurn(game, 0);
    const ai = makeAI(0, 'hard', 37);
    const { actions, action } = decide(game, 0, ai);
    assertLegalAction(actions, action);
    assert.equal(action.type, 'useLeader', '己方攻城行成型时应使用号角领袖');
  }
  // 麦德尔之子：敌方远程行 22 分 → 应该用领袖灼烧
  {
    const game = makeGame({ seed: 38, f0: 'northern-realms', f1: 'skellige', leader0: 'foltest-son-of-medell' });
    clearBoard(game);
    placeUnit(game, 1, 'clan-brokvar-archer', 'ranged');
    placeUnit(game, 1, 'clan-brokvar-archer', 'ranged');
    placeUnit(game, 1, 'milva', 'ranged');
    setHand(game, 0, ['redanian-foot-soldier', 'poor-fucking-infantry', 'ballista']);
    setTurn(game, 0);
    const ai = makeAI(0, 'hard', 38);
    const { actions, action } = decide(game, 0, ai);
    assertLegalAction(actions, action);
    assert.equal(action.type, 'useLeader', '敌方远程行 ≥10 时应使用灼烧领袖');
  }
  // 敌方行很小时不应该浪费灼烧领袖
  {
    const game = makeGame({ seed: 39, f0: 'northern-realms', f1: 'skellige', leader0: 'foltest-son-of-medell' });
    clearBoard(game);
    setHand(game, 0, ['redanian-foot-soldier', 'poor-fucking-infantry', 'ballista']);
    setTurn(game, 0);
    const ai = makeAI(0, 'hard', 39);
    const { actions, action } = decide(game, 0, ai);
    assertLegalAction(actions, action);
    assert.notEqual(action.type, 'useLeader', '敌方行很小时不应浪费灼烧领袖');
  }
});

test('启发式：Decoy 会换回敌方打到我方场地的间谍（引擎支持）', () => {
  const game = makeGame({ seed: 40, f0: 'northern-realms', f1: 'monsters' });
  clearBoard(game);
  placeEnemySpy(game, 0, 1, 'thaler', 'siege');
  setHand(game, 0, ['decoy', 'redanian-foot-soldier', 'poor-fucking-infantry']);
  setTurn(game, 0);
  for (const difficulty of ['normal', 'hard']) {
    const ai = makeAI(0, difficulty, 40);
    const { view, actions, action } = decide(game, 0, ai);
    assertLegalAction(actions, action);
    assert.equal(cardOfAction(view, 0, action)?.id, 'decoy', `${difficulty} AI 应使用 Decoy 换回敌方间谍`);
  }
});

/* ================================================================== */
/* 4. 性能                                                             */
/* ================================================================== */

test('性能：单次决策 normal < 20ms，hard < 60ms', () => {
  const normal = playFullGame({
    seed: 501,
    f0: 'nilfgaard',
    f1: 'monsters',
    d0: 'normal',
    d1: 'normal',
    timeDecisions: true,
  });
  assert.ok(normal.times.length > 10);
  const normalMax = Math.max(...normal.times);
  const normalAvg = normal.times.reduce((s, t) => s + t, 0) / normal.times.length;
  assert.ok(normalAvg < 20, `normal 平均决策耗时过长：${normalAvg.toFixed(2)}ms`);
  assert.ok(normalMax < 20, `normal 单次决策耗时过长：${normalMax.toFixed(2)}ms`);

  const hard = playFullGame({
    seed: 502,
    f0: 'skellige',
    f1: 'scoiatael',
    d0: 'hard',
    d1: 'hard',
    timeDecisions: true,
  });
  assert.ok(hard.times.length > 10);
  const hardMax = Math.max(...hard.times);
  const hardAvg = hard.times.reduce((s, t) => s + t, 0) / hard.times.length;
  assert.ok(hardAvg < 60, `hard 平均决策耗时过长：${hardAvg.toFixed(2)}ms`);
  assert.ok(hardMax < 60, `hard 单次决策耗时过长：${hardMax.toFixed(2)}ms`);
});

/* ================================================================== */
/* 5. 难度强弱（同 seed、换座位消除先手偏差）                           */
/* ================================================================== */

test('难度：normal 明显强于 easy；hard 强于 easy 且不弱于 normal', () => {
  let normalWins = 0;
  let easyWins = 0;
  let normalDraws = 0;
  let hardWins = 0;
  let hardNormalWins = 0;
  let hardDraws = 0;
  let hardEasyWins = 0;
  let easyHardWins = 0;
  let hardEasyDraws = 0;

  const pairs = 8;
  for (let i = 0; i < pairs; i += 1) {
    const f0 = FACTIONS[i % FACTIONS.length];
    const f1 = FACTIONS[(i + 2) % FACTIONS.length];
    const p0idx = i % 2;
    const p1idx = (i + 1) % 2;

    // normal vs easy（换座位消除先手偏差）
    const na = playFullGame({ seed: 900 + i, f0, f1, p0idx, p1idx, d0: 'normal', d1: 'easy' });
    const nb = playFullGame({ seed: 950 + i, f0: f1, f1: f0, p0idx: p1idx, p1idx: p0idx, d0: 'easy', d1: 'normal' });
    if (na.result.winner === 0) normalWins += 1;
    else if (na.result.winner === 1) easyWins += 1;
    else normalDraws += 1;
    if (nb.result.winner === 1) normalWins += 1;
    else if (nb.result.winner === 0) easyWins += 1;
    else normalDraws += 1;

    // hard vs normal
    const ha = playFullGame({ seed: 970 + i, f0, f1, p0idx, p1idx, d0: 'hard', d1: 'normal' });
    const hb = playFullGame({ seed: 990 + i, f0: f1, f1: f0, p0idx: p1idx, p1idx: p0idx, d0: 'normal', d1: 'hard' });
    if (ha.result.winner === 0) hardWins += 1;
    else if (ha.result.winner === 1) hardNormalWins += 1;
    else hardDraws += 1;
    if (hb.result.winner === 1) hardWins += 1;
    else if (hb.result.winner === 0) hardNormalWins += 1;
    else hardDraws += 1;

    // hard vs easy
    const he = playFullGame({ seed: 970 + i, f0, f1, p0idx, p1idx, d0: 'hard', d1: 'easy' });
    const eh = playFullGame({ seed: 990 + i, f0: f1, f1: f0, p0idx: p1idx, p1idx: p0idx, d0: 'easy', d1: 'hard' });
    if (he.result.winner === 0) hardEasyWins += 1;
    else if (he.result.winner === 1) easyHardWins += 1;
    else hardEasyDraws += 1;
    if (eh.result.winner === 1) hardEasyWins += 1;
    else if (eh.result.winner === 0) easyHardWins += 1;
    else hardEasyDraws += 1;
  }

  assert.ok(normalWins >= easyWins + 4,
    `normal(${normalWins}) 应明显强于 easy(${easyWins})，draws=${normalDraws}`);
  assert.ok(hardWins + 2 >= hardNormalWins,
    `hard(${hardWins}) 不应弱于 normal(${hardNormalWins})，draws=${hardDraws}`);
  assert.ok(hardEasyWins >= easyHardWins + 4,
    `hard(${hardEasyWins}) 应明显强于 easy(${easyHardWins})，draws=${hardEasyDraws}`);
});
