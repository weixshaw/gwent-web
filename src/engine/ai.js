/**
 * ai.js — 《巫师3》昆特牌 AI 对手（三档难度）
 *
 * 契约（docs/ARCHITECTURE.md §5 / 任务书）：
 *   const ai = createAI({ cards, leaders, playerIndex, difficulty, seed });
 *   ai.chooseAction(view, engine)        // view = engine.viewFor(playerIndex)
 *   ai.choosePending(pending, view, engine)
 *   ai.chooseMulligan(view, engine)
 *
 * 设计要点：
 *  - 严禁作弊：只读取 view（对手 hand 恒为 null）与 pending 暴露的选项；
 *    engine 仅用于 getActions() / clone()（推演），不会读取 engine.state。
 *  - easy：随机 + 粗权重；normal：启发式估值；hard：关键选择上对 clone 做 1-ply 推演。
 *  - 单次决策尽量快（normal < 20ms，hard < 60ms）；任何异常回退到合法安全动作。
 *
 * 策略覆盖：间谍抽牌价值、紧缚/士气/号角/天气收益、医师复活（间谍/医师连锁）、
 * Decoy 回收、Scorch 与单行灼烧、Berserker/Mardroeme 变身、复仇者 Cow/Kambi、
 * 灵巧选行、领袖时机、Mulligan、Pass/小局资源管理。
 */

import { hashSeed } from './rng.js';

const ROWS = ['close', 'ranged', 'siege'];
const WEATHER_KINDS = ['frost', 'fog', 'rain', 'storm'];
const WEATHER_ROWS = {
  frost: ['close'],
  fog: ['ranged'],
  rain: ['siege'],
  storm: ['ranged', 'siege'],
  clear: [],
};

const CARD_VALUE = 6.4; // 一张普通手牌大致能转化的战力
const OPP_CARD_VALUE = 5.3; // 对手手牌的估值（略低，避免高估对手）
const W_HAND = 0.8; // 手牌资源在局面估值里的权重
const ROUND_WIN_BONUS = 14;
const GEM_VALUE = 22;
const PASS_LEAD = 12;
const MULLIGAN_LIMIT = 2;
const BUDGET_MS = { easy: 30, normal: 18, hard: 55 };

function normalizeName(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ==================================================================== */
/* 工厂                                                                 */
/* ==================================================================== */

/**
 * @param {{cards?:Object, leaders?:Object, playerIndex?:0|1, difficulty?:'easy'|'normal'|'hard', seed?:number}} config
 */
export function createAI(config = {}) {
  const cards = config.cards || {};
  const leaders = config.leaders || {};
  const difficulty = ['easy', 'normal', 'hard'].includes(config.difficulty)
    ? config.difficulty
    : 'normal';
  const P = config.playerIndex === 0 ? 0 : 1;
  const O = 1 - P;
  const rng = mulberry32(hashSeed(`gwent-ai:${config.seed == null ? 1 : config.seed}:${P}:${difficulty}`));

  /* ------------------------------------------------------------------ */
  /* 基础能力查询                                                       */
  /* ------------------------------------------------------------------ */

  const allCards = Object.values(cards);
  const byId = cards;
  let simSeq = 0;

  function cardOf(cardId) {
    return (cardId && byId[cardId]) || null;
  }

  function abilityList(card) {
    const list = card && card.abilities;
    if (!Array.isArray(list)) return [];
    return list.map((a) => (typeof a === 'string' ? { id: a } : a)).filter(Boolean);
  }

  function getAb(card, id) {
    if (!card) return null;
    const list = card.abilities;
    if (!Array.isArray(list)) return null;
    for (const a of list) {
      if (typeof a === 'string') {
        if (a === id) return { id: a };
      } else if (a && a.id === id) {
        return a;
      }
    }
    return null;
  }

  function hasAb(card, id) {
    return !!getAb(card, id);
  }

  function leaderAbilityList(leaderId) {
    const leader = leaders[leaderId];
    if (!leader) return [];
    let list = leader.ability != null ? leader.ability : leader.abilities;
    if (!Array.isArray(list)) list = list == null ? [] : [list];
    return list.map((a) => (typeof a === 'string' ? { id: a } : a)).filter(Boolean);
  }

  function leaderHasAbility(leaderId, id) {
    return leaderAbilityList(leaderId).some((a) => a.id === id);
  }

  /* Muster 组员表（镜像引擎匹配规则） */
  const musterInfo = new Map();
  for (const source of allCards) {
    const ab = getAb(source, 'muster');
    if (!ab || source.type !== 'unit') continue;
    const group = ab.group || source.nameEn;
    const from = Array.isArray(ab.from) && ab.from.length ? ab.from.slice() : ['deck'];
    const srcN = normalizeName(source.nameEn);
    const gN = normalizeName(group);
    const sourceEqualsGroup = srcN === gN;
    const ownGroup = (c) => {
      const sub = getAb(c, 'muster');
      return normalizeName(sub && sub.group ? sub.group : c.nameEn);
    };
    const members = [];
    for (const c of allCards) {
      if (!c || c.type !== 'unit') continue;
      const n = normalizeName(c.nameEn);
      let ok = false;
      if (c.id === source.id) ok = true;
      else if (n === srcN) ok = true;
      else if (n === gN) ok = true;
      else if (gN && n.startsWith(gN)) {
        if (!sourceEqualsGroup) ok = true;
        else {
          const tg = ownGroup(c);
          if (tg && tg !== gN) ok = true;
        }
      }
      if (ok) members.push(c);
    }
    musterInfo.set(source.id, { group, from, members });
  }

  /* ------------------------------------------------------------------ */
  /* view 辅助                                                          */
  /* ------------------------------------------------------------------ */

  function meOf(view) {
    return (view && view.players && view.players[P]) || null;
  }
  function oppOf(view) {
    return (view && view.players && view.players[O]) || null;
  }
  function myHand(view) {
    const me = meOf(view);
    return (me && Array.isArray(me.hand) && me.hand) || [];
  }
  function handInst(view, uid) {
    return myHand(view).find((h) => h.uid === uid) || null;
  }
  function cardFromAction(view, action) {
    if (!action || action.type !== 'playCard') return null;
    const inst = handInst(view, action.uid);
    return inst ? cardOf(inst.cardId) : null;
  }
  function countInHand(view, cardId) {
    return myHand(view).filter((h) => h.cardId === cardId).length;
  }
  function countVisibleCopies(view, cardId) {
    let n = 0;
    for (const inst of myHand(view)) if (inst.cardId === cardId) n += 1;
    for (const idx of [0, 1]) {
      const pl = view.players[idx];
      if (!pl) continue;
      for (const row of ROWS) {
        for (const u of pl.rows[row] || []) if (u.cardId === cardId) n += 1;
      }
      for (const g of pl.graveyard || []) if (g.cardId === cardId) n += 1;
    }
    for (const w of view.weatherCards || []) if (w.cardId === cardId) n += 1;
    return n;
  }
  function findViewBoardUnit(view, boardOwner, uid) {
    if (!uid) return null;
    const pl = view.players[boardOwner];
    if (!pl) return null;
    for (const row of ROWS) {
      for (const u of pl.rows[row] || []) {
        if (u.uid === uid) return { unit: u, row };
      }
    }
    return null;
  }

  function unitRec(u) {
    const card = cardOf(u.cardId);
    return {
      uid: u.uid,
      cardId: u.cardId,
      card,
      owner: u.owner,
      boardOwner: u.boardOwner,
      hero: !!(u.hero != null ? u.hero : card && card.hero),
      isToken: !!u.isToken,
      kind: u.kind || 'unit',
      powerNow: typeof u.power === 'number' ? u.power : 0,
      basePower: typeof u.basePower === 'number' ? u.basePower : (card ? card.strength || 0 : 0),
    };
  }

  function buildCtx(view) {
    const rows = [0, 1].map((idx) => {
      const pl = view.players[idx] || {};
      const r = pl.rows || {};
      return {
        close: (r.close || []).map(unitRec),
        ranged: (r.ranged || []).map(unitRec),
        siege: (r.siege || []).map(unitRec),
      };
    });
    const rowSpecials = [0, 1].map((idx) => {
      const rs = (view.players[idx] && view.players[idx].rowSpecials) || {};
      return {
        close: rs.close || null,
        ranged: rs.ranged || null,
        siege: rs.siege || null,
      };
    });
    const halfWeather = [0, 1].map((idx) => {
      const pl = view.players[idx];
      if (!pl) return false;
      if ((pl.passives || []).includes('halfWeather')) return true;
      return leaderHasAbility(pl.leaderId, 'halfWeather');
    });
    const doubleSpy = leaderHasAbility(view.players[0] && view.players[0].leaderId, 'doubleSpy')
      || leaderHasAbility(view.players[1] && view.players[1].leaderId, 'doubleSpy');
    return {
      view,
      rows,
      rowSpecials,
      weather: Object.assign({ frost: false, fog: false, rain: false, storm: false }, view.weather || {}),
      halfWeather,
      doubleSpy,
    };
  }

  function cloneCtx(ctx) {
    return {
      view: ctx.view,
      rows: [
        { close: ctx.rows[0].close.slice(), ranged: ctx.rows[0].ranged.slice(), siege: ctx.rows[0].siege.slice() },
        { close: ctx.rows[1].close.slice(), ranged: ctx.rows[1].ranged.slice(), siege: ctx.rows[1].siege.slice() },
      ],
      rowSpecials: [Object.assign({}, ctx.rowSpecials[0]), Object.assign({}, ctx.rowSpecials[1])],
      weather: Object.assign({}, ctx.weather),
      halfWeather: ctx.halfWeather.slice(),
      doubleSpy: ctx.doubleSpy,
    };
  }

  function weatherActive(ctx, row) {
    for (const kind of WEATHER_KINDS) {
      if (ctx.weather[kind] && WEATHER_ROWS[kind].includes(row)) return true;
    }
    return false;
  }

  function rowHasMardroeme(ctx, owner, row) {
    const sp = ctx.rowSpecials[owner] && ctx.rowSpecials[owner][row];
    if (sp && sp.kind === 'mardroeme') return true;
    return (ctx.rows[owner][row] || []).some((rec) => rec.card && hasAb(rec.card, 'mardroeme'));
  }

  function rowHasHornUnit(ctx, owner, row) {
    return (ctx.rows[owner][row] || []).some((rec) => rec.card && hasAb(rec.card, 'horn'));
  }

  /** 计算一行的有效战力（与引擎 scoring.js 保持一致）。 */
  function rowSim(ctx, owner, row) {
    const units = ctx.rows[owner][row] || [];
    const special = ctx.rowSpecials[owner] ? ctx.rowSpecials[owner][row] : null;
    const weather = weatherActive(ctx, row);
    const half = !!ctx.halfWeather[owner];
    let hornSources = special && special.kind === 'horn' ? 1 : 0;
    let mardroeme = special && special.kind === 'mardroeme';
    let moraleCount = 0;
    const bondCounts = new Map();
    for (const rec of units) {
      const card = rec.card;
      if (!card || card.type !== 'unit') continue;
      if (hasAb(card, 'horn')) hornSources += 1;
      if (hasAb(card, 'mardroeme')) mardroeme = true;
      if (hasAb(card, 'morale')) moraleCount += 1;
      if (hasAb(card, 'bond')) bondCounts.set(rec.cardId, (bondCounts.get(rec.cardId) || 0) + 1);
    }
    const hornActive = hornSources > 0;
    const entries = [];
    let total = 0;
    for (const rec of units) {
      const card = rec.card;
      if (!card || card.type !== 'unit') continue;
      const base = card.strength || 0;
      let power = base;
      if (!card.hero) {
        if (weather) {
          const min = half ? Math.ceil(base / 2) : 1;
          power = Math.min(min, base);
        }
        if (ctx.doubleSpy && hasAb(card, 'spy')) power *= 2;
        if (hasAb(card, 'bond')) {
          const n = bondCounts.get(rec.cardId) || 1;
          if (n > 1) power *= n;
        }
        const morale = Math.max(0, moraleCount - (hasAb(card, 'morale') ? 1 : 0));
        if (morale > 0) power += morale;
        if (hornActive && (!hasAb(card, 'horn') || hornSources > 1)) power *= 2;
      }
      total += power;
      entries.push({ rec, card, power, row });
    }
    return { total, entries, mardroeme, weather, hornActive };
  }

  function scoreOf(ctx, owner) {
    let total = 0;
    for (const row of ROWS) total += rowSim(ctx, owner, row).total;
    return total;
  }

  function leadOf(ctx) {
    return scoreOf(ctx, P) - scoreOf(ctx, O);
  }

  function addUnitRec(ctx, boardOwner, row, cardId, opts = {}) {
    const card = cardOf(cardId);
    if (!card) return null;
    const targetRow = ROWS.includes(row) ? row : (card.rows && card.rows[0]) || 'close';
    let finalCard = card;
    const bers = getAb(card, 'berserker');
    if (bers && rowHasMardroeme(ctx, boardOwner, targetRow)) {
      const transformed = cardOf(bers.transformTo);
      if (transformed) finalCard = transformed;
    }
    const rec = {
      uid: `sim-${++simSeq}`,
      cardId: finalCard.id,
      card: finalCard,
      owner: opts.owner == null ? boardOwner : opts.owner,
      boardOwner,
      row: targetRow,
      hero: !!finalCard.hero,
      isToken: true,
      kind: 'unit',
      powerNow: 0,
      basePower: finalCard.strength || 0,
    };
    ctx.rows[boardOwner][targetRow].push(rec);
    return rec;
  }

  function removeRecFromCtx(ctx, boardOwner, rec) {
    for (const row of ROWS) {
      const arr = ctx.rows[boardOwner][row];
      const idx = arr.findIndex((r) => r.uid === rec.uid);
      if (idx >= 0) {
        arr.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  function findRecInRows(ctx, boardOwner, uid) {
    if (!uid) return null;
    for (const row of ROWS) {
      const rec = (ctx.rows[boardOwner][row] || []).find((r) => r.uid === uid);
      if (rec) return { rec, row };
    }
    return null;
  }

  function transformBerserkersRow(ctx, owner, row) {
    const arr = ctx.rows[owner][row] || [];
    for (let i = 0; i < arr.length; i++) {
      const rec = arr[i];
      const bers = getAb(rec.card, 'berserker');
      if (!bers) continue;
      const transformed = cardOf(bers.transformTo);
      if (!transformed) continue;
      arr[i] = {
        uid: rec.uid,
        cardId: transformed.id,
        card: transformed,
        owner: rec.owner,
        boardOwner: owner,
        row,
        hero: !!transformed.hero,
        isToken: true,
        kind: 'unit',
        powerNow: 0,
        basePower: transformed.strength || 0,
      };
    }
  }

  function applyWeatherCtx(ctx, kind) {
    if (kind === 'clear') {
      ctx.weather = { frost: false, fog: false, rain: false, storm: false };
      return;
    }
    if (WEATHER_KINDS.includes(kind)) ctx.weather[kind] = true;
  }

  function strongestEntries(ctx, boardOwner, row) {
    const sim = rowSim(ctx, boardOwner, row);
    const nonHero = sim.entries.filter((e) => !e.card.hero);
    if (!nonHero.length) return [];
    const max = Math.max(...nonHero.map((e) => e.power));
    return nonHero.filter((e) => e.power === max);
  }

  function applyScorchRow(ctx, enemyOwner, row, require = 10) {
    const sim = rowSim(ctx, enemyOwner, row);
    if (sim.total < require) return [];
    const targets = strongestEntries(ctx, enemyOwner, row);
    for (const t of targets) removeRecFromCtx(ctx, enemyOwner, t.rec);
    return targets;
  }

  function applyScorchAny(ctx) {
    const all = [];
    for (const owner of [0, 1]) {
      for (const row of ROWS) {
        const sim = rowSim(ctx, owner, row);
        for (const e of sim.entries) {
          if (!e.card.hero) all.push({ owner, row, rec: e.rec, power: e.power });
        }
      }
    }
    if (!all.length) return [];
    const max = Math.max(...all.map((e) => e.power));
    const targets = all.filter((e) => e.power === max);
    for (const t of targets) removeRecFromCtx(ctx, t.owner, t.rec);
    return targets;
  }

  function bestRowForCard(ctx, owner, card) {
    const rows = card && card.rows && card.rows.length ? card.rows : ['close'];
    if (rows.length === 1) return rows[0];
    let bestRow = rows[0];
    let bestTotal = -Infinity;
    for (const row of rows) {
      const rec = addUnitRec(ctx, owner, row, card.id, { owner });
      const total = rowSim(ctx, owner, row).total;
      if (rec) removeRecFromCtx(ctx, owner, rec);
      if (total > bestTotal) {
        bestTotal = total;
        bestRow = row;
      }
    }
    return bestRow;
  }

  /* ------------------------------------------------------------------ */
  /* 静态估值                                                            */
  /* ------------------------------------------------------------------ */

  function maxBondCountOnBoard(ctx, cardId) {
    let best = 0;
    for (const row of ROWS) {
      const n = (ctx.rows[P][row] || []).filter((r) => r.cardId === cardId).length;
      if (n > best) best = n;
    }
    return best;
  }

  function tokenValue(card) {
    const av = getAb(card, 'avenger');
    if (!av || !av.token) return 0;
    const token = cardOf(av.token);
    return token ? token.strength || 0 : 0;
  }

  function memberValue(card) {
    if (!card) return 0;
    let v = card.strength || 0;
    if (hasAb(card, 'muster')) v += 1;
    if (hasAb(card, 'medic')) v += 2;
    if (hasAb(card, 'morale')) v += 0.5;
    if (hasAb(card, 'bond')) v += 0.5;
    return v;
  }

  function expectedMusterInfo(card, view) {
    const info = musterInfo.get(card.id);
    if (!info) return { value: 0, count: 0, entries: [] };
    const deckCount = (view.players[P] && view.players[P].deckCount) || 0;
    let budget = deckCount;
    const fromHand = info.from.includes('hand');
    const fromDeck = info.from.length === 0 || info.from.includes('deck');
    let value = 0;
    let count = 0;
    const entries = [];
    for (const member of info.members) {
      const copies = member.copies || 0;
      if (copies <= 0) continue;
      const isSource = member.id === card.id;
      let visibleAfter = countVisibleCopies(view, member.id);
      if (isSource) visibleAfter -= 1;
      let inHand = 0;
      if (fromHand) {
        inHand = Math.max(0, countInHand(view, member.id) - (isSource ? 1 : 0));
        visibleAfter -= inHand;
      }
      let n = inHand;
      if (fromDeck) {
        const remainingDeck = Math.max(0, copies - Math.max(0, visibleAfter));
        const take = Math.min(remainingDeck, budget);
        if (take > 0) {
          n += take;
          budget -= take;
        }
      }
      if (n > 0) {
        entries.push({ card: member, n });
        count += n;
        value += n * memberValue(member);
      }
    }
    return { value, count, entries };
  }

  function isRevivable(card) {
    return !!card && card.type === 'unit' && !card.hero && card.deckable !== false && !hasAb(card, 'avenger');
  }

  function reviveCandidateValue(view, ctx, card, uid, depth, excluded) {
    if (!card) return 0;
    let v = card.strength || 0;
    if (hasAb(card, 'spy')) v += 2 * CARD_VALUE; // 复活间谍：+2 抽牌
    if (hasAb(card, 'medic') && depth < 2) {
      const nextExcluded = new Set(excluded);
      nextExcluded.add(uid);
      v += bestReviveValue(view, ctx, depth + 1, nextExcluded) * 0.85;
    }
    if (hasAb(card, 'muster')) v += expectedMusterInfo(card, view).value * 0.9;
    if (hasAb(card, 'avenger')) v += tokenValue(card) * 0.7;
    return v;
  }

  function bestReviveTarget(view, ctx, excluded = new Set(), depth = 0) {
    const grave = (view.players[P] && view.players[P].graveyard) || [];
    let best = null;
    let bestValue = 0;
    for (const inst of grave) {
      if (excluded.has(inst.uid)) continue;
      const card = cardOf(inst.cardId);
      if (!isRevivable(card)) continue;
      const v = reviveCandidateValue(view, ctx, card, inst.uid, depth, excluded);
      if (v > bestValue) {
        bestValue = v;
        best = { card, uid: inst.uid, value: v };
      }
    }
    return best;
  }

  function bestReviveValue(view, ctx, depth = 0, excluded = new Set()) {
    const target = bestReviveTarget(view, ctx, excluded, depth);
    return target ? target.value : 0;
  }

  function plainUnitFutureValue(card, view, ctx) {
    const rows = card.rows && card.rows.length ? card.rows : ['close'];
    let best = -Infinity;
    const isSpy = hasAb(card, 'spy');
    for (const row of rows) {
      const c2 = cloneCtx(ctx);
      const boardOwner = isSpy ? O : P;
      const rec = addUnitRec(c2, boardOwner, row, card.id, { owner: P });
      if (!rec) continue;
      enterEffectsSim(c2, view, rec, 2);
      const gain = leadOf(c2) - leadOf(ctx);
      if (gain > best) best = gain;
    }
    return best === -Infinity ? 0 : best;
  }

  function bestHornGain(ctx) {
    let best = 0;
    for (const row of ROWS) {
      if (ctx.rowSpecials[P][row]) continue;
      if (rowHasHornUnit(ctx, P, row)) continue;
      const c2 = cloneCtx(ctx);
      c2.rowSpecials[P][row] = { kind: 'horn' };
      const gain = scoreOf(c2, P) - scoreOf(ctx, P);
      if (gain > best) best = gain;
    }
    return best;
  }

  function bestWeatherSwing(ctx) {
    let best = { kind: null, delta: 0 };
    for (const kind of WEATHER_KINDS) {
      if (ctx.weather[kind]) continue;
      const c2 = cloneCtx(ctx);
      c2.weather[kind] = true;
      const delta = leadOf(c2) - leadOf(ctx);
      if (delta > best.delta) best = { kind, delta };
    }
    if (Object.values(ctx.weather).some(Boolean)) {
      const c2 = cloneCtx(ctx);
      c2.weather = { frost: false, fog: false, rain: false, storm: false };
      const delta = leadOf(c2) - leadOf(ctx);
      if (delta > best.delta) best = { kind: 'clear', delta };
    }
    return best;
  }

  function anyScorchGain(ctx) {
    const all = [];
    for (const owner of [0, 1]) {
      for (const row of ROWS) {
        const sim = rowSim(ctx, owner, row);
        for (const e of sim.entries) if (!e.card.hero) all.push({ owner, power: e.power });
      }
    }
    if (!all.length) return 0;
    const max = Math.max(...all.map((e) => e.power));
    let gain = 0;
    for (const e of all) {
      if (e.power !== max) continue;
      gain += e.owner === O ? max : -max;
    }
    return Math.max(0, gain);
  }

  function rowScorchUnitGain(ctx, card) {
    const ab = getAb(card, 'scorch');
    if (!ab) return 0;
    if (ab.mode !== 'row') return anyScorchGain(ctx);
    const row = ab.row;
    if (!ROWS.includes(row)) return 0;
    const sim = rowSim(ctx, O, row);
    const require = ab.requireEnemyRowTotalAtLeast == null ? 10 : ab.requireEnemyRowTotalAtLeast;
    if (sim.total < require) return 0;
    const nonHero = sim.entries.filter((e) => !e.card.hero);
    if (!nonHero.length) return 0;
    const max = Math.max(...nonHero.map((e) => e.power));
    return nonHero.filter((e) => e.power === max).reduce((s, e) => s + e.power, 0);
  }

  function currentPowerOfRec(ctx, boardOwner, uid) {
    for (const row of ROWS) {
      const sim = rowSim(ctx, boardOwner, row);
      const hit = sim.entries.find((e) => e.rec.uid === uid);
      if (hit) return hit.power;
    }
    return 0;
  }

  function reenterValue(view, ctx, card) {
    if (!card) return 0;
    if (hasAb(card, 'medic')) return bestReviveValue(view, ctx);
    if (hasAb(card, 'muster')) return expectedMusterInfo(card, view).value;
    return 0;
  }

  function decoyGain(view, ctx) {
    let best = 0;
    for (const row of ROWS) {
      for (const rec of ctx.rows[P][row]) {
        const card = rec.card;
        if (!card || card.hero) continue;
        const powerNow = currentPowerOfRec(ctx, P, rec.uid);
        let gain = handCardFutureValue(card, view, ctx) - powerNow;
        if (rec.owner === P) gain += reenterValue(view, ctx, card);
        if (hasAb(card, 'avenger') && (view.round || 1) < 3) gain += tokenValue(card) * 0.9;
        if (gain > best) best = gain;
      }
    }
    return best;
  }

  function bestMardroemeGain(view, ctx) {
    let best = 0;
    for (const row of ROWS) {
      if (ctx.rowSpecials[P][row]) continue;
      const c2 = cloneCtx(ctx);
      c2.rowSpecials[P][row] = { kind: 'mardroeme' };
      transformBerserkersRow(c2, P, row);
      const gain = scoreOf(c2, P) - scoreOf(ctx, P);
      if (gain > best) best = gain;
    }
    // 手里还有狂战士时，将来也能变身
    let futureBerserkers = 0;
    for (const inst of myHand(view)) {
      const c = cardOf(inst.cardId);
      if (!c) continue;
      const bers = getAb(c, 'berserker');
      if (!bers) continue;
      const target = cardOf(bers.transformTo);
      if (target) futureBerserkers += (target.strength || 0) - (c.strength || 0);
    }
    best += futureBerserkers * 0.5;
    return best;
  }

  function handCardFutureValue(card, view, ctx) {
    if (!card) return 0;
    if (card.type === 'weather') {
      return Math.max(0, bestWeatherSwing(ctx).delta);
    }
    if (card.type === 'special') {
      if (getAb(card, 'horn')) return Math.max(0, bestHornGain(ctx));
      if (getAb(card, 'mardroeme')) return Math.max(0, bestMardroemeGain(view, ctx));
      if (getAb(card, 'decoy')) return Math.max(0, decoyGain(view, ctx) - 1);
      if (getAb(card, 'scorch')) return Math.max(0, anyScorchGain(ctx));
      return 0;
    }
    const strength = card.strength || 0;
    if (hasAb(card, 'spy')) {
      const draws = Math.min(2, (view.players[P] && view.players[P].deckCount) || 0);
      return (draws - 1) * CARD_VALUE - strength;
    }
    let value = plainUnitFutureValue(card, view, ctx);
    if (hasAb(card, 'avenger') && (view.round || 1) < 3) value += tokenValue(card) * 0.6;
    return value;
  }

  /**
   * 手牌资源估值：
   *  - 主体是“手牌数 × 单牌价值”（手牌数=资源，尤其是间谍抽 2 的核心价值）；
   *  - 再叠加少量“牌质”修正（组合件/高价值牌/无用手牌），避免只看数量。
   */
  function handPotential(view, ctx) {
    const hand = myHand(view);
    const base = hand.length * CARD_VALUE * 0.82;
    let quality = 0;
    const bondCounts = new Map();
    for (const inst of hand) {
      const card = cardOf(inst.cardId);
      if (!card) continue;
      if (hasAb(card, 'bond')) {
        bondCounts.set(card.id, (bondCounts.get(card.id) || 0) + 1);
        continue;
      }
      const fv = handCardFutureValue(card, view, ctx);
      quality += clamp(fv - CARD_VALUE, -3, 6);
    }
    for (const [id, h] of bondCounts) {
      const card = cardOf(id);
      const boardCount = maxBondCountOnBoard(ctx, id);
      const marginal = (card.strength || 0) * (2 * boardCount + h);
      quality += clamp(marginal - CARD_VALUE, -3, 6);
    }
    return Math.max(0, base + quality * 0.35);
  }

  /* ------------------------------------------------------------------ */
  /* 出牌模拟                                                            */
  /* ------------------------------------------------------------------ */

  function applyMusterSim(ctx, view, rec) {
    const info = musterInfo.get(rec.card.id);
    if (!info) return 0;
    const deckCount = (view.players[P] && view.players[P].deckCount) || 0;
    let budget = deckCount;
    const fromHand = info.from.includes('hand');
    const fromDeck = info.from.length === 0 || info.from.includes('deck');
    let handDelta = 0;
    for (const member of info.members) {
      const copies = member.copies || 0;
      if (copies <= 0) continue;
      const isSource = member.id === rec.cardId;
      let visibleAfter = countVisibleCopies(view, member.id);
      if (isSource) visibleAfter -= 1;
      let inHand = 0;
      if (fromHand) {
        inHand = myHand(view).filter((h) => h.uid !== rec.handUid && h.cardId === member.id).length;
        visibleAfter -= inHand;
        if (inHand > 0) handDelta -= inHand * memberValue(member);
      }
      let n = inHand;
      if (fromDeck) {
        const remainingDeck = Math.max(0, copies - Math.max(0, visibleAfter));
        const take = Math.min(remainingDeck, budget);
        if (take > 0) {
          n += take;
          budget -= take;
        }
      }
      for (let i = 0; i < n; i += 1) {
        const targetRow = bestRowForCard(ctx, P, member);
        addUnitRec(ctx, P, targetRow, member.id);
      }
    }
    return handDelta;
  }

  function enterEffectsSim(ctx, view, rec, depth = 0) {
    const card = rec.card;
    let handDelta = 0;
    let premium = 0;
    if (!card) return { handDelta, premium };
    const isSpy = hasAb(card, 'spy');
    if (isSpy) {
      handDelta += Math.min(2, (view.players[P] && view.players[P].deckCount) || 0) * CARD_VALUE;
    }
    if (hasAb(card, 'muster')) handDelta += applyMusterSim(ctx, view, rec);
    if (hasAb(card, 'medic') && depth < 2) {
      const target = bestReviveTarget(view, ctx, new Set([rec.uid]), depth);
      if (target) {
        const row = bestRowForCard(ctx, P, target.card);
        const revived = addUnitRec(ctx, P, row, target.card.id, { owner: P });
        if (revived) {
          const sub = enterEffectsSim(ctx, view, revived, depth + 1);
          handDelta += sub.handDelta;
          premium += sub.premium;
        }
      }
    }
    const scorch = getAb(card, 'scorch');
    if (scorch) {
      if (scorch.mode === 'any') {
        applyScorchAny(ctx);
      } else if (scorch.mode === 'row' && ROWS.includes(scorch.row)) {
        applyScorchRow(ctx, O, scorch.row, scorch.requireEnemyRowTotalAtLeast == null ? 10 : scorch.requireEnemyRowTotalAtLeast);
      }
    }
    if (hasAb(card, 'mardroeme')) {
      const row = rec.row;
      if (!ctx.rowSpecials[rec.boardOwner][row]) ctx.rowSpecials[rec.boardOwner][row] = { kind: 'mardroeme' };
      transformBerserkersRow(ctx, rec.boardOwner, row);
    }
    if (hasAb(card, 'avenger') && (view.round || 1) < 3) premium += tokenValue(card) * 0.6;
    return { handDelta, premium };
  }

  /**
   * 模拟打出一张牌（不修改真实引擎，只改本地 ctx）。
   * @returns {{ctx:Object, deltaLead:number, handDelta:number, premium:number}|null}
   */
  function simulatePlay(action, view, ctx, instOverride) {
    if (!action || action.type !== 'playCard') return null;
    const inst = instOverride || handInst(view, action.uid);
    if (!inst) return null;
    const card = cardOf(inst.cardId);
    if (!card) return null;
    const next = cloneCtx(ctx);
    const beforeLead = leadOf(ctx);
    let handDelta = -handCardFutureValue(card, view, ctx);
    let premium = 0;

    if (card.type === 'weather') {
      const weatherAb = getAb(card, 'weather');
      const kind = weatherAb && weatherAb.weather;
      if (!kind) return null;
      if (kind !== 'clear' && next.weather[kind]) {
        // 重复天气：直接浪费
        return { ctx: next, deltaLead: 0, handDelta, premium: -1, wasted: true };
      }
      applyWeatherCtx(next, kind);
    } else if (card.type === 'special') {
      if (getAb(card, 'horn')) {
        const row = action.row;
        if (!ROWS.includes(row) || next.rowSpecials[P][row]) return null;
        next.rowSpecials[P][row] = { kind: 'horn' };
      } else if (getAb(card, 'mardroeme')) {
        const row = action.row;
        const rowOwner = action.rowOwner === 1 ? 1 : 0;
        if (!ROWS.includes(row) || next.rowSpecials[rowOwner][row]) return null;
        next.rowSpecials[rowOwner][row] = { kind: 'mardroeme' };
        transformBerserkersRow(next, rowOwner, row);
      } else if (getAb(card, 'decoy')) {
        const found = findRecInRows(ctx, P, action.targetUid);
        if (!found) return null;
        const targetCard = found.rec.card;
        if (!targetCard || targetCard.hero) return null;
        handDelta += handCardFutureValue(targetCard, view, ctx);
        if (hasAb(targetCard, 'avenger') && found.rec.owner === P) {
          const av = getAb(targetCard, 'avenger');
          const token = av && cardOf(av.token);
          if (token) {
            const tokenRow = (token.rows && token.rows[0]) || 'close';
            addUnitRec(next, P, tokenRow, token.id, { owner: P });
          }
        }
        removeRecFromCtx(next, P, found.rec);
      } else if (getAb(card, 'scorch')) {
        applyScorchAny(next);
      } else {
        return null;
      }
    } else {
      const row = action.row || (card.rows && card.rows[0]) || 'close';
      const isSpy = hasAb(card, 'spy');
      const boardOwner = isSpy ? O : P;
      const rec = addUnitRec(next, boardOwner, row, card.id, { owner: P });
      if (!rec) return null;
      rec.handUid = inst.uid;
      const effect = enterEffectsSim(next, view, rec, 0);
      handDelta += effect.handDelta;
      premium += effect.premium;
    }

    return { ctx: next, deltaLead: leadOf(next) - beforeLead, handDelta, premium };
  }

  /* ------------------------------------------------------------------ */
  /* 领袖能力估值 / 模拟                                                 */
  /* ------------------------------------------------------------------ */

  function leaderEffect(view) {
    const me = meOf(view);
    if (!me) return null;
    const list = leaderAbilityList(me.leaderId);
    if (!list.length) return null;
    return list.find((a) => !a.passive) || list[0];
  }

  function fizzle(ctx, view, holdCost = 2) {
    return {
      ctx,
      deltaLead: 0,
      handDelta: 0,
      premium: 0,
      holdCost: mustWinRound(view) ? 0 : holdCost,
      fizzle: true,
    };
  }

  /**
   * 模拟使用领袖能力。
   * @returns {{ctx, deltaLead, handDelta, premium, holdCost, fizzle?}}
   */
  function simulateLeader(ctx, view, opts = {}) {
    const me = meOf(view);
    if (!me || !me.leaderAvailable) return null;
    const ab = leaderEffect(view);
    if (!ab) return null;
    const next = cloneCtx(ctx);
    const beforeLead = leadOf(ctx);
    const must = mustWinRound(view) || !!opts.forCatch;

    switch (ab.id) {
      case 'clearWeather': {
        const any = Object.values(ctx.weather).some(Boolean);
        if (!any) return fizzle(next, view, 2);
        applyWeatherCtx(next, 'clear');
        return { ctx: next, deltaLead: leadOf(next) - beforeLead, handDelta: 0, premium: 0, holdCost: must ? 0 : 1 };
      }
      case 'playWeatherFromDeck': {
        const probability = 0.85;
        if (ab.weather === 'any') {
          const best = bestWeatherSwing(ctx);
          if (!best.kind || best.delta <= 0) return fizzle(next, view, 2);
          applyWeatherCtx(next, best.kind);
          return {
            ctx: next,
            deltaLead: (leadOf(next) - beforeLead) * probability,
            handDelta: 0,
            premium: 0,
            holdCost: must ? 0 : 1.5,
          };
        }
        if (!WEATHER_KINDS.includes(ab.weather)) return fizzle(next, view, 2);
        if (next.weather[ab.weather]) return fizzle(next, view, 2);
        applyWeatherCtx(next, ab.weather);
        return {
          ctx: next,
          deltaLead: (leadOf(next) - beforeLead) * probability,
          handDelta: 0,
          premium: 0,
          holdCost: must ? 0 : 1.5,
        };
      }
      case 'leaderHorn': {
        const row = ab.row;
        if (!ROWS.includes(row)) return fizzle(next, view, 2);
        if (next.rowSpecials[P][row] || rowHasHornUnit(ctx, P, row)) return fizzle(next, view, 2);
        next.rowSpecials[P][row] = { kind: 'horn' };
        let additions = 0;
        for (const inst of myHand(view)) {
          const c = cardOf(inst.cardId);
          if (!c || c.type !== 'unit' || hasAb(c, 'spy')) continue;
          if ((c.rows || []).includes(row)) additions += c.strength || 0;
        }
        return {
          ctx: next,
          deltaLead: leadOf(next) - beforeLead,
          handDelta: 0,
          premium: 0,
          holdCost: must ? 0 : additions * 0.5,
        };
      }
      case 'scorchRow': {
        const enemyRowTotal = rowSim(ctx, O, ab.row).total;
        const require = ab.requireEnemyRowTotalAtLeast == null ? 10 : ab.requireEnemyRowTotalAtLeast;
        if (!ROWS.includes(ab.row) || enemyRowTotal < require) return fizzle(next, view, 2);
        applyScorchRow(next, O, ab.row, require);
        return {
          ctx: next,
          deltaLead: leadOf(next) - beforeLead,
          handDelta: 0,
          premium: 0,
          holdCost: must ? 0 : enemyRowTotal < 16 ? 3 : 0.5,
        };
      }
      case 'viewOpponentHand':
        return { ctx: next, deltaLead: 0, handDelta: 0, premium: 1.5, holdCost: 0 };
      case 'takeGraveyardUnitToHand': {
        const from = ab.from === 'opponent' ? O : P;
        const grave = (view.players[from] && view.players[from].graveyard) || [];
        let best = null;
        let bestValue = 0;
        for (const inst of grave) {
          if (inst.isToken || cardOf(inst.cardId)?.deckable === false) continue;
          const c = cardOf(inst.cardId);
          if (!c) continue;
          const v = handCardFutureValue(c, view, ctx);
          if (v > bestValue) {
            bestValue = v;
            best = c;
          }
        }
        if (!best) return fizzle(next, view, 2);
        return { ctx: next, deltaLead: 0, handDelta: bestValue, premium: 0, holdCost: must ? 0 : 1 };
      }
      case 'discardDraw': {
        const hand = myHand(view);
        if (hand.length < 2) return fizzle(next, view, 2);
        const scored = hand
          .map((inst) => ({ inst, v: handCardFutureValue(cardOf(inst.cardId), view, ctx) }))
          .sort((a, b) => a.v - b.v);
        const discardValue = scored[0].v + scored[1].v;
        const handDelta = CARD_VALUE - discardValue;
        return { ctx: next, deltaLead: 0, handDelta, premium: 0, holdCost: 0.5 };
      }
      case 'repositionAgile': {
        const agileUnits = [];
        for (const row of ROWS) {
          for (const rec of next.rows[P][row]) {
            const c = rec.card;
            if (!c || !hasAb(c, 'agile') || hasAb(c, 'spy')) continue;
            agileUnits.push({
              uid: rec.uid,
              cardId: rec.cardId,
              rows: (c.rows || []).filter((r) => ROWS.includes(r)),
            });
          }
        }
        for (const entry of agileUnits) {
          const found = findRecInRows(next, P, entry.uid);
          if (!found) continue;
          removeRecFromCtx(next, P, found.rec);
          let bestRow = entry.rows[0] || 'close';
          let bestTotal = -Infinity;
          for (const alt of entry.rows) {
            const probe = addUnitRec(next, P, alt, entry.cardId, { owner: P });
            const total = rowSim(next, P, alt).total;
            if (probe) removeRecFromCtx(next, P, probe);
            if (total > bestTotal) {
              bestTotal = total;
              bestRow = alt;
            }
          }
          addUnitRec(next, P, bestRow, entry.cardId, { owner: P });
        }
        return {
          ctx: next,
          deltaLead: leadOf(next) - beforeLead,
          handDelta: 0,
          premium: 0,
          holdCost: must ? 0 : agileUnits.length ? 0.5 : 2,
        };
      }
      case 'shuffleGraveyards': {
        let premium;
        if (me.faction === 'skellige') {
          premium = (view.round || 1) >= 3 ? -6 : (view.round || 1) === 2 ? -4 : -1;
        } else {
          const deck = me.deckCount || 0;
          premium = deck <= 4 && (view.round || 1) < 3 ? 4 : -2;
        }
        return { ctx: next, deltaLead: 0, handDelta: 0, premium, holdCost: 0 };
      }
      case 'cancelLeader':
      default:
        return fizzle(next, view, 3);
    }
  }

  function estimateLeaderValue(view, ctx) {
    const sim = simulateLeader(ctx, view);
    if (!sim) return -Infinity;
    const must = mustWinRound(view);
    const value = sim.deltaLead + W_HAND * sim.handDelta + sim.premium - (must ? 0 : sim.holdCost || 0);
    return sim.fizzle ? Math.min(value, -1) : value;
  }

  /* ------------------------------------------------------------------ */
  /* 局面估值（hard 用）                                                 */
  /* ------------------------------------------------------------------ */

  function roundOutcome(view, sMe, sOpp) {
    if (sMe > sOpp) return 1;
    if (sMe < sOpp) return -1;
    const me = meOf(view);
    const opp = oppOf(view);
    const meNilf = !!me && me.faction === 'nilfgaard';
    const oppNilf = !!opp && opp.faction === 'nilfgaard';
    if (meNilf && !oppNilf) return 1;
    if (!meNilf && oppNilf) return -1;
    return 0;
  }

  function tieConsequence(view) {
    const me = meOf(view);
    const opp = oppOf(view);
    const myGems = ((me && me.gems) || 1) - 1;
    const oppGems = ((opp && opp.gems) || 1) - 1;
    if (oppGems <= 0 && myGems <= 0) return 'draw-match';
    if (oppGems <= 0) return 'win-match';
    if (myGems <= 0) return 'lose-match';
    return 'continue';
  }

  function mustWinRound(view) {
    const me = meOf(view);
    const round = view.round || 1;
    return round >= 3 || (me && me.gems === 1);
  }

  function oppThreatEstimate(view) {
    const opp = oppOf(view);
    if (!opp) return 7;
    switch (opp.faction) {
      case 'monsters':
        return 9;
      case 'skellige':
        return 8.5;
      case 'northern-realms':
        return 8;
      case 'nilfgaard':
        return 7.5;
      case 'scoiatael':
        return 7.5;
      default:
        return 7;
    }
  }

  function evaluatePosition(view) {
    if (!view) return 0;
    if (view.result) {
      const winner = view.result.winner;
      if (winner === P) return 1e7;
      if (winner === null) return -3e6;
      return -1e7;
    }
    const me = meOf(view);
    const opp = oppOf(view);
    if (!me || !opp) return 0;
    const ctx = buildCtx(view);
    const lead = (me.score || 0) - (opp.score || 0);
    const lastRound = (view.round || 1) >= 3;
    const must = lastRound || me.gems === 1;
    const winNow = opp.gems === 1;
    const wLead = must ? 1.4 : winNow ? 1.15 : 1;
    const myPot = handPotential(view, ctx);
    const oppPot = (opp.handCount || 0) * OPP_CARD_VALUE;
    let value = lead * wLead + (myPot - oppPot) * W_HAND;

    if (opp.passed && !me.passed) {
      const outcome = roundOutcome(view, me.score || 0, opp.score || 0);
      value += outcome > 0 ? ROUND_WIN_BONUS : -3;
    } else if (me.passed && !opp.passed) {
      const outcome = roundOutcome(view, me.score || 0, opp.score || 0);
      if (outcome > 0) {
        // 我已经 Pass：对手要么放弃（我赢小局），要么花 needed 张牌反超。
        const threat = oppThreatEstimate(view);
        const needed = Math.max(1, Math.ceil(((lead || 0) + 1) / threat));
        if (needed > (opp.handCount || 0)) {
          value += ROUND_WIN_BONUS;
        } else {
          // 对手反超要花牌 → 我获得牌差，但丢掉小局
          value += -ROUND_WIN_BONUS * 0.6 + needed * (CARD_VALUE * 0.85);
        }
      } else {
        value -= 9;
      }
    }
    value += ((me.gems || 0) - (opp.gems || 0)) * GEM_VALUE;
    value += (me.pendingDraws || 0) * CARD_VALUE * 0.9;
    return value;
  }

  function futurePremium(card, view) {
    if (!card) return 0;
    let premium = 0;
    if (hasAb(card, 'avenger') && (view.round || 1) < 3) premium += tokenValue(card) * 0.6;
    return premium;
  }

  /** 卡牌在 clone 局面里体现不出来的“未来价值”（Decoy 回收、复仇者 token 等）。 */
  function actionFuturePremium(action, view, ctx) {
    const card = cardFromAction(view, action);
    let premium = futurePremium(card, view);
    if (card && getAb(card, 'decoy') && action.targetUid) {
      const found = findViewBoardUnit(view, P, action.targetUid);
      if (found) {
        const targetCard = cardOf(found.unit.cardId);
        if (targetCard) {
          if (hasAb(targetCard, 'spy')) premium += CARD_VALUE * 0.6;
          else premium += reenterValue(view, ctx, targetCard) * 0.6;
        }
      }
    }
    return premium;
  }

  /* ------------------------------------------------------------------ */
  /* Pass / 追分决策                                                     */
  /* ------------------------------------------------------------------ */

  function pseudoActionsFor(inst, card, ctx) {
    const acts = [];
    if (!card) return acts;
    if (card.type === 'weather') {
      const ab = getAb(card, 'weather');
      if (ab && ab.weather) acts.push({ type: 'playCard', uid: inst.uid, row: undefined });
      return acts;
    }
    if (card.type === 'special') {
      if (getAb(card, 'horn')) {
        for (const row of ROWS) {
          if (!ctx.rowSpecials[P][row]) acts.push({ type: 'playCard', uid: inst.uid, row });
        }
      } else if (getAb(card, 'mardroeme')) {
        for (const owner of [0, 1]) {
          for (const row of ROWS) {
            if (!ctx.rowSpecials[owner][row]) acts.push({ type: 'playCard', uid: inst.uid, row, rowOwner: owner });
          }
        }
      } else if (getAb(card, 'decoy')) {
        for (const row of ROWS) {
          for (const rec of ctx.rows[P][row]) {
            if (rec.card && !rec.card.hero) acts.push({ type: 'playCard', uid: inst.uid, targetUid: rec.uid });
          }
        }
      } else if (getAb(card, 'scorch')) {
        acts.push({ type: 'playCard', uid: inst.uid });
      }
      return acts;
    }
    const rows = card.rows && card.rows.length ? card.rows : ['close'];
    for (const row of rows) acts.push({ type: 'playCard', uid: inst.uid, row });
    return acts;
  }

  /**
   * 估算“若对手已 Pass，我需要多少张牌才能反超”。贪心模拟。
   */
  function planCatch(view, ctx) {
    let simCtx = cloneCtx(ctx);
    const working = myHand(view).map((h) => ({ uid: h.uid, cardId: h.cardId }));
    const me = meOf(view);
    const opp = oppOf(view);
    const oppScore = (opp && opp.score) || 0;
    let score = (me && me.score) || 0;
    let cost = 0;
    let leaderLeft = !!(me && me.leaderAvailable);
    let guard = 0;
    while (guard++ < 14 && working.length && roundOutcome(view, score, oppScore) <= 0) {
      let best = null;
      let bestDelta = 1e-6;
      for (let i = 0; i < working.length; i += 1) {
        const inst = working[i];
        const card = cardOf(inst.cardId);
        if (!card) continue;
        const options = pseudoActionsFor(inst, card, simCtx);
        for (const action of options) {
          const sim = simulatePlay(action, view, simCtx, inst);
          if (!sim) continue;
          const delta = leadOf(sim.ctx) - leadOf(simCtx);
          if (delta > bestDelta) {
            bestDelta = delta;
            best = { sim, index: i };
          }
        }
      }
      if (leaderLeft) {
        const simL = simulateLeader(simCtx, view, { forCatch: true });
        if (simL) {
          const delta = leadOf(simL.ctx) - leadOf(simCtx);
          if (delta > bestDelta) {
            bestDelta = delta;
            best = { sim: simL, leader: true };
          }
        }
      }
      if (!best) break;
      simCtx = best.sim.ctx;
      score = scoreOf(simCtx, P);
      if (best.leader) leaderLeft = false;
      else {
        working.splice(best.index, 1);
        cost += 1;
      }
    }
    const outcome = roundOutcome(view, score, oppScore);
    return { finalScore: score, cost, canWin: outcome > 0, canTie: outcome === 0 };
  }

  /** @returns {{pass:boolean, reason:string}} */
  function decidePass(view, ctx) {
    const me = meOf(view);
    const opp = oppOf(view);
    if (!me || !opp) return { pass: false, reason: 'nodata' };
    if (me.passed) return { pass: true, reason: 'already-passed' };
    const myScore = me.score || 0;
    const oppScore = opp.score || 0;
    const lead = myScore - oppScore;
    const round = view.round || 1;
    const lastRound = round >= 3;
    const must = lastRound || me.gems === 1;
    const winNow = opp.gems === 1;
    const oppDesperate = lastRound || winNow;
    const myHand = me.handCount || 0;
    const oppHand = opp.handCount || 0;
    const outcome = roundOutcome(view, myScore, oppScore);

    if (opp.passed) {
      if (outcome > 0) return { pass: true, reason: 'ahead-locked' };
      if (outcome === 0) {
        const tie = tieConsequence(view);
        if (tie === 'win-match' || tie === 'draw-match') return { pass: true, reason: 'tie-accept' };
        const plan = planCatch(view, ctx);
        if (plan.canWin) return { pass: false, reason: 'tie-need-win' };
        return { pass: true, reason: 'tie-hopeless' };
      }
      const plan = planCatch(view, ctx);
      if (!plan.canWin && !plan.canTie) return { pass: true, reason: 'cannot-catch' };
      if (plan.canWin) {
        if (must || winNow) return { pass: false, reason: 'must-catch' };
        if (plan.cost <= 2) return { pass: false, reason: 'cheap-catch' };
        if (plan.cost <= 3 && myHand >= plan.cost + 4) return { pass: false, reason: 'affordable-catch' };
        if (oppHand <= 2 && plan.cost <= 3) return { pass: false, reason: 'bleed-catch' };
        return { pass: true, reason: 'save-cards' };
      }
      // 只能打平
      const tie = tieConsequence(view);
      if (must && (tie === 'draw-match' || tie === 'continue')) return { pass: false, reason: 'tie-attempt' };
      return { pass: true, reason: 'accept-loss' };
    }

    // 对手尚未 Pass
    if (must) return { pass: false, reason: 'must-fight' };
    const leadSafe = oppDesperate ? PASS_LEAD + 8 : PASS_LEAD;
    if (outcome > 0 && lead >= leadSafe) return { pass: true, reason: 'safe-lead' };
    if (outcome > 0 && lead >= 6 && myHand <= 2) return { pass: true, reason: 'low-hand-lead' };
    if (!winNow && lead <= -20 && oppHand <= 5) return { pass: true, reason: 'concede' };
    return { pass: false, reason: 'play' };
  }

  /* ------------------------------------------------------------------ */
  /* 合法动作                                                            */
  /* ------------------------------------------------------------------ */

  let probeCardCache;
  function probeAgileCard() {
    if (probeCardCache !== undefined) return probeCardCache;
    probeCardCache = null;
    for (const card of allCards) {
      if (!card || card.type !== 'unit' || card.hero) continue;
      if (!card.rows || card.rows.length < 2) continue;
      if (hasAb(card, 'spy')) continue;
      probeCardCache = card;
      break;
    }
    return probeCardCache;
  }

  function filterAction(action, view) {
    if (!action || typeof action !== 'object') return false;
    if (action.type === 'pass') return true;
    if (action.type === 'useLeader') {
      const me = meOf(view);
      return !!(me && me.leaderAvailable);
    }
    if (action.type !== 'playCard') return false;
    const inst = handInst(view, action.uid);
    if (!inst) return false;
    const card = cardOf(inst.cardId);
    if (!card) return false;
    if (card.type === 'weather') {
      const w = getAb(card, 'weather');
      if (!w || !w.weather) return false;
      if (w.weather === 'clear') return Object.values(view.weather || {}).some(Boolean);
      return !view.weather || !view.weather[w.weather];
    }
    if (card.type === 'special') {
      if (getAb(card, 'horn')) {
        const row = action.row;
        if (!ROWS.includes(row)) return false;
        const special = view.players[P].rowSpecials && view.players[P].rowSpecials[row];
        if (special) return false;
        const hasHornUnit = (view.players[P].rows[row] || []).some((u) => {
          const c = cardOf(u.cardId);
          return c && hasAb(c, 'horn');
        });
        return !hasHornUnit;
      }
      if (getAb(card, 'mardroeme')) {
        const row = action.row;
        const owner = action.rowOwner === 1 ? 1 : 0;
        if (!ROWS.includes(row)) return false;
        const special = view.players[owner].rowSpecials && view.players[owner].rowSpecials[row];
        if (special) return false;
        // 只在能触发/准备触发狂战士时使用
        const hasBerserker = (view.players[owner].rows[row] || []).some((u) => {
          const c = cardOf(u.cardId);
          return c && hasAb(c, 'berserker');
        });
        if (!hasBerserker) {
          const handBerserker = myHand(view).some((h) => {
            const c = cardOf(h.cardId);
            return c && hasAb(c, 'berserker');
          });
          if (!handBerserker) return false;
        }
        return true;
      }
      if (getAb(card, 'decoy')) {
        const found = findViewBoardUnit(view, P, action.targetUid);
        if (!found) return false;
        const targetCard = cardOf(found.unit.cardId);
        return !!(targetCard && !targetCard.hero);
      }
      if (getAb(card, 'scorch')) return true;
      return false;
    }
    // 单位牌
    const rows = card.rows && card.rows.length ? card.rows : [];
    if (rows.length && action.row && !rows.includes(action.row)) return false;
    return true;
  }

  function getLegalActions(view, engine) {
    let actions = [];
    try {
      if (engine && typeof engine.getActions === 'function') actions = engine.getActions() || [];
    } catch (err) {
      actions = [];
    }
    if (!Array.isArray(actions) || !actions.length) {
      actions = Array.isArray(view.actions) ? view.actions : [];
    }
    return actions.filter((a) => filterAction(a, view));
  }

  /* ------------------------------------------------------------------ */
  /* 动作打分                                                            */
  /* ------------------------------------------------------------------ */

  function normalActionScore(action, view, ctx) {
    const opp = oppOf(view);
    if (action.type === 'useLeader') {
      return estimateLeaderValue(view, ctx);
    }
    const sim = simulatePlay(action, view, ctx);
    if (!sim) return -Infinity;
    if (sim.wasted) return sim.deltaLead + W_HAND * sim.handDelta - 2;
    const catchMode = !!(opp && opp.passed);
    if (catchMode) {
      // 追分：只看能增加多少分差，同时略微偏好便宜方案
      return sim.deltaLead * 2 + sim.handDelta * 0.05 + sim.premium;
    }
    let score = sim.deltaLead + W_HAND * sim.handDelta + sim.premium;
    if (mustWinRound(view)) {
      // 决胜局：分数即一切
      score = sim.deltaLead * 1.25 + W_HAND * sim.handDelta + sim.premium;
    }
    return score;
  }

  function pickBest(actions, scoreFn) {
    let best = null;
    let bestScore = -Infinity;
    for (const action of actions) {
      let score;
      try {
        score = scoreFn(action);
      } catch (err) {
        score = -Infinity;
      }
      if (score > bestScore) {
        bestScore = score;
        best = action;
      }
    }
    return { best, bestScore };
  }

  function chooseActionNormal(view, ctx, actions) {
    const pass = actions.find((a) => a.type === 'pass');
    const plays = actions.filter((a) => a.type !== 'pass');
    if (!plays.length) return pass || null;
    const pd = decidePass(view, ctx);
    if (pd.pass && pass) return pass;
    const { best, bestScore } = pickBest(plays, (a) => normalActionScore(a, view, ctx));
    const me = meOf(view);
    const opp = oppOf(view);
    if (bestScore < -1 && pass && me && opp && (me.score || 0) >= (opp.score || 0)) return pass;
    return best || plays[0];
  }

  function chooseActionEasy(view, ctx, actions) {
    const me = meOf(view);
    const opp = oppOf(view);
    const pass = actions.find((a) => a.type === 'pass');
    const plays = actions.filter((a) => a.type !== 'pass');
    if (!plays.length) return pass || null;
    if (opp && opp.passed && me && (me.score || 0) > (opp.score || 0)) return pass || plays[0];
    const pd = decidePass(view, ctx, { easy: true });
    if (pd.pass && pass && rng() < 0.8) return pass;
    if (pass && rng() < 0.1) return pass;

    // 粗估值 + 噪声
    const weighted = plays.map((action) => {
      let value;
      try {
        const sim = action.type === 'useLeader' ? simulateLeader(ctx, view) : simulatePlay(action, view, ctx);
        value = sim ? sim.deltaLead * 0.5 + sim.handDelta * 0.2 + 2 : 0;
      } catch (err) {
        value = 0;
      }
      return { action, weight: Math.max(0.15, value + 1 + rng() * 3) };
    });
    let total = weighted.reduce((s, w) => s + w.weight, 0);
    if (total <= 0) return plays[Math.floor(rng() * plays.length)];
    let roll = rng() * total;
    for (const w of weighted) {
      roll -= w.weight;
      if (roll <= 0) return w.action;
    }
    return plays[plays.length - 1];
  }

  function resolveClonePendings(clone, depth = 0) {
    let guard = 0;
    while (clone.pending && guard++ < 6) {
      const pending = clone.pending;
      if (pending.player !== P) break;
      let view;
      try {
        view = clone.viewFor(P);
      } catch (err) {
        break;
      }
      const choice = choosePendingInternal(pending, view, clone, { depth: depth + 1, useClone: false });
      const res = clone.respond(choice);
      if (!res || !res.ok) break;
    }
  }

  function hardActionValue(action, view, engine, ctx) {
    if (action.type === 'pass') return null;
    try {
      const clone = engine.clone();
      const res = clone.apply(action);
      if (!res || !res.ok) return null;
      resolveClonePendings(clone, 0);
      const after = clone.viewFor(P);
      let value = evaluatePosition(after);
      value += actionFuturePremium(action, view, ctx);
      return value;
    } catch (err) {
      return null;
    }
  }

  /** hard：用 clone 推演“现在 Pass”后的局面。 */
  function hardPassValue(view, engine) {
    try {
      const clone = engine.clone();
      const res = clone.apply({ type: 'pass' });
      if (!res || !res.ok) return null;
      resolveClonePendings(clone, 0);
      return evaluatePosition(clone.viewFor(P));
    } catch (err) {
      return null;
    }
  }

  function chooseActionHard(view, ctx, actions, engine, startTime) {
    const pass = actions.find((a) => a.type === 'pass');
    const plays = actions.filter((a) => a.type !== 'pass');
    if (!plays.length) return pass || null;
    const pd = decidePass(view, ctx);
    const must = mustWinRound(view);

    const before = evaluatePosition(view);
    const budget = BUDGET_MS.hard;
    let best = null;
    let bestValue = -Infinity;
    let fallback = null;
    let fallbackScore = -Infinity;
    let evaluated = 0;
    for (const action of plays) {
      const elapsed = Date.now() - startTime;
      let value = null;
      if (elapsed < budget) {
        try {
          value = hardActionValue(action, view, engine, ctx);
        } catch (err) {
          value = null;
        }
      }
      let heuristic = null;
      try {
        heuristic = normalActionScore(action, view, ctx);
      } catch (err) {
        heuristic = -Infinity;
      }
      if (value != null) {
        evaluated += 1;
        if (action.type === 'useLeader' && heuristic < -0.5) value += heuristic * 2;
        // clone 推演与启发式轻微融合（避免估值函数在特殊局面下过度自信）
        if (heuristic != null) value += 1.5 * heuristic;
        if (value > bestValue) {
          bestValue = value;
          best = action;
        }
      } else if (heuristic > fallbackScore) {
        fallbackScore = heuristic;
        fallback = action;
      }
    }
    if (!best) best = fallback || plays[0];

    // hard：Pass 决策也做 1-ply 推演（规则给出的 Pass 不再是唯一依据）
    let passValue = null;
    if (pass && !must) passValue = hardPassValue(view, engine);
    if (pd.pass && pass) {
      const hardLock = pd.reason === 'ahead-locked'
        || pd.reason === 'cannot-catch'
        || pd.reason === 'tie-accept'
        || pd.reason === 'tie-hopeless'
        || pd.reason === 'concede';
      if (hardLock || passValue == null || evaluated === 0) return pass;
      if (passValue + 0.5 >= bestValue) return pass;
      return best;
    }
    if (pd.pass && !pass) return null;
    if (pass && passValue != null && evaluated > 0 && !must) {
      const me = meOf(view);
      const opp = oppOf(view);
      if (me && opp && !opp.passed && passValue > bestValue + 2) return pass;
    }
    if (pass && evaluated > 0 && bestValue < before - 8 && !must) {
      const me = meOf(view);
      const opp = oppOf(view);
      if (me && opp && (me.score || 0) >= (opp.score || 0)) return pass;
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Pending 决策                                                        */
  /* ------------------------------------------------------------------ */

  function chooseMedicHeuristic(pending, view, ctx) {
    const options = Array.isArray(pending.options) ? pending.options : [];
    let best = { skip: true };
    let bestValue = 0.2;
    for (const opt of options) {
      const card = cardOf(opt.cardId);
      if (!card) continue;
      const value = reviveCandidateValue(view, ctx, card, opt.uid, 0, new Set());
      if (value > bestValue) {
        bestValue = value;
        best = { uid: opt.uid };
      }
    }
    return best;
  }

  function choosePendingHeuristic(pending, view) {
    const ctx = buildCtx(view);
    switch (pending.kind) {
      case 'mulligan':
        return chooseMulliganInternal(view);
      case 'chooseFirstPlayer':
        return { first: difficulty === 'easy' && rng() < 0.35 ? P : O };
      case 'medic':
        return chooseMedicHeuristic(pending, view, ctx);
      case 'reviveRow': {
        const options = Array.isArray(pending.options) && pending.options.length ? pending.options : ROWS;
        const revivedCardId = pending.cardId
          || (pending.inst && pending.inst.cardId)
          || null;
        let bestRow = options[0];
        let bestScore = -Infinity;
        for (const row of options) {
          const c2 = cloneCtx(ctx);
          const card = revivedCardId ? cardOf(revivedCardId) : probeAgileCard();
          if (card) addUnitRec(c2, P, row, card.id, { owner: P });
          const score = scoreOf(c2, P);
          if (score > bestScore) {
            bestScore = score;
            bestRow = row;
          }
        }
        return { row: bestRow };
      }
      case 'takeGraveUnit': {
        const options = Array.isArray(pending.options) ? pending.options : [];
        let best = options[0] ? { uid: options[0].uid } : null;
        let bestValue = -Infinity;
        for (const opt of options) {
          const card = cardOf(opt.cardId);
          const value = card ? handCardFutureValue(card, view, ctx) : 0;
          if (value > bestValue) {
            bestValue = value;
            best = { uid: opt.uid };
          }
        }
        return best || { uid: options[0] && options[0].uid };
      }
      case 'viewHand':
        return { ack: true };
      case 'chooseWeather': {
        const options = Array.isArray(pending.options) ? pending.options : [];
        let best = options[0] ? { uid: options[0].uid } : null;
        let bestDelta = -Infinity;
        for (const opt of options) {
          const kind = opt.weather || (cardOf(opt.cardId) && getAb(cardOf(opt.cardId), 'weather') && getAb(cardOf(opt.cardId), 'weather').weather);
          if (!kind) continue;
          const c2 = cloneCtx(ctx);
          applyWeatherCtx(c2, kind);
          const delta = leadOf(c2) - leadOf(ctx);
          if (delta > bestDelta) {
            bestDelta = delta;
            best = { uid: opt.uid };
          }
        }
        return best || (options[0] ? { uid: options[0].uid } : {});
      }
      case 'discardCards': {
        const options = Array.isArray(pending.options) ? pending.options : [];
        const count = pending.count || 2;
        const scored = options
          .map((opt) => ({ opt, value: handCardFutureValue(cardOf(opt.cardId), view, ctx) }))
          .sort((a, b) => a.value - b.value);
        return { cards: scored.slice(0, count).map((s) => s.opt.uid) };
      }
      case 'deckChoice': {
        const options = Array.isArray(pending.options) ? pending.options : [];
        let best = options[0] ? { uid: options[0].uid } : null;
        let bestValue = -Infinity;
        for (const opt of options) {
          const card = cardOf(opt.cardId);
          if (!card) continue;
          let value = handCardFutureValue(card, view, ctx);
          if (hasAb(card, 'spy')) value += 2;
          if (value > bestValue) {
            bestValue = value;
            best = { uid: opt.uid };
          }
        }
        return best || (options[0] ? { uid: options[0].uid } : {});
      }
      default:
        return safeChoice(pending);
    }
  }

  function choosePendingInternal(pending, view, engine, opts = {}) {
    if (!pending) return {};
    if (pending.player !== P) return safeChoice(pending);
    if (pending.kind === 'mulligan') return chooseMulliganInternal(view);

    // hard：关键选择用 clone 推演
    if (difficulty === 'hard' && opts.useClone !== false && engine && typeof engine.clone === 'function') {
      try {
        const cloneChoices = evaluatePendingWithClone(pending, view, engine);
        if (cloneChoices) return cloneChoices;
      } catch (err) {
        /* 回退启发式 */
      }
    }
    const heuristic = choosePendingHeuristic(pending, view);
    return validateChoice(pending, heuristic) ? heuristic : safeChoice(pending);
  }

  function evaluatePendingWithClone(pending, view, engine) {
    let options = [];
    if (pending.kind === 'medic') {
      options = (pending.options || []).slice(0, 8).map((o) => ({ choice: { uid: o.uid }, label: o }));
    } else if (pending.kind === 'reviveRow') {
      options = (pending.options || []).map((row) => ({ choice: { row }, label: row }));
    } else if (pending.kind === 'chooseWeather') {
      options = (pending.options || []).map((o) => ({ choice: { uid: o.uid }, label: o }));
    } else {
      return null;
    }
    if (!options.length) return null;
    let best = null;
    let bestValue = -Infinity;
    for (const opt of options) {
      try {
        const clone = engine.clone();
        const res = clone.respond(opt.choice);
        if (!res || !res.ok) continue;
        resolveClonePendings(clone, 0);
        const after = clone.viewFor(P);
        const value = evaluatePosition(after);
        if (value > bestValue) {
          bestValue = value;
          best = opt.choice;
        }
      } catch (err) {
        /* ignore */
      }
    }
    return best;
  }

  function validateChoice(pending, choice) {
    if (!choice || typeof choice !== 'object') return false;
    switch (pending.kind) {
      case 'mulligan':
        return Array.isArray(choice.cards);
      case 'chooseFirstPlayer':
        return choice.first === 0 || choice.first === 1;
      case 'medic':
        return choice.skip === true || typeof choice.uid === 'string' || typeof choice.cardId === 'string';
      case 'reviveRow':
        return (pending.options || []).includes(choice.row);
      case 'takeGraveUnit':
        return typeof choice.uid === 'string';
      case 'viewHand':
        return choice.ack === true;
      case 'chooseWeather':
        return typeof choice.uid === 'string' || typeof choice.weather === 'string';
      case 'discardCards': {
        if (!Array.isArray(choice.cards)) return false;
        const validUids = new Set((pending.options || []).map((o) => o.uid));
        const unique = new Set(choice.cards);
        return unique.size === (pending.count || 2) && choice.cards.every((uid) => validUids.has(uid));
      }
      case 'deckChoice':
        return typeof choice.uid === 'string';
      default:
        return true;
    }
  }

  function safeChoice(pending) {
    if (!pending) return {};
    const options = Array.isArray(pending.options) ? pending.options : [];
    switch (pending.kind) {
      case 'mulligan':
        return { cards: [] };
      case 'chooseFirstPlayer':
        return { first: P };
      case 'medic':
        return { skip: true };
      case 'reviveRow':
        return { row: (pending.options || ROWS)[0] };
      case 'takeGraveUnit':
        return options[0] ? { uid: options[0].uid } : {};
      case 'viewHand':
        return { ack: true };
      case 'chooseWeather':
        return options[0] ? { uid: options[0].uid } : { weather: 'clear' };
      case 'discardCards': {
        const count = pending.count || 2;
        return { cards: options.slice(0, count).map((o) => o.uid) };
      }
      case 'deckChoice':
        return options[0] ? { uid: options[0].uid } : {};
      default:
        return {};
    }
  }

  /* ------------------------------------------------------------------ */
  /* Mulligan                                                            */
  /* ------------------------------------------------------------------ */

  function mulliganKeepScore(inst, view, ctx, duplicates) {
    const card = cardOf(inst.cardId);
    if (!card) return 0;
    let score = handCardFutureValue(card, view, ctx);
    if (card.type === 'unit') {
      if (card.hero) score += 1.5;
      if (hasAb(card, 'spy')) score += 3;
      if (hasAb(card, 'medic')) score += 1.5;
      if (hasAb(card, 'muster')) score += 1.5;
      if (hasAb(card, 'avenger')) score -= 1.5;
      if (hasAb(card, 'bond')) score += 0.5;
    } else if (card.type === 'weather') {
      score = 3 + Math.max(0, score) * 0.3;
    } else {
      if (hasAb(card, 'horn')) score += 1.5;
      if (hasAb(card, 'scorch')) score += 1.5;
      if (hasAb(card, 'decoy')) score += 0.5;
      if (hasAb(card, 'mardroeme')) score += 0.5;
    }
    const key = card.type === 'weather'
      ? `w:${(getAb(card, 'weather') || {}).weather || card.id}`
      : card.id;
    const count = duplicates.get(key) || 0;
    if (count > 1 && (card.type !== 'unit' || hasAb(card, 'avenger'))) score -= 4;
    return score;
  }

  function chooseMulliganInternal(view) {
    const me = meOf(view);
    if (!me) return { cards: [] };
    const hand = myHand(view);
    if (!hand.length) return { cards: [] };
    const deckCount = me.deckCount || 0;
    const limit = Math.min(MULLIGAN_LIMIT, hand.length);
    if (difficulty === 'easy') {
      const chosen = [];
      for (const inst of hand) {
        if (chosen.length >= limit) break;
        if (rng() < 0.3) chosen.push(inst.uid);
      }
      return { cards: chosen };
    }
    if (deckCount <= 0) return { cards: [] };
    const ctx = buildCtx(view);
    const duplicates = new Map();
    for (const inst of hand) {
      const card = cardOf(inst.cardId);
      if (!card) continue;
      const key = card.type === 'weather'
        ? `w:${(getAb(card, 'weather') || {}).weather || card.id}`
        : card.id;
      duplicates.set(key, (duplicates.get(key) || 0) + 1);
    }
    const scored = hand
      .map((inst) => ({ inst, score: mulliganKeepScore(inst, view, ctx, duplicates) }))
      .sort((a, b) => a.score - b.score);
    const threshold = difficulty === 'hard' ? 4.6 : 4.2;
    const chosen = [];
    for (const entry of scored) {
      if (chosen.length >= limit) break;
      if (entry.score < threshold) chosen.push(entry.inst.uid);
    }
    return { cards: chosen };
  }

  /* ------------------------------------------------------------------ */
  /* 公开 API                                                            */
  /* ------------------------------------------------------------------ */

  function chooseAction(view, engine) {
    try {
      if (!view || !view.players) return { type: 'pass' };
      if (view.turn != null && view.turn !== P) return null;
      const actions = getLegalActions(view, engine);
      if (!actions.length) return null;
      if (actions.length === 1 && actions[0].type === 'pass') return actions[0];
      const startTime = Date.now();
      const ctx = buildCtx(view);
      if (difficulty === 'easy') return chooseActionEasy(view, ctx, actions);
      if (difficulty === 'hard') return chooseActionHard(view, ctx, actions, engine, startTime);
      return chooseActionNormal(view, ctx, actions);
    } catch (err) {
      try {
        const actions = getLegalActions(view, engine);
        return actions.find((a) => a.type === 'pass') || actions[0] || { type: 'pass' };
      } catch (err2) {
        return { type: 'pass' };
      }
    }
  }

  function choosePending(pending, view, engine) {
    try {
      if (!pending) return {};
      const v = view && view.players ? view : null;
      if (!v) return safeChoice(pending);
      if (pending.player != null && pending.player !== P) return safeChoice(pending);
      const choice = choosePendingInternal(pending, v, engine, {});
      if (validateChoice(pending, choice)) return choice;
      return safeChoice(pending);
    } catch (err) {
      return safeChoice(pending);
    }
  }

  function chooseMulligan(view) {
    try {
      if (!view || !view.players) return { cards: [] };
      const choice = chooseMulliganInternal(view);
      const valid = myHand(view).map((h) => h.uid);
      const cards = (choice.cards || []).filter((uid) => valid.includes(uid)).slice(0, MULLIGAN_LIMIT);
      return { cards };
    } catch (err) {
      return { cards: [] };
    }
  }

  return {
    chooseAction,
    choosePending,
    chooseMulligan,
    difficulty,
    playerIndex: P,
  };
}

export default createAI;
