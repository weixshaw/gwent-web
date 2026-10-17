// ============================================================================
//  src/ui/fx.js · 昆特牌 · 全屏视觉特效层
//  Owner: vfx   Contract: docs/ARCHITECTURE.md §7, docs/ART_DIRECTION.md §5/§7
//  ---------------------------------------------------------------------------
//  设计原则
//   · 服务信息：先让玩家看清发生了什么（位置/分数），再叠氛围。
//   · 不阻塞：所有动画返回 Promise，内部 Promise.race 超时兜底（大事件 ≤2.5s），
//     任何异常 catch 后 resolve；粒子 canvas 与 DOM 层均 pointer-events:none。
//   · 性能：单 rAF 循环、固定粒子池（≤800）、预渲染 sprite、页面隐藏暂停、
//     prefers-reduced-motion 降级为淡入淡出。
//   · 解耦：不依赖 board / card-render 的内部结构；只消费传入的元素、rect，
//     以及可选的数据属性（data-uid / data-fx-row / data-fx-deck / ...）。
//
//  集成约定（Lead 的 app.js / board.js）
//   · init({ root, canvas?, getCardRect?, faction?, eventEffects?:'lite'|'full'|'off',
//            eventAudio?:boolean, menuAmbient?:boolean })
//     canvas 省略时自动复用 index.html 的 #fx-canvas；无则创建 fixed 全屏画布。
//   · DOM 定位：优先 ctx.board.getCardEl / getRowEl / getDeckEl / getGraveyardEl / getLeaderEl，
//     回退 data 属性：[data-uid] / [data-fx-row][data-fx-player] / [data-fx-deck] /
//     [data-fx-grave] / [data-fx-leader]（board.js 已提供）。
//   · cardPlay 的 toEl 既支持「目标卡牌元素」也支持「目标行容器」（行容器时按
//     --board-card-w/h + flex 居中布局推算新牌槽位）。
//   · 音效分工：onEvent 统一播放引擎事件音效（事件驱动）；直接调用 fx.* 不发声。
//     UI 点击/hover 由 menu/board 自行 audio.play('ui-click'/'ui-hover')。
//   · 事件驱动的重特效默认 'lite'（轻量提示 + 音频）；如 board 不再显式调用
//     fx.cardPlay 等精细动画，可传 eventEffects:'full' 交给 onEvent 全权驱动。
// ============================================================================

import { audio } from './audio.js';

// ---------------------------------------------------------------- constants
const MAX_PARTICLES = 800;   // 全屏粒子硬上限（ART_DIRECTION §7）
const MAX_BOLTS = 4;
const MAX_BEAMS = 8;
const MAX_ROOTS = 3;
const TAU = Math.PI * 2;
const DEFAULT_CARD_W = 132;
const DEFAULT_CARD_H = 184;

const FACTION_TOKENS = {
  'northern-realms': ['--nr', '--nr-glow', '#4d7ea8', '#9cc4e4'],
  nilfgaard: ['--ng', '--ng-glow', '#c9a227', '#f0d078'],
  scoiatael: ['--st', '--st-glow', '#2f7a4a', '#a8e0a0'],
  monsters: ['--mo', '--mo-glow', '#8a2323', '#ff6b5a'],
  skellige: ['--sk', '--sk-glow', '#2f6f6a', '#9adfd6'],
  neutral: ['--neutral', '--neutral-glow', '#8b7d5c', '#d9cbb3'],
};
const FACTION_NAMES = {
  'northern-realms': '北方领域',
  nilfgaard: '尼弗迦德帝国',
  scoiatael: '松鼠党',
  monsters: '怪物',
  skellige: '史凯利格',
  neutral: '中立',
};
const WEATHER_FLASH = {
  frost: ['#cfe9ff', 0.15],
  fog: ['#cfc9ba', 0.1],
  rain: ['#9db8d0', 0.08],
  storm: ['#b9c7ff', 0.2],
  clear: ['#ffe2a0', 0.12],
};

// ------------------------------------------------------------------- state
let initialized = false;
let config = {};
let rootEl = null;
let ownsCanvas = false;
let canvasEl = null;
let ctx2d = null;
let dom = null;
let W = 0;
let H = 0;
let dpr = 1;
let reducedMotion = false;
let reducedQuery = null;
let faction = { id: 'neutral', color: '#c9a227', glow: '#f0d078', name: '中立' };

// particles / transient systems
const pool = [];
let count = 0;
let beams = [];
let bolts = [];
let roots = [];
const sprites = Object.create(null);
const colorSpriteCache = new Map();
const weather = { frost: false, fog: false, rain: false, storm: false };
let ambientOn = false;
let stormTimer = 0;
const spawnAcc = { frost: 0, rain: 0, fog: 0, ember: 0 };

// loop
let running = false;
let rafId = 0;
let lastTime = 0;
let fps = 60;
let fpsFrames = 0;
let fpsTime = 0;

// misc
const pendingTimers = new Set();
const warnedOnce = new Set();
let lastBannerAt = 0;
let lastBannerKind = '';
let lastGameOverAt = 0;
let lastCoinAt = 0;

const TEMPLATE = Object.freeze({
  kind: 'sprite',
  sprite: 'gold',
  x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, drag: 0,
  size: 6, sizeEnd: 0, rot: 0, vr: 0,
  life: 1, max: 1, alpha: 1, blend: 'lighter',
  len: 0, r: 0, grow: 0, width: 1, color: '#f0d078',
  sx: 0, sy: 0, cx: 0, cy: 0, ex: 0, ey: 0, t: 0,
});

for (let i = 0; i < MAX_PARTICLES; i += 1) pool.push({});

// ============================================================================
//  utils
// ============================================================================
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function warnOnce(key, err) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  try {
    console.warn('[fx]', key, err || '');
  } catch {
    /* noop */
  }
}

function later(fn, ms) {
  const id = setTimeout(() => {
    pendingTimers.delete(id);
    try {
      fn();
    } catch (err) {
      warnOnce('timer', err);
    }
  }, Math.max(0, ms));
  pendingTimers.add(id);
  return id;
}

function div(className) {
  const el = document.createElement('div');
  if (className) el.className = className;
  return el;
}

function cssEscape(value) {
  const str = String(value == null ? '' : value);
  try {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(str);
  } catch {
    /* noop */
  }
  return str.replace(/["\\\]]/g, '\\$&');
}

function safeQuery(selector) {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function readCssVar(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

function readVarFrom(el, name) {
  if (!el || el.nodeType !== 1) return 0;
  try {
    return parseFloat(getComputedStyle(el).getPropertyValue(name)) || 0;
  } catch {
    return 0;
  }
}

function parseHex(hex) {
  const value = String(hex || '').trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short) return [parseInt(short[1] + short[1], 16), parseInt(short[2] + short[2], 16), parseInt(short[3] + short[3], 16)];
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (long) return [parseInt(long[1], 16), parseInt(long[2], 16), parseInt(long[3], 16)];
  return null;
}

function rgba(color, alpha = 1) {
  const rgb = parseHex(color);
  const a = clamp(alpha, 0, 1);
  if (!rgb) return `rgba(201, 162, 39, ${a})`;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

function mixHex(hex, target = '#ffffff', amount = 0.5) {
  const a = parseHex(hex);
  const b = parseHex(target);
  if (!a || !b) return hex;
  const t = clamp(amount, 0, 1);
  const toHex = (n) => Math.round(n).toString(16).padStart(2, '0');
  return '#' + toHex(lerp(a[0], b[0], t)) + toHex(lerp(a[1], b[1], t)) + toHex(lerp(a[2], b[2], t));
}

function getFactionColors(factionId) {
  const id = FACTION_TOKENS[factionId] ? factionId : 'neutral';
  const [cVar, gVar, cFallback, gFallback] = FACTION_TOKENS[id];
  return {
    id,
    color: readCssVar(cVar, cFallback),
    glow: readCssVar(gVar, gFallback),
    name: FACTION_NAMES[id] || '中立',
  };
}

// ---- rect helpers -----------------------------------------------------------
function normRect(rect) {
  if (!rect) return null;
  const raw = {
    x: isNum(rect.x) ? rect.x : rect.left,
    y: isNum(rect.y) ? rect.y : rect.top,
    w: isNum(rect.w) ? rect.w : isNum(rect.width) ? rect.width : 0,
    h: isNum(rect.h) ? rect.h : isNum(rect.height) ? rect.height : 0,
  };
  const x = Number(raw.x);
  const y = Number(raw.y);
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function rectOf(el) {
  if (!el || el.nodeType !== 1) return null;
  try {
    return normRect(el.getBoundingClientRect());
  } catch {
    return null;
  }
}

function rectCenter(rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function viewCenterRect() {
  return { x: W / 2 - DEFAULT_CARD_W / 2, y: H / 2 - DEFAULT_CARD_H / 2, w: DEFAULT_CARD_W, h: DEFAULT_CARD_H };
}

function fallbackCardRect(cx = 0.5, cy = 0.5) {
  return { x: W * cx - DEFAULT_CARD_W / 2, y: H * cy - DEFAULT_CARD_H / 2, w: DEFAULT_CARD_W, h: DEFAULT_CARD_H };
}

function quadPoint(a, c, b, t) {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

function pageRectOr(el, fallback) {
  return rectOf(el) || fallback;
}

// ---- el / board discovery ----------------------------------------------------
function normalizeEls(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((el) => el && el.nodeType === 1);
  if (typeof value === 'object' && typeof value.length === 'number' && typeof value !== 'string') {
    return Array.from(value).filter((el) => el && el.nodeType === 1);
  }
  return value && value.nodeType === 1 ? [value] : [];
}

function resolveElArg(arg, keys = ['el', 'rowEl', 'toRowEl', 'fromEl', 'tokenEl']) {
  if (!arg) return null;
  if (arg.nodeType === 1) return arg;
  if (typeof arg === 'object') {
    for (const key of keys) if (arg[key] && arg[key].nodeType === 1) return arg[key];
  }
  return null;
}

function board(ctx) {
  return ctx && ctx.board && typeof ctx.board === 'object' ? ctx.board : null;
}

function findCardEl(uid, ctx) {
  if (uid == null || uid === '') return null;
  const b = board(ctx);
  if (b) {
    try {
      if (typeof b.getCardEl === 'function') {
        const el = b.getCardEl(uid);
        if (el && el.nodeType === 1) return el;
      }
      if (b.cards && typeof b.cards.get === 'function') {
        const el = b.cards.get(uid);
        if (el && el.nodeType === 1) return el;
      }
    } catch {
      /* noop */
    }
  }
  return safeQuery(`[data-uid="${cssEscape(uid)}"]`);
}

function findRowEl(playerIndex, row, ctx) {
  const p = Number.isFinite(Number(playerIndex)) ? Number(playerIndex) : 0;
  const b = board(ctx);
  if (b) {
    try {
      const fns = ['getRowEl', 'getPlayerRowEl', 'rowEl'];
      for (const name of fns) {
        if (typeof b[name] === 'function') {
          const el = b[name](p, row);
          if (el && el.nodeType === 1) return el;
        }
        if (b[name] && b[name][p] && b[name][p][row] && b[name][p][row].nodeType === 1) return b[name][p][row];
      }
    } catch {
      /* noop */
    }
  }
  return (
    safeQuery(`[data-fx-row="${cssEscape(row)}"][data-fx-player="${p}"]`) ||
    safeQuery(`[data-row="${cssEscape(row)}"][data-player="${p}"]`)
  );
}

function findDeckEl(playerIndex, ctx) {
  const p = Number.isFinite(Number(playerIndex)) ? Number(playerIndex) : 0;
  const b = board(ctx);
  if (b && typeof b.getDeckEl === 'function') {
    try {
      const el = b.getDeckEl(p);
      if (el && el.nodeType === 1) return el;
    } catch {
      /* noop */
    }
  }
  return safeQuery(`[data-fx-deck="${p}"]`) || safeQuery(`[data-deck="${p}"]`) || safeQuery('[data-fx-deck]');
}

function findGraveEl(playerIndex, ctx) {
  const p = Number.isFinite(Number(playerIndex)) ? Number(playerIndex) : 0;
  const b = board(ctx);
  if (b && typeof b.getGraveyardEl === 'function') {
    try {
      const el = b.getGraveyardEl(p);
      if (el && el.nodeType === 1) return el;
    } catch {
      /* noop */
    }
  }
  return safeQuery(`[data-fx-grave="${p}"]`) || safeQuery(`[data-grave="${p}"]`) || safeQuery('[data-fx-grave]');
}

function findLeaderEl(playerIndex, ctx) {
  const p = Number.isFinite(Number(playerIndex)) ? Number(playerIndex) : 0;
  const b = board(ctx);
  if (b && typeof b.getLeaderEl === 'function') {
    try {
      const el = b.getLeaderEl(p);
      if (el && el.nodeType === 1) return el;
    } catch {
      /* noop */
    }
  }
  return safeQuery(`[data-fx-leader="${p}"]`) || safeQuery('[data-fx-leader]');
}

function playerIndexFrom(event, ctx) {
  if (!event) return null;
  const raw = event.player ?? event.playerIndex ?? event.owner ?? event.who ?? event.seat;
  if (raw == null) {
    const view = ctx && ctx.view;
    if (view && Number.isFinite(view.activePlayer)) return view.activePlayer;
    return null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (raw === 'player' || raw === 'human' || raw === 'you') return 0;
  if (raw === 'ai' || raw === 'opponent') return 1;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function humanIndex(view) {
  const players = view && Array.isArray(view.players) ? view.players : null;
  if (!players) return null;
  const human = players.findIndex((p) => p && p.isAI === false);
  if (human >= 0) return human;
  const notAi = players.findIndex((p) => p && p.isAI !== true);
  return notAi >= 0 ? notAi : view && Number.isFinite(view.activePlayer) ? view.activePlayer : null;
}

function eventUid(event) {
  if (!event) return null;
  return event.uid ?? event.cardUid ?? event.unitUid ?? (event.card && (event.card.uid ?? event.card.id)) ?? null;
}

function eventCard(event) {
  if (!event) return null;
  return event.card || (event.cardView && typeof event.cardView === 'object' ? event.cardView : null);
}

function normalizeScores(scores) {
  if (!scores) return null;
  if (Array.isArray(scores)) {
    const a = Number(scores[0]);
    const b = Number(scores[1]);
    return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
  }
  if (typeof scores === 'object') {
    const a = Number(scores.player ?? scores.human ?? scores.mine ?? scores[0]);
    const b = Number(scores.opponent ?? scores.ai ?? scores.theirs ?? scores[1]);
    if (Number.isFinite(a) && Number.isFinite(b)) return [a, b];
  }
  return null;
}

function normalizeGemCounts(gems) {
  if (!gems) return null;
  if (Array.isArray(gems)) {
    const nums = [Number(gems[0]), Number(gems[1])];
    return nums.every(Number.isFinite) ? nums : null;
  }
  if (typeof gems === 'object') {
    const nums = [Number(gems.player ?? gems[0] ?? gems.human), Number(gems.opponent ?? gems[1] ?? gems.ai)];
    return nums.every(Number.isFinite) ? nums : null;
  }
  return null;
}

// ============================================================================
//  guard —— 所有特效的 Promise 超时兜底 / 取消清理
// ============================================================================
function guard(ms, task) {
  return new Promise((resolve) => {
    let done = false;
    const token = { cancelled: false, cleanups: [] };
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const cleanup of token.cleanups.splice(0)) {
        try {
          cleanup();
        } catch {
          /* noop */
        }
      }
      if (err) warnOnce('effect', err);
      resolve();
    };
    const timer = setTimeout(() => {
      token.cancelled = true;
      finish();
    }, Math.max(120, ms));
    Promise.resolve()
      .then(() => task(token))
      .then(
        () => finish(),
        (err) => finish(err)
      );
  });
}

function onCleanup(token, fn) {
  if (token && typeof fn === 'function') token.cleanups.push(fn);
}

// ============================================================================
//  sprites（预渲染发光点，避免每帧创建 gradient）
// ============================================================================
function glowSprite(midColor, coreColor = '#ffffff', softness = 0.22) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, coreColor);
  grad.addColorStop(softness, midColor);
  grad.addColorStop(1, rgba(midColor, 0));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2, 0, TAU);
  g.fill();
  return canvas;
}

function buildSprites() {
  sprites.gold = glowSprite('#f0d078', '#fff8e0');
  sprites.white = glowSprite('#ffffff', '#ffffff', 0.3);
  sprites.ice = glowSprite('#bfe8ff', '#ffffff', 0.25);
  sprites.ember = glowSprite('#ff7a2f', '#ffd9a0', 0.28);
  sprites.blood = glowSprite('#ff4d4d', '#ffb0a0', 0.3);
  sprites.soul = glowSprite('#a8e6c0', '#ffffff', 0.25);
  sprites.dust = glowSprite('#d9cbb3', '#f5efe0', 0.35);
  sprites.fog = glowSprite('#cdd3d8', '#ffffff', 0.45);
  sprites.smoke = glowSprite('#9a9188', '#c8c0b4', 0.5);
}

function colorSprite(hex) {
  const key = String(hex || '#c9a227');
  if (colorSpriteCache.has(key)) return colorSpriteCache.get(key);
  if (colorSpriteCache.size > 10) colorSpriteCache.clear();
  const sprite = glowSprite(key, mixHex(key, '#ffffff', 0.6), 0.26);
  colorSpriteCache.set(key, sprite);
  return sprite;
}

// ============================================================================
//  canvas / DOM layer mount
// ============================================================================
function mountCanvas(provided) {
  let canvas = null;
  if (provided && provided.nodeType === 1 && typeof provided.getContext === 'function') {
    canvas = provided;
  } else if (typeof provided === 'string') {
    canvas = safeQuery(provided);
  }
  if (!canvas) {
    // Lead 的 index.html 已提供 <canvas id="fx-canvas">，优先复用避免双层画布
    const existing = document.getElementById('fx-canvas');
    if (existing && existing.nodeType === 1 && typeof existing.getContext === 'function') canvas = existing;
  }
  if (canvas) {
    canvasEl = canvas;
    ownsCanvas = false;
  } else {
    canvasEl = document.createElement('canvas');
    ownsCanvas = true;
    document.documentElement.appendChild(canvasEl);
  }
  canvasEl.classList.add('fx-canvas');
  canvasEl.setAttribute('aria-hidden', 'true');
  ctx2d = canvasEl.getContext('2d', { alpha: true, desynchronized: true });
  if (!ctx2d) throw new Error('canvas 2d context unavailable');
}

function mountDomLayer() {
  const layer = div('fx-layer');
  layer.setAttribute('aria-hidden', 'true');
  const tint = div('fx-weather-tint');
  const tintLayers = {};
  for (const kind of ['frost', 'fog', 'rain', 'storm']) {
    const tintLayer = div(`fx-tint-layer fx-tint-layer--${kind}`);
    tint.appendChild(tintLayer);
    tintLayers[kind] = tintLayer;
  }
  const vignette = div('fx-vignette');
  const ghost = div('fx-ghost-layer');
  const coin = div('fx-coin-host');
  const banner = div('fx-banner-host');
  const toasts = div('fx-toasts fx-toast-layer');
  const flash = div('fx-flash');
  layer.append(tint, vignette, ghost, coin, banner, toasts, flash);
  document.documentElement.appendChild(layer);
  dom = { layer, tint, tintLayers, vignette, ghost, coin, banner, toasts, flash, runes: null };
  updateWeatherTint();
}

function resize() {
  W = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
  H = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
  dpr = clamp(window.devicePixelRatio || 1, 1, 2);
  if (!canvasEl) return;
  canvasEl.width = Math.round(W * dpr);
  canvasEl.height = Math.round(H * dpr);
  if (ctx2d) {
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.imageSmoothingEnabled = true;
  }
}

// ============================================================================
//  particle pool
// ============================================================================
function spawn(cfg) {
  if (reducedMotion) return null; // reduced-motion 降级：不产生 canvas 粒子
  if (count >= MAX_PARTICLES || !ctx2d) return null;
  const p = pool[count];
  Object.assign(p, TEMPLATE, cfg);
  p.t = 0;
  p.max = p.life > 0 ? p.life : 0.8;
  count += 1;
  return p;
}

function killAt(index) {
  const last = count - 1;
  if (index !== last) {
    const tmp = pool[index];
    pool[index] = pool[last];
    pool[last] = tmp;
  }
  count = last;
}

function updateParticles(dt) {
  for (let i = count - 1; i >= 0; i -= 1) {
    const p = pool[i];
    p.t += dt;
    p.life -= dt;
    if (p.life <= 0) {
      killAt(i);
      continue;
    }
    if (p.kind === 'ring') {
      p.r += p.grow * dt;
      continue;
    }
    if (p.kind === 'orb') {
      const u = clamp(1 - p.life / p.max, 0, 1);
      p.x = (1 - u) * (1 - u) * p.sx + 2 * (1 - u) * u * p.cx + u * u * p.ex;
      p.y = (1 - u) * (1 - u) * p.sy + 2 * (1 - u) * u * p.cy + u * u * p.ey;
      if (Math.random() < dt * 26) {
        spawn({
          kind: 'sprite',
          sprite: 'soul',
          x: p.x + rand(-7, 7),
          y: p.y + rand(-7, 7),
          vx: rand(-14, 14),
          vy: rand(-26, 10),
          size: rand(1.6, 4),
          life: rand(0.3, 0.7),
          alpha: 0.5,
        });
      }
      continue;
    }
    // sprite / rain / shard 物理
    p.vx += p.ax * dt;
    p.vy += p.ay * dt;
    if (p.drag) {
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d;
      p.vy *= d;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    if (p.y > H + 120 && p.vy > 0) killAt(i);
    else if (p.x < -700 || p.x > W + 700) killAt(i);
  }
}

function updateWeatherParticles(dt) {
  if (reducedMotion) return;
  const budget = MAX_PARTICLES - 40;
  if (ambientOn) {
    spawnAcc.ember += dt * 7;
    while (spawnAcc.ember >= 1) {
      spawnAcc.ember -= 1;
      if (count >= budget) break;
      spawnAmbientEmber();
    }
    spawnAcc.fog += dt * 0.22;
    while (spawnAcc.fog >= 1) {
      spawnAcc.fog -= 1;
      if (count >= budget) break;
      spawnFog(true);
    }
  }
  if (weather.frost) {
    spawnAcc.frost += dt * 20;
    while (spawnAcc.frost >= 1) {
      spawnAcc.frost -= 1;
      if (count >= budget) break;
      spawnFrost();
    }
  }
  if (weather.fog) {
    spawnAcc.fog += dt * 1.6;
    while (spawnAcc.fog >= 1) {
      spawnAcc.fog -= 1;
      if (count >= budget) break;
      spawnFog(false);
    }
  }
  const rainRate = weather.storm ? 105 : weather.rain ? 68 : 0;
  if (rainRate) {
    spawnAcc.rain += dt * rainRate;
    while (spawnAcc.rain >= 1) {
      spawnAcc.rain -= 1;
      if (count >= budget) break;
      spawnRain();
    }
  }
  if (weather.storm) {
    stormTimer -= dt;
    if (stormTimer <= 0) {
      stormTimer = rand(2.8, 7);
      triggerLightning();
    }
  }
}

function spawnFrost() {
  spawn({
    kind: 'sprite',
    sprite: 'ice',
    x: rand(-20, W + 20),
    y: rand(-60, H * 0.24),
    vx: rand(-22, 22),
    vy: rand(18, 58),
    size: rand(2.2, 6),
    life: rand(5, 10),
    alpha: rand(0.4, 0.95),
    rot: rand(0, TAU),
    vr: rand(-1.2, 1.2),
    drag: 0.02,
  });
}

function spawnRain() {
  const speed = weather.storm ? rand(880, 1280) : rand(620, 980);
  spawn({
    kind: 'rain',
    x: rand(-60, W + 90),
    y: rand(-120, -10),
    vx: -speed * rand(0.12, 0.22),
    vy: speed,
    len: rand(14, 30),
    life: rand(0.55, 1.15),
    alpha: rand(0.16, 0.34),
    blend: 'source-over',
  });
}

function spawnFog(ambient) {
  const fromLeft = Math.random() < 0.5;
  spawn({
    kind: 'sprite',
    sprite: 'fog',
    blend: 'source-over',
    x: fromLeft ? rand(-380, -120) : rand(W + 120, W + 380),
    y: rand(H * 0.08, H * 0.95),
    vx: fromLeft ? rand(7, 18) : rand(-18, -7),
    vy: rand(-4, 4),
    size: rand(ambient ? 320 : 240, ambient ? 620 : 520),
    life: rand(ambient ? 12 : 10, ambient ? 20 : 17),
    alpha: rand(0.04, ambient ? 0.07 : 0.1),
    rot: rand(0, TAU),
    vr: rand(-0.04, 0.04),
  });
}

function spawnAmbientEmber() {
  const gold = Math.random() < 0.7;
  spawn({
    kind: 'sprite',
    sprite: gold ? 'gold' : 'ember',
    x: rand(0, W),
    y: H + rand(10, H * 0.35),
    vx: rand(-16, 16),
    vy: rand(-80, -30),
    ax: rand(-6, 6),
    ay: rand(-3, 3),
    size: rand(1.3, 3.8),
    life: rand(6, 12),
    alpha: rand(0.3, 0.75),
    rot: rand(0, TAU),
    vr: rand(-1, 1),
  });
}

function ambientBurst() {
  if (reducedMotion) return;
  for (let i = 0; i < 30; i += 1) {
    spawn({
      kind: 'sprite',
      sprite: Math.random() < 0.72 ? 'gold' : 'ember',
      x: rand(0, W),
      y: rand(0, H),
      vx: rand(-16, 16),
      vy: rand(-44, -12),
      ax: rand(-6, 6),
      size: rand(1.2, 3.4),
      life: rand(5, 11),
      alpha: rand(0.2, 0.65),
      rot: rand(0, TAU),
      vr: rand(-0.8, 0.8),
    });
  }
  for (let i = 0; i < 4; i += 1) {
    spawn({
      kind: 'sprite',
      sprite: 'fog',
      blend: 'source-over',
      x: rand(0, W),
      y: rand(H * 0.15, H * 0.9),
      vx: rand(-12, 12),
      vy: rand(-4, 4),
      size: rand(320, 620),
      life: rand(10, 18),
      alpha: rand(0.03, 0.06),
      rot: rand(0, TAU),
      vr: rand(-0.04, 0.04),
    });
  }
  ensureLoop();
}

// ---- transient helpers -------------------------------------------------------
function burstAt(point, n, spriteName = 'gold', options = {}) {
  if (!point) return;
  const { speed = 90, size = 2.4, life = 0.6, spread = TAU, angle = -Math.PI / 2, alpha = 0.7 } = options;
  for (let i = 0; i < n; i += 1) {
    const a = spread >= TAU ? Math.random() * TAU : angle + (Math.random() - 0.5) * spread;
    const power = speed * rand(0.3, 1.1);
    spawn({
      kind: 'sprite',
      sprite: spriteName,
      x: point.x,
      y: point.y,
      vx: Math.cos(a) * power,
      vy: Math.sin(a) * power,
      size: size * rand(0.55, 1.35),
      life: life * rand(0.55, 1.3),
      alpha: alpha * rand(0.6, 1),
      drag: 1.4,
      rot: rand(0, TAU),
      vr: rand(-3, 3),
    });
  }
  ensureLoop();
}

function dustAt(rect, n = 14) {
  if (!rect) return;
  for (let i = 0; i < n; i += 1) {
    spawn({
      kind: 'sprite',
      sprite: 'dust',
      x: rect.x + rand(0, rect.w),
      y: rect.y + rect.h * rand(0.65, 1),
      vx: rand(-34, 34),
      vy: rand(-42, -8),
      size: rand(2.5, 7),
      life: rand(0.4, 0.95),
      alpha: rand(0.2, 0.5),
      drag: 1.1,
    });
  }
  ensureLoop();
}

function smokePuff(point, options = {}) {
  if (!point) return;
  const { size = rand(60, 130), life = rand(0.8, 1.5), alpha = rand(0.08, 0.16) } = options;
  spawn({
    kind: 'sprite',
    sprite: 'smoke',
    blend: 'source-over',
    x: point.x + rand(-16, 16),
    y: point.y + rand(-16, 16),
    vx: rand(-22, 22),
    vy: rand(-32, -8),
    size,
    life,
    alpha,
    rot: rand(0, TAU),
    vr: rand(-0.5, 0.5),
    drag: 0.6,
  });
  ensureLoop();
}

function addRing(x, y, options = {}) {
  const { color = '#f0d078', grow = 260, max = 0.6, width = 2, startR = 6, alpha = 0.75 } = options;
  spawn({ kind: 'ring', x, y, r: startR, grow, life: max, max, width, color, alpha });
  ensureLoop();
}

function addBeam(x1, y1, x2, y2, options = {}) {
  if (reducedMotion) return;
  const { life = 0.4, color = '#ffa050', width = 3 } = options;
  if (beams.length >= MAX_BEAMS) beams.shift();
  beams.push({ x1, y1, x2, y2, t: 0, max: life, color, width, head: { x: x1, y: y1 } });
  ensureLoop();
}

function spawnOrb(from, to, options = {}) {
  const { color = '#a8e6c0', dur = 0.85, size = 30, spriteName = 'soul' } = options;
  const ctrl = {
    x: (from.x + to.x) / 2 + rand(-60, 60),
    y: Math.min(from.y, to.y) - rand(90, 190),
  };
  spawn({
    kind: 'orb',
    sprite: spriteName,
    sx: from.x,
    sy: from.y,
    cx: ctrl.x,
    cy: ctrl.y,
    ex: to.x,
    ey: to.y,
    x: from.x,
    y: from.y,
    size,
    life: dur,
    max: dur,
    alpha: 0.95,
    color,
  });
  ensureLoop();
}

// ============================================================================
//  lightning / beams / roots
// ============================================================================
function triggerLightning() {
  if (reducedMotion) {
    doScreenFlash('#cbd6ff', 0.1);
    return;
  }
  const x = rand(W * 0.12, W * 0.88);
  const y1 = rand(H * 0.3, H * 0.72);
  const pts = [[x, 0]];
  let cx = x;
  let cy = 0;
  while (cy < y1) {
    cy += rand(16, 52);
    cx += rand(-46, 46);
    pts.push([clamp(cx, 0, W), cy]);
  }
  if (bolts.length >= MAX_BOLTS) bolts.shift();
  bolts.push({ pts, t: 0, max: rand(0.16, 0.28) });
  doScreenFlash('#c9d6ff', 0.16);
  doShake(1.1);
  playSfx('weather-storm', { volume: 0.22, delay: 0.08 });
  ensureLoop();
}

function updateBeams(dt) {
  for (let i = beams.length - 1; i >= 0; i -= 1) {
    const beam = beams[i];
    beam.t += dt;
    const p = easeOutCubic(clamp((beam.t / beam.max) * 1.8, 0, 1));
    beam.head.x = lerp(beam.x1, beam.x2, p);
    beam.head.y = lerp(beam.y1, beam.y2, p);
    if (!reducedMotion && Math.random() < dt * 30) {
      spawn({
        kind: 'sprite',
        sprite: Math.random() < 0.6 ? 'ember' : 'gold',
        x: beam.head.x + rand(-8, 8),
        y: beam.head.y + rand(-8, 8),
        vx: rand(-40, 40),
        vy: rand(-60, -10),
        size: rand(1.4, 3.6),
        life: rand(0.25, 0.6),
        alpha: 0.7,
      });
    }
    if (beam.t >= beam.max) beams.splice(i, 1);
  }
}

function updateBolts(dt) {
  for (let i = bolts.length - 1; i >= 0; i -= 1) {
    bolts[i].t += dt;
    if (bolts[i].t >= bolts[i].max) bolts.splice(i, 1);
  }
}

function createRootBranches(rect) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h * 0.92;
  const branches = [];
  const mains = randInt(3, 5);
  const addBranch = (start, angle, steps, segLen, width) => {
    const pts = [{ x: start.x, y: start.y }];
    let x = start.x;
    let y = start.y;
    let a = angle;
    for (let i = 0; i < steps; i += 1) {
      a += rand(-0.34, 0.34);
      x += Math.cos(a) * segLen;
      y += Math.sin(a) * segLen;
      pts.push({ x, y });
    }
    branches.push({ pts, width });
    return pts;
  };
  for (let i = 0; i < mains; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    const spread = rand(0.18, 0.62) * side;
    const start = { x: cx + rand(-rect.w * 0.22, rect.w * 0.22), y: cy };
    const mainPts = addBranch(start, -Math.PI / 2 + spread, randInt(4, 6), rect.h * 0.13, rand(2.2, 3.4));
    // 根须分叉
    const mid = mainPts[Math.floor(mainPts.length / 2)];
    addBranch(mid, -Math.PI / 2 + spread + rand(0.4, 0.9) * side, randInt(2, 3), rect.h * 0.08, rand(1.1, 1.8));
    const tip = mainPts[mainPts.length - 1];
    addBranch(tip, -Math.PI / 2 + spread + rand(0.2, 0.6), randInt(1, 2), rect.h * 0.06, 1);
  }
  return branches;
}

function addRoots(rect) {
  if (reducedMotion || !rect) return;
  const branches = createRootBranches(rect);
  if (roots.length >= MAX_ROOTS) roots.shift();
  roots.push({ rect, branches, t: 0, max: 1.25 });
  ensureLoop();
}

function updateRoots(dt) {
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    roots[i].t += dt;
    if (roots[i].t >= roots[i].max) roots.splice(i, 1);
  }
}

// ============================================================================
//  draw
// ============================================================================
function drawParticle(p) {
  const k = clamp(p.life / p.max, 0, 1); // 1 → 0
  const u = 1 - k;
  const fadeIn = Math.min(1, u / 0.12);
  const fadeOut = Math.min(1, k / 0.38);
  const alpha = clamp(p.alpha * fadeIn * fadeOut, 0, 1);
  if (alpha <= 0.002) return;

  if (p.kind === 'rain') {
    const mag = Math.hypot(p.vx, p.vy) || 1;
    ctx2d.globalAlpha = alpha;
    ctx2d.strokeStyle = 'rgba(176,204,234,1)';
    ctx2d.lineWidth = 1.35;
    ctx2d.beginPath();
    ctx2d.moveTo(p.x, p.y);
    ctx2d.lineTo(p.x - (p.vx / mag) * p.len, p.y - (p.vy / mag) * p.len);
    ctx2d.stroke();
    return;
  }

  if (p.kind === 'ring') {
    const r = Math.max(1, p.r);
    const ringAlpha = alpha * clamp(k / 0.5, 0, 1);
    ctx2d.strokeStyle = p.color;
    // 外层柔光
    ctx2d.globalAlpha = ringAlpha * 0.16;
    ctx2d.lineWidth = p.width * 5;
    ctx2d.beginPath();
    ctx2d.arc(p.x, p.y, r, 0, TAU);
    ctx2d.stroke();
    // 主光环
    ctx2d.globalAlpha = ringAlpha;
    ctx2d.lineWidth = p.width * (0.4 + k * 0.8);
    ctx2d.beginPath();
    ctx2d.arc(p.x, p.y, r, 0, TAU);
    ctx2d.stroke();
    return;
  }

  if (p.kind === 'shard') {
    const size = p.size + (p.sizeEnd - p.size || 0) * u;
    ctx2d.globalAlpha = alpha;
    ctx2d.fillStyle = p.color;
    ctx2d.save();
    ctx2d.translate(p.x, p.y);
    ctx2d.rotate(p.rot);
    ctx2d.fillRect(-size / 2, -size / 6, size, size / 3);
    ctx2d.restore();
    return;
  }

  // sprite
  const sprite = p.sprite === 'faction' ? colorSprite(faction.color) : sprites[p.sprite] || sprites.gold;
  const size = (p.size + (p.sizeEnd - p.size) * u) * (p.kind === 'orb' ? 1 : 1);
  ctx2d.globalAlpha = p.kind === 'orb' ? alpha * (0.55 + Math.sin(u * Math.PI) * 0.45) : alpha;
  ctx2d.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size);
  if (p.kind === 'orb') {
    ctx2d.globalAlpha = alpha;
    ctx2d.drawImage(sprites.white, p.x - size / 6, p.y - size / 6, size / 3, size / 3);
  }
}

function drawBeams() {
  for (const beam of beams) {
    const p = easeOutCubic(clamp((beam.t / beam.max) * 1.8, 0, 1));
    const ex = lerp(beam.x1, beam.x2, p);
    const ey = lerp(beam.y1, beam.y2, p);
    const fade = 1 - clamp((beam.t - beam.max * 0.4) / (beam.max * 0.6), 0, 1);
    if (fade <= 0) continue;
    const grad = ctx2d.createLinearGradient(beam.x1, beam.y1, ex, ey);
    grad.addColorStop(0, rgba(beam.color, 0));
    grad.addColorStop(0.5, rgba(beam.color, 0.6 * fade));
    grad.addColorStop(1, rgba('#fff5dc', 0.95 * fade));
    ctx2d.globalCompositeOperation = 'lighter';
    ctx2d.globalAlpha = 1;
    ctx2d.lineCap = 'round';
    ctx2d.strokeStyle = grad;
    ctx2d.lineWidth = beam.width * (0.5 + 0.8 * fade);
    ctx2d.beginPath();
    ctx2d.moveTo(beam.x1, beam.y1);
    ctx2d.lineTo(ex, ey);
    ctx2d.stroke();
    ctx2d.globalAlpha = 0.3 * fade;
    ctx2d.strokeStyle = beam.color;
    ctx2d.lineWidth = beam.width * 3.2;
    ctx2d.stroke();
  }
}

function drawBolts() {
  for (const bolt of bolts) {
    const k = clamp(1 - bolt.t / bolt.max, 0, 1);
    ctx2d.globalCompositeOperation = 'lighter';
    ctx2d.globalAlpha = k * 0.35;
    ctx2d.strokeStyle = '#8ea8ff';
    ctx2d.lineWidth = 9;
    ctx2d.lineJoin = 'round';
    ctx2d.beginPath();
    bolt.pts.forEach(([x, y], i) => (i ? ctx2d.lineTo(x, y) : ctx2d.moveTo(x, y)));
    ctx2d.stroke();
    ctx2d.globalAlpha = k;
    ctx2d.strokeStyle = '#eaf2ff';
    ctx2d.lineWidth = 2.2;
    ctx2d.beginPath();
    bolt.pts.forEach(([x, y], i) => (i ? ctx2d.lineTo(x, y) : ctx2d.moveTo(x, y)));
    ctx2d.stroke();
  }
}

function drawRoots() {
  for (const root of roots) {
    const progress = clamp(root.t / (root.max * 0.65), 0, 1);
    const fade = root.t < root.max * 0.62 ? 1 : clamp(1 - (root.t - root.max * 0.62) / (root.max * 0.38), 0, 1);
    if (fade <= 0) continue;
    ctx2d.globalCompositeOperation = 'lighter';
    ctx2d.lineCap = 'round';
    for (const branch of root.branches) {
      const pts = branch.pts;
      const total = pts.length - 1;
      if (total < 1) continue;
      const target = progress * total;
      ctx2d.beginPath();
      ctx2d.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i += 1) {
        const segStart = i - 1;
        if (segStart >= target) break;
        const segT = clamp(target - segStart, 0, 1);
        const x = lerp(pts[i - 1].x, pts[i].x, segT);
        const y = lerp(pts[i - 1].y, pts[i].y, segT);
        ctx2d.lineTo(x, y);
      }
      ctx2d.globalAlpha = 0.22 * fade;
      ctx2d.strokeStyle = '#ff4d4d';
      ctx2d.lineWidth = branch.width * 4;
      ctx2d.stroke();
      ctx2d.globalAlpha = 0.85 * fade;
      ctx2d.strokeStyle = '#ff8a6a';
      ctx2d.lineWidth = branch.width;
      ctx2d.stroke();
    }
  }
}

function drawFrame() {
  if (!ctx2d) return;
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, W, H);
  ctx2d.lineCap = 'round';

  // pass 1：常规混合（雨、雾、烟、碎片）
  ctx2d.globalCompositeOperation = 'source-over';
  for (let i = 0; i < count; i += 1) {
    const p = pool[i];
    if (p.blend === 'source-over') drawParticle(p);
  }

  // pass 2：发光叠加
  ctx2d.globalCompositeOperation = 'lighter';
  for (let i = 0; i < count; i += 1) {
    const p = pool[i];
    if (p.blend !== 'source-over') drawParticle(p);
  }

  drawBeams();
  drawBolts();
  drawRoots();

  ctx2d.globalAlpha = 1;
  ctx2d.globalCompositeOperation = 'source-over';
}

// ============================================================================
//  loop
// ============================================================================
function anyWeatherOn() {
  return weather.frost || weather.fog || weather.rain || weather.storm;
}

function needed() {
  return count > 0 || beams.length > 0 || bolts.length > 0 || roots.length > 0 || anyWeatherOn() || ambientOn;
}

function ensureLoop() {
  if (reducedMotion || running || document.hidden || !ctx2d) return;
  running = true;
  lastTime = 0;
  rafId = requestAnimationFrame(loop);
}

function loop(timestamp) {
  if (!running) return;
  const time = isNum(timestamp) ? timestamp : now();
  let dt = lastTime ? (time - lastTime) / 1000 : 1 / 60;
  lastTime = time;
  dt = clamp(dt, 0.001, 0.05);

  fpsFrames += 1;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    fps = Math.round(fpsFrames / fpsTime);
    fpsFrames = 0;
    fpsTime = 0;
  }

  updateParticles(dt);
  updateWeatherParticles(dt);
  updateBeams(dt);
  updateBolts(dt);
  updateRoots(dt);
  drawFrame();

  if (!needed()) {
    running = false;
    rafId = 0;
    if (ctx2d) ctx2d.clearRect(0, 0, W, H);
    return;
  }
  rafId = requestAnimationFrame(loop);
}

function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  running = false;
  lastTime = 0;
  if (ctx2d) ctx2d.clearRect(0, 0, W, H);
}

function clearParticles() {
  count = 0;
  beams = [];
  bolts = [];
  roots = [];
  if (ctx2d) ctx2d.clearRect(0, 0, W, H);
}

// ============================================================================
//  visibility / reduced motion / resize
// ============================================================================
function onVisibilityChange() {
  if (document.hidden) {
    stopLoop();
  } else if (needed()) {
    ensureLoop();
  }
}

function onReducedMotionChange(event) {
  reducedMotion = !!(event && event.matches);
  if (reducedMotion) {
    clearParticles();
    stopLoop();
  } else if (needed()) {
    ensureLoop();
  }
}

function bindGlobals() {
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', onVisibilityChange);
  try {
    reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = reducedQuery.matches;
    if (typeof reducedQuery.addEventListener === 'function') {
      reducedQuery.addEventListener('change', onReducedMotionChange);
    } else if (typeof reducedQuery.addListener === 'function') {
      reducedQuery.addListener(onReducedMotionChange);
    }
  } catch {
    reducedMotion = false;
  }
}

function unbindGlobals() {
  window.removeEventListener('resize', resize);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  try {
    if (reducedQuery && typeof reducedQuery.removeEventListener === 'function') {
      reducedQuery.removeEventListener('change', onReducedMotionChange);
    } else if (reducedQuery && typeof reducedQuery.removeListener === 'function') {
      reducedQuery.removeListener(onReducedMotionChange);
    }
  } catch {
    /* noop */
  }
  reducedQuery = null;
}

// ============================================================================
//  DOM effects: flash / shake / toast
// ============================================================================
function doScreenFlash(color = '#fff8e0', alpha = 0.5) {
  return guard(900, async (token) => {
    ensureAll();
    if (!dom || !dom.flash) return;
    const el = dom.flash;
    el.style.background = color;
    const a = clamp(Number(alpha) || 0, 0, 1);
    try {
      for (const anim of el.getAnimations ? el.getAnimations() : []) anim.cancel();
    } catch {
      /* noop */
    }
    try {
      const anim = el.animate(
        [{ opacity: a }, { opacity: a * 0.55, offset: 0.25 }, { opacity: 0 }],
        { duration: reducedMotion ? 260 : 460, easing: 'ease-out', fill: 'forwards' }
      );
      onCleanup(token, () => {
        try {
          anim.cancel();
        } catch {
          /* noop */
        }
        el.style.opacity = '';
      });
      await anim.finished.catch(() => {});
    } catch {
      el.style.opacity = '0';
    }
  });
}

function doShake(intensity = 1) {
  return guard(900, async (token) => {
    ensureAll();
    const el = rootEl || document.body;
    if (!el) return;
    const i = clamp(Number(intensity) || 1, 0.2, 3);
    if (reducedMotion) return;
    el.style.setProperty('--fx-shake-i', i.toFixed(2));
    el.classList.remove('fx-shaking');
    // force reflow 以便连续触发时重启动画
    void el.offsetWidth;
    el.classList.add('fx-shaking');
    onCleanup(token, () => {
      try {
        el.classList.remove('fx-shaking');
      } catch {
        /* noop */
      }
    });
    await wait(460 + i * 60);
  });
}

function doToast(text) {
  // 注意：完整生命周期 = 入场 220 + 停留 1750 + 出场 300 ≈ 2.3s，
  // guard 时限必须覆盖全程，且注册 onCleanup 保证超时/异常时也一定移除 DOM。
  return guard(3400, async (token) => {
    ensureAll();
    if (!dom || !dom.toasts) return;
    const msg = String(text == null ? '' : text).trim();
    if (!msg) return;
    const el = div('fx-toast');
    el.textContent = msg;
    dom.toasts.appendChild(el);
    onCleanup(token, () => {
      try {
        el.remove();
      } catch {
        /* noop */
      }
    });
    while (dom.toasts.children.length > 4) dom.toasts.firstElementChild.remove();
    try {
      const inAnim = el.animate(
        [
          { opacity: 0, transform: 'translateY(12px) scale(.96)' },
          { opacity: 1, transform: 'translateY(0) scale(1)' },
        ],
        { duration: reducedMotion ? 160 : 220, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' }
      );
      onCleanup(token, () => {
        try {
          inAnim.cancel();
        } catch {
          /* noop */
        }
      });
      await inAnim.finished.catch(() => {});
    } catch {
      /* noop */
    }
    if (token.cancelled) return;
    await wait(1750);
    if (token.cancelled) return;
    try {
      await el
        .animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 300, fill: 'forwards' })
        .finished.catch(() => {});
    } catch {
      /* noop */
    }
    el.remove();
  });
}

function doPowerPulse(uid, delta) {
  return guard(1000, async (token) => {
    ensureAll();
    if (uid == null) return;
    const el = findCardEl(uid, null);
    const rect = rectOf(el);
    const up = (Number(delta) || 0) >= 0;
    if (el) {
      el.classList.remove('fx-power-up', 'fx-power-down');
      void el.offsetWidth;
      el.classList.add(up ? 'fx-power-up' : 'fx-power-down');
      later(() => {
        try {
          el.classList.remove('fx-power-up', 'fx-power-down');
        } catch {
          /* noop */
        }
      }, 780);
    }
    if (rect) {
      const c = rectCenter(rect);
      burstAt(c, up ? 10 : 8, up ? 'gold' : 'blood', { speed: 70, size: 2, life: 0.5 });
      addRing(c.x, c.y, { color: up ? '#f0d078' : '#ff6b5a', grow: 110, max: 0.4, width: 1.6, alpha: 0.5 });
    }
    await wait(80);
    if (token.cancelled) return;
  });
}

// ============================================================================
//  helpers: ghost cards / fly animations / classes
// ============================================================================
function flashClass(el, className, ms = 800) {
  if (!el || !el.classList) return;
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
  later(() => {
    try {
      el.classList.remove(className);
    } catch {
      /* noop */
    }
  }, ms);
}

function isCardEl(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.dataset && el.dataset.uid) return true;
  if (el.classList && (el.classList.contains('gt-card') || el.classList.contains('fx-card'))) return true;
  return false;
}

/** 从视口坐标反查卡牌 DOM（用于 cardPlay 只给了 fromRect 时克隆正确的牌面）。 */
function cardElAtPoint(point) {
  if (!point || typeof document.elementsFromPoint !== 'function') return null;
  try {
    const stack = document.elementsFromPoint(point.x, point.y) || [];
    for (const node of stack) {
      if (!node || node.nodeType !== 1) continue;
      const card = typeof node.closest === 'function' ? node.closest('.gt-card, [data-uid]') : null;
      if (card && card.nodeType === 1) return card;
    }
  } catch {
    /* noop */
  }
  return null;
}

/**
 * 解析出牌落点。
 * toEl 可能是「目标卡牌」也可能是 Lead 传入的「目标行」容器：
 *   - 卡牌 → 直接用其 rect；
 *   - 行容器 → 按该行已有卡牌尺寸 + flex 居中布局，推算新牌 append 后的槽位 rect。
 */
function resolvePlayDestination(toEl, fromRect) {
  if (isCardEl(toEl)) {
    const rect = rectOf(toEl);
    if (rect) return { cardEl: toEl, rect, rowEl: null };
  }
  const rowEl = toEl && toEl.nodeType === 1 ? toEl : null;
  const cardsBox = rowEl
    ? rowEl.querySelector('.board-row__cards, .row__cards, [data-fx-cards]')
    : null;
  const box = cardsBox && cardsBox.nodeType === 1 ? cardsBox : rowEl;
  const boxRect = rectOf(box);
  if (!boxRect) {
    return { cardEl: null, rect: normRect(fromRect) || fallbackCardRect(0.5, 0.44), rowEl };
  }
  let existing = [];
  try {
    existing = box ? Array.from(box.querySelectorAll('.gt-card, [data-uid]')).filter((n) => n.nodeType === 1) : [];
  } catch {
    existing = [];
  }
  const lastRect = existing.length ? rectOf(existing[existing.length - 1]) : null;
  let w;
  let h;
  if (lastRect) {
    w = lastRect.w;
    h = lastRect.h;
  } else {
    // Lead 的 screens.css 用 --board-card-w/h 统一控制行内卡牌尺寸（在 board 容器上定义）
    const cssH = readVarFrom(box || rowEl, '--board-card-h');
    const cssW = readVarFrom(box || rowEl, '--board-card-w');
    if (cssH > 24) {
      h = clamp(cssH, 40, DEFAULT_CARD_H);
      w = cssW > 16 ? clamp(cssW, 28, DEFAULT_CARD_W) : h * (DEFAULT_CARD_W / DEFAULT_CARD_H);
    } else {
      h = clamp(boxRect.h - 6, 56, DEFAULT_CARD_H);
      w = h * (DEFAULT_CARD_W / DEFAULT_CARD_H);
    }
  }
  const gap = 4;
  const n = existing.length;
  const total = (n + 1) * w + n * gap;
  const startX = boxRect.x + boxRect.w / 2 - total / 2;
  const x = clamp(startX + n * (w + gap), boxRect.x, Math.max(boxRect.x, boxRect.x + boxRect.w - w));
  const y = boxRect.y + boxRect.h / 2 - h / 2;
  return { cardEl: null, rect: { x, y, w, h }, rowEl };
}

function makePlaceholderGhost(rect, card, options = {}) {
  const r = rect || fallbackCardRect();
  const node = div('fx-ghost fx-ghost--placeholder' + (options.back ? ' fx-ghost--back' : ''));
  node.style.width = `${r.w}px`;
  node.style.height = `${r.h}px`;
  const emblem = div('fx-ghost__emblem');
  const name = div('fx-ghost__name');
  name.textContent = options.back ? '' : String((card && (card.nameZh || card.nameEn || card.name || card.id)) || '');
  node.append(emblem, name);
  if (dom) dom.ghost.appendChild(node);
  return node;
}

function createCardGhost(options = {}) {
  if (!dom) return null;
  const { el = null, rect = null, card = null, faceDown = false, className = '' } = options;
  const r = normRect(rect) || fallbackCardRect();
  if (el && el.nodeType === 1 && !faceDown) {
    try {
      const clone = el.cloneNode(true);
      clone.removeAttribute('id');
      if (clone.querySelectorAll) clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      clone.classList.add('fx-ghost', 'fx-ghost--clone');
      if (className) clone.classList.add(className);
      clone.setAttribute('aria-hidden', 'true');
      clone.removeAttribute('data-uid');
      clone.style.pointerEvents = 'none';
      clone.style.transition = 'none';
      clone.style.transform = 'none';
      clone.style.position = 'fixed';
      clone.style.left = '0';
      clone.style.top = '0';
      clone.style.margin = '0';
      clone.style.zIndex = '3';
      clone.style.width = `${r.w}px`;
      clone.style.height = `${r.h}px`;
      dom.ghost.appendChild(clone);
      return clone;
    } catch {
      /* fallthrough */
    }
  }
  const node = makePlaceholderGhost(r, card, { back: faceDown });
  if (className) node.classList.add(className);
  node.style.zIndex = '3';
  return node;
}

/** 从 fromRect 弧线飞到 toRect；结束时自动移除 ghost。 */
function flyGhost(token, node, from, to, options = {}) {
  return new Promise((resolve) => {
    if (!node) {
      resolve();
      return;
    }
    const duration = reducedMotion ? 140 : Math.max(120, Number(options.duration) || 480);
    const rotate = isNum(options.rotate) ? options.rotate : -7;
    const arc = isNum(options.arc) ? options.arc : 90;
    // scaleTo：保持 ghost 原始比例，用 transform 缩放（用于 clone 牌，避免内联宽高把牌面压扁）
    const scaleTo = isNum(options.scaleTo) ? clamp(options.scaleTo, 0.25, 2.2) : null;
    const sourceSize = options.sourceSize && isNum(options.sourceSize.w) ? options.sourceSize : null;
    const w = scaleTo && sourceSize ? sourceSize.w : to.w || DEFAULT_CARD_W;
    const h = scaleTo && sourceSize ? sourceSize.h : to.h || DEFAULT_CARD_H;
    node.style.width = `${w}px`;
    node.style.height = `${h}px`;
    const scaleFrom = isNum(options.scaleFrom)
      ? options.scaleFrom
      : reducedMotion
        ? 1
        : clamp((from.w || w) / w, 0.55, 1.6);
    const endScale = scaleTo || 1;
    const startCenter = rectCenter(from);
    const endCenter = rectCenter(to);
    const sx = startCenter.x - w / 2;
    const sy = startCenter.y - h / 2;
    const ex = endCenter.x - w / 2;
    const ey = endCenter.y - h / 2;
    const cx = (sx + ex) / 2 + (ex >= sx ? 40 : -40);
    const cy = Math.min(sy, ey) - arc;
    // 动画第一帧之前先摆到起点，避免闪现在视口左上角
    try {
      node.style.width = `${w}px`;
      node.style.height = `${h}px`;
      node.style.transform = reducedMotion
        ? `translate3d(${ex}px, ${ey}px, 0) scale(${endScale})`
        : `translate3d(${sx}px, ${sy}px, 0) scale(${scaleFrom}) rotate(${rotate}deg)`;
    } catch {
      /* noop */
    }
    const keyframes = reducedMotion
      ? [
          { opacity: 0, transform: `translate3d(${ex}px, ${ey}px, 0) scale(${endScale})` },
          { opacity: 1, transform: `translate3d(${ex}px, ${ey}px, 0) scale(${endScale})` },
        ]
      : [
          {
            transform: `translate3d(${sx}px, ${sy}px, 0) scale(${scaleFrom}) rotate(${rotate}deg)`,
            opacity: options.fade ? 0 : 1,
            offset: 0,
          },
          {
            transform: `translate3d(${cx}px, ${cy}px, 0) scale(${((scaleFrom + endScale) / 2) * 1.04}) rotate(${rotate * 0.2}deg)`,
            opacity: 1,
            offset: 0.55,
          },
          { transform: `translate3d(${ex}px, ${ey}px, 0) scale(${endScale}) rotate(0deg)`, opacity: 1, offset: 1 },
        ];
    let anim = null;
    try {
      anim = node.animate(keyframes, {
        duration,
        easing: 'cubic-bezier(.22,.7,.28,1)',
        fill: 'forwards',
      });
    } catch {
      anim = null;
    }
    if (token) onCleanup(token, () => {
      try {
        anim && anim.cancel();
      } catch {
        /* noop */
      }
      node.remove();
    });
    if (!anim) {
      node.remove();
      resolve();
      return;
    }
    anim.finished.then(
      () => {
        try {
          anim.cancel();
        } catch {
          /* noop */
        }
        node.remove();
        resolve();
      },
      () => {
        node.remove();
        resolve();
      }
    );
  });
}

function emitTrail(token, from, to, duration, spriteName = 'gold', options = {}) {
  if (reducedMotion || !token) return;
  const a = rectCenter(from);
  const b = rectCenter(to);
  const ctrl = { x: (a.x + b.x) / 2 + (options.arcX || 40), y: Math.min(a.y, b.y) - (options.arc || 100) };
  const start = now();
  const timer = setInterval(() => {
    const u = clamp((now() - start) / Math.max(duration, 1), 0, 1);
    const p = quadPoint(a, ctrl, b, u);
    for (let i = 0; i < 2; i += 1) {
      spawn({
        kind: 'sprite',
        sprite: spriteName,
        x: p.x + rand(-9, 9),
        y: p.y + rand(-11, 11),
        vx: rand(-26, 26),
        vy: rand(-42, -4),
        size: rand(1.4, 3.2),
        life: rand(0.24, 0.5),
        alpha: rand(0.3, 0.75),
      });
    }
    if (u >= 1) clearInterval(timer);
  }, 26);
  ensureLoop();
  onCleanup(token, () => clearInterval(timer));
}

function landImpact(rect, color = faction.color) {
  if (!rect) return;
  const c = rectCenter(rect);
  addRing(c.x, c.y, { color, grow: 340, max: 0.55, width: 2.4 });
  addRing(c.x, c.y, { color: rgba(color, 1), grow: 200, max: 0.42, width: 1.4, alpha: 0.5 });
  burstAt({ x: c.x, y: rect.y + rect.h * 0.85 }, 16, 'dust', { speed: 80, size: 4, life: 0.55, spread: Math.PI * 0.8, angle: -Math.PI / 2 });
  ensureLoop();
}

function shatterRect(rect) {
  if (!rect) return;
  const c = rectCenter(rect);
  for (let i = 0; i < 26; i += 1) {
    spawn({
      kind: 'shard',
      x: c.x + rand(-rect.w / 2, rect.w / 2),
      y: c.y + rand(-rect.h / 2, rect.h / 2),
      vx: rand(-220, 220),
      vy: rand(-260, 40),
      ay: 620,
      rot: rand(0, TAU),
      vr: rand(-8, 8),
      size: rand(3, 11),
      life: rand(0.5, 1.1),
      alpha: rand(0.65, 1),
      color: Math.random() < 0.6 ? '#ffcf7a' : '#a63a2a',
      blend: 'source-over',
      drag: 0.6,
    });
  }
  burstAt(c, 22, 'ember', { speed: 160, size: 2.8, life: 0.8 });
}

function placeGhostAt(node, rect) {
  if (!node || !rect) return;
  try {
    node.style.width = `${rect.w}px`;
    node.style.height = `${rect.h}px`;
    node.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`;
  } catch {
    /* noop */
  }
}

function fadeGhostQuick(node, rect, duration = 240) {
  if (!node) return;
  placeGhostAt(node, rect);
  try {
    const anim = node.animate([{ opacity: 0 }, { opacity: 1 }], { duration, fill: 'forwards' });
    anim.finished.then(() => node.remove(), () => node.remove());
  } catch {
    node.remove();
  }
}

// ============================================================================
//  effect: cardPlay / cardSummon
// ============================================================================
function doCardPlay(args = {}) {
  return guard(1600, async (token) => {
    ensureAll();
    const { fromRect, toEl, card, faceDown = false } = args || {};
    const dest = resolvePlayDestination(toEl, fromRect);
    const toRect = dest.cardEl ? rectOf(dest.cardEl) || dest.rect : dest.rect;
    const from = resolveFromRect(fromRect, card) || {
      x: Math.max(12, toRect.x - Math.min(240, W * 0.14)),
      y: H - (toRect.h || DEFAULT_CARD_H) - 24,
      w: toRect.w || DEFAULT_CARD_W,
      h: toRect.h || DEFAULT_CARD_H,
    };
    // 幽灵牌的牌面来源：优先目标卡牌，其次反查 fromRect 处的手牌 DOM
    const sourceEl = dest.cardEl || cardElAtPoint(rectCenter(from));
    const sourceRect = rectOf(sourceEl) || from;
    const ghost = createCardGhost({ el: sourceEl, rect: sourceRect, card, faceDown });
    if (!ghost) {
      landImpact(toRect);
      return;
    }
    onCleanup(token, () => {
      try {
        ghost.remove();
      } catch {
        /* noop */
      }
    });
    // 若目标是真实卡牌 DOM，飞行期间先隐藏，落位瞬间再显示
    let targetHidden = false;
    if (dest.cardEl && dest.cardEl.style && !faceDown && !reducedMotion) {
      try {
        dest.cardEl.style.visibility = 'hidden';
        targetHidden = true;
        onCleanup(token, () => {
          try {
            dest.cardEl.style.visibility = '';
          } catch {
            /* noop */
          }
        });
      } catch {
        /* noop */
      }
    }
    const showTarget = () => {
      if (!targetHidden) return;
      targetHidden = false;
      try {
        dest.cardEl.style.visibility = '';
      } catch {
        /* noop */
      }
    };
    if (reducedMotion) {
      fadeGhostQuick(ghost, toRect, 220);
      later(() => {
        showTarget();
        if (dest.cardEl) flashClass(dest.cardEl, 'fx-landed', 600);
      }, 200);
      await wait(240);
      return;
    }
    const duration = 470;
    // clone 手牌保持原尺寸，用 scale 收进目标槽位，避免压扁牌面
    const useScale = isCardEl(sourceEl) && isNum(toRect.w) && isNum(sourceRect.w) && sourceRect.w > 0;
    const scaleTo = useScale ? clamp(toRect.w / sourceRect.w, 0.4, 1.4) : null;
    emitTrail(token, from, toRect, duration, 'gold', { arc: 110 });
    await flyGhost(token, ghost, from, toRect, {
      duration,
      arc: 120,
      rotate: -6,
      scaleTo,
      sourceSize: useScale ? { w: sourceRect.w, h: sourceRect.h } : null,
    });
    showTarget();
    if (token.cancelled) return;
    landImpact(toRect, faction.color);
    if (dest.cardEl) flashClass(dest.cardEl, 'fx-landed', 640);
    else if (dest.rowEl) flashClass(dest.rowEl, 'fx-gold-breathe', 900);
    dustAt(toRect, 10);
    doShake(0.45);
  });
}

function resolveFromRect(candidate, card) {
  const direct = normRect(candidate);
  if (direct) return direct;
  if (typeof config.getCardRect === 'function') {
    try {
      const key = card && typeof card === 'object' ? card.uid ?? card.id : card;
      const r = normRect(config.getCardRect(key));
      if (r) return r;
    } catch {
      /* noop */
    }
  }
  return null;
}

function deckOriginFor(rect) {
  const decks = Array.from(document.querySelectorAll('[data-fx-deck], [data-deck]')).filter((el) => el.nodeType === 1);
  if (decks.length && rect) {
    let best = null;
    let bestDist = Infinity;
    for (const el of decks) {
      const r = rectOf(el);
      if (!r) continue;
      const c = rectCenter(r);
      const dist = Math.hypot(c.x - rectCenter(rect).x, c.y - rectCenter(rect).y);
      if (dist < bestDist) {
        bestDist = dist;
        best = r;
      }
    }
    if (best) return best;
  }
  // 兜底：从画面右侧偏上（AI 牌堆方向）飞出
  return { x: W - 150, y: H * 0.36, w: 104, h: 144 };
}

function doCardSummon(args = {}) {
  return guard(1600, async (token) => {
    ensureAll();
    const { toEl, card } = args || {};
    const dest = resolvePlayDestination(toEl, null);
    const toRect = dest.cardEl ? rectOf(dest.cardEl) || dest.rect : dest.rect;
    const ghost = createCardGhost({ el: dest.cardEl, rect: toRect, card, className: 'fx-ghost--summon' });
    if (!ghost) {
      landImpact(toRect);
      return;
    }
    onCleanup(token, () => {
      try {
        ghost.remove();
      } catch {
        /* noop */
      }
    });
    if (reducedMotion) {
      fadeGhostQuick(ghost, toRect, 200);
      landImpact(toRect);
      await wait(220);
      return;
    }
    const from = deckOriginFor(toRect);
    emitTrail(token, from, toRect, 520, 'dust', { arc: 130, arcX: 70 });
    await flyGhost(token, ghost, from, toRect, { duration: 520, arc: 130, rotate: 8 });
    if (token.cancelled) return;
    landImpact(toRect, faction.glow);
    dustAt(toRect, 12);
  });
}

// ============================================================================
//  effect: scorch
// ============================================================================
function doScorch(args = {}) {
  return guard(2500, async (token) => {
    ensureAll();
    const els = normalizeEls(args && args.els);
    const cardEls = normalizeEls(args && args.cardEls);
    const sourceRect = cardEls.length ? rectOf(cardEls[0]) : null;
    const source = sourceRect ? rectCenter(sourceRect) : { x: W / 2, y: H * 0.1 };
    const targets = els
      .map((el) => ({ el, rect: rectOf(el) }))
      .filter((t) => t.rect);

    if (!targets.length) {
      // 无 DOM 信息：全场火线 + 屏震，信息由日志/横幅承担
      addBeam(source.x, source.y, W / 2, H * 0.55, { color: '#ffa050', width: 3 });
      for (let i = 0; i < 3; i += 1) {
        later(() => addBeam(rand(0, W), -20, rand(0, W), H * 0.8, { color: '#ff9a4d', width: 2.4 }), i * 110);
      }
      startBurning(token, null, { x: W * 0.2, y: H * 0.4, w: W * 0.6, h: H * 0.3 }, 780);
      doScreenFlash('#ff7a2f', 0.09);
      doShake(1);
      await wait(900);
      return;
    }

    doShake(1.15);
    doScreenFlash('#ffb066', 0.08);
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      const center = rectCenter(target.rect);
      later(() => addBeam(source.x, source.y, center.x, center.y, { color: '#ffa050', width: 3.2 }), i * 110);
      later(() => {
        if (token.cancelled) return;
        startBurning(token, target.el, target.rect, 900);
        burstAt(center, 20, 'ember', { speed: 130, size: 3.2, life: 0.85 });
        addRing(center.x, center.y, { color: '#ff7a2f', grow: 220, max: 0.5, width: 2 });
        dustAt(target.rect, 8);
      }, 160 + i * 110);
    }
    await wait(560 + targets.length * 110 + 420);
  });
}

function startBurning(token, el, rect, duration = 1000) {
  if (!rect) return;
  if (el && el.classList) {
    el.classList.add('fx-burning');
    later(() => {
      try {
        el.classList.remove('fx-burning');
      } catch {
        /* noop */
      }
    }, duration + 520);
  }
  const endAt = now() + duration;
  const timer = setInterval(() => {
    if (now() > endAt || token.cancelled) {
      clearInterval(timer);
      return;
    }
    const x = rect.x + rand(0, rect.w);
    const y = rect.y + rect.h * rand(0.3, 0.95);
    spawn({
      kind: 'sprite',
      sprite: Math.random() < 0.7 ? 'ember' : 'gold',
      x,
      y,
      vx: rand(-16, 16),
      vy: rand(-105, -45),
      size: rand(2, 6.5),
      life: rand(0.4, 0.95),
      alpha: rand(0.55, 1),
      ay: -20,
      drag: 0.5,
    });
    if (Math.random() < 0.22) {
      spawn({
        kind: 'sprite',
        sprite: 'smoke',
        blend: 'source-over',
        x,
        y: y - 16,
        vx: rand(-9, 9),
        vy: rand(-34, -12),
        size: rand(26, 70),
        life: rand(0.9, 1.6),
        alpha: 0.09,
        rot: rand(0, TAU),
        vr: rand(-0.3, 0.3),
      });
    }
  }, 45);
  onCleanup(token, () => clearInterval(timer));
  ensureLoop();
}

// ============================================================================
//  effect: weather
// ============================================================================
function updateWeatherTint() {
  if (!dom) return;
  const active = ['frost', 'fog', 'rain', 'storm'].filter((k) => weather[k]);
  for (const kind of ['frost', 'fog', 'rain', 'storm']) {
    if (dom.tintLayers[kind]) dom.tintLayers[kind].classList.toggle('is-on', !!weather[kind]);
  }
  dom.tint.classList.toggle('is-active', active.length > 0);
  dom.tint.dataset.weather = active.join(' ') || 'clear';
  dom.tint.dataset.faction = faction.id;
}

function weatherBurst(kind) {
  if (reducedMotion) return;
  if (kind === 'frost') {
    for (let i = 0; i < 72; i += 1) {
      spawn({
        kind: 'sprite',
        sprite: 'ice',
        x: rand(0, W),
        y: rand(-40, H * 0.92),
        vx: rand(-24, 24),
        vy: rand(14, 56),
        size: rand(2, 6),
        life: rand(3, 7),
        alpha: rand(0.45, 1),
        rot: rand(0, TAU),
        vr: rand(-1.2, 1.2),
      });
    }
  } else if (kind === 'rain' || kind === 'storm') {
    for (let i = 0; i < 70; i += 1) {
      spawn({
        kind: 'rain',
        x: rand(-60, W + 90),
        y: rand(-H * 0.4, H),
        vx: rand(-180, -80),
        vy: rand(700, 1100),
        len: rand(14, 30),
        life: rand(0.5, 1.2),
        alpha: rand(0.16, 0.34),
        blend: 'source-over',
      });
    }
    if (kind === 'storm') {
      stormTimer = 0.4;
      triggerLightning();
    }
  } else if (kind === 'fog') {
    for (let i = 0; i < 12; i += 1) smokePuff({ x: rand(0, W), y: rand(H * 0.2, H * 0.9) }, { size: rand(240, 420), life: rand(2, 4), alpha: 0.06 });
  } else if (kind === 'clear') {
    for (let i = 0; i < 40; i += 1) {
      spawn({
        kind: 'sprite',
        sprite: 'gold',
        x: rand(0, W),
        y: rand(0, H),
        vx: rand(-30, 30),
        vy: rand(-30, 30),
        size: rand(1.4, 4),
        life: rand(0.6, 1.6),
        alpha: rand(0.2, 0.6),
      });
    }
  }
  ensureLoop();
}

function doWeather(kind, active = true) {
  return guard(1700, async (token) => {
    ensureAll();
    const k = String(kind || 'clear').toLowerCase();
    if (k === 'clear' || k === 'none' || k === 'reset') {
      for (const key of Object.keys(weather)) weather[key] = false;
      updateWeatherTint();
      if (!reducedMotion) weatherBurst('clear');
      doScreenFlash(WEATHER_FLASH.clear[0], WEATHER_FLASH.clear[1]);
      ensureLoop();
      await wait(480);
      return;
    }
    if (!(k in weather)) return;
    const on = active !== false;
    const changed = weather[k] !== on;
    weather[k] = on;
    updateWeatherTint();
    if (on && changed) {
      const flash = WEATHER_FLASH[k] || WEATHER_FLASH.fog;
      doScreenFlash(flash[0], flash[1]);
      weatherBurst(k);
      doShake(k === 'storm' ? 1 : 0.35);
    }
    ensureLoop();
    await wait(on ? 760 : 380);
    if (token.cancelled) return;
  });
}

// ============================================================================
//  effect: horn / mardroeme
// ============================================================================
function doHorn(rowArg) {
  return guard(1900, async (token) => {
    ensureAll();
    const rowEl = resolveElArg(rowArg, ['rowEl', 'el', 'toRowEl']);
    const rect = rectOf(rowEl) || { x: W * 0.12, y: H * 0.46, w: W * 0.76, h: H * 0.12 };
    const center = rectCenter(rect);
    flashClass(rowEl, 'fx-gold-breathe', 1700);
    for (let i = 0; i < 3; i += 1) {
      later(() => addRing(center.x, center.y, { color: '#f0d078', grow: 420, max: 0.95, width: 3, startR: 12 }), i * 150);
    }
    if (!reducedMotion) {
      for (let i = 0; i < 46; i += 1) {
        spawn({
          kind: 'sprite',
          sprite: Math.random() < 0.75 ? 'gold' : 'dust',
          x: rect.x + rand(0, rect.w),
          y: rect.y + rect.h * rand(0.5, 1),
          vx: rand(-16, 16),
          vy: rand(-90, -35),
          size: rand(1.4, 3.6),
          life: rand(0.9, 2),
          alpha: rand(0.35, 0.85),
          drag: 0.3,
        });
      }
      doShake(0.35);
      doScreenFlash('#f0d078', 0.1);
      ensureLoop();
    }
    await wait(850);
    if (token.cancelled) return;
  });
}

function doMardroeme(rowArg, transformedEls) {
  return guard(2200, async (token) => {
    ensureAll();
    const rowEl = resolveElArg(rowArg, ['rowEl', 'el', 'toRowEl']);
    const rect = rectOf(rowEl) || { x: W * 0.12, y: H * 0.48, w: W * 0.76, h: H * 0.16 };
    addRoots(rect);
    doScreenFlash('#7a1f1f', 0.12);
    doShake(1.2);
    const els = normalizeEls(transformedEls);
    for (const el of els) {
      flashClass(el, 'fx-mardroeme', 1500);
      const r = rectOf(el);
      if (r) burstAt(rectCenter(r), 12, 'blood', { speed: 100, size: 2.6, life: 0.7 });
    }
    if (!els.length) burstAt(rectCenter(rect), 16, 'blood', { speed: 90, size: 3, life: 0.8 });
    await wait(950);
    if (token.cancelled) return;
  });
}

// ============================================================================
//  effect: spy / medic / muster / avenger
// ============================================================================
function doSpy(args = {}) {
  return guard(1800, async (token) => {
    ensureAll();
    const { fromEl, toRowEl, card } = args || {};
    const from = rectOf(fromEl) || { x: W * 0.5 - DEFAULT_CARD_W / 2, y: H * 0.7, w: DEFAULT_CARD_W, h: DEFAULT_CARD_H };
    const to = rectOf(toRowEl) || fallbackCardRect(0.5, 0.34);
    const ghost = createCardGhost({ el: fromEl, rect: from, card, faceDown: false, className: 'fx-ghost--spy' });
    if (ghost) {
      placeGhostAt(ghost, from);
      onCleanup(token, () => {
        try {
          ghost.remove();
        } catch {
          /* noop */
        }
      });
    }
    const a = rectCenter(from);
    const b = rectCenter(to);
    if (!reducedMotion) {
      for (let i = 0; i < 7; i += 1) {
        later(() => smokePuff({ x: lerp(a.x, b.x, i / 7) + rand(-40, 40), y: lerp(a.y, b.y, i / 7) + rand(-30, 30) }, { size: rand(70, 150), life: rand(0.8, 1.6) }), i * 60);
      }
      await wait(300);
      if (token.cancelled) return;
      if (ghost) {
        const tx = a.x - from.w / 2;
        const ty = a.y - from.h / 2;
        try {
          ghost.style.width = `${from.w}px`;
          ghost.style.height = `${from.h}px`;
          ghost.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
          await ghost
            .animate(
              [
                { transform: `translate3d(${tx}px, ${ty}px, 0) scaleX(1)` },
                { transform: `translate3d(${tx}px, ${ty}px, 0) scaleX(.06)` },
                { transform: `translate3d(${tx}px, ${ty}px, 0) scaleX(1)` },
              ],
              { duration: 320, easing: 'cubic-bezier(.4,0,.2,1)' }
            )
            .finished.catch(() => {});
        } catch {
          /* noop */
        }
      }
      if (token.cancelled) return;
      emitTrail(token, from, to, 420, 'smoke', { arc: 60 });
      if (ghost) await flyGhost(token, ghost, from, to, { duration: 420, arc: 70, rotate: -4 });
      smokePuff(rectCenter(to), { size: 150, life: 1.2, alpha: 0.16 });
      burstAt(rectCenter(to), 12, 'smoke', { speed: 60, size: 5, life: 0.7 });
    } else {
      if (ghost) {
        fadeGhostQuick(ghost, to, 220);
      }
      await wait(220);
    }
    if (token.cancelled) return;
    if (toRowEl) flashClass(toRowEl, 'fx-dim-row', 700);
    await wait(260);
  });
}

function doMedic(args = {}) {
  return guard(1900, async (token) => {
    ensureAll();
    const { fromEl, toRowEl } = args || {};
    const from = rectOf(fromEl) || { x: 40, y: H * 0.72, w: 90, h: 126 };
    const toRect = rectOf(toRowEl) || fallbackCardRect(0.5, 0.56);
    const a = rectCenter(from);
    const b = rectCenter(toRect);
    spawnOrb(a, b, { dur: reducedMotion ? 0.3 : 0.85 });
    if (!reducedMotion) {
      for (let i = 0; i < 5; i += 1) {
        later(() => burstAt({ x: lerp(a.x, b.x, i / 5) + rand(-20, 20), y: lerp(a.y, b.y, i / 5) + rand(-20, 20) }, 4, 'soul', { speed: 40, size: 2, life: 0.5, alpha: 0.5 }), i * 120);
      }
    }
    await wait(reducedMotion ? 320 : 780);
    if (token.cancelled) return;
    burstAt(b, 24, 'soul', { speed: 90, size: 2.6, life: 0.8 });
    addRing(b.x, b.y, { color: '#a8e6c0', grow: 230, max: 0.7, width: 2.4 });
    addRing(b.x, b.y, { color: '#ffffff', grow: 140, max: 0.5, width: 1.4, alpha: 0.6 });
    if (toRowEl) flashClass(toRowEl, 'fx-revive-row', 1100);
    await wait(320);
  });
}

function doMuster(args = {}) {
  return guard(2200, async (token) => {
    ensureAll();
    const els = normalizeEls(args && args.cardEls);
    const items = els
      .map((el) => ({ el, rect: rectOf(el) }))
      .filter((item) => item.rect);
    if (!items.length) {
      items.push({ el: null, rect: fallbackCardRect(0.5, 0.42) });
    }
    if (reducedMotion) {
      for (const item of items) landImpact(item.rect, faction.glow);
      await wait(260);
      return;
    }
    const flights = [];
    let index = 0;
    for (const item of items) {
      const delay = index * 100;
      index += 1;
      later(() => {
        if (token.cancelled) return;
        const from = deckOriginFor(item.rect);
        const ghost = createCardGhost({ el: item.el, rect: item.rect, className: 'fx-ghost--summon' });
        if (!ghost) {
          landImpact(item.rect, faction.glow);
          return;
        }
        emitTrail(token, from, item.rect, 430, 'dust', { arc: 110, arcX: 60 });
        flights.push(flyGhost(token, ghost, from, item.rect, { duration: 430, arc: 110, rotate: 7 }));
        later(() => {
          landImpact(item.rect, faction.glow);
          dustAt(item.rect, 9);
        }, 430);
      }, delay);
    }
    await wait(index * 100 + 500);
    await Promise.all(flights);
    if (token.cancelled) return;
  });
}

function doAvenger(args = {}) {
  return guard(2400, async (token) => {
    ensureAll();
    const els = normalizeEls(args && args.els);
    const tokenEl = args && args.tokenEl && args.tokenEl.nodeType === 1 ? args.tokenEl : null;
    const rects = els.map((el) => rectOf(el)).filter(Boolean);
    if (!rects.length) rects.push(fallbackCardRect(0.5, 0.5));
    for (const rect of rects) shatterRect(rect);
    doScreenFlash('#ffb066', 0.1);
    doShake(1.5);
    for (const el of els) flashClass(el, 'fx-shatter', 900);
    await wait(reducedMotion ? 240 : 420);
    if (token.cancelled) return;
    const tokenRect = rectOf(tokenEl) || { x: W / 2 - DEFAULT_CARD_W / 2, y: H / 2 - DEFAULT_CARD_H / 2, w: DEFAULT_CARD_W, h: DEFAULT_CARD_H };
    const c = rectCenter(tokenRect);
    if (tokenEl) {
      flashClass(tokenEl, 'fx-token-rise', 1500);
      if (!reducedMotion) {
        try {
          const anim = tokenEl.animate(
            [
              { opacity: 0, transform: 'translateY(26px) scale(.45)', filter: 'brightness(1.8)' },
              { opacity: 1, transform: 'translateY(0) scale(1)', filter: 'brightness(1)' },
            ],
            { duration: 560, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'backwards' }
          );
          onCleanup(token, () => {
            try {
              anim.cancel();
            } catch {
              /* noop */
            }
          });
        } catch {
          /* noop */
        }
      }
    }
    burstAt(c, 30, 'gold', { speed: 150, size: 3, life: 0.9 });
    addRing(c.x, c.y, { color: '#f0d078', grow: 320, max: 0.8, width: 2.6 });
    addRing(c.x, c.y, { color: '#ff6b5a', grow: 200, max: 0.55, width: 2 });
    await wait(620);
    if (token.cancelled) return;
  });
}

// ============================================================================
//  effect: leaderActivate
// ============================================================================
function buildCloseupEl(el, rect, fid) {
  const wrap = div('fx-leader-closeup');
  const inner = div('fx-closeup-inner');
  const w = (rect && rect.w) || 160;
  const h = (rect && rect.h) || 224;
  // 按视口缩放：小领袖卡放大到电影级特写，大元素则不夸张
  const targetH = Math.min(H * 0.52, 580);
  const targetW = Math.min(W * 0.36, 440);
  const scale = clamp(Math.min(targetW / w, targetH / h), 1.15, 3.4);
  inner.style.transform = `scale(${scale})`;
  if (el && el.nodeType === 1) {
    try {
      const clone = el.cloneNode(true);
      clone.removeAttribute('id');
      if (clone.querySelectorAll) clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      clone.classList.add('fx-closeup-card');
      clone.setAttribute('aria-hidden', 'true');
      clone.style.pointerEvents = 'none';
      clone.style.transition = 'none';
      clone.style.margin = '0';
      clone.style.width = `${w}px`;
      clone.style.height = `${h}px`;
      clone.style.position = 'relative';
      clone.style.left = 'auto';
      clone.style.top = 'auto';
      inner.appendChild(clone);
    } catch {
      /* fallthrough */
    }
  }
  if (!inner.firstChild) {
    const emblem = div('fx-leader-emblem');
    const ring = div('fx-leader-emblem__ring');
    const name = div('fx-leader-emblem__name');
    name.textContent = FACTION_NAMES[fid] || '中立';
    emblem.append(ring, name);
    inner.appendChild(emblem);
  }
  wrap.appendChild(inner);
  return wrap;
}

function doLeaderActivate(args = {}) {
  return guard(2200, async (token) => {
    ensureAll();
    const el = args && args.el && args.el.nodeType === 1 ? args.el : resolveElArg(args, ['el', 'leaderEl']);
    const fid = (args && args.faction) || faction.id || 'neutral';
    const colors = getFactionColors(fid);
    if (fid !== faction.id) doSetFactionTheme(fid);
    const rect = rectOf(el) || { x: W / 2 - 100, y: H * 0.18, w: 200, h: 280 };
    const wrap = buildCloseupEl(el, rect, colors.id);
    dom.banner.appendChild(wrap);
    onCleanup(token, () => wrap.remove());

    // 暗角
    if (dom.vignette) {
      dom.vignette.style.setProperty('--fx-vig-color', rgba(colors.color, 0.82));
      try {
        const vigIn = dom.vignette.animate([{ opacity: 0 }, { opacity: 0.95 }], { duration: reducedMotion ? 140 : 240, fill: 'forwards' });
        onCleanup(token, () => {
          try {
            vigIn.cancel();
          } catch {
            /* noop */
          }
          dom.vignette.style.opacity = '';
        });
      } catch {
        /* noop */
      }
    }

    if (!reducedMotion) {
      burstAt({ x: W / 2, y: H / 2 }, 46, 'faction', { speed: 260, size: 4, life: 1.0, alpha: 0.6 });
      addRing(W / 2, H / 2, { color: colors.glow, grow: 640, max: 1.1, width: 3 });
      addRing(W / 2, H / 2, { color: colors.color, grow: 420, max: 0.9, width: 5, alpha: 0.4 });
      doScreenFlash(colors.glow, 0.24);
      doShake(1);
    } else {
      doScreenFlash(colors.glow, 0.1);
    }

    try {
      wrap.animate(
        [
          { opacity: 0, transform: 'scale(.82)' },
          { opacity: 1, transform: 'scale(1)' },
        ],
        { duration: reducedMotion ? 160 : 340, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' }
      );
    } catch {
      /* noop */
    }
    await wait(reducedMotion ? 420 : 700);
    if (token.cancelled) return;
    try {
      await wrap
        .animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(1.05)' }], { duration: 300, fill: 'forwards' })
        .finished.catch(() => {});
    } catch {
      /* noop */
    }
    if (dom && dom.vignette) {
      try {
        await dom.vignette.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration: 360, fill: 'forwards' }).finished.catch(() => {});
      } catch {
        /* noop */
      }
      dom.vignette.style.opacity = '';
    }
    await wait(120);
  });
}

// ============================================================================
//  effect: roundBanner / gameOver / coinFlip
// ============================================================================
function buildBanner(options = {}) {
  const { variant = 'win', eyebrow = '', title = '', scoreText = '', gems = null } = options;
  const wrap = div(`fx-banner fx-banner--${variant}`);
  const ruleTop = div('fx-banner__rule');
  const eyebrowEl = div('fx-banner__eyebrow');
  eyebrowEl.textContent = eyebrow;
  const titleEl = div('fx-banner__title');
  titleEl.textContent = title;
  wrap.append(ruleTop, eyebrowEl, titleEl);
  if (scoreText) {
    const score = div('fx-banner__score');
    score.textContent = scoreText;
    wrap.appendChild(score);
  }
  const gemRow = buildGemRow(gems);
  if (gemRow) wrap.appendChild(gemRow);
  wrap.appendChild(div('fx-banner__rule fx-banner__rule--bottom'));
  return wrap;
}

function buildGemRow(gems) {
  const nums = normalizeGemCounts(gems);
  if (!nums) return null;
  const wrap = div('fx-banner__gems');
  const total = Math.max(2, Math.round(Math.max(nums[0], nums[1])));
  ['我方', '对方'].forEach((label, i) => {
    const group = div('fx-gem-group');
    const name = div('fx-gem-group__label');
    name.textContent = label;
    const row = div('fx-gem-group__row');
    const lit = clamp(Math.round(nums[i]), 0, total);
    for (let g = 0; g < total; g += 1) {
      row.appendChild(div(`fx-gem ${g < lit ? 'is-lit' : 'is-lost'}`));
    }
    group.append(name, row);
    wrap.appendChild(group);
  });
  return wrap;
}

function doRoundBanner(args = {}) {
  const nowTs = now();
  const rawKind = String((args && args.kind) || 'draw').toLowerCase();
  const kind = rawKind === 'win' ? 'win' : rawKind === 'lose' ? 'lose' : 'draw';
  if (nowTs - lastBannerAt < 700 && lastBannerKind === kind) return Promise.resolve();
  lastBannerAt = nowTs;
  lastBannerKind = kind;
  return guard(2500, async (token) => {
    ensureAll();
    const labels = {
      win: ['小局结算 · ROUND WON', '胜'],
      lose: ['小局结算 · ROUND LOST', '负'],
      draw: ['小局结算 · ROUND DRAWN', '平'],
    };
    const scores = normalizeScores(args && args.scores);
    const wrap = buildBanner({
      variant: kind,
      eyebrow: labels[kind][0],
      title: labels[kind][1],
      scoreText: scores ? `${scores[0]} : ${scores[1]}` : '',
      gems: args && args.gems,
    });
    dom.banner.appendChild(wrap);
    onCleanup(token, () => wrap.remove());
    const titleEl = wrap.querySelector('.fx-banner__title');
    try {
      wrap.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reducedMotion ? 140 : 260, fill: 'forwards' });
      if (titleEl) {
        titleEl.animate(
          [
            { opacity: 0, transform: 'scale(1.8) rotate(-5deg)' },
            { opacity: 1, transform: 'scale(1) rotate(-2deg)' },
          ],
          {
            duration: reducedMotion ? 140 : 420,
            delay: reducedMotion ? 0 : 90,
            easing: 'cubic-bezier(.2,.9,.3,1.15)',
            fill: 'forwards',
          }
        );
      }
    } catch {
      /* noop */
    }
    if (!reducedMotion) {
      const color = kind === 'win' ? '#f0d078' : kind === 'lose' ? '#ff6b5a' : '#d9cbb3';
      doScreenFlash(color, kind === 'lose' ? 0.1 : 0.14);
      addRing(W / 2, H / 2, { color, grow: 520, max: 0.9, width: 2.2, alpha: 0.5 });
      burstAt({ x: W / 2, y: H / 2 }, 26, kind === 'win' ? 'gold' : kind === 'lose' ? 'blood' : 'white', { speed: 180, size: 2.6, life: 0.9 });
      doShake(kind === 'win' ? 0.8 : 0.5);
    }
    await wait(reducedMotion ? 900 : 1500);
    if (token.cancelled) return;
    try {
      await wrap.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(1.03)' }], { duration: 320, fill: 'forwards' }).finished.catch(() => {});
    } catch {
      /* noop */
    }
  });
}

function resolveOutcome(winner, view) {
  if (winner === null || winner === undefined || winner === -1 || winner === 'draw') return 'draw';
  if (typeof winner === 'boolean') return winner ? 'win' : 'lose';
  if (typeof winner === 'number' && Number.isFinite(winner)) {
    const players = view && Array.isArray(view.players) ? view.players : null;
    if (players && players[winner]) {
      if (players[winner].isAI === true) return 'lose';
      if (players[winner].isAI === false) return 'win';
    }
    const human = humanIndex(view);
    if (human != null) return winner === human ? 'win' : 'lose';
    return winner === 0 ? 'win' : 'lose';
  }
  const text = String(winner).toLowerCase();
  if (text === 'player' || text === 'human' || text === 'you' || text === 'win') return 'win';
  if (text === 'ai' || text === 'opponent' || text === 'lose') return 'lose';
  return 'draw';
}

function goldRain(count = 210) {
  for (let i = 0; i < count; i += 1) {
    spawn({
      kind: 'sprite',
      sprite: Math.random() < 0.8 ? 'gold' : 'white',
      x: rand(0, W),
      y: rand(-H * 0.6, -10),
      vx: rand(-30, 30),
      vy: rand(240, 520),
      ax: rand(-12, 12),
      size: rand(1.8, 5.4),
      life: rand(2.4, 3.6),
      alpha: rand(0.5, 1),
      rot: rand(0, TAU),
      vr: rand(-2, 2),
      drag: 0.02,
    });
  }
  ensureLoop();
}

function darkEmbers(count = 140) {
  for (let i = 0; i < count; i += 1) {
    spawn({
      kind: 'sprite',
      sprite: Math.random() < 0.75 ? 'blood' : 'ember',
      x: rand(0, W),
      y: rand(H * 0.5, H + 60),
      vx: rand(-20, 20),
      vy: rand(-70, -22),
      ax: rand(-8, 8),
      size: rand(1.2, 4.2),
      life: rand(2.6, 4.4),
      alpha: rand(0.25, 0.7),
      rot: rand(0, TAU),
      vr: rand(-1.4, 1.4),
    });
  }
  ensureLoop();
}

function silverDust(count = 120) {
  for (let i = 0; i < count; i += 1) {
    spawn({
      kind: 'sprite',
      sprite: 'dust',
      x: rand(0, W),
      y: rand(0, H),
      vx: rand(-14, 14),
      vy: rand(-26, -4),
      size: rand(1.4, 4),
      life: rand(1.6, 3.2),
      alpha: rand(0.25, 0.6),
    });
  }
  ensureLoop();
}

function doGameOver(args = {}) {
  const nowTs = now();
  if (nowTs - lastGameOverAt < 1200) return Promise.resolve();
  lastGameOverAt = nowTs;
  return guard(2500, async (token) => {
    ensureAll();
    const view = args && args.view;
    const outcome = resolveOutcome(args && args.winner, view);
    const labels = {
      win: ['GWENT · VICTORY', '胜 利'],
      lose: ['GWENT · DEFEAT', '败 北'],
      draw: ['GWENT · DRAW', '平 局'],
    };
    const wrap = div(`fx-gameover fx-gameover--${outcome}`);
    const eyebrow = div('fx-gameover__eyebrow');
    eyebrow.textContent = labels[outcome][0];
    const title = div('fx-gameover__title');
    title.textContent = labels[outcome][1];
    wrap.append(eyebrow, title);

    let scoreText = '';
    try {
      const players = view && Array.isArray(view.players) ? view.players : [];
      const human = humanIndex(view);
      if (human != null && players[1 - human]) {
        const mine = Number(players[human] && players[human].gems);
        const theirs = Number(players[1 - human] && players[1 - human].gems);
        if (Number.isFinite(mine) && Number.isFinite(theirs)) scoreText = `宝石 ${mine} : ${theirs}`;
      }
    } catch {
      /* noop */
    }
    if (scoreText) {
      const sub = div('fx-gameover__sub');
      sub.textContent = scoreText;
      wrap.appendChild(sub);
    }
    dom.banner.appendChild(wrap);
    onCleanup(token, () => wrap.remove());

    if (!reducedMotion) {
      if (outcome === 'win') {
        goldRain(220);
        doScreenFlash('#ffe9b0', 0.28);
        addRing(W / 2, H / 2, { color: '#f0d078', grow: 780, max: 1.4, width: 3 });
        doShake(1.2);
      } else if (outcome === 'lose') {
        darkEmbers(150);
        doScreenFlash('#3a1414', 0.16);
        if (dom.vignette) {
          dom.vignette.style.setProperty('--fx-vig-color', 'rgba(40, 8, 8, .9)');
          try {
            dom.vignette.animate([{ opacity: 0 }, { opacity: 0.9 }], { duration: 900, fill: 'forwards' });
          } catch {
            /* noop */
          }
        }
        doShake(0.5);
      } else {
        silverDust(130);
        doScreenFlash('#d9cbb3', 0.14);
      }
    } else {
      doScreenFlash(outcome === 'win' ? '#ffe9b0' : outcome === 'lose' ? '#3a1414' : '#d9cbb3', 0.12);
    }

    try {
      wrap.animate(
        [
          { opacity: 0, transform: 'scale(1.24)' },
          { opacity: 1, transform: 'scale(1)' },
        ],
        { duration: reducedMotion ? 160 : 520, easing: 'cubic-bezier(.16,.8,.3,1.1)', fill: 'forwards' }
      );
    } catch {
      /* noop */
    }
    await wait(reducedMotion ? 800 : 1900);
    if (token.cancelled) return;
    try {
      await wrap.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, fill: 'forwards' }).finished.catch(() => {});
    } catch {
      /* noop */
    }
    if (dom && dom.vignette) {
      try {
        await dom.vignette.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 420, fill: 'forwards' }).finished.catch(() => {});
      } catch {
        /* noop */
      }
      dom.vignette.style.opacity = '';
    }
  });
}

function coinLabelFor(firstPlayer) {
  if (firstPlayer === 0) return '先手 · 玩家';
  if (firstPlayer === 1) return '先手 · 对手';
  if (firstPlayer === true) return '先手 · 玩家';
  if (firstPlayer === false) return '先手 · 对手';
  const n = Number(firstPlayer);
  if (Number.isFinite(n)) return `先手 · ${n === 0 ? '玩家' : '对手'}`;
  return '先手已定';
}

function doCoinFlip(args = {}) {
  const nowTs = now();
  if (nowTs - lastCoinAt < 900) return Promise.resolve();
  lastCoinAt = nowTs;
  return guard(2200, async (token) => {
    ensureAll();
    const firstPlayer = args && args.firstPlayer;
    const stage = div('fx-coin-stage');
    const coin = div('fx-coin');
    const front = div('fx-coin__face fx-coin__face--front');
    const back = div('fx-coin__face fx-coin__face--back');
    const sun = div('fx-coin__sun');
    const rune = div('fx-coin__rune');
    front.appendChild(sun);
    back.appendChild(rune);
    const shadow = div('fx-coin__shadow');
    const label = div('fx-coin__label');
    label.textContent = coinLabelFor(firstPlayer);
    stage.append(coin, shadow, label);
    dom.coin.appendChild(stage);
    onCleanup(token, () => stage.remove());
    coin.append(front, back);

    const center = { x: W / 2, y: H / 2 };
    try {
      const spin = coin.animate(
        reducedMotion
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { transform: 'translateY(-30px) rotateX(0deg) rotateZ(0deg) scale(.62)', opacity: 0, offset: 0 },
              { transform: 'translateY(-120px) rotateX(540deg) rotateZ(18deg) scale(1.12)', opacity: 1, offset: 0.22 },
              { transform: 'translateY(0px) rotateX(1080deg) rotateZ(-4deg) scale(1)', opacity: 1, offset: 0.78 },
              { transform: 'translateY(0px) rotateX(1080deg) rotateZ(0deg) scale(1)', opacity: 1, offset: 1 },
            ],
        { duration: reducedMotion ? 180 : 1100, easing: 'cubic-bezier(.24,.7,.3,1)', fill: 'forwards' }
      );
      onCleanup(token, () => {
        try {
          spin.cancel();
        } catch {
          /* noop */
        }
      });
      await spin.finished.catch(() => {});
    } catch {
      /* noop */
    }
    if (token.cancelled) return;
    label.classList.add('is-show');
    if (!reducedMotion) {
      addRing(center.x, center.y, { color: '#f0d078', grow: 520, max: 0.9, width: 3 });
      addRing(center.x, center.y, { color: '#ffe9b0', grow: 300, max: 0.6, width: 1.6, alpha: 0.6 });
      burstAt({ x: center.x, y: center.y + 20 }, 36, 'gold', { speed: 220, size: 2.8, life: 0.9 });
      doScreenFlash('#f0d078', 0.18);
      doShake(0.7);
    }
    await wait(reducedMotion ? 500 : 900);
    if (token.cancelled) return;
  });
}

// ============================================================================
//  faction theme / menu ambient
// ============================================================================
function doSetFactionTheme(factionId) {
  try {
    ensureAll();
    const colors = getFactionColors(factionId || (config && config.faction) || 'neutral');
    faction = colors;
    const targets = [document.documentElement, rootEl].filter(Boolean);
    for (const target of targets) {
      target.style.setProperty('--fx-faction', colors.color);
      target.style.setProperty('--fx-faction-glow', colors.glow);
      target.style.setProperty('--fx-faction-weak', rgba(colors.color, 0.22));
      target.style.setProperty('--fx-faction-soft', rgba(colors.color, 0.08));
    }
    if (dom) dom.tint.dataset.faction = colors.id;
    return colors;
  } catch (err) {
    warnOnce('setFactionTheme', err);
    return faction;
  }
}

function buildRunes() {
  if (!dom || dom.runes) return dom && dom.runes;
  const runes = div('fx-runes');
  ['outer', 'mid', 'inner'].forEach((size) => {
    runes.appendChild(div(`fx-runes__ring fx-runes__ring--${size}`));
  });
  const sigil = div('fx-runes__sigil');
  const core = div('fx-runes__core');
  sigil.appendChild(core);
  runes.appendChild(sigil);
  dom.layer.insertBefore(runes, dom.layer.firstChild);
  dom.runes = runes;
  return runes;
}

function doMenuAmbient(enabled = true) {
  return guard(1000, async () => {
    ensureAll();
    const on = !!enabled && !reducedMotion;
    ambientOn = on;
    if (on) {
      const runes = buildRunes();
      if (runes) runes.classList.add('is-active');
      ambientBurst();
      ensureLoop();
    } else if (dom && dom.runes) {
      dom.runes.classList.remove('is-active');
    }
  });
}

// ============================================================================
//  init / destroy
// ============================================================================
function doInit(options = {}) {
  if (initialized) return fxApi;
  try {
    if (typeof document === 'undefined') return fxApi;
    initialized = true;
    config = {
      root: null,
      canvas: null,
      getCardRect: null,
      faction: 'neutral',
      eventEffects: 'lite', // 'lite' | 'full' | 'off'
      eventAudio: true,
      menuAmbient: false,
      autoCoin: true, // 开局自动从 view.firstPlayer 补一次抛硬币（可用 false 关闭）
      ...options,
    };
    const rootOption = config.root;
    if (typeof rootOption === 'string') rootEl = safeQuery(rootOption);
    else if (rootOption && rootOption.nodeType === 1) rootEl = rootOption;
    if (!rootEl) rootEl = safeQuery('#app') || safeQuery('[data-fx-root]') || document.body;

    mountCanvas(config.canvas);
    mountDomLayer();
    resize();
    buildSprites();
    bindGlobals();
    doSetFactionTheme(config.faction || 'neutral');
    if (config.menuAmbient) doMenuAmbient(true);
    return fxApi;
  } catch (err) {
    warnOnce('init', err);
    return fxApi;
  }
}

function ensureAll() {
  if (!initialized) doInit({});
  if (!W || !H) resize();
}

function doDestroy() {
  try {
    stopLoop();
    clearParticles();
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    unbindGlobals();
    if (dom && dom.layer) dom.layer.remove();
    if (canvasEl) {
      if (ownsCanvas && canvasEl.isConnected) canvasEl.remove();
      else {
        canvasEl.classList.remove('fx-canvas');
        try {
          ctx2d && ctx2d.clearRect(0, 0, canvasEl.width, canvasEl.height);
        } catch {
          /* noop */
        }
      }
    }
    if (rootEl && rootEl.classList) rootEl.classList.remove('fx-shaking');
    dom = null;
    canvasEl = null;
    ctx2d = null;
    colorSpriteCache.clear();
    for (const key of Object.keys(sprites)) delete sprites[key];
    weather.frost = weather.fog = weather.rain = weather.storm = false;
    ambientOn = false;
    initialized = false;
    config = {};
    rootEl = null;
    W = 0;
    H = 0;
  } catch (err) {
    warnOnce('destroy', err);
  }
}

// ============================================================================
//  audio bridge（只在 onEvent 中统一触发，直接 fx.* 调用不发声）
// ============================================================================
function playSfx(name, options = {}) {
  if (!config || config.eventAudio === false) return;
  try {
    audio.play(name, options);
  } catch (err) {
    warnOnce('audio', err);
  }
}

// ============================================================================
//  engine event dispatch
// ============================================================================
function deriveRoundScores(event, ctx) {
  const explicit = normalizeScores(event && event.scores);
  const prev = ctx && ctx.prevView;
  const view = ctx && ctx.view;
  const human = humanIndex(prev || view);
  if (explicit) {
    if (human == null || human === 0) return explicit;
    return [explicit[human], explicit[1 - human]];
  }
  const players = prev && Array.isArray(prev.players) ? prev.players : view && Array.isArray(view.players) ? view.players : null;
  if (!players) return null;
  if (human == null || !players[human] || !players[1 - human]) return null;
  const scoreOf = (p) => {
    if (Number.isFinite(Number(p.score))) return Number(p.score);
    if (p.rowScores && typeof p.rowScores === 'object') {
      return ['close', 'ranged', 'siege'].reduce((sum, row) => sum + (Number(p.rowScores[row]) || 0), 0);
    }
    return 0;
  };
  return [scoreOf(players[human]), scoreOf(players[1 - human])];
}

function deriveRoundKind(event, ctx) {
  const explicit = event && (event.kind || event.outcome || event.result);
  if (explicit === 'win' || explicit === 'lose' || explicit === 'draw') return explicit;
  const scores = deriveRoundScores(event, ctx);
  if (scores) {
    if (scores[0] > scores[1]) return 'win';
    if (scores[0] < scores[1]) return 'lose';
    return 'draw';
  }
  return 'draw';
}

function deriveGems(event, ctx) {
  const view = ctx && ctx.view;
  const human = humanIndex(view);
  const direct = normalizeGemCounts(event && (event.gems || event.gemCounts));
  if (direct) {
    if (human == null || human === 0) return direct;
    return [direct[human], direct[1 - human]];
  }
  if (view && Array.isArray(view.players)) {
    if (human != null && view.players[human] && view.players[1 - human]) {
      const mine = Number(view.players[human].gems);
      const theirs = Number(view.players[1 - human].gems);
      if (Number.isFinite(mine) && Number.isFinite(theirs)) return [mine, theirs];
    }
  }
  return null;
}

function applyWeatherFromEvent(event, ctx) {
  const view = ctx && ctx.view;
  const prev = ctx && ctx.prevView;
  let nextWeather = event && event.weather;
  if (typeof nextWeather === 'string') {
    const all = { frost: false, fog: false, rain: false, storm: false };
    if (nextWeather in all) all[nextWeather] = true;
    nextWeather = all;
  }
  if (!nextWeather || typeof nextWeather !== 'object') nextWeather = view && view.weather;
  const prevWeather = (prev && prev.weather) || { ...weather };
  if (!nextWeather || typeof nextWeather !== 'object') {
    // 无法判断：根据事件里的 kind 直接开一种
    const kind = event && (event.kind || event.weatherKind);
    if (kind === 'clear') {
      if (anyWeatherOn()) {
        doWeather('clear');
        playSfx('weather-clear');
      }
    } else if (kind && kind in weather) {
      doWeather(kind, true);
      playSfx(`weather-${kind}`);
    }
    return;
  }
  const anyNext = !!(nextWeather.frost || nextWeather.fog || nextWeather.rain || nextWeather.storm);
  if (!anyNext && anyWeatherOn()) {
    doWeather('clear');
    playSfx('weather-clear');
    return;
  }
  for (const kind of ['frost', 'fog', 'rain', 'storm']) {
    const was = !!(prevWeather && prevWeather[kind]);
    const nowOn = !!nextWeather[kind];
    if (nowOn !== was) {
      doWeather(kind, nowOn);
      playSfx(`weather-${kind}`, { volume: 0.85 });
    }
  }
}

// 力量变化：引擎只发 scores 快照（不逐卡 delta），因此对比上一帧快照脉动变化的行
let lastScoreState = null;

function resetFxRuntimeState() {
  weather.frost = weather.fog = weather.rain = weather.storm = false;
  updateWeatherTint();
  lastScoreState = null;
  stormTimer = 0;
}

function handlePowerUpdateEvent(event, ctx, lite) {
  const scores = Array.isArray(event && event.scores) ? event.scores : null;
  if (!scores) {
    const changes = Array.isArray(event && event.changes) ? event.changes : [{ uid: eventUid(event), delta: event && (event.delta ?? event.diff) }];
    for (const change of changes) {
      if (!change) continue;
      doPowerPulse(change.uid ?? change.cardUid, change.delta ?? change.diff ?? 0);
    }
    return;
  }
  const previous = lastScoreState;
  lastScoreState = scores.map((entry) => ({
    score: Number(entry && entry.score) || 0,
    rows: { ...((entry && entry.rows) || {}) },
  }));
  if (!lite || !previous) return;
  for (let p = 0; p < 2; p += 1) {
    const beforeRows = (previous[p] && previous[p].rows) || {};
    const afterRows = (scores[p] && scores[p].rows) || {};
    for (const row of ['close', 'ranged', 'siege']) {
      const before = Number(beforeRows[row]) || 0;
      const after = Number(afterRows[row]) || 0;
      if (after === before) continue;
      const up = after > before;
      const rowEl = findRowEl(p, row, ctx);
      if (!rowEl) continue;
      flashClass(rowEl, up ? 'fx-gold-breathe' : 'fx-dim-row', 820);
      const scoreEl = rowEl.querySelector ? rowEl.querySelector('.board-row__score') : null;
      const rect = rectOf(scoreEl) || rectOf(rowEl);
      if (rect) {
        const c = rectCenter(rect);
        burstAt(c, up ? 8 : 5, up ? 'gold' : 'blood', { speed: 60, size: 2, life: 0.45, alpha: 0.5 });
        addRing(c.x, c.y, { color: up ? faction.glow : '#ff6b5a', grow: 100, max: 0.35, width: 1.4, alpha: 0.45 });
      }
      ensureLoop();
    }
  }
}

function impactOnEl(el, options = {}) {
  const rect = rectOf(el);
  if (!rect) return;
  const c = rectCenter(rect);
  const { count = 10, sprite = 'dust', ring = true } = options;
  burstAt({ x: c.x, y: rect.y + rect.h * 0.9 }, count, sprite, { speed: 60, size: 3, life: 0.5, spread: Math.PI * 0.9, angle: -Math.PI / 2 });
  if (ring) addRing(c.x, c.y, { color: faction.glow, grow: 160, max: 0.35, width: 1.4, alpha: 0.5 });
  ensureLoop();
}

function glowCardEl(el, color = '#a8e6c0') {
  const rect = rectOf(el);
  if (!rect) return;
  const c = rectCenter(rect);
  addRing(c.x, c.y, { color, grow: 180, max: 0.5, width: 2 });
  burstAt(c, 10, 'soul', { speed: 55, size: 2, life: 0.6 });
  ensureLoop();
}

function handleEvent(event, ctx = {}) {
  if (!event || typeof event !== 'object') return;
  ensureAll();
  const type = event.type;
  const full = config.eventEffects === 'full';
  const lite = full || config.eventEffects !== 'off';
  const view = ctx && ctx.view;
  try {
    switch (type) {
      case 'gameStart': {
        if (ctx && ctx.faction) doSetFactionTheme(ctx.faction);
        resetFxRuntimeState();
        doMenuAmbient(false);
        // 抛硬币：app 目前只把 gameStart 交给 fx（引擎初始 coinToss 事件未被消费），
        // 这里从 view.firstPlayer 补一次全屏金币，确保 ART_DIRECTION §5 的抛硬币效果出现。
        try {
          const fpRaw = ctx && ctx.view ? ctx.view.firstPlayer : undefined;
          const hasFirst = fpRaw !== null && fpRaw !== undefined && fpRaw !== '' && Number.isFinite(Number(fpRaw)) && Number(fpRaw) >= 0;
          if (hasFirst && config.autoCoin !== false) {
            const fp = Number(fpRaw);
            later(() => {
              if (!initialized || reducedMotion) return;
              playSfx('coin', { volume: 0.8 });
              doCoinFlip({ firstPlayer: fp });
            }, 420);
          }
        } catch {
          /* noop */
        }
        break;
      }
      case 'draw': {
        playSfx('card-draw');
        break;
      }
      case 'mulligan': {
        playSfx('card-flip');
        break;
      }
      case 'firstPlayerChosen': {
        playSfx('coin');
        break;
      }
      case 'cardPlayed': {
        const card = eventCard(event);
        const isHero = !!(event.hero || (card && (card.hero || (Array.isArray(card.abilities) && card.abilities.some((a) => a && a.id === 'hero')))));
        playSfx(isHero ? 'hero-place' : 'card-place');
        if (!lite) break;
        const el = findCardEl(eventUid(event), ctx);
        const rowEl = findRowEl(playerIndexFrom(event, ctx), event.row, ctx);
        if (el) {
          if (full) {
            const fromRect = findDeckEl(playerIndexFrom(event, ctx), ctx);
            doCardPlay({ fromRect: rectOf(fromRect), toEl: el, card });
          } else {
            impactOnEl(el, { count: 8, sprite: 'dust' });
            flashClass(el, 'fx-landed', 600);
          }
        } else if (rowEl) {
          impactOnEl(rowEl, { count: 6, sprite: 'dust' });
        }
        break;
      }
      case 'cardSummoned': {
        playSfx('muster');
        if (!lite) break;
        const el = findCardEl(eventUid(event), ctx);
        if (el) {
          if (full) doCardSummon({ toEl: el, card: eventCard(event) });
          else impactOnEl(el, { count: 8, sprite: 'dust' });
        }
        break;
      }
      case 'spyDraw': {
        playSfx('spy');
        break;
      }
      case 'muster': {
        playSfx('muster');
        if (!lite) break;
        const uids = Array.isArray(event.uids) ? event.uids : Array.isArray(event.cards) ? event.cards : [];
        const els = uids.map((uid) => findCardEl(uid, ctx)).filter(Boolean);
        if (full) doMuster({ cardEls: els });
        else for (const el of els) impactOnEl(el, { count: 4, sprite: 'dust' });
        break;
      }
      case 'medic': {
        playSfx('medic');
        if (!lite) break;
        if (full) {
          doMedic({
            fromEl: findGraveEl(playerIndexFrom(event, ctx), ctx),
            toRowEl: findRowEl(playerIndexFrom(event, ctx), event.row, ctx),
          });
        }
        break;
      }
      case 'cardRevived': {
        playSfx('medic', { volume: 0.7, pitch: 1.06 });
        if (!lite) break;
        const el = findCardEl(eventUid(event), ctx);
        if (el) glowCardEl(el);
        break;
      }
      case 'scorch': {
        playSfx('scorch');
        if (!lite) break;
        const uids = Array.isArray(event.uids) ? event.uids : Array.isArray(event.targets) ? event.targets : [];
        const els = uids.map((uid) => findCardEl(typeof uid === 'object' ? uid.uid : uid, ctx)).filter(Boolean);
        if (full) doScorch({ els, cardEls: findCardEl(event.cardUid, ctx) ? [findCardEl(event.cardUid, ctx)] : [] });
        else {
          for (const el of els) {
            const rect = rectOf(el);
            if (rect) burstAt(rectCenter(rect), 12, 'ember', { speed: 90, size: 2.6, life: 0.7 });
          }
          if (!els.length) doScreenFlash('#ff7a2f', 0.07);
          doShake(0.8);
        }
        break;
      }
      case 'weatherChanged': {
        applyWeatherFromEvent(event, ctx);
        break;
      }
      case 'hornPlaced': {
        playSfx('horn');
        if (!lite) break;
        const rowEl = findRowEl(playerIndexFrom(event, ctx), event.row, ctx);
        if (full) doHorn(rowEl);
        else if (rowEl) {
          impactOnEl(rowEl, { count: 12, sprite: 'gold' });
          flashClass(rowEl, 'fx-gold-breathe', 1200);
        }
        break;
      }
      case 'mardroeme': {
        playSfx('mardroeme');
        if (!lite) break;
        const rowEl = findRowEl(playerIndexFrom(event, ctx), event.row, ctx);
        if (full) doMardroeme(rowEl, []);
        else if (rowEl) {
          impactOnEl(rowEl, { count: 12, sprite: 'blood' });
          flashClass(rowEl, 'fx-mardroeme', 1000);
        }
        break;
      }
      case 'transform': {
        playSfx('mardroeme', { volume: 0.55, pitch: 1.1 });
        if (lite) {
          const el = findCardEl(eventUid(event), ctx);
          if (el) glowCardEl(el, '#ff6b5a');
        }
        break;
      }
      case 'decoy': {
        playSfx('card-flip');
        if (lite) {
          const el = findCardEl(eventUid(event), ctx);
          if (el) impactOnEl(el, { count: 8, sprite: 'dust' });
        }
        break;
      }
      case 'avenger': {
        playSfx('avenger');
        if (!lite) break;
        // 引擎 payload: { fromUid, uid(token), row, ... }
        const sourceUid = event.fromUid ?? (Array.isArray(event.uids) ? event.uids[0] : eventUid(event));
        const tokenUid = event.uid ?? event.tokenUid;
        const sourceEl = findCardEl(sourceUid, ctx);
        const tokenEl = findCardEl(tokenUid, ctx);
        if (full) doAvenger({ els: sourceEl ? [sourceEl] : [], tokenEl });
        else if (sourceEl) impactOnEl(sourceEl, { count: 12, sprite: 'ember' });
        break;
      }
      case 'leaderUsed': {
        playSfx('leader');
        if (!lite) break;
        const p = playerIndexFrom(event, ctx);
        const fid = event.faction || (view && view.players && view.players[p] && view.players[p].faction) || config.faction;
        if (full) doLeaderActivate({ el: findLeaderEl(p, ctx), faction: fid });
        else {
          doScreenFlash(getFactionColors(fid).glow, 0.12);
          const el = findLeaderEl(p, ctx);
          if (el) impactOnEl(el, { count: 12, sprite: 'gold' });
        }
        break;
      }
      case 'leaderCanceled': {
        playSfx('card-flip');
        break;
      }
      case 'powerUpdate': {
        handlePowerUpdateEvent(event, ctx, lite);
        break;
      }
      case 'roundStarted': {
        playSfx('turn');
        const roundNo = Number(event.round);
        if (Number.isFinite(roundNo) && roundNo > 0) doToast(`第 ${roundNo} 局`);
        break;
      }
      case 'roundEnded': {
        const kind = deriveRoundKind(event, ctx);
        playSfx(kind === 'win' ? 'round-win' : kind === 'lose' ? 'round-lose' : 'round-draw');
        if (!lite) break;
        doRoundBanner({ kind, scores: deriveRoundScores(event, ctx), gems: deriveGems(event, ctx) });
        break;
      }
      case 'gemsUpdate': {
        playSfx('gem-crack');
        const gems = deriveGems(event, ctx);
        if (lite && gems) {
          if (Number(event.player) === humanIndex(view)) {
            if (gems[0] < 2 || gems[1] < 2) doShake(0.5);
          }
        }
        break;
      }
      case 'gameOver': {
        const outcome = resolveOutcome(event.winner, view);
        playSfx(outcome === 'win' ? 'victory' : outcome === 'lose' ? 'defeat' : 'round-draw');
        if (!lite) break;
        doGameOver({ winner: event.winner, view });
        doMenuAmbient(false);
        break;
      }
      case 'coinToss': {
        playSfx('coin');
        if (lite) doCoinFlip({ firstPlayer: event.firstPlayer });
        break;
      }
      case 'turnChanged': {
        playSfx('turn', { volume: 0.55 });
        break;
      }
      case 'pass': {
        playSfx('pass');
        break;
      }
      case 'mardroemePlaced': {
        playSfx('mardroeme');
        if (!lite) break;
        const rowEl = findRowEl(event.rowOwner ?? playerIndexFrom(event, ctx), event.row, ctx);
        if (full) doMardroeme(rowEl, []);
        else if (rowEl) {
          impactOnEl(rowEl, { count: 12, sprite: 'blood' });
          flashClass(rowEl, 'fx-mardroeme', 1000);
        }
        break;
      }
      case 'scorchFizzle': {
        playSfx('error', { volume: 0.45 });
        break;
      }
      case 'graveToHand':
      case 'graveyardsShuffled': {
        playSfx('card-draw', { volume: 0.5 });
        break;
      }
      case 'discarded': {
        playSfx('card-draw', { volume: 0.55 });
        break;
      }
      case 'agileRepositioned': {
        playSfx('card-flip', { volume: 0.5 });
        break;
      }
      case 'skelligeRevive': {
        playSfx('medic', { volume: 0.65 });
        if (lite) {
          const el = findCardEl(eventUid(event), ctx);
          if (el) glowCardEl(el);
        }
        break;
      }
      case 'monsterKeep': {
        if (lite) {
          const el = findCardEl(event.uid, ctx);
          if (el) glowCardEl(el, faction.glow);
        }
        break;
      }
      case 'mulliganChoice': {
        playSfx('card-flip', { volume: 0.6 });
        break;
      }
      case 'cardEntered':
      case 'cardLeft':
      case 'stage':
      case 'revivePending': {
        break;
      }
      case 'toast': {
        if (event.text) doToast(event.text);
        break;
      }
      case 'log': {
        break;
      }
      case 'pending': {
        break;
      }
      default: {
        break;
      }
    }
  } catch (err) {
    warnOnce(`onEvent:${type}`, err);
  }
}

// ============================================================================
//  public API
// ============================================================================
const fxApi = {
  init: doInit,
  onEvent: handleEvent,
  cardPlay: doCardPlay,
  cardSummon: doCardSummon,
  powerPulse: doPowerPulse,
  scorch: doScorch,
  weather: doWeather,
  horn: doHorn,
  mardroeme: doMardroeme,
  spy: doSpy,
  medic: doMedic,
  muster: doMuster,
  avenger: doAvenger,
  leaderActivate: doLeaderActivate,
  roundBanner: doRoundBanner,
  gameOver: doGameOver,
  coinFlip: doCoinFlip,
  screenFlash: doScreenFlash,
  shake: doShake,
  toast: doToast,
  setFactionTheme: doSetFactionTheme,
  menuAmbient: doMenuAmbient,
  destroy: doDestroy,

  // ---- diagnostics（demo / QA 使用，不属于契约） ----
  stats() {
    return {
      initialized,
      particles: count,
      maxParticles: MAX_PARTICLES,
      beams: beams.length,
      bolts: bolts.length,
      roots: roots.length,
      fps,
      reducedMotion,
      ambient: ambientOn,
      weather: { ...weather },
      faction: faction.id,
      layers: dom
        ? {
            canvas: !!canvasEl,
            ghosts: dom.ghost ? dom.ghost.children.length : 0,
            toasts: dom.toasts ? dom.toasts.children.length : 0,
          }
        : null,
    };
  },
  get canvas() {
    return canvasEl;
  },
  get root() {
    return rootEl;
  },
};

export const fx = fxApi;
export default fx;
