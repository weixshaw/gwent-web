/**
 * ability-text.js — 卡牌能力文案的唯一事实源
 *
 * 提供：
 *  - ROW_NAMES / WEATHER_NAMES / GROUP_LABELS / TOKEN_LABELS：术语对照
 *  - ABILITY_TEXT：能力 id → { nameZh, nameEn, icon, zh, en }（供 UI 图例、tooltip 复用）
 *  - formatAbilityZh / formatAbilityEn：把结构化 ability 对象渲染成一句话
 *  - formatAbilitiesZh / formatAbilitiesEn：渲染一组能力（按 "\n" 连接）
 *  - abilityNameZh / abilityIcon：按 id 取名称/图标
 *
 * 约定：能力对象一律形如 { id: "muster", group: "Crone", from: ["deck"] }；
 * 本模块不 import 任何其它数据模块，避免循环依赖。
 */

/* ------------------------------------------------------------------ */
/* 术语表                                                              */
/* ------------------------------------------------------------------ */

export const ROW_NAMES = {
  close: { zh: "近战行", en: "Close Combat", nameZh: "近战", nameEn: "Close" },
  ranged: { zh: "远程行", en: "Ranged Combat", nameZh: "远程", nameEn: "Ranged" },
  siege: { zh: "攻城行", en: "Siege", nameZh: "攻城", nameEn: "Siege" },
};

export const WEATHER_NAMES = {
  frost: { zh: "刺骨冰霜", en: "Biting Frost" },
  fog: { zh: "浓雾", en: "Impenetrable Fog" },
  rain: { zh: "暴雨", en: "Torrential Rain" },
  storm: { zh: "史凯利格风暴", en: "Skellige Storm" },
  clear: { zh: "晴天", en: "Clear Weather" },
};

/** Muster 的 group 英文键 → 中文指代（用于"找出所有「…」"） */
export const GROUP_LABELS = {
  Arachas: { zh: "蟹蜘蛛", en: "Arachas" },
  Crone: { zh: "老巫妪", en: "Crone" },
  Ghoul: { zh: "食尸鬼", en: "Ghoul" },
  Nekker: { zh: "孽鬼", en: "Nekker" },
  Vampire: { zh: "吸血鬼", en: "Vampire" },
  "Light Longship": { zh: "轻型长船", en: "Light Longship" },
  "Dwarven Skirmisher": { zh: "矮人散兵", en: "Dwarven Skirmisher" },
  "Elven Skirmisher": { zh: "精灵散兵", en: "Elven Skirmisher" },
  "Havekar Smuggler": { zh: "哈维卡走私贩", en: "Havekar Smuggler" },
  "Gaunter O'Dimm": { zh: "冈特·欧迪姆", en: "Gaunter O'Dimm" },
  "Gaunter O'Dimm: Darkness": { zh: "冈特·欧迪姆：黑暗", en: "Gaunter O'Dimm: Darkness" },
  Roach: { zh: "萝卜", en: "Roach" },
  "Clan Drummond Shield Maiden": { zh: "德拉蒙家族盾女", en: "Clan Drummond Shield Maiden" },
};

/** 召唤衍生物 id → 名称（Avenger / Berserker 引用） */
export const TOKEN_LABELS = {
  "bovine-defense-force": { zh: "牛之防御部队", en: "Bovine Defense Force" },
  hemdall: { zh: "海姆达尔", en: "Hemdall" },
  "transformed-vildkaarl": { zh: "变身维尔德卡尔", en: "Transformed Vildkaarl" },
  "transformed-young-vildkaarl": { zh: "变身年轻维尔德卡尔", en: "Transformed Young Vildkaarl" },
};

/* ------------------------------------------------------------------ */
/* 能力文案（单位能力 + 领袖能力）                                     */
/* ------------------------------------------------------------------ */

export const ABILITY_TEXT = {
  /* --- 单位能力 --- */
  hero: {
    nameZh: "英雄",
    nameEn: "Hero",
    icon: "hero",
    zh: "英雄：不受任何特殊牌或能力影响。",
    en: "Hero: Not affected by any Special Cards or abilities.",
  },
  spy: {
    nameZh: "间谍",
    nameEn: "Spy",
    icon: "spy",
    zh: "间谍：置于对方战场，战力计入对方；己方从牌堆抽 2 张牌。",
    en: "Spy: Place on your opponent's battlefield (counts towards their total) and draw 2 cards from your deck.",
  },
  medic: {
    nameZh: "医师",
    nameEn: "Medic",
    icon: "medic",
    zh: "医师：从己方弃牌堆选择 1 张非英雄单位牌，立即打出。",
    en: "Medic: Choose one non-Hero unit card from your discard pile and play it instantly.",
  },
  muster: {
    nameZh: "集结",
    nameEn: "Muster",
    icon: "muster",
    zh: "集结：从牌堆找出所有同组卡牌并立即打出。",
    en: "Muster: Find all cards of the same group in your deck and play them instantly.",
  },
  bond: {
    nameZh: "紧缚",
    nameEn: "Tight Bond",
    icon: "bond",
    zh: "紧缚：同一行每有 1 张同名单位，自身战力 ×同名单位数量。",
    en: "Tight Bond: This card's strength is multiplied by the number of cards with the same name in its row.",
  },
  morale: {
    nameZh: "士气",
    nameEn: "Morale",
    icon: "morale",
    zh: "士气：同排其他单位各获得 +1 战力。",
    en: "Morale: Adds +1 strength to all other units in the same row.",
  },
  agile: {
    nameZh: "灵巧",
    nameEn: "Agile",
    icon: "agile",
    zh: "灵巧：可放置在近战行或远程行，落子后不可移动。",
    en: "Agile: Can be placed in either the Close or Ranged row. Cannot be moved once placed.",
  },
  horn: {
    nameZh: "号角",
    nameEn: "Commander's Horn",
    icon: "horn",
    zh: "号角：使所在行获得号角效果，该行单位战力翻倍。",
    en: "Commander's Horn: Doubles the strength of all unit cards in that row. Limited to 1 per row.",
  },
  mardroeme: {
    nameZh: "曼陀罗",
    nameEn: "Mardroeme",
    icon: "mardroeme",
    zh: "曼陀罗：使所在行获得曼陀罗效果，立即并持续转化该行的狂战士。",
    en: "Mardroeme: Triggers transformation of all Berserker cards on the same row.",
  },
  decoy: {
    nameZh: "诱饵",
    nameEn: "Decoy",
    icon: "decoy",
    zh: "诱饵：将己方场上 1 张非英雄单位牌换回手牌。",
    en: "Decoy: Swap with a non-Hero unit card on your side of the battlefield to return it to your hand.",
  },
  scorch: {
    nameZh: "灼烧",
    nameEn: "Scorch",
    icon: "scorch",
    zh: "灼烧：摧毁最强单位。",
    en: "Scorch: Kill the strongest unit(s).",
  },
  avenger: {
    nameZh: "复仇者",
    nameEn: "Avenger",
    icon: "avenger",
    zh: "复仇者：离开战场时召唤新的单位取代自己。",
    en: "Avenger: When removed from the battlefield, summons a powerful new unit to take its place.",
  },
  berserker: {
    nameZh: "狂战士",
    nameEn: "Berserker",
    icon: "berserker",
    zh: "狂战士：所在行存在曼陀罗效果时立即变身。",
    en: "Berserker: Transforms when a Mardroeme card is on its row.",
  },
  weather: {
    nameZh: "天气",
    nameEn: "Weather",
    icon: "weather",
    zh: "天气：降低指定行所有单位的战力。",
    en: "Weather: Reduce the strength of all units in the given row(s), including your own.",
  },

  /* --- 领袖能力 --- */
  clearWeather: {
    nameZh: "清空天气",
    nameEn: "Clear Weather",
    icon: "weather",
    zh: "清除当前所有天气效果。",
    en: "Clear all weather effects in play.",
  },
  playWeatherFromDeck: {
    nameZh: "天降恶劣",
    nameEn: "Summon Weather",
    icon: "weather",
    zh: "从牌堆打出 1 张天气牌。",
    en: "Pick a weather card from your deck and play it instantly.",
  },
  viewOpponentHand: {
    nameZh: "窥探",
    nameEn: "Spy Network",
    icon: "hand",
    zh: "查看对手手牌。",
    en: "Look at cards from your opponent's hand.",
  },
  takeGraveyardUnitToHand: {
    nameZh: "亡者归来",
    nameEn: "Grave Robbery",
    icon: "graveyard",
    zh: "从弃牌堆取 1 张单位牌加入手牌。",
    en: "Take a unit card from a discard pile into your hand.",
  },
  cancelLeader: {
    nameZh: "白色火焰",
    nameEn: "The White Flame",
    icon: "leader",
    zh: "被动：取消对手的领袖能力。",
    en: "Passive: Cancel your opponent's Leader Ability.",
  },
  randomRevive: {
    nameZh: "无序复活",
    nameEn: "Chaotic Revival",
    icon: "revive",
    zh: "被动：所有将单位复活回战场的效应改为随机选择目标。",
    en: "Passive: Abilities that restore a unit to the battlefield restore a randomly chosen unit.",
  },
  doubleSpy: {
    nameZh: "间谍操弄",
    nameEn: "Treacherous Spies",
    icon: "spy",
    zh: "被动：所有间谍牌战力 ×2（影响双方）。",
    en: "Passive: Doubles the strength of all spy cards (affects both players).",
  },
  leaderHorn: {
    nameZh: "王命号角",
    nameEn: "Ruler's Horn",
    icon: "horn",
    zh: "使己方指定行获得号角效果。",
    en: "Treat the chosen row as if a Commander's Horn were placed there.",
  },
  scorchRow: {
    nameZh: "行刑灼烧",
    nameEn: "Scorch Row",
    icon: "scorch",
    zh: "若敌方指定行总战力不低于 10，摧毁该行最强单位。",
    en: "Destroy the enemy's strongest unit(s) in the chosen row if its total strength is 10 or more.",
  },
  shuffleGraveyards: {
    nameZh: "洗牌重来",
    nameEn: "Shuffle Graveyards",
    icon: "graveyard",
    zh: "将双方弃牌堆中的所有牌洗回各自牌堆。",
    en: "Shuffle all cards from each player's graveyard back into their decks.",
  },
  discardDraw: {
    nameZh: "弃牌换筹",
    nameEn: "Discard and Draw",
    icon: "hand",
    zh: "弃 2 张手牌，从牌堆选择 1 张加入手牌。",
    en: "Discard 2 cards and draw 1 card of your choice from your deck.",
  },
  drawExtraStart: {
    nameZh: "雏菊恩泽",
    nameEn: "Daisy of the Valley",
    icon: "draw",
    zh: "被动：开局额外抽 1 张牌。",
    en: "Passive: Draw an extra card at the beginning of the battle.",
  },
  repositionAgile: {
    nameZh: "灵巧调度",
    nameEn: "Reposition Agile",
    icon: "agile",
    zh: "将所有己方灵巧单位移动到能使总战力最大的行（已最优则不动）。",
    en: "Move agile units to whichever valid row maximizes their strength.",
  },
  halfWeather: {
    nameZh: "半伤天气",
    nameEn: "Half Weather",
    icon: "weather",
    zh: "被动：己方单位受天气影响时只失去一半力量（向下取整）。",
    en: "Passive: Units only lose half their strength in bad weather conditions.",
  },
};

/** 全部合法能力 id（供数据校验与测试使用） */
export const ABILITY_IDS = Object.freeze(Object.keys(ABILITY_TEXT));

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */

const ROW_ZH = { close: "近战行", ranged: "远程行", siege: "攻城行" };
const ROW_EN = { close: "Close Combat", ranged: "Ranged Combat", siege: "Siege" };

const WEATHER_EFFECT_ZH = {
  frost: "天气：将双方近战行所有单位的战力降为 1（0 战力不变），持续到本小局结束。",
  fog: "天气：将双方远程行所有单位的战力降为 1（0 战力不变），持续到本小局结束。",
  rain: "天气：将双方攻城行所有单位的战力降为 1（0 战力不变），持续到本小局结束。",
  storm: "天气：将双方远程行与攻城行所有单位的战力降为 1（0 战力不变），持续到本小局结束。",
  clear: "天气：清除当前所有天气效果。",
};

const WEATHER_EFFECT_EN = {
  frost: "Weather: Sets the strength of all Close Combat units to 1 for both players.",
  fog: "Weather: Sets the strength of all Ranged Combat units to 1 for both players.",
  rain: "Weather: Sets the strength of all Siege units to 1 for both players.",
  storm: "Weather: Sets the strength of all Ranged and Siege units to 1 for both players.",
  clear: "Weather: Removes all Weather Card effects.",
};

function groupLabel(group, lang) {
  const hit = GROUP_LABELS[group];
  if (hit) return hit[lang];
  return group;
}

function tokenLabel(tokenId, lang) {
  const hit = TOKEN_LABELS[tokenId];
  if (hit) return hit[lang];
  return tokenId;
}

/**
 * 单条能力 → 中文一句话。
 * ctx: { cardType?: 'unit'|'special'|'weather' }（区分"号角牌/号角单位"与"曼陀罗牌/曼陀罗单位"）
 */
export function formatAbilityZh(a, ctx = {}) {
  if (!a || !a.id) return "";
  const cardType = ctx.cardType || "unit";
  switch (a.id) {
    case "hero":
    case "spy":
    case "medic":
    case "bond":
    case "morale":
    case "agile":
      return ABILITY_TEXT[a.id].zh;

    case "muster": {
      const group = groupLabel(a.group, "zh");
      const from = Array.isArray(a.from) ? a.from : ["deck"];
      const source = from.includes("hand") ? "从手牌和牌堆" : "从牌堆";
      return `集结：${source}找出所有「${group}」卡牌并立即打出。`;
    }

    case "scorch": {
      if (a.mode === "any") {
        return "灼烧：摧毁全场战力最高的非英雄单位，并列最高者全部摧毁。";
      }
      const row = ROW_ZH[a.row] || "指定行";
      return `灼烧：若敌方${row}总战力不低于 10，摧毁该行战力最高的非英雄单位，并列最高者全部摧毁。`;
    }

    case "avenger":
      return `复仇者：当此牌离开战场时，在其所在行召唤「${tokenLabel(a.token, "zh")}」。`;

    case "berserker":
      return `狂战士：当所在行存在曼陀罗效果时，变身为「${tokenLabel(a.transformTo, "zh")}」。`;

    case "horn":
      return cardType === "special"
        ? "号角：选择己方一行放置，该行所有单位战力翻倍，持续到本小局结束。"
        : "号角：使所在行获得号角效果，该行单位战力翻倍（自身不受此号角影响）。";

    case "mardroeme":
      return cardType === "special"
        ? "曼陀罗：选择任一行放置，该行获得曼陀罗效果，立即并持续转化该行所有狂战士，持续到本小局结束。"
        : "曼陀罗：使所在行获得曼陀罗效果，立即并持续转化该行的狂战士。";

    case "decoy":
      return "诱饵：选择己方场上 1 张非英雄单位牌返回手牌；本牌以 0 战力占位留在原行。";

    case "weather":
      return WEATHER_EFFECT_ZH[a.weather] || WEATHER_EFFECT_ZH.frost;

    /* --- 领袖能力 --- */
    case "clearWeather":
      return ABILITY_TEXT.clearWeather.zh;

    case "playWeatherFromDeck": {
      if (a.weather === "any") return "从牌堆打出任意 1 张天气牌。";
      const name = (WEATHER_NAMES[a.weather] && WEATHER_NAMES[a.weather].zh) || "天气牌";
      return `从牌堆打出「${name}」。`;
    }

    case "viewOpponentHand":
      return `查看对手随机的 ${a.count || 1} 张手牌。`;

    case "takeGraveyardUnitToHand":
      return a.from === "opponent"
        ? "从对手弃牌堆取 1 张单位牌加入手牌。"
        : "从己方弃牌堆取 1 张单位牌加入手牌。";

    case "cancelLeader":
      return "被动：取消对手的领袖能力。若双方都带此领袖，则双方领袖能力都被取消。";

    case "randomRevive":
      return "被动：所有将单位复活回战场的效应改为随机选择目标（影响双方）。";

    case "doubleSpy":
      return "被动：所有间谍牌战力 ×2（影响双方）。";

    case "leaderHorn": {
      const row = ROW_ZH[a.row] || "指定";
      return `己方${row}获得号角效果` + (a.row ? "（该行已有号角则无效）。" : "。");
    }

    case "scorchRow": {
      const row = ROW_ZH[a.row] || "指定行";
      const need = a.requireEnemyRowTotalAtLeast || 10;
      return `若敌方${row}总战力不低于 ${need}，摧毁该行战力最高的非英雄单位（并列全毁）。`;
    }

    case "shuffleGraveyards":
      return ABILITY_TEXT.shuffleGraveyards.zh;

    case "discardDraw":
      return `弃 ${a.discard || 2} 张手牌，从牌堆选择 ${a.draw || 1} 张加入手牌。`;

    case "drawExtraStart":
      return `被动：开局额外抽 ${a.count || 1} 张牌。`;

    case "repositionAgile":
      return ABILITY_TEXT.repositionAgile.zh;

    case "halfWeather":
      return ABILITY_TEXT.halfWeather.zh;

    default:
      return ABILITY_TEXT[a.id] ? ABILITY_TEXT[a.id].zh : "";
  }
}

/** 单条能力 → 英文一句话。 */
export function formatAbilityEn(a, ctx = {}) {
  if (!a || !a.id) return "";
  const cardType = ctx.cardType || "unit";
  switch (a.id) {
    case "hero":
    case "spy":
    case "medic":
    case "bond":
    case "morale":
    case "agile":
      return ABILITY_TEXT[a.id].en;

    case "muster": {
      const group = groupLabel(a.group, "en");
      const from = Array.isArray(a.from) ? a.from : ["deck"];
      const source = from.includes("hand") ? "in your hand and deck" : "in your deck";
      return `Muster: Find all cards named "${group}" ${source} and play them instantly.`;
    }

    case "scorch": {
      if (a.mode === "any") {
        return "Scorch: Kill the strongest non-Hero unit(s) on the battlefield.";
      }
      const row = ROW_EN[a.row] || "chosen";
      return `Scorch: If the combined strength of the enemy's ${row} row is 10 or more, destroy its strongest non-Hero unit(s).`;
    }

    case "avenger":
      return `Avenger: When this card leaves the battlefield, summon ${tokenLabel(a.token, "en")} in its place.`;

    case "berserker":
      return `Berserker: Transforms into ${tokenLabel(a.transformTo, "en")} when a Mardroeme card is on its row.`;

    case "horn":
      return cardType === "special"
        ? "Commander's Horn: Place on one of your rows. Doubles the strength of all units in that row until the end of the round."
        : "Commander's Horn: Treat this card's row as if a Commander's Horn were placed there (this card is not doubled by itself).";

    case "mardroeme":
      return cardType === "special"
        ? "Mardroeme: Place on any row. Triggers transformation of all Berserker cards in that row until the end of the round."
        : "Mardroeme: Treat this card's row as if a Mardroeme card were placed there.";

    case "decoy":
      return "Decoy: Swap with a non-Hero unit card on your side of the battlefield to return it to your hand.";

    case "weather":
      return WEATHER_EFFECT_EN[a.weather] || WEATHER_EFFECT_EN.frost;

    case "clearWeather":
      return ABILITY_TEXT.clearWeather.en;

    case "playWeatherFromDeck": {
      if (a.weather === "any") return "Pick any weather card from your deck and play it instantly.";
      const name = (WEATHER_NAMES[a.weather] && WEATHER_NAMES[a.weather].en) || "weather card";
      return `Pick a ${name} card from your deck and play it instantly.`;
    }

    case "viewOpponentHand":
      return `Look at ${a.count || 1} random cards from your opponent's hand.`;

    case "takeGraveyardUnitToHand":
      return a.from === "opponent"
        ? "Draw a unit card from your opponent's discard pile."
        : "Return a unit card from your discard pile to your hand.";

    case "cancelLeader":
      return "Passive: Cancel your opponent's Leader Ability.";

    case "randomRevive":
      return "Passive: Abilities that restore a unit to the battlefield restore a randomly chosen unit. Affects both players.";

    case "doubleSpy":
      return "Passive: Doubles the strength of all spy cards (affects both players).";

    case "leaderHorn":
      return `Treat your ${ROW_EN[a.row] || "chosen"} row as if a Commander's Horn were placed there.`;

    case "scorchRow":
      return `If the combined strength of the enemy's ${ROW_EN[a.row] || "chosen"} row is ${a.requireEnemyRowTotalAtLeast || 10} or more, destroy its strongest non-Hero unit(s).`;

    case "shuffleGraveyards":
      return ABILITY_TEXT.shuffleGraveyards.en;

    case "discardDraw":
      return `Discard ${a.discard || 2} cards and draw ${a.draw || 1} card of your choice from your deck.`;

    case "drawExtraStart":
      return `Passive: Draw ${a.count || 1} extra card at the beginning of the battle.`;

    case "repositionAgile":
      return ABILITY_TEXT.repositionAgile.en;

    case "halfWeather":
      return ABILITY_TEXT.halfWeather.en;

    default:
      return ABILITY_TEXT[a.id] ? ABILITY_TEXT[a.id].en : "";
  }
}

/** 一组能力 → 中文多行文本 */
export function formatAbilitiesZh(abilities, ctx = {}) {
  if (!Array.isArray(abilities) || abilities.length === 0) return "";
  return abilities.map((a) => formatAbilityZh(a, ctx)).filter(Boolean).join("\n");
}

/** 一组能力 → 英文多行文本 */
export function formatAbilitiesEn(abilities, ctx = {}) {
  if (!Array.isArray(abilities) || abilities.length === 0) return "";
  return abilities.map((a) => formatAbilityEn(a, ctx)).filter(Boolean).join("\n");
}

/** 能力中文名（图例用） */
export function abilityNameZh(id) {
  return (ABILITY_TEXT[id] && ABILITY_TEXT[id].nameZh) || id;
}

/** 能力英文名 */
export function abilityNameEn(id) {
  return (ABILITY_TEXT[id] && ABILITY_TEXT[id].nameEn) || id;
}

/** 能力图标名（visualist 的 art.js 消费） */
export function abilityIcon(id) {
  return (ABILITY_TEXT[id] && ABILITY_TEXT[id].icon) || "none";
}

export default ABILITY_TEXT;
