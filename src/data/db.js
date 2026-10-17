/**
 * db.js — 卡牌/领袖/阵营索引与牌组校验
 *
 * 契约（docs/ARCHITECTURE.md §4）：
 *   CARDS_BY_FACTION, getCard, getLeader, getFaction, collectionFor, validateDeck
 *
 * 牌组规则（docs/GAME_RULES.md §7）：
 *   - 单位牌（含英雄）≥ 22
 *   - 特殊牌（special + weather）≤ 10
 *   - 领袖恰好 1 张，且必须属于所选阵营
 *   - 只能使用"本阵营 + 中立"的卡
 *   - 每张卡数量 ≤ copies
 *   - deckable=false 的衍生物不可入组
 */

import { CARDS, CARD_LIST } from "./cards.js";
import { LEADERS, LEADER_LIST } from "./leaders.js";
import { FACTIONS, FACTION_IDS, ALL_FACTION_IDS } from "./factions.js";

/** 牌组规则常量（UI/测试/AI 共用） */
export const DECK_RULES = Object.freeze({
  MIN_UNITS: 22,
  MAX_SPECIALS: 10,
  MIN_UNIT_STRENGTH: 0,
});

/** 5 个可玩阵营 */
export { FACTION_IDS, ALL_FACTION_IDS };

/** faction → 该阵营全部卡牌 id（含不可收藏衍生物；按 CARDS 定义顺序） */
export const CARDS_BY_FACTION = Object.fromEntries(ALL_FACTION_IDS.map((f) => [f, []]));
for (const card of CARD_LIST) {
  if (!CARDS_BY_FACTION[card.faction]) CARDS_BY_FACTION[card.faction] = [];
  CARDS_BY_FACTION[card.faction].push(card.id);
}

/** 全部可收藏卡（deckable 且 copies > 0） */
export const DECKABLE_CARDS = CARD_LIST.filter((c) => c.deckable && c.copies > 0);

/** 全部合法卡牌 id */
export const CARD_IDS = Object.keys(CARDS);

/* ------------------------------------------------------------------ */
/* 基础查询                                                            */
/* ------------------------------------------------------------------ */

/** @returns 卡牌对象 | null */
export function getCard(id) {
  return CARDS[id] || null;
}

/** @returns 领袖对象 | null */
export function getLeader(id) {
  return LEADERS[id] || null;
}

/** @returns 阵营对象（含 neutral）| null */
export function getFaction(id) {
  return FACTIONS[id] || null;
}

export function isPlayableFaction(id) {
  return FACTION_IDS.includes(id);
}

/**
 * 某阵营的可用收藏：本阵营 + 中立，deckable 且 copies > 0。
 * 顺序：先本阵营（按 CARDS 定义顺序），后中立。
 */
export function collectionFor(factionId) {
  if (!FACTIONS[factionId]) return [];
  if (factionId === "neutral") return DECKABLE_CARDS.filter((c) => c.faction === "neutral");
  return DECKABLE_CARDS.filter((c) => c.faction === factionId || c.faction === "neutral");
}

/** 某阵营可收集的单位牌（含英雄） */
export function unitsFor(factionId) {
  return collectionFor(factionId).filter((c) => c.type === "unit");
}

/** 某阵营可收集的特殊牌（special + weather） */
export function specialsFor(factionId) {
  return collectionFor(factionId).filter((c) => c.type === "special" || c.type === "weather");
}

/** 卡牌的中文显示名（找不到时回退 id） */
export function cardName(id) {
  const c = getCard(id);
  return c ? c.nameZh : id;
}

/* ------------------------------------------------------------------ */
/* 牌组校验                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把牌组规格统一展开成卡牌 id 数组。
 * 兼容两种输入：['id','id',...] 与 [{id, count}, ...]（预设牌组格式）。
 */
export function normalizeDeckSpec(deckSpec) {
  if (!Array.isArray(deckSpec)) return null;
  const ids = [];
  for (const entry of deckSpec) {
    if (typeof entry === "string") {
      ids.push(entry);
    } else if (entry && typeof entry === "object" && typeof entry.id === "string") {
      const n = Number.isInteger(entry.count) ? entry.count : 1;
      for (let i = 0; i < Math.max(0, n); i++) ids.push(entry.id);
    } else {
      ids.push(String(entry));
    }
  }
  return ids;
}

/**
 * 校验牌组。
 *
 * @param {string[]} deckIds   已按份数展开的卡牌 id 数组（引擎契约格式）
 * @param {string}   leaderId  领袖 id
 * @param {string}   factionId 阵营 id（5 个可玩阵营之一）
 * @returns {{ok:boolean, errors:string[], stats:{units:number, specials:number, heroes:number, strength:number, total:number}}}
 */
export function validateDeck(deckIds, leaderId, factionId) {
  const errors = [];
  const stats = { units: 0, specials: 0, heroes: 0, strength: 0, total: 0 };

  /* --- 阵营 --- */
  const faction = getFaction(factionId);
  if (!faction) {
    errors.push(`未知阵营：「${factionId ?? ""}」。`);
  } else if (!isPlayableFaction(factionId)) {
    errors.push("「中立」不是可对战阵营，请选择 5 大阵营之一。");
  }

  /* --- 领袖 --- */
  if (!leaderId) {
    errors.push("必须选择 1 张领袖牌。");
  } else {
    const leader = getLeader(leaderId);
    if (!leader) {
      errors.push(`未知领袖牌：「${leaderId}」。`);
    } else if (faction && leader.faction !== factionId) {
      errors.push(`领袖「${leader.nameZh}」不属于当前阵营。`);
    }
  }

  /* --- 卡牌本身 --- */
  const normalized = normalizeDeckSpec(deckIds);
  if (!normalized) {
    errors.push("牌组必须是卡牌 id 数组（或 [{id, count}] 列表）。");
    return { ok: false, errors, stats };
  }

  stats.total = normalized.length;
  const counts = new Map();
  for (const id of normalized) {
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  for (const [id, count] of counts) {
    const card = getCard(id);
    if (!card) {
      errors.push(`未知卡牌：「${id}」。`);
      continue;
    }
    if (!card.deckable || card.copies <= 0) {
      errors.push(`「${card.nameZh}」是召唤衍生物，不能放入牌组。`);
      continue;
    }
    if (count > card.copies) {
      errors.push(`「${card.nameZh}」超出收藏份数：最多 ${card.copies} 张，当前 ${count} 张。`);
    }
    if (faction && card.faction !== factionId && card.faction !== "neutral") {
      errors.push(`「${card.nameZh}」属于其他阵营，不能加入${faction.nameZh}牌组。`);
    }
    if (card.type === "unit") {
      stats.units += count;
      stats.strength += (card.strength || 0) * count;
      if (card.hero) stats.heroes += count;
    } else {
      stats.specials += count;
    }
  }

  /* --- 数量规则 --- */
  if (stats.units < DECK_RULES.MIN_UNITS) {
    errors.push(`单位牌不足：至少需要 ${DECK_RULES.MIN_UNITS} 张，当前 ${stats.units} 张。`);
  }
  if (stats.specials > DECK_RULES.MAX_SPECIALS) {
    errors.push(`特殊牌过多：最多 ${DECK_RULES.MAX_SPECIALS} 张，当前 ${stats.specials} 张。`);
  }

  return { ok: errors.length === 0, errors, stats };
}

/** 便捷判断：牌组是否合法 */
export function isDeckValid(deckIds, leaderId, factionId) {
  return validateDeck(deckIds, leaderId, factionId).ok;
}

/* ------------------------------------------------------------------ */
/* 汇总信息（调试 / 测试 / UI 统计用）                                 */
/* ------------------------------------------------------------------ */

export function cardCountByFaction() {
  const out = {};
  for (const id of ALL_FACTION_IDS) out[id] = CARDS_BY_FACTION[id] ? CARDS_BY_FACTION[id].length : 0;
  return out;
}

export function leaderCountByFaction() {
  const out = {};
  for (const l of LEADER_LIST) out[l.faction] = (out[l.faction] || 0) + 1;
  return out;
}

export const TOTAL_CARDS = CARD_LIST.length;
export const TOTAL_LEADERS = LEADER_LIST.length;

export default {
  CARDS,
  LEADERS,
  FACTIONS,
  CARDS_BY_FACTION,
  getCard,
  getLeader,
  getFaction,
  collectionFor,
  validateDeck,
};
