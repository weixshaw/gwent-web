/**
 * Deck validation & deck-list <-> card-id expansion.
 * Rules (see docs/GAME_RULES.md §7):
 *  - exactly 1 leader of the faction
 *  - units (incl. heroes) >= 22
 *  - specials (special + weather) <= 10
 *  - only faction cards + neutral cards
 *  - no more copies than the collected amount (card.copies)
 *  - tokens (deckable === false, copies === 0) cannot be included
 */

export const ROWS = ['close', 'ranged', 'siege'];
export const ROW_NAMES_ZH = { close: '近战行', ranged: '远程行', siege: '攻城行' };

export function isUnitCard(card) {
  return card && card.type === 'unit';
}
export function isSpecialCard(card) {
  return card && (card.type === 'special' || card.type === 'weather');
}

/** Cards usable in a deck of `faction`: own faction + neutral, deckable only. */
export function cardsAvailableFor(cards, faction) {
  return Object.values(cards).filter(
    (c) => c.deckable !== false && c.copies > 0 && (c.faction === faction || c.faction === 'neutral'),
  );
}

/**
 * Validate a deck given as [{id, count}] or [id, id, ...].
 * @returns {{ok:boolean, errors:string[], stats:{units:number,special:number,heroes:number,strength:number,total:number}}}
 */
export function validateDeck(deckSpec, leaderId, faction, cards, leaders) {
  const errors = [];
  const counts = new Map();
  const entries = Array.isArray(deckSpec)
    ? deckSpec.map((entry) => (typeof entry === 'string' ? { id: entry, count: 1 } : entry))
    : [];
  for (const { id, count } of entries) {
    counts.set(id, (counts.get(id) ?? 0) + (count || 1));
  }

  let units = 0;
  let special = 0;
  let heroes = 0;
  let strength = 0;
  let total = 0;

  for (const [id, count] of counts) {
    const card = cards[id];
    if (!card) {
      errors.push(`未知卡牌 id：${id}`);
      continue;
    }
    if (count <= 0) {
      errors.push(`「${card.nameZh || card.nameEn}」数量必须大于 0`);
      continue;
    }
    if (!card.deckable || card.copies <= 0) {
      errors.push(`「${card.nameZh || card.nameEn}」不可加入牌组`);
      continue;
    }
    if (card.faction !== faction && card.faction !== 'neutral') {
      errors.push(`「${card.nameZh || card.nameEn}」不属于该阵营或中立`);
      continue;
    }
    if (count > card.copies) {
      errors.push(`「${card.nameZh || card.nameEn}」超出收藏份数（${card.copies}）`);
    }
    total += count;
    if (isUnitCard(card)) {
      units += count;
      if (card.hero) heroes += count;
      strength += (card.strength || 0) * count;
    } else {
      special += count;
    }
  }

  const leader = leaders?.[leaderId];
  if (!leader) errors.push('必须选择一名领袖');
  else if (leader.faction !== faction) errors.push('领袖不属于该阵营');
  if (units < 22) errors.push(`单位牌数量不足：需要至少 22 张，当前 ${units} 张`);
  if (special > 10) errors.push(`特殊牌过多：最多 10 张，当前 ${special} 张`);
  if (total === 0) errors.push('牌组为空');

  return { ok: errors.length === 0, errors, stats: { units, special, heroes, strength, total } };
}

/** Expand [{id,count}] into a flat card-id array (shuffle done by engine). */
export function expandDeck(deckSpec) {
  const out = [];
  for (const entry of deckSpec) {
    const id = typeof entry === 'string' ? entry : entry.id;
    const count = typeof entry === 'string' ? 1 : entry.count || 1;
    for (let i = 0; i < count; i++) out.push(id);
  }
  return out;
}
