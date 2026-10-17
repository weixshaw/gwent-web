/* ============================================================================
   card-render.js — 卡牌 DOM 渲染（visualist）
   ----------------------------------------------------------------------------
   严格实现 docs/ARCHITECTURE.md §6 的契约：
     initCardRenderer / createCardEl / setCardPower / setCardState /
     createCardBack / createLeaderCardEl / renderRowIcon /
     getCardArtDataUrl / preloadArt
   美术来自 ./art.js（程序化 SVG，无任何外部图片/字体）。

   与 Lead 现有 UI 的兼容约定：
   - 同时输出 `gt-card--{faction}` 与简写 `gt-card--nr|ng|st|mo|sk|neutral`；
   - 状态同时写 `data-state` 与 `is-selected / is-target / is-disabled /
     is-just-played / is-entering ...` 类，供 board.js 直接 toggle；
   - 根节点负责布局尺寸，内部 `.gt-card__surface` 负责 3D tilt / 抬升；
   - 任何插画异常都不会抛出，降级为占位插画，保证对局不中断。
   ============================================================================ */

import {
  ensureArtSprite,
  renderCardArtSvg,
  renderCardBackSvg,
  renderLeaderArtSvg,
  renderFrameSvg,
  renderRowIcon as renderArtRowIcon,
  renderAbilityIcon,
  resolveCardArt,
  getCardArtDataUrl as getArtDataUrl,
  preloadArt as preloadCardArt,
  escapeHtml,
} from "./art.js";

/* ------------------------------------------------------------------ 常量 */
const FACTION_SHORT = {
  "northern-realms": "nr",
  nilfgaard: "ng",
  scoiatael: "st",
  monsters: "mo",
  skellige: "sk",
  neutral: "neutral",
};

const FACTION_ALIASES = {
  "northern-realms": "northern-realms",
  northernrealms: "northern-realms",
  nr: "northern-realms",
  north: "northern-realms",
  nilfgaard: "nilfgaard",
  ng: "nilfgaard",
  scoiatael: "scoiatael",
  "scoia-tael": "scoiatael",
  st: "scoiatael",
  monsters: "monsters",
  monster: "monsters",
  mo: "monsters",
  skellige: "skellige",
  sk: "skellige",
  neutral: "neutral",
  ne: "neutral",
};

const ROW_LABEL = {
  close: "近战行",
  ranged: "远程行",
  siege: "攻城行",
  agile: "灵巧（近战 / 远程）",
  weather: "天气",
  frost: "冰霜",
  fog: "浓雾",
  rain: "暴雨",
  storm: "风暴",
  clear: "天晴",
  horn: "号角",
  mardroeme: "曼陀罗",
  scorch: "灼烧",
  decoy: "诱饵",
};

const LEADER_STATE_LABEL = {
  available: "可用",
  used: "已使用",
  canceled: "已取消",
};

const ABILITY_LABEL = {
  hero: "英雄",
  spy: "间谍",
  medic: "医师",
  muster: "集结",
  horn: "号角",
  scorch: "灼烧",
  decoy: "诱饵",
  mardroeme: "曼陀罗",
  agile: "灵巧",
  avenger: "复仇者",
  berserker: "狂战士",
  bond: "紧缚",
  morale: "士气",
  weather: "天气",
};

const TILT_DEG = 6;

const prefersReducedMotion = () => {
  try {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (err) {
    return false;
  }
};

const canHover = () => {
  try {
    return !!(window.matchMedia && window.matchMedia("(hover: hover)").matches);
  } catch (err) {
    return true;
  }
};

/* --------------------------------------------------------------- 模块状态 */
const ctx = {
  getCard: null,
  getLeader: null,
  getFaction: null,
  initialized: false,
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const normalizeFaction = (faction) => {
  const raw = String(faction || "neutral").toLowerCase();
  return FACTION_ALIASES[raw] || "neutral";
};

function normalizeCard(cardOrId) {
  let card = cardOrId;
  if (typeof card === "string") {
    card = ctx.getCard ? ctx.getCard(cardOrId) : null;
    if (!card) card = { id: cardOrId };
  }
  if (!card || typeof card !== "object") card = { id: "unknown" };
  return card;
}

function normalizeLeader(leaderOrId) {
  let leader = leaderOrId;
  if (typeof leader === "string") {
    leader = ctx.getLeader ? ctx.getLeader(leaderOrId) : null;
    if (!leader) leader = { id: leaderOrId };
  }
  if (!leader || typeof leader !== "object") leader = { id: "unknown" };
  return leader;
}

/* ========================================================================== */
/*  契约第 1 项：初始化                                                       */
/* ========================================================================== */

/**
 * 注入数据访问器（由 Lead 在启动时调用，可传 { getCard, getLeader, getFaction }）。
 * 允许延迟/重复调用；同时预热共享 SVG defs。
 */
export function initCardRenderer(accessors = {}) {
  if (accessors && typeof accessors.getCard === "function") ctx.getCard = accessors.getCard;
  if (accessors && typeof accessors.getLeader === "function") ctx.getLeader = accessors.getLeader;
  if (accessors && typeof accessors.getFaction === "function") ctx.getFaction = accessors.getFaction;
  if (!ctx.initialized) {
    ctx.initialized = true;
    ensureArtSprite();
  }
  return ctx;
}

/* ========================================================================== */
/*  契约第 2 项：createCardEl                                                 */
/* ========================================================================== */

function powerOf(card, opts) {
  if (opts && opts.powerOverride !== undefined && opts.powerOverride !== null) {
    return opts.powerOverride;
  }
  if (card.strength === undefined || card.strength === null) return null;
  return card.strength;
}

function cardType(card) {
  const type = String(card.type || "unit").toLowerCase();
  if (type === "special" || type === "weather" || type === "unit") return type;
  return "unit";
}

function primaryRowIcon(card, art) {
  const type = cardType(card);
  if (type === "weather") return renderArtRowIcon(art.weatherKind || "weather");
  if (type === "special") {
    const abilities = Array.isArray(card.abilities) ? card.abilities : [];
    const ids = abilities.map((a) => a && a.id).filter(Boolean);
    for (const key of ["horn", "scorch", "decoy", "mardroeme"]) {
      if (ids.includes(key)) return renderArtRowIcon(key);
    }
    return renderArtRowIcon("weather");
  }
  const rows = Array.isArray(card.rows) ? card.rows : [];
  if (rows.length > 1) return renderArtRowIcon("agile");
  const row = rows[0] || "close";
  return renderArtRowIcon(row);
}

function rowTooltip(card, art) {
  const type = cardType(card);
  if (type === "weather") return ROW_LABEL[art.weatherKind] || "天气";
  if (type === "special") {
    const ids = (card.abilities || []).map((a) => a && a.id).filter(Boolean);
    for (const key of ["horn", "scorch", "decoy", "mardroeme"]) {
      if (ids.includes(key)) return ROW_LABEL[key];
    }
    return "特殊牌";
  }
  const rows = Array.isArray(card.rows) ? card.rows : [];
  if (rows.length > 1) return ROW_LABEL.agile;
  return ROW_LABEL[rows[0] || "close"] || "战场";
}

/** 能力摘要：优先 abilityZh；无能力时用风味文字（能力区不至于空着） */
function abilitySummary(card) {
  const zh = String(card.abilityZh || "").trim();
  if (zh) return { text: zh, flavor: false };
  const flavor = String(card.flavorZh || "").trim();
  if (flavor) return { text: flavor, flavor: true };
  const abilities = Array.isArray(card.abilities) ? card.abilities : [];
  const labels = abilities.map((a) => ABILITY_LABEL[a && a.id]).filter(Boolean);
  if (labels.length) return { text: labels.join(" · "), flavor: false };
  return { text: "", flavor: true };
}

function abilityIconMarkup(card, art) {
  const abilities = Array.isArray(card.abilities) ? card.abilities : [];
  if (abilities.length) return renderAbilityIcon(abilities);
  if (card.hero || art.motif === "hero") return renderAbilityIcon([{ id: "hero" }]);
  return "";
}

function ariaLabelFor(card, art, power) {
  const name = card.nameZh || card.nameEn || card.id || "卡牌";
  const type = cardType(card);
  if (type === "weather") return `${name}，天气牌`;
  if (type === "special") return `${name}，特殊牌`;
  const powerText = power === null || power === undefined ? "" : `，战力 ${power}`;
  const heroText = card.hero ? "，英雄牌" : "";
  return `${name}${heroText}${powerText}`;
}

function artPlaceholderMarkup(card) {
  const pal = normalizeFaction(card.faction);
  return `<div class="gt-card__art-placeholder gt-card__art-placeholder--${FACTION_SHORT[pal]}">
    <span class="gt-card__art-placeholder-sigil" aria-hidden="true">⚜</span>
  </div>`;
}

function buildCardBackInto(el, factionId, size) {
  const faction = normalizeFaction(factionId);
  el.classList.add("gt-card--back", "is-facedown");
  el.dataset.faction = faction;
  el.classList.add(`gt-card--${faction}`, `gt-card--${FACTION_SHORT[faction]}`);
  el.innerHTML = `<div class="gt-card__surface gt-card__surface--back">
    <div class="gt-card__back-art" aria-hidden="true">${renderCardBackSvg(faction)}</div>
    <div class="gt-card__back-sheen" aria-hidden="true"></div>
  </div>`;
  return el;
}

/**
 * 创建一张卡牌 DOM。
 * @param {object|string} cardOrId 卡牌数据（或 id，需先 initCardRenderer 注入 getCard）
 * @param {object} opts { size:'xxs'|'xs'|'sm'|'md'|'lg', faceDown?, interactive?,
 *                        powerOverride?, hidePower?, className?, uid?, hideAbility? }
 * @returns {HTMLElement}
 */
export function createCardEl(cardOrId, opts = {}) {
  if (!ctx.initialized) initCardRenderer();
  const card = normalizeCard(cardOrId);
  const size = String(opts.size || "md");
  const faction = normalizeFaction(card.faction);
  const short = FACTION_SHORT[faction];
  const type = cardType(card);
  const art = (() => {
    try {
      return resolveCardArt(card);
    } catch (err) {
      return { motif: "warrior", subjectMotif: "warrior", hero: false, weatherKind: "frost", specialKind: "arcane", seedText: String(card.id || "") };
    }
  })();

  const el = document.createElement("div");
  const classes = [
    "gt-card",
    `gt-card--${faction}`,
    `gt-card--${short}`,
    `gt-card--${size}`,
    "gt-card--type-" + type,
  ];
  if (card.hero || art.hero) classes.push("gt-card--hero");
  if (type === "special") classes.push("gt-card--special");
  if (type === "weather") classes.push("gt-card--weather");
  if (Array.isArray(card.rows) && card.rows.length > 1) classes.push("gt-card--agile");
  if (opts.interactive) classes.push("is-interactive", "gt-card--interactive");
  if (opts.className) classes.push(String(opts.className));
  el.className = classes.filter(Boolean).join(" ");
  el.dataset.cardId = card.id || "";
  if (opts.uid) el.dataset.uid = String(opts.uid);
  el.dataset.type = type;
  el.dataset.motif = art.motif;
  el.dataset.faction = faction;
  el.dataset.state = "normal";

  // 卡背 / 盖放
  if (opts.faceDown) {
    buildCardBackInto(el, faction, size);
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", "盖放的卡牌");
    return el;
  }

  const power = powerOf(card, opts);
  const hidePower = opts.hidePower === true || power === null || power === undefined;
  const summary = abilitySummary(card);
  const icon = abilityIconMarkup(card, art);
  const nameZh = card.nameZh || card.nameEn || card.id || "未知卡牌";
  const nameEn = card.nameEn && card.nameEn !== nameZh ? card.nameEn : "";
  const tooltipText = String(card.abilityZh || card.flavorZh || "").trim();

  el.setAttribute("role", "img");
  el.setAttribute("aria-label", ariaLabelFor(card, art, power));
  if (tooltipText) {
    el.dataset.tooltip = tooltipText;
    el.dataset.tooltipTitle = nameZh;
    if (nameEn) el.dataset.tooltipEn = nameEn;
  }

  let artMarkup;
  try {
    artMarkup = opts.deferArt ? artPlaceholderMarkup(card) : renderCardArtSvg(card);
  } catch (err) {
    artMarkup = artPlaceholderMarkup(card);
    if (typeof console !== "undefined") console.warn("[card-render] art failed:", card.id, err);
  }

  const heroCrown = card.hero || art.hero
    ? `<span class="gt-card__name-crown" aria-hidden="true">${crownSvg()}</span>`
    : "";
  const rowTip = rowTooltip(card, art);
  const weatherAttr = type === "weather" ? ` data-weather="${escapeHtml(art.weatherKind)}"` : "";

  el.innerHTML = `<div class="gt-card__surface">
    <div class="gt-card__art">${artMarkup}</div>
    <div class="gt-card__art-shade" aria-hidden="true"></div>
    <div class="gt-card__name">
      ${heroCrown}
      <span class="gt-card__name-zh">${escapeHtml(nameZh)}</span>
      ${nameEn ? `<span class="gt-card__name-en">${escapeHtml(nameEn)}</span>` : ""}
    </div>
    <div class="gt-card__paper">
      ${icon ? `<span class="gt-card__ability-icon" aria-hidden="true">${icon}</span>` : ""}
      <span class="gt-card__ability-text${summary.flavor ? " gt-card__ability-text--flavor" : ""}">${escapeHtml(
        summary.text
      )}</span>
    </div>
    ${
      hidePower
        ? ""
        : `<div class="gt-card__power" title="战力${card.hero ? "（英雄）" : ""}">
             <span class="gt-card__power-value">${escapeHtml(String(power))}</span>
           </div>`
    }
    <div class="gt-card__row" title="${escapeHtml(rowTip)}" aria-hidden="true">
      <span class="gt-card__row-icon">${primaryRowIcon(card, art)}</span>
    </div>
    <div class="gt-card__shine" aria-hidden="true"></div>
    <div class="gt-card__foil" aria-hidden="true"></div>
    ${type === "weather" ? `<div class="gt-card__weather"${weatherAttr} aria-hidden="true"></div>` : ""}
    <div class="gt-card__frame" aria-hidden="true">${renderFrameSvg({
      hero: !!(card.hero || art.hero),
      special: type === "special" || type === "weather",
    })}</div>
  </div>`;

  if (opts.deferArt) {
    el.dataset.artDeferred = "1";
    el.__gtMountArt = () => mountCardArt(el, card);
  }
  if (opts.interactive) enableTilt(el);
  return el;
}

/** 延迟挂载插画（大画廊/选牌弹窗初始化性能优化） */
export function mountCardArt(el, cardOrId) {
  if (!el || el.dataset.artDeferred !== "1") return;
  const card = normalizeCard(cardOrId || el.dataset.cardId);
  const artBox = el.querySelector(".gt-card__art");
  if (!artBox) return;
  try {
    artBox.innerHTML = renderCardArtSvg(card);
  } catch (err) {
    artBox.innerHTML = artPlaceholderMarkup(card);
  }
  delete el.dataset.artDeferred;
  delete el.__gtMountArt;
}

function crownSvg() {
  return `<svg viewBox="0 0 24 18" aria-hidden="true" focusable="false"><path d="M2 14L3.8 4l5 3.6L12 2l3.2 5.6 5-3.6L22 14Z" fill="currentColor"/><circle cx="12" cy="16" r="1.5" fill="currentColor"/></svg>`;
}

/* ========================================================================== */
/*  契约第 3 项：setCardPower                                                 */
/* ========================================================================== */

function removeFloatingDelta(powerEl) {
  const nodes = powerEl.querySelectorAll(".gt-card__power-delta");
  nodes.forEach((node) => node.remove());
}

function spawnPowerDelta(el, powerEl, delta) {
  if (!powerEl || !delta) return;
  removeFloatingDelta(powerEl);
  const sign = delta > 0 ? "+" : "";
  const node = document.createElement("span");
  node.className = `gt-card__power-delta ${delta > 0 ? "is-up" : "is-down"}`;
  node.textContent = `${sign}${delta}`;
  powerEl.appendChild(node);
  const cleanup = () => {
    if (node.parentNode) node.remove();
  };
  if (typeof node.animate === "function") {
    const anim = node.animate(
      [
        { transform: "translate(-50%, 0) scale(.72)", opacity: 0 },
        { transform: "translate(-50%, -40%) scale(1.12)", opacity: 1, offset: 0.22 },
        { transform: "translate(-50%, -150%) scale(1)", opacity: 0 },
      ],
      { duration: 780, easing: "cubic-bezier(.22,.8,.3,1)" }
    );
    anim.onfinish = cleanup;
    anim.oncancel = cleanup;
    setTimeout(cleanup, 1000);
  } else {
    setTimeout(cleanup, 900);
  }
  powerEl.classList.remove("is-bumped", "is-bumped-down");
  void powerEl.offsetWidth;
  powerEl.classList.add(delta > 0 ? "is-bumped" : "is-bumped-down");
  setTimeout(() => powerEl.classList.remove("is-bumped", "is-bumped-down"), 760);
}

/**
 * 更新战力数字，并播放上浮 +N / -N 动画。
 * @param {HTMLElement} el createCardEl 返回的卡牌
 * @param {number|null} power 新战力；null/undefined → 隐藏力量宝石
 * @param {object} opts { delta = 0, animate = true }
 */
export function setCardPower(el, power, opts = {}) {
  if (!el) return;
  const { delta = 0, animate = true } = opts;
  const powerEl = el.querySelector(".gt-card__power");
  const node = powerEl && powerEl.querySelector(".gt-card__power-value");
  const hidden = power === null || power === undefined || power === "";
  if (hidden) {
    if (powerEl) {
      powerEl.classList.add("gt-card__power--hidden");
      powerEl.setAttribute("aria-hidden", "true");
    }
    return;
  }
  if (!powerEl || !node) {
    // 例如之后才得知战力的牌：补一个宝石
    mountPowerGem(el, power);
    return;
  }
  powerEl.classList.remove("gt-card__power--hidden");
  powerEl.removeAttribute("aria-hidden");
  const prevRaw = Number(node.textContent);
  const prev = Number.isFinite(prevRaw) ? prevRaw : null;
  const value = Number(power);
  const shown = Number.isFinite(value) ? value : power;
  node.textContent = String(shown);
  if (powerEl) powerEl.dataset.power = String(shown);
  const effectiveDelta = Number.isFinite(delta) && delta !== 0 ? delta : Number.isFinite(prev) && Number.isFinite(value) ? value - prev : 0;
  if (animate && effectiveDelta !== 0 && !prefersReducedMotion()) {
    spawnPowerDelta(el, powerEl, effectiveDelta);
  }
}

function mountPowerGem(el, power) {
  const surface = el.querySelector(".gt-card__surface");
  if (!surface) return;
  const gem = document.createElement("div");
  gem.className = "gt-card__power";
  gem.title = "战力";
  gem.innerHTML = `<span class="gt-card__power-value">${escapeHtml(String(power))}</span>`;
  const frame = surface.querySelector(".gt-card__frame");
  if (frame) surface.insertBefore(gem, frame);
  else surface.appendChild(gem);
  if (prefersReducedMotion()) return;
  gem.classList.add("is-bumped");
  setTimeout(() => gem.classList.remove("is-bumped"), 760);
}

/* ========================================================================== */
/*  契约第 4 项：setCardState                                                 */
/* ========================================================================== */

const STATE_CLASSES = ["is-selected", "is-target", "is-disabled", "is-just-played", "is-normal"];

/**
 * 设置卡牌视觉状态：'selected' | 'target' | 'disabled' | 'normal' | 'just-played'
 * 同步写 data-state 与 is-* 类（兼容 Lead 直接 toggle 类名的旧代码）。
 */
export function setCardState(el, state) {
  if (!el) return;
  const next = String(state || "normal");
  el.classList.remove(...STATE_CLASSES);
  el.dataset.state = next;
  if (next === "normal") {
    el.classList.add("is-normal");
    return;
  }
  el.classList.add(`is-${next}`);
  if (next === "just-played") {
    // 重复触发时让 CSS 动画重新开始
    const surface = el.querySelector(".gt-card__surface");
    if (surface) {
      surface.classList.remove("is-just-played-anim");
      void surface.offsetWidth;
      surface.classList.add("is-just-played-anim");
      setTimeout(() => surface.classList.remove("is-just-played-anim"), 1000);
    }
  }
}

/* ========================================================================== */
/*  契约第 5 项：createCardBack / createLeaderCardEl                          */
/* ========================================================================== */

/**
 * 创建阵营牌背。
 * @param {string} factionId
 * @param {string} size 'xxs'|'xs'|'sm'|'md'|'lg'
 */
export function createCardBack(factionId = "neutral", size = "md") {
  if (!ctx.initialized) initCardRenderer();
  const faction = normalizeFaction(factionId);
  const el = document.createElement("div");
  el.className = `gt-card gt-card--back gt-card--${faction} gt-card--${FACTION_SHORT[faction]} gt-card--${String(
    size || "md"
  )}`;
  el.dataset.faction = faction;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", "卡牌背面");
  buildCardBackInto(el, faction, size);
  return el;
}

/**
 * 创建领袖牌。
 * @param {object|string} leaderOrId
 * @param {object} opts { size, used?, canceled?, available?, interactive?, className? }
 */
export function createLeaderCardEl(leaderOrId, opts = {}) {
  if (!ctx.initialized) initCardRenderer();
  const leader = normalizeLeader(leaderOrId);
  const faction = normalizeFaction(leader.faction);
  const short = FACTION_SHORT[faction];
  const size = String(opts.size || "md");
  const used = opts.used === true;
  const canceled = opts.canceled === true;
  const available = opts.available === true || (!used && !canceled);
  const state = canceled ? "canceled" : used ? "used" : "available";

  const el = document.createElement("div");
  el.className = [
    "gt-leader",
    `gt-leader--${faction}`,
    `gt-leader--${short}`,
    `gt-leader--${size}`,
    `gt-leader--state-${state}`,
    opts.interactive ? "is-interactive" : "",
    opts.className || "",
  ]
    .filter(Boolean)
    .join(" ");
  el.dataset.leaderId = leader.id || "";
  el.dataset.faction = faction;
  el.dataset.state = state;
  el.setAttribute("role", "img");
  const name = leader.nameZh || leader.nameEn || leader.id || "领袖";
  el.setAttribute("aria-label", `${name}，领袖能力：${leader.abilityZh || leader.abilityEn || ""}`);
  if (leader.abilityZh || leader.abilityEn) {
    el.dataset.tooltip = String(leader.abilityZh || leader.abilityEn);
    el.dataset.tooltipTitle = name;
  }

  let art;
  try {
    art = renderLeaderArtSvg(leader);
  } catch (err) {
    art = `<div class="gt-card__art-placeholder"><span class="gt-card__art-placeholder-sigil">♛</span></div>`;
  }
  const nameEn = leader.nameEn && leader.nameEn !== name ? leader.nameEn : "";

  el.innerHTML = `<div class="gt-leader__surface">
    <div class="gt-leader__art">${art}</div>
    <div class="gt-leader__art-shade" aria-hidden="true"></div>
    <div class="gt-leader__crown" aria-hidden="true">${crownSvg()}</div>
    <div class="gt-leader__name">
      <span class="gt-leader__name-zh">${escapeHtml(name)}</span>
      ${nameEn ? `<span class="gt-leader__name-en">${escapeHtml(nameEn)}</span>` : ""}
    </div>
    <div class="gt-leader__paper">
      <span class="gt-leader__ability-text">${escapeHtml(leader.abilityZh || leader.abilityEn || "")}</span>
    </div>
    <div class="gt-leader__state" aria-hidden="true">
      <span class="gt-leader__state-dot"></span>
      <span class="gt-leader__state-text">${LEADER_STATE_LABEL[state]}</span>
    </div>
    <div class="gt-leader__frame" aria-hidden="true">${renderFrameSvg({ hero: true, leader: true })}</div>
  </div>`;

  if (opts.interactive) enableTilt(el, true);
  return el;
}

/** 更新领袖卡状态（可用 / 已使用 / 已取消） */
export function setLeaderState(el, { used = false, canceled = false, available = false } = {}) {
  if (!el) return;
  const state = canceled ? "canceled" : used ? "used" : "available";
  el.dataset.state = state;
  el.classList.remove(
    "gt-leader--state-available",
    "gt-leader--state-used",
    "gt-leader--state-canceled",
    "is-used",
    "is-canceled",
    "is-available"
  );
  el.classList.add(`gt-leader--state-${state}`, `is-${state}`);
  const text = el.querySelector(".gt-leader__state-text");
  if (text) text.textContent = LEADER_STATE_LABEL[state];
}

/* ========================================================================== */
/*  契约第 6~9 项：行图标 / 插画 dataURL / 预热                                */
/* ========================================================================== */

/**
 * 行图标（返回 innerHTML SVG 字符串）：近战 / 远程 / 攻城 / 灵巧 / 天气。
 * @param {string} row
 * @returns {string}
 */
export function renderRowIcon(row) {
  return renderArtRowIcon(row);
}

/**
 * 插画 dataURL（缓存）—— 供 vfx 幽灵卡 / 粒子贴图使用。
 * @param {object} card
 * @returns {string}
 */
export function getCardArtDataUrl(card) {
  if (!card || typeof card !== "object") return "";
  try {
    return getArtDataUrl(card);
  } catch (err) {
    if (typeof console !== "undefined") console.warn("[card-render] getCardArtDataUrl failed:", err);
    return "";
  }
}

/**
 * 预生成一组卡牌的插画缓存（同步、无网络）。
 * @param {Array<object>} cards
 */
export function preloadArt(cards) {
  try {
    if (!ctx.initialized) initCardRenderer();
    preloadCardArt(cards);
  } catch (err) {
    if (typeof console !== "undefined") console.warn("[card-render] preloadArt failed:", err);
  }
}

/* ========================================================================== */
/*  交互：3D tilt / 金色高光跟随                                              */
/* ========================================================================== */

/**
 * 鼠标位置驱动的 3D tilt（±6°）+ 金色高光跟随。
 * 只改 CSS 变量与 transform，不触发 layout；prefers-reduced-motion 时禁用。
 */
function enableTilt(el) {
  if (!el || el.__gtTiltBound) return;
  el.__gtTiltBound = true;
  el.classList.add("is-interactive", "gt-card--interactive");
  let rect = null;
  let hoverRaf = 0;
  let pending = null;

  const apply = () => {
    hoverRaf = 0;
    if (!pending || !el.isConnected) return;
    const { x, y } = pending;
    pending = null;
    const rx = (0.5 - y) * TILT_DEG * 2;
    const ry = (x - 0.5) * TILT_DEG * 2;
    el.style.setProperty("--gt-rx", `${rx.toFixed(2)}deg`);
    el.style.setProperty("--gt-ry", `${ry.toFixed(2)}deg`);
    el.style.setProperty("--gt-mx", `${(x * 100).toFixed(1)}%`);
    el.style.setProperty("--gt-my", `${(y * 100).toFixed(1)}%`);
  };

  const onEnter = () => {
    rect = el.getBoundingClientRect();
    el.classList.add("is-hovered");
  };
  const onMove = (event) => {
    if (!rect) rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = clamp01((event.clientX - rect.left) / rect.width);
    const y = clamp01((event.clientY - rect.top) / rect.height);
    pending = { x, y };
    if (!hoverRaf) hoverRaf = requestAnimationFrame(apply);
  };
  const onLeave = () => {
    el.classList.remove("is-hovered");
    rect = null;
    pending = null;
    if (hoverRaf) {
      cancelAnimationFrame(hoverRaf);
      hoverRaf = 0;
    }
    el.style.setProperty("--gt-rx", "0deg");
    el.style.setProperty("--gt-ry", "0deg");
    el.style.setProperty("--gt-mx", "50%");
    el.style.setProperty("--gt-my", "38%");
  };

  if (!canHover() || prefersReducedMotion()) {
    // 触摸 / 降级模式下只保留 CSS hover 的抬升，不绑定指针运算
    el.addEventListener("pointerenter", onEnter, { passive: true });
    el.addEventListener("pointerleave", onLeave, { passive: true });
    return;
  }
  el.addEventListener("pointerenter", onEnter, { passive: true });
  el.addEventListener("pointermove", onMove, { passive: true });
  el.addEventListener("pointerleave", onLeave, { passive: true });
  el.addEventListener("pointercancel", onLeave, { passive: true });
}

/* ========================================================================== */
/*  默认导出（方便 `import cardRenderer from './card-render.js'`）            */
/* ========================================================================== */

export default {
  initCardRenderer,
  createCardEl,
  setCardPower,
  setCardState,
  createCardBack,
  createLeaderCardEl,
  setLeaderState,
  renderRowIcon,
  getCardArtDataUrl,
  preloadArt,
  mountCardArt,
};
