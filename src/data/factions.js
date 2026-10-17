/**
 * factions.js — 5 个可玩阵营 + 中立伪阵营
 *
 * 数据结构（docs/ARCHITECTURE.md §4）：
 *   { id, nameZh, nameEn, sigil, colors:{primary,accent,glow},
 *     ability:{id,...}, abilityZh, abilityEn, loreZh }
 *
 * sigil 供 visualist 程序化纹章使用：lion | sun | leaf | claw | longship | star
 * colors 与 docs/ART_DIRECTION.md §2 的阵营色 token 对齐。
 */

export const FACTIONS = {
  "northern-realms": {
    id: "northern-realms",
    nameZh: "北方领域",
    nameEn: "Northern Realms",
    sigil: "lion",
    shortZh: "北方",
    colors: { primary: "#4d7ea8", accent: "#c9a227", glow: "#9cc4e4" },
    ability: { id: "drawOnRoundWin" },
    abilityZh: "每赢下一小局，在下一小局开始时从牌堆抽 1 张牌。",
    abilityEn: "Draw a card from your deck whenever you win a round.",
    loreZh:
      "泰莫利亚、瑞达尼亚与科德温诸国并肩而立。北境的人民坚毅而多疑，他们的军队以纪律与钢铁守住最后的自由。",
  },

  nilfgaard: {
    id: "nilfgaard",
    nameZh: "尼弗迦德帝国",
    nameEn: "Nilfgaardian Empire",
    sigil: "sun",
    shortZh: "尼弗迦德",
    colors: { primary: "#1b1b1d", accent: "#d4af37", glow: "#f0d078" },
    ability: { id: "winTies" },
    abilityZh: "平局时视为尼弗迦德获胜（只扣对手 1 颗宝石）。",
    abilityEn: "Wins any round that ends in a draw.",
    loreZh:
      "来自南方的黑衣帝国，以烈日为徽。恩希尔的野心与纪律一样森冷，帝国的军团所到之处，皆被纳入版图。",
  },

  scoiatael: {
    id: "scoiatael",
    nameZh: "松鼠党",
    nameEn: "Scoia'tael",
    sigil: "leaf",
    shortZh: "松鼠党",
    colors: { primary: "#2f5d3a", accent: "#b87333", glow: "#a8e0a0" },
    ability: { id: "chooseFirstPlayer" },
    abilityZh: "比赛开始时由松鼠党决定谁先手；双方都是松鼠党时抛硬币。",
    abilityEn: "Decide who takes the first turn at the start of the game.",
    loreZh:
      "被人类逐出家园的精灵、矮人与其他非人种族组成的游击队。他们藏身于森林，以箭与仇恨回应压迫。",
  },

  monsters: {
    id: "monsters",
    nameZh: "怪物",
    nameEn: "Monsters",
    sigil: "claw",
    shortZh: "怪物",
    colors: { primary: "#7a1f1f", accent: "#d9cbb3", glow: "#ff6b5a" },
    ability: { id: "keepRandomUnit" },
    abilityZh: "每小局结束时，随机保留 1 张己方单位牌到下一小局（含英雄）。",
    abilityEn: "Keeps a random unit card on the battlefield after each round.",
    loreZh:
      "天球交汇后滞留大陆的怪物——食尸鬼、吸血鬼、巨兽与妖灵。它们没有旗帜，只有饥饿与本能。",
  },

  skellige: {
    id: "skellige",
    nameZh: "史凯利格",
    nameEn: "Skellige",
    sigil: "longship",
    shortZh: "群岛",
    colors: { primary: "#2f6f6a", accent: "#c9a227", glow: "#9adfd6" },
    ability: { id: "round3Revive" },
    abilityZh: "第三小局开始时，从弃牌堆随机取 2 张单位牌放回战场。",
    abilityEn:
      "2 random unit cards from the graveyard are placed on the battlefield at the start of the third round.",
    loreZh:
      "风暴群岛上的史凯利格人。长船、战斧与荣耀是他们的信仰，宁可战死，也不愿卑躬屈膝。",
  },

  neutral: {
    id: "neutral",
    nameZh: "中立",
    nameEn: "Neutral",
    sigil: "star",
    shortZh: "中立",
    colors: { primary: "#8b7d5c", accent: "#d9cbb3", glow: "#e7dcc2" },
    ability: { id: "none" },
    abilityZh: "中立牌不属于任何阵营，可被任意阵营编入牌组。",
    abilityEn: "Neutral cards can be used by any faction.",
    loreZh:
      "不属于任何阵营的猎魔人、术士、吟游诗人与特殊牌。乱世之中，人人皆可雇佣，也人人皆可背弃。",
  },
};

/** 5 个可玩阵营（不含 neutral） */
export const FACTION_IDS = ["northern-realms", "nilfgaard", "scoiatael", "monsters", "skellige"];

/** 全部 faction 键（含 neutral） */
export const ALL_FACTION_IDS = [...FACTION_IDS, "neutral"];

export const FACTION_LIST = Object.values(FACTIONS);

export const getFactionData = (id) => FACTIONS[id] || null;

export default FACTIONS;
