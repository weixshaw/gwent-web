/**
 * tests/card-data.test.mjs — 数据层完整性测试（node --test）
 *
 * 运行：node --test tests/card-data.test.mjs
 *
 * 覆盖：
 *  1. 数量精确（163 卡 / 22 领袖 / 各阵营分布）
 *  2. id 唯一、合法，且与 research/reference/*.final.json 逐字段一致
 *  3. 必填字段与类型完整
 *  4. 结构化 abilities 合法（每种能力的形状约束）
 *  5. copies / deckable / hero 约束、4 张衍生物
 *  6. 中文本地化质量 & abilityZh 与结构化 abilities 一致
 *  7. art 提示合法且 seed 稳定
 *  8. factions / leaders / ability-text 完整
 *  9. db 索引与 collectionFor 行为
 * 10. validateDeck 对全部预设通过、对非法牌组拒绝
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { CARDS, CARD_LIST } from "../src/data/cards.js";
import { LEADERS, LEADER_LIST } from "../src/data/leaders.js";
import { FACTIONS, FACTION_IDS, ALL_FACTION_IDS } from "../src/data/factions.js";
import { ALL_PRESETS, PRESET_DECKS, expandPreset, getDefaultPreset } from "../src/data/decks.js";
import {
  ABILITY_TEXT,
  ABILITY_IDS,
  GROUP_LABELS,
  ROW_NAMES,
  TOKEN_LABELS,
  WEATHER_NAMES,
  abilityIcon,
  abilityNameZh,
  formatAbilitiesEn,
  formatAbilitiesZh,
} from "../src/data/ability-text.js";
import {
  CARDS_BY_FACTION,
  DECKABLE_CARDS,
  DECK_RULES,
  TOTAL_CARDS,
  TOTAL_LEADERS,
  cardCountByFaction,
  collectionFor,
  getCard,
  getFaction,
  getLeader,
  leaderCountByFaction,
  validateDeck,
} from "../src/data/db.js";

/* ------------------------------------------------------------------ */
/* 参考数据（只读；用于逐字段比对）                                    */
/* ------------------------------------------------------------------ */

const REF_DIR = new URL("../research/reference/", import.meta.url);
const refCards = JSON.parse(fs.readFileSync(new URL("cards.final.json", REF_DIR), "utf8"));
const refLeaders = JSON.parse(fs.readFileSync(new URL("leaders.final.json", REF_DIR), "utf8"));
const refFactions = JSON.parse(fs.readFileSync(new URL("factions.final.json", REF_DIR), "utf8"));

const CARD_TYPES = new Set(["unit", "special", "weather"]);
const ROWS = new Set(["close", "ranged", "siege"]);
const FACTION_KEYS = new Set(["northern-realms", "nilfgaard", "scoiatael", "monsters", "skellige", "neutral"]);
const MOTIFS = new Set([
  "monster", "beast", "warrior", "mage", "elf", "dwarf", "vampire", "witch",
  "spirit", "hero", "siege", "spell", "weather", "leader", "token",
]);
const WEATHERS = new Set(["frost", "fog", "rain", "storm", "clear"]);
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

function hasCJK(s) {
  return typeof s === "string" && CJK.test(s);
}

/**
 * nameEn 订正表（数据层有意偏离 reference 的唯一字段）。
 * research 参考数据生成时对这两族卡名的冒号有损；游戏内/ wiki 实际为
 * "Crone: Brewess"、"Gaunter O'Dimm: Darkness"，且规则 §3.3 的 Muster
 * 同组判定依赖 group + ":" 前缀。id 与全部结构化字段仍与参考数据完全一致。
 */
const NAME_EN_FIXES = {
  "crone-brewess": "Crone: Brewess",
  "crone-weavess": "Crone: Weavess",
  "crone-whispess": "Crone: Whispess",
  "gaunter-o-dimm-darkness": "Gaunter O'Dimm: Darkness",
};

/** 与 cards.js 生成脚本一致的稳定哈希（校验 seed 未被手改） */
function hashSeed(id) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 99991;
}

/* ------------------------------------------------------------------ */
/* 1. 数量                                                            */
/* ------------------------------------------------------------------ */

test("1. 卡牌/领袖数量与阵营分布精确", () => {
  assert.equal(refCards.length, 163, "参考数据应有 163 张卡");
  assert.equal(refLeaders.length, 22, "参考数据应有 22 张领袖");

  assert.equal(CARD_LIST.length, 163);
  assert.equal(Object.keys(CARDS).length, 163);
  assert.equal(TOTAL_CARDS, 163);

  assert.equal(LEADER_LIST.length, 22);
  assert.equal(Object.keys(LEADERS).length, 22);
  assert.equal(TOTAL_LEADERS, 22);

  const expectedCards = {
    "northern-realms": 25,
    nilfgaard: 29,
    scoiatael: 23,
    monsters: 35,
    skellige: 27,
    neutral: 24,
  };
  assert.deepEqual(cardCountByFaction(), expectedCards);

  // 中立里含 5 张天气牌 + 19 张非天气牌
  const neutral = CARD_LIST.filter((c) => c.faction === "neutral");
  assert.equal(neutral.filter((c) => c.type === "weather").length, 5);
  assert.equal(neutral.filter((c) => c.type !== "weather").length, 19);

  const expectedLeaders = {
    "northern-realms": 5,
    nilfgaard: 5,
    scoiatael: 5,
    monsters: 5,
    skellige: 2,
  };
  assert.deepEqual(leaderCountByFaction(), expectedLeaders);

  // 类型分布：154 单位 + 4 特殊 + 5 天气
  const byType = { unit: 0, special: 0, weather: 0 };
  for (const c of CARD_LIST) byType[c.type] += 1;
  assert.deepEqual(byType, { unit: 154, special: 4, weather: 5 });
});

/* ------------------------------------------------------------------ */
/* 2. id 与参考数据逐字段一致                                          */
/* ------------------------------------------------------------------ */

test("2a. id 唯一、合法 kebab-case，且与参考数据集合完全一致", () => {
  const ids = CARD_LIST.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "卡牌 id 必须唯一");
  assert.equal(new Set(LEADER_LIST.map((l) => l.id)).size, 22, "领袖 id 必须唯一");

  const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  for (const id of ids) assert.match(id, kebab, `非法卡牌 id: ${id}`);
  for (const l of LEADER_LIST) assert.match(l.id, kebab, `非法领袖 id: ${l.id}`);

  const refIds = new Set(refCards.map((c) => c.id));
  assert.equal(ids.length, refIds.size);
  for (const id of refIds) assert.ok(CARDS[id], `缺少参考卡牌: ${id}`);
  for (const id of ids) assert.ok(refIds.has(id), `多出参考数据中没有的卡牌: ${id}`);

  const refLeaderIds = new Set(refLeaders.map((l) => l.id));
  for (const id of refLeaderIds) assert.ok(LEADERS[id], `缺少参考领袖: ${id}`);
  for (const l of LEADER_LIST) assert.ok(refLeaderIds.has(l.id), `多出参考数据中没有的领袖: ${l.id}`);
});

test("2b. 每张卡的结构化字段与参考数据逐字段一致", () => {
  for (const ref of refCards) {
    const card = CARDS[ref.id];
    assert.ok(card, `缺少卡牌 ${ref.id}`);
    assert.equal(card.id, ref.id);
    const expectedNameEn = NAME_EN_FIXES[ref.id] || ref.nameEn;
    assert.equal(card.nameEn, expectedNameEn, `${ref.id}.nameEn`);
    assert.equal(card.faction, ref.faction, `${ref.id}.faction`);
    assert.equal(card.type, ref.type, `${ref.id}.type`);
    assert.equal(card.hero, ref.hero, `${ref.id}.hero`);
    assert.deepEqual(card.rows, ref.rows, `${ref.id}.rows`);
    assert.equal(card.strength, ref.strength, `${ref.id}.strength`);
    assert.equal(card.copies, ref.copies, `${ref.id}.copies`);
    assert.equal(card.deckable, ref.deckable, `${ref.id}.deckable`);
    assert.deepEqual(card.abilities, ref.abilities, `${ref.id}.abilities`);
    assert.equal(card.dlc, ref.dlc, `${ref.id}.dlc`);
    assert.equal(card.flavorEn, ref.quoteEn, `${ref.id}.flavorEn 应保留原始英文引语`);
  }
});

test("2c. 每张领袖的阵营与能力结构与参考数据一致", () => {
  for (const ref of refLeaders) {
    const leader = LEADERS[ref.id];
    assert.ok(leader, `缺少领袖 ${ref.id}`);
    assert.equal(leader.id, ref.id);
    assert.equal(leader.nameEn, ref.nameEn);
    assert.equal(leader.faction, ref.faction);
    assert.deepEqual(leader.ability, ref.ability, `${ref.id}.ability`);
    assert.equal(leader.abilityEn, ref.abilityTextEn, `${ref.id}.abilityEn 应保留原始英文`);
    assert.equal(leader.quoteEn, ref.quoteEn);
    assert.equal(leader.dlc, ref.dlc);
  }
});

test("2d. Muster 同组按规则 §3.3 的精确写法都能解析到卡（家族 combo 不落空）", () => {
  // 仅 4 张卡订正了 nameEn（补回游戏内真实冒号），其余卡 nameEn 与参考一致
  for (const [id, fixed] of Object.entries(NAME_EN_FIXES)) {
    assert.equal(CARDS[id].nameEn, fixed, `${id}: nameEn 订正`);
    assert.ok(fixed.includes(":"), `${id}: 订正后的 nameEn 必须含冒号`);
  }

  const deckable = CARD_LIST.filter((c) => c.deckable && c.copies > 0);
  const groups = new Map();
  for (const card of CARD_LIST) {
    for (const a of card.abilities) {
      if (a.id !== "muster") continue;
      if (!groups.has(a.group)) groups.set(a.group, []);
      groups.get(a.group).push(card.id);
    }
  }
  for (const [group, sources] of groups) {
    // 规则 §3.3：同组 = 牌名完全等于 group，或以 group + ":" 开头
    const matched = deckable.filter((c) => c.nameEn === group || c.nameEn.startsWith(`${group}:`));
    assert.ok(matched.length >= 1, `muster group「${group}」按 §3.3 精确规则解析到 0 张卡（来源：${sources.join(", ")}）`);
    if (group === "Arachas") {
      assert.ok(!matched.some((c) => c.id === "arachas-behemoth"), "Arachas 组不得包含 Arachas Behemoth");
    }
  }
  // 三老妪与冈特黑暗的具体回归断言
  assert.deepEqual(
    deckable.filter((c) => c.nameEn.startsWith("Crone:")).map((c) => c.id).sort(),
    ["crone-brewess", "crone-weavess", "crone-whispess"]
  );
  assert.ok(deckable.some((c) => c.nameEn === "Gaunter O'Dimm: Darkness"));
});

/* ------------------------------------------------------------------ */
/* 3. 必填字段完整                                                    */
/* ------------------------------------------------------------------ */

test("3a. 卡牌必填字段与类型完整", () => {
  for (const card of CARD_LIST) {
    const at = card.id;
    assert.equal(typeof card.id, "string", at);
    assert.ok(hasCJK(card.nameZh), `${at}: nameZh 必须为中文`);
    assert.ok(card.nameEn.length > 0, `${at}: nameEn`);
    assert.ok(FACTION_KEYS.has(card.faction), `${at}: 非法 faction ${card.faction}`);
    assert.ok(CARD_TYPES.has(card.type), `${at}: 非法 type ${card.type}`);
    assert.equal(typeof card.hero, "boolean", `${at}: hero`);
    assert.ok(Array.isArray(card.rows), `${at}: rows 必须是数组`);
    for (const row of card.rows) assert.ok(ROWS.has(row), `${at}: 非法行 ${row}`);
    if (card.type === "unit") {
      assert.equal(typeof card.strength, "number", `${at}: 单位牌 strength 必须是数字`);
      assert.ok(card.strength >= 0, `${at}: strength 不能为负`);
      assert.ok(card.rows.length >= 1, `${at}: 单位牌至少有一行`);
    } else {
      assert.equal(card.strength, null, `${at}: 非单位牌 strength 必须为 null`);
      assert.equal(card.rows.length, 0, `${at}: 非单位牌 rows 必须为空`);
    }
    assert.ok(Number.isInteger(card.copies) && card.copies >= 0, `${at}: copies`);
    assert.equal(typeof card.deckable, "boolean", `${at}: deckable`);
    assert.ok(Array.isArray(card.abilities), `${at}: abilities 必须是数组`);
    assert.equal(typeof card.abilityZh, "string", `${at}: abilityZh`);
    assert.equal(typeof card.abilityEn, "string", `${at}: abilityEn`);
    assert.ok(hasCJK(card.flavorZh) && card.flavorZh.length >= 4, `${at}: flavorZh`);
    assert.equal(typeof card.flavorEn, "string", `${at}: flavorEn`);
    assert.equal(typeof card.dlc, "string", `${at}: dlc`);
  }
});

test("3b. 卡牌中文名不重复（避免复制粘贴错位）", () => {
  const names = CARD_LIST.map((c) => c.nameZh);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dup, [], `重复中文名: ${dup.join(", ")}`);

  const leaderNames = LEADER_LIST.map((l) => l.nameZh);
  assert.equal(new Set(leaderNames).size, leaderNames.length, "领袖中文名必须唯一");
});

test("3c. 领袖必填字段完整", () => {
  for (const l of LEADER_LIST) {
    const at = l.id;
    assert.ok(hasCJK(l.nameZh), `${at}: nameZh 必须为中文`);
    assert.ok(l.nameEn.length > 0, at);
    assert.ok(FACTION_IDS.includes(l.faction), `${at}: 领袖必须属于可玩阵营`);
    assert.ok(Array.isArray(l.ability) && l.ability.length > 0, `${at}: ability`);
    assert.ok(l.abilityZh.length > 0 && hasCJK(l.abilityZh), `${at}: abilityZh`);
    assert.ok(l.abilityEn.length > 0, `${at}: abilityEn`);
    assert.ok(l.quoteZh.length > 0 && hasCJK(l.quoteZh), `${at}: quoteZh`);
    assert.ok(l.quoteEn.length > 0, `${at}: quoteEn`);
    assert.equal(l.art.motif, "leader", `${at}: art.motif`);
    assert.equal(l.art.palette, l.faction, `${at}: art.palette`);
    assert.ok(l.art.seed === hashSeed(l.id), `${at}: art.seed 必须由 id 稳定哈希而来`);
  }
});

/* ------------------------------------------------------------------ */
/* 4. 结构化 abilities 合法                                           */
/* ------------------------------------------------------------------ */

test("4a. 所有能力 id 均在 ability-text 中登记且形状合法", () => {
  const abilityIds = new Set();
  for (const card of CARD_LIST) {
    for (const a of card.abilities) {
      abilityIds.add(a.id);
      assert.equal(typeof a.id, "string", `${card.id}: ability.id`);
      assert.ok(ABILITY_IDS.includes(a.id), `${card.id}: 未登记的能力 id "${a.id}"`);

      switch (a.id) {
        case "muster":
          assert.equal(typeof a.group, "string", `${card.id}: muster.group`);
          assert.ok(Array.isArray(a.from) && a.from.length > 0, `${card.id}: muster.from`);
          for (const src of a.from) assert.ok(["deck", "hand"].includes(src), `${card.id}: muster.from=${src}`);
          if (a.group !== "Roach" && a.group !== "Clan Drummond Shield Maiden") {
            assert.ok(GROUP_LABELS[a.group], `${card.id}: muster.group "${a.group}" 缺少中文标签`);
          }
          break;
        case "scorch":
          assert.ok(["any", "row"].includes(a.mode), `${card.id}: scorch.mode`);
          if (a.mode === "row") {
            assert.ok(ROWS.has(a.row), `${card.id}: scorch.row`);
            assert.equal(a.requireEnemyRowTotalAtLeast, 10, `${card.id}: scorch 阈值应为 10`);
          }
          break;
        case "avenger":
          assert.ok(TOKEN_LABELS[a.token], `${card.id}: avenger token 未登记`);
          assert.ok(CARDS[a.token], `${card.id}: avenger token 不存在`);
          assert.equal(CARDS[a.token].deckable, false, `${card.id}: avenger token 必须是不可收藏衍生物`);
          break;
        case "berserker":
          assert.ok(TOKEN_LABELS[a.transformTo], `${card.id}: berserker transformTo 未登记`);
          assert.ok(CARDS[a.transformTo], `${card.id}: berserker transformTo 不存在`);
          assert.equal(CARDS[a.transformTo].deckable, false, `${card.id}: 变身牌必须是衍生物`);
          break;
        case "weather":
          assert.ok(WEATHERS.has(a.weather), `${card.id}: 非法天气 ${a.weather}`);
          assert.equal(card.type, "weather", `${card.id}: 带天气能力的必须是 weather 牌`);
          break;
        case "spy":
          assert.equal(a.draw, 2, `${card.id}: 间谍应抽 2 张`);
          break;
        case "hero":
          assert.equal(card.hero, true, `${card.id}: 拥有 hero 能力的卡必须标记 hero`);
          break;
        case "bond":
        case "morale":
        case "agile":
        case "medic":
        case "horn":
        case "mardroeme":
        case "decoy":
          break;
        default:
          // 领袖能力不应出现在卡牌上
          assert.fail(`${card.id}: 卡牌不应携带领袖能力 "${a.id}"`);
      }
    }
  }

  // 反向：hero 标记的卡必须有 hero 能力
  for (const card of CARD_LIST) {
    if (card.hero) {
      assert.ok(card.abilities.some((a) => a.id === "hero"), `${card.id}: hero 卡缺少 hero 能力`);
    }
  }

  // 领袖能力形状
  for (const l of LEADER_LIST) {
    for (const a of l.ability) {
      abilityIds.add(a.id);
      assert.ok(ABILITY_IDS.includes(a.id), `${l.id}: 未登记的领袖能力 "${a.id}"`);
      if (a.id === "playWeatherFromDeck") {
        assert.ok(a.weather === "any" || WEATHERS.has(a.weather), `${l.id}: 非法天气`);
      }
      if (a.id === "leaderHorn" || a.id === "scorchRow") {
        assert.ok(ROWS.has(a.row), `${l.id}: 非法行`);
      }
    }
  }

  // ability-text 登记的能力集合应与数据实际用到的集合完全一致
  assert.deepEqual([...abilityIds].sort(), [...ABILITY_IDS].sort(), "ability-text 与数据能力集合不一致");
});

test("4b. 每种能力用到时都能渲染出中英文案", () => {
  for (const card of CARD_LIST) {
    const ctx = { cardType: card.type };
    for (const a of card.abilities) {
      assert.ok(formatAbilitiesZh([a], ctx).length > 0, `${card.id}: ${a.id} 中文渲染为空`);
      assert.ok(formatAbilitiesEn([a], ctx).length > 0, `${card.id}: ${a.id} 英文渲染为空`);
    }
  }
  for (const l of LEADER_LIST) {
    for (const a of l.ability) {
      assert.ok(formatAbilitiesZh([a], { cardType: "leader" }).length > 0, `${l.id}: ${a.id} 中文渲染为空`);
      assert.ok(formatAbilitiesEn([a], { cardType: "leader" }).length > 0, `${l.id}: ${a.id} 英文渲染为空`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 5. copies / deckable / hero / 衍生物                               */
/* ------------------------------------------------------------------ */

test("5a. copies 与 deckable 约束合理", () => {
  for (const card of CARD_LIST) {
    const at = card.id;
    assert.ok(card.copies >= 0 && card.copies <= 5, `${at}: copies 应在 0~5`);
    if (card.deckable) {
      assert.ok(card.copies >= 1, `${at}: 可收藏卡 copies 必须 ≥ 1`);
    } else {
      assert.equal(card.copies, 0, `${at}: 不可收藏衍生物 copies 必须为 0`);
    }
    if (card.hero && card.deckable) assert.equal(card.copies, 1, `${at}: 英雄只能有 1 份`);
    if (card.type === "weather") assert.ok(card.copies >= 1 && card.copies <= 3, `${at}: 天气牌份数`);
  }
  assert.equal(DECKABLE_CARDS.length, 159, "可收藏卡应为 159 张（163 - 4 衍生物）");
});

test("5b. 4 张召唤衍生物齐全且不可入组", () => {
  const tokens = ["bovine-defense-force", "hemdall", "transformed-vildkaarl", "transformed-young-vildkaarl"];
  for (const id of tokens) {
    const card = CARDS[id];
    assert.ok(card, `缺少衍生物 ${id}`);
    assert.equal(card.copies, 0, `${id}: copies`);
    assert.equal(card.deckable, false, `${id}: deckable`);
    assert.equal(card.hero, id === "hemdall", `${id}: hero 标记应与参考一致`);
  }
  const refTokens = refCards.filter((c) => !c.deckable).map((c) => c.id).sort();
  assert.deepEqual(refTokens, [...tokens].sort());
});

/* ------------------------------------------------------------------ */
/* 6. 中文本地化质量 & abilityZh 一致性                               */
/* ------------------------------------------------------------------ */

test("6a. abilityZh / abilityEn 与结构化 abilities 完全一致", () => {
  for (const card of CARD_LIST) {
    const ctx = { cardType: card.type };
    assert.equal(card.abilityZh, formatAbilitiesZh(card.abilities, ctx), `${card.id}: abilityZh 与 abilities 不一致`);
    assert.equal(card.abilityEn, formatAbilitiesEn(card.abilities, ctx), `${card.id}: abilityEn 与 abilities 不一致`);
    if (card.abilities.length === 0) {
      assert.equal(card.abilityZh, "", `${card.id}: 无能力时 abilityZh 应为空`);
      assert.equal(card.abilityEn, "", `${card.id}: 无能力时 abilityEn 应为空`);
    } else {
      for (const a of card.abilities) {
        assert.ok(card.abilityZh.includes(abilityNameZh(a.id)), `${card.id}: abilityZh 缺少「${abilityNameZh(a.id)}」`);
        assert.ok(card.abilityZh.includes("："), `${card.id}: abilityZh 应使用「名词：说明」格式`);
      }
    }
  }
});

test("6b. 领袖 abilityZh 与结构化能力一致，中文引语齐全", () => {
  for (const l of LEADER_LIST) {
    assert.equal(l.abilityZh, formatAbilitiesZh(l.ability, { cardType: "leader" }), `${l.id}: abilityZh 不一致`);
    assert.ok(l.quoteZh.length >= 6, `${l.id}: quoteZh 过短`);
  }
});

test("6c. 中文名/风味文案无明显空值或英文残留", () => {
  for (const card of CARD_LIST) {
    assert.ok(card.nameZh.length >= 1 && card.nameZh.length <= 24, `${card.id}: nameZh 长度异常`);
    assert.ok(hasCJK(card.nameZh), `${card.id}: nameZh 非中文`);
    assert.ok(hasCJK(card.flavorZh), `${card.id}: flavorZh 非中文`);
    assert.ok(card.flavorZh.length <= 120, `${card.id}: flavorZh 过长`);
  }
});

/* ------------------------------------------------------------------ */
/* 7. art 提示                                                        */
/* ------------------------------------------------------------------ */

test("7. art { motif, palette, seed } 合法且 seed 稳定", () => {
  for (const card of CARD_LIST) {
    const { motif, palette, seed } = card.art;
    assert.ok(MOTIFS.has(motif), `${card.id}: 非法 motif "${motif}"`);
    assert.equal(palette, card.faction, `${card.id}: palette 应等于 faction`);
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed < 99991, `${card.id}: 非法 seed`);
    assert.equal(seed, hashSeed(card.id), `${card.id}: seed 必须由 id 稳定哈希而来`);
    if (!card.deckable) assert.equal(motif, "token", `${card.id}: 衍生物 motif 应为 token`);
    else if (card.type === "weather") assert.equal(motif, "weather", `${card.id}: 天气牌 motif`);
    else if (card.type === "special") assert.equal(motif, "spell", `${card.id}: 特殊牌 motif`);
    else if (card.hero) assert.equal(motif, "hero", `${card.id}: 英雄牌 motif`);
  }
});

/* ------------------------------------------------------------------ */
/* 8. factions / ability-text                                        */
/* ------------------------------------------------------------------ */

test("8a. factions 数据完整（5 阵营 + neutral）", () => {
  assert.deepEqual(Object.keys(FACTIONS).sort(), [...ALL_FACTION_IDS].sort());
  assert.equal(FACTION_IDS.length, 5);
  const sigils = new Set(["lion", "sun", "leaf", "claw", "longship", "star"]);
  const refById = Object.fromEntries(refFactions.map((f) => [f.id, f]));

  for (const [id, faction] of Object.entries(FACTIONS)) {
    assert.equal(faction.id, id);
    assert.ok(hasCJK(faction.nameZh), `${id}: nameZh`);
    assert.ok(faction.nameEn.length > 0, `${id}: nameEn`);
    assert.ok(sigils.has(faction.sigil), `${id}: 非法 sigil "${faction.sigil}"`);
    for (const key of ["primary", "accent", "glow"]) {
      assert.match(faction.colors[key], /^#[0-9a-f]{6}$/i, `${id}.colors.${key}`);
    }
    assert.ok(faction.ability && typeof faction.ability.id === "string", `${id}: ability.id`);
    assert.ok(hasCJK(faction.abilityZh), `${id}: abilityZh`);
    assert.ok(faction.abilityEn.length > 0, `${id}: abilityEn`);
    assert.ok(hasCJK(faction.loreZh), `${id}: loreZh`);
  }
  // 5 大阵营能力与参考数据一致
  for (const ref of refFactions) {
    assert.equal(FACTIONS[ref.id].abilityEn, ref.abilityEn, `${ref.id}: abilityEn 应与参考一致`);
    assert.deepEqual(FACTIONS[ref.id].ability, ref.ability, `${ref.id}: ability 应与参考一致`);
    assert.equal(FACTIONS[ref.id].colors.primary, ref.palette.primary, `${ref.id}: primary 色`);
    assert.equal(FACTIONS[ref.id].colors.accent, ref.palette.accent, `${ref.id}: accent 色`);
  }
});

test("8b. ability-text 每项都有中文名/说明/图标与英文", () => {
  for (const [id, text] of Object.entries(ABILITY_TEXT)) {
    assert.ok(text.nameZh.length > 0 && hasCJK(text.nameZh), `${id}: nameZh`);
    assert.ok(text.nameEn.length > 0, `${id}: nameEn`);
    assert.ok(text.zh.length > 0 && hasCJK(text.zh), `${id}: zh`);
    assert.ok(text.en.length > 0, `${id}: en`);
    assert.equal(typeof text.icon, "string");
    assert.ok(text.icon.length > 0, `${id}: icon`);
    assert.equal(abilityNameZh(id), text.nameZh);
    assert.equal(abilityIcon(id), text.icon);
  }
  assert.ok(ABILITY_IDS.length >= 20);
  for (const row of Object.keys(ROW_NAMES)) {
    assert.ok(hasCJK(ROW_NAMES[row].zh) && ROW_NAMES[row].en.length > 0, `ROW_NAMES.${row}`);
  }
  for (const [key, w] of Object.entries(WEATHER_NAMES)) {
    assert.ok(WEATHERS.has(key), `WEATHER_NAMES.${key}`);
    assert.ok(hasCJK(w.zh) && w.en.length > 0, `WEATHER_NAMES.${key}`);
  }
  // 数据中用到的 muster group 都有中文标签
  const groups = new Set();
  for (const card of CARD_LIST) for (const a of card.abilities) if (a.id === "muster") groups.add(a.group);
  for (const g of groups) {
    if (g === "Roach" || g === "Clan Drummond Shield Maiden") continue;
    assert.ok(GROUP_LABELS[g], `muster.group "${g}" 缺少中文标签`);
  }
});

/* ------------------------------------------------------------------ */
/* 9. db 索引                                                         */
/* ------------------------------------------------------------------ */

test("9a. getCard / getLeader / getFaction 查询", () => {
  assert.equal(getCard("geralt-of-rivia").nameZh, "利维亚的杰洛特");
  assert.equal(getCard("not-a-card"), null);
  assert.equal(getLeader("king-bran").faction, "skellige");
  assert.equal(getLeader("nope"), null);
  assert.equal(getFaction("neutral").nameZh, "中立");
  assert.equal(getFaction("atlantis"), null);
});

test("9b. CARDS_BY_FACTION 与 collectionFor 正确", () => {
  let sum = 0;
  for (const factionId of ALL_FACTION_IDS) {
    const ids = CARDS_BY_FACTION[factionId];
    assert.ok(Array.isArray(ids) && ids.length > 0, `${factionId}: 卡表为空`);
    sum += ids.length;
    assert.equal(new Set(ids).size, ids.length, `${factionId}: 卡表有重复`);
    for (const id of ids) assert.equal(CARDS[id].faction, factionId, `${factionId}: ${id} 阵营不符`);
  }
  assert.equal(sum, 163, "CARDS_BY_FACTION 应覆盖全部 163 张卡");

  for (const factionId of FACTION_IDS) {
    const collection = collectionFor(factionId);
    assert.ok(collection.length > 0, `${factionId}: collection 为空`);
    for (const card of collection) {
      assert.ok(card.faction === factionId || card.faction === "neutral", `${factionId}: 混入其他阵营卡 ${card.id}`);
      assert.equal(card.deckable, true, `${factionId}: collection 不应含衍生物 ${card.id}`);
      assert.ok(card.copies > 0, `${factionId}: collection 不应含 copies=0 的 ${card.id}`);
    }
    // 每个阵营至少能构筑出 22 张单位牌（份数合计）
    const unitCopies = collection
      .filter((c) => c.type === "unit")
      .reduce((n, c) => n + c.copies, 0);
    assert.ok(unitCopies >= DECK_RULES.MIN_UNITS, `${factionId}: 可收集单位份数不足 (${unitCopies})`);
    // 中立牌必须出现在每个阵营的收藏中
    assert.ok(collection.some((c) => c.faction === "neutral"), `${factionId}: 缺少中立卡`);
    // 其他阵营的可收藏卡不得出现
    for (const other of FACTION_IDS.filter((f) => f !== factionId)) {
      assert.ok(!collection.some((c) => c.faction === other), `${factionId}: 混入 ${other} 卡`);
    }
  }
  // neutral 伪阵营的收藏只含中立牌
  const neutralCollection = collectionFor("neutral");
  assert.ok(neutralCollection.every((c) => c.faction === "neutral"));
  assert.deepEqual(collectionFor("atlantis"), []);
});

/* ------------------------------------------------------------------ */
/* 10. validateDeck                                                   */
/* ------------------------------------------------------------------ */

test("10a. 全部预设牌组通过 validateDeck", () => {
  assert.equal(ALL_PRESETS.length, 10, "应有 10 套预设（5 阵营 × 2）");
  for (const factionId of FACTION_IDS) {
    const presets = PRESET_DECKS[factionId];
    assert.ok(Array.isArray(presets) && presets.length >= 1, `${factionId}: 至少 1 套预设`);
    assert.ok(getDefaultPreset(factionId), `${factionId}: 默认预设`);
  }

  const presetIds = new Set();
  for (const preset of ALL_PRESETS) {
    assert.ok(!presetIds.has(preset.id), `预设 id 重复: ${preset.id}`);
    presetIds.add(preset.id);
    assert.ok(hasCJK(preset.nameZh), `${preset.id}: nameZh`);
    assert.ok(Array.isArray(preset.cards) && preset.cards.length > 0, `${preset.id}: cards`);
    assert.equal(getLeader(preset.leaderId).faction, preset.faction, `${preset.id}: 领袖阵营`);
    for (const entry of preset.cards) {
      assert.ok(Number.isInteger(entry.count) && entry.count > 0, `${preset.id}: ${entry.id} count 必须为正整数`);
    }
    const ids = expandPreset(preset);
    const result = validateDeck(ids, preset.leaderId, preset.faction);
    assert.deepEqual(result.errors, [], `${preset.id}: ${result.errors.join(" / ")}`);
    assert.equal(result.ok, true, `${preset.id}: 预设牌组必须合法`);
    assert.ok(result.stats.units >= 22 && result.stats.units <= 26, `${preset.id}: 单位数 ${result.stats.units} 应在 22~26`);
    assert.ok(result.stats.specials >= 0 && result.stats.specials <= 8, `${preset.id}: 特殊牌数 ${result.stats.specials} 应在 0~8`);
    assert.equal(result.stats.total, ids.length);
  }

  // validateDeck 也兼容预设的 [{id,count}] 形式
  for (const preset of ALL_PRESETS) {
    const result = validateDeck(preset.cards, preset.leaderId, preset.faction);
    assert.equal(result.ok, true, `${preset.id}: 应兼容 [{id,count}] 形式`);
    assert.equal(result.stats.total, preset.cards.reduce((n, e) => n + e.count, 0));
  }

  // expandPreset 与 count 展开一致
  const preset = PRESET_DECKS["northern-realms"][0];
  const ids = expandPreset(preset);
  const expected = preset.cards.reduce((n, e) => n + e.count, 0);
  assert.equal(ids.length, expected);
  assert.ok(ids.includes("blue-stripes-commando"));
});

test("10b. validateDeck 拒绝非法牌组（错误信息可读）", () => {
  const factionId = "northern-realms";
  const base = expandPreset(PRESET_DECKS[factionId][0]);
  const leaderId = PRESET_DECKS[factionId][0].leaderId;

  const legal = validateDeck(base, leaderId, factionId);
  assert.equal(legal.ok, true);
  assert.deepEqual(
    Object.keys(legal.stats).sort(),
    ["heroes", "specials", "strength", "total", "units"].sort()
  );
  assert.equal(legal.stats.units + legal.stats.specials, base.length);

  // 未知阵营
  assert.equal(validateDeck(base, leaderId, "atlantis").ok, false);
  // 中立伪阵营不可对战
  assert.equal(validateDeck(base, leaderId, "neutral").ok, false);
  // 缺少领袖 / 未知领袖 / 领袖阵营不符
  assert.equal(validateDeck(base, "", factionId).ok, false);
  assert.equal(validateDeck(base, "nope", factionId).ok, false);
  const wrongLeader = validateDeck(base, "eredin-king-of-the-wild-hunt", factionId);
  assert.equal(wrongLeader.ok, false);
  assert.ok(wrongLeader.errors.some((e) => e.includes("领袖")), "应报领袖阵营错误");

  // 未知卡牌
  const withUnknown = [...base, "not-a-real-card"];
  const unknownRes = validateDeck(withUnknown, leaderId, factionId);
  assert.equal(unknownRes.ok, false);
  assert.ok(unknownRes.errors.some((e) => e.includes("未知卡牌")));

  // 其他阵营卡牌
  const foreignRes = validateDeck([...base, "imlerith"], leaderId, factionId);
  assert.equal(foreignRes.ok, false);
  assert.ok(foreignRes.errors.some((e) => e.includes("其他阵营")), "应报阵营越界错误");

  // 不可收藏衍生物
  const tokenRes = validateDeck([...base, "bovine-defense-force"], leaderId, factionId);
  assert.equal(tokenRes.ok, false);
  assert.ok(tokenRes.errors.some((e) => e.includes("衍生物")), "应报衍生物错误");

  // 超出收藏份数
  const maxBlueStripes = getCard("blue-stripes-commando").copies;
  const tooMany = [...base];
  for (let i = 0; i < maxBlueStripes + 1; i++) tooMany.push("blue-stripes-commando");
  const tooManyRes = validateDeck(tooMany, leaderId, factionId);
  assert.equal(tooManyRes.ok, false);
  assert.ok(tooManyRes.errors.some((e) => e.includes("超出收藏份数")), "应报份数错误");

  // 单位牌不足
  const lowUnits = base.filter((id) => getCard(id).type === "unit").slice(0, 10);
  const lowRes = validateDeck(lowUnits, leaderId, factionId);
  assert.equal(lowRes.ok, false);
  assert.ok(lowRes.errors.some((e) => e.includes("单位牌不足")), "应报单位不足");

  // 特殊牌过多（22 单位 + 11 特殊）
  const units22 = collectionFor(factionId)
    .filter((c) => c.type === "unit")
    .flatMap((c) => Array(c.copies).fill(c.id))
    .slice(0, 22);
  const specials11 = [
    ...Array(3).fill("commander-s-horn"),
    ...Array(3).fill("decoy"),
    ...Array(3).fill("scorch"),
    ...Array(2).fill("clear-weather"),
  ];
  const tooManySpecials = validateDeck([...units22, ...specials11], leaderId, factionId);
  assert.equal(tooManySpecials.ok, false);
  assert.ok(tooManySpecials.errors.some((e) => e.includes("特殊牌过多")), "应报特殊牌过多");

  // 非数组输入
  assert.equal(validateDeck(null, leaderId, factionId).ok, false);
});

test("10c. 预设牌组的强度统计合理（可作 AI 参考）", () => {
  for (const preset of ALL_PRESETS) {
    const ids = expandPreset(preset);
    const result = validateDeck(ids, preset.leaderId, preset.faction);

    const expectedUnits = preset.cards
      .filter((e) => getCard(e.id).type === "unit")
      .reduce((n, e) => n + e.count, 0);
    const expectedSpecials = preset.cards
      .filter((e) => getCard(e.id).type !== "unit")
      .reduce((n, e) => n + e.count, 0);
    const expectedStrength = preset.cards
      .filter((e) => getCard(e.id).type === "unit")
      .reduce((n, e) => n + (getCard(e.id).strength || 0) * e.count, 0);
    const expectedHeroes = preset.cards
      .filter((e) => getCard(e.id).hero)
      .reduce((n, e) => n + e.count, 0);

    assert.equal(result.stats.units, expectedUnits, `${preset.id}: units 统计`);
    assert.equal(result.stats.specials, expectedSpecials, `${preset.id}: specials 统计`);
    assert.equal(result.stats.strength, expectedStrength, `${preset.id}: strength 统计`);
    assert.equal(result.stats.heroes, expectedHeroes, `${preset.id}: heroes 统计`);

    assert.ok(result.stats.strength > 80, `${preset.id}: 基础战力 ${result.stats.strength} 偏低`);
    assert.ok(result.stats.heroes >= 1, `${preset.id}: 应至少含 1 张英雄`);
  }
});
