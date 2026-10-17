import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/engine/engine.js';
import { CARDS, LEADERS } from './fixtures.mjs';
import { validateDeck } from '../src/engine/deck.js';

// ────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────

function mkDeck(extra = []) {
  const units = [
    ...Array(6).fill('soldier'),
    ...Array(4).fill('archer'),
    ...Array(4).fill('siege'),
    ...Array(3).fill('bond'),
    ...Array(2).fill('morale'),
    ...Array(2).fill('spy'),
    ...Array(2).fill('medic'),
  ];
  const base = [...units.slice(0, 22), ...extra];
  return base;
}

function makeGame(opts = {}) {
  const game = createGame({
    seed: opts.seed ?? 7,
    cards: CARDS,
    leaders: LEADERS,
    players: [
      {
        id: 'p0',
        faction: opts.f0 ?? 'northern-realms',
        leaderId: opts.l0 ?? 'l-north',
        deck: opts.deck0 ?? mkDeck(),
      },
      {
        id: 'p1',
        faction: opts.f1 ?? 'monsters',
        leaderId: opts.l1 ?? 'l-mons',
        deck: opts.deck1 ?? mkDeck(),
      },
    ],
  });
  return game;
}

/** Resolve setup (mulligan choices, ST first-player) until playable. */
function startGame(game, { mulligan = [] } = {}) {
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

function newGame(opts = {}) {
  return startGame(makeGame(opts));
}

const active = (g) => g.state.turn;
const other = (p) => 1 - p;

function giveHand(game, p, cardIds) {
  const created = [];
  for (const id of cardIds) {
    const inst = game._makeInst(game.state, id, p);
    game.state.players[p].hand.push(inst);
    created.push(inst);
  }
  return created;
}

function setupTurn(game, p) {
  game.state.phase = 'play';
  game.state.pending = null;
  game.state.turn = p;
}

function playCard(game, p, cardId, opts = {}) {
  setupTurn(game, p);
  const inst = giveHand(game, p, [cardId])[0];
  const card = CARDS[cardId];
  const row = opts.row ?? card.rows?.[0];
  const res = game.apply({ type: 'playCard', uid: inst.uid, row, rowOwner: opts.rowOwner, targetUid: opts.targetUid });
  assert.ok(res.ok, 'playCard failed: ' + res.error);
  let guard = 0;
  while (game.pending && guard++ < 10) {
    if (opts.respond) opts.respond(game);
    else if (game.pending.kind === 'medic') game.respond({ skip: true });
    else if (game.pending.kind === 'reviveRow') game.respond({ row: game.pending.options[0] });
    else if (game.pending.kind === 'viewHand') game.respond({ ack: true });
    else throw new Error('unexpected pending: ' + game.pending.kind);
  }
  return res;
}

function place(game, p, cardId, row) {
  const inst = game._makeInst(game.state, cardId, p);
  inst.row = row ?? CARDS[cardId].rows?.[0] ?? 'close';
  inst.boardOwner = p;
  game.state.players[p].rows[inst.row].push(inst);
  game._recompute(true);
  return inst;
}

function clearBoard(game) {
  for (const p of game.state.players) {
    p.rows = { close: [], ranged: [], siege: [] };
    p.rowSpecials = { close: null, ranged: null, siege: null };
  }
  game.state.weather = { frost: false, fog: false, rain: false, storm: false };
  game.state.weatherCards = [];
  game.state.passed = [false, false];
  game.state.phase = 'play';
  game._recompute(true);
}

function rowScore(game, p, row) {
  return game.viewFor(0).players[p].rowScores[row];
}

function pass(game, p) {
  setupTurn(game, p);
  const res = game.apply({ type: 'pass' });
  assert.ok(res.ok, 'pass failed: ' + res.error);
  return res;
}

// ────────────────────────────────────────────────────────────────────────
// setup & fundamentals
// ────────────────────────────────────────────────────────────────────────

test('setup: draws 10, mulligan phase, then round 1', () => {
  const g = makeGame();
  assert.equal(g.state.phase, 'setup');
  assert.equal(g.state.players[0].hand.length, 10);
  assert.equal(g.state.players[1].hand.length, 10);
  assert.equal(g.pending.kind, 'mulligan');
  assert.equal(g.pending.player, 0);
  g.respond({ cards: [] });
  assert.equal(g.pending.kind, 'mulligan');
  assert.equal(g.pending.player, 1);
  g.respond({ cards: [] });
  assert.equal(g.state.phase, 'play');
  assert.equal(g.state.round, 1);
  assert.ok([0, 1].includes(g.state.firstPlayer));
  assert.equal(g.state.turn, g.state.firstPlayer);
});

test('mulligan: redraws chosen count and keeps hand size', () => {
  const g = makeGame();
  const chosen = g.state.players[0].hand.slice(0, 2).map((c) => c.uid);
  g.respond({ cards: chosen });
  g.respond({ cards: [] });
  assert.equal(g.state.players[0].hand.length, 10);
  assert.equal(g.state.players[0].deck.length + g.state.players[0].hand.length, 22);
});

test('turn alternates and both passes end the round', () => {
  const g = newGame();
  const first = g.state.turn;
  playCard(g, first, 'soldier');
  assert.equal(g.state.turn, other(first));
  // second player passes, first can still act
  pass(g, other(first));
  assert.equal(g.state.turn, first);
  pass(g, first);
  assert.equal(g.state.round, 2);
  assert.equal(g.state.phase, 'play');
  assert.equal(g.state.roundHistory.length, 1);
  assert.equal(g.state.roundHistory[0].scores[first], 4);
  // round 2 starts with the winner
  assert.equal(g.state.turn, first);
});

test('empty hand auto-passes', () => {
  const g = newGame();
  for (const pl of g.state.players) { pl.hand = []; pl.leaderUsed = true; }
  g.state.turn = g.state.firstPlayer;
  g._finalizeAction();
  assert.equal(g.state.roundHistory.length, 1);
  assert.equal(g.state.roundHistory[0].tie, true);
});

test('faction ability: nilfgaard wins ties', () => {
  const g = newGame({ f0: 'nilfgaard', f1: 'monsters', l0: 'l-nilf' });
  const first = g.state.turn;
  clearBoard(g);
  // 0 : 0 tie
  pass(g, first);
  pass(g, other(first));
  assert.equal(g.state.roundHistory.length, 1);
  const h = g.state.roundHistory[0];
  assert.equal(h.tie, true);
  assert.equal(h.nilfTie, true);
  assert.equal(h.winner, 0);
  assert.deepEqual(g.state.gems, [2, 1]);
});

test('non-nilf tie costs both a gem', () => {
  const g = newGame({ f0: 'northern-realms', f1: 'monsters' });
  const first = g.state.turn;
  clearBoard(g);
  pass(g, first);
  pass(g, other(first));
  assert.deepEqual(g.state.gems, [1, 1]);
  assert.equal(g.state.roundHistory[0].winner, null);
});

test('northern realms draws on round win', () => {
  const g = newGame({ f0: 'northern-realms', f1: 'monsters' });
  clearBoard(g);
  place(g, 0, 'soldier');
  pass(g, 0);
  pass(g, 1);
  assert.equal(g.state.roundHistory[0].winner, 0);
  assert.equal(g.state.round, 2);
  // p0 did not play from hand (board injected), so the Northern Realms draw is visible: 11 cards.
  assert.equal(g.state.players[0].hand.length, 11);
  assert.equal(g.state.players[1].hand.length, 10);
});

test('monsters keep a unit after the round', () => {
  const g = newGame({ f0: 'monsters', f1: 'northern-realms' });
  const first = g.state.turn;
  clearBoard(g);
  place(g, 0, 'soldier', 'close');
  place(g, 0, 'archer', 'ranged');
  // let p0 win: nothing to do, p0 already leads 9:0
  pass(g, 0);
  pass(g, 1);
  assert.equal(g.state.round, 2);
  const p0 = g.viewFor(0).players[0];
  const units = Object.values(p0.rows).flat();
  assert.equal(units.length, 1, 'monsters keeps exactly one unit');
  assert.ok(p0.score > 0);
});

test('skellige revives 2 units at the start of round 3', () => {
  const g = newGame({ f0: 'skellige', f1: 'northern-realms', l0: 'l-skell' });
  clearBoard(g);
  place(g, 0, 'soldier');
  place(g, 0, 'archer', 'ranged');
  pass(g, 0);
  pass(g, 1); // p0 wins round1
  assert.equal(g.state.round, 2);
  clearBoard(g);
  place(g, 1, 'soldier'); // p1 wins round2
  pass(g, 0);
  pass(g, 1);
  assert.equal(g.state.round, 3);
  const p0 = g.viewFor(0).players[0];
  const revived = Object.values(p0.rows).flat();
  assert.equal(revived.length, 2, 'two units revived for round 3');
});

test('scoia\'tael chooses who starts', () => {
  const g = makeGame({ f0: "scoiatael", f1: 'monsters', l0: 'l-elf' });
  assert.equal(g.pending.kind, 'chooseFirstPlayer');
  assert.equal(g.pending.player, 0);
  g.respond({ first: 1 });
  assert.equal(g.state.firstPlayer, 1);
  g.respond({ cards: [] });
  g.respond({ cards: [] });
  assert.equal(g.state.turn, 1);
});

test('clone() keeps engine deterministic and independent', () => {
  const g = newGame();
  const clone = g.clone();
  assert.equal(clone.viewFor(0).round, g.viewFor(0).round);
  const p = g.state.turn;
  playCard(g, p, 'soldier');
  // Mutating the original must not change the clone.
  assert.equal(clone.state.roundHistory.length, 0);
  assert.notEqual(clone.viewFor(0).scores[0], g.viewFor(0).scores[0]);
});

// ────────────────────────────────────────────────────────────────────────
// scoring
// ────────────────────────────────────────────────────────────────────────

test('tight bond: multiplier by same-name copies in the same row', () => {
  const g = newGame();
  clearBoard(g);
  place(g, 0, 'bond');
  place(g, 0, 'bond');
  place(g, 0, 'bond');
  assert.equal(rowScore(g, 0, 'close'), 4 * 3 * 3); // each 4 x 3 copies = 36
});

test('weather + tight bond + horn: 1 x copies x2', () => {
  const g = newGame();
  clearBoard(g);
  place(g, 0, 'bond');
  place(g, 0, 'bond');
  place(g, 0, 'bond');
  g.state.weather.frost = true;
  g.state.players[0].rowSpecials.close = { kind: 'horn', uid: 'h1', cardId: 'horn' };
  g._recompute(true);
  assert.equal(rowScore(g, 0, 'close'), 1 * 3 * 2 * 3); // per card: 1*3*2 = 6, total 18
});

test('morale adds +1 after bond, horn doubles after morale', () => {
  const g = newGame();
  clearBoard(g);
  place(g, 0, 'soldier'); // 4
  place(g, 0, 'morale'); // 2, gives +1 to soldier
  assert.equal(rowScore(g, 0, 'close'), 5 + 2);
  g.state.players[0].rowSpecials.close = { kind: 'horn', uid: 'h1', cardId: 'horn' };
  g._recompute(true);
  // soldier: (4+1)*2=10 ; morale: (2+0)*2=4
  assert.equal(rowScore(g, 0, 'close'), 10 + 4);
});

test('horn unit does not double itself but doubles the row', () => {
  const g = newGame();
  clearBoard(g);
  place(g, 0, 'soldier');
  place(g, 0, 'hornman');
  // soldier 4*2=8, hornman 2 (not doubled by its own horn)
  assert.equal(rowScore(g, 0, 'close'), 10);
});

test('heroes are immune to weather, horn, morale and decoy', () => {
  const g = newGame();
  clearBoard(g);
  place(g, 0, 'hero');
  place(g, 0, 'morale');
  g.state.weather.frost = true;
  g.state.players[0].rowSpecials.close = { kind: 'horn', uid: 'h1', cardId: 'horn' };
  g._recompute(true);
  // hero 15, morale unit (2->1 weather, +0 morale) then *2 = 2
  assert.equal(rowScore(g, 0, 'close'), 15 + 2);
  // decoy cannot target a hero
  setupTurn(g, 0);
  const decoyInst = giveHand(g, 0, ['decoy'])[0];
  const res = g.apply({ type: 'playCard', uid: decoyInst.uid, targetUid: g.state.players[0].rows.close[0].uid });
  assert.equal(res.ok, false);
});

// ────────────────────────────────────────────────────────────────────────
// special cards & unit abilities
// ────────────────────────────────────────────────────────────────────────

test('scorch destroys all strongest non-hero units on both sides', () => {
  const g = newGame();
  clearBoard(g);
  place(g, 0, 'soldier');
  place(g, 0, 'archer', 'ranged');
  place(g, 1, 'soldier');
  place(g, 1, 'archer', 'ranged');
  playCard(g, 0, 'scorch');
  // The strongest units are the two archers (5) -> both die, soldiers survive.
  const units = [...g.state.players[0].rows.ranged, ...g.state.players[1].rows.ranged];
  assert.equal(units.length, 0, 'strongest (5) units destroyed on both sides');
  const corpses = [...g.state.players[0].graveyard, ...g.state.players[1].graveyard];
  assert.equal(corpses.filter((c) => c.cardId === 'archer').length, 2);
});

test('row scorch only triggers if enemy row total >= 10', () => {
  const g = newGame();
  clearBoard(g);
  place(g, 1, 'soldier');
  place(g, 1, 'soldier');
  place(g, 1, 'soldier');
  // enemy close row total = 12 >= 10, strongest soldiers die
  playCard(g, 0, 'row-scorcher');
  assert.equal(g.state.players[1].rows.close.length, 0);
  // now a low-total row: no effect
  clearBoard(g);
  place(g, 1, 'soldier');
  const before = g.state.players[1].rows.close.length;
  playCard(g, 0, 'row-scorcher');
  assert.equal(g.state.players[1].rows.close.length, before);
});

test('spy goes to the opponent board and draws 2 cards', () => {
  const g = newGame();
  clearBoard(g);
  const handBefore = g.state.players[0].hand.length;
  playCard(g, 0, 'spy');
  const p1Units = Object.values(g.state.players[1].rows).flat();
  assert.ok(p1Units.some((u) => u.cardId === 'spy'));
  // card leaves hand (-1), draws 2 => hand +1
  assert.equal(g.state.players[1].hand.length, 10);
  assert.ok(rowScore(g, 1, 'close') >= 1);
  assert.ok(g.state.players[0].hand.length >= handBefore + 1);
});

test('medic revives a non-hero unit from the graveyard', () => {
  const g = newGame();
  clearBoard(g);
  g.state.players[0].graveyard.push(g._makeInst(g.state, 'revived', 0));
  playCard(g, 0, 'medic', {
    respond: (game) => {
      const opt = game.pending.options.find((o) => o.cardId === 'revived');
      game.respond({ uid: opt.uid });
    },
  });
  assert.ok(Object.values(g.state.players[0].rows).flat().some((u) => u.cardId === 'revived'));
});

test('medic revive of an agile unit keeps the card (reviveRow)', () => {
  const g = newGame();
  clearBoard(g);
  const agileInst = g._makeInst(g.state, 'agile', 0);
  g.state.players[0].graveyard.push(agileInst);
  playCard(g, 0, 'medic', {
    respond: (game) => {
      const opt = game.pending.options.find((o) => o.uid === agileInst.uid);
      game.respond({ uid: opt.uid });
      // now pending reviveRow
      game.respond({ row: 'ranged' });
    },
  });
  const onBoard = Object.values(g.state.players[0].rows).flat();
  assert.ok(onBoard.some((u) => u.uid === agileInst.uid), 'agile revived unit must be on the board');
  assert.ok(!g.state.players[0].graveyard.some((c) => c.uid === agileInst.uid), 'revived card must leave the graveyard');
});

test('muster pulls all same-group cards from the deck', () => {
  const g = newGame();
  clearBoard(g);
  g.state.players[0].deck.unshift(
    g._makeInst(g.state, 'muster-copy', 0),
    g._makeInst(g.state, 'muster-copy', 0),
  );
  playCard(g, 0, 'muster');
  const close = g.state.players[0].rows.close.map((u) => u.cardId);
  assert.equal(close.filter((c) => c === 'muster-copy').length, 2);
  assert.equal(close.filter((c) => c === 'muster').length, 1);
});

test('muster: same-name copies in deck are summoned (Arachas x3)', () => {
  const g = newGame();
  clearBoard(g);
  g.state.players[0].deck.unshift(
    g._makeInst(g.state, 'arachas', 0),
    g._makeInst(g.state, 'arachas', 0),
  );
  g.state.players[0].deck.unshift(g._makeInst(g.state, 'lone-behemoth', 0));
  playCard(g, 0, 'arachas');
  const close = g.state.players[0].rows.close.map((u) => u.cardId);
  assert.equal(close.filter((c) => c === 'arachas').length, 3, 'all three Arachas copies must be on board');
  assert.ok(!close.includes('lone-behemoth'), 'Arachas must NOT pull Arachas Behemoth');
  assert.ok(g.state.players[0].deck.some((c) => c.cardId === 'lone-behemoth'), 'Behemoth stays in deck');
});

test('muster: family group with colon names (Crones)', () => {
  const g = newGame();
  clearBoard(g);
  g.state.players[0].deck.unshift(
    g._makeInst(g.state, 'crone-b', 0),
    g._makeInst(g.state, 'crone-c', 0),
  );
  playCard(g, 0, 'crone-a');
  const close = g.state.players[0].rows.close.map((u) => u.cardId).sort();
  assert.deepEqual(close, ['crone-a', 'crone-b', 'crone-c']);
});

test('muster: Gaunter O\'Dimm summons Darkness copies', () => {
  const g = newGame();
  clearBoard(g);
  g.state.players[0].deck.unshift(
    g._makeInst(g.state, 'gaunter-dark', 0),
    g._makeInst(g.state, 'gaunter-dark', 0),
    g._makeInst(g.state, 'gaunter-dark', 0),
  );
  playCard(g, 0, 'gaunter');
  const all = Object.values(g.state.players[0].rows).flat().map((u) => u.cardId);
  assert.equal(all.filter((c) => c === 'gaunter-dark').length, 3);
});

test('muster with explicit group (Arachas Behemoth summons Arachas)', () => {
  const g = newGame();
  clearBoard(g);
  g.state.players[0].deck.unshift(
    g._makeInst(g.state, 'arachas', 0),
    g._makeInst(g.state, 'arachas', 0),
    g._makeInst(g.state, 'arachas', 0),
  );
  playCard(g, 0, 'behemoth');
  const close = g.state.players[0].rows.close.map((u) => u.cardId);
  assert.equal(close.filter((c) => c === 'arachas').length, 3);
});

test('decoy returns a unit to hand and leaves a 0-power placeholder', () => {
  const g = newGame();
  clearBoard(g);
  const soldier = place(g, 0, 'soldier');
  assert.equal(rowScore(g, 0, 'close'), 4);
  playCard(g, 0, 'decoy', { targetUid: soldier.uid });
  assert.ok(g.state.players[0].hand.some((c) => c.cardId === 'soldier'));
  assert.equal(rowScore(g, 0, 'close'), 0, 'only the decoy placeholder remains');
  const row = g.state.players[0].rows.close;
  assert.equal(row.length, 1);
  assert.equal(row[0].kind, 'decoy');
});

test('avenger: cow removed by decoy summons bovine defense force', () => {
  const g = newGame();
  clearBoard(g);
  const cow = place(g, 0, 'cow', 'ranged');
  playCard(g, 0, 'decoy', { targetUid: cow.uid });
  const close = g.state.players[0].rows.close.map((u) => u.cardId);
  assert.ok(close.includes('bdf'), 'BDF should have been summoned');
  assert.ok(g.state.players[0].hand.some((c) => c.cardId === 'cow'));
});

test('berserker transforms under mardroeme aura', () => {
  const g = newGame({ f0: 'skellige', f1: 'northern-realms', l0: 'l-skell' });
  clearBoard(g);
  const berserk = place(g, 0, 'berserk', 'close');
  playCard(g, 0, 'mardroeme', { rowOwner: 0, row: 'close' });
  const close = g.state.players[0].rows.close.map((u) => u.cardId);
  assert.ok(close.includes('bear'));
  assert.ok(!close.includes('berserk'));
  assert.ok(!g.state.players[0].graveyard.some((c) => c.uid === berserk.uid));
  assert.equal(rowScore(g, 0, 'close'), 14);
});

test('weather card: frost forces close combat units to 1; clear weather removes it', () => {
  const g = newGame();
  clearBoard(g);
  place(g, 0, 'soldier');
  place(g, 1, 'soldier');
  playCard(g, 0, 'frost');
  assert.equal(g.state.weather.frost, true);
  assert.equal(rowScore(g, 0, 'close'), 1);
  assert.equal(rowScore(g, 1, 'close'), 1);
  playCard(g, 0, 'clear');
  assert.equal(g.state.weather.frost, false);
  assert.equal(rowScore(g, 0, 'close'), 4);
});

test('duplicate weather is wasted', () => {
  const g = newGame();
  clearBoard(g);
  playCard(g, 0, 'frost');
  const before = g.state.weatherCards.length;
  playCard(g, 0, 'frost');
  assert.equal(g.state.weather.frost, true);
  assert.ok(g.state.players[0].graveyard.some((c) => c.cardId === 'frost'));
  assert.equal(g.state.weatherCards.length, before);
});

test('horn special can not be stacked on the same row', () => {
  const g = newGame();
  clearBoard(g);
  playCard(g, 0, 'horn', { row: 'close' });
  setupTurn(g, 0);
  const horn2 = giveHand(g, 0, ['horn'])[0];
  const res = g.apply({ type: 'playCard', uid: horn2.uid, row: 'close' });
  assert.equal(res.ok, false);
});

// ────────────────────────────────────────────────────────────────────────
// rule rulings (QA audit)
// ────────────────────────────────────────────────────────────────────────

test('King Bran: units lose half strength (rounded down), never below 1', () => {
  const g = makeGame({ f0: 'skellige', l0: 'l-passive-half' });
  startGame(g);
  clearBoard(g);
  for (const id of ['soldier', 'archer', 'siege']) place(g, 0, id, CARDS[id].rows[0]);
  // base 4 -> 2, 5 -> 3, 6 -> 3 under frost? weather only affects close for frost
  g.state.weather.frost = true;
  g._recompute(true);
  const close = g.state.players[0].rows.close.map((u) => u.cardId);
  assert.deepEqual(close, ['soldier']);
  assert.equal(rowScore(g, 0, 'close'), 2);
  // base 1 unit: 1 -> 1 (not 0)
  clearBoard(g);
  place(g, 0, 'muster', 'close'); // 4
  // use a 1-power unit: cow? no. Add via state directly using fixture 'morale' (2) => 1
  const one = g._makeInst(g.state, 'morale', 0);
  g.state.players[0].rows.close = [one];
  g.state.weather.frost = true;
  g._recompute(true);
  assert.equal(rowScore(g, 0, 'close'), 1);
});

test('Skellige round-3 revive excludes heroes', () => {
  const g = makeGame({ f0: 'skellige', f1: 'northern-realms', l0: 'l-skell' });
  startGame(g);
  clearBoard(g);
  // create graves directly
  for (const id of ['hero', 'revived', 'soldier', 'archer']) {
    g.state.players[0].graveyard.push(g._makeInst(g.state, id, 0));
  }
  // keep both players able to act so the round doesn't auto-finish
  g.state.players[0].hand.push(g._makeInst(g.state, 'soldier', 0));
  g.state.players[1].hand.push(g._makeInst(g.state, 'soldier', 1));
  g.state.round = 2;
  g.state.firstPlayer = 0;
  g.state.skipTurnSwap = true;
  g._startRound(3);
  g._pump();
  const units = Object.values(g.viewFor(0).players[0].rows).flat().map((u) => u.cardId);
  assert.equal(units.length, 2);
  assert.ok(!units.includes('hero'), 'heroes must not be revived by Skellige');
});

test('decoy steals an enemy spy on your battlefield into your hand', () => {
  const g = newGame();
  clearBoard(g);
  // p1's spy sits on p0's battlefield
  const spy = g._makeInst(g.state, 'spy', 1);
  spy.row = 'close';
  spy.boardOwner = 0;
  g.state.players[0].rows.close.push(spy);
  playCard(g, 0, 'decoy', { targetUid: spy.uid });
  assert.ok(g.state.players[0].hand.some((c) => c.uid === spy.uid), 'stolen spy should be in decoy player hand');
  assert.ok(!g.state.players[1].hand.some((c) => c.uid === spy.uid));
});

test('leader graveyard abilities can take special cards', () => {
  const g = makeGame({ l0: 'l-revive' });
  startGame(g);
  clearBoard(g);
  g.state.players[0].graveyard.push(g._makeInst(g.state, 'horn', 0));
  setupTurn(g, 0);
  assert.ok(g.apply({ type: 'useLeader' }).ok);
  assert.equal(g.pending.kind, 'takeGraveUnit');
  assert.ok(g.pending.options.some((o) => o.cardId === 'horn'));
  g.respond({ uid: g.pending.options[0].uid });
  assert.ok(g.state.players[0].hand.some((c) => c.cardId === 'horn'));
});

test('avenger token does not change the just-finished round score (scores freeze)', () => {
  const g = newGame({ f0: 'northern-realms', f1: 'monsters' });
  clearBoard(g);
  place(g, 0, 'soldier'); // 4
  place(g, 0, 'cow', 'ranged'); // 0, will transform at round end
  pass(g, 0);
  pass(g, 1);
  const h = g.state.roundHistory[0];
  assert.equal(h.scores[0], 4, 'BDF (8) must NOT count in the finished round');
  assert.equal(g.state.round, 2);
  const p0rows = g.viewFor(0).players[0].rows;
  const units = Object.values(p0rows).flat();
  assert.ok(units.some((u) => u.cardId === 'bdf'), 'BDF persists into round 2');
  assert.equal(g.viewFor(0).players[0].score, 8);
});

// ────────────────────────────────────────────────────────────────────────
// leaders
// ────────────────────────────────────────────────────────────────────────

test('leader: play weather from deck', () => {
  const g = makeGame({ l0: 'l-weather' });
  startGame(g);
  clearBoard(g);
  if (!g.state.players[0].deck.some((c) => c.cardId === 'frost')) {
    g.state.players[0].deck.unshift(g._makeInst(g.state, 'frost', 0));
  }
  setupTurn(g, 0);
  const res = g.apply({ type: 'useLeader' });
  assert.ok(res.ok, res.error);
  assert.equal(g.state.weather.frost, true);
  assert.equal(g.state.players[0].leaderUsed, true);
});

test('leader: horn row', () => {
  const g = makeGame({ l0: 'l-horn' });
  startGame(g);
  clearBoard(g);
  setupTurn(g, 0);
  assert.ok(g.apply({ type: 'useLeader' }).ok);
  assert.equal(g.state.players[0].rowSpecials.close?.kind, 'horn');
});

test('leader: scorch row', () => {
  const g = makeGame({ l0: 'l-scorch' });
  startGame(g);
  clearBoard(g);
  place(g, 1, 'soldier');
  place(g, 1, 'soldier');
  place(g, 1, 'soldier');
  setupTurn(g, 0);
  assert.ok(g.apply({ type: 'useLeader' }).ok);
  assert.equal(g.state.players[1].rows.close.length, 0);
});

test('leader: take unit from own graveyard to hand', () => {
  const g = makeGame({ l0: 'l-revive' });
  startGame(g);
  clearBoard(g);
  g.state.players[0].graveyard.push(g._makeInst(g.state, 'revived', 0));
  setupTurn(g, 0);
  assert.ok(g.apply({ type: 'useLeader' }).ok);
  assert.equal(g.pending?.kind, 'takeGraveUnit');
  const opt = g.pending.options[0];
  g.respond({ uid: opt.uid });
  assert.ok(g.state.players[0].hand.some((c) => c.cardId === 'revived'));
});

test('leader: discard 2 then draw 1 from deck', () => {
  const g = makeGame({ l0: 'l-discard' });
  startGame(g);
  clearBoard(g);
  setupTurn(g, 0);
  assert.ok(g.apply({ type: 'useLeader' }).ok);
  assert.equal(g.pending.kind, 'discardCards');
  const uids = g.pending.options.slice(0, 2).map((o) => o.uid);
  g.respond({ cards: uids });
  assert.equal(g.pending.kind, 'deckChoice');
  const handAfterDiscard = g.state.players[0].hand.length;
  g.respond({ uid: g.pending.options[0].uid });
  // -2 discarded +1 drawn
  assert.equal(g.state.players[0].hand.length, handAfterDiscard + 1);
});

test('leader: white flame cancels opponent leader', () => {
  const g = makeGame({ l0: 'l-white-flame', l1: 'l-horn' });
  startGame(g);
  assert.equal(g.state.players[0].leaderUsed, true);
  assert.equal(g.state.players[1].leaderCanceled, true);
  assert.equal(g.state.players[1].leaderUsed, false);
});

test('leader: passive double spy power', () => {
  const g = makeGame({ l0: 'l-passive-spy' });
  startGame(g);
  clearBoard(g);
  place(g, 1, 'spy'); // spy on p1 board; doubleSpy doubles spy power
  assert.equal(rowScore(g, 1, 'close'), 2);
});

test('leader: passive king bran halves weather loss', () => {
  const g = makeGame({ f0: 'skellige', l0: 'l-passive-half' });
  startGame(g);
  clearBoard(g);
  place(g, 0, 'soldier'); // 4 -> half = 2
  place(g, 1, 'soldier'); // 4 -> 1
  g.state.weather.frost = true;
  g._recompute(true);
  assert.equal(rowScore(g, 0, 'close'), 2);
  assert.equal(rowScore(g, 1, 'close'), 1);
});

test('leader: passive extra opening draw', () => {
  const g = makeGame({ l0: 'l-passive-extra' });
  startGame(g);
  assert.equal(g.state.players[0].hand.length, 11);
  assert.equal(g.state.players[1].hand.length, 10);
});

// ────────────────────────────────────────────────────────────────────────
// deck validation
// ────────────────────────────────────────────────────────────────────────

test('validateDeck: legal deck', () => {
  const list = [
    { id: 'soldier', count: 5 },
    { id: 'archer', count: 5 },
    { id: 'siege', count: 5 },
    { id: 'agile', count: 3 },
    { id: 'bond', count: 4 },
    { id: 'horn', count: 1 },
  ];
  const res = validateDeck(list, 'l-north', 'northern-realms', CARDS, LEADERS);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(res.stats.units, 22);
});

test('validateDeck: rejects too few units / too many specials / wrong faction', () => {
  const few = [{ id: 'soldier', count: 3 }];
  assert.equal(validateDeck(few, 'l-north', 'northern-realms', CARDS, LEADERS).ok, false);
  const manySpecials = [
    ...Array(3).fill({ id: 'soldier', count: 5 }),
    { id: 'archer', count: 4 }, { id: 'siege', count: 4 }, { id: 'bond', count: 4 },
    ...Array(11).fill({ id: 'horn', count: 1 }),
  ];
  const res = validateDeck(manySpecials, 'l-north', 'northern-realms', CARDS, LEADERS);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('特殊牌')));
});

// ────────────────────────────────────────────────────────────────────────
// long random playout — catches crashes and invalid states
// ────────────────────────────────────────────────────────────────────────

function autoPlayout(game, maxActions = 400) {
  let guard = 0;
  while (game.state.phase !== 'game-over' && guard++ < maxActions) {
    if (game.state.pending) {
      const p = game.pending;
      if (p.kind === 'medic') game.respond({ skip: true });
      else if (p.kind === 'reviveRow') game.respond({ row: p.options[0] });
      else if (p.kind === 'chooseFirstPlayer') game.respond({ first: 0 });
      else if (p.kind === 'viewHand') game.respond({ ack: true });
      else if (p.kind === 'takeGraveUnit') game.respond({ uid: p.options[0].uid });
      else if (p.kind === 'discardCards') game.respond({ cards: p.options.slice(0, p.count).map((o) => o.uid) });
      else if (p.kind === 'deckChoice') game.respond({ uid: p.options[0].uid });
      else if (p.kind === 'chooseWeather') game.respond({ uid: p.options[0].uid });
      else throw new Error('unhandled pending ' + p.kind);
      continue;
    }
    const actions = game.getActions();
    if (!actions.length) throw new Error('no actions but phase=' + game.state.phase);
    // Prefer plays, pass only when nothing else.
    const nonPass = actions.filter((a) => a.type !== 'pass');
    const action = nonPass.length && Math.random() > 0.15 ? nonPass[0] : actions[actions.length - 1];
    const res = game.apply(action);
    if (!res.ok) throw new Error('action rejected: ' + res.error + ' ' + JSON.stringify(action));
  }
  return guard;
}

test('random playout terminates without errors', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const g = startGame(
      makeGame({
        seed,
        f0: 'monsters',
        f1: 'skellige',
        l0: 'l-mons',
        l1: 'l-skell',
        deck0: mkDeck(['horn', 'decoy', 'scorch', 'frost', 'mardroeme']),
        deck1: mkDeck(['horn', 'decoy', 'scorch', 'fog', 'clear']),
      }),
    );
    const actions = autoPlayout(g);
    assert.ok(g.state.phase === 'game-over' || g.state.round >= 3, `seed ${seed} actions ${actions}`);
    const view = g.viewFor(0);
    assert.ok(view.phase === 'game-over', `seed ${seed} should finish, phase=${view.phase}`);
    assert.ok(view.result);
  }
});
