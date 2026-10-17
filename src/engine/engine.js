/**
 * Gwent (The Witcher 3) rules engine — deterministic, DOM-free state machine.
 *
 * See docs/GAME_RULES.md for the authoritative rule spec and
 * docs/ARCHITECTURE.md §5 for the public API used by UI / AI.
 */

import { hashSeed, randInt, pickRandom, pickRandomMany, shuffle } from './rng.js';
import {
  ROW_KEYS,
  abilityIds,
  getAbility,
  hasAbility,
  computeScores,
  computeAllRows,
  rowTotal,
  strongestOnBoard,
  strongestInRow,
  WEATHER_ROWS,
} from './scoring.js';

export const STARTING_HAND = 10;
export const MULLIGAN_COUNT = 2;
export const STARTING_GEMS = 2;
export const MAX_ROUNDS = 3;

const ROW_ZH = { close: '近战行', ranged: '远程行', siege: '攻城行' };
const WEATHER_ZH = { frost: '严寒冰霜', fog: '浓雾', rain: '暴雨', storm: '史凯利格风暴', clear: '晴朗' };

const FACTION_ROUND_ABILITY = {
  'northern-realms': 'drawOnRoundWin',
  nilfgaard: 'winTies',
  scoiatael: 'chooseFirstPlayer',
  monsters: 'keepRandomUnit',
  skellige: 'round3Revive',
};

let gameSeq = 0;

function makeError(msg) {
  return { ok: false, error: msg, events: [] };
}

export class GwentEngine {
  constructor(config, internalState = null) {
    if (!config) throw new Error('createGame() requires a config');
    this.config = config;
    this.cardDb = config.cards ?? {};
    this.leaders = config.leaders ?? {};
    this.factions = config.factions ?? {};
    this.gameId = ++gameSeq;
    this.pendingChoiceResolver = null;
    if (internalState) {
      this.state = internalState;
      return;
    }
    this.state = this._createState(config);
    this._pump();
    this.startEvents = this.state.events.slice();
    this.state.events = [];
  }

  // ────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────

  clone() {
    if (this.state.pending) {
      // structuredClone of a state with pending is fine — pending contains only data.
    }
    const copy = new GwentEngine(this.config, structuredClone(this.state));
    copy.state.events = [];
    return copy;
  }

  get pending() {
    return this.state.pending;
  }

  get phase() {
    return this.state.phase;
  }

  get round() {
    return this.state.round;
  }

  get turn() {
    return this.state.turn;
  }

  viewFor(pov = 0) {
    const view = this._buildView(pov);
    view.actions = this.getActions();
    return view;
  }

  result() {
    return this.state.result ? { ...this.state.result } : null;
  }

  getActions() {
    const st = this.state;
    if (st.pending || st.phase !== 'play') return [];
    const p = st.turn;
    if (st.players[p].passed) return [];
    const actions = [];
    for (const inst of st.players[p].hand) {
      const card = this.cardDb[inst.cardId];
      if (!card) continue;
      if (card.type === 'weather') {
        const w = getAbility(card, 'weather');
        if (!w) continue;
        actions.push({ type: 'playCard', uid: inst.uid, player: p, label: `打出 ${card.nameZh || card.nameEn}` });
        continue;
      }
      if (card.type === 'special') {
        const horn = getAbility(card, 'horn');
        const mard = getAbility(card, 'mardroeme');
        const decoy = getAbility(card, 'decoy');
        const scorch = getAbility(card, 'scorch');
        if (horn) {
          for (const row of ROW_KEYS) {
            const r = p;
            if (!this._rowHasHorn(p, row)) {
              actions.push({ type: 'playCard', uid: inst.uid, player: p, row, rowOwner: r, label: `号角 → ${row}` });
            }
          }
        } else if (mard) {
          for (const owner of [0, 1]) {
            for (const row of ROW_KEYS) {
              if (!st.players[owner].rowSpecials[row]) {
                actions.push({
                  type: 'playCard', uid: inst.uid, player: p, row, rowOwner: owner,
                  label: `曼陀罗 → P${owner} ${row}`,
                });
              }
            }
          }
        } else if (decoy) {
          for (const row of ROW_KEYS) {
            for (const target of st.players[p].rows[row]) {
              const tcard = this.cardDb[target.cardId];
              if (tcard && tcard.type === 'unit' && !tcard.hero) {
                actions.push({
                  type: 'playCard', uid: inst.uid, player: p, targetUid: target.uid,
                  row, label: `诱饵 ⇄ ${tcard.nameZh || tcard.nameEn}`,
                });
              }
            }
          }
        } else if (scorch) {
          actions.push({ type: 'playCard', uid: inst.uid, player: p, label: `打出 ${card.nameZh || card.nameEn}` });
        }
        continue;
      }
      // unit
      const rows = card.rows?.length ? card.rows : [null];
      const spy = hasAbility(card, 'spy');
      for (const row of rows) {
        actions.push({
          type: 'playCard', uid: inst.uid, player: p,
          row: row ?? undefined,
          targetBoard: spy ? 1 - p : p,
          label: `打出 ${card.nameZh || card.nameEn}${row ? ' → ' + row : ''}`,
        });
      }
    }
    const leaderInfo = this._leaderActionInfo(p);
    if (leaderInfo.available) {
      actions.push({ type: 'useLeader', player: p, label: `领袖能力：${this.leaders[st.players[p].leaderId]?.nameZh || ''}` });
    }
    actions.push({ type: 'pass', player: p, label: '放弃本局' });
    return actions;
  }

  /** Apply an action for the current player. */
  apply(action) {
    const st = this.state;
    st.events = [];
    if (st.pending) return makeError('当前需要先完成选择（pending）');
    if (!action || typeof action !== 'object') return makeError('无效动作');
    if (st.phase !== 'play') return makeError('当前阶段不能执行该动作');
    if (st.passed[st.turn]) return makeError('已放弃本局，不能行动');
    const player = st.turn;
    try {
      switch (action.type) {
        case 'playCard':
          return this._applyPlayCard(player, action);
        case 'useLeader':
          return this._applyUseLeader(player);
        case 'pass':
          return this._applyPass(player);
        default:
          return makeError('未知动作类型：' + action.type);
      }
    } catch (err) {
      console.error('[engine] action failed', err);
      return makeError(err.message || String(err));
    }
  }

  /** Resolve the current pending choice. */
  respond(choice) {
    const st = this.state;
    st.events = [];
    if (!st.pending) return makeError('当前没有待处理的选择');
    try {
      const pending = st.pending;
      st.pending = null;
      switch (pending.kind) {
        case 'chooseFirstPlayer':
          this._resolveChooseFirst(pending, choice);
          break;
        case 'mulligan':
          this._resolveMulligan(pending, choice);
          break;
        case 'medic':
          this._resolveMedic(pending, choice);
          break;
        case 'reviveRow':
          this._resolveReviveRow(pending, choice);
          break;
        case 'takeGraveUnit':
          this._resolveTakeGraveUnit(pending, choice);
          break;
        case 'viewHand':
          this._log(`P${pending.player} 查看了对手的 ${pending.cards.length} 张手牌`);
          break;
        case 'chooseWeather':
          this._resolveChooseWeather(pending, choice);
          break;
        case 'discardCards':
          this._resolveDiscardCards(pending, choice);
          break;
        case 'deckChoice':
          this._resolveDeckChoice(pending, choice);
          break;
        default:
          return makeError('未知的选择类型：' + pending.kind);
      }
      this._pump();
      return { ok: true, events: st.events.slice() };
    } catch (err) {
      console.error('[engine] respond failed', err);
      return makeError(err.message || String(err));
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Game setup
  // ────────────────────────────────────────────────────────────────

  _createState(config) {
    const seed = hashSeed(config.seed ?? Date.now());
    const st = {
      seed,
      rngState: seed,
      phase: 'setup',
      stage: 'setup',
      round: 0,
      turn: 0,
      firstPlayer: 0,
      passed: [false, false],
      gems: [STARTING_GEMS, STARTING_GEMS],
      weather: { frost: false, fog: false, rain: false, storm: false },
      weatherCards: [],
      players: [],
      passives: { doubleSpy: false, randomRevive: false },
      pending: null,
      stack: [],
      after: [],
      finalize: false,
      skipTurnSwap: false,
      log: [],
      events: [],
      roundHistory: [],
      result: null,
      uidSeq: 0,
      scores: [
        { score: 0, rows: { close: 0, ranged: 0, siege: 0 } },
        { score: 0, rows: { close: 0, ranged: 0, siege: 0 } },
      ],
      toastSeq: 0,
      version: 0,
    };

    if (!Array.isArray(config.players) || config.players.length !== 2) {
      throw new Error('createGame 需要 2 名玩家');
    }
    // Helpers such as _draw/_emit read this.state; expose the state being built.
    this.state = st;

    st.players = config.players.map((p, index) => {
      const leader = this.leaders[p.leaderId];
      const insts = (p.deck ?? []).map((cardId) => this._makeInst(st, cardId, index));
      return {
        index,
        id: p.id ?? (index === 0 ? 'player' : 'ai'),
        isAI: !!p.isAI || index === 1,
        faction: p.faction,
        leaderId: p.leaderId,
        leaderUsed: false,
        leaderCanceled: false,
        passives: [],
        hand: [],
        deck: shuffle(st, insts),
        graveyard: [],
        rows: { close: [], ranged: [], siege: [] },
        rowSpecials: { close: null, ranged: null, siege: null },
        passed: false,
        mulliganChoice: null,
        pendingDraws: 0,
        keepUid: null,
      };
    });

    this._applyLeaderPassives(st);
    this._log('对局开始 — 双方各抽 10 张牌');

    // Initial draws.
    for (let i = 0; i < STARTING_HAND; i++) {
      for (const p of st.players) this._draw(p.index, 1, { silent: false, reason: 'initial' });
    }
    // Francesca: Daisy of the Valley - draw an extra card at the beginning of the battle.
    for (const p of st.players) {
      if (p.passives.includes('drawExtraStart')) this._draw(p.index, 1, { silent: false, reason: 'daisy' });
    }
    st.players.forEach((p) => {
      if (p.hand.length) this._emit('draw', { player: p.index, count: p.hand.length, cardIds: p.hand.map((c) => c.cardId), initial: true });
    });

    // Scoia'tael chooses who starts; otherwise coin flip.
    const stPlayers = st.players.map((p, i) => ({ p, i })).filter(({ p }) => p.faction === 'scoiatael');
    if (stPlayers.length === 1) {
      const chooser = stPlayers[0].i;
      st.pending = { kind: 'chooseFirstPlayer', player: chooser, options: [0, 1] };
    } else {
      st.firstPlayer = randInt(st, 2);
      this._emit('coinToss', { firstPlayer: st.firstPlayer });
      this._log(`抛硬币：P${st.firstPlayer} 先手`);
      this._beginMulliganPhase(st);
    }
    return st;
  }

  _applyLeaderPassives(st) {
    // White Flame: cancel opponent's leader ability.
    const cancelers = st.players.filter((p) => this._leaderHas(p.leaderId, 'cancelLeader'));
    if (cancelers.length) {
      for (const c of cancelers) {
        c.leaderUsed = true; // its "ability" is spent at setup
        const opp = st.players[1 - c.index];
        opp.leaderCanceled = true;
        this._log(`「Emhyr var Emreis: The White Flame」取消了 P${opp.index} 的领袖能力`);
        this._emit('leaderCanceled', { player: opp.index });
      }
    }
    for (const p of st.players) {
      const leader = this.leaders[p.leaderId];
      if (!leader) continue;
      const abilities = leader.abilities ?? leader.ability ?? [];
      const list = Array.isArray(abilities) ? abilities : [abilities];
      for (const ab of list) {
        const id = typeof ab === 'string' ? ab : ab.id;
        switch (id) {
          case 'doubleSpy':
            st.passives.doubleSpy = true;
            p.leaderUsed = true;
            break;
          case 'halfWeather':
            p.passives.push('halfWeather');
            p.leaderUsed = true;
            break;
          case 'randomRevive':
            st.passives.randomRevive = true;
            p.leaderUsed = true;
            break;
          case 'drawExtraStart':
            p.passives.push('drawExtraStart');
            p.leaderUsed = true;
            break;
          default:
            break;
        }
      }
    }
  }

  _leaderHas(leaderId, abilityId) {
    const leader = this.leaders[leaderId];
    if (!leader) return false;
    const abilities = leader.abilities ?? leader.ability ?? [];
    const list = Array.isArray(abilities) ? abilities : [abilities];
    return list.some((a) => (typeof a === 'string' ? a : a.id) === abilityId);
  }

  _beginMulliganPhase(st) {
    st.stage = 'mulligan';
    st.pending = { kind: 'mulligan', player: 0, count: MULLIGAN_COUNT, chosen: [] };
    this._emit('stage', { stage: 'mulligan' });
  }

  _resolveChooseFirst(pending, choice) {
    const st = this.state;
    const first = choice?.first === 1 ? 1 : choice?.first === 0 ? 0 : null;
    if (first === null) throw new Error('无效的先手选择');
    st.firstPlayer = first;
    this._emit('coinToss', { firstPlayer: first, byScoiatael: true });
    this._log(`松鼠党选择 P${first} 先手`);
    this._beginMulliganPhase(st);
  }

  _resolveMulligan(pending, choice) {
    const st = this.state;
    const p = pending.player;
    const chosen = Array.isArray(choice?.cards) ? choice.cards.slice(0, MULLIGAN_COUNT) : [];
    // Validate chosen are in hand + unique.
    const handUids = new Set(st.players[p].hand.map((c) => c.uid));
    const unique = [...new Set(chosen)].filter((uid) => handUids.has(uid));
    st.players[p].mulliganChoice = unique;
    this._emit('mulliganChoice', { player: p, count: unique.length });
    if (p === 0) {
      st.pending = { kind: 'mulligan', player: 1, count: MULLIGAN_COUNT, chosen: [] };
      return;
    }
    // Both chose: perform redraws simultaneously.
    for (const pl of st.players) {
      const chosenUids = pl.mulliganChoice ?? [];
      if (!chosenUids.length) continue;
      const chosenInsts = pl.hand.filter((c) => chosenUids.includes(c.uid));
      pl.hand = pl.hand.filter((c) => !chosenUids.includes(c.uid));
      pl.deck.push(...chosenInsts);
      pl.deck = shuffle(st, pl.deck);
      for (let i = 0; i < chosenInsts.length; i++) this._draw(pl.index, 1, { silent: true, reason: 'mulligan' });
      this._emit('mulligan', {
        player: pl.index,
        outCardIds: chosenInsts.map((c) => c.cardId),
        inCardIds: pl.hand.slice(-chosenInsts.length).map((c) => c.cardId),
      });
      this._log(`P${pl.index} 换掉了 ${chosenInsts.length} 张牌`);
    }
    st.stage = 'play';
    this.state.skipTurnSwap = true;
    this._startRound(1);
  }

  // ────────────────────────────────────────────────────────────────
  // Round lifecycle
  // ────────────────────────────────────────────────────────────────

  _startRound(roundNo) {
    const st = this.state;
    st.round = roundNo;
    st.phase = 'play';
    st.stage = 'play';
    st.passed = [false, false];
    st.turn = st.firstPlayer;
    st.skipTurnSwap = true;
    for (const p of st.players) {
      p.passed = false;
      p.keepUid = null;
      // Northern Realms: draw for a won previous round.
      if (p.pendingDraws > 0) {
        const n = p.pendingDraws;
        p.pendingDraws = 0;
        this.state.stack.push({ kind: 'draw', player: p.index, n, reason: 'northern-realms' });
      }
    }
    // Skellige: round 3 revive.
    if (roundNo === 3) {
      st.players.forEach((p) => {
        if (p.faction === 'skellige') {
          this.state.stack.push({ kind: 'skelligeRevive', player: p.index });
        }
      });
    }
    this._emit('roundStarted', {
      round: roundNo,
      firstPlayer: st.firstPlayer,
      scores: this._scoresArray(),
      gems: st.gems.slice(),
    });
    this._log(`—— 第 ${roundNo} 小局开始，P${st.firstPlayer} 先手 ——`);
    this._recompute(true);
    this.state.finalize = true;
  }

  _endRound() {
    const st = this.state;
    const computed = computeScores(st, this.cardDb);
    const scores = computed.map((c) => c.score);
    const starters = st.firstPlayer;
    let winner = null;
    let tie = false;
    let nilfTie = false;
    if (scores[0] === scores[1]) {
      tie = true;
      const nilf = st.players.map((p) => p.faction === 'nilfgaard');
      if (nilf[0] !== nilf[1]) {
        winner = nilf[0] ? 0 : 1;
        nilfTie = true;
        st.gems[1 - winner] -= 1;
      } else {
        st.gems[0] -= 1;
        st.gems[1] -= 1;
      }
    } else {
      winner = scores[0] > scores[1] ? 0 : 1;
      st.gems[1 - winner] -= 1;
    }
    const history = {
      round: st.round,
      scores: scores.slice(),
      winner,
      tie,
      nilfTie,
      gems: st.gems.slice(),
    };
    st.roundHistory.push(history);
    this._emit('roundEnded', {
      round: st.round,
      scores: scores.slice(),
      winner,
      tie,
      nilfTie,
      gems: st.gems.slice(),
      history,
    });
    this._log(`第 ${st.round} 小局结束：${scores[0]} : ${scores[1]}，${winner === null ? '平局' : `P${winner} 获胜`}`);

    // Monster faction: keep one random unit.
    for (const p of st.players) {
      if (p.faction !== 'monsters') continue;
      const units = [];
      for (const row of ROW_KEYS) {
        for (const inst of p.rows[row]) {
          if (this.cardDb[inst.cardId]?.type === 'unit') units.push(inst);
        }
      }
      const kept = pickRandom(st, units);
      if (kept) {
        p.keepUid = kept.uid;
        this._emit('monsterKeep', { player: p.index, uid: kept.uid, cardId: kept.cardId });
        this._log(`怪物能力：P${p.index} 保留了「${this.cardDb[kept.cardId]?.nameZh ?? kept.cardId}」`);
      }
    }

    // Clear boards; avengers spawn their token which stays for the next round.
    for (const p of st.players) {
      for (const row of ROW_KEYS) {
        const rowInsts = [...p.rows[row]];
        for (const inst of rowInsts) {
          if (p.keepUid === inst.uid) continue;
          this._removeFromBoard(inst, { toGrave: true });
        }
      }
      // row specials -> graveyard
      for (const row of ROW_KEYS) {
        const special = p.rowSpecials[row];
        if (special) {
          if (special.inst) p.graveyard.push(special.inst);
          p.rowSpecials[row] = null;
        }
      }
    }
    // weather cards -> graveyards of their owners
    for (const inst of st.weatherCards) {
      const owner = st.players[inst.owner];
      owner.graveyard.push(inst);
    }
    st.weatherCards = [];
    st.weather = { frost: false, fog: false, rain: false, storm: false };
    this._emit('weatherChanged', { weather: { ...st.weather }, cleared: true });
    this._recompute(true);

    // Northern Realms: extra card on round win.
    if (winner !== null && st.players[winner].faction === 'northern-realms') {
      st.players[winner].pendingDraws += 1;
    }

    const over = st.gems[0] <= 0 || st.gems[1] <= 0 || st.round >= MAX_ROUNDS;
    if (over) {
      let gameWinner = null;
      if (st.gems[0] <= 0 && st.gems[1] <= 0) gameWinner = null;
      else if (st.gems[0] <= 0) gameWinner = 1;
      else if (st.gems[1] <= 0) gameWinner = 0;
      else gameWinner = st.gems[0] === st.gems[1] ? null : st.gems[0] > st.gems[1] ? 0 : 1;
      st.phase = 'game-over';
      st.result = {
        winner: gameWinner,
        gems: st.gems.slice(),
        history: st.roundHistory.map((h) => ({ ...h })),
        reason: gameWinner === null ? 'draw' : 'rounds',
      };
      this._emit('gameOver', { winner: gameWinner, gems: st.gems.slice(), history: st.result.history });
      this._log(
        gameWinner === null
          ? '比赛结束：平局'
          : `比赛结束：P${gameWinner}（${st.players[gameWinner].faction}）获胜`,
      );
      return;
    }

    this._emit('gemsUpdate', { gems: st.gems.slice() });
    // Next round: winner starts; on draw the previous starter starts again.
    st.firstPlayer = winner ?? starters;
    this.state.phase = 'round-end';
    this.state.stack.push({ kind: 'startRound', round: st.round + 1 });
  }

  // ────────────────────────────────────────────────────────────────
  // Turn / action handling
  // ────────────────────────────────────────────────────────────────

  _applyPass(player) {
    const st = this.state;
    st.players[player].passed = true;
    st.passed[player] = true;
    this._emit('pass', { player });
    this._log(`P${player} 放弃了本小局`);
    this.state.finalize = true;
    this._pump();
    return { ok: true, events: st.events.slice() };
  }

  _applyPlayCard(player, action) {
    const st = this.state;
    const inst = st.players[player].hand.find((c) => c.uid === action.uid);
    if (!inst) return makeError('该牌不在手牌中');
    const card = this.cardDb[inst.cardId];
    if (!card) return makeError('未知卡牌');

    if (card.type === 'weather') {
      const w = getAbility(card, 'weather');
      if (!w) return makeError('天气牌缺少天气属性');
      this._removeHand(player, inst);
      this._playWeatherCard(player, inst, w.weather);
      this.state.finalize = true;
      this._pump();
      return { ok: true, events: st.events.slice() };
    }

    if (card.type === 'special') {
      const horn = getAbility(card, 'horn');
      const mard = getAbility(card, 'mardroeme');
      const decoy = getAbility(card, 'decoy');
      const scorch = getAbility(card, 'scorch');
      if (horn) {
        const row = action.row;
        if (!ROW_KEYS.includes(row)) return makeError('请选择号角所在的行');
        if (st.players[player].rowSpecials[row]) return makeError('该行已有号角或曼陀罗效果');
        this._removeHand(player, inst);
        st.players[player].rowSpecials[row] = { kind: 'horn', uid: inst.uid, cardId: inst.cardId, inst };
        this._emit('hornPlaced', { player, row, uid: inst.uid, cardId: inst.cardId });
        this._log(`P${player} 在${ROW_ZH[row] || row}吹响号角`);
      } else if (mard) {
        const row = action.row;
        const rowOwner = action.rowOwner === 1 ? 1 : 0;
        if (!ROW_KEYS.includes(row)) return makeError('请选择曼陀罗所在的行');
        if (st.players[rowOwner].rowSpecials[row]) return makeError('该行已有号角或曼陀罗效果');
        this._removeHand(player, inst);
        st.players[rowOwner].rowSpecials[row] = { kind: 'mardroeme', uid: inst.uid, cardId: inst.cardId, inst };
        this._emit('mardroemePlaced', { player, row, rowOwner, uid: inst.uid, cardId: inst.cardId });
        this._log(`P${player} 在 P${rowOwner} 的${ROW_ZH[row] || row}使用曼陀罗`);
        this.state.stack.push({ kind: 'transformRow', player: rowOwner, row });
      } else if (decoy) {
        const target = this._findUnitByUid(action.targetUid);
        if (!target) return makeError('诱饵需要选择场上一张非英雄单位');
        const targetCard = this.cardDb[target.inst.cardId];
        if (!targetCard || targetCard.type !== 'unit') return makeError('只能交换单位牌');
        if (targetCard.hero) return makeError('英雄牌不能作为诱饵目标');
        if (target.inst.boardOwner !== player) return makeError('只能交换自己场地上的单位');
        const row = target.row;
        this._removeHand(player, inst);
        // Return target to the decoy player's hand (ownership transfers; triggers avenger).
        this._removeFromBoard(target.inst, { toGrave: false, toHand: player });
        target.inst.owner = player;
        st.players[player].hand.push(target.inst);
        // Decoy placeholder stays on the row.
        const decoyInst = { ...inst, kind: 'decoy', row, boardOwner: player, deckRow: row, isToken: true };
        st.players[player].rows[row].push(decoyInst);
        this._emit('decoy', {
          player, row, uid: target.inst.uid, decoyUid: decoyInst.uid, cardId: inst.cardId,
          returnedCardId: target.inst.cardId,
        });
        this._log(`P${player} 用诱饵换回了「${targetCard.nameZh || targetCard.nameEn}」`);
      } else if (scorch) {
        this._removeHand(player, inst);
        this._toGrave(player, inst);
        this._emit('cardPlayed', { player, uid: inst.uid, cardId: inst.cardId, row: null, cardType: 'special' });
        this.state.stack.push({ kind: 'scorch', player, mode: 'any' });
      } else {
        return makeError('未知特殊牌');
      }
      this.state.finalize = true;
      this._pump();
      return { ok: true, events: st.events.slice() };
    }

    // Unit card
    const rows = card.rows ?? [];
    let row = action.row;
    if (!row && rows.length === 1) row = rows[0];
    if (!row) return makeError('请为该牌选择行');
    if (!rows.includes(row)) return makeError('该牌不能放在这一行');
    const boardOwner = hasAbility(card, 'spy') ? 1 - player : player;
    this._removeHand(player, inst);
    inst.row = row;
    inst.boardOwner = boardOwner;
    st.players[boardOwner].rows[row].push(inst);
    this._emit('cardPlayed', {
      player, uid: inst.uid, cardId: inst.cardId, row, boardOwner,
      spy: hasAbility(card, 'spy'), hero: !!card.hero, cardType: 'unit',
    });
    this._log(
      `P${player} 打出「${card.nameZh || card.nameEn}」到${boardOwner === player ? '自己' : '对手'}的${ROW_ZH[row] || row}`,
    );
    this.state.stack.push({ kind: 'enter', owner: player, uid: inst.uid, row, boardOwner });
    this.state.finalize = true;
    this._pump();
    return { ok: true, events: st.events.slice() };
  }

  _applyUseLeader(player) {
    const st = this.state;
    const info = this._leaderActionInfo(player);
    if (!info.available) return makeError('领袖能力不可用');
    const p = st.players[player];
    const leader = this.leaders[p.leaderId];
    p.leaderUsed = true;
    const abilities = leader.abilities ?? leader.ability ?? [];
    const ab = (Array.isArray(abilities) ? abilities : [abilities]).find(
      (a) => typeof a === 'object' && !a.passive,
    ) ?? (Array.isArray(abilities) ? abilities[0] : abilities);
    const id = typeof ab === 'string' ? ab : ab.id;
    this._emit('leaderUsed', { player, leaderId: p.leaderId, ability: id });
    this._log(`P${player} 发动领袖能力「${leader.nameZh || leader.nameEn}」`);
    this.state.stack.push({ kind: 'leaderAbility', player, ability: ab });
    this.state.finalize = true;
    this._pump();
    return { ok: true, events: st.events.slice() };
  }

  _leaderActionInfo(player) {
    const st = this.state;
    const p = st.players[player];
    if (st.phase !== 'play' || st.pending) return { available: false, reason: 'phase' };
    if (st.turn !== player) return { available: false, reason: 'turn' };
    if (p.passed) return { available: false, reason: 'passed' };
    if (p.leaderUsed) return { available: false, reason: 'used' };
    if (p.leaderCanceled) return { available: false, reason: 'canceled' };
    const leader = this.leaders[p.leaderId];
    if (!leader) return { available: false, reason: 'nodata' };
    const abilities = leader.abilities ?? leader.ability ?? [];
    const list = Array.isArray(abilities) ? abilities : [abilities];
    const hasActive = list.some((a) => (typeof a === 'string' ? a : !a.passive));
    return { available: hasActive, reason: hasActive ? 'ok' : 'passive' };
  }

  _canAct(player) {
    const p = this.state.players[player];
    if (p.passed) return false;
    if (p.hand.length > 0) return true;
    const info = this._leaderActionInfo(player);
    return info.available;
  }

  _finalizeAction() {
    const st = this.state;
    if (st.phase !== 'play') return;
    if (!st.skipTurnSwap) {
      const cur = st.turn;
      const opp = 1 - cur;
      if (!st.passed[opp]) {
        st.turn = opp;
        this._emit('turnChanged', { player: opp });
      }
    }
    st.skipTurnSwap = false;

    let guard = 0;
    while (guard++ < 4) {
      const cur = st.turn;
      if (!st.passed[cur] && !this._canAct(cur)) {
        st.players[cur].passed = true;
        st.passed[cur] = true;
        this._emit('pass', { player: cur, auto: true });
        this._log(`P${cur} 无牌可出，自动放弃`);
      }
      if (st.passed[0] && st.passed[1]) {
        this._endRound();
        return;
      }
      if (st.passed[cur]) {
        st.turn = 1 - cur;
        this._emit('turnChanged', { player: st.turn });
        continue;
      }
      break;
    }
    this._recompute();
  }

  // ────────────────────────────────────────────────────────────────
  // Effect task queue
  // ────────────────────────────────────────────────────────────────

  _pump() {
    const st = this.state;
    let guard = 0;
    while (guard++ < 800) {
      if (st.pending) return;
      if (st.stack.length) {
        const task = st.stack.shift();
        this._execTask(task);
        continue;
      }
      if (st.after.length) {
        const task = st.after.shift();
        this._execAfter(task);
        continue;
      }
      if (st.finalize) {
        st.finalize = false;
        this._finalizeAction();
        continue;
      }
      return;
    }
    console.error('[engine] resolution guard tripped', st.stack, st.after);
  }

  _execTask(task) {
    const st = this.state;
    switch (task.kind) {
      case 'draw':
        this._draw(task.player, task.n, { reason: task.reason });
        break;
      case 'enter':
        this._enterEffects(task.owner, task.uid, task.row, task.boardOwner);
        break;
      case 'muster':
        this._muster(task);
        break;
      case 'medic':
        this._medicStart(task);
        break;
      case 'medicAuto': {
        const options = this._graveUnits(task.player).filter((c) => this._canBeRevived(c.cardId));
        const chosen = pickRandom(this.state, options);
        if (chosen) this._reviveUnit(task.player, chosen.uid);
        break;
      }
      case 'transformBerserker':
        this._transformBerserker(task.player, task.row, task.uid);
        break;
      case 'scorch':
        this._resolveScorchTask(task);
        break;
      case 'transformRow':
        this._transformBerserkers(task.player, task.row);
        break;
      case 'avenger':
        this._spawnAvenger(task);
        break;
      case 'leaderAbility':
        this._leaderAbility(task);
        break;
      case 'playWeatherCard': {
        const inst = this._findByIdentity(task.uid);
        if (inst && task.fromDeck) {
          this.state.players[task.player].deck = this.state.players[task.player].deck.filter((c) => c.uid !== inst.uid);
        }
        this._playWeatherCard(task.player, inst, task.weather, { fromDeck: !!task.fromDeck });
        break;
      }
      case 'skelligeRevive':
        this._skelligeRevive(task.player);
        break;
      case 'startRound':
        st.phase = 'play';
        this._startRound(task.round);
        break;
      case 'takeGraveToHand':
        this._moveGraveToHand(task.player, task.from, task.uid);
        break;
      case 'discardResolve':
        this._discardCardsNow(task);
        break;
      case 'deckToHand':
        this._moveDeckToHand(task.player, task.uid);
        break;
      case 'shuffleGraveyards':
        this._shuffleGraveyards();
        break;
      case 'repositionAgile':
        this._repositionAgile(task.player);
        break;
      case 'clearWeather':
        this._clearWeather();
        break;
      case 'recompute':
        this._recompute(true);
        break;
      case 'log':
        this._log(task.text);
        break;
      default:
        console.warn('[engine] unknown task', task);
    }
    this._recompute();
  }

  _execAfter(task) {
    switch (task.kind) {
      default:
        console.warn('[engine] unknown after-task', task);
    }
  }

  _enterEffects(owner, uid, row, boardOwner = owner) {
    const found = this._findUnitByUid(uid);
    if (!found) return;
    const inst = found.inst;
    const card = this.cardDb[inst.cardId];
    if (!card) return;
    const abilities = (card.abilities ?? []).map((a) => (typeof a === 'string' ? { id: a } : a));
    const ids = abilities.map((a) => a.id);

    // Spy: draw 2 from own deck.
    if (ids.includes('spy')) {
      this._draw(owner, 2, { reason: 'spy' });
      this._emit('spyDraw', { player: owner, uid, cardId: inst.cardId, boardOwner });
    }

    // Muster (incl. Cerys from hand+deck).
    const muster = abilities.find((a) => a.id === 'muster');
    if (muster) {
      this.state.stack.push({
        kind: 'muster',
        player: owner,
        uid,
        cardId: inst.cardId,
        group: muster.group || card.nameEn,
        from: muster.from || ['deck'],
      });
    }

    // Medic (may chain via revive).
    if (ids.includes('medic')) {
      const options = this._graveUnits(owner).filter((c) => this._canBeRevived(c.cardId));
      if (options.length) {
        if (this.state.passives.randomRevive) {
          const chosen = pickRandom(this.state, options);
          this.state.stack.push({ kind: 'medicAuto', player: owner, uid: chosen.uid, sourceUid: uid });
        } else {
          this.state.pending = {
            kind: 'medic',
            player: owner,
            sourceUid: uid,
            sourceCardId: inst.cardId,
            options: options.map((c) => ({ uid: c.uid, cardId: c.cardId })),
          };
        }
      }
    }

    // Unit scorch abilities.
    for (const ab of abilities) {
      if (ab.id !== 'scorch') continue;
      if (ab.mode === 'any') {
        this.state.stack.push({ kind: 'scorch', player: owner, mode: 'any' });
      } else if (ab.mode === 'row') {
        this.state.stack.push({
          kind: 'scorch',
          player: owner,
          mode: 'row',
          row: ab.row,
          require: ab.requireEnemyRowTotalAtLeast ?? 10,
        });
      }
    }

    // Mardroeme unit (Ermion): transform berserkers on the same row.
    if (ids.includes('mardroeme')) {
      this.state.stack.push({ kind: 'transformRow', player: boardOwner, row });
    }

    // Berserker: transform if the row already has a mardroeme aura.
    const berserker = abilities.find((a) => a.id === 'berserker');
    if (berserker) {
      const aura = this._rowHasMardroeme(boardOwner, row);
      if (aura) {
        this.state.stack.push({ kind: 'transformBerserker', player: boardOwner, row, uid });
      }
    }

    this._emit('cardEntered', { player: owner, uid, cardId: inst.cardId, row, boardOwner });
  }

  _muster(task) {
    const st = this.state;
    const sourceCard = this.cardDb[task.cardId];
    const group = task.group || sourceCard?.nameEn || task.cardId;
    const normalize = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const gN = normalize(group);
    const srcN = normalize(sourceCard?.nameEn || '');
    const sourceEqualsGroup = srcN === gN;
    const ownGroupOf = (card) => {
      const ab = (card?.abilities ?? []).find((a) => (typeof a === 'string' ? a : a.id) === 'muster');
      return normalize(ab?.group || card?.nameEn || '');
    };
    const matches = (inst) => {
      if (inst.uid === task.uid) return false;
      const c = this.cardDb[inst.cardId];
      if (!c) return false;
      const n = normalize(c.nameEn);
      if (n === srcN) return true; // same-name copies
      if (n === gN) return true; // exact group name (Shield Maiden/Roach/...)
      if (n.startsWith(gN)) {
        if (!sourceEqualsGroup) return true; // family group: Crone/Vampire/Arachas Behemoth...
        // Even when the played card's name equals the group (Arachas, Gaunter), include
        // targets that belong to a *different* muster group and share the prefix.
        const tg = ownGroupOf(c);
        if (tg && tg !== gN) return true;
      }
      return false;
    };

    const pl = st.players[task.player];
    const cardsToSummon = [];
    if (task.from.includes('hand')) {
      pl.hand = pl.hand.filter((inst) => {
        if (matches(inst)) {
          cardsToSummon.push(inst);
          return false;
        }
        return true;
      });
    }
    const fromDeck = [];
    pl.deck = pl.deck.filter((inst) => {
      if (matches(inst)) {
        fromDeck.push(inst);
        return false;
      }
      return true;
    });
    const summoned = [...fromDeck, ...cardsToSummon];
    if (!summoned.length) return;
    this._emit('muster', { player: task.player, sourceUid: task.uid, group, uids: summoned.map((s) => s.uid) });
    for (const inst of summoned) {
      const card = this.cardDb[inst.cardId];
      const row = this._bestRowFor(task.player, inst.cardId) ?? (card.rows?.[0] || 'close');
      inst.row = row;
      inst.boardOwner = task.player;
      pl.rows[row].push(inst);
      this._emit('cardSummoned', { player: task.player, uid: inst.uid, cardId: inst.cardId, row });
      this.state.stack.push({ kind: 'enter', owner: task.player, uid: inst.uid, row, boardOwner: task.player });
    }
    this._log(`P${task.player} 集结：召唤了 ${summoned.length} 张牌`);
  }

  _medicStart(task) {
    const options = this._graveUnits(task.player).filter((c) => this._canBeRevived(c.cardId));
    if (!options.length) return;
    if (this.state.passives.randomRevive) {
      const chosen = pickRandom(this.state, options);
      this._reviveUnit(task.player, chosen.uid);
      return;
    }
    this.state.pending = {
      kind: 'medic',
      player: task.player,
      sourceUid: task.uid,
      sourceCardId: task.cardId,
      options: options.map((c) => ({ uid: c.uid, cardId: c.cardId })),
    };
  }

  _resolveMedic(pending, choice) {
    if (!choice || choice.skip) {
      this._log(`P${pending.player} 放弃医师复活`);
      return;
    }
    const uid = choice.uid ?? pending.options.find((o) => o.cardId === choice.cardId)?.uid;
    if (!uid || !pending.options.some((o) => o.uid === uid)) throw new Error('无效的复活目标');
    this._reviveUnit(pending.player, uid);
  }

  _reviveUnit(player, uid) {
    const st = this.state;
    const pl = st.players[player];
    const inst = pl.graveyard.find((c) => c.uid === uid);
    if (!inst) return;
    pl.graveyard = pl.graveyard.filter((c) => c.uid !== uid);
    const card = this.cardDb[inst.cardId];
    const rows = card.rows ?? [];
    if (rows.length > 1) {
      this.state.pending = {
        kind: 'reviveRow',
        player,
        uid,
        cardId: inst.cardId,
        inst,
        options: rows.slice(),
      };
      this._emit('revivePending', { player, uid: inst.uid, cardId: inst.cardId });
      return;
    }
    this._placeRevived(player, inst, rows[0] ?? 'close');
  }

  _resolveReviveRow(pending, choice) {
    const inst = pending.inst || this.state.players[pending.player].graveyard.find((c) => c.uid === pending.uid);
    const row = pending.options.includes(choice?.row) ? choice.row : pending.options[0];
    if (!inst) return;
    this.state.players[pending.player].graveyard = this.state.players[pending.player].graveyard.filter(
      (c) => c.uid !== pending.uid,
    );
    this._placeRevived(pending.player, inst, row);
  }

  _placeRevived(player, inst, row) {
    const st = this.state;
    inst.row = row;
    inst.boardOwner = player;
    st.players[player].rows[row].push(inst);
    this._emit('medic', { player, uid: inst.uid, cardId: inst.cardId, row });
    this._log(`P${player} 医师复活了「${this.cardDb[inst.cardId]?.nameZh || inst.cardId}」`);
    this.state.stack.push({ kind: 'enter', owner: player, uid: inst.uid, row, boardOwner: player });
  }

  _resolveScorchTask(task) {
    const st = this.state;
    if (task.mode === 'any') {
      const targets = strongestOnBoard(st, this.cardDb);
      if (!targets.length) return;
      this._emit('scorch', { player: task.player, kind: 'any', uids: targets.map((t) => t.inst.uid) });
      for (const t of targets) this._removeFromBoard(t.inst, { toGrave: true });
      this._log(`灼烧：摧毁了 ${targets.length} 张最强单位`);
    } else {
      const enemy = 1 - task.player;
      const require = task.require ?? 10;
      if (rowTotal(st, enemy, task.row, this.cardDb) < require) {
        this._emit('scorchFizzle', { player: task.player, row: task.row });
        return;
      }
      const targets = strongestInRow(st, enemy, task.row, this.cardDb);
      if (!targets.length) return;
      this._emit('scorch', { player: task.player, kind: 'row', row: task.row, uids: targets.map((t) => t.inst.uid) });
      for (const t of targets) this._removeFromBoard(t.inst, { toGrave: true });
      this._log(`灼烧：摧毁了敌方${ROW_ZH[task.row] || task.row} ${targets.length} 张最强单位`);
    }
  }

  _transformBerserkers(player, row) {
    const st = this.state;
    const insts = [...st.players[player].rows[row]];
    for (const inst of insts) {
      this._transformBerserker(player, row, inst.uid);
    }
  }

  _transformBerserker(player, row, uid) {
    const st = this.state;
    const rowInsts = st.players[player].rows[row];
    const idx = rowInsts.findIndex((c) => c.uid === uid);
    if (idx < 0) return;
    const inst = rowInsts[idx];
    const card = this.cardDb[inst.cardId];
    if (!card) return;
    const ab = getAbility(card, 'berserker');
    if (!ab) return;
    const targetId = ab.transformTo;
    const targetCard = this.cardDb[targetId];
    if (!targetCard) return;
    const newInst = this._makeInst(st, targetId, player, { isToken: true });
    newInst.row = row;
    newInst.boardOwner = player;
    rowInsts[idx] = newInst;
    this._emit('transform', {
      player, row, fromUid: inst.uid, fromCardId: inst.cardId,
      uid: newInst.uid, cardId: targetId,
    });
    this._log(`狂战士在${ROW_ZH[row] || row}变身为「${targetCard.nameZh || targetCard.nameEn}」`);
    this._recompute(true);
  }

  _spawnAvenger(task) {
    const st = this.state;
    const owner = st.players[task.player];
    const card = this.cardDb[task.tokenCardId];
    if (!card) return;
    const row = card.rows?.[0] ?? 'close';
    const inst = this._makeInst(st, task.tokenCardId, task.player, { isToken: true });
    inst.row = row;
    inst.boardOwner = task.player;
    st.players[task.player].rows[row].push(inst);
    this._emit('avenger', {
      player: task.player, row, fromUid: task.fromUid, fromCardId: task.fromCardId,
      uid: inst.uid, cardId: task.tokenCardId,
    });
    this._log(`复仇者：召唤了「${card.nameZh || card.nameEn}」`);
    this._recompute(true);
  }

  _leaderAbility(task) {
    const st = this.state;
    const player = task.player;
    const ability = task.ability;
    const id = typeof ability === 'string' ? ability : ability.id;
    switch (id) {
      case 'clearWeather':
        this.state.stack.push({ kind: 'clearWeather' });
        break;
      case 'playWeatherFromDeck': {
        const weatherKind = ability.weather;
        if (weatherKind === 'any') {
          const opts = [];
          for (const inst of st.players[player].deck) {
            const w = getAbility(this.cardDb[inst.cardId], 'weather');
            if (w) opts.push({ uid: inst.uid, cardId: inst.cardId, weather: w.weather });
          }
          if (!opts.length) {
            this._emit('toast', { text: '牌堆中没有天气牌' });
            break;
          }
          this.state.pending = { kind: 'chooseWeather', player, options: opts };
        } else {
          const found = st.players[player].deck.find((inst) => {
            const w = getAbility(this.cardDb[inst.cardId], 'weather');
            return w && w.weather === weatherKind;
          });
          if (!found) {
            this._emit('toast', { text: '牌堆中没有对应的天气牌' });
            break;
          }
          this.state.stack.push({
            kind: 'playWeatherCard', player, uid: found.uid, weather: weatherKind, fromDeck: true,
          });
        }
        break;
      }
      case 'leaderHorn': {
        const row = ability.row;
        if (!ROW_KEYS.includes(row)) break;
        if (st.players[player].rowSpecials[row]) {
          this._emit('toast', { text: '该行已有号角或曼陀罗效果' });
          break;
        }
        st.players[player].rowSpecials[row] = { kind: 'horn', uid: 'leader-horn-' + player, cardId: null, leader: true };
        this._emit('hornPlaced', { player, row, leader: true });
        this._log(`P${player} 领袖能力：${ROW_ZH[row] || row}号角`);
        break;
      }
      case 'scorchRow': {
        this.state.stack.push({
          kind: 'scorch', player, mode: 'row', row: ability.row,
          require: ability.requireEnemyRowTotalAtLeast ?? 10,
        });
        break;
      }
      case 'viewOpponentHand': {
        const opp = st.players[1 - player];
        const cards = pickRandomMany(st, opp.hand, Math.min(ability.count ?? 3, opp.hand.length));
        this.state.pending = {
          kind: 'viewHand', player,
          cards: cards.map((c) => ({ uid: c.uid, cardId: c.cardId })),
        };
        break;
      }
      case 'takeGraveyardUnitToHand': {
        const from = ability.from === 'opponent' ? 1 - player : player;
        const options = st.players[from].graveyard
          .filter((inst) => !this._isToken(inst))
          .map((inst) => ({ uid: inst.uid, cardId: inst.cardId }));
        if (!options.length) {
          this._emit('toast', { text: '弃牌堆中没有可取的牌' });
          break;
        }
        this.state.pending = { kind: 'takeGraveUnit', player, from, options };
        break;
      }
      case 'discardDraw': {
        const options = st.players[player].hand.map((c) => ({ uid: c.uid, cardId: c.cardId }));
        if (options.length < (ability.discard ?? 2)) {
          this._emit('toast', { text: '手牌不足，无法弃牌' });
          break;
        }
        this.state.pending = { kind: 'discardCards', player, count: ability.discard ?? 2, options };
        break;
      }
      case 'repositionAgile':
        this.state.stack.push({ kind: 'repositionAgile', player });
        break;
      case 'shuffleGraveyards':
        this.state.stack.push({ kind: 'shuffleGraveyards' });
        break;
      case 'cancelLeader':
        this._emit('toast', { text: '该能力在开局时已生效' });
        break;
      default:
        console.warn('[engine] unhandled leader ability', id);
    }
  }

  _resolveChooseWeather(pending, choice) {
    const st = this.state;
    const opt = pending.options.find((o) => o.uid === choice?.uid || o.weather === choice?.weather);
    if (!opt) return;
    st.stack.push({ kind: 'playWeatherCard', player: pending.player, uid: opt.uid, weather: opt.weather, fromDeck: true });
  }

  _resolveTakeGraveUnit(pending, choice) {
    const uid = choice?.uid;
    if (!uid) return;
    this.state.stack.push({ kind: 'takeGraveToHand', player: pending.player, from: pending.from, uid });
  }

  _resolveDiscardCards(pending, choice) {
    const st = this.state;
    const uids = [...new Set(choice?.cards ?? [])];
    if (uids.length !== pending.count) throw new Error(`必须弃 ${pending.count} 张牌`);
    if (!uids.every((uid) => pending.options.some((o) => o.uid === uid))) throw new Error('无效的弃牌选择');
    this.state.stack.push({ kind: 'discardResolve', player: pending.player, uids });
  }

  _discardCardsNow(task) {
    const st = this.state;
    const pl = st.players[task.player];
    const cards = pl.hand.filter((c) => task.uids.includes(c.uid));
    pl.hand = pl.hand.filter((c) => !task.uids.includes(c.uid));
    for (const inst of cards) pl.graveyard.push(inst);
    this._emit('discarded', { player: task.player, uids: task.uids, cardIds: cards.map((c) => c.cardId) });
    const deckOptions = pl.deck.map((c) => ({ uid: c.uid, cardId: c.cardId }));
    if (!deckOptions.length) {
      this._emit('toast', { text: '牌堆为空，无法抽牌' });
      return;
    }
    this.state.pending = { kind: 'deckChoice', player: task.player, options: deckOptions };
  }

  _resolveDeckChoice(pending, choice) {
    const uid = choice?.uid;
    if (!uid) return;
    this.state.stack.push({ kind: 'deckToHand', player: pending.player, uid });
  }

  _moveDeckToHand(player, uid) {
    const pl = this.state.players[player];
    const inst = pl.deck.find((c) => c.uid === uid);
    if (!inst) return;
    pl.deck = pl.deck.filter((c) => c.uid !== uid);
    pl.hand.push(inst);
    this._emit('draw', { player, count: 1, cardIds: [inst.cardId], fromDeckChoice: true });
    this._log(`P${player} 从牌堆选择了「${this.cardDb[inst.cardId]?.nameZh || inst.cardId}」`);
  }

  _moveGraveToHand(player, from, uid) {
    const src = this.state.players[from];
    const inst = src.graveyard.find((c) => c.uid === uid);
    if (!inst) return;
    src.graveyard = src.graveyard.filter((c) => c.uid !== uid);
    this.state.players[player].hand.push(inst);
    this._emit('graveToHand', { player, from, uid, cardId: inst.cardId });
    this._log(`P${player} 从 P${from} 的弃牌堆取回「${this.cardDb[inst.cardId]?.nameZh || inst.cardId}」`);
  }

  _shuffleGraveyards() {
    const st = this.state;
    for (const p of st.players) {
      if (!p.graveyard.length) continue;
      p.deck.push(...p.graveyard);
      p.graveyard = [];
      p.deck = shuffle(st, p.deck);
    }
    this._emit('graveyardsShuffled', {});
    this._log('双方弃牌堆洗回牌堆');
  }

  _repositionAgile(player) {
    const st = this.state;
    const pl = st.players[player];
    const agile = [];
    for (const row of ['close', 'ranged']) {
      for (const inst of pl.rows[row]) {
        const card = this.cardDb[inst.cardId];
        if (card && hasAbility(card, 'agile') && !hasAbility(card, 'spy')) agile.push({ inst, row });
      }
    }
    if (!agile.length) {
      this._emit('toast', { text: '没有可移动的灵巧单位' });
      return;
    }
    if (agile.length > 8) {
      // Greedy fallback for pathological boards.
      for (const a of agile) {
        const other = a.row === 'close' ? 'ranged' : 'close';
        const before = computeAllRows(st, player, this.cardDb).score;
        pl.rows[a.row] = pl.rows[a.row].filter((i) => i.uid !== a.inst.uid);
        a.inst.row = other;
        pl.rows[other].push(a.inst);
        const after = computeAllRows(st, player, this.cardDb).score;
        if (after < before) {
          pl.rows[other] = pl.rows[other].filter((i) => i.uid !== a.inst.uid);
          a.inst.row = a.row;
          pl.rows[a.row].push(a.inst);
        }
      }
      this._emit('agileRepositioned', { player });
      this._recompute(true);
      return;
    }
    const agileUids = new Set(agile.map((a) => a.inst.uid));
    const baseClose = pl.rows.close.filter((i) => !agileUids.has(i.uid));
    const baseRanged = pl.rows.ranged.filter((i) => !agileUids.has(i.uid));
    const originalRows = { close: pl.rows.close.slice(), ranged: pl.rows.ranged.slice() };
    let best = { score: -Infinity, mask: 0 };
    for (let mask = 0; mask < (1 << agile.length); mask++) {
      pl.rows.close = baseClose.concat(agile.filter((_, i) => !((mask >> i) & 1)).map((a) => a.inst));
      pl.rows.ranged = baseRanged.concat(agile.filter((_, i) => (mask >> i) & 1).map((a) => a.inst));
      const total = computeAllRows(st, player, this.cardDb).score;
      if (total > best.score) best = { score: total, mask };
    }
    pl.rows.close = originalRows.close;
    pl.rows.ranged = originalRows.ranged;
    agile.forEach((a, i) => {
      const target = (best.mask >> i) & 1 ? 'ranged' : 'close';
      if (target === a.row) return;
      pl.rows[a.row] = pl.rows[a.row].filter((inst) => inst.uid !== a.inst.uid);
      a.inst.row = target;
      pl.rows[target].push(a.inst);
    });
    this._emit('agileRepositioned', { player });
    this._log(`P${player} 的灵巧单位移动到最优行`);
    this._recompute(true);
  }

  // ────────────────────────────────────────────────────────────────
  // Card movement / helpers
  // ────────────────────────────────────────────────────────────────

  _makeInst(st, cardId, owner, opts = {}) {
    return {
      uid: `${cardId}-${owner}-${++st.uidSeq}`,
      cardId,
      owner,
      isToken: !!opts.isToken,
      row: null,
    };
  }

  _draw(player, n, opts = {}) {
    const st = this.state;
    const pl = st.players[player];
    const drawn = [];
    for (let i = 0; i < n; i++) {
      const inst = pl.deck.shift();
      if (!inst) break;
      pl.hand.push(inst);
      drawn.push(inst);
    }
    if (drawn.length) {
      this._emit('draw', { player, count: drawn.length, cardIds: drawn.map((c) => c.cardId), reason: opts.reason });
    } else if (!opts.silent) {
      this._emit('toast', { text: '牌堆已空，无法抽牌' });
    }
  }

  _removeHand(player, inst) {
    this.state.players[player].hand = this.state.players[player].hand.filter((c) => c.uid !== inst.uid);
  }

  _toGrave(player, inst) {
    this.state.players[player].graveyard.push(inst);
  }

  /**
   * Remove a unit/decoy from the battlefield.
   * Triggers avenger for real cards. Returns the removed instance.
   */
  _removeFromBoard(inst, opts = {}) {
    const st = this.state;
    const boardOwner = inst.boardOwner ?? inst.owner;
    const rows = st.players[boardOwner]?.rows ?? st.players[inst.owner].rows;
    const rowName = inst.row;
    const row = rows[rowName];
    if (row) {
      const idx = row.findIndex((c) => c.uid === inst.uid);
      if (idx >= 0) row.splice(idx, 1);
    }
    const card = this.cardDb[inst.cardId];
    if (card && hasAbility(card, 'avenger') && !inst.isToken) {
      const av = getAbility(card, 'avenger');
      if (av?.token) {
        this.state.stack.push({
          kind: 'avenger',
          player: inst.owner,
          fromUid: inst.uid,
          fromCardId: inst.cardId,
          tokenCardId: av.token,
        });
      }
    }
    if (opts.toHand != null) {
      // returned to hand by decoy; caller pushes it
    } else if (opts.toGrave !== false) {
      st.players[inst.owner].graveyard.push(inst);
    }
    if (!opts.silent) this._emit('cardLeft', { uid: inst.uid, cardId: inst.cardId, row: rowName });
    return inst;
  }

  _findUnitByUid(uid) {
    for (const p of this.state.players) {
      for (const row of ROW_KEYS) {
        const inst = p.rows[row].find((c) => c.uid === uid);
        if (inst) return { inst, row, owner: p.index };
      }
    }
    const decoy = this._findDecoy(uid);
    return decoy;
  }

  _findDecoy(uid) {
    for (const p of this.state.players) {
      for (const row of ROW_KEYS) {
        const inst = p.rows[row].find((c) => c.uid === uid && c.kind === 'decoy');
        if (inst) return { inst, row, owner: p.index };
      }
    }
    return null;
  }

  _findByIdentity(uid) {
    for (const p of this.state.players) {
      for (const zone of ['hand', 'deck', 'graveyard']) {
        const found = p[zone].find((c) => c.uid === uid);
        if (found) return found;
      }
      for (const row of ROW_KEYS) {
        const found = p.rows[row].find((c) => c.uid === uid);
        if (found) return found;
      }
    }
    const w = this.state.weatherCards.find((c) => c.uid === uid);
    return w ?? null;
  }

  _graveUnits(player) {
    return this.state.players[player].graveyard.filter((inst) => {
      const card = this.cardDb[inst.cardId];
      return card?.type === 'unit' && !this._isToken(inst) && !hasAbility(card, 'avenger');
    });
  }

  _isToken(inst) {
    return !!inst.isToken || this.cardDb[inst.cardId]?.deckable === false;
  }

  _canBeRevived(cardId) {
    const card = this.cardDb[cardId];
    if (!card || card.type !== 'unit') return false;
    if (card.hero) return false;
    if (card.deckable === false) return false;
    if (hasAbility(card, 'avenger')) return false;
    return true;
  }

  _bestRowFor(player, cardId) {
    const card = this.cardDb[cardId];
    const rows = card?.rows ?? [];
    if (rows.length <= 1) return rows[0] ?? null;
    let bestRow = rows[0];
    let best = -Infinity;
    for (const row of rows) {
      const inst = { uid: 'probe', cardId, owner: player, isToken: true, row };
      const pl = this.state.players[player];
      const before = computeAllRows(this.state, player, this.cardDb).score;
      pl.rows[row].push(inst);
      const after = computeAllRows(this.state, player, this.cardDb).score;
      pl.rows[row].pop();
      if (after > best) {
        best = after;
        bestRow = row;
      }
    }
    return bestRow;
  }

  _rowHasHorn(player, row) {
    if (this.state.players[player].rowSpecials[row]) return true;
    return this.state.players[player].rows[row].some((inst) => {
      const card = this.cardDb[inst.cardId];
      return card && card.type === 'unit' && hasAbility(card, 'horn');
    });
  }

  _rowHasMardroeme(player, row) {
    const special = this.state.players[player].rowSpecials[row];
    if (special?.kind === 'mardroeme') return true;
    return this.state.players[player].rows[row].some((inst) => {
      const card = this.cardDb[inst.cardId];
      return card && hasAbility(card, 'mardroeme');
    });
  }

  _playWeatherCard(player, inst, weatherKind, opts = {}) {
    const st = this.state;
    if (!inst) return;
    if (weatherKind === 'clear') {
      this._toGrave(player, inst);
      this.state.stack.push({ kind: 'clearWeather' });
      return;
    }
    if (st.weather[weatherKind]) {
      // Duplicate weather: wasted, goes to graveyard.
      this._toGrave(player, inst);
      this._emit('toast', { text: '该天气已经生效' });
      return;
    }
    st.weather[weatherKind] = true;
    st.weatherCards.push(inst);
    this._emit('weatherChanged', { weather: { ...st.weather }, kind: weatherKind, player });
    this._log(`天气：${WEATHER_ZH[weatherKind] || weatherKind} 生效`);
  }

  _clearWeather() {
    const st = this.state;
    const active = Object.entries(st.weather).filter(([, v]) => v).map(([k]) => k);
    if (!active.length) {
      this._emit('toast', { text: '当前没有天气效果' });
      return;
    }
    for (const inst of st.weatherCards) st.players[inst.owner].graveyard.push(inst);
    st.weatherCards = [];
    st.weather = { frost: false, fog: false, rain: false, storm: false };
    this._emit('weatherChanged', { weather: { ...st.weather }, cleared: true });
    this._log('天气被清除');
  }

  _skelligeRevive(player) {
    const st = this.state;
    const pl = st.players[player];
    const candidates = pl.graveyard.filter((inst) => {
      const card = this.cardDb[inst.cardId];
      return card?.type === 'unit' && !card.hero && !this._isToken(inst) && !hasAbility(card, 'avenger');
    });
    const chosen = pickRandomMany(st, candidates, 2);
    if (!chosen.length) {
      this._emit('skelligeRevive', { player, uids: [] });
      return;
    }
    this._emit('skelligeRevive', { player, uids: chosen.map((c) => c.uid) });
    this._log(`史凯利格能力：P${player} 从墓地复活 ${chosen.length} 张单位`);
    for (const inst of chosen) {
      pl.graveyard = pl.graveyard.filter((c) => c.uid !== inst.uid);
      const row = this._bestRowFor(player, inst.cardId) ?? (this.cardDb[inst.cardId]?.rows?.[0] || 'close');
      inst.row = row;
      inst.boardOwner = player;
      pl.rows[row].push(inst);
      this._emit('medic', { player, uid: inst.uid, cardId: inst.cardId, row, skellige: true });
      this.state.stack.push({ kind: 'enter', owner: player, uid: inst.uid, row, boardOwner: player });
    }
  }

  _recompute(force = false) {
    const st = this.state;
    const computed = computeScores(st, this.cardDb);
    const scores = computed.map((c) => ({ score: c.score, rows: { close: c.rows.close.total, ranged: c.rows.ranged.total, siege: c.rows.siege.total } }));
    const prev = st.scores;
    if (force || !prev || JSON.stringify(prev) !== JSON.stringify(scores)) {
      st.scores = scores;
      this._emit('powerUpdate', { scores });
    }
    st.version++;
  }

  _scoresArray() {
    const computed = computeScores(this.state, this.cardDb);
    return computed.map((c) => c.score);
  }

  _emit(type, payload = {}) {
    this.state.events.push({ type, ...payload });
  }

  _log(text) {
    this.state.log.push(text);
    if (this.state.log.length > 200) this.state.log.splice(0, this.state.log.length - 200);
    this.state.events.push({ type: 'log', text });
  }

  // ────────────────────────────────────────────────────────────────
  // View
  // ────────────────────────────────────────────────────────────────

  _buildView(pov) {
    const st = this.state;
    const computed = computeScores(st, this.cardDb);
    const players = st.players.map((p, i) => {
      const rows = {};
      for (const row of ROW_KEYS) {
        rows[row] = computed[i].rows[row].cards.map((c) => ({
          uid: c.inst.uid,
          cardId: c.inst.cardId,
          owner: c.inst.owner,
          boardOwner: i,
          row,
          power: c.power,
          basePower: c.breakdown.base,
          hero: !!c.card.hero,
          isToken: !!c.inst.isToken,
          kind: c.inst.kind ?? 'unit',
          breakdown: { ...c.breakdown },
        }));
      }
      const rowSpecials = {};
      for (const row of ROW_KEYS) {
        const special = p.rowSpecials[row];
        rowSpecials[row] = special ? { kind: special.kind, uid: special.uid, cardId: special.cardId, leader: !!special.leader } : null;
      }
      const hand = i === pov
        ? p.hand.map((inst) => ({ uid: inst.uid, cardId: inst.cardId, playable: true }))
        : null;
      return {
        index: i,
        id: p.id,
        isAI: i !== pov,
        faction: p.faction,
        leaderId: p.leaderId,
        leaderUsed: p.leaderUsed,
        leaderCanceled: p.leaderCanceled,
        leaderAvailable: this._leaderActionInfo(i).available,
        passives: p.passives.slice(),
        gems: st.gems[i],
        score: computed[i].score,
        rows,
        rowScores: {
          close: computed[i].rows.close.total,
          ranged: computed[i].rows.ranged.total,
          siege: computed[i].rows.siege.total,
        },
        rowSpecials,
        hand,
        handCount: p.hand.length,
        deckCount: p.deck.length,
        graveyard: p.graveyard.map((inst) => ({
          uid: inst.uid,
          cardId: inst.cardId,
          owner: inst.owner,
          isToken: !!inst.isToken,
        })),
        passed: p.passed,
        pendingDraws: p.pendingDraws,
      };
    });

    return {
      phase: st.phase,
      stage: st.stage,
      round: st.round,
      turn: st.turn,
      firstPlayer: st.firstPlayer,
      passed: st.passed.slice(),
      gems: st.gems.slice(),
      weather: { ...st.weather },
      weatherCards: st.weatherCards.map((inst) => ({ uid: inst.uid, cardId: inst.cardId, owner: inst.owner })),
      players,
      pending: st.pending ? JSON.parse(JSON.stringify(st.pending)) : null,
      result: st.result ? JSON.parse(JSON.stringify(st.result)) : null,
      log: st.log.slice(-60),
      roundHistory: st.roundHistory.map((h) => ({ ...h })),
      scores: computed.map((c) => c.score),
      version: st.version,
      actions: [],
    };
  }
}

export function createGame(config) {
  return new GwentEngine(config);
}
