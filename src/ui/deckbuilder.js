/**
 * deckbuilder.js — 组牌器界面（Owner: deck-smith）
 * ----------------------------------------------------------------------------
 * 契约（docs/ARCHITECTURE.md §8）：
 *   const db = createDeckBuilder({ onPlay, onBack });
 *   screenRoot.appendChild(db.el);
 *   db.open(factionId?);   // 进入组牌器
 *   db.close();            // 隐藏
 *   db.destroy();          // 卸载
 *
 * 功能：
 *   - 5 阵营 + 中立收藏规则（本阵营 + 中立），阵营能力提示
 *   - 领袖选择（按阵营，展示能力描述）
 *   - 收藏区：单位 / 英雄 / 特殊 / 天气筛选、搜索、排序、份数加减（≤ copies）
 *   - 牌组区：已选列表、逐张移除、清空、实时统计、合法性校验
 *   - 预设牌组：每阵营 2 套（数据层 PRESET_DECKS），一键载入（覆盖前确认）
 *   - localStorage 自动保存/恢复：key = gwent.decks.v1，按阵营保存牌组与领袖
 *   - 开始对局：合法时调用 onPlay({ faction, leaderId, cards })
 *
 * 依赖约定：
 *   - 卡牌数据全部来自 src/data/**（不硬编码卡名/数值）
 *   - 卡牌外观优先使用 visualist 的 createCardEl（src/ui/card-render.js）；
 *     该模块尚未就绪时使用自绘占位卡，就绪后自动重建收藏区
 *   - 纹章 / 行图标 / 领袖插画优先使用 src/ui/art.js，缺失时退化为内置极简 SVG
 *   - 样式全部位于 .deckbuilder 命名空间（src/styles/deckbuilder.css）
 */

import {
  FACTION_IDS,
  DECK_RULES,
  getCard,
  getLeader,
  getFaction,
  collectionFor,
  validateDeck,
} from "../data/db.js";
import { getPresets, getDefaultPreset, expandPreset } from "../data/decks.js";
import { LEADER_LIST } from "../data/leaders.js";

/* ========================================================================== */
/*  常量与工具                                                                 */
/* ========================================================================== */

const STORAGE_KEY = "gwent.decks.v1";
const STORAGE_VERSION = 1;
const DEFAULT_FACTION = FACTION_IDS[0] || "northern-realms";
const MAX_SPECIALS = DECK_RULES.MAX_SPECIALS;
const MIN_UNITS = DECK_RULES.MIN_UNITS;

const FILTERS = [
  { id: "all", label: "全部" },
  { id: "unit", label: "单位" },
  { id: "hero", label: "英雄" },
  { id: "special", label: "特殊" },
  { id: "weather", label: "天气" },
];

const SORTS = [
  { id: "power-desc", label: "战力 ↓" },
  { id: "power-asc", label: "战力 ↑" },
  { id: "name", label: "名称" },
  { id: "default", label: "默认顺序" },
];

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);

let collator = null;
try {
  collator = new Intl.Collator("zh-Hans-CN", { sensitivity: "base", numeric: true });
} catch (_err) {
  collator = null;
}
const compareName = (a, b) =>
  collator ? collator.compare(a.nameZh || a.id, b.nameZh || b.id) : String(a.nameZh || a.id).localeCompare(String(b.nameZh || b.id));

const ICONS = {
  back: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14.5 5.2 7.7 12l6.8 6.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  plus: `<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 2.2v7.6M2.2 6h7.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  minus: `<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.2 6h7.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  check: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8.4l3.2 3.2L13 4.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  search: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="6.8" cy="6.8" r="4.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.2 10.2 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
};

/** art.js / card-render.js 尚未就绪时的纹章占位（不外链图片，纯 SVG） */
const FALLBACK_SIGILS = {
  "northern-realms": `<path d="M50 14 82 28v26c0 21-14 34-32 42-18-8-32-21-32-42V28Z"/><path d="M35 40h30M50 32v30M39 51l11 9 11-9"/>`,
  nilfgaard: `<circle cx="50" cy="50" r="20"/><circle cx="50" cy="50" r="7"/><path d="M50 8v12M50 80v12M8 50h12M80 50h12M20 20l9 9M71 71l9 9M80 20l-9 9M29 71l-9 9"/>`,
  scoiatael: `<path d="M50 9 61 33 74 26 68 43 85 48 70 60 82 75 63 72 59 89 50 76 41 89 37 72 18 75 30 60 15 48 32 43 26 26 39 33Z"/>`,
  monsters: `<path d="M27 20c10 13 12 31 0 50M45 16c10 15 12 35-4 56M63 19c10 13 14 29 2 47"/><path d="M23 74c18 11 34 11 54 0"/>`,
  skellige: `<path d="M16 61c23 17 45 17 68 0l-6 13c-19 12-37 12-56 0Z"/><path d="M50 18v43M50 22c13 7 19 19 17 33L50 52Z"/><path d="M39 70c7-4 15-4 22 0"/>`,
  neutral: `<path d="M50 10l11 29 29 11-29 11-11 29-11-29-29-11 29-11Z"/>`,
};
const FALLBACK_ROW_ICONS = {
  close: `<path d="M12 3v15M7.6 7.4 12 3l4.4 4.4M8 21h8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  ranged: `<path d="M5 4c8 4 8 12 0 16M5 4v16M3 12h17M17 9l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  siege: `<path d="M3.5 21h17M6 21l4-12h4l4 12M12 9V4M8 21l2-6h4l2 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  agile: `<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  weather: `<path d="M6 14a4 4 0 010-8 6 6 0 0111 2 3 3 0 010 6H6Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 18.5l-1 2M12 18.5l-1 2M16 18.5l-1 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`,
  special: `<path d="M12 3l3 7 7 2-7 2-3 7-3-7-7-2 7-2Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`,
  leader: `<path d="M3.6 18 5.4 6.6l4.4 4.2L12 3.8l2.2 7 4.4-4.2L20.4 18Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>`,
};

/* ========================================================================== */
/*  视觉模块（art.js / card-render.js）的动态接入                              */
/* ========================================================================== */

/**
 * 动态探测并载入一个同源 ES 模块：先用 HEAD 避免 404 在控制台留下错误记录，
 * 文件不存在 / 载入失败时静默返回 null。
 */
async function tryImportModule(relativePath) {
  try {
    const url = new URL(relativePath, import.meta.url);
    if (typeof window !== "undefined" && window.location && window.location.protocol === "file:") {
      return null;
    }
    const res = await fetch(url.href, { method: "HEAD", cache: "no-store" });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (type && !/javascript|ecmascript/.test(type)) return null;
    return await import(url.href);
  } catch (_err) {
    return null;
  }
}

/** 确保 visualist 的 card.css 已加载（index.html 已引入时不重复添加）。 */
async function ensureCardStylesheet() {
  try {
    if (document.querySelector('link[href$="card.css"]')) return;
    const url = new URL("../styles/card.css", import.meta.url);
    const res = await fetch(url.href, { method: "HEAD", cache: "no-store" });
    if (!res.ok) return;
    await new Promise((resolve) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = url.href;
      link.onload = resolve;
      link.onerror = resolve;
      document.head.appendChild(link);
    });
  } catch (_err) {
    /* 样式缺失不阻塞功能 */
  }
}

/* ========================================================================== */
/*  工厂                                                                       */
/* ========================================================================== */

let instanceSeq = 0;

/**
 * 创建组牌器。
 * @param {object} [options]
 * @param {(config:{faction:string,leaderId:string,cards:string[]})=>void} [options.onPlay]
 * @param {()=>void} [options.onBack]
 * @returns {{el:HTMLElement, open:(factionId?:string)=>void, close:()=>void, destroy:()=>void}}
 */
export function createDeckBuilder(options = {}) {
  const onPlay = typeof options.onPlay === "function" ? options.onPlay : null;
  const onBack = typeof options.onBack === "function" ? options.onBack : null;
  const uid = `deckbuilder-${++instanceSeq}`;

  /* ------------------------------ DOM 骨架 ------------------------------ */
  const el = document.createElement("div");
  el.className = "deckbuilder deckbuilder--closed";
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", "组牌器");
  el.setAttribute("aria-hidden", "true");
  el.tabIndex = -1;

  const filterHtml = FILTERS.map(
    (f) =>
      `<button type="button" class="deckbuilder__filter" data-action="filter" data-filter="${f.id}" aria-pressed="false"><span>${f.label}</span><em data-filter-count="${f.id}">0</em></button>`
  ).join("");
  const sortHtml = SORTS.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");

  el.innerHTML = `
    <div class="deckbuilder__shell">
      <header class="deckbuilder__topbar">
        <button type="button" class="deckbuilder__ghost-btn deckbuilder__back" data-action="back" aria-label="返回主菜单">
          ${ICONS.back}<span>返回</span>
        </button>
        <div class="deckbuilder__title-wrap">
          <h1 class="deckbuilder__title">组牌器</h1>
          <p class="deckbuilder__subtitle">GWENT · DECK BUILDER</p>
        </div>
        <div class="deckbuilder__topbar-actions">
          <span class="deckbuilder__save-state" data-save-state role="status">自动保存</span>
          <button type="button" class="deckbuilder__ghost-btn deckbuilder__save-btn" data-action="save">保存</button>
          <button type="button" class="deckbuilder__primary-btn deckbuilder__start-top" data-action="start" data-start disabled>开始对局</button>
        </div>
      </header>

      <nav class="deckbuilder__factions" aria-label="选择阵营">
        <div class="deckbuilder__faction-tabs" data-faction-tabs></div>
        <p class="deckbuilder__faction-ability" data-faction-ability></p>
      </nav>

      <div class="deckbuilder__body">
        <aside class="deckbuilder__panel deckbuilder__side" aria-label="领袖与预设牌组">
          <section class="deckbuilder__section">
            <header class="deckbuilder__section-head">
              <h2 class="deckbuilder__eyebrow">领袖</h2>
              <span class="deckbuilder__section-hint">择一统帅</span>
            </header>
            <div class="deckbuilder__leaders" data-leaders role="group" aria-label="选择领袖"></div>
          </section>

          <section class="deckbuilder__section">
            <header class="deckbuilder__section-head">
              <h2 class="deckbuilder__eyebrow">预设牌组</h2>
              <span class="deckbuilder__section-hint">一键载入</span>
            </header>
            <div class="deckbuilder__presets" data-presets></div>
          </section>

          <section class="deckbuilder__section deckbuilder__lore">
            <header class="deckbuilder__section-head">
              <h2 class="deckbuilder__eyebrow">阵营志</h2>
            </header>
            <p class="deckbuilder__lore-text" data-lore></p>
          </section>
        </aside>

        <main class="deckbuilder__panel deckbuilder__collection" aria-label="卡牌收藏">
          <div class="deckbuilder__collection-watermark" data-watermark aria-hidden="true"></div>
          <header class="deckbuilder__collection-head">
            <div class="deckbuilder__collection-title">
              <h2>收藏</h2>
              <span class="deckbuilder__collection-summary" data-collection-summary></span>
            </div>
            <div class="deckbuilder__filters" data-filters role="group" aria-label="卡牌筛选">${filterHtml}</div>
          </header>
          <div class="deckbuilder__toolbar">
            <label class="deckbuilder__search">
              <span class="deckbuilder__search-icon" aria-hidden="true">${ICONS.search}</span>
              <span class="deckbuilder__sr-only">搜索卡牌</span>
              <input type="search" data-search placeholder="搜索卡牌（中文 / 英文）" autocomplete="off" spellcheck="false" />
            </label>
            <label class="deckbuilder__sort">
              <span class="deckbuilder__sort-label">排序</span>
              <span class="deckbuilder__select-wrap"><select data-sort>${sortHtml}</select></span>
            </label>
          </div>
          <div class="deckbuilder__grid-scroll" data-grid-scroll>
            <div class="deckbuilder__grid" data-grid></div>
            <div class="deckbuilder__empty" data-grid-empty hidden></div>
          </div>
        </main>

        <aside class="deckbuilder__panel deckbuilder__deckcol" aria-label="当前牌组">
          <header class="deckbuilder__deck-head">
            <div class="deckbuilder__deck-heading">
              <h2 class="deckbuilder__eyebrow">牌组</h2>
              <span class="deckbuilder__deck-faction" data-deck-faction></span>
            </div>
            <button type="button" class="deckbuilder__ghost-btn deckbuilder__clear-btn" data-action="clear-deck">清空</button>
          </header>

          <div class="deckbuilder__stats">
            <div class="deckbuilder__strength">
              <span class="deckbuilder__strength-num" data-stat-strength>0</span>
              <span class="deckbuilder__strength-label">总战力</span>
            </div>
            <div class="deckbuilder__meters">
              <div class="deckbuilder__meter" data-meter="units">
                <span class="deckbuilder__meter-label">单位</span>
                <span class="deckbuilder__meter-value" data-stat-units>0</span>
                <span class="deckbuilder__meter-limit" data-limit-units>/${MIN_UNITS}</span>
              </div>
              <div class="deckbuilder__meter" data-meter="specials">
                <span class="deckbuilder__meter-label">特殊</span>
                <span class="deckbuilder__meter-value" data-stat-specials>0</span>
                <span class="deckbuilder__meter-limit" data-limit-specials>/${MAX_SPECIALS}</span>
              </div>
              <div class="deckbuilder__meter" data-meter="total">
                <span class="deckbuilder__meter-label">总卡数</span>
                <span class="deckbuilder__meter-value" data-stat-total>0</span>
                <span class="deckbuilder__meter-limit">张</span>
              </div>
            </div>
          </div>

          <div class="deckbuilder__validity" data-validity aria-live="polite"></div>

          <div class="deckbuilder__deck-scroll" data-deck-scroll>
            <div class="deckbuilder__deck-list" data-deck-list></div>
          </div>

          <div class="deckbuilder__deck-foot">
            <button type="button" class="deckbuilder__primary-btn deckbuilder__start-wide" data-action="start" data-start-bottom disabled>开始对局</button>
            <p class="deckbuilder__start-hint" data-start-hint>牌组合法后方可开始</p>
          </div>
        </aside>
      </div>
    </div>

    <div class="deckbuilder__dialog-layer" data-dialog hidden>
      <div class="deckbuilder__dialog-backdrop" data-dialog-action="cancel"></div>
      <div class="deckbuilder__dialog" role="alertdialog" aria-modal="true" aria-labelledby="${uid}-dialog-title" aria-describedby="${uid}-dialog-desc">
        <h3 class="deckbuilder__dialog-title" id="${uid}-dialog-title"></h3>
        <p class="deckbuilder__dialog-desc" id="${uid}-dialog-desc"></p>
        <div class="deckbuilder__dialog-actions">
          <button type="button" class="deckbuilder__ghost-btn" data-dialog-action="cancel">取消</button>
          <button type="button" class="deckbuilder__primary-btn" data-dialog-action="confirm">确定</button>
        </div>
      </div>
    </div>

    <div class="deckbuilder__toast" data-toast role="status" aria-live="polite"></div>
  `;

  /* ------------------------------ 引用缓存 ------------------------------ */
  const q = (sel, root = el) => root.querySelector(sel);
  const qa = (sel, root = el) => Array.from(root.querySelectorAll(sel));

  const ui = {
    factionTabs: q("[data-faction-tabs]"),
    factionAbility: q("[data-faction-ability]"),
    leaders: q("[data-leaders]"),
    presets: q("[data-presets]"),
    lore: q("[data-lore]"),
    watermark: q("[data-watermark]"),
    collectionSummary: q("[data-collection-summary]"),
    filters: q("[data-filters]"),
    search: q("[data-search]"),
    sort: q("[data-sort]"),
    grid: q("[data-grid]"),
    gridEmpty: q("[data-grid-empty]"),
    gridScroll: q("[data-grid-scroll]"),
    deckFaction: q("[data-deck-faction]"),
    clearBtn: q(".deckbuilder__clear-btn"),
    statStrength: q("[data-stat-strength]"),
    statUnits: q("[data-stat-units]"),
    statSpecials: q("[data-stat-specials]"),
    statTotal: q("[data-stat-total]"),
    meterUnits: q('[data-meter="units"]'),
    meterSpecials: q('[data-meter="specials"]'),
    validity: q("[data-validity]"),
    deckList: q("[data-deck-list]"),
    deckScroll: q("[data-deck-scroll]"),
    startButtons: qa("[data-action='start']"),
    startHint: q("[data-start-hint]"),
    saveState: q("[data-save-state]"),
    dialogLayer: q("[data-dialog]"),
    dialogEl: q(".deckbuilder__dialog"),
    dialogTitle: q("[data-dialog] .deckbuilder__dialog-title"),
    dialogDesc: q("[data-dialog] .deckbuilder__dialog-desc"),
    dialogConfirm: q('.deckbuilder__dialog [data-dialog-action="confirm"]'),
    dialogCancel: q('.deckbuilder__dialog [data-dialog-action="cancel"]'),
    toast: q("[data-toast]"),
  };

  /* ------------------------------ 运行时状态 ------------------------------ */
  const state = {
    faction: null,
    leaderId: null,
    counts: new Map(), // cardId -> count（保留插入顺序）
    filter: "all",
    search: "",
    sort: "power-desc",
  };

  let store = null;
  let isOpen = false;
  let destroyed = false;
  let lastFocused = null;
  let dialogState = null;
  let toastTimer = 0;
  let searchTimer = 0;
  let saveFlashTimer = 0;
  const pendingTimers = new Set();

  let artKit = null;
  let artPromise = null;
  let cardRenderer = null;
  let rendererPromise = null;

  const later = (fn, ms) => {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      if (!destroyed) fn();
    }, ms);
    pendingTimers.add(timer);
    return timer;
  };

  /* ======================================================================== */
  /*  视觉模块加载                                                             */
  /* ======================================================================== */

  function ensureArtKit() {
    if (artKit) return Promise.resolve(artKit);
    if (!artPromise) {
      artPromise = tryImportModule("./art.js").then((mod) => {
        if (!mod || typeof mod.sigilMarkup !== "function") {
          artPromise = null;
          return null;
        }
        artKit = mod;
        try {
          mod.ensureArtSprite?.();
        } catch (_err) {
          /* 纹章 defs 注入失败不阻塞 */
        }
        return mod;
      });
    }
    return artPromise;
  }

  function ensureCardRenderer() {
    if (cardRenderer) return Promise.resolve(cardRenderer);
    if (!rendererPromise) {
      rendererPromise = tryImportModule("./card-render.js").then(async (mod) => {
        if (!mod || typeof mod.createCardEl !== "function") {
          rendererPromise = null;
          return null;
        }
        try {
          mod.initCardRenderer?.({ getCard, getLeader, getFaction });
        } catch (_err) {
          /* 初始化失败则退回占位卡 */
        }
        await ensureCardStylesheet();
        cardRenderer = mod;
        return mod;
      });
    }
    return rendererPromise;
  }

  // 任一视觉模块就绪（且组牌器正打开）→ 用新的视觉重建；未就绪时安静降级
  ensureArtKit().then((mod) => {
    if (mod && isOpen && !destroyed && state.faction) renderAll({ resetScroll: false });
  });
  ensureCardRenderer().then((mod) => {
    if (mod && isOpen && !destroyed && state.faction) renderCollection({ resetScroll: false });
  });

  /* ======================================================================== */
  /*  视觉辅助（带内置降级）                                                   */
  /* ======================================================================== */

  function sigilSvg(factionId, strokeWidth = 1.15) {
    if (artKit && typeof artKit.sigilMarkup === "function") {
      try {
        artKit.ensureArtSprite?.();
        const key = typeof artKit.factionKey === "function" ? artKit.factionKey(factionId) : "ne";
        return `<svg class="db-sigil" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><g fill="none" stroke="url(#gtf-gold)" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${artKit.sigilMarkup(key)}</g></svg>`;
      } catch (_err) {
        /* 退化为内置纹章 */
      }
    }
    const inner = FALLBACK_SIGILS[factionId] || FALLBACK_SIGILS.neutral;
    return `<svg class="db-sigil" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="${strokeWidth * 1.8}" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`;
  }

  function rowIconSvg(row) {
    if (artKit && typeof artKit.renderRowIcon === "function") {
      try {
        return artKit.renderRowIcon(row);
      } catch (_err) {
        /* ignore */
      }
    }
    const key = row === "melee" || row === "close-combat" ? "close" : row === "range" || row === "ranged-combat" ? "ranged" : row;
    const path = FALLBACK_ROW_ICONS[key] || FALLBACK_ROW_ICONS.close;
    return `<svg class="db-rune-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${path}</svg>`;
  }

  function abilityIconSvg(abilities) {
    if (artKit && typeof artKit.renderAbilityIcon === "function") {
      try {
        return artKit.renderAbilityIcon(abilities);
      } catch (_err) {
        /* ignore */
      }
    }
    return `<svg class="db-rune-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${FALLBACK_ROW_ICONS.special}</svg>`;
  }

  function leaderArtSvg(leader) {
    if (artKit && typeof artKit.renderLeaderArtSvg === "function") {
      try {
        return artKit.renderLeaderArtSvg(leader);
      } catch (_err) {
        /* ignore */
      }
    }
    return "";
  }

  function cardArtSvg(card) {
    if (artKit && typeof artKit.renderCardArtSvg === "function") {
      try {
        return artKit.renderCardArtSvg(card);
      } catch (_err) {
        /* ignore */
      }
    }
    return "";
  }

  function weatherKindOf(card) {
    const ability = (card.abilities || []).find((a) => a && a.id === "weather");
    return (ability && ability.weather) || "clear";
  }

  /* ======================================================================== */
  /*  数据辅助                                                                 */
  /* ======================================================================== */

  function deckIds() {
    const ids = [];
    for (const [id, count] of state.counts) {
      for (let i = 0; i < count; i += 1) ids.push(id);
    }
    return ids;
  }

  function totalCards() {
    let total = 0;
    for (const n of state.counts.values()) total += n;
    return total;
  }

  function getValidation() {
    return validateDeck(deckIds(), state.leaderId, state.faction);
  }

  function sanitizeCounts(factionId, map) {
    const out = new Map();
    for (const [id, raw] of map) {
      const card = getCard(id);
      if (!card || !card.deckable || !(card.copies > 0)) continue;
      if (card.faction !== factionId && card.faction !== "neutral") continue;
      const count = Math.max(0, Math.min(Math.floor(Number(raw) || 0), card.copies));
      if (count > 0) out.set(id, count);
    }
    return out;
  }

  function resolveLeader(leaderId, factionId) {
    const leader = leaderId ? getLeader(leaderId) : null;
    if (leader && leader.faction === factionId) return leader.id;
    const presets = getPresets(factionId);
    if (presets.length) {
      const presetLeader = getLeader(presets[0].leaderId);
      if (presetLeader && presetLeader.faction === factionId) return presetLeader.id;
    }
    const first = LEADER_LIST.find((l) => l.faction === factionId);
    return first ? first.id : null;
  }

  function defaultEntryFor(factionId) {
    const preset = getDefaultPreset(factionId);
    if (preset) {
      return {
        leaderId: preset.leaderId,
        cards: preset.cards.map(({ id, count }) => ({ id, count })),
      };
    }
    return { leaderId: resolveLeader(null, factionId), cards: [] };
  }

  function readStore() {
    const empty = { lastFaction: null, decks: {} };
    try {
      if (typeof localStorage === "undefined") return empty;
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return empty;
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return empty;
      const source = data.decks && typeof data.decks === "object" ? data.decks : {};
      const decks = {};
      for (const factionId of FACTION_IDS) {
        const entry = source[factionId];
        if (!entry || !Array.isArray(entry.cards)) continue;
        const cards = [];
        for (const item of entry.cards) {
          if (!item || typeof item.id !== "string") continue;
          const count = Math.floor(Number(item.count));
          if (!Number.isFinite(count) || count <= 0) continue;
          cards.push({ id: item.id, count });
        }
        let leaderId = typeof entry.leaderId === "string" ? entry.leaderId : null;
        const leader = leaderId ? getLeader(leaderId) : null;
        if (!leader || leader.faction !== factionId) leaderId = null;
        decks[factionId] = { leaderId, cards };
      }
      return {
        lastFaction: FACTION_IDS.includes(data.lastFaction) ? data.lastFaction : null,
        decks,
      };
    } catch (_err) {
      return empty;
    }
  }

  function persist() {
    if (!state.faction) return false;
    if (!store) store = readStore();
    store.lastFaction = state.faction;
    store.decks[state.faction] = {
      leaderId: state.leaderId,
      cards: Array.from(state.counts, ([id, count]) => ({ id, count })),
    };
    const decks = {};
    for (const factionId of FACTION_IDS) {
      const entry = store.decks[factionId];
      if (entry) decks[factionId] = { leaderId: entry.leaderId, cards: entry.cards };
    }
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: STORAGE_VERSION, lastFaction: store.lastFaction, decks })
      );
      markSaveState(true);
      return true;
    } catch (_err) {
      markSaveState(false);
      return false;
    }
  }

  function markSaveState(ok) {
    if (!ui.saveState) return;
    ui.saveState.textContent = ok ? "已自动保存" : "本地存储不可用";
    ui.saveState.classList.toggle("is-error", !ok);
    if (!ok) return;
    ui.saveState.classList.remove("is-flash");
    void ui.saveState.offsetWidth;
    ui.saveState.classList.add("is-flash");
    clearTimeout(saveFlashTimer);
    saveFlashTimer = later(() => ui.saveState.classList.remove("is-flash"), 900);
  }

  /* ======================================================================== */
  /*  渲染：外框 / 阵营 / 领袖 / 预设                                          */
  /* ======================================================================== */

  function applyFactionTheme() {
    const faction = getFaction(state.faction);
    if (!faction) return;
    const colors = faction.colors || {};
    el.style.setProperty("--db-faction", colors.primary || "var(--gold)");
    el.style.setProperty("--db-faction-glow", colors.glow || "var(--gold-bright)");
    el.style.setProperty("--db-faction-accent", colors.accent || "var(--gold)");
    el.dataset.faction = state.faction;
  }

  function renderFactionTabs() {
    ui.factionTabs.innerHTML = FACTION_IDS.map((factionId) => {
      const faction = getFaction(factionId);
      const active = factionId === state.faction;
      const colors = (faction && faction.colors) || {};
      return `<button type="button" class="deckbuilder__faction-tab${active ? " is-active" : ""}"
        data-action="faction" data-faction="${factionId}" aria-pressed="${active}"
        style="--db-tab-core:${esc(colors.primary || "#8b7d5c")};--db-tab-glow:${esc(colors.glow || "#d9cbb3")};--db-tab-accent:${esc(colors.accent || "#c9a227")}"
        title="${esc(faction ? `${faction.nameZh} · ${faction.abilityZh}` : factionId)}">
        <span class="deckbuilder__faction-sigil">${sigilSvg(factionId, 2.8)}</span>
        <span class="deckbuilder__faction-name">${esc((faction && (faction.shortZh || faction.nameZh)) || factionId)}</span>
      </button>`;
    }).join("");
  }

  function renderFactionAbility() {
    const faction = getFaction(state.faction);
    if (!faction) {
      ui.factionAbility.textContent = "";
      return;
    }
    ui.factionAbility.innerHTML = `<span class="deckbuilder__ability-tag">阵营能力</span><span class="deckbuilder__ability-text">${esc(
      faction.abilityZh || ""
    )}</span>`;
    ui.factionAbility.title = faction.abilityZh || "";
  }

  function renderWatermark() {
    ui.watermark.innerHTML = sigilSvg(state.faction);
  }

  function renderLeaders() {
    const leaders = LEADER_LIST.filter((leader) => leader.faction === state.faction);
    if (!leaders.length) {
      ui.leaders.innerHTML = `<p class="deckbuilder__muted">本阵营暂无领袖数据。</p>`;
      return;
    }
    ui.leaders.innerHTML = leaders
      .map((leader) => {
        const selected = leader.id === state.leaderId;
        const art = leaderArtSvg(leader);
        const portrait = art
          ? `<span class="deckbuilder__leader-art">${art}</span>`
          : `<span class="deckbuilder__leader-sigil">${sigilSvg(leader.faction, 2.2)}</span>`;
        return `<button type="button" class="deckbuilder__leader${selected ? " is-selected" : ""}"
          data-action="leader" data-leader="${leader.id}" aria-pressed="${selected}"
          title="${esc(`${leader.nameZh}\n${leader.abilityZh || ""}`)}">
          <span class="deckbuilder__leader-portrait">${portrait}</span>
          <span class="deckbuilder__leader-body">
            <span class="deckbuilder__leader-name">${esc(leader.nameZh)}</span>
            <span class="deckbuilder__leader-ability">${esc(leader.abilityZh || "")}</span>
          </span>
          ${selected ? `<span class="deckbuilder__leader-check">${ICONS.check}</span>` : ""}
        </button>`;
      })
      .join("");
  }

  function presetCounts(preset) {
    const map = new Map();
    for (const { id, count } of preset.cards || []) {
      map.set(id, (map.get(id) || 0) + (count || 0));
    }
    return map;
  }

  function presetMatches(preset) {
    if (!preset) return false;
    if (preset.leaderId !== state.leaderId) return false;
    const map = presetCounts(preset);
    if (map.size !== state.counts.size) return false;
    for (const [id, count] of map) {
      if (state.counts.get(id) !== count) return false;
    }
    return true;
  }

  function renderPresets() {
    const presets = getPresets(state.faction);
    if (!presets.length) {
      ui.presets.innerHTML = `<p class="deckbuilder__muted">本阵营暂无预设牌组。</p>`;
      return;
    }
    ui.presets.innerHTML = presets
      .map((preset) => {
        const ids = expandPreset(preset);
        const validation = validateDeck(ids, preset.leaderId, state.faction);
        const leader = getLeader(preset.leaderId);
        const current = presetMatches(preset);
        return `<article class="deckbuilder__preset${current ? " is-current" : ""}">
          <div class="deckbuilder__preset-head">
            <h3 class="deckbuilder__preset-name">${esc(preset.nameZh)}</h3>
            <span class="deckbuilder__preset-meta">${ids.length} 张 · 战力 ${validation.stats.strength}</span>
          </div>
          <p class="deckbuilder__preset-desc">${esc(preset.descZh || "")}</p>
          <div class="deckbuilder__preset-foot">
            <span class="deckbuilder__preset-leader">${esc((leader && leader.nameZh) || "")}</span>
            <button type="button" class="deckbuilder__preset-load" data-action="load-preset" data-preset-id="${esc(
              preset.id
            )}" ${current ? "disabled" : ""}>${current ? "当前" : "载入"}</button>
          </div>
        </article>`;
      })
      .join("");
  }

  function renderLore() {
    if (!ui.lore) return;
    const faction = getFaction(state.faction);
    ui.lore.textContent = (faction && faction.loreZh) || "";
  }

  /* ======================================================================== */
  /*  渲染：收藏区                                                             */
  /* ======================================================================== */

  function matchesFilter(card, filter) {
    switch (filter) {
      case "unit":
        return card.type === "unit" && !card.hero;
      case "hero":
        return card.hero === true;
      case "special":
        return card.type === "special";
      case "weather":
        return card.type === "weather";
      default:
        return true;
    }
  }

  function matchesSearch(card, query) {
    if (!query) return true;
    const haystack = [card.nameZh, card.nameEn, card.id, card.abilityZh, card.abilityEn]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return haystack.includes(query.toLowerCase());
  }

  function sortCards(list, sortId) {
    const next = list.slice();
    switch (sortId) {
      case "power-asc":
        next.sort((a, b) => (a.strength || 0) - (b.strength || 0) || compareName(a, b));
        break;
      case "name":
        next.sort(compareName);
        break;
      case "default":
        break;
      case "power-desc":
      default:
        next.sort((a, b) => (b.strength || 0) - (a.strength || 0) || compareName(a, b));
        break;
    }
    return next;
  }

  function filterCounts(full) {
    const counts = { all: full.length, unit: 0, hero: 0, special: 0, weather: 0 };
    for (const card of full) {
      if (card.type === "unit" && !card.hero) counts.unit += 1;
      if (card.hero) counts.hero += 1;
      if (card.type === "special") counts.special += 1;
      if (card.type === "weather") counts.weather += 1;
    }
    return counts;
  }

  function renderFilterTabs() {
    const full = collectionFor(state.faction);
    const counts = filterCounts(full);
    for (const filter of FILTERS) {
      const countEl = q(`[data-filter-count="${filter.id}"]`);
      if (countEl) countEl.textContent = counts[filter.id] ?? 0;
    }
    syncFilterTabs();
  }

  function syncFilterTabs() {
    for (const btn of qa("[data-action='filter']")) {
      const active = btn.dataset.filter === state.filter;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    }
  }

  function fallbackCardMarkup(card) {
    const art = cardArtSvg(card);
    const className = [
      "db-fallback",
      `db-fallback--${card.type}`,
      card.hero ? "db-fallback--hero" : "",
      art ? "has-art" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const rows =
      card.type === "unit"
        ? (card.rows || ["close"]).map((row) => rowIconSvg(row)).join("")
        : "";
    let corner;
    if (card.type === "unit") {
      corner = `<span class="db-fallback__power${card.hero ? " is-hero" : ""}">${card.strength ?? 0}</span>`;
    } else if (card.type === "weather") {
      corner = `<span class="db-fallback__rune">${rowIconSvg(weatherKindOf(card))}</span>`;
    } else {
      corner = `<span class="db-fallback__rune">${abilityIconSvg(card.abilities)}</span>`;
    }
    return `<div class="${className}" data-faction="${esc(card.faction)}">
      ${art ? `<span class="db-fallback__art">${art}</span>` : `<span class="db-fallback__sigil">${sigilSvg(card.faction, 2.2)}</span>`}
      <span class="db-fallback__veil" aria-hidden="true"></span>
      <span class="db-fallback__name">${esc(card.nameZh)}</span>
      <span class="db-fallback__rows">${rows}</span>
      ${corner}
    </div>`;
  }

  function renderCollection({ resetScroll = false } = {}) {
    if (!state.faction) return;
    const full = collectionFor(state.faction);
    const query = state.search.trim();
    const filtered = full.filter((card) => matchesFilter(card, state.filter) && matchesSearch(card, query));
    const list = sortCards(filtered, state.sort);

    const faction = getFaction(state.faction);
    const filterLabel = (FILTERS.find((f) => f.id === state.filter) || FILTERS[0]).label;
    ui.collectionSummary.textContent = `${faction ? faction.nameZh : ""} · ${filterLabel} ${list.length} / ${full.length} 张`;

    const previousScroll = ui.gridScroll.scrollTop;
    ui.grid.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const card of list) fragment.appendChild(createCardTile(card));
    ui.grid.appendChild(fragment);

    if (list.length === 0) {
      ui.gridEmpty.hidden = false;
      ui.gridEmpty.innerHTML = `<span class="deckbuilder__empty-ornament" aria-hidden="true"></span><p>没有找到符合条件的卡牌。</p><p class="deckbuilder__muted">试试更换筛选，或清空搜索关键词。</p>`;
    } else {
      ui.gridEmpty.hidden = true;
      ui.gridEmpty.innerHTML = "";
    }

    ui.gridScroll.scrollTop = resetScroll ? 0 : previousScroll;
  }

  function createCardTile(card) {
    const picked = state.counts.get(card.id) || 0;
    const max = card.copies;

    const frame = document.createElement("div");
    frame.className = "deckbuilder__card";
    frame.dataset.cardId = card.id;
    frame.dataset.type = card.type;
    if (card.hero) frame.dataset.hero = "true";
    if (picked > 0) frame.classList.add("is-picked");
    if (picked >= max) frame.classList.add("is-maxed");
    frame.title = `${card.nameZh}${card.nameEn ? ` · ${card.nameEn}` : ""}\n已选 ${picked} / ${max} 张${
      card.abilityZh ? `\n${card.abilityZh}` : ""
    }`;

    const visual = document.createElement("div");
    visual.className = "deckbuilder__card-visual";
    let cardEl = null;
    if (cardRenderer) {
      try {
        cardEl = cardRenderer.createCardEl(card, {
          size: "sm",
          interactive: true,
          className: "deckbuilder__card-render",
        });
      } catch (_err) {
        cardEl = null;
      }
    }
    if (cardEl && cardEl instanceof HTMLElement) {
      visual.appendChild(cardEl);
    } else {
      visual.innerHTML = fallbackCardMarkup(card);
    }
    frame.appendChild(visual);

    const badge = document.createElement("span");
    badge.className = "deckbuilder__card-badge";
    badge.dataset.pickedBadge = "";
    badge.textContent = picked > 0 ? `${picked}/${max}` : `×${max}`;
    badge.title = `已选 ${picked} 张 / 收藏份数 ${max} 张`;
    frame.appendChild(badge);

    const controls = document.createElement("div");
    controls.className = "deckbuilder__card-controls";
    controls.innerHTML = `
      <button type="button" class="deckbuilder__card-btn" data-action="card-remove" data-card-id="${esc(card.id)}"
        aria-label="减少一张「${esc(card.nameZh)}」" ${picked > 0 ? "" : "disabled"}>${ICONS.minus}</button>
      <span class="deckbuilder__card-count" data-picked-count>${picked}</span>
      <button type="button" class="deckbuilder__card-btn" data-action="card-add" data-card-id="${esc(card.id)}"
        aria-label="增加一张「${esc(card.nameZh)}」" ${picked >= max ? "disabled" : ""}>${ICONS.plus}</button>`;
    frame.appendChild(controls);

    return frame;
  }

  function syncCardTiles() {
    for (const frame of qa(".deckbuilder__card", ui.grid)) {
      const card = getCard(frame.dataset.cardId);
      if (!card) continue;
      const picked = state.counts.get(card.id) || 0;
      frame.classList.toggle("is-picked", picked > 0);
      frame.classList.toggle("is-maxed", picked >= card.copies);
      const badge = q("[data-picked-badge]", frame);
      if (badge) {
        badge.textContent = picked > 0 ? `${picked}/${card.copies}` : `×${card.copies}`;
        badge.title = `已选 ${picked} 张 / 收藏份数 ${card.copies} 张`;
      }
      const countEl = q("[data-picked-count]", frame);
      if (countEl) countEl.textContent = picked;
      const minus = q('[data-action="card-remove"]', frame);
      if (minus) minus.disabled = picked <= 0;
      const plus = q('[data-action="card-add"]', frame);
      if (plus) plus.disabled = picked >= card.copies;
      if (picked === 0 && document.activeElement === plus) {
        /* 焦点保持 */
      }
    }
  }

  function pulseCardTile(cardId) {
    const frame = qa(".deckbuilder__card", ui.grid).find((item) => item.dataset.cardId === cardId);
    if (!frame) return;
    frame.classList.remove("is-pulsing");
    void frame.offsetWidth;
    frame.classList.add("is-pulsing");
    frame.addEventListener("animationend", () => frame.classList.remove("is-pulsing"), { once: true });
  }

  /* ======================================================================== */
  /*  渲染：牌组区                                                             */
  /* ======================================================================== */

  function renderDeckList() {
    const faction = getFaction(state.faction);
    const units = [];
    const others = [];
    for (const [id, count] of state.counts) {
      const card = getCard(id);
      if (!card) continue;
      (card.type === "unit" ? units : others).push({ card, count });
    }
    const unitTotal = units.reduce((sum, item) => sum + item.count, 0);
    const otherTotal = others.reduce((sum, item) => sum + item.count, 0);
    const total = unitTotal + otherTotal;

    if (ui.deckFaction) {
      ui.deckFaction.textContent = `${(faction && faction.nameZh) || ""}${total ? ` · ${total} 张` : ""}`;
    }
    if (ui.clearBtn) ui.clearBtn.disabled = total === 0;

    if (total === 0) {
      ui.deckList.innerHTML = `<div class="deckbuilder__deck-empty">
        <span class="deckbuilder__empty-ornament" aria-hidden="true"></span>
        <p>尚未选择卡牌。</p>
        <p class="deckbuilder__muted">从收藏中挑选，或载入一套预设牌组。</p>
      </div>`;
      return;
    }

    const groupHtml = (label, items, sum) => {
      if (!items.length) return "";
      return `<div class="deckbuilder__deck-group">
        <div class="deckbuilder__deck-group-head"><span>${label}</span><em>${sum}</em><i aria-hidden="true"></i></div>
        ${items.map((item) => deckRowHtml(item)).join("")}
      </div>`;
    };

    ui.deckList.innerHTML = groupHtml("单位", units, unitTotal) + groupHtml("特殊 / 天气", others, otherTotal);
  }

  function deckRowHtml({ card, count }) {
    let power;
    if (card.type === "unit") {
      power = `<span class="deckbuilder__deck-power${card.hero ? " is-hero" : ""}">${card.strength ?? 0}</span>`;
    } else if (card.type === "weather") {
      power = `<span class="deckbuilder__deck-power is-rune">${rowIconSvg(weatherKindOf(card))}</span>`;
    } else {
      power = `<span class="deckbuilder__deck-power is-rune">${abilityIconSvg(card.abilities)}</span>`;
    }
    const tags = [
      card.hero ? `<span class="deckbuilder__deck-tag is-hero">英雄</span>` : "",
      card.type === "weather" ? `<span class="deckbuilder__deck-tag is-weather">天气</span>` : "",
      card.type === "special" ? `<span class="deckbuilder__deck-tag">特殊</span>` : "",
    ]
      .filter(Boolean)
      .join("");
    return `<div class="deckbuilder__deck-row">
      ${power}
      <span class="deckbuilder__deck-name" title="${esc(card.abilityZh || card.nameZh)}">${esc(card.nameZh)}</span>
      ${tags}
      <span class="deckbuilder__deck-count">×${count}</span>
      <button type="button" class="deckbuilder__deck-remove" data-action="deck-remove" data-card-id="${esc(
        card.id
      )}" aria-label="从牌组移除一张「${esc(card.nameZh)}」" title="移除一张">${ICONS.minus}</button>
    </div>`;
  }

  function renderValidity(validation) {
    if (validation.ok) {
      ui.validity.className = "deckbuilder__validity is-ok";
      ui.validity.innerHTML = `<p class="deckbuilder__validity-ok">${ICONS.check}<span>牌组合法，可以开始对局。</span></p>`;
      return;
    }
    ui.validity.className = "deckbuilder__validity is-invalid";
    ui.validity.innerHTML = `<p class="deckbuilder__validity-title">牌组尚不可用</p><ul class="deckbuilder__validity-list">${validation.errors
      .map((error) => `<li>${esc(error)}</li>`)
      .join("")}</ul>`;
  }

  function renderStats() {
    const validation = getValidation();
    const stats = validation.stats;

    ui.statStrength.textContent = String(stats.strength);
    ui.statUnits.textContent = String(stats.units);
    ui.statSpecials.textContent = String(stats.specials);
    ui.statTotal.textContent = String(stats.total);

    ui.meterUnits.classList.toggle("is-short", stats.units < MIN_UNITS);
    ui.meterUnits.classList.toggle("is-met", stats.units >= MIN_UNITS);
    ui.meterSpecials.classList.toggle("is-over", stats.specials > MAX_SPECIALS);

    renderValidity(validation);

    for (const button of ui.startButtons) {
      button.disabled = !validation.ok;
      button.title = validation.ok ? "开始对局" : "牌组尚未合法，无法开始对局";
    }
    ui.startHint.textContent = validation.ok ? "牌组合法，可以开始对局" : "请按提示修正牌组后开始";
    ui.startHint.classList.toggle("is-ok", validation.ok);

    return validation;
  }

  function renderAll({ resetScroll = false } = {}) {
    if (!state.faction) return;
    applyFactionTheme();
    renderFactionTabs();
    renderFactionAbility();
    renderWatermark();
    renderLeaders();
    renderPresets();
    renderLore();
    renderFilterTabs();
    renderCollection({ resetScroll });
    renderDeckList();
    renderStats();
  }

  /* ======================================================================== */
  /*  交互：牌组增减 / 领袖 / 阵营 / 预设                                       */
  /* ======================================================================== */

  function changeCard(cardId, delta) {
    const card = getCard(cardId);
    if (!card || !card.deckable) return;
    const current = state.counts.get(cardId) || 0;
    let next = current + delta;
    if (delta > 0) next = Math.min(next, card.copies);
    if (delta < 0) next = Math.max(next, 0);
    if (next === current) return;

    if (next === 0) state.counts.delete(cardId);
    else state.counts.set(cardId, next);

    persist();
    syncCardTiles();
    renderDeckList();
    renderStats();
    renderPresets();
    if (delta > 0) pulseCardTile(cardId);
  }

  function selectFaction(factionId) {
    if (!FACTION_IDS.includes(factionId) || factionId === state.faction) return;
    persist();
    hydrateFaction(factionId);
    persist();
    showToast(`已切换至「${getFaction(factionId).nameZh}」`);
  }

  function selectLeader(leaderId) {
    const leader = getLeader(leaderId);
    if (!leader || leader.faction !== state.faction || leader.id === state.leaderId) return;
    state.leaderId = leader.id;
    persist();
    renderLeaders();
    renderStats();
    renderPresets();
  }

  async function clearDeck() {
    if (totalCards() === 0) {
      showToast("牌组已是空的");
      return;
    }
    const confirmed = await openConfirm({
      title: "清空牌组",
      message: "将移除当前牌组中的全部卡牌，此操作不可撤销。",
      confirmLabel: "清空牌组",
      cancelLabel: "保留",
      danger: true,
    });
    if (!confirmed) return;
    state.counts.clear();
    persist();
    syncCardTiles();
    renderDeckList();
    renderStats();
    renderPresets();
    showToast("牌组已清空");
  }

  async function loadPreset(presetId) {
    const preset = getPresets(state.faction).find((item) => item.id === presetId);
    if (!preset) return;
    if (presetMatches(preset)) {
      showToast(`当前牌组已是「${preset.nameZh}」`);
      return;
    }
    if (totalCards() > 0) {
      const confirmed = await openConfirm({
        title: "载入预设牌组",
        message: `载入「${preset.nameZh}」将覆盖当前 ${totalCards()} 张的牌组，是否继续？`,
        confirmLabel: "载入并覆盖",
        cancelLabel: "取消",
      });
      if (!confirmed) return;
    }
    const counts = new Map();
    for (const { id, count } of preset.cards) {
      counts.set(id, (counts.get(id) || 0) + count);
    }
    state.counts = sanitizeCounts(state.faction, counts);
    state.leaderId = resolveLeader(preset.leaderId, state.faction);
    persist();
    renderAll({ resetScroll: true });
    ui.deckScroll.scrollTop = 0;
    showToast(`已载入预设「${preset.nameZh}」`);
  }

  function hydrateFaction(factionId) {
    const faction = getFaction(factionId);
    if (!faction || !FACTION_IDS.includes(factionId)) return;
    state.faction = factionId;
    const entry = (store && store.decks && store.decks[factionId]) || defaultEntryFor(factionId);
    const counts = new Map();
    for (const { id, count } of entry.cards || []) {
      counts.set(id, (counts.get(id) || 0) + count);
    }
    state.counts = sanitizeCounts(factionId, counts);
    state.leaderId = resolveLeader(entry.leaderId, factionId);
    renderAll({ resetScroll: true });
    ui.deckScroll.scrollTop = 0;
  }

  /* ======================================================================== */
  /*  交互：开始对局 / 返回                                                    */
  /* ======================================================================== */

  function startGame() {
    const validation = getValidation();
    if (!validation.ok) {
      renderStats();
      showToast("牌组尚未合法，无法开始对局");
      return;
    }
    persist();
    const config = { faction: state.faction, leaderId: state.leaderId, cards: deckIds() };
    if (!onPlay) {
      showToast(`已生成对局配置（${config.cards.length} 张），但未提供 onPlay 回调`);
      return;
    }
    try {
      onPlay(config);
    } catch (err) {
      if (typeof console !== "undefined") console.warn("[deckbuilder] onPlay 回调出错：", err);
    }
  }

  function goBack() {
    close();
    if (onBack) {
      try {
        onBack();
      } catch (err) {
        if (typeof console !== "undefined") console.warn("[deckbuilder] onBack 回调出错：", err);
      }
    }
  }

  /* ======================================================================== */
  /*  对话框 / 提示                                                            */
  /* ======================================================================== */

  function openConfirm({ title, message, confirmLabel = "确定", cancelLabel = "取消", danger = false }) {
    return new Promise((resolve) => {
      if (dialogState) closeDialog(false);
      dialogState = { resolve, previousFocus: document.activeElement };
      ui.dialogTitle.textContent = title || "请确认";
      ui.dialogDesc.textContent = message || "";
      ui.dialogConfirm.textContent = confirmLabel;
      ui.dialogCancel.textContent = cancelLabel;
      ui.dialogConfirm.classList.toggle("is-danger", !!danger);
      ui.dialogLayer.hidden = false;
      requestAnimationFrame(() => {
        if (!dialogState) return;
        ui.dialogLayer.classList.add("is-open");
        const focusTarget = danger ? ui.dialogCancel : ui.dialogConfirm;
        try {
          focusTarget.focus({ preventScroll: true });
        } catch (_err) {
          /* ignore */
        }
      });
    });
  }

  function closeDialog(result) {
    if (!dialogState) return;
    const { resolve, previousFocus } = dialogState;
    dialogState = null;
    ui.dialogLayer.classList.remove("is-open");
    ui.dialogLayer.hidden = true;
    resolve(!!result);
    try {
      if (previousFocus && typeof previousFocus.focus === "function" && document.contains(previousFocus)) {
        previousFocus.focus({ preventScroll: true });
      }
    } catch (_err) {
      /* ignore */
    }
  }

  function showToast(text) {
    if (!text) return;
    ui.toast.textContent = text;
    ui.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = later(() => ui.toast.classList.remove("is-visible"), 2000);
  }

  /* ======================================================================== */
  /*  事件绑定                                                                 */
  /* ======================================================================== */

  function onElClick(event) {
    const actionEl = event.target.closest("[data-action]");
    if (!actionEl || !el.contains(actionEl)) return;
    const action = actionEl.dataset.action;
    switch (action) {
      case "back":
        goBack();
        break;
      case "save": {
        const ok = persist();
        showToast(ok ? "牌组已保存到本地" : "无法保存：浏览器本地存储不可用");
        break;
      }
      case "start":
        startGame();
        break;
      case "faction":
        selectFaction(actionEl.dataset.faction);
        break;
      case "leader":
        selectLeader(actionEl.dataset.leader);
        break;
      case "filter": {
        const filter = actionEl.dataset.filter;
        if (state.filter === filter) break;
        state.filter = filter;
        syncFilterTabs();
        renderCollection({ resetScroll: true });
        break;
      }
      case "card-add":
        changeCard(actionEl.dataset.cardId, 1);
        break;
      case "card-remove":
        changeCard(actionEl.dataset.cardId, -1);
        break;
      case "deck-remove":
        changeCard(actionEl.dataset.cardId, -1);
        break;
      case "clear-deck":
        clearDeck();
        break;
      case "load-preset":
        loadPreset(actionEl.dataset.presetId);
        break;
      default:
        break;
    }
  }

  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = later(() => {
      state.search = ui.search.value.trim();
      renderCollection({ resetScroll: true });
    }, 120);
  }

  function onSearchKeydown(event) {
    if (event.key === "Escape" && ui.search.value) {
      event.stopPropagation();
      ui.search.value = "";
      state.search = "";
      renderCollection({ resetScroll: true });
    }
  }

  function onSortChange() {
    state.sort = ui.sort.value;
    renderCollection({ resetScroll: true });
  }

  function onWindowKeydown(event) {
    if (!isOpen || destroyed) return;
    if (event.key !== "Escape") return;
    if (event.target === ui.search && ui.search.value) return; // 搜索框内 Esc 由输入框处理
    if (dialogState) {
      event.preventDefault();
      event.stopPropagation();
      closeDialog(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    goBack();
  }

  function onDialogClick(event) {
    const actionEl = event.target.closest("[data-dialog-action]");
    if (!actionEl) return;
    closeDialog(actionEl.dataset.dialogAction === "confirm");
  }

  function onDialogKeydown(event) {
    if (!dialogState || event.key !== "Tab") return;
    const focusables = qa("button:not([disabled])", ui.dialogEl);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  el.addEventListener("click", onElClick);
  ui.search.addEventListener("input", onSearchInput);
  ui.search.addEventListener("keydown", onSearchKeydown);
  ui.sort.addEventListener("change", onSortChange);
  ui.dialogLayer.addEventListener("click", onDialogClick);
  ui.dialogLayer.addEventListener("keydown", onDialogKeydown);

  /* ======================================================================== */
  /*  生命周期                                                                 */
  /* ======================================================================== */

  function open(factionId) {
    if (destroyed) return;
    store = readStore();
    const savedFaction = store.lastFaction;
    let target = DEFAULT_FACTION;
    if (FACTION_IDS.includes(factionId)) target = factionId;
    else if (FACTION_IDS.includes(state.faction)) target = state.faction;
    else if (savedFaction) target = savedFaction;

    hydrateFaction(target);

    isOpen = true;
    lastFocused = document.activeElement;
    el.classList.remove("deckbuilder--closed");
    el.setAttribute("aria-hidden", "false");
    window.addEventListener("keydown", onWindowKeydown, true);
    requestAnimationFrame(() => {
      if (!destroyed && isOpen) el.classList.add("is-visible");
    });
    try {
      el.focus({ preventScroll: true });
    } catch (_err) {
      /* ignore */
    }

    // 视觉模块可能在本页面首次打开后才就绪：每次打开时安静重试一次
    if (!artKit) {
      ensureArtKit().then((mod) => {
        if (mod && isOpen && !destroyed && state.faction) renderAll({ resetScroll: false });
      });
    }
    if (!cardRenderer) {
      ensureCardRenderer().then((mod) => {
        if (mod && isOpen && !destroyed && state.faction) renderCollection({ resetScroll: false });
      });
    }
  }

  function close() {
    if (!isOpen || destroyed) return;
    persist();
    isOpen = false;
    closeDialog(false);
    el.classList.remove("is-visible");
    el.classList.add("deckbuilder--closed");
    el.setAttribute("aria-hidden", "true");
    window.removeEventListener("keydown", onWindowKeydown, true);
    clearTimeout(toastTimer);
    ui.toast.classList.remove("is-visible");
    try {
      if (lastFocused && typeof lastFocused.focus === "function" && document.contains(lastFocused)) {
        lastFocused.focus({ preventScroll: true });
      }
    } catch (_err) {
      /* ignore */
    }
  }

  function destroy() {
    if (destroyed) return;
    close();
    destroyed = true;
    window.removeEventListener("keydown", onWindowKeydown, true);
    closeDialog(false);
    clearTimeout(searchTimer);
    clearTimeout(toastTimer);
    clearTimeout(saveFlashTimer);
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    el.remove();
  }

  // 初始化排序/筛选控件
  ui.sort.value = state.sort;
  for (const limitEl of qa("[data-limit-units]")) limitEl.textContent = `/${MIN_UNITS}`;
  for (const limitEl of qa("[data-limit-specials]")) limitEl.textContent = `/${MAX_SPECIALS}`;

  return { el, open, close, destroy };
}

export default createDeckBuilder;
