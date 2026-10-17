/**
 * decks.js — 预设牌组（快速游戏 / AI 使用）与展开工具
 *
 * 结构：PRESET_DECKS = { factionId: [ { id, nameZh, nameEn, descZh, leaderId, cards:[{id,count}] }, ... ] }
 * 每套牌组均满足 docs/GAME_RULES.md §7 的构筑规则（tests/card-data.test.mjs 用 validateDeck 复核）：
 *   - 单位牌（含英雄）≥ 22
 *   - 特殊牌（special + weather）≤ 10
 *   - 领袖属于本阵营
 *   - 只使用"本阵营 + 中立"卡，每卡数量 ≤ copies
 *
 * 引擎契约中 deck 是"按份数展开的卡牌 id 数组"，用 expandPreset(preset) 转换。
 */

import { FACTION_IDS } from "./factions.js";

export const PRESET_DECKS = {
  "northern-realms": [
    {
      id: "nr-temeria",
      nameZh: "泰莫利亚王师",
      nameEn: "Host of Temeria",
      descZh: "蓝衣铁卫与克林弗里德屠龙者的紧缚阵线，配三名间谍与医师滚雪球。",
      leaderId: "foltest-lord-commander-of-the-north",
      cards: [
        { id: "blue-stripes-commando", count: 3 },
        { id: "crinfrid-reavers-dragon-hunter", count: 3 },
        { id: "poor-fucking-infantry", count: 3 },
        { id: "catapult", count: 2 },
        { id: "redanian-foot-soldier", count: 2 },
        { id: "ballista", count: 1 },
        { id: "dun-banner-medic", count: 1 },
        { id: "prince-stennis", count: 1 },
        { id: "sigismund-dijkstra", count: 1 },
        { id: "thaler", count: 1 },
        { id: "keira-metz", count: 1 },
        { id: "esterad-thyssen", count: 1 },
        { id: "john-natalis", count: 1 },
        { id: "philippa-eilhart", count: 1 },
        { id: "vernon-roche", count: 1 },
        { id: "commander-s-horn", count: 2 },
        { id: "decoy", count: 2 },
        { id: "scorch", count: 1 },
      ],
    },
    {
      id: "nr-siege",
      nameZh: "攻城大师的钢铁洪流",
      nameEn: "The Siegemaster's Iron Tide",
      descZh: "以攻城行号角为核心，弩炮、投石车与投石机倾泻火力，前排紧缚稳住阵脚。",
      leaderId: "foltest-the-siegemaster",
      cards: [
        { id: "blue-stripes-commando", count: 3 },
        { id: "crinfrid-reavers-dragon-hunter", count: 3 },
        { id: "poor-fucking-infantry", count: 3 },
        { id: "catapult", count: 2 },
        { id: "trebuchet", count: 2 },
        { id: "redanian-foot-soldier", count: 2 },
        { id: "ballista", count: 1 },
        { id: "siege-tower", count: 1 },
        { id: "kaedweni-siege-expert", count: 1 },
        { id: "siegfried-of-denesle", count: 1 },
        { id: "ves", count: 1 },
        { id: "dun-banner-medic", count: 1 },
        { id: "prince-stennis", count: 1 },
        { id: "thaler", count: 1 },
        { id: "esterad-thyssen", count: 1 },
        { id: "john-natalis", count: 1 },
        { id: "vernon-roche", count: 1 },
        { id: "commander-s-horn", count: 2 },
        { id: "decoy", count: 1 },
        { id: "clear-weather", count: 1 },
        { id: "scorch", count: 1 },
      ],
    },
  ],

  nilfgaard: [
    {
      id: "ng-black-legion",
      nameZh: "黑衣军团",
      nameEn: "The Black Legion",
      descZh: "因佩拉旅与瑙西卡骑兵的紧缚方阵，间谍抽牌、医师复活，用人数碾压对手。",
      leaderId: "emhyr-var-emreis-emperor-of-nilfgaard",
      cards: [
        { id: "impera-brigade-guard", count: 4 },
        { id: "nausicaa-cavalry-rider", count: 3 },
        { id: "young-emissary", count: 2 },
        { id: "black-infantry-archer", count: 2 },
        { id: "etolian-auxiliary-archers", count: 2 },
        { id: "siege-technician", count: 1 },
        { id: "siege-engineer", count: 1 },
        { id: "shilard-fitz-oesterlen", count: 1 },
        { id: "vattier-de-rideaux", count: 1 },
        { id: "stefan-skellen", count: 1 },
        { id: "cahir-mawr-dyffryn-aep-ceallach", count: 1 },
        { id: "fringilla-vigo", count: 1 },
        { id: "letho-of-gulet", count: 1 },
        { id: "menno-coehoorn", count: 1 },
        { id: "morvran-voorhis", count: 1 },
        { id: "tibor-eggebracht", count: 1 },
        { id: "commander-s-horn", count: 2 },
        { id: "torrential-rain", count: 1 },
        { id: "decoy", count: 1 },
        { id: "scorch", count: 1 },
        { id: "biting-frost", count: 1 },
      ],
    },
    {
      id: "ng-white-flame",
      nameZh: "白色火焰",
      nameEn: "The White Flame",
      descZh: "以白色火焰压制对手领袖，间谍与医师维持手牌优势，远程行号角收割。",
      leaderId: "emhyr-var-emreis-the-white-flame",
      cards: [
        { id: "impera-brigade-guard", count: 4 },
        { id: "nausicaa-cavalry-rider", count: 3 },
        { id: "young-emissary", count: 2 },
        { id: "black-infantry-archer", count: 2 },
        { id: "etolian-auxiliary-archers", count: 2 },
        { id: "siege-technician", count: 1 },
        { id: "shilard-fitz-oesterlen", count: 1 },
        { id: "vattier-de-rideaux", count: 1 },
        { id: "stefan-skellen", count: 1 },
        { id: "cahir-mawr-dyffryn-aep-ceallach", count: 1 },
        { id: "rainfarn", count: 1 },
        { id: "vanhemar", count: 1 },
        { id: "letho-of-gulet", count: 1 },
        { id: "menno-coehoorn", count: 1 },
        { id: "morvran-voorhis", count: 1 },
        { id: "tibor-eggebracht", count: 1 },
        { id: "commander-s-horn", count: 2 },
        { id: "impenetrable-fog", count: 1 },
        { id: "clear-weather", count: 1 },
        { id: "decoy", count: 1 },
        { id: "scorch", count: 1 },
      ],
    },
  ],

  monsters: [
    {
      id: "mo-wild-hunt",
      nameZh: "狂猎军团",
      nameEn: "The Wild Hunt",
      descZh: "蟹蜘蛛、食尸鬼与孽鬼的集结浪潮，配合三女巫与吸血鬼快速铺场。",
      leaderId: "eredin-king-of-the-wild-hunt",
      cards: [
        { id: "arachas", count: 3 },
        { id: "arachas-behemoth", count: 1 },
        { id: "ghoul", count: 3 },
        { id: "nekker", count: 3 },
        { id: "vampire-bruxa", count: 1 },
        { id: "vampire-ekimmara", count: 1 },
        { id: "vampire-fleder", count: 1 },
        { id: "vampire-garkain", count: 1 },
        { id: "vampire-katakan", count: 1 },
        { id: "crone-brewess", count: 1 },
        { id: "crone-weavess", count: 1 },
        { id: "crone-whispess", count: 1 },
        { id: "earth-elemental", count: 1 },
        { id: "fire-elemental", count: 1 },
        { id: "draug", count: 1 },
        { id: "imlerith", count: 1 },
        { id: "kayran", count: 1 },
        { id: "leshen", count: 1 },
        { id: "biting-frost", count: 1 },
        { id: "impenetrable-fog", count: 1 },
        { id: "torrential-rain", count: 1 },
        { id: "commander-s-horn", count: 1 },
        { id: "scorch", count: 1 },
      ],
    },
    {
      id: "mo-swamp",
      nameZh: "沼泽妖灵",
      nameEn: "Swamp Spawn",
      descZh: "蟾蜍与妖灵的点杀体系，靠医师回收与复仇者坎比打消耗战。",
      leaderId: "eredin-bringer-of-death",
      cards: [
        { id: "arachas", count: 2 },
        { id: "arachas-behemoth", count: 1 },
        { id: "ghoul", count: 2 },
        { id: "nekker", count: 2 },
        { id: "toad", count: 1 },
        { id: "grave-hag", count: 1 },
        { id: "plague-maiden", count: 1 },
        { id: "botchling", count: 1 },
        { id: "werewolf", count: 1 },
        { id: "foglet", count: 1 },
        { id: "ice-giant", count: 1 },
        { id: "wyvern", count: 1 },
        { id: "frightener", count: 1 },
        { id: "harpy", count: 1 },
        { id: "endrega", count: 1 },
        { id: "griffin", count: 1 },
        { id: "forktail", count: 1 },
        { id: "draug", count: 1 },
        { id: "imlerith", count: 1 },
        { id: "kayran", count: 1 },
        { id: "leshen", count: 1 },
        { id: "torrential-rain", count: 1 },
        { id: "impenetrable-fog", count: 1 },
        { id: "commander-s-horn", count: 1 },
        { id: "decoy", count: 1 },
        { id: "scorch", count: 1 },
      ],
    },
  ],

  scoiatael: [
    {
      id: "st-aen-seidhe",
      nameZh: "艾恩·希迪",
      nameEn: "Aen Seidhe",
      descZh: "满编灵巧单位，靠「艾恩·希迪的希望」在近战/远程行之间调度，玛哈坎守卫以量取胜。",
      leaderId: "francesca-findabair-hope-of-the-aen-seidhe",
      cards: [
        { id: "dol-blathanna-scout", count: 3 },
        { id: "vrihedd-brigade-veteran", count: 2 },
        { id: "barclay-els", count: 1 },
        { id: "ciaran-aep-easnillien", count: 1 },
        { id: "filavandrel-aen-fidhail", count: 1 },
        { id: "yaevinn", count: 1 },
        { id: "mahakaman-defender", count: 5 },
        { id: "dwarven-skirmisher", count: 3 },
        { id: "elven-skirmisher", count: 3 },
        { id: "havekar-healer", count: 1 },
        { id: "eithne", count: 1 },
        { id: "iorveth", count: 1 },
        { id: "isengrim-faoiltiarna", count: 1 },
        { id: "saesenthessis", count: 1 },
        { id: "commander-s-horn", count: 2 },
        { id: "decoy", count: 2 },
        { id: "scorch", count: 1 },
        { id: "clear-weather", count: 1 },
      ],
    },
    {
      id: "st-dol-blathanna",
      nameZh: "多尔·布拉萨纳游猎队",
      nameEn: "Dol Blathanna Rangers",
      descZh: "远程行号角配合精灵散兵集结，米尔瓦的士气与哈维卡走私贩的爆发一击制胜。",
      leaderId: "francesca-findabair-the-beautiful",
      cards: [
        { id: "dol-blathanna-scout", count: 3 },
        { id: "dol-blathanna-archer", count: 1 },
        { id: "elven-skirmisher", count: 3 },
        { id: "vrihedd-brigade-veteran", count: 2 },
        { id: "vrihedd-brigade-recruit", count: 1 },
        { id: "havekar-healer", count: 2 },
        { id: "havekar-smuggler", count: 3 },
        { id: "mahakaman-defender", count: 4 },
        { id: "milva", count: 1 },
        { id: "ida-emean-aep-sivney", count: 1 },
        { id: "eithne", count: 1 },
        { id: "iorveth", count: 1 },
        { id: "isengrim-faoiltiarna", count: 1 },
        { id: "saesenthessis", count: 1 },
        { id: "commander-s-horn", count: 2 },
        { id: "biting-frost", count: 1 },
        { id: "clear-weather", count: 1 },
        { id: "decoy", count: 1 },
        { id: "scorch", count: 1 },
      ],
    },
  ],

  skellige: [
    {
      id: "sk-crach",
      nameZh: "克拉茨的荣耀",
      nameEn: "Glory of Crach",
      descZh: "奎特、德拉蒙与战争长船的三重紧缚，狂战士在曼陀罗中变身成熊。",
      leaderId: "crach-an-craite",
      cards: [
        { id: "clan-an-craite-warrior", count: 3 },
        { id: "clan-drummond-shield-maiden", count: 3 },
        { id: "war-longship", count: 3 },
        { id: "light-longship", count: 3 },
        { id: "clan-brokvar-archer", count: 2 },
        { id: "young-berserker", count: 3 },
        { id: "berserker", count: 1 },
        { id: "clan-heymaey-skald", count: 1 },
        { id: "clan-tordarroch-armorsmith", count: 1 },
        { id: "draig-bon-dhu", count: 1 },
        { id: "birna-bran", count: 1 },
        { id: "olaf", count: 1 },
        { id: "cerys", count: 1 },
        { id: "ermion", count: 1 },
        { id: "hjalmar", count: 1 },
        { id: "mardroeme", count: 2 },
        { id: "commander-s-horn", count: 1 },
        { id: "decoy", count: 1 },
        { id: "scorch", count: 1 },
      ],
    },
    {
      id: "sk-storm",
      nameZh: "风暴群岛之怒",
      nameEn: "Wrath of the Isles",
      descZh: "布兰王无惧恶劣天气，坎比化身海姆达尔，长船与盾女在风暴中绞杀对手。",
      leaderId: "king-bran",
      cards: [
        { id: "clan-an-craite-warrior", count: 3 },
        { id: "clan-drummond-shield-maiden", count: 3 },
        { id: "war-longship", count: 3 },
        { id: "clan-brokvar-archer", count: 3 },
        { id: "light-longship", count: 3 },
        { id: "young-berserker", count: 3 },
        { id: "clan-dimun-pirate", count: 1 },
        { id: "kambi", count: 1 },
        { id: "blueboy-lugos", count: 1 },
        { id: "madman-lugos", count: 1 },
        { id: "holger-blackhand", count: 1 },
        { id: "cerys", count: 1 },
        { id: "ermion", count: 1 },
        { id: "hjalmar", count: 1 },
        { id: "mardroeme", count: 2 },
        { id: "skellige-storm", count: 1 },
        { id: "biting-frost", count: 1 },
        { id: "decoy", count: 1 },
        { id: "scorch", count: 1 },
      ],
    },
  ],
};

/** 按份数展开预设牌组 → 引擎可直接使用的卡牌 id 数组 */
export function expandPreset(preset) {
  if (!preset || !Array.isArray(preset.cards)) return [];
  const ids = [];
  for (const entry of preset.cards) {
    const count = entry.count | 0;
    for (let i = 0; i < count; i++) ids.push(entry.id);
  }
  return ids;
}

/** 某阵营的全部预设（不存在时返回 []） */
export function getPresets(factionId) {
  return PRESET_DECKS[factionId] ? PRESET_DECKS[factionId].slice() : [];
}

/** 某阵营的默认预设 */
export function getDefaultPreset(factionId) {
  const list = PRESET_DECKS[factionId];
  return list && list.length ? list[0] : null;
}

/** 按 preset id 查找（跨阵营） */
export function getPresetById(presetId) {
  for (const factionId of FACTION_IDS) {
    const hit = (PRESET_DECKS[factionId] || []).find((p) => p.id === presetId);
    if (hit) return { ...hit, faction: factionId };
  }
  return null;
}

/** 全部预设的扁平列表（含 faction 字段），供菜单/快速游戏使用 */
export const ALL_PRESETS = FACTION_IDS.flatMap((factionId) =>
  (PRESET_DECKS[factionId] || []).map((preset) => ({ ...preset, faction: factionId }))
);

export default PRESET_DECKS;
