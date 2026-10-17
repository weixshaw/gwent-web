/**
 * tests/data-audit.test.mjs — QA 独立数据核对（对抗式）
 *
 * 职责：**不信任** src/data 自带测试，直接以 research/reference/*.json 为 oracle，
 * 对 cardsmith 产出的 src/data/** 做独立比对：
 *
 *   1. 参考数据（oracle）自检：163 卡 / 22 领袖 / 5 阵营、token 约束、能力词表
 *   2. 卡牌：id 集合完全一致、无重复 id、kebab-case、163 数量
 *   3. 每张卡：faction / type / hero / rows（含顺序）/ strength / copies / deckable 深比较
 *   4. abilities：按参考结构深比较（忽略中文与 cardsmith 附加字段、不比较数组顺序）
 *   5. 领袖：22 张、阵营、ability 结构深比较
 *   6. 阵营：5 可玩阵营 + neutral，能力 id 一致
 *   7. 预设牌组：**独立计数**校验（单位≥22、特殊≤10、数量≤copies、仅本阵营+中立、
 *      领袖合法且同阵营、无衍生物），并与 validateDeck 交叉验证
 *   8. Muster group 可解析性（防止「打出一张却拉不到任何牌」的死 combo）
 *
 * 运行：node --test tests/data-audit.test.mjs   （或 npm test 全量）
 * 数据未就绪时：全部数据相关用例输出 SKIP 提示并 exit 0。
 *
 * 约束：本文件只读 src/data（不得修改）；发现问题由 QA 发消息给 cardsmith/Lead。
 * 审计报告：docs/QA_RULES_AUDIT.md
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ */
/* 路径与 oracle 读取                                                  */
/* ------------------------------------------------------------------ */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REF_DIR = join(ROOT, "research", "reference");
const DATA_DIR = join(ROOT, "src", "data");

function readRef(name) {
  const file = join(REF_DIR, name);
  assert.ok(existsSync(file), `缺少参考数据文件：${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

const refCards = readRef("cards.final.json");
const refLeaders = readRef("leaders.final.json");
const refFactions = readRef("factions.final.json");

/* ------------------------------------------------------------------ */
/* 动态加载 src/data（缺失时 skip，而不是 fail）                        */
/* ------------------------------------------------------------------ */

async function loadDataModule(fileName) {
  const file = join(DATA_DIR, fileName);
  if (!existsSync(file)) return null;
  try {
    return await import(pathToFileURL(file).href);
  } catch (err) {
    assert.fail(`src/data/${fileName} 存在但无法加载：${err.message}`);
  }
}

const cardsMod = await loadDataModule("cards.js");
const leadersMod = await loadDataModule("leaders.js");
const factionsMod = await loadDataModule("factions.js");
const decksMod = await loadDataModule("decks.js");
const dbMod = await loadDataModule("db.js");

const CARDS = cardsMod?.CARDS ?? null;
const CARD_LIST = cardsMod?.CARD_LIST ?? (CARDS ? Object.values(CARDS) : null);
const LEADERS = leadersMod?.LEADERS ?? null;
const LEADER_LIST = leadersMod?.LEADER_LIST ?? (LEADERS ? Object.values(LEADERS) : null);
const FACTIONS = factionsMod?.FACTIONS ?? null;

const DATA_READY = Boolean(CARDS && CARD_LIST && LEADERS && LEADER_LIST && FACTIONS);
const SKIP_REASON = DATA_READY
  ? false
  : "SKIP：src/data/{cards,leaders,factions}.js 尚未产出（等待 cardsmith）。参考数据已就绪，等待数据后本测试自动启用。";

if (!DATA_READY) {
  console.warn("\n[data-audit] SKIP：等待 cardsmith 产出 src/data/ 后自动启用独立核对。\n");
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FACTION_IDS = ["northern-realms", "nilfgaard", "scoiatael", "monsters", "skellige"];
const CARD_TYPES = new Set(["unit", "special", "weather"]);
const ABILITY_IDS = new Set([
  "hero", "agile", "bond", "spy", "medic", "muster", "morale",
  "horn", "scorch", "avenger", "berserker", "mardroeme", "decoy", "weather",
]);
const TOKEN_IDS = [
  "bovine-defense-force",
  "hemdall",
  "transformed-vildkaarl",
  "transformed-young-vildkaarl",
];

/** 参考卡按 id 索引 */
const refCardById = new Map(refCards.map((c) => [c.id, c]));
const refLeaderById = new Map(refLeaders.map((l) => [l.id, l]));
const refFactionById = new Map(refFactions.map((f) => [f.id, f]));

/** 只保留参考 ability 中出现的键（忽略 cardsmith 附加字段），并按键名排序做深比较 */
function projectAbility(ability, refAbility) {
  const out = {};
  for (const key of Object.keys(refAbility).sort()) out[key] = ability?.[key];
  return JSON.stringify(out);
}

/**
 * abilities 深比较：
 *  - 数量必须一致
 *  - 参考中的每个 ability 都要在 src 中找到一个「参考键全部相等」的 ability（一对一）
 *  - 不比较数组顺序，忽略 src 中的附加字段
 */
function assertAbilitiesMatch(srcAbilities, refAbilities, label) {
  assert.ok(Array.isArray(srcAbilities), `${label}.abilities 应为数组`);
  assert.equal(srcAbilities.length, refAbilities.length, `${label}.abilities 数量应为 ${refAbilities.length}`);
  const remaining = [...srcAbilities];
  refAbilities.forEach((refAbility, i) => {
    const expected = projectAbility(refAbility, refAbility);
    const idx = remaining.findIndex((src) => projectAbility(src, refAbility) === expected);
    assert.ok(
      idx >= 0,
      `${label}.abilities[${i}] 与参考不一致：期望 ${expected}，实际 ${JSON.stringify(srcAbilities)}`,
    );
    remaining.splice(idx, 1);
  });
}

/** 独立统计预设牌组（不调用 validateDeck） */
function auditPreset(preset, factionId) {
  const errors = [];
  const counts = new Map();
  const cards = Array.isArray(preset?.cards) ? preset.cards : null;
  if (!cards) return { errors: [`预设 ${preset?.id ?? "?"} 缺少 cards 数组`], stats: null };

  for (const entry of cards) {
    const id = entry?.id;
    const count = entry?.count;
    if (!id) { errors.push(`预设 ${preset.id}: 存在缺少 id 的条目`); continue; }
    if (!Number.isInteger(count) || count < 1) {
      errors.push(`预设 ${preset.id}: 「${id}」count 非法（${count}）`);
      continue;
    }
    counts.set(id, (counts.get(id) ?? 0) + count);
  }

  const stats = { units: 0, specials: 0, heroes: 0, baseStrength: 0, total: 0 };
  for (const [id, count] of counts) {
    const card = CARDS[id];
    stats.total += count;
    if (!card) { errors.push(`预设 ${preset.id}: 未知卡牌「${id}」`); continue; }
    if (!card.deckable || card.copies <= 0) {
      errors.push(`预设 ${preset.id}: 「${id}」是不可收藏衍生物，不能入组`);
      continue;
    }
    if (card.faction !== factionId && card.faction !== "neutral") {
      errors.push(`预设 ${preset.id}: 「${id}」属于 ${card.faction}，不可用于 ${factionId}`);
    }
    if (count > card.copies) {
      errors.push(`预设 ${preset.id}: 「${id}」数量 ${count} 超过收藏份数 ${card.copies}`);
    }
    if (card.type === "unit") {
      stats.units += count;
      stats.baseStrength += (card.strength ?? 0) * count;
      if (card.hero) stats.heroes += count;
    } else if (card.type === "special" || card.type === "weather") {
      stats.specials += count;
    } else {
      errors.push(`预设 ${preset.id}: 「${id}」类型非法 ${card.type}`);
    }
  }

  if (stats.units < 22) errors.push(`预设 ${preset.id}: 单位牌 ${stats.units} < 22`);
  if (stats.specials > 10) errors.push(`预设 ${preset.id}: 特殊牌 ${stats.specials} > 10`);
  if (!preset.leaderId) errors.push(`预设 ${preset.id}: 缺少 leaderId`);
  else {
    const leader = LEADERS?.[preset.leaderId];
    if (!leader) errors.push(`预设 ${preset.id}: 未知领袖「${preset.leaderId}」`);
    else if (leader.faction !== factionId) {
      errors.push(`预设 ${preset.id}: 领袖「${preset.leaderId}」阵营 ${leader.faction} ≠ ${factionId}`);
    }
  }
  // 领袖不得混在 cards 里（领袖不进入牌组）
  const leaderAsCard = cards.find((e) => e?.id === preset.leaderId);
  if (leaderAsCard) errors.push(`预设 ${preset.id}: 领袖牌出现在 cards 列表中`);

  return { errors, stats, counts };
}

const normName = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/* ================================================================== */
/* 1. 参考数据（oracle）自检 —— 不依赖 src/data，始终运行              */
/* ================================================================== */

test("oracle: 163 张卡 / 22 领袖 / 5 阵营，id 唯一且 kebab-case", () => {
  assert.equal(refCards.length, 163, "参考卡牌应为 163 张");
  assert.equal(refLeaders.length, 22, "参考领袖应为 22 张");
  assert.equal(refFactions.length, 5, "参考阵营应为 5 个");

  const cardIds = refCards.map((c) => c.id);
  assert.equal(new Set(cardIds).size, cardIds.length, "参考卡牌 id 必须唯一");
  for (const id of cardIds) assert.match(id, KEBAB, `参考卡牌 id 非法：${id}`);
  const leaderIds = refLeaders.map((l) => l.id);
  assert.equal(new Set(leaderIds).size, leaderIds.length, "参考领袖 id 必须唯一");
  for (const id of leaderIds) assert.match(id, KEBAB, `参考领袖 id 非法：${id}`);

  const byType = { unit: 0, special: 0, weather: 0 };
  for (const c of refCards) {
    assert.ok(CARD_TYPES.has(c.type), `${c.id}: 非法 type ${c.type}`);
    byType[c.type]++;
    assert.ok(FACTION_IDS.includes(c.faction) || c.faction === "neutral", `${c.id}: 非法 faction ${c.faction}`);
    for (const ability of c.abilities) {
      assert.ok(ABILITY_IDS.has(ability.id), `${c.id}: 参考出现未知能力 id ${ability.id}`);
    }
    for (const row of c.rows) assert.ok(["close", "ranged", "siege"].includes(row), `${c.id}: 非法行 ${row}`);
  }
  assert.deepEqual(byType, { unit: 154, special: 4, weather: 5 });
  for (const f of refFactions) assert.ok(FACTION_IDS.includes(f.id), `参考阵营非法：${f.id}`);
});

test("oracle: 4 张衍生物 copies=0/deckable=false；召唤/变身目标均存在", () => {
  for (const id of TOKEN_IDS) {
    const c = refCardById.get(id);
    assert.ok(c, `参考数据缺少衍生物 ${id}`);
    assert.equal(c.copies, 0, `${id} copies 应为 0`);
    assert.equal(c.deckable, false, `${id} deckable 应为 false`);
  }
  for (const c of refCards) {
    for (const a of c.abilities) {
      if (a.id === "avenger") assert.ok(refCardById.has(a.token), `${c.id}: avenger token「${a.token}」不存在`);
      if (a.id === "berserker") {
        const t = refCardById.get(a.transformTo);
        assert.ok(t, `${c.id}: transformTo「${a.transformTo}」不存在`);
        assert.equal(t.deckable, false, `${a.transformTo} 应为不可收藏衍生物`);
      }
    }
  }
  // 可收藏牌 copies 1~5（如 Mahakaman Defender=5、Impera Brigade Guard=4）；特殊/天气 2~3
  for (const c of refCards.filter((x) => x.deckable)) {
    assert.ok(c.copies >= 1 && c.copies <= 5, `${c.id}: copies=${c.copies} 超出 1~5`);
    if (c.type === "special" || c.type === "weather") {
      // 参考数据中多数特殊/天气为 3 份；Clear Weather / Torrential Rain 为 2 份（与 upstream Occurrences 一致）
      assert.ok([2, 3].includes(c.copies), `${c.id}: 特殊/天气 copies=${c.copies} 应为 2~3`);
    }
  }
  // 英雄牌全部含 hero ability
  for (const c of refCards.filter((x) => x.hero)) {
    assert.ok(c.abilities.some((a) => a.id === "hero"), `${c.id}: 英雄缺少 hero ability`);
  }
  // 每张 leader 至少一个 ability，且在 5 阵营内
  for (const l of refLeaders) {
    assert.ok(Array.isArray(l.ability) && l.ability.length > 0, `${l.id}: leader ability 为空`);
    assert.ok(FACTION_IDS.includes(l.faction), `${l.id}: leader faction 非法`);
  }
});

/* ================================================================== */
/* 2~5. src/data 卡牌/领袖/阵营 独立比对                              */
/* ================================================================== */

test("cards: 163 张、id 集合与参考完全一致、无重复、kebab-case", { skip: SKIP_REASON }, () => {
  assert.equal(CARD_LIST.length, 163, "src/data/cards.js 卡牌数应为 163");
  const ids = CARD_LIST.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "src/data/cards.js 存在重复 id");

  const srcIds = new Set(ids);
  const refIds = new Set(refCards.map((c) => c.id));
  const missing = [...refIds].filter((id) => !srcIds.has(id));
  const extra = [...srcIds].filter((id) => !refIds.has(id));
  assert.deepEqual(missing, [], `缺少参考卡牌：${missing.join(", ")}`);
  assert.deepEqual(extra, [], `多出参考数据中没有的卡牌：${extra.join(", ")}`);

  for (const id of ids) assert.match(id, KEBAB, `非法卡牌 id：${id}`);
  // CARDS 对象的键必须与卡牌自身 id 一致
  assert.equal(Object.keys(CARDS).length, CARD_LIST.length, "CARDS 键数量与 CARD_LIST 不一致");
  for (const c of CARD_LIST) {
    assert.equal(CARDS[c.id], c, `CARDS["${c.id}"] 与 CARD_LIST 中的对象不一致`);
  }
});

test("cards: 每张卡 faction/type/hero/rows/strength/copies/deckable 与参考逐字段一致", { skip: SKIP_REASON }, () => {
  for (const ref of refCards) {
    const card = CARDS[ref.id];
    assert.ok(card, `缺少卡牌 ${ref.id}`);
    assert.equal(card.id, ref.id, `${ref.id}.id`);
    assert.equal(card.faction, ref.faction, `${ref.id}.faction`);
    assert.equal(card.type, ref.type, `${ref.id}.type`);
    assert.equal(card.hero, ref.hero, `${ref.id}.hero 必须为布尔值`);
    assert.deepEqual(card.rows, ref.rows, `${ref.id}.rows（内容与顺序）`);
    const srcStrength = card.strength ?? null;
    const refStrength = ref.strength ?? null;
    assert.equal(srcStrength, refStrength, `${ref.id}.strength`);
    assert.equal(card.copies, ref.copies, `${ref.id}.copies`);
    assert.equal(card.deckable, ref.deckable, `${ref.id}.deckable`);
  }
});

test("cards: abilities 与参考深比较（忽略中文/附加字段/数组顺序）", { skip: SKIP_REASON }, () => {
  for (const ref of refCards) {
    const card = CARDS[ref.id];
    assert.ok(card, `缺少卡牌 ${ref.id}`);
    assertAbilitiesMatch(card.abilities, ref.abilities, ref.id);
  }
});

test("cards: 结构不变量（行/力量/能力引用/中文文案/衍生物）", { skip: SKIP_REASON }, () => {
  for (const card of CARD_LIST) {
    const at = card.id;
    assert.ok(card.nameZh && card.nameZh.trim().length > 0, `${at}: nameZh 不能为空`);
    assert.ok(card.nameEn && card.nameEn.trim().length > 0, `${at}: nameEn 不能为空`);
    assert.ok(Array.isArray(card.abilities), `${at}: abilities 必须为数组`);

    if (card.type === "unit") {
      assert.ok(card.rows.length >= 1 && card.rows.length <= 2, `${at}: 单位牌行数应为 1~2`);
      assert.ok(Number.isInteger(card.strength) && card.strength >= 0, `${at}: 单位牌 strength 应为非负整数`);
      if (card.rows.length === 2) {
        assert.deepEqual(card.rows, ["close", "ranged"], `${at}: 双行单位必须为 close+ranged（灵巧）`);
        assert.ok(card.abilities.some((a) => a.id === "agile"), `${at}: 双行单位缺少 agile 能力`);
      }
    } else {
      assert.deepEqual(card.rows, [], `${at}: 特殊/天气牌 rows 必须为空`);
      assert.equal(card.strength, null, `${at}: 特殊/天气牌 strength 必须为 null`);
    }
    if (card.abilities.some((a) => a.id === "hero")) assert.equal(card.hero, true, `${at}: 有 hero 能力但 hero=false`);
    if (card.hero) assert.ok(card.copies <= 1, `${at}: 英雄 copies 不应 > 1`);
    if (!card.deckable) assert.equal(card.copies, 0, `${at}: 不可收藏牌 copies 应为 0`);

    for (const a of card.abilities) {
      assert.ok(ABILITY_IDS.has(a.id), `${at}: 未知能力 id ${a.id}`);
      assert.ok(CARDS[a.token] || !a.token, `${at}: avenger token 不存在 ${a.token}`);
      assert.ok(CARDS[a.transformTo] || !a.transformTo, `${at}: transformTo 不存在 ${a.transformTo}`);
      if (a.id === "muster") {
        assert.ok(Array.isArray(a.from) && a.from.length > 0, `${at}: muster 缺少 from`);
        assert.ok(typeof a.group === "string" && a.group.length > 0, `${at}: muster 缺少 group`);
      }
    }
  }
  // 4 张衍生物必须存在且不可入组
  for (const id of TOKEN_IDS) assert.ok(CARDS[id], `缺少衍生物 ${id}`);
  // 阵营卡数分布（与参考一致，防止"复制粘贴错位"）
  const dist = {};
  for (const c of CARD_LIST) dist[c.faction] = (dist[c.faction] ?? 0) + 1;
  assert.deepEqual(dist, {
    "northern-realms": 25, nilfgaard: 29, scoiatael: 23, monsters: 35, skellige: 27, neutral: 24,
  });
});

test("leaders: 22 张、id 集合/阵营/ability 与参考一致", { skip: SKIP_REASON }, () => {
  assert.equal(LEADER_LIST.length, 22, "领袖数应为 22");
  const srcIds = new Set(LEADER_LIST.map((l) => l.id));
  const refIds = new Set(refLeaders.map((l) => l.id));
  assert.deepEqual([...refIds].filter((id) => !srcIds.has(id)), [], "缺少领袖");
  assert.deepEqual([...srcIds].filter((id) => !refIds.has(id)), [], "多出领袖");
  assert.equal(Object.keys(LEADERS).length, 22, "LEADERS 键数量应为 22");

  for (const ref of refLeaders) {
    const leader = LEADERS[ref.id];
    assert.ok(leader, `缺少领袖 ${ref.id}`);
    assert.equal(leader.id, ref.id, `${ref.id}.id`);
    assert.equal(leader.faction, ref.faction, `${ref.id}.faction`);
    assert.match(leader.id, KEBAB, `${ref.id}: 非法 kebab-case id`);
    assert.ok(leader.nameZh && leader.nameZh.trim().length > 0, `${ref.id}: 缺少中文名`);
    assertAbilitiesMatch(leader.ability, ref.ability, `${ref.id}(leader)`);
  }
  // 每阵营领袖数：北方 5、尼弗迦德 5、怪物 5、松鼠党 5、史凯利格 2
  const byFaction = {};
  for (const l of LEADER_LIST) byFaction[l.faction] = (byFaction[l.faction] ?? 0) + 1;
  assert.deepEqual(byFaction, {
    "northern-realms": 5, nilfgaard: 5, scoiatael: 5, monsters: 5, skellige: 2,
  });
});

test("factions: 5 阵营 + neutral，能力 id 与参考一致", { skip: SKIP_REASON }, () => {
  assert.ok(FACTIONS, "缺少 FACTIONS");
  for (const id of [...FACTION_IDS, "neutral"]) assert.ok(FACTIONS[id], `缺少阵营 ${id}`);
  for (const ref of refFactions) {
    const f = FACTIONS[ref.id];
    assert.ok(f, `缺少阵营 ${ref.id}`);
    assert.equal(f.id, ref.id, `${ref.id}.id`);
    assert.ok(f.ability && f.ability.id === ref.ability.id, `${ref.id}: ability.id 应为 ${ref.ability.id}`);
    assert.ok(f.nameZh && f.nameZh.length > 0, `${ref.id}: 缺少 nameZh`);
    assert.ok(f.nameEn && f.nameEn.length > 0, `${ref.id}: 缺少 nameEn`);
  }
  const neutral = FACTIONS.neutral;
  assert.ok(neutral, "缺少 neutral 伪阵营");
  assert.ok(neutral.nameZh && neutral.nameZh.length > 0, "neutral 缺少 nameZh");
});

/* ================================================================== */
/* 6. db 契约交叉检查                                                  */
/* ================================================================== */

test("db: collectionFor = 本阵营 + 中立（deckable 且 copies>0）", { skip: SKIP_REASON || !dbMod ? "SKIP：src/data/db.js 尚未产出" : false }, () => {
  for (const factionId of FACTION_IDS) {
    const collection = dbMod.collectionFor(factionId);
    assert.ok(Array.isArray(collection), `collectionFor(${factionId}) 应返回数组`);
    const expected = CARD_LIST
      .filter((c) => c.deckable && c.copies > 0 && (c.faction === factionId || c.faction === "neutral"))
      .map((c) => c.id)
      .sort();
    const actual = collection.map((c) => c.id).sort();
    assert.deepEqual(actual, expected, `collectionFor(${factionId}) 与独立计算不一致`);
    // 不含其他阵营
    for (const c of collection) {
      assert.ok(c.faction === factionId || c.faction === "neutral", `collectionFor(${factionId}) 混入 ${c.faction} 卡 ${c.id}`);
    }
  }
  // CARDS_BY_FACTION 覆盖全部卡牌
  const union = new Set();
  for (const id of [...FACTION_IDS, "neutral"]) {
    const ids = dbMod.CARDS_BY_FACTION?.[id] ?? [];
    for (const cardId of ids) union.add(cardId);
  }
  assert.deepEqual([...union].sort(), CARD_LIST.map((c) => c.id).sort(), "CARDS_BY_FACTION 未覆盖全部卡牌");
});

/* ================================================================== */
/* 7. 预设牌组独立计数校验                                             */
/* ================================================================== */

test("presets: 每阵营 ≥1 套，独立计数满足牌组规则（单位≥22、特殊≤10、数量≤copies、仅本阵营+中立）", { skip: SKIP_REASON || !decksMod?.PRESET_DECKS || !LEADERS ? "SKIP：src/data/decks.js 尚未产出" : false }, () => {
  const PRESET_DECKS = decksMod.PRESET_DECKS;
  const problems = [];
  let presetCount = 0;

  for (const factionId of FACTION_IDS) {
    const presets = PRESET_DECKS[factionId];
    assert.ok(Array.isArray(presets) && presets.length >= 1, `${factionId}: 至少需要 1 套预设牌组`);
    for (const preset of presets) {
      presetCount++;
      const audit = auditPreset(preset, factionId);
      for (const err of audit.errors) problems.push(err);
      if (audit.stats) {
        // 独立计数结果必须满足硬性规则
        assert.ok(audit.stats.units >= 22, `${preset.id}: 单位牌 ${audit.stats.units} < 22`);
        assert.ok(audit.stats.specials <= 10, `${preset.id}: 特殊牌 ${audit.stats.specials} > 10`);
        assert.ok(audit.stats.total === [...audit.counts.values()].reduce((a, b) => a + b, 0));
      }
      // 交叉验证：与 db.validateDeck 的结论一致（防止两边同时错）
      if (dbMod?.validateDeck && decksMod?.expandPreset) {
        const expanded = decksMod.expandPreset(preset);
        const result = dbMod.validateDeck(expanded, preset.leaderId, factionId);
        assert.equal(
          result.ok,
          audit.errors.length === 0,
          `${preset.id}: QA 独立审计与 validateDeck 结论不一致（独立=${audit.errors.length === 0}，validateDeck=${result.ok}：${result.errors.join("；")}）`,
        );
      }
    }
  }
  assert.ok(presetCount >= 5, `预设牌组总数过少：${presetCount}`);
  assert.deepEqual(problems, [], `预设牌组问题：\n- ${problems.join("\n- ")}`);
});

/* ================================================================== */
/* 8. Muster group 可解析性（防止"打出却拉不到牌"的死 combo）           */
/* ================================================================== */

test("muster: 每个 group 至少能解析到 1 张可收藏卡（Arachas 不得误吃 Behemoth）", { skip: SKIP_REASON }, () => {
  const warnings = [];
  for (const card of CARD_LIST) {
    for (const ability of card.abilities) {
      if (ability.id !== "muster") continue;
      const group = ability.group;
      // 硬规则：宽松名称归一化后必须能解析到至少 1 张 deckable 卡
      const tolerant = CARD_LIST.filter(
        (c) => c.deckable && c.copies > 0
          && (normName(c.nameEn) === normName(group) || normName(c.nameEn).startsWith(normName(group))),
      );
      assert.ok(
        tolerant.length >= 1,
        `${card.id}: muster group「${group}」无法解析到任何可收藏卡（数据/规则不一致，见 docs/QA_RULES_AUDIT.md A-02）`,
      );
      // 文档 §3.3 精确规则：名称 === group 或以 group + ":" 开头
      const exact = CARD_LIST.filter(
        (c) => c.deckable && c.copies > 0 && (c.nameEn === group || c.nameEn.startsWith(`${group}:`)),
      );
      if (exact.length === 0) {
        warnings.push(`${card.id} → group「${group}」（nameEn 精确匹配失败，实际依赖名称归一化/引擎特殊处理）`);
      }
      // Arachas：文档精确规则只能命中 Arachas 本体，不能把 Arachas Behemoth 当成同组
      if (group === "Arachas") {
        assert.ok(
          exact.every((c) => c.id !== "arachas-behemoth"),
          "Arachas group 不应匹配 Arachas Behemoth（不同名，原版 Muster 不召唤它）",
        );
      }
    }
  }
  if (warnings.length > 0) {
    console.warn(
      "\n[data-audit] ⚠ Muster 文档精确匹配失败（见 QA_RULES_AUDIT A-02）：\n- " + warnings.join("\n- ") + "\n",
    );
  }
});
