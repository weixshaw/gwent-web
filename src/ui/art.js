/* ============================================================================
   art.js — 程序化卡牌美术（visualist）
   ----------------------------------------------------------------------------
   零外部资源：全部插画 / 纹章 / 卡背 / 图标均由确定性种子生成的内联 SVG 构成。
   同一张牌（id + art.seed）每次生成完全一致；不同牌在构图、月亮、尘埃、
   裂纹、光位、剪影变体上明显不同。

   设计语言：暗黑奇幻 + 鎏金魔典（obsidian / antique gold / heraldry / runes）。
   性能：共享 <defs> sprite（全局仅一份），每张卡只缓存 SVG body 字符串；
        重复卡牌直接复用 innerHTML；不使用逐卡 filter（除英雄/领袖的少量颗粒）。
   ========================================================================== */

/* ------------------------------------------------------------------ 常量 */
const ART_W = 240;
const ART_H = 210;
const SVG_NS = "http://www.w3.org/2000/svg";

/** 十六类 motif —— 与 docs/ART_DIRECTION.md §3 对应 */
export const MOTIFS = [
  "monster",
  "beast",
  "warrior",
  "mage",
  "elf",
  "dwarf",
  "vampire",
  "witch",
  "spirit",
  "hero",
  "siege",
  "spell",
  "weather",
  "leader",
  "token",
];

/* ------------------------------------------------------- 确定性随机 / 工具 */
/** FNV-1a 32bit —— 稳定哈希（跨会话/跨机器一致） */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 —— 可复现 PRNG */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seedText) {
  return mulberry32(hashSeed(String(seedText)));
}

/** 保留一位小数，压缩 SVG 体积 */
const n = (v) => Math.round(v * 10) / 10;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const range = (rng, a, b) => a + (b - a) * rng();
const irange = (rng, a, b) => Math.floor(range(rng, a, b + 0.999));
const pick = (rng, arr) => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];

function escHtml(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function hexToRgb(hex) {
  let h = String(hex).replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const num = parseInt(h, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function rgbToHex(r, g, b) {
  const c = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** 两色混合 t=0 → a，t=1 → b */
function mixHex(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(lerp(A.r, B.r, t), lerp(A.g, B.g, t), lerp(A.b, B.b, t));
}

/** 变暗 / 变亮（t < 0 变暗，t > 0 变亮） */
function shadeHex(hex, t) {
  return t >= 0 ? mixHex(hex, "#ffffff", t * 0.8) : mixHex(hex, "#000000", -t);
}

/** 带透明度的 rgba() 字符串 */
function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`;
}

/* -------------------------------------------------------------- 阵营调色板 */
/**
 * 与 theme.css 中的 token 保持一致（美术 SVG 需自包含，不能依赖 CSS 变量，
 * 这样 getCardArtDataUrl() 生成的独立 SVG 才能在 <img>/canvas 中正常渲染色）。
 */
export const FACTION_PALETTES = {
  "northern-realms": {
    key: "nr",
    nameZh: "北方领域",
    nameEn: "Northern Realms",
    core: "#4d7ea8",
    glow: "#9cc4e4",
    deep: "#0d1820",
    accent: "#c9a227",
    moon: "#e9eff5",
    metal: "#aebfce",
  },
  nilfgaard: {
    key: "ng",
    nameZh: "尼弗迦德帝国",
    nameEn: "Nilfgaardian Empire",
    core: "#c9a227",
    glow: "#f0d078",
    deep: "#20180b",
    accent: "#e8c96a",
    moon: "#f6e8bc",
    metal: "#e0c264",
  },
  scoiatael: {
    key: "st",
    nameZh: "松鼠党",
    nameEn: "Scoia'tael",
    core: "#2f7a4a",
    glow: "#a8e0a0",
    deep: "#0c1a11",
    accent: "#b87333",
    moon: "#e7dcc2",
    metal: "#8fae7a",
  },
  monsters: {
    key: "mo",
    nameZh: "怪物",
    nameEn: "Monsters",
    core: "#8a2323",
    glow: "#ff6b5a",
    deep: "#1d0b0a",
    accent: "#d9cbb3",
    moon: "#ffc9b5",
    metal: "#b08a72",
  },
  skellige: {
    key: "sk",
    nameZh: "史凯利格",
    nameEn: "Skellige",
    core: "#2f6f6a",
    glow: "#9adfd6",
    deep: "#0b1717",
    accent: "#c98f4a",
    moon: "#d5eff1",
    metal: "#7ea6a0",
  },
  neutral: {
    key: "ne",
    nameZh: "中立",
    nameEn: "Neutral",
    core: "#8b7d5c",
    glow: "#d9cbb3",
    deep: "#17140f",
    accent: "#c9a227",
    moon: "#e7dcc2",
    metal: "#b3a484",
  },
};

const PALETTE_ALIASES = {
  "northern-realms": "northern-realms",
  northernrealms: "northern-realms",
  north: "northern-realms",
  nr: "northern-realms",
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

export function paletteFor(factionId) {
  const raw = String(factionId || "neutral").toLowerCase();
  const id = PALETTE_ALIASES[raw] || "neutral";
  return FACTION_PALETTES[id];
}

export function factionKey(factionId) {
  return paletteFor(factionId).key;
}

/* ---------------------------------------------------------------- SVG defs */
/**
 * 全局共享 defs（只注入 sprite 一次）。prefix 用于生成自包含 SVG 时复用同一段
 * 标记（dataURL 版本会内联这段 defs）。
 */
function globalDefs(prefix = "gtf") {
  return `
    <linearGradient id="${prefix}-gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f9ecc0"/>
      <stop offset=".28" stop-color="#f0d078"/>
      <stop offset=".6" stop-color="#c9a227"/>
      <stop offset=".82" stop-color="#8a6f22"/>
      <stop offset="1" stop-color="#e6c565"/>
    </linearGradient>
    <linearGradient id="${prefix}-gold-v" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f0d078"/>
      <stop offset=".5" stop-color="#c9a227"/>
      <stop offset="1" stop-color="#7c6320"/>
    </linearGradient>
    <radialGradient id="${prefix}-bokeh">
      <stop offset="0" stop-color="#fff6dd" stop-opacity=".9"/>
      <stop offset=".35" stop-color="#f0d078" stop-opacity=".3"/>
      <stop offset="1" stop-color="#c9a227" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${prefix}-moon">
      <stop offset="0" stop-color="#fffdf4"/>
      <stop offset=".62" stop-color="#efe4c8"/>
      <stop offset="1" stop-color="#b9ac8d"/>
    </radialGradient>
    <radialGradient id="${prefix}-moon-bloom">
      <stop offset="0" stop-color="#fff3cf" stop-opacity=".55"/>
      <stop offset=".45" stop-color="#e7dcc2" stop-opacity=".16"/>
      <stop offset="1" stop-color="#c9bda3" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${prefix}-vignette" cx=".5" cy=".42" r=".78">
      <stop offset=".34" stop-color="#000" stop-opacity="0"/>
      <stop offset=".68" stop-color="#000" stop-opacity=".24"/>
      <stop offset=".9" stop-color="#000" stop-opacity=".58"/>
      <stop offset="1" stop-color="#000" stop-opacity=".82"/>
    </radialGradient>
    <linearGradient id="${prefix}-shade-bottom" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0"/>
      <stop offset=".62" stop-color="#000" stop-opacity=".18"/>
      <stop offset="1" stop-color="#000" stop-opacity=".72"/>
    </linearGradient>
    <linearGradient id="${prefix}-shade-top" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity=".55"/>
      <stop offset="1" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${prefix}-fog" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e7dcc2" stop-opacity="0"/>
      <stop offset=".42" stop-color="#d9cbb3" stop-opacity=".14"/>
      <stop offset="1" stop-color="#8f8570" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${prefix}-fire" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff2c4" stop-opacity=".95"/>
      <stop offset=".35" stop-color="#ffb347" stop-opacity=".85"/>
      <stop offset=".72" stop-color="#ff7a2f" stop-opacity=".5"/>
      <stop offset="1" stop-color="#7a1f1f" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${prefix}-blood" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ff6b5a" stop-opacity=".8"/>
      <stop offset="1" stop-color="#7a1f1f" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${prefix}-steel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e9eff5" stop-opacity=".9"/>
      <stop offset=".5" stop-color="#8ea1b3" stop-opacity=".55"/>
      <stop offset="1" stop-color="#39434d" stop-opacity=".25"/>
    </linearGradient>
    <linearGradient id="${prefix}-leather" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1d1710"/>
      <stop offset=".5" stop-color="#120e0a"/>
      <stop offset="1" stop-color="#080706"/>
    </linearGradient>
    <radialGradient id="${prefix}-medallion" cx=".5" cy=".45" r=".75">
      <stop offset="0" stop-color="#2b2116"/>
      <stop offset=".7" stop-color="#16110c"/>
      <stop offset="1" stop-color="#0a0806"/>
    </radialGradient>
    <filter id="${prefix}-grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch" result="noise"/>
      <feColorMatrix in="noise" type="matrix"
        values=".32 .32 .32 0 .58  .32 .32 .32 0 .53  .32 .32 .32 0 .4  0 0 0 .22 0"/>
    </filter>
    <filter id="${prefix}-soft-glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="3.2"/>
    </filter>
    <pattern id="${prefix}-dust" width="72" height="72" patternUnits="userSpaceOnUse">
      ${dustPatternDots()}
    </pattern>
    <pattern id="${prefix}-hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="9" stroke="#c9a227" stroke-width=".5" opacity=".5"/>
    </pattern>
  `;
}

/** 皮革/纸张颗粒 pattern 的点阵（固定种子，一次生成） */
function dustPatternDots() {
  const rng = makeRng("gtf-dust-pattern");
  let out = "";
  for (let i = 0; i < 90; i += 1) {
    const x = range(rng, 0, 72);
    const y = range(rng, 0, 72);
    const r = range(rng, 0.25, 1.15);
    const op = range(rng, 0.06, 0.3);
    out += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="#e7dcc2" opacity="${n(op)}"/>`;
  }
  return out;
}

/** 单一阵营的渐变（共享 defs；自包含 SVG 时内联） */
function factionDefs(pal, prefix = "gtf") {
  const k = pal.key;
  return `
    <linearGradient id="${prefix}-bg-${k}" x1="0" y1="0" x2=".18" y2="1">
      <stop offset="0" stop-color="${shadeHex(pal.core, -0.86)}"/>
      <stop offset=".36" stop-color="${pal.deep}"/>
      <stop offset=".74" stop-color="${shadeHex(pal.deep, -0.42)}"/>
      <stop offset="1" stop-color="#060504"/>
    </linearGradient>
    <radialGradient id="${prefix}-glow-${k}">
      <stop offset="0" stop-color="${shadeHex(pal.glow, 0.2)}" stop-opacity=".85"/>
      <stop offset=".34" stop-color="${pal.glow}" stop-opacity=".34"/>
      <stop offset=".68" stop-color="${pal.core}" stop-opacity=".1"/>
      <stop offset="1" stop-color="${pal.core}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${prefix}-ember-${k}">
      <stop offset="0" stop-color="${shadeHex(pal.accent, 0.25)}" stop-opacity=".95"/>
      <stop offset=".45" stop-color="${pal.core}" stop-opacity=".38"/>
      <stop offset="1" stop-color="${pal.core}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${prefix}-rim-${k}" x1="0" y1="0" x2="1" y2=".35">
      <stop offset="0" stop-color="${pal.core}" stop-opacity=".14"/>
      <stop offset=".3" stop-color="${shadeHex(pal.glow, 0.28)}" stop-opacity="1"/>
      <stop offset=".58" stop-color="${shadeHex(pal.glow, 0.05)}" stop-opacity=".82"/>
      <stop offset=".82" stop-color="${pal.core}" stop-opacity=".6"/>
      <stop offset="1" stop-color="${pal.glow}" stop-opacity=".18"/>
    </linearGradient>
    <linearGradient id="${prefix}-water-${k}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${pal.glow}" stop-opacity=".5"/>
      <stop offset=".5" stop-color="${pal.core}" stop-opacity=".26"/>
      <stop offset="1" stop-color="${pal.core}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${prefix}-hero-${k}" x1="0" y1="0" x2=".6" y2="1">
      <stop offset="0" stop-color="${shadeHex(pal.metal, 0.35)}" stop-opacity=".95"/>
      <stop offset=".4" stop-color="${pal.core}" stop-opacity=".75"/>
      <stop offset="1" stop-color="${shadeHex(pal.deep, -0.2)}" stop-opacity=".95"/>
    </linearGradient>
    <linearGradient id="${prefix}-subj-${k}" x1=".28" y1="0" x2=".72" y2="1">
      <stop offset="0" stop-color="#070504"/>
      <stop offset=".42" stop-color="#100c09"/>
      <stop offset=".78" stop-color="${shadeHex(pal.deep, 0.16)}"/>
      <stop offset="1" stop-color="${shadeHex(pal.deep, 0.34)}"/>
    </linearGradient>
    <linearGradient id="${prefix}-herosubj-${k}" x1=".2" y1="0" x2=".8" y2="1">
      <stop offset="0" stop-color="#181209"/>
      <stop offset=".38" stop-color="#241b11"/>
      <stop offset=".72" stop-color="${shadeHex(pal.deep, 0.24)}"/>
      <stop offset="1" stop-color="${shadeHex(pal.deep, 0.44)}"/>
    </linearGradient>`;
}

/* ------------------------------------------------------- 共享 defs sprite */
let artSprite = null;
let artDefsRoot = null;

/**
 * 确保文档里存在唯一的 SVG defs sprite。
 * 所有卡牌插画通过 url(#gtf-...) 引用它，避免每张卡重复内联 defs。
 */
export function ensureArtSprite() {
  if (typeof document === "undefined") return null;
  if (artSprite && artSprite.isConnected && artDefsRoot) return artSprite;
  artSprite = document.createElementNS(SVG_NS, "svg");
  artSprite.setAttribute("class", "gt-art-sprite");
  artSprite.setAttribute("aria-hidden", "true");
  artSprite.setAttribute("focusable", "false");
  artSprite.setAttribute("width", "0");
  artSprite.setAttribute("height", "0");
  artSprite.style.cssText =
    "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;opacity:0;";
  artDefsRoot = document.createElementNS(SVG_NS, "defs");
  artSprite.appendChild(artDefsRoot);
  (document.body || document.documentElement).appendChild(artSprite);
  let markup = globalDefs("gtf");
  Object.values(FACTION_PALETTES).forEach((pal) => {
    markup += factionDefs(pal, "gtf");
  });
  artDefsRoot.insertAdjacentHTML("beforeend", markup);
  return artSprite;
}

/* ---------------------------------------------------------- 几何 / 形状工具 */

/** 星形 / 锯齿多边形点串 */
function starPoints(cx, cy, count, rOuter, rInner, rotation = 0, jitter = null) {
  const pts = [];
  const total = count * 2;
  for (let i = 0; i < total; i += 1) {
    const a = rotation + (i / total) * Math.PI * 2;
    let r = i % 2 === 0 ? rOuter : rInner;
    if (jitter) r += jitter(i, a);
    pts.push(`${n(cx + Math.cos(a) * r)} ${n(cy + Math.sin(a) * r)}`);
  }
  return pts.join("L");
}

/** 正多边形点串 */
function polyPoints(cx, cy, count, radius, rotation = 0) {
  const pts = [];
  for (let i = 0; i < count; i += 1) {
    const a = rotation + (i / count) * Math.PI * 2;
    pts.push(`${n(cx + Math.cos(a) * radius)} ${n(cy + Math.sin(a) * radius)}`);
  }
  return pts.join("L");
}

/** 一条从 y 基线起伏的山脊 / 废墟天际线 */
function ridgePath(rng, yBase, amp, step) {
  const pts = [];
  let x = -10;
  let y = yBase + range(rng, -amp, amp) * 0.4;
  pts.push(`${n(x)} ${n(y)}`);
  while (x < ART_W + 10) {
    x += range(rng, step * 0.6, step * 1.6);
    y = yBase + range(rng, -amp, amp);
    pts.push(`${n(x)} ${n(y)}`);
  }
  return `M-10 ${ART_H}L-10 ${n(yBase)}L${pts.join("L")}L${ART_W + 10} ${ART_H}Z`;
}

/** 一根带分叉的裂纹 */
function crackPath(rng, x, y, len, angle) {
  const segs = irange(rng, 3, 6);
  let cx = x;
  let cy = y;
  let a = angle;
  let d = `M${n(cx)} ${n(cy)}`;
  for (let i = 0; i < segs; i += 1) {
    a += range(rng, -0.55, 0.55);
    const l = len / segs;
    cx += Math.cos(a) * l;
    cy += Math.sin(a) * l;
    d += `L${n(cx)} ${n(cy)}`;
    if (rng() < 0.4) {
      const ba = a + (rng() < 0.5 ? -1 : 1) * range(rng, 0.5, 1.1);
      const bl = l * range(rng, 0.4, 0.8);
      d += `M${n(cx)} ${n(cy)}L${n(cx + Math.cos(ba) * bl)} ${n(cy + Math.sin(ba) * bl)}M${n(cx)} ${n(cy)}`;
    }
  }
  return d;
}

/** 柔光圆（用渐变光斑代替 blur filter，性能更好） */
function glowCircle(cx, cy, r, fill, opacity = 1) {
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${fill}" opacity="${n(opacity)}"/>`;
}

/** 悬浮尘埃 / 火星 */
function dustField(rng, opts = {}) {
  const count = opts.count || 26;
  const color = opts.color || "#f0d078";
  const x0 = opts.x0 == null ? 8 : opts.x0;
  const x1 = opts.x1 == null ? ART_W - 8 : opts.x1;
  const y0 = opts.y0 == null ? 10 : opts.y0;
  const y1 = opts.y1 == null ? ART_H - 12 : opts.y1;
  let out = "";
  for (let i = 0; i < count; i += 1) {
    const x = range(rng, x0, x1);
    const y = range(rng, y0, y1);
    const r = rng() < 0.82 ? range(rng, 0.5, 1.5) : range(rng, 1.6, 2.8);
    const op = range(rng, 0.18, 0.72);
    out += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${color}" opacity="${n(op)}"/>`;
  }
  // 少量大光斑，形成景深
  const bokeh = irange(rng, 2, 5);
  for (let i = 0; i < bokeh; i += 1) {
    const x = range(rng, 12, ART_W - 12);
    const y = range(rng, 14, ART_H * 0.8);
    const r = range(rng, 5, 16);
    out += glowCircle(x, y, r, "url(#gtf-bokeh)", range(rng, 0.1, 0.3));
  }
  return out;
}

/** 四芒星闪光 */
function sparkle(cx, cy, size, color = "#f0d078", opacity = 0.8) {
  return `<g transform="translate(${n(cx)} ${n(cy)})" fill="${color}" opacity="${n(opacity)}">
    <path d="M0 ${n(-size)}L${n(size * 0.22)} ${n(-size * 0.22)}L${n(size)} 0L${n(size * 0.22)} ${n(size * 0.22)}L0 ${n(size)}L${n(-size * 0.22)} ${n(size * 0.22)}L${n(-size)} 0L${n(-size * 0.22)} ${n(-size * 0.22)}Z"/>
  </g>`;
}

/* --------------------------------------------------------------- 阵营纹章 */
/** 生成带 26 齿鬃毛的狮头（北方领域） */
function lionMarkup(prefix = "gtf") {
  const mane = starPoints(50, 58, 26, 44, 35, -Math.PI / 2, (i) =>
    (i % 3 === 0 ? 2.4 : -1.1) + (i % 2 ? 0.8 : 0)
  );
  return `
    <path d="M${mane}Z" fill="none"/>
    <path d="M50 34C40 34 32 43 32 54C32 66 40 76 50 83C60 76 68 66 68 54C68 43 60 34 50 34Z"/>
    <path d="M35 37L29 27L41 32M65 37L71 27L59 32"/>
    <path d="M41 53q4.5-3.5 9 0q-4.5 4-9 0Z" fill="url(#${prefix}-gold)" fill-opacity=".55" stroke="none"/>
    <path d="M59 53q-4.5-3.5-9 0q4.5 4 9 0Z" fill="url(#${prefix}-gold)" fill-opacity=".55" stroke="none"/>
    <path d="M50 62l-3.4 5.2h6.8Z"/>
    <path d="M50 68v6M50 74q-4.5 3-8 0M50 74q4.5 3 8 0"/>
    <path d="M36 25L39 13L45 23L50 8L55 23L61 13L64 25Z"/>
    <path d="M42 20v-6M58 20v-6" opacity=".6"/>
    <circle cx="34" cy="46" r="1.4" fill="url(#${prefix}-gold)" stroke="none"/>
    <circle cx="66" cy="46" r="1.4" fill="url(#${prefix}-gold)" stroke="none"/>
  `;
}

/** 黑日（尼弗迦德） */
function sunMarkup(prefix = "gtf") {
  let rays = "";
  for (let i = 0; i < 16; i += 1) {
    const a = (i / 16) * Math.PI * 2;
    const long = i % 2 === 0;
    const r0 = 24;
    const r1 = long ? 47 : 36;
    const w = long ? 2.6 : 1.7;
    const px = Math.cos(a);
    const py = Math.sin(a);
    const bx = Math.cos(a + Math.PI / 2) * w;
    const by = Math.sin(a + Math.PI / 2) * w;
    rays += `<path d="M${n(50 + px * r0 + bx)} ${n(50 + py * r0 + by)}L${n(50 + px * r1)} ${n(50 + py * r1)}L${n(50 + px * r0 - bx)} ${n(50 + py * r0 - by)}Z" fill="url(#${prefix}-gold)" stroke="none"/>`;
  }
  return `
    ${rays}
    <circle cx="50" cy="50" r="21"/>
    <circle cx="50" cy="50" r="15" opacity=".7"/>
    <circle cx="50" cy="50" r="6.5" fill="url(#${prefix}-gold)" fill-opacity=".85" stroke="none"/>
    <circle cx="50" cy="50" r="30" stroke-dasharray="1 4.6" opacity=".75"/>
  `;
}

/** 叶与箭（松鼠党） */
function leafMarkup(prefix = "gtf") {
  return `
    <path d="M50 8L57 20L53 22L61 32L56 34L65 44L59 46L67 56L60 58L64 70L54 70L50 90L46 70L36 70L40 58L33 56L41 46L35 44L44 34L39 32L47 22L43 20Z"/>
    <path d="M50 14V86" opacity=".8"/>
    <path d="M50 30L41 26M50 30L59 26M50 44L38 40M50 44L62 40M50 58L40 55M50 58L60 55M50 72L42 69M50 72L58 69" opacity=".65"/>
    <path d="M12 88L82 18" opacity=".55"/>
    <path d="M82 18L70 16L75 26Z" fill="url(#${prefix}-gold)" fill-opacity=".8" stroke="none"/>
    <path d="M12 88L20 82M12 88L18 94M12 88L6 82M12 88L4 92" opacity=".55"/>
    <circle cx="50" cy="8" r="1.6" fill="url(#${prefix}-gold)" stroke="none" opacity=".8"/>
  `;
}

/** 爪痕骷髅（怪物） */
function skullMarkup(prefix = "gtf") {
  return `
    <path d="M50 14C31 14 19 28 19 47C19 59 26 68 34 74L34 84C34 89 39 91 43 88L46 85L50 90L54 85L57 88C61 91 66 89 66 84L66 74C74 68 81 59 81 47C81 28 69 14 50 14ZM38 43C34 43 31 46 31 50C31 55 34 58 38 58C42 58 45 55 45 50C45 46 42 43 38 43ZM62 43C58 43 55 46 55 50C55 55 58 58 62 58C66 58 69 55 69 50C69 46 66 43 62 43ZM50 62L45 70H55Z" fill="url(#${prefix}-gold)" fill-opacity=".1" fill-rule="evenodd"/>
    <path d="M34 78q8 5 16 9M66 78q-8 5-16 9" opacity=".6"/>
    <path d="M14 20C30 36 34 56 26 82L34 84C44 58 40 34 20 16Z" fill="url(#${prefix}-gold)" fill-opacity=".4" stroke="none"/>
    <path d="M30 14C44 32 46 52 40 78L47 80C56 54 52 30 36 10Z" fill="url(#${prefix}-gold)" fill-opacity=".32" stroke="none"/>
    <path d="M50 10C60 30 60 52 54 80L60 82C70 54 68 28 56 6Z" fill="url(#${prefix}-gold)" fill-opacity=".24" stroke="none"/>
    <circle cx="50" cy="35" r="2.2" fill="url(#${prefix}-gold)" stroke="none" opacity=".8"/>
  `;
}

/** 长船（史凯利格） */
function longshipMarkup(prefix = "gtf") {
  let shields = "";
  for (let i = 0; i < 5; i += 1) {
    shields += `<circle cx="${n(24 + i * 14)}" cy="70" r="3.2"/>`;
  }
  return `
    <path d="M8 62C28 77 72 77 92 62L88 73C68 84 32 84 12 73Z" fill="url(#${prefix}-gold)" fill-opacity=".16"/>
    <path d="M92 62C97 50 99 36 93 22C101 28 107 42 103 57C101 65 97 69 92 71Z"/>
    <path d="M8 62C4 54 2 44 6 34C0 42 -2 54 1 63Z" opacity=".7"/>
    <path d="M50 22V62" stroke-width="2.6"/>
    <path d="M50 25C64 31 71 44 68 59L50 59Z" fill="url(#${prefix}-gold)" fill-opacity=".14"/>
    <path d="M50 25C38 32 33 44 35 59L50 59Z" opacity=".55"/>
    ${shields}
    <path d="M6 88q10-6 20 0t20 0t20 0t20 0t20 0M14 96q10-5 20 0t20 0t20 0t20 0" opacity=".5"/>
    <path d="M93 22l6-4M93 22l-4-6" opacity=".7"/>
  `;
}

/** 八角星（中立） */
function octagramMarkup(prefix = "gtf") {
  const star = starPoints(50, 50, 8, 46, 18, -Math.PI / 2);
  const star2 = starPoints(50, 50, 8, 32, 12, -Math.PI / 2 + Math.PI / 8);
  return `
    <path d="M${star}Z" fill="url(#${prefix}-gold)" fill-opacity=".07"/>
    <path d="M${star2}Z" opacity=".55"/>
    <circle cx="50" cy="50" r="38" opacity=".7"/>
    <circle cx="50" cy="50" r="22" stroke-dasharray="2 4" opacity=".6"/>
    <circle cx="50" cy="50" r="3" fill="url(#${prefix}-gold)" stroke="none"/>
    <circle cx="50" cy="12" r="2" fill="url(#${prefix}-gold)" stroke="none"/>
    <circle cx="50" cy="88" r="2" fill="url(#${prefix}-gold)" stroke="none"/>
    <circle cx="12" cy="50" r="2" fill="url(#${prefix}-gold)" stroke="none"/>
    <circle cx="88" cy="50" r="2" fill="url(#${prefix}-gold)" stroke="none"/>
  `;
}

/**
 * 阵营纹章（线稿徽记）。返回 100×100 坐标系内的 SVG 片段。
 * @param {string} key 阵营 key（nr/ng/st/mo/sk/ne）
 */
export function sigilMarkup(key, prefix = "gtf") {
  switch (key) {
    case "nr":
      return lionMarkup(prefix);
    case "ng":
      return sunMarkup(prefix);
    case "st":
      return leafMarkup(prefix);
    case "mo":
      return skullMarkup(prefix);
    case "sk":
      return longshipMarkup(prefix);
    default:
      return octagramMarkup(prefix);
  }
}

/**
 * 纹章组（默认用于插画水印 / 卡背中章 / 领袖光环）。
 * @param {string} factionId
 * @param {object} opts { x, y, size, rotation, opacity, strokeWidth, fill }
 */
export function renderSigil(factionId, opts = {}) {
  const pal = paletteFor(factionId);
  const {
    x = 120,
    y = 104,
    size = 168,
    rotation = 0,
    opacity = 0.16,
    strokeWidth = 1.1,
    fill = "none",
  } = opts;
  const s = size / 100;
  return `<g transform="translate(${n(x)} ${n(y)}) rotate(${n(rotation)}) scale(${n(
    s
  )}) translate(-50 -50)" fill="${fill}" stroke="url(#gtf-gold)" stroke-width="${n(
    strokeWidth / s
  )}" stroke-linecap="round" stroke-linejoin="round" opacity="${n(opacity)}">${sigilMarkup(
    pal.key
  )}</g>`;
}

/* --------------------------------------------------------------- 鎏金卡框 */
const cornerCurl = (prefix, scale = 1) => `
  <g transform="scale(${scale})" fill="none" stroke="url(#${prefix}-gold)" stroke-linecap="round" stroke-linejoin="round">
    <path d="M1 18C1 8 8 1 18 1" stroke-width="1.4" opacity=".95" vector-effect="non-scaling-stroke"/>
    <path d="M4 22C4 11 11 4 22 4" stroke-width=".8" opacity=".42" vector-effect="non-scaling-stroke"/>
    <path d="M6 11C6 7 9 4 13 4C10 5 8.4 7.2 8.4 10C10 8 12.6 7.6 14.6 9.2C12 9.4 10.4 11 10.4 13.4C9.2 11.2 7.4 10.4 5.6 10.6Z" fill="url(#${prefix}-gold)" stroke="none" opacity=".9"/>
    <circle cx="20.4" cy="3.4" r="1.15" fill="url(#${prefix}-gold)" stroke="none"/>
    <circle cx="3.4" cy="20.4" r="1.15" fill="url(#${prefix}-gold)" stroke="none"/>
    <path d="M14.5 2.4h5M2.4 14.5v5" stroke-width=".7" opacity=".5" vector-effect="non-scaling-stroke"/>
  </g>`;

/** 卡牌鎏金外框（viewBox 132×184，贴合卡面比例，缩放不变形） */
export function renderFrameSvg(opts = {}) {
  const { hero = false, special = false, leader = false } = opts;
  const prefix = "gtf";
  const corner = cornerCurl(prefix);
  const crown = leader || hero
    ? `<g transform="translate(66 5.5)" fill="url(#${prefix}-gold)" stroke="url(#${prefix}-gold)" stroke-width=".5">
        <path d="M-7 3.2L-5.6-2.4L-2.8 1L0-3.2L2.8 1L5.6-2.4L7 3.2Z" stroke="none"/>
        <circle cx="0" cy="-4.6" r=".9" stroke="none"/>
        <circle cx="-6.4" cy="-3.2" r=".7" stroke="none"/>
        <circle cx="6.4" cy="-3.2" r=".7" stroke="none"/>
      </g>`
    : "";
  return `
    <svg viewBox="0 0 132 184" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <rect x=".9" y=".9" width="130.2" height="182.2" rx="9.2" fill="none"
        stroke="url(#${prefix}-gold-v)" stroke-width="${hero ? 1.7 : 1.25}" opacity="${hero ? 0.95 : 0.8}"
        vector-effect="non-scaling-stroke"/>
      <rect x="2.6" y="2.6" width="126.8" height="178.8" rx="8" fill="none"
        stroke="url(#${prefix}-gold)" stroke-width=".62" opacity="${special ? 0.3 : 0.52}"
        vector-effect="non-scaling-stroke"/>
      <rect x="4.4" y="4.4" width="123.2" height="175.2" rx="6.8" fill="none"
        stroke="url(#${prefix}-gold)" stroke-width=".4" opacity=".22"
        vector-effect="non-scaling-stroke"/>
      <g vector-effect="non-scaling-stroke" opacity="${hero ? 1 : 0.9}">
        <g transform="translate(5 5)">${corner}</g>
        <g transform="translate(127 5) rotate(90)">${corner}</g>
        <g transform="translate(127 179) rotate(180)">${corner}</g>
        <g transform="translate(5 179) rotate(270)">${corner}</g>
      </g>
      ${crown}
      <g stroke="url(#${prefix}-gold)" stroke-width=".7" opacity=".5" vector-effect="non-scaling-stroke">
        <path d="M56 91.5h-4M76 91.5h4" stroke-linecap="round"/>
      </g>
    </svg>`;
}

/* ------------------------------------------------------------------ 图标 */
const ICON_PATHS = {
  close: `
    <path d="M5.2 2.5L10 7.3l4.8-4.8 1.4 1.4L11.4 8.7l4.8 4.8-1.4 1.4L10 10.1l-4.8 4.8-1.4-1.4 4.8-4.8L3.8 3.9Z"/>
    <path d="M4.6 18.8l2.4-2.4M19.4 18.8l-2.4-2.4M3.2 21.4l2.2-2.2M20.8 21.4l-2.2-2.2" opacity=".75"/>`,
  ranged: `
    <path d="M6 2.6C14.5 6 14.5 18 6 21.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    <path d="M6 2.6V21.4" fill="none" stroke="currentColor" stroke-width="1" opacity=".85"/>
    <path d="M2.4 12h16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M18.4 12l-4-2.2v4.4Z"/>
    <path d="M2.8 12l2.2-1.6M2.8 12l2.2 1.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>`,
  siege: `
    <path d="M2.4 21.2h19.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M4.4 21.2L9.2 7.6h5.6l4.8 13.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M6.6 15.2h10.8M15 15.2l4.4-5.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    <circle cx="20.3" cy="8.2" r="2.1" fill="currentColor"/>
    <path d="M8.8 7.6L6.4 4.2M11 7.6V3.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".8"/>`,
  agile: `
    <path d="M4.2 20.2C8.2 15.4 9.4 10.6 8.4 4.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M8.4 4.2L5 8.2M8.4 4.2l3.4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M19.8 20.2C15.8 15.4 14.6 10.6 15.6 4.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M15.6 4.2l3.4 4M15.6 4.2l-3.4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M12 9.4v6M12 15.4l-2.2 2M12 15.4l2.2 2" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" opacity=".65"/>`,
  weather: `
    <path d="M12 2v20M2 12h20M4.9 4.9l14.2 14.2M19.1 4.9L4.9 19.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M12 2l-1.6 3h3.2ZM22 12l-3-1.6v3.2ZM12 22l1.6-3h-3.2ZM2 12l3 1.6v-3.2Z" fill="currentColor" stroke="none"/>
    <circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none"/>`,
  frost: `
    <path d="M12 2v20M3.4 7l17.2 10M20.6 7L3.4 17" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
    <path d="M12 2l-1.8 3.2h3.6ZM12 22l1.8-3.2h-3.6ZM3.4 7l3.6.6-1.8 3.4ZM20.6 7l-3.6.6 1.8 3.4ZM3.4 17l3.6-.6-1.8-3.4ZM20.6 17l-3.6-.6 1.8-3.4Z" fill="currentColor" stroke="none"/>
    <circle cx="12" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="1.2"/>`,
  fog: `
    <path d="M3 9.4h14.4M6.6 13h14.4M3 16.6h12.8M8.2 20h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".95"/>
    <path d="M3 6h10.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity=".45"/>`,
  rain: `
    <path d="M6.4 11.2a4.2 4.2 0 0 1 .6-8.2A5.6 5.6 0 0 1 17.3 4a3.5 3.5 0 0 1 .5 6.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M7.6 14.2L5.6 19M12 14.2l-2 4.8M16.4 14.2l-2 4.8M19.2 16.2l-1.4 3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
  storm: `
    <path d="M6.6 10.6a4 4 0 0 1 .5-7.8A5.4 5.4 0 0 1 17 3.4a3.4 3.4 0 0 1 .5 6.7" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
    <path d="M13.4 10.2L8.2 16.8h3.4l-1.8 5.4 6.4-7.4h-3.6l1.2-4.6Z" fill="currentColor" stroke="none"/>
    <path d="M4.4 13.6h3.4M3.2 16.4h2.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".6"/>`,
  clear: `
    <circle cx="12" cy="12" r="4.6" fill="currentColor"/>
    <path d="M12 1.6v3.4M12 19v3.4M1.6 12h3.4M19 12h3.4M4.6 4.6l2.4 2.4M17 17l2.4 2.4M19.4 4.6L17 7M7 17l-2.4 2.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
  horn: `
    <path d="M4.6 4.2C13.4 6 18.6 12 20.4 20.2C16.2 16.4 11.4 13 5.4 11.4C8.2 9.2 8.6 6.6 4.6 4.2Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M5.2 3.6C4 3 2.6 3 2.2 4.4C1.8 5.8 3 7 4.4 7.4" fill="none" stroke="currentColor" stroke-width="1.160" stroke-linecap="round"/>`,
  mardroeme: `
    <path d="M3.4 11.2C3.4 6.6 7.2 3.6 12 3.6C16.8 3.6 20.6 6.6 20.6 11.2C20.6 12.4 19.6 12.8 18.4 12.8H5.6C4.4 12.8 3.4 12.4 3.4 11.2Z" fill="currentColor" stroke="none"/>
    <path d="M8.4 13.2h7.2v6.2c0 1.4-1.2 2.2-2.6 2.2h-2c-1.4 0-2.6-.8-2.6-2.2Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="8.2" cy="8.2" r="1.1" fill="#000" opacity=".35"/><circle cx="13" cy="6.6" r=".9" fill="#000" opacity=".35"/><circle cx="16" cy="9.2" r="1.15" fill="#000" opacity=".35"/>`,
  scorch: `
    <path d="M12.4 1.8c1 4.6 5 6 5 10.4 0 2.8-1.6 5-3.9 5.8 1-2.2.6-4-1-5.6-.5 2.4-1.7 3.8-3.4 4.9.4-2.8-.4-4.4-1.6-5.9-.9 2-1.1 4 .3 6.3-2.3-1-3.8-3.2-3.8-5.7C4 7.4 8.6 6.6 9.6 1.8c1 2 .8 4.2.2 6.4 1.9-1.2 3.2-3.2 2.6-6.4Z" fill="currentColor" stroke="none"/>`,
  decoy: `
    <rect x="3" y="6" width="11" height="15" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4" transform="rotate(-8 8.5 13.5)"/>
    <rect x="9.4" y="4.4" width="11" height="15" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4" transform="rotate(7 15 12)"/>
    <path d="M14.6 10.4l2.6 2.4-2.6 2.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`,
  spy: `
    <path d="M1.8 12C5 6.6 8.4 4.8 12 4.8S19 6.6 22.2 12C19 17.4 15.6 19.2 12 19.2S5 17.4 1.8 12Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
    <circle cx="12" cy="12" r="3.2" fill="currentColor"/>
    <circle cx="12" cy="12" r="1.2" fill="#000" opacity=".55"/>`,
  medic: `
    <path d="M12 3.2v17.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    <path d="M7.4 7.2C5.2 7.6 3 6.8 2 5.2c.6 2.6 2.8 4.6 5.4 4.8Z" fill="currentColor" stroke="none"/>
    <path d="M16.6 7.2C18.8 7.6 21 6.8 22 5.2c-.6 2.6-2.8 4.6-5.4 4.8Z" fill="currentColor" stroke="none"/>
    <circle cx="12" cy="4.4" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/>
    <path d="M8.4 17.6c2.4 1.8 4.8 1.8 7.2 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`,
  muster: `
    <path d="M12 21V8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M12 8L8.6 11.4M12 8l3.4 3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M3.4 20.6L9 15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity=".8"/>
    <path d="M9 15l-3.4.2M9 15l-.2 3.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".8"/>
    <path d="M20.6 20.6L15 15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity=".8"/>
    <path d="M15 15l3.4.2M15 15l.2 3.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".8"/>`,
  bond: `
    <rect x="2.4" y="8.4" width="9" height="7.2" rx="3.6" fill="none" stroke="currentColor" stroke-width="1.5" transform="rotate(-20 6.9 12)"/>
    <rect x="12.6" y="8.4" width="9" height="7.2" rx="3.6" fill="none" stroke="currentColor" stroke-width="1.5" transform="rotate(-20 17.1 12)"/>`,
  morale: `
    <path d="M5.4 2.4v19.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M5.4 3.6h13.2l-3.2 4.2 3.2 4.2H5.4Z" fill="currentColor" stroke="none"/>`,
  avenger: `
    <path d="M12 2.6c2.8 3.4 4.8 6.2 4.8 9.4 0 2.2-1 4.2-2.6 5.6.2-2.4-.6-4-1.8-5.4-.6 3-1.4 4.6-3.2 6.4.8-2.8 0-4.6-1.4-6.2-.8 2-1 4.2.4 6.8C5.8 16.6 4.4 14 4.4 11C4.4 7.6 7.4 5.2 12 2.6Z" fill="currentColor" stroke="none"/>
    <path d="M8 20.4h8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
  berserker: `
    <path d="M5 3.4c2.2 2.2 2.8 4.4 2.4 7.2l3-2.6c1.4-1.2 3.6-1.2 4.8.2 1.2 1.4 1 3.4-.4 4.6L9 18.6c-1.2 1-2.8 1.2-4 .2L2.4 17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M12.6 8.4l1.4-4.8M15.8 9.4l3.6-3.6M17.2 12.2l4.8-1.4M4.6 15.6l2.8 1.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`,
  hero: `
    <path d="M4.4 18.6L6 7.4l4.2 4L12 4.6l1.8 6.8 4.2-4 1.6 11.2Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M4.4 18.6h15.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="12" cy="14.4" r="1.6" fill="currentColor"/>`,
  leader: `
    <path d="M3.6 17.8L5.4 6.6l4.4 4.2L12 3.8l2.2 7 4.4-4.2l1.8 11.2Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M3.6 17.8h16.8M7.2 20.6h9.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
  spy2: `
    <path d="M1.8 12C5 6.6 8.4 4.8 12 4.8S19 6.6 22.2 12C19 17.4 15.6 19.2 12 19.2S5 17.4 1.8 12Z" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <circle cx="12" cy="12" r="3" fill="currentColor"/>`,
};

/**
 * 行图标（近战 / 远程 / 攻城 / 灵巧 / 天气种类）。
 * @param {string} row
 * @returns {string} <svg> 字符串，可直接赋给 innerHTML
 */
export function renderRowIcon(row) {
  const key = String(row || "close").toLowerCase();
  const aliases = {
    close: "close",
    melee: "close",
    "close-combat": "close",
    ranged: "ranged",
    range: "ranged",
    "ranged-combat": "ranged",
    siege: "siege",
    agile: "agile",
    weather: "weather",
    frost: "frost",
    fog: "fog",
    rain: "rain",
    storm: "storm",
    clear: "clear",
    horn: "horn",
    mardroeme: "mardroeme",
    special: "weather",
    spell: "weather",
    leader: "leader",
  };
  const icon = ICON_PATHS[aliases[key] || key] || ICON_PATHS.close;
  return `<svg class="gt-icon gt-icon--${aliases[key] || key}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icon}</svg>`;
}

/** 能力 → 图标 id */
const ABILITY_ICON_MAP = {
  hero: "hero",
  spy: "spy",
  medic: "medic",
  muster: "muster",
  horn: "horn",
  scorch: "scorch",
  decoy: "decoy",
  mardroeme: "mardroeme",
  agile: "agile",
  avenger: "avenger",
  berserker: "berserker",
  bond: "bond",
  morale: "morale",
  weather: "weather",
  leader: "leader",
};

/** 从 abilities 数组推断主图标（用于能力区小徽记） */
export function renderAbilityIcon(abilities) {
  const list = Array.isArray(abilities) ? abilities : [];
  let id = null;
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i] && list[i].id;
    if (a && ABILITY_ICON_MAP[a]) {
      id = ABILITY_ICON_MAP[a];
      break;
    }
  }
  if (!id) id = "morale";
  return `<svg class="gt-icon gt-icon--${id}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON_PATHS[id]}</svg>`;
}

/** 天气种类的符文图标（供卡面左下角使用） */
export function weatherIconSvg(kind) {
  return renderRowIcon(String(kind || "").toLowerCase());
}

/* --------------------------------------------------------------- 牌背设计 */
const backCache = new Map();

function medallionRunes(prefix, radius) {
  let out = "";
  const glyphs = [
    "M-2-4V4M-3-2L3 2M-3 2L3-2",
    "M-3-4L3-4M0-4V4M-3 4H3",
    "M-3 4V-4L3-1L-3 2",
    "M3-4L-3-1L3 2V4",
    "M-2-4L2-1L-2 2V4M-2 4H2",
    "M-3-3H2V3H-2M-2-1V1",
    "M0-4V4M-3 0H3M-2 2L2-2",
    "M-3-4V4M3-4V4M-3 0H3",
  ];
  for (let i = 0; i < 24; i += 1) {
    const a = (i / 24) * Math.PI * 2;
    const x = 132 + Math.cos(a) * radius;
    const y = 184 + Math.sin(a) * radius;
    const g = glyphs[i % glyphs.length];
    const rot = (a * 180) / Math.PI + 90;
    out += `<g transform="translate(${n(x)} ${n(y)}) rotate(${n(rot)}) scale(.62)"><path d="${g}" fill="none" stroke="url(#${prefix}-gold)" stroke-width="1.5" stroke-linecap="round" opacity=".55"/></g>`;
  }
  return out;
}

function factionBackOrnament(pal, prefix) {
  switch (pal.key) {
    case "nr":
      return `<g fill="none" stroke="url(#${prefix}-gold)" stroke-width="1.2" opacity=".55" stroke-linecap="round">
        <path d="M42 52C58 36 76 30 96 34C112 37 124 46 132 52"/>
        <path d="M90 42C78 52 72 66 74 82M174 52C158 36 140 30 120 34C104 37 92 46 84 52"/>
        <path d="M84 46C78 56 76 68 80 80M164 70C156 62 148 58 140 56M140 56c4-6 4-12 0-16M140 56c8-2 14 0 18 4"/>
        <path d="M174 82c6-4 12-4 16 2M66 82c-6-4-12-4-16 2"/>
      </g>`;
    case "ng":
      return `<g fill="none" stroke="url(#${prefix}-gold)" stroke-width="1.1" opacity=".55">
        <circle cx="132" cy="184" r="102" stroke-dasharray="1 7"/>
        <path d="M132 60V74M132 294V308M46 184H32M218 184H232M72 112L62 102M192 256L202 266M192 112L202 102M72 256L62 266"/>
        <path d="M132 48l3 6-3 6-3-6ZM132 320l3-6-3-6-3 6Z"/>
      </g>`;
    case "st":
      return `<g fill="none" stroke="url(#${prefix}-gold)" stroke-width="1.15" opacity=".55">
        <path d="M62 66C80 56 100 56 114 64M202 66C184 56 164 56 150 64"/>
        <path d="M62 66c-8-6-10-14-6-20 6 2 10 6 12 12M202 66c8-6 10-14 6-20-6 2-10 6-12 12"/>
        <path d="M132 72c8 6 10 16 4 24-6-4-8-10-8-16M132 296c-8 4-12 12-8 20 8-2 12-8 12-14"/>
      </g>`;
    case "mo":
      return `<g fill="none" stroke="url(#${prefix}-gold)" stroke-width="1.4" opacity=".45" stroke-linecap="round">
        <path d="M54 96C70 112 78 136 72 164M78 82C96 104 102 130 94 158M206 116C190 132 182 152 186 174M186 100C170 122 164 144 170 168"/>
        <path d="M132 64l-6 10h12ZM132 300l-6-10h12Z"/>
      </g>`;
    case "sk":
      return `<g fill="none" stroke="url(#${prefix}-gold)" stroke-width="1.15" opacity=".55">
        <path d="M52 132q20-10 40 0t40 0t40 0t40 0"/>
        <path d="M60 226q18-9 36 0t36 0t36 0t36 0"/>
        <path d="M132 70c10 8 12 20 4 30-6-4-8-10-8-16M132 298c-10-6-12-18-4-28 6 4 8 10 8 16"/>
      </g>`;
    default:
      return `<g fill="none" stroke="url(#${prefix}-gold)" stroke-width="1" opacity=".5">
        <path d="M132 68v10M132 290v10M56 184h10M198 184h10M79 122l7 7M185 246l7 7M185 122l-7 7M79 246l-7 7"/>
        <circle cx="132" cy="184" r="112" stroke-dasharray="2 10"/>
      </g>`;
  }
}

/**
 * 阵营牌背（全卡尺寸，viewBox 264×368）。
 * 结果按阵营缓存；多次使用同一阵营时复用同一个 SVG 字符串。
 * @param {string} factionId
 * @returns {string} 完整 <svg> 字符串
 */
export function renderCardBackSvg(factionId) {
  const pal = paletteFor(factionId);
  const cacheKey = pal.key;
  if (backCache.has(cacheKey)) return backCache.get(cacheKey);
  const prefix = "gtf";
  const svg = `
  <svg class="gt-back-svg" viewBox="0 0 264 368" preserveAspectRatio="xMidYMid slice"
       xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <rect width="264" height="368" rx="14" fill="url(#${prefix}-leather)"/>
    <rect width="264" height="368" rx="14" fill="url(#${prefix}-glow-${pal.key})" opacity=".34"/>
    <rect width="264" height="368" fill="url(#${prefix}-dust)" opacity=".55"/>
    <rect width="264" height="368" fill="url(#${prefix}-hatch)" opacity=".06"/>
    <rect x="7" y="7" width="250" height="354" rx="11" fill="none"
      stroke="url(#${prefix}-gold-v)" stroke-width="2.4" opacity=".9"/>
    <rect x="13" y="13" width="238" height="342" rx="8" fill="none"
      stroke="url(#${prefix}-gold)" stroke-width=".7" opacity=".55"/>
    <rect x="17.5" y="17.5" width="229" height="333" rx="6" fill="none"
      stroke="${rgba(pal.core, 0.45)}" stroke-width=".9"/>
    <rect x="21" y="21" width="222" height="326" rx="5" fill="none"
      stroke="url(#${prefix}-gold)" stroke-width=".45" opacity=".22"/>
    <g opacity=".28" stroke="${rgba(pal.core, 0.7)}" stroke-width=".8" fill="none">
      <path d="M21 90V21H90M174 21h69v69M21 278v69h69M243 278v69h-69"/>
    </g>
    ${factionBackOrnament(pal, prefix)}
    <g>
      <circle cx="132" cy="184" r="96" fill="#0a0806" opacity=".38"/>
      <circle cx="132" cy="184" r="93" fill="none" stroke="url(#${prefix}-gold-v)" stroke-width="1.3" opacity=".75"/>
      <circle cx="132" cy="184" r="86" fill="url(#${prefix}-medallion)"/>
      <circle cx="132" cy="184" r="86" fill="none" stroke="${rgba(pal.core, 0.55)}" stroke-width="1.1"/>
      <circle cx="132" cy="184" r="78" fill="none" stroke="url(#${prefix}-gold)" stroke-width=".6" opacity=".6"/>
      <circle cx="132" cy="184" r="71" fill="none" stroke="url(#${prefix}-gold)" stroke-width=".45" opacity=".3"/>
      ${medallionRunes(prefix, 82)}
      <g transform="translate(132 184) scale(1.06) translate(-50 -50)">
        <g transform="translate(50 50) scale(.96) translate(-50 -50)" fill="none"
           stroke="url(#${prefix}-gold)" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity=".92">
          ${sigilMarkup(pal.key, prefix)}
        </g>
      </g>
      <g fill="url(#${prefix}-gold)" stroke="none">
        <path d="M132 72l4.6 7.6-4.6 7.6-4.6-7.6Z"/>
        <path d="M132 296l4.6-7.6-4.6-7.6-4.6 7.6Z"/>
        <circle cx="132" cy="184" r="1.7" opacity=".8"/>
      </g>
    </g>
    <g fill="none" stroke="url(#${prefix}-gold)" stroke-width=".8" opacity=".5">
      <path d="M36 132h10c6 0 10 4 10 10v10M228 132h-10c-6 0-10 4-10 10v10M36 236h10c6 0 10-4 10-10v-10M228 236h-10c-6 0-10-4-10-10v-10"/>
    </g>
    <rect width="264" height="368" fill="url(#${prefix}-vignette)"/>
    <rect width="264" height="368" filter="url(#${prefix}-grain)" opacity=".5" style="mix-blend-mode:overlay"/>
    <rect x="7" y="7" width="250" height="354" rx="11" fill="none" stroke="#000" stroke-width="1" opacity=".5"/>
  </svg>`;
  backCache.set(cacheKey, svg);
  return svg;
}

/* ========================================================================== */
/*  场景工具箱                                                                */
/* ========================================================================== */

const RUNE_GLYPHS = [
  "M0-6V6M-4 0H4",
  "M-3-6V6M3-6V6M-3 0H3",
  "M-4 6L0-6L4 6M-2 2H2",
  "M-3-6L3 0L-3 6M1-3V3",
  "M0-6L-4 6M0-6L4 6M-3 2H3",
  "M-3-4L3-4L-3 4L3 4",
  "M-2-6V6M2-6V6M-2-2L2 2",
  "M0-6V6M-4-3L4-3M-3 3L3 3",
  "M-4-5L4 0L-4 5M-1-2V2",
  "M-3-5H3V0H-3ZM-3 0L3 5",
  "M0-6V0L4 6M0-3L-4 3",
  "M-4 4L0-6L4 4M-2-1H2",
  "M-3-6H3M0-6V6M-3 0H3",
  "M-4-4L0-6L4-4V4L0 6L-4 4Z",
];

function subject(ctx, d, opts = {}) {
  const heroFill = ctx.heroSubject || ctx.hero;
  const {
    fill = heroFill ? `url(#gtf-herosubj-${ctx.pal.key})` : `url(#gtf-subj-${ctx.pal.key})`,
    rim = heroFill ? 1 : 0.92,
    width = heroFill ? 1.5 : 1.3,
    opacity = 1,
    extra = "",
  } = opts;
  const halo = `<path d="${d}" fill="none" stroke="${rgba(
    ctx.pal.glow,
    heroFill ? 0.26 : 0.19
  )}" stroke-width="${n(width * 3.4)}" stroke-linejoin="round" stroke-linecap="round"/>`;
  return `${halo}<path d="${d}" fill="${fill}" opacity="${opacity}" stroke="url(#gtf-rim-${
    ctx.pal.key
  })" stroke-width="${width}" stroke-opacity="${rim}" stroke-linejoin="round" stroke-linecap="round"${extra}/>`;
}

/** 大件黑体兵器 / 结构的轮廓（无渐变填充，边缘更冷） */
function solid(ctx, d, opts = {}) {
  const { fill = "#070504", rim = 0.55, width = 1.2, extra = "" } = opts;
  return `<path d="${d}" fill="none" stroke="${rgba(ctx.pal.glow, 0.1)}" stroke-width="${n(
    width * 3
  )}" stroke-linejoin="round" stroke-linecap="round"/><path d="${d}" fill="${fill}" stroke="url(#gtf-rim-${
    ctx.pal.key
  })" stroke-width="${width}" stroke-opacity="${rim}" stroke-linejoin="round" stroke-linecap="round"${extra}/>`;
}

/** 轮廓高光线：在剪影内部勾出结构 */
function contour(ctx, d, opts = {}) {
  const { width = 0.9, opacity = 0.28, color = null, extra = "" } = opts;
  const stroke = color || rgba(ctx.pal.glow, 1);
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;
}

/** 以底部中心为锚点放大主体，让插画更饱满 */
function subjectScale(inner, scale = 1.08, cx = 120, baseY = 198) {
  return `<g transform="translate(${n(cx)} ${n(baseY)}) scale(${n(scale)}) translate(${n(-cx)} ${n(
    -baseY
  )})">${inner}</g>`;
}

function glowEyes(ctx, points, opts = {}) {
  const color = opts.color || shadeHex(ctx.pal.glow, 0.25);
  const r = opts.r || 2.1;
  let out = "";
  points.forEach(([x, y, scale = 1]) => {
    out += `<g>
      ${glowCircle(x, y, r * 5.2 * scale, "url(#gtf-bokeh)", 0.5)}
      <ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(r * 1.5 * scale)}" ry="${n(r * 0.85 * scale)}" fill="${color}" opacity=".92"/>
      <circle cx="${n(x)}" cy="${n(y)}" r="${n(r * 0.42 * scale)}" fill="#fff6dd" opacity=".9"/>
    </g>`;
  });
  return out;
}

/** 月轮 / 日轮（含光晕、环形山、部分卡牌为日蚀环） */
function moonScene(ctx, opts = {}) {
  const { rng, pal } = ctx;
  const skip = opts.force ? false : rng() < 0.14;
  if (skip) return "";
  const x = opts.x != null ? opts.x : range(rng, 48, 192);
  const y = opts.y != null ? opts.y : range(rng, 32, 80);
  const r = opts.r != null ? opts.r : range(rng, 13, 29);
  const eclipse = opts.eclipse != null ? opts.eclipse : rng() < 0.22;
  let out = glowCircle(x, y, r * (eclipse ? 4.2 : 3.2), "url(#gtf-moon-bloom)", eclipse ? 0.6 : 0.85);
  if (eclipse) {
    out += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="#080605" opacity=".9"/>`;
    out += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="none" stroke="${shadeHex(pal.glow, 0.35)}" stroke-width="1.6" opacity=".8"/>`;
    out += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r * 1.25)}" fill="none" stroke="${rgba(pal.glow, 0.35)}" stroke-width=".6" stroke-dasharray="1 4"/>`;
  } else {
    out += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="url(#gtf-moon)" opacity=".92"/>`;
    const craters = irange(rng, 3, 6);
    for (let i = 0; i < craters; i += 1) {
      const a = rng() * Math.PI * 2;
      const d = rng() * r * 0.62;
      out += `<circle cx="${n(x + Math.cos(a) * d)}" cy="${n(y + Math.sin(a) * d)}" r="${n(
        range(rng, 1, r * 0.22)
      )}" fill="#8f8570" opacity="${n(range(rng, 0.08, 0.22))}"/>`;
    }
    out += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="none" stroke="#fff6dd" stroke-width=".6" opacity=".28"/>`;
  }
  return out;
}

/** 放射金线（英雄 / 领袖） */
function rayBurst(ctx, opts = {}) {
  const { rng } = ctx;
  const cx = opts.cx != null ? opts.cx : 120 + range(rng, -14, 14);
  const cy = opts.cy != null ? opts.cy : 70 + range(rng, -8, 8);
  const count = opts.count || irange(rng, 16, 24);
  const inner = opts.inner || 16;
  const outer = opts.outer || 150;
  const color = opts.color || "#f0d078";
  const opMin = opts.opacityMin != null ? opts.opacityMin : 0.05;
  const opMax = opts.opacityMax != null ? opts.opacityMax : 0.16;
  let out = `<g class="gt-art__rays">`;
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2 + range(rng, -0.03, 0.03);
    const len = range(rng, outer * 0.55, outer);
    const w = range(rng, 0.9, 2.6);
    const x1 = cx + Math.cos(a) * inner;
    const y1 = cy + Math.sin(a) * inner;
    const x2 = cx + Math.cos(a - w / 60) * len;
    const y2 = cy + Math.sin(a - w / 60) * len;
    const x3 = cx + Math.cos(a + w / 60) * len;
    const y3 = cy + Math.sin(a + w / 60) * len;
    out += `<path d="M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}L${n(x3)} ${n(y3)}Z" fill="${color}" opacity="${n(
      range(rng, opMin, opMax)
    )}"/>`;
  }
  out += `</g>`;
  return out;
}

/** 符文环（特殊 / 天气 / 召唤 / 领袖） */
function runeRing(ctx, opts = {}) {
  const { rng, pal } = ctx;
  const cx = opts.cx != null ? opts.cx : 120;
  const cy = opts.cy != null ? opts.cy : 104;
  const r = opts.r != null ? opts.r : range(rng, 74, 88);
  const count = opts.count || 18;
  const opacity = opts.opacity != null ? opts.opacity : 0.55;
  const color = opts.color || "url(#gtf-gold)";
  let out = `<g class="gt-art__runering" opacity="${n(opacity)}">`;
  out += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="none" stroke="${color}" stroke-width=".7"/>`;
  out += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r - 4.5)}" fill="none" stroke="${color}" stroke-width=".35" stroke-dasharray="1 5" opacity=".7"/>`;
  out += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r + 4)}" fill="none" stroke="${color}" stroke-width=".35" opacity=".4"/>`;
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * (r - 10);
    const y = cy + Math.sin(a) * (r - 10);
    const rot = (a * 180) / Math.PI + 90 + range(rng, -6, 6);
    const glyph = RUNE_GLYPHS[irange(rng, 0, RUNE_GLYPHS.length - 1)];
    out += `<g transform="translate(${n(x)} ${n(y)}) rotate(${n(rot)}) scale(${n(range(rng, 0.55, 0.8))})"><path d="${glyph}" fill="none" stroke="${color}" stroke-width="1.1" stroke-linecap="round" opacity="${n(
      range(rng, 0.5, 0.95)
    )}"/></g>`;
  }
  // 环上的四颗宝石
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    out += `<path transform="translate(${n(cx + Math.cos(a) * r)} ${n(cy + Math.sin(a) * r)}) rotate(45)" d="M-2.4 0L0-2.4L2.4 0L0 2.4Z" fill="${color}"/>`;
  }
  out += `</g>`;
  return out;
}

/** 远景雾气（多层椭圆 + 渐变光斑） */
function fogWisps(ctx, opts = {}) {
  const { rng, pal } = ctx;
  const count = opts.count || 3;
  let out = `<g class="gt-art__fog">`;
  for (let i = 0; i < count; i += 1) {
    const y = opts.y != null ? opts.y + i * range(rng, 6, 16) : range(rng, 118, 186);
    const x = range(rng, 30, 210);
    const rx = range(rng, 60, 140);
    const ry = range(rng, 8, 20);
    out += `<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(rx)}" ry="${n(ry)}" fill="url(#gtf-glow-${
      pal.key
    })" opacity="${n(range(rng, 0.08, 0.2))}"/>`;
  }
  out += `</g>`;
  return out;
}

/** 近地火堆 / 余烬 */
function emberGlow(ctx, opts = {}) {
  const { rng, pal } = ctx;
  const count = opts.count || 3;
  let out = `<g class="gt-art__embers">`;
  for (let i = 0; i < count; i += 1) {
    const x = range(rng, 24, 216);
    const y = range(rng, 150, 198);
    out += glowCircle(x, y, range(rng, 8, 26), `url(#gtf-ember-${pal.key})`, range(rng, 0.2, 0.5));
  }
  const sparks = opts.sparks || 10;
  for (let i = 0; i < sparks; i += 1) {
    const x = range(rng, 20, 220);
    const y = range(rng, 110, 198);
    out += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(range(rng, 0.6, 1.6))}" fill="${shadeHex(
      pal.accent,
      0.2
    )}" opacity="${n(range(rng, 0.35, 0.85))}"/>`;
  }
  out += `</g>`;
  return out;
}

/** 干裂大地 */
function crackedGround(ctx, opts = {}) {
  const { rng, pal } = ctx;
  const count = opts.count || irange(rng, 2, 4);
  let out = `<g class="gt-art__cracks" fill="none" stroke-linecap="round">`;
  for (let i = 0; i < count; i += 1) {
    const x = range(rng, 6, 234);
    const y = range(rng, 160, 198);
    const len = range(rng, 28, 76);
    const a = range(rng, -Math.PI * 0.85, -Math.PI * 0.15);
    const color = rng() < 0.5 ? rgba(pal.glow, 0.2) : "rgba(201,162,39,.18)";
    out += `<path d="${crackPath(rng, x, y, len, a)}" stroke="${color}" stroke-width="${n(
      range(rng, 0.45, 0.9)
    )}"/>`;
  }
  out += `</g>`;
  return out;
}

/** 远景枯树 */
function deadTree(rng, x, baseY, height) {
  const lean = range(rng, -0.18, 0.18);
  const topX = x + lean * height;
  const topY = baseY - height;
  let d = `M${n(x - 2.4)} ${n(baseY)}C${n(x - 1.6)} ${n(baseY - height * 0.35)} ${n(
    x - 1
  )} ${n(baseY - height * 0.6)} ${n(topX)} ${n(topY)}C${n(x + 1.4)} ${n(
    baseY - height * 0.6
  )} ${n(x + 2)} ${n(baseY - height * 0.4)} ${n(x + 2.6)} ${n(baseY)}Z`;
  let branches = "";
  const nb = irange(rng, 3, 6);
  for (let i = 0; i < nb; i += 1) {
    const t = range(rng, 0.35, 0.9);
    const bx = lerp(x, topX, t);
    const by = baseY - height * t;
    const side = rng() < 0.5 ? -1 : 1;
    const bl = height * range(rng, 0.12, 0.3);
    const ba = side * range(rng, 0.5, 1.1) - Math.PI / 2;
    const ex = bx + Math.cos(ba) * bl;
    const ey = by + Math.sin(ba) * bl;
    branches += `M${n(bx)} ${n(by)}Q${n((bx + ex) / 2 + side * 4)} ${n((by + ey) / 2 - 3)} ${n(ex)} ${n(ey)}`;
    if (rng() < 0.5) {
      branches += `M${n(ex)} ${n(ey)}l${n(side * 5)} ${n(-6)}`;
    }
  }
  return `<g class="gt-art__tree" fill="#080605" stroke="#080605">
    <path d="${d}"/>
    <path d="${branches}" fill="none" stroke-width="1.3" stroke-linecap="round"/>
  </g>`;
}

/** 地面残影 / 远景城堡 */
function distantKeep(rng, x, baseY, scale = 1) {
  const h = 30 * scale;
  const w = 16 * scale;
  return `<g fill="#070505" stroke="rgba(201,162,39,.12)" stroke-width=".4">
    <path d="M${n(x - w)} ${n(baseY)}V${n(baseY - h * 0.7)}H${n(x - w * 0.6)}V${n(
    baseY - h
  )}L${n(x)} ${n(baseY - h * 1.35)}L${n(x + w * 0.5)} ${n(baseY - h * 0.85)}H${n(
    x + w * 0.2
  )}V${n(baseY - h * 0.55)}H${n(x + w)}V${n(baseY)}Z"/>
  </g>`;
}

/** 武器：竖剑（英雄 / 战士背景） */
function swordVertical(ctx, opts = {}) {
  const { pal } = ctx;
  const cx = opts.cx || 120;
  const top = opts.top || 24;
  const guardY = opts.guardY || 138;
  const bottom = opts.bottom || 176;
  return `<g class="gt-art__sword">
    <path d="M${cx} ${top}L${cx + 5} ${top + 12}L${cx + 4.4} ${guardY}L${cx} ${guardY + 9}L${
    cx - 4.4
  } ${guardY}L${cx - 5} ${top + 12}Z" fill="url(#gtf-steel)" opacity=".82" stroke="url(#gtf-gold)" stroke-width=".6" stroke-opacity=".55"/>
    <path d="M${cx - 21} ${guardY}H${cx + 21}L${cx + 18} ${guardY + 6}H${cx + 5}L${cx + 3.6} ${
    guardY + 4
  }H${cx - 3.6}L${cx - 5} ${guardY + 6}H${cx - 18}Z" fill="url(#gtf-gold-v)"/>
    <path d="M${cx - 3.5} ${guardY + 6}H${cx + 3.5}V${bottom - 6}H${cx - 3.5}Z" fill="${shadeHex(
    pal.deep,
    0.1
  )}" stroke="url(#gtf-gold)" stroke-width=".5"/>
    <circle cx="${cx}" cy="${bottom}" r="4.6" fill="url(#gtf-gold)"/>
    <circle cx="${cx}" cy="${bottom}" r="2" fill="${shadeHex(pal.deep, 0.2)}"/>
  </g>`;
}

/** 武器：斜握长矛 */
function spearDiagonal(ctx, opts = {}) {
  const { rng } = ctx;
  const x1 = opts.x1 != null ? opts.x1 : range(rng, 52, 88);
  const y1 = opts.y1 != null ? opts.y1 : 22;
  const x2 = opts.x2 != null ? opts.x2 : range(rng, 150, 190);
  const y2 = opts.y2 != null ? opts.y2 : 196;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const head = 22;
  const hx = x1 + (dx / len) * head;
  const hy = y1 + (dy / len) * head;
  return `<g class="gt-art__spear">
    <path d="M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}" stroke="#0a0806" stroke-width="3"/>
    <path d="M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}" stroke="url(#gtf-gold)" stroke-width=".7" opacity=".4"/>
    <path d="M${n(x1)} ${n(y1)}L${n(hx + nx * 4)} ${n(hy + ny * 4)}L${n(hx - nx * 4)} ${n(
    hy - ny * 4
  )}Z" fill="url(#gtf-gold)" opacity=".85"/>
    <path d="M${n(x1 + nx * 8)} ${n(y1 + ny * 8)}q${n(-nx * 6)} ${n(-ny * 6)} ${n(-nx * 12)} ${n(
    -ny * 12
  )}" fill="none" stroke="url(#gtf-gold-v)" stroke-width="2" opacity=".7"/>
  </g>`;
}

/** 战士的背景场景：城堡 / 军队 / 松林 / 废墟（增加同 motif 卡的构图差异） */
function battleScene(ctx, variant) {
  const { rng, pal } = ctx;
  let out = "";
  if (variant === 0) {
    // 城堡剪影
    const baseY = 178;
    out += `<g fill="#050403" stroke="${rgba(pal.glow, 0.24)}" stroke-width=".7" opacity=".95">
      <path d="M-10 ${baseY}V126h14v-12h12v18h10v-22h12v22h10v-18h12v12h14V${baseY}Z"/>
      <path d="M172 ${baseY}V120h16v-14h14v16h12v-26h16v26h12v-16h14v14h14V${baseY}Z" opacity=".85"/>
      <path d="M-10 ${baseY}h260v8H-10Z" opacity=".6"/>
    </g>`;
    for (let i = 0; i < 7; i += 1) {
      const x = range(rng, 22, 218);
      out += `<rect x="${n(x)}" y="${n(range(rng, 120, 160))}" width="${n(
        range(rng, 2, 5)
      )}" height="${n(range(rng, 4, 9))}" fill="${rgba(pal.glow, 0.18)}"/>`;
    }
  } else if (variant === 1) {
    // 远处军队：长矛林立 + 盾牌剪影
    const baseY = 186;
    for (let i = 0; i < 12; i += 1) {
      const x = range(rng, 16, 224);
      const h = range(rng, 26, 54);
      out += `<path d="M${n(x)} ${n(baseY)}V${n(baseY - h)}" stroke="#070504" stroke-width="${n(
        range(rng, 1.6, 3)
      )}" opacity="${n(range(rng, 0.5, 0.9))}"/>`;
      if (rng() < 0.45) {
        out += `<path d="M${n(x - 3)} ${n(baseY - h)}l3-9 3 9Z" fill="${rgba(pal.accent, 0.35)}"/>`;
      }
    }
    out += `<g fill="#060504" opacity=".92">`;
    for (let i = 0; i < 6; i += 1) {
      const x = range(rng, 24, 216);
      const s0 = range(rng, 0.7, 1.05);
      out += `<path transform="translate(${n(x)} ${baseY - 6}) scale(${n(
        s0
      )})" d="M0 10C-2 2 -5-2 -5-8C-5-14 0-18 5-16C10-14 12-8 10-2C9 3 6 7 4 10Z" stroke="${rgba(
        pal.glow,
        0.12
      )}" stroke-width=".6"/>`;
    }
    out += `</g>`;
    out += `<path d="M-10 196C40 188 90 194 130 190S210 186 250 194V210H-10Z" fill="#050403" opacity=".9"/>`;
  } else if (variant === 2) {
    // 松林
    for (let i = 0; i < 7; i += 1) {
      const x = range(rng, 10, 230);
      const h = range(rng, 52, 104);
      const w = h * range(rng, 0.28, 0.44);
      const baseY = range(rng, 176, 196);
      out += `<path d="M${n(x)} ${n(baseY - h)}L${n(x + w * 0.5)} ${n(baseY - h * 0.62)}H${n(
        x - w * 0.5
      )}Z M${n(x)} ${n(baseY - h * 0.74)}L${n(x + w * 0.72)} ${n(baseY - h * 0.34)}H${n(
        x - w * 0.72
      )}Z" fill="#050403" opacity="${n(range(rng, 0.55, 0.9))}"/>`;
      out += `<path d="M${n(x)} ${n(baseY)}V${n(baseY - h * 0.1)}" stroke="#050403" stroke-width="2"/>`;
    }
    out += `<path d="M-10 196h260v14H-10Z" fill="#050403" opacity=".8"/>`;
  } else {
    // 断柱废墟
    const baseY = 188;
    out += `<g fill="#060504" stroke="${rgba(pal.glow, 0.14)}" stroke-width=".6">
      <path d="M18 ${baseY}V118h13v-9h7v9h8V${baseY}Z"/>
      <path d="M186 ${baseY}V126h11v-7h7v7h9v-14h8V${baseY}Z" opacity=".9"/>
      <path d="M96 ${baseY}V150h34v-9h-9v-14h-7v14h-8v-11h-10Z" opacity=".75"/>
      <path d="M-10 ${baseY}h260v9H-10Z" opacity=".65"/>
    </g>`;
    for (let i = 0; i < 4; i += 1) {
      const x = range(rng, 30, 210);
      out += `<path d="M${n(x)} 96l${n(range(rng, -10, 10))} ${n(range(rng, 14, 30))}" stroke="${rgba(
        pal.accent,
        0.16
      )}" stroke-width=".8"/>`;
    }
  }
  return out;
}

/** 战场道具：插在地上的长矛 / 群鸦 / 残破盾牌 */
function propField(ctx, enabled) {
  if (!enabled) return "";
  const { rng, pal } = ctx;
  const style = irange(rng, 0, 2);
  let out = "";
  if (style === 0) {
    // 插在地上的长矛
    for (let i = 0; i < 3; i += 1) {
      const x = range(rng, 24, 216);
      const y = range(rng, 140, 176);
      const lean = range(rng, -10, 10);
      out += `<g opacity="${n(range(rng, 0.6, 0.9))}"><path d="M${n(x)} ${n(y)}l${n(
        lean
      )} 44" stroke="#080605" stroke-width="3"/><path d="M${n(x - 4)} ${n(y - 2)}l4-10 4 10Z" fill="${rgba(
        pal.accent,
        0.5
      )}"/></g>`;
    }
  } else if (style === 1) {
    // 群鸦
    for (let i = 0; i < 4; i += 1) {
      const x = range(rng, 30, 210);
      const y = range(rng, 30, 90);
      const s = range(rng, 0.6, 1.1);
      out += `<path transform="translate(${n(x)} ${n(y)}) scale(${n(
        s
      )})" d="M0 0q-6-6-12 0q6-2 12 0q6-2 12 0q-6-6-12 0Z" fill="#060504" opacity="${n(
        range(rng, 0.5, 0.85)
      )}"/>`;
    }
  } else {
    // 废墟残墙
    const x = range(rng, 26, 58);
    out += `<g fill="#060504" stroke="${rgba(pal.glow, 0.14)}" stroke-width=".6" opacity=".9">
      <path d="M${n(x)} 186V138h10v-12h9v18h7v-24h10v66Z"/>
      <path d="M${n(x + 58)} 186v-28h8V146h8v40Z" opacity=".7"/>
    </g>`;
  }
  return out;
}

/** 战旗 */
function warBanner(ctx, opts = {}) {
  const { rng, pal } = ctx;
  const x = opts.x != null ? opts.x : rng() < 0.5 ? range(rng, 34, 58) : range(rng, 182, 206);
  const top = opts.top || range(rng, 34, 54);
  const bottom = opts.bottom || range(rng, 178, 194);
  const dir = opts.dir || (x < 120 ? 1 : -1);
  const w = range(rng, 26, 40);
  const flag = `M${n(x)} ${n(top)}C${n(x + dir * w * 0.5)} ${n(top - 6)} ${n(x + dir * w)} ${n(
    top + 4
  )} ${n(x + dir * w * 1.1)} ${n(top + 14)}C${n(x + dir * w * 0.8)} ${n(top + 26)} ${n(
    x + dir * w * 0.9
  )} ${n(top + 34)} ${n(x + dir * w * 0.7)} ${n(top + 46)}C${n(x + dir * w * 0.45)} ${n(
    top + 38
  )} ${n(x + dir * w * 0.25)} ${n(top + 42)} ${n(x)} ${n(top + 38)}Z`;
  return `<g class="gt-art__banner">
    <path d="M${n(x)} ${n(top)}V${n(bottom)}" stroke="#0b0806" stroke-width="2.6"/>
    <path d="M${n(x)} ${n(top)}V${n(bottom)}" stroke="url(#gtf-gold)" stroke-width=".55" opacity=".55"/>
    <path d="${flag}" fill="${shadeHex(pal.deep, -0.1)}" stroke="url(#gtf-gold)" stroke-width=".7" stroke-opacity=".45"/>
    <path d="${flag}" fill="url(#gtf-gold)" opacity=".06"/>
    ${miniSigil(pal.key, x + dir * w * 0.52, top + 22, w * 0.62, 0.4)}
    <path d="M${n(x)} ${n(top - 6)}l3 6-3 6-3-6Z" fill="url(#gtf-gold)"/>
  </g>`;
}

/** 小纹章印在旗帜/盾牌上（直接内联，不引用外部） */
function miniSigil(factionKey, x, y, size, opacity = 0.35) {
  const s = size / 100;
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${n(s)}) translate(-50 -50)" fill="none" stroke="url(#gtf-gold)" stroke-width="${n(
    1.2 / s
  )}" stroke-linecap="round" opacity="${n(opacity)}">${sigilMarkup(factionKey)}</g>`;
}

/** 圆形盾牌 */
function roundShield(ctx, opts = {}) {
  const { pal } = ctx;
  const x = opts.x || 172;
  const y = opts.y || 150;
  const r = opts.r || 25;
  return `<g class="gt-art__shield">
    <circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${shadeHex(pal.deep, -0.05)}" stroke="url(#gtf-gold)" stroke-width="1.6" stroke-opacity=".75"/>
    <circle cx="${n(x)}" cy="${n(y)}" r="${n(r * 0.78)}" fill="none" stroke="${rgba(
    pal.glow,
    0.35
  )}" stroke-width=".8"/>
    ${miniSigil(pal.key, x, y, r * 1.3, 0.45)}
    <circle cx="${n(x)}" cy="${n(y)}" r="${n(r * 0.16)}" fill="url(#gtf-gold)" opacity=".9"/>
  </g>`;
}

/* ========================================================================== */
/*  16 类 motif 绘制函数                                                      */
/* ========================================================================== */

/* ---- 战士 ---------------------------------------------------------------- */
function paintWarrior(ctx) {
  const { rng, pal } = ctx;
  const weapon = irange(rng, 0, 2);
  const shield = rng() < 0.42;
  const banner = rng() < 0.6;
  const cx = 120 + range(rng, -6, 6);
  const shift = range(rng, -14, 14);
  const helmVariant = irange(rng, 0, 2);
  const props = rng() < 0.5;
  const hooded = rng() < 0.3;
  const sceneVariant = irange(rng, 0, 3);
  const flip = rng() < 0.32;
  const tilt = range(rng, -4, 4);
  let out = "";

  out += battleScene(ctx, sceneVariant);
  // 月轮固定在画面两侧，避免与头盔重叠
  const moonSide = rng() < 0.5 ? -1 : 1;
  out += moonScene(ctx, {
    x: 120 + moonSide * range(rng, 58, 78),
    y: range(rng, 32, 62),
    r: range(rng, 15, 26),
  });
  out += propField(ctx, props);
  if (banner) out += warBanner(ctx);

  // 背后的兵器
  if (weapon === 0) {
    out += swordVertical(ctx, { cx: cx + range(rng, -12, 12), top: range(rng, 12, 26), guardY: 128 });
    out += `<path d="M${cx - 58} 200L${cx - 34} 118" stroke="#080605" stroke-width="3" opacity=".7"/>`;
  } else if (weapon === 1) {
    out += spearDiagonal(ctx, {
      x1: range(rng, 30, 52),
      y1: 12,
      x2: range(rng, 182, 206),
      y2: 202,
    });
  } else {
    out += `<g class="gt-art__axe">
      <path d="M${n(cx + 60)} 18L${n(cx - 42)} 202" stroke="#090705" stroke-width="6.4"/>
      <path d="M${n(cx + 60)} 18L${n(cx - 42)} 202" stroke="url(#gtf-gold)" stroke-width="1" opacity=".38"/>
      <path d="M${n(cx + 44)} 30C${n(cx + 60)} 2 ${n(cx + 92)} -4 ${n(cx + 112)} 8C${n(
        cx + 96
      )} 10 ${n(cx + 80)} 22 ${n(cx + 70)} 40C${n(cx + 60)} 34 ${n(cx + 50)} 32 ${n(
        cx + 44
      )} 30Z" fill="#0a0807" stroke="url(#gtf-rim-${pal.key})" stroke-width="1" stroke-opacity=".7"/>
      <path d="M${n(cx + 108)} 6C${n(cx + 116)} 12 ${n(cx + 116)} 22 ${n(cx + 108)} 28C${n(
        cx + 94
      )} 18 ${n(cx + 82)} 10 ${n(cx + 70)} 4C${n(cx + 82)} 2 ${n(cx + 98)} 3 ${n(
        cx + 108
      )} 6Z" fill="url(#gtf-gold)" opacity=".5"/>
    </g>`;
  }

  // ---- 主体（坐标已含 cx）----
  let fig = `<g>`;
  // 披风
  fig += subject(
    ctx,
    `M${cx - 62} 204C${cx - 64} 162 ${cx - 48} 140 ${cx - 28} 132L${cx + 28} 132C${cx + 48} 140 ${
      cx + 64
    } 162 ${cx + 62} 204Z`,
    { fill: "#080605", rim: 0.5, width: 1.1 }
  );
  fig += contour(
    ctx,
    `M${cx - 48} 202C${cx - 48} 170 ${cx - 38} 150 ${cx - 22} 140M${cx + 48} 202C${cx + 48} 170 ${
      cx + 38
    } 150 ${cx + 22} 140`,
    { opacity: 0.24, width: 1 }
  );
  // 胸甲
  fig += subject(
    ctx,
    `M${cx - 42} 204C${cx - 38} 164 ${cx - 26} 143 ${cx - 15} 136L${cx + 15} 136C${cx + 26} 143 ${
      cx + 38
    } 164 ${cx + 42} 204Z`,
    { fill: `url(#gtf-subj-${pal.key})`, rim: 1 }
  );
  // 胸甲结构线：领口 V、胸肌弧、腰封、锁甲
  fig += contour(
    ctx,
    `M${cx - 19} 141L${cx} 160L${cx + 19} 141M${cx - 33} 166C${cx - 20} 158 ${cx - 8} 164 ${cx} 173C${
      cx + 8
    } 164 ${cx + 20} 158 ${cx + 33} 166M${cx - 30} 186C${cx - 12} 192 ${cx + 12} 192 ${cx + 30} 186`,
    { opacity: 0.42, width: 1.1 }
  );
  fig += `<path d="M${cx - 31} 190C${cx - 12} 196 ${cx + 12} 196 ${cx + 31} 190L${cx + 32} 198C${
    cx + 12
  } 204 ${cx - 12} 204 ${cx - 32} 198Z" fill="#0a0705" stroke="url(#gtf-gold)" stroke-width=".55" stroke-opacity=".45"/>`;
  fig += `<circle cx="${cx}" cy="195" r="4.2" fill="none" stroke="url(#gtf-gold)" stroke-width=".8" opacity=".65"/><circle cx="${cx}" cy="195" r="1.5" fill="url(#gtf-gold)" opacity=".8"/>`;
  // 锁甲下摆
  fig += `<path d="M${cx - 26} 199C${cx - 10} 204 ${cx + 10} 204 ${cx + 26} 199M${cx - 24} 204C${cx - 8} 208 ${cx + 8} 208 ${cx + 24} 204" fill="none" stroke="${rgba(
    pal.glow,
    0.18
  )}" stroke-width=".8"/>`;
  // 护颈
  fig += subject(
    ctx,
    `M${cx - 17} 118L${cx + 17} 118L${cx + 20} 138L${cx - 20} 138Z`,
    { fill: "#0b0806", width: 1.2, rim: 0.8 }
  );
  fig += contour(ctx, `M${cx - 16} 125H${cx + 16}M${cx - 17} 131H${cx + 17}`, { opacity: 0.32, width: 0.8 });
  // 肩甲（双层 + 尖刺）
  [-1, 1].forEach((sd) => {
    const ox = cx + sd * 33;
    fig += subject(
      ctx,
      `M${ox - sd * 20} 174C${ox - sd * 32} 166 ${ox - sd * 36} 152 ${ox - sd * 31} 141L${ox - sd * 14} 145L${
        ox + sd * 3
      } 153C${ox + sd * 2} 163 ${ox - sd * 8} 170 ${ox - sd * 18} 175Z`,
      { fill: "#0e0b07", width: 1.4, rim: 0.95 }
    );
    fig += contour(
      ctx,
      `M${ox - sd * 28} 160C${ox - sd * 25} 152 ${ox - sd * 25} 147 ${ox - sd * 24} 142`,
      { opacity: 0.42, width: 0.9 }
    );
    fig += `<path d="M${ox - sd * 31} 141L${ox - sd * 38} 128L${ox - sd * 23} 139Z" fill="#0b0806" stroke="url(#gtf-rim-${
      pal.key
    })" stroke-width=".8" stroke-opacity=".7"/>`;
  });
  // 头部：兜帽游侠 / 大盔骑士
  if (hooded) {
    fig += subject(
      ctx,
      `M${cx} 50C${cx - 17} 50 ${cx - 29} 64 ${cx - 29} 84C${cx - 29} 100 ${cx - 23} 113 ${cx - 14} 121L${
        cx - 13
      } 130L${cx + 13} 130L${cx + 14} 121C${cx + 23} 113 ${cx + 29} 100 ${cx + 29} 84C${cx + 29} 64 ${
        cx + 17
      } 50 ${cx} 50Z`,
      { fill: "#0d0a07", width: 1.4, rim: 0.9 }
    );
    fig += `<path d="M${cx - 22} 76C${cx - 20} 94 ${cx - 11} 108 ${cx} 115C${cx + 11} 108 ${cx + 20} 94 ${
      cx + 22
    } 76C${cx + 21} 65 ${cx + 12} 58 ${cx} 58C${cx - 12} 58 ${cx - 21} 65 ${cx - 22} 76Z" fill="#020202"/>`;
    fig += glowEyes(ctx, [[cx - 8, 82, 0.8], [cx + 8, 82, 0.8]]);
    fig += `<path d="M${cx - 8} 108C${cx - 3} 112 ${cx + 3} 112 ${cx + 8} 108" fill="none" stroke="${rgba(
      pal.glow,
      0.25
    )}" stroke-width="1"/>`;
    // 兜帽尖角
    fig += `<path d="M${cx} 50C${cx - 8} 38 ${cx - 22} 30 ${cx - 42} 26C${cx - 24} 34 ${cx - 12} 42 ${cx - 4} 52Z" fill="${shadeHex(
      pal.deep,
      0.22
    )}" opacity=".9"/>`;
    fig += contour(ctx, `M${cx - 25} 70C${cx - 27} 84 ${cx - 22} 98 ${cx - 14} 108M${cx + 25} 70C${cx + 27} 84 ${cx + 22} 98 ${cx + 14} 108`, {
      opacity: 0.35,
      width: 1,
    });
  } else {
  fig += subject(
    ctx,
    `M${cx} 44C${cx - 14} 44 ${cx - 24} 55 ${cx - 25} 71C${cx - 26} 86 ${cx - 22} 99 ${cx - 16} 108L${
      cx - 15
    } 120C${cx - 8} 126 ${cx + 8} 126 ${cx + 15} 120L${cx + 16} 108C${cx + 22} 99 ${cx + 26} 86 ${
      cx + 25
    } 71C${cx + 24} 55 ${cx + 14} 44 ${cx} 44Z`,
    { fill: "#100c08", width: 1.6, rim: 1 }
  );
  // 头盔高光结构
  fig += contour(
    ctx,
    `M${cx} 44V70M${cx - 23} 74C${cx - 21} 60 ${cx - 12} 50 ${cx + 2} 48M${cx + 23} 74C${cx + 21} 60 ${
      cx + 12
    } 50 ${cx - 2} 48M${cx - 12} 118C${cx - 6} 124 ${cx + 6} 124 ${cx + 12} 118`,
    { opacity: 0.48, width: 1 }
  );
  // 面甲缝隙
  fig += `<path d="M${cx - 21} 82C${cx - 10} 77 ${cx + 10} 77 ${cx + 21} 82L${cx + 17} 97C${cx + 8} 93 ${
    cx - 8
  } 93 ${cx - 17} 97Z" fill="#030202"/>`;
  fig += `<path d="M${cx - 21} 82C${cx - 10} 77 ${cx + 10} 77 ${cx + 21} 82" fill="none" stroke="url(#gtf-gold)" stroke-width=".6" opacity=".55"/>`;
  fig += glowEyes(ctx, [[cx - 9, 87, 0.82], [cx + 9, 87, 0.82]]);
  // 鼻梁护条
  fig += `<path d="M${cx - 2.6} 76L${cx + 2.6} 76L${cx + 2.8} 108L${cx} 113L${cx - 2.8} 108Z" fill="#0c0906" stroke="url(#gtf-rim-${
    pal.key
  })" stroke-width=".6" stroke-opacity=".7"/>`;
  // 护颊
  fig += contour(
    ctx,
    `M${cx - 17} 98L${cx - 13} 116M${cx + 17} 98L${cx + 13} 116`,
    { opacity: 0.36, width: 1 }
  );
  // 盔顶龙脊 + 铆钉
  fig += `<path d="M${cx - 1.4} 44V72M${cx + 1.4} 44V72" stroke="url(#gtf-gold)" stroke-width="1" opacity=".45"/>`;
  fig += `<circle cx="${cx - 18}" cy="72" r="1.3" fill="url(#gtf-gold)" opacity=".55"/><circle cx="${
    cx + 18
  }" cy="72" r="1.3" fill="url(#gtf-gold)" opacity=".55"/>`;
  // 战损划痕
  fig += `<path d="M${cx - 20} 62L${cx - 14} 70M${cx + 16} 58L${cx + 20} 66" stroke="${rgba(
    pal.glow,
    0.25
  )}" stroke-width=".7"/>`;
  }
  // 盔饰变体（仅头盔）
  if (!hooded && helmVariant === 1) {
    fig += `<path d="M${cx} 46C${cx - 4} 30 ${cx - 18} 18 ${cx - 40} 12C${cx - 22} 22 ${cx - 10} 32 ${cx - 2} 48Z" fill="${shadeHex(
      pal.core,
      0.32
    )}" opacity=".85"/><path d="M${cx} 46C${cx + 4} 32 ${cx + 16} 22 ${cx + 36} 16C${cx + 20} 26 ${cx + 10} 34 ${cx + 3} 48Z" fill="${shadeHex(
      pal.deep,
      0.18
    )}" opacity=".9"/>`;
  } else if (!hooded && helmVariant === 2) {
    fig += `<path d="M${cx - 24} 66C${cx - 38} 54 ${cx - 54} 50 ${cx - 66} 56C${cx - 54} 60 ${cx - 44} 70 ${cx - 38} 84Z" fill="${shadeHex(
      pal.deep,
      0.2
    )}" stroke="url(#gtf-rim-${pal.key})" stroke-width=".8" stroke-opacity=".6"/><path d="M${cx + 24} 66C${cx + 38} 54 ${cx + 54} 50 ${cx + 66} 56C${cx + 54} 60 ${cx + 44} 70 ${cx + 38} 84Z" fill="${shadeHex(
      pal.deep,
      0.2
    )}" stroke="url(#gtf-rim-${pal.key})" stroke-width=".8" stroke-opacity=".6"/>`;
  }
  fig += `</g>`;

  // 构图姿态：胸像 / 广角 / 特写 / 偏置（让 47 张战士牌的构图明显不同）
  const pose = ctx.heroSubject ? 0 : irange(rng, 0, 3);
  let figWrap = "";
  if (pose === 0) {
    figWrap = `<g transform="translate(120 ${202}) scale(${n(range(rng, 1.06, 1.16))}) translate(-120 -202)">${fig}</g>`;
  } else if (pose === 1) {
    figWrap = `<g transform="translate(${n(120 + range(rng, -34, 34))} 186) scale(${n(
      range(rng, 0.72, 0.86)
    )}) translate(-120 -202)">${fig}</g>`;
  } else if (pose === 2) {
    // 半身特写：以底部为锚放大后再整体下移，让头盔/面部落在可见插画区
    const cs = range(rng, 1.2, 1.34);
    figWrap = `<g transform="translate(${n(range(rng, -14, 14))} ${n(
      range(rng, 16, 28)
    )}) translate(120 202) scale(${n(cs)}) translate(-120 -202)">${fig}</g>`;
  } else {
    figWrap = `<g transform="translate(${n(120 + (rng() < 0.5 ? -1 : 1) * range(rng, 34, 50))} ${
      202
    }) scale(${n(range(rng, 1, 1.12))}) translate(-120 -202)">${fig}</g>`;
  }
  out += figWrap;
  if (shield) {
    out += roundShield(ctx, {
      x: rng() < 0.5 ? 36 : 204,
      y: range(rng, 172, 188),
      r: range(rng, 17, 23),
    });
  }
  out += emberGlow(ctx, { count: 2, sparks: 6 });
  let result = `<g transform="translate(${n(shift)} 0)">${out}</g>`;
  if (flip) result = `<g transform="translate(240 0) scale(-1 1)">${result}</g>`;
  if (Math.abs(tilt) > 0.5) {
    result = `<g transform="rotate(${n(tilt)} 120 132)">${result}</g>`;
  }
  return result;
}

/* ---- 野兽 ---------------------------------------------------------------- */
function paintBeast(ctx) {
  const { rng, pal } = ctx;
  const bear = rng() < 0.3;
  const cx = 120 + range(rng, -6, 6);
  let out = moonScene(ctx, {
    x: range(rng, 46, 194),
    y: range(rng, 40, 72),
    r: range(rng, 20, 32),
  });
  out += `<path d="${ridgePath(rng, 158, 14, 30)}" fill="#050403" opacity=".7"/>`;
  out += fogWisps(ctx, { count: 2, y: 150 });

  let fig = `<g transform="translate(${cx} 0)">`;
  // 胸 / 颈鬃毛
  fig += subject(
    ctx,
    `M-58 198C-56 166 -44 144 -26 134L-16 124L16 124L26 134C44 144 56 166 58 198Z`,
    { fill: "#070504", rim: 0.5 }
  );
  // 鬃毛尖刺
  let fur = "";
  for (let i = 0; i < 11; i += 1) {
    const t = i / 10;
    const x = lerp(-58, 58, t);
    const y = 198 - Math.sin(t * Math.PI) * 46;
    fur += `M${n(x)} ${n(y)}l${n(range(rng, -5, 5))} ${n(-range(rng, 7, 16))}`;
  }
  fig += `<path d="${fur}" stroke="#070504" stroke-width="3.6" fill="none" stroke-linecap="round"/>`;
  // 耳朵
  if (bear) {
    fig += subject(ctx, `M-40 58C-48 36 -30 26 -18 46Z`, { fill: "#090706", width: 1.2, rim: 0.8 });
    fig += subject(ctx, `M40 58C48 36 30 26 18 46Z`, { fill: "#090706", width: 1.2, rim: 0.8 });
    fig += `<path d="M-34 52C-30 42 -24 42 -20 48Z" fill="${rgba(pal.glow, 0.18)}"/>`;
    fig += `<path d="M34 52C30 42 24 42 20 48Z" fill="${rgba(pal.glow, 0.18)}"/>`;
  } else {
    fig += subject(ctx, `M-36 62L-52 18L-12 50Z`, { fill: "#080605", width: 1.3, rim: 0.9 });
    fig += subject(ctx, `M36 62L52 18L12 50Z`, { fill: "#080605", width: 1.3, rim: 0.9 });
    fig += `<path d="M-36 56L-45 28L-21 50Z" fill="${rgba(pal.glow, 0.16)}"/>`;
    fig += `<path d="M36 56L45 28L21 50Z" fill="${rgba(pal.glow, 0.16)}"/>`;
  }
  // 头部
  fig += subject(
    ctx,
    `M0 46C-25 46 -42 62 -44 88C-46 106 -36 121 -24 130L-18 152C-10 160 10 160 18 152L24 130C36 121 46 106 44 88C42 62 25 46 0 46Z`,
    { fill: "#090706", width: 1.5, rim: 0.95 }
  );
  // 脸颊毛尖
  fig += `<path d="M-44 88L-60 94L-45 102L-57 112L-40 114M44 88L60 94L45 102L57 112L40 114" fill="#090706" stroke="url(#gtf-rim-${
    pal.key
  })" stroke-width=".6" stroke-opacity=".5"/>`;
  // 额顶毛
  fig += `<path d="M-6 47L0 34L6 47M-16 50L-12 37L-2 46M16 50L12 37L2 46" fill="#090706"/>`;
  // 眼窝 + 眼睛
  fig += `<path d="M-34 84C-24 78 -8 78 -4 86C-12 93 -26 94 -34 84ZM34 84C24 78 8 78 4 86C12 93 26 94 34 84Z" fill="#030202"/>`;
  fig += glowEyes(ctx, [[-19, 85, 1.02], [19, 85, 1.02]], { color: shadeHex(pal.glow, 0.3) });
  // 吻部
  fig += `<path d="M-20 108C-12 102 12 102 20 108C15 128 -15 128 -20 108Z" fill="#060504" stroke="url(#gtf-rim-${
    pal.key
  })" stroke-width=".7" stroke-opacity=".5"/>`;
  fig += `<path d="M0 106L-7 116H7Z" fill="#030202"/>`;
  fig += `<path d="M-13 121C-8 126 8 126 13 121" fill="none" stroke="${rgba(pal.glow, 0.3)}" stroke-width="1"/>`;
  // 獠牙
  fig += `<path d="M-12 118l-2.4 9 4.4-2.4Z" fill="#e7dcc2" opacity=".8"/><path d="M12 118l2.4 9-4.4-2.4Z" fill="#e7dcc2" opacity=".8"/>`;
  fig += `<path d="M-6 123l-.8 5 2-1.2Z" fill="#d9cbb3" opacity=".6"/><path d="M6 123l.8 5-2-1.2Z" fill="#d9cbb3" opacity=".6"/>`;
  // 面部纹路
  fig += contour(
    ctx,
    `M-40 78C-30 68 -18 64 0 64M40 78C30 68 18 64 0 64M-28 104C-24 98 -20 94 -16 92M28 104C24 98 20 94 16 92`,
    { opacity: 0.3, width: 0.8 }
  );
  // 额头印记
  fig += `<path d="M0 60l-4 8h8Z" fill="none" stroke="url(#gtf-gold)" stroke-width=".8" opacity=".5"/>`;
  fig += `</g>`;
  out += subjectScale(fig, range(rng, 0.98, 1.08), 120, 200);
  // 爪痕
  out += `<g fill="none" stroke="${rgba(pal.glow, 0.2)}" stroke-linecap="round">
    <path d="M186 34C198 62 198 96 188 126" stroke-width="1.5"/>
    <path d="M202 48C212 74 212 104 204 130" stroke-width="1.1"/>
    <path d="M218 64C226 86 226 108 220 128" stroke-width=".8"/>
  </g>`;
  out += dustField(rng, { count: 16, color: shadeHex(pal.accent, 0.2) });
  return out;
}

/* ---- 怪物 ---------------------------------------------------------------- */
function paintMonster(ctx) {
  const { rng, pal } = ctx;
  const cx = 120 + range(rng, -4, 4);
  let out = moonScene(ctx, {
    eclipse: rng() < 0.5,
    x: range(rng, 44, 82),
    y: range(rng, 38, 74),
    r: range(rng, 18, 28),
  });
  // 背景爪痕
  out += `<g fill="${rgba(pal.core, 0.2)}" opacity=".9">
    <path d="M16 20C42 46 52 84 40 132C56 100 54 56 32 12Z"/>
    <path d="M42 12C66 40 76 80 62 136C80 102 78 54 58 6Z"/>
    <path d="M202 28C182 56 174 94 184 140C168 106 170 62 190 20Z"/>
  </g>`;
  // 巨角（每侧三叉）
  const antler = `<g fill="#090705" stroke="url(#gtf-rim-${pal.key})" stroke-width="1" stroke-opacity=".65">
    <path d="M134 84C152 64 176 44 206 26L211 36C180 54 158 74 144 94Z"/>
    <path d="M160 62C178 44 196 32 218 24L216 32C196 42 180 52 166 68Z"/>
    <path d="M150 74L166 58L163 68L152 82Z"/>
    <path d="M180 44L198 30L194 42L184 52Z"/>
    <path d="M168 44L176 18L181 22L174 50Z"/>
    <path d="M200 30L216 14L213 24L205 34Z"/>
    <path d="M138 88L150 100L142 104L132 94Z"/>
  </g>`;
  out += antler;
  out += `<g transform="translate(240 0) scale(-1 1)">${antler}</g>`;

  let fig = `<g transform="translate(${cx} 0)">`;
  // 佝偻躯干
  fig += subject(
    ctx,
    `M-74 200C-70 160 -52 138 -28 130L28 130C52 138 70 160 74 200Z`,
    { fill: "#060404", rim: 0.45 }
  );
  // 肩部骨刺
  [-1, 1].forEach((sd) => {
    fig += `<path d="M${sd * 52} 142C${sd * 72} 122 ${sd * 78} 100 ${sd * 72} 80C${sd * 62} 104 ${
      sd * 50
    } 122 ${sd * 32} 134Z" fill="#080605" stroke="url(#gtf-rim-${pal.key})" stroke-width=".8" stroke-opacity=".55"/>`;
  });
  // 头颅（长吻、棱角）
  fig += subject(
    ctx,
    `M0 46C-30 46 -50 68 -52 98C-53 116 -44 132 -30 142L-30 154C-22 164 22 164 30 154L30 142C44 132 53 116 52 98C50 68 30 46 0 46Z`,
    { fill: "#090706", width: 1.6, rim: 1 }
  );
  // 颧骨 / 眉弓
  fig += `<path d="M-52 92L-64 100L-46 106L-58 118L-38 118M52 92L64 100L46 106L58 118L38 118" fill="#080605" stroke="url(#gtf-rim-${
    pal.key
  })" stroke-width=".7" stroke-opacity=".55"/>`;
  fig += `<path d="M-46 88C-30 76 -10 74 0 80C10 74 30 76 46 88L40 98C28 90 14 88 0 92C-14 88 -28 90 -40 98Z" fill="#040303"/>`;
  // 眼窝
  fig += `<path d="M-44 100L-16 94L-20 112L-40 112ZM44 100L16 94L20 112L40 112Z" fill="#020202"/>`;
  fig += glowEyes(ctx, [[-30, 104, 1.25], [30, 104, 1.25]], { color: shadeHex(pal.glow, 0.32) });
  fig += glowEyes(ctx, [[-20, 118, 0.5], [20, 118, 0.5]], { r: 1.5 });
  // 鼻孔
  fig += `<path d="M0 116L-9 132H9Z" fill="#030202"/>`;
  // 血盆大口 + 长下颌
  fig += `<path d="M-34 138C-24 150 -10 156 0 156C10 156 24 150 34 138C30 168 18 186 0 194C-18 186 -30 168 -34 138Z" fill="#030202" stroke="url(#gtf-rim-${
    pal.key
  })" stroke-width="1" stroke-opacity=".7"/>`;
  // 上颚獠牙
  let teeth = "";
  for (let i = 0; i < 6; i += 1) {
    const t = i / 5;
    const x = lerp(-27, 27, t);
    const y = 147 + Math.abs(t - 0.5) * 15;
    const len = range(rng, 7, 14) * (i === 1 || i === 4 ? 1.35 : 1);
    teeth += `<path d="M${n(x - 3)} ${n(y)}L${n(x + 3)} ${n(y)}L${n(x)} ${n(y + len)}Z" fill="#d9cbb3" opacity=".7"/>`;
  }
  // 下颚獠牙
  for (let i = 0; i < 5; i += 1) {
    const x = lerp(-20, 20, i / 4);
    const y = 168 + Math.abs(i / 4 - 0.5) * 12;
    teeth += `<path d="M${n(x - 2.4)} ${n(y + 8)}L${n(x + 2.4)} ${n(y + 8)}L${n(x)} ${n(y)}Z" fill="#c9bda3" opacity=".5"/>`;
  }
  fig += teeth;
  fig += `<path d="M-24 164C-10 174 10 174 24 164" fill="none" stroke="${rgba(pal.glow, 0.18)}" stroke-width="1"/>`;
  // 额头符文 / 裂纹
  fig += `<path d="M0 66V80M-7 70L7 76M-6 78L6 72" fill="none" stroke="url(#gtf-gold)" stroke-width="1.2" opacity=".65"/>`;
  fig += `<path d="M-36 118L-26 124M38 112L28 122M-14 52L-8 64M18 50L12 62" fill="none" stroke="${rgba(
    pal.glow,
    0.25
  )}" stroke-width=".8"/>`;
  // 侧颈触须
  fig += `<path d="M-52 130C-72 140 -84 160 -78 184M52 126C72 138 84 158 78 186M-42 148C-58 166 -62 184 -56 202M42 148C58 166 62 184 56 202" fill="none" stroke="#070504" stroke-width="6" stroke-linecap="round"/>`;
  fig += `</g>`;
  out += subjectScale(fig, 1.04, 120, 200);
  out += emberGlow(ctx, { count: 3, sparks: 14 });
  out += fogWisps(ctx, { count: 2, y: 156 });
  return out;
}


/* ---- 法师 ---------------------------------------------------------------- */
function paintMage(ctx) {
  const { rng, pal } = ctx;
  let out = moonScene(ctx, { x: range(rng, 52, 96), y: range(rng, 38, 66), r: range(rng, 16, 24) });
  out += runeRing(ctx, { opacity: 0.38, r: range(rng, 78, 88), cy: 100 });
  out += fogWisps(ctx, { count: 2, y: 150 });
  // 法杖
  const staffX = range(rng, 168, 186);
  out += `<g class="gt-art__staff">
    <path d="M${n(staffX)} 44V196" stroke="#0a0806" stroke-width="4"/>
    <path d="M${n(staffX)} 44V196" stroke="url(#gtf-gold)" stroke-width=".9" opacity=".45"/>
    <path d="M${n(staffX - 10)} 46C${n(staffX - 12)} 34 ${n(staffX - 4)} 26 ${n(
    staffX
  )} 26C${n(staffX + 4)} 26 ${n(staffX + 12)} 34 ${n(staffX + 10)} 46" fill="none" stroke="url(#gtf-gold)" stroke-width="1.6" opacity=".8"/>
    ${glowCircle(staffX, 30, 28, "url(#gtf-bokeh)", 0.55)}
    ${glowCircle(staffX, 30, 15, `url(#gtf-glow-${pal.key})`, 0.9)}
    <circle cx="${n(staffX)}" cy="30" r="6" fill="${shadeHex(pal.glow, 0.35)}" opacity=".95"/>
    <circle cx="${n(staffX)}" cy="30" r="2.6" fill="#fff6dd"/>
  </g>`;
  // 法师本体（兜帽 + 长袍）
  out += `<g transform="translate(0 0)">`;
  out += subject(
    ctx,
    `M112 92C98 98 88 112 84 130C80 148 72 164 60 196L176 196C166 170 156 148 154 126C152 108 142 96 130 92Z`,
    { fill: "#0a0807", width: 1.3, rim: 0.6 }
  );
  // 手臂伸向法杖
  out += subject(
    ctx,
    `M140 118C152 114 164 108 ${staffX - 4} 96L${staffX + 2} 106C${staffX - 14} 120 ${152} 128 140 132Z`,
    { fill: "#0c0907" }
  );
  // 手
  out += `<ellipse cx="${n(staffX - 6)}" cy="102" rx="4.6" ry="5.6" fill="#0b0806"/>`;
  // 兜帽
  out += subject(
    ctx,
    `M120 40C104 40 92 54 92 72C92 84 97 94 105 100L105 108C112 114 128 114 135 108L135 100C143 94 148 84 148 72C148 54 136 40 120 40Z`,
    { fill: "#0b0807", width: 1.3, rim: 0.7 }
  );
  // 兜帽阴影
  out += `<path d="M104 70C104 84 111 94 120 100C129 94 136 84 136 70C136 62 130 56 120 56C110 56 104 62 104 70Z" fill="#030202"/>`;
  out += glowEyes(ctx, [[112, 74, 0.9], [128, 74, 0.9]], { color: shadeHex(pal.glow, 0.3) });
  // 袍褶
  out += `<path d="M96 150C104 162 108 178 106 196M120 146V196M144 150C136 162 132 178 134 196M104 132C98 146 92 158 86 172" fill="none" stroke="url(#gtf-rim-${pal.key})" stroke-width=".7" opacity=".45"/>`;
  // 胸前符文吊坠
  out += `<circle cx="120" cy="136" r="4.2" fill="none" stroke="url(#gtf-gold)" stroke-width=".9" opacity=".8"/><circle cx="120" cy="136" r="1.4" fill="url(#gtf-gold)" opacity=".9"/>`;
  out += `</g>`;
  // 漂浮符文 / 光尘
  for (let i = 0; i < 7; i += 1) {
    const x = range(rng, 46, 200);
    const y = range(rng, 54, 150);
    const g = RUNE_GLYPHS[irange(rng, 0, RUNE_GLYPHS.length - 1)];
    out += `<g transform="translate(${n(x)} ${n(y)}) rotate(${n(range(rng, -30, 30))}) scale(${n(
      range(rng, 0.32, 0.55)
    )})"><path d="${g}" fill="none" stroke="url(#gtf-gold)" stroke-width="1.4" opacity="${n(
      range(rng, 0.25, 0.6)
    )}"/></g>`;
  }
  out += dustField(rng, { count: 26, color: shadeHex(pal.glow, 0.2) });
  return out;
}

/* ---- 精灵 ---------------------------------------------------------------- */
function paintElf(ctx) {
  const { rng, pal } = ctx;
  const cx = 120;
  let out = moonScene(ctx, { x: range(rng, 158, 196), y: range(rng, 36, 62), r: range(rng, 18, 27) });
  out += `<path d="${ridgePath(rng, 156, 12, 32)}" fill="#050403" opacity=".65"/>`;
  // 弓
  out += `<g class="gt-art__bow">
    <path d="M64 28C40 64 40 144 64 182" fill="none" stroke="#0a0806" stroke-width="4.4" stroke-linecap="round"/>
    <path d="M64 28C42 62 42 146 64 182" fill="none" stroke="url(#gtf-gold)" stroke-width=".9" opacity=".5"/>
    <path d="M64 28L104 104L64 182" fill="none" stroke="${rgba(pal.glow, 0.55)}" stroke-width=".8"/>
    <path d="M28 104H108" stroke="#0a0806" stroke-width="2.6"/>
    <path d="M28 104H108" stroke="${rgba(pal.glow, 0.55)}" stroke-width=".7"/>
    <path d="M106 104l-12-4.6v9.2Z" fill="${shadeHex(pal.glow, 0.3)}" opacity=".9"/>
    <path d="M28 104l14-3.4v6.8Z" fill="url(#gtf-gold)" opacity=".85"/>
    <path d="M28 104l-6-4M28 104l-6 4" stroke="url(#gtf-gold)" stroke-width="1" fill="none" opacity=".7"/>
  </g>`;
  // 精灵本体
  out += `<g transform="translate(${cx} 0)">`;
  // 长发披风
  out += subject(
    ctx,
    `M-18 96C-34 108 -42 128 -44 150C-46 168 -52 182 -58 196L72 196C58 176 48 158 46 138C44 118 34 102 20 96Z`,
    { fill: "#080605", width: 1.1, rim: 0.5 }
  );
  // 兜帽与头
  out += subject(
    ctx,
    `M8 40C-6 40 -16 52 -16 66C-16 76 -12 84 -6 90L18 90C24 84 28 76 28 66C28 52 22 40 8 40Z`,
    { fill: "#0b0807", width: 1.2, rim: 0.65 }
  );
  out += `<path d="M8 40C10 30 18 24 28 26C20 30 16 36 14 44Z" fill="#0b0807" stroke="url(#gtf-rim-${pal.key})" stroke-width=".6" stroke-opacity=".4"/>`;
  out += `<path d="M-10 62C-10 76 -4 86 6 92C16 86 22 76 22 62C22 54 16 48 6 48C-4 48 -10 54 -10 62Z" fill="#030202"/>`;
  out += glowEyes(ctx, [[-1, 64, 0.8], [14, 64, 0.8]], { color: shadeHex(pal.glow, 0.32) });
  // 拉弓的手臂
  out += subject(ctx, `M-10 112C-24 110 -36 108 -46 104L-48 114C-36 120 -22 124 -8 124Z`, {
    fill: "#0c0907",
    rim: 0.4,
  });
  // 箭
  out += `<path d="M-52 104H-14" stroke="#0a0806" stroke-width="2" opacity=".9"/>`;
  // 箭袋
  out += `<path d="M32 112L48 96L58 106L44 126Z" fill="#0b0807" stroke="url(#gtf-gold)" stroke-width=".6" stroke-opacity=".5"/>`;
  out += `<path d="M40 98L34 82M45 97L42 80M50 96L50 78" stroke="#0a0806" stroke-width="1.4"/>`;
  // 斗篷翻边
  out += `<path d="M-18 96C-4 108 4 118 6 132M20 96C30 110 36 124 38 140" fill="none" stroke="url(#gtf-gold)" stroke-width=".6" opacity=".35"/>`;
  out += `</g>`;
  // 叶片装饰
  for (let i = 0; i < 6; i += 1) {
    const x = range(rng, 30, 210);
    const y = range(rng, 50, 160);
    const s = range(rng, 0.3, 0.7);
    out += `<g transform="translate(${n(x)} ${n(y)}) rotate(${n(range(rng, -60, 60))}) scale(${n(
      s
    )})"><path d="M0-12C8-6 12 2 10 12C2 8 -2 0 0-12Z" fill="none" stroke="${rgba(
      pal.glow,
      0.4
    )}" stroke-width=".9"/><path d="M0-10V8" stroke="${rgba(pal.glow, 0.35)}" stroke-width=".5"/></g>`;
  }
  out += dustField(rng, { count: 22, color: shadeHex(pal.glow, 0.25) });
  return out;
}

/* ---- 矮人 ---------------------------------------------------------------- */
function paintDwarf(ctx) {
  const { rng, pal } = ctx;
  let out = moonScene(ctx, { x: range(rng, 60, 180), y: range(rng, 40, 72), r: range(rng, 16, 24) });
  // 双刃巨斧
  out += `<g class="gt-art__axe">
    <path d="M48 200L154 40" stroke="#090705" stroke-width="6"/>
    <path d="M48 200L154 40" stroke="url(#gtf-gold)" stroke-width="1" opacity=".38"/>
    <path d="M152 38C172 14 202 12 218 30C196 32 176 44 164 60C158 52 154 44 152 38Z"
      fill="#0b0908" stroke="url(#gtf-rim-${pal.key})" stroke-width="1" stroke-opacity=".7"/>
    <path d="M152 38C132 14 102 12 86 30C108 32 128 44 140 60C146 52 150 44 152 38Z"
      fill="#0b0908" stroke="url(#gtf-rim-${pal.key})" stroke-width="1" stroke-opacity=".7"/>
    <path d="M214 28C220 34 220 44 214 50C202 40 192 32 182 26C192 24 204 24 214 28Z" fill="url(#gtf-gold)" opacity=".55"/>
    <path d="M90 28C84 34 84 44 90 50C102 40 112 32 122 26C112 24 100 24 90 28Z" fill="url(#gtf-gold)" opacity=".5"/>
    <path d="M148 34L160 46" stroke="url(#gtf-gold)" stroke-width="3" opacity=".8"/>
  </g>`;
  out += `<g transform="translate(0 0)">`;
  // 披风
  out += subject(
    ctx,
    `M58 196C60 164 72 142 92 132L148 132C168 142 180 164 182 196Z`,
    { fill: "#080605", width: 1.1, rim: 0.45 }
  );
  // 身体
  out += subject(
    ctx,
    `M70 196C72 168 82 148 96 140L144 140C158 148 168 168 170 196Z`,
    { fill: "#0d0a07", width: 1.1, rim: 0.55 }
  );
  // 皮甲束带
  out += `<path d="M94 150H146M100 166H160M92 180H168" stroke="url(#gtf-gold)" stroke-width=".7" opacity=".4"/>`;
  out += `<circle cx="120" cy="168" r="8" fill="none" stroke="url(#gtf-gold)" stroke-width="1.1" opacity=".65"/>`;
  // 头盔
  out += subject(
    ctx,
    `M92 92C92 74 104 60 120 60C136 60 148 74 148 92L146 100H94Z`,
    { fill: "#0f0b08", width: 1.3, rim: 0.8 }
  );
  // 盔角
  out += subject(ctx, `M94 88C84 82 74 86 70 96C80 94 88 98 92 106Z`, { fill: "#0c0907", width: 1 });
  out += subject(ctx, `M146 88C156 82 166 86 170 96C160 94 152 98 148 106Z`, { fill: "#0c0907", width: 1 });
  out += `<path d="M120 62V100M106 92H134" fill="none" stroke="url(#gtf-gold)" stroke-width=".8" opacity=".45"/>`;
  // 脸部
  out += `<path d="M98 98C98 110 106 120 120 124C134 120 142 110 142 98Z" fill="#0b0806"/>`;
  out += glowEyes(ctx, [[110, 104, 0.6], [130, 104, 0.6]], { r: 1.7 });
  out += `<path d="M116 108L120 114L124 108" fill="none" stroke="${rgba(pal.glow, 0.3)}" stroke-width="1.2"/>`;
  // 大胡子
  out += `<path d="M96 116C98 142 106 166 120 182C134 166 142 142 144 116C134 128 106 128 96 116Z" fill="${shadeHex(
    pal.deep,
    0.14
  )}" stroke="url(#gtf-rim-${pal.key})" stroke-width=".7" stroke-opacity=".45"/>`;
  out += `<path d="M106 124C108 144 112 162 120 174M134 124C132 144 128 162 120 174M114 122C114 140 116 156 120 168M126 122C126 140 124 156 120 168" fill="none" stroke="${rgba(
    pal.glow,
    0.18
  )}" stroke-width=".7"/>`;
  // 胡须铜环
  out += `<circle cx="109" cy="156" r="2.4" fill="none" stroke="url(#gtf-gold)" stroke-width=".7" opacity=".7"/>
           <circle cx="131" cy="156" r="2.4" fill="none" stroke="url(#gtf-gold)" stroke-width=".7" opacity=".7"/>`;
  out += `</g>`;
  out += roundShield(ctx, { x: 184, y: 152, r: 25 });
  out += emberGlow(ctx, { count: 2, sparks: 8 });
  return out;
}

/* ---- 吸血鬼 -------------------------------------------------------------- */
function paintVampire(ctx) {
  const { rng, pal } = ctx;
  const mx = range(rng, 150, 190);
  const my = range(rng, 40, 62);
  let out = "" + glowCircle(mx, my, 82, "url(#gtf-ember-mo)", 0.55);
  out += `<circle cx="${n(mx)}" cy="${n(my)}" r="${n(range(rng, 20, 28))}" fill="${rgba(
    pal.glow,
    0.28
  )}"/>`;
  out += `<circle cx="${n(mx)}" cy="${n(my)}" r="${n(range(rng, 20, 28))}" fill="none" stroke="${rgba(
    pal.glow,
    0.4
  )}" stroke-width=".9"/>`;
  // 双翼
  const wing = `<path d="M146 112C166 86 194 60 228 46C214 68 210 88 216 108C204 98 192 98 184 102C192 114 194 128 190 142C180 128 166 122 154 124L152 148C146 136 144 124 146 112Z" fill="#080605" stroke="url(#gtf-rim-${pal.key})" stroke-width=".8" stroke-opacity=".5"/>`;
  out += wing;
  out += `<g transform="translate(240 0) scale(-1 1)">${wing}</g>`;
  out += `<path d="M152 120C170 106 190 88 214 72M150 132C168 122 184 112 204 100M174 108C182 116 186 128 186 140" fill="none" stroke="${rgba(
    pal.glow,
    0.22
  )}" stroke-width=".8"/>`;
  // 本体
  out += `<g>`;
  out += subject(
    ctx,
    `M120 84C108 84 102 96 102 110C102 124 96 142 90 160C86 174 82 184 78 196L162 196C158 184 154 174 150 160C144 142 138 124 138 110C138 96 132 84 120 84Z`,
    { fill: "#070504", width: 1.1, rim: 0.5 }
  );
  // 立领
  out += `<path d="M120 96L96 82L106 118L120 104L134 118L144 82L120 96Z" fill="#0a0807" stroke="url(#gtf-rim-${pal.key})" stroke-width=".7" stroke-opacity=".5"/>`;
  // 头
  out += subject(
    ctx,
    `M120 52C109 52 101 61 101 73C101 85 109 94 120 98C131 94 139 85 139 73C139 61 131 52 120 52Z`,
    { fill: "#0b0807", width: 1.2, rim: 0.7 }
  );
  // 苍白面部
  out += `<path d="M120 58C112 58 107 65 107 73C107 81 113 88 120 91C127 88 133 81 133 73C133 65 128 58 120 58Z" fill="${rgba(
    "#d9cbb3",
    0.16
  )}"/>`;
  out += glowEyes(ctx, [[112, 70, 0.72], [128, 70, 0.72]], { color: "#ff6b5a", r: 1.9 });
  // 獠牙
  out += `<path d="M114 82l-1.6 6 3.4-1.6Z" fill="#f6efdd" opacity=".9"/><path d="M126 82l1.6 6-3.4-1.6Z" fill="#f6efdd" opacity=".9"/>`;
  // 胸前血坠
  out += `<path d="M120 116l4 7-4 12-4-12Z" fill="${pal.glow}" opacity=".55"/>`;
  out += `<path d="M120 120l2.4 4-2.4 6-2.4-6Z" fill="#ffd9cd" opacity=".5"/>`;
  out += `</g>`;
  // 蝙蝠
  const bat = (x, y, s) =>
    `<g transform="translate(${n(x)} ${n(y)}) scale(${n(s)})" fill="#080605"><path d="M0 0C-5-5-13-4-16 2C-10 0-6 3-4 8C-2 4 2 4 4 8C6 3 10 0 16 2C13-4 5-5 0 0Z" stroke="${rgba(
      pal.glow,
      0.28
    )}" stroke-width=".6"/></g>`;
  for (let i = 0; i < 4; i += 1) {
    out += bat(range(rng, 24, 214), range(rng, 30, 120), range(rng, 0.45, 0.9));
  }
  out += fogWisps(ctx, { count: 2, y: 160 });
  out += dustField(rng, { count: 16, color: "rgba(255,120,100,1)" });
  return out;
}

/* ---- 女巫 ---------------------------------------------------------------- */
function paintWitch(ctx) {
  const { rng, pal } = ctx;
  let out = moonScene(ctx, { eclipse: rng() < 0.4, x: range(rng, 52, 92), y: range(rng, 34, 60), r: range(rng, 16, 24) });
  out += runeRing(ctx, { opacity: 0.3, r: 82, cy: 100, count: 14 });
  out += fogWisps(ctx, { count: 2, y: 156 });
  // 法杖
  out += `<path d="M60 54V196M60 62C52 58 48 50 50 42C56 46 60 50 60 56" fill="none" stroke="#0a0806" stroke-width="3.6"/>`;
  out += `<path d="M60 54l-4-10 7 3 1 9" fill="none" stroke="url(#gtf-gold)" stroke-width="1" opacity=".65"/>`;
  out += glowCircle(60, 52, 20, `url(#gtf-glow-${pal.key})`, 0.6);
  out += `<circle cx="60" cy="51" r="3.4" fill="${shadeHex(pal.glow, 0.3)}" opacity=".9"/>`;
  // 坩埚
  const px = 168;
  const py = 156;
  out += `<g class="gt-art__cauldron">
    ${glowCircle(px, py - 20, 46, `url(#gtf-glow-${pal.key})`, 0.5)}
    <path d="M${px - 32} ${py}C${px - 30} ${py + 26} ${px - 18} ${py + 38} ${px} ${py + 38}C${
    px + 18
  } ${py + 38} ${px + 30} ${py + 26} ${px + 32} ${py}Z" fill="#0a0807" stroke="url(#gtf-gold)" stroke-width=".8" stroke-opacity=".5"/>
    <ellipse cx="${px}" cy="${py}" rx="33" ry="9" fill="#050403" stroke="url(#gtf-gold)" stroke-width=".9" stroke-opacity=".65"/>
    <ellipse cx="${px}" cy="${py}" rx="27" ry="6" fill="${rgba(pal.glow, 0.22)}"/>
    <path d="M${px - 24} ${py + 36}l-4 8M${px + 24} ${py + 36}l4 8M${px} ${py + 40}v8" stroke="#0a0806" stroke-width="3"/>
    <path d="M${px - 18} ${py + 8}C${px - 22} ${py - 14} ${px - 10} ${py - 22} ${px - 14} ${py - 40}C${
    px - 2
  } ${py - 24} ${px - 4} ${py - 10} ${px - 6} ${py + 4}C${px + 4} ${py - 16} ${px + 12} ${py - 26} ${
    px + 8
  } ${py - 44}C${px + 22} ${py - 26} ${px + 16} ${py - 8} ${px + 12} ${py + 6}C${px + 20} ${py - 10} ${
    px + 28
  } ${py - 18} ${px + 26} ${py - 34}C${px + 36} ${py - 18} ${px + 28} ${py - 2} ${px + 22} ${py + 6}Z" fill="url(#gtf-fire)" opacity=".55"/>
    <circle cx="${px - 8}" cy="${py - 22}" r="2.2" fill="#ffe9a8" opacity=".5"/>
    <circle cx="${px + 10}" cy="${py - 34}" r="1.6" fill="#ffe9a8" opacity=".4"/>
  </g>`;
  // 女巫本体（佝偻、钩鼻）
  out += `<g>`;
  out += subject(
    ctx,
    `M124 48C110 48 98 60 94 76C91 88 94 98 100 106C92 116 90 130 94 142C86 154 80 172 74 196L158 196C158 176 152 158 150 142C154 128 150 112 142 100C136 90 134 78 134 66C134 56 130 50 124 48Z`,
    { fill: "#080605", width: 1.2, rim: 0.55 }
  );
  // 兜帽阴影 + 侧脸
  out += `<path d="M104 72C100 84 104 96 112 102C108 88 110 78 118 74C126 70 134 76 136 86C141 82 143 72 138 64C130 54 112 58 104 72Z" fill="#030202"/>`;
  out += `<path d="M104 78L92 84L104 88Z" fill="#0b0807"/>`;
  out += glowEyes(ctx, [[112, 80, 0.7]], { color: shadeHex(pal.glow, 0.3), r: 1.8 });
  // 爪手
  out += `<path d="M100 130C88 132 78 138 72 146L78 154C86 146 94 142 104 140Z" fill="#0b0807"/>`;
  out += `<path d="M74 146l-6 6M78 148l-5 8M82 150l-4 9" stroke="#0b0807" stroke-width="1.6" stroke-linecap="round"/>`;
  // 长袍补丁 / 挂饰
  out += `<path d="M112 118C110 138 112 160 116 182M134 116C138 138 138 160 136 182" fill="none" stroke="${rgba(
    pal.glow,
    0.18
  )}" stroke-width=".7"/>`;
  out += `<circle cx="130" cy="150" r="3" fill="none" stroke="url(#gtf-gold)" stroke-width=".7" opacity=".6"/>`;
  out += `</g>`;
  // 蜡烛
  [38, 212].forEach((x, i) => {
    const y = i === 0 ? 180 : 172;
    out += `<g><rect x="${x - 3}" y="${y}" width="6" height="16" fill="#d9cbb3" opacity=".5"/><path d="M${x} ${y - 12}C${x - 4} ${y - 6} ${x - 2} ${y - 2} ${x} ${y - 1}C${x + 2} ${y - 2} ${x + 4} ${y - 6} ${x} ${y - 12}Z" fill="#ffb347" opacity=".85"/>${glowCircle(
      x,
      y - 4,
      14,
      `url(#gtf-ember-${pal.key})`,
      0.6
    )}</g>`;
  });
  out += dustField(rng, { count: 18, color: shadeHex(pal.accent, 0.2) });
  return out;
}

/* ---- 幽灵 ---------------------------------------------------------------- */
function paintSpirit(ctx) {
  const { rng, pal } = ctx;
  let out = moonScene(ctx, { x: range(rng, 48, 190), y: range(rng, 34, 64), r: range(rng, 18, 28) });
  out += `<path d="${ridgePath(rng, 160, 16, 30)}" fill="#050403" opacity=".6"/>`;
  out += fogWisps(ctx, { count: 3, y: 140 });
  // 幽灵本体
  out += `<g>`;
  out += subject(
    ctx,
    `M120 42C106 42 96 54 96 70C96 82 102 92 110 98C100 110 96 126 98 142C90 158 82 174 74 196L166 196C158 174 150 158 142 142C144 126 140 110 130 98C138 92 144 82 144 70C144 54 134 42 120 42Z`,
    { fill: "#070504", width: 1.1, rim: 0.5, opacity: 0.94 }
  );
  // 破布流苏
  for (let i = 0; i < 5; i += 1) {
    const x = 78 + i * 20 + range(rng, -4, 4);
    const w = range(rng, 6, 12);
    const h = range(rng, 18, 34);
    out += `<path d="M${n(x)} ${196 - h}C${n(x + 3)} ${n(196 - h * 0.5)} ${n(x + 2)} ${196 - h * 0.3} ${n(
      x + w
    )} 196L${n(x + w * 0.5)} ${n(196 - h * 0.25)}L${n(x)} ${196 - h}Z" fill="#070504" opacity=".9"/>`;
  }
  // 兜帽阴影
  out += `<path d="M106 66C106 80 111 90 120 96C129 90 134 80 134 66C134 58 128 52 120 52C112 52 106 58 106 66Z" fill="#020202"/>`;
  out += glowEyes(ctx, [[113, 70, 0.85], [127, 70, 0.85]], { color: shadeHex(pal.glow, 0.3) });
  // 手臂
  out += subject(ctx, `M102 112C88 116 76 124 70 134L78 141C86 130 96 124 108 122Z`, { fill: "#0b0807", rim: 0.4 });
  out += subject(ctx, `M138 112C150 114 160 120 168 128L162 136C154 128 146 124 136 122Z`, {
    fill: "#0b0807",
    rim: 0.4,
  });
  // 灯笼
  out += `<g class="gt-art__lantern">
    <path d="M168 128V138" stroke="url(#gtf-gold)" stroke-width=".9" opacity=".7"/>
    ${glowCircle(168, 150, 30, "url(#gtf-bokeh)", 0.55)}
    <path d="M160 138H176L179 154H157Z" fill="#0a0807" stroke="url(#gtf-gold)" stroke-width=".9" stroke-opacity=".7"/>
    <rect x="162" y="141" width="12" height="10" fill="${shadeHex(pal.glow, 0.35)}" opacity=".75"/>
    <circle cx="168" cy="146" r="2.4" fill="#fff6dd"/>
    <path d="M157 154H179" stroke="url(#gtf-gold)" stroke-width="1"/>
  </g>`;
  // 灵体烟尾
  out += `<path d="M96 120C86 138 88 158 96 178M144 120C154 138 152 158 144 178" fill="none" stroke="${rgba(
    pal.glow,
    0.15
  )}" stroke-width="2.4"/>`;
  out += `</g>`;
  out += dustField(rng, { count: 24, color: shadeHex(pal.glow, 0.25) });
  return out;
}

/* ---- 攻城器械 ------------------------------------------------------------ */
function paintSiege(ctx) {
  const { rng, pal } = ctx;
  const variant = irange(rng, 0, 2);
  let out = moonScene(ctx, { x: range(rng, 42, 90), y: range(rng, 36, 62), r: range(rng, 18, 26) });
  out += distantKeep(rng, range(rng, 188, 214), 170, range(rng, 0.9, 1.4));
  out += `<path d="${ridgePath(rng, 172, 10, 34)}" fill="#050403" opacity=".7"/>`;
  const baseY = 186;
  // 城垛
  out += `<path d="M16 ${baseY}H224V196H16Z" fill="#080605"/>`;
  let cren = "";
  for (let x = 20; x < 222; x += 22) cren += `M${x} ${baseY}V${baseY - 10}H${x + 12}V${baseY}`;
  out += `<path d="${cren}" fill="#080605" stroke="${rgba(pal.glow, 0.18)}" stroke-width=".6"/>`;
  if (variant === 0) {
    // 投石机
    out += `<g class="gt-art__trebuchet">
      <path d="M66 188L120 92L174 188" fill="none" stroke="#0a0807" stroke-width="6" stroke-linejoin="round"/>
      <path d="M84 150H156M102 122H138" fill="none" stroke="#0a0807" stroke-width="3.4"/>
      <path d="M120 94L40 50" stroke="#0a0807" stroke-width="5.4" stroke-linecap="round"/>
      <path d="M120 94L180 126" stroke="#0a0807" stroke-width="5" stroke-linecap="round"/>
      <path d="M40 50C34 66 38 84 52 96" fill="none" stroke="${rgba(pal.glow, 0.5)}" stroke-width=".9" stroke-dasharray="2 5"/>
      <circle cx="52" cy="100" r="8.6" fill="#080605" stroke="url(#gtf-gold)" stroke-width=".8" stroke-opacity=".5"/>
      <rect x="168" y="120" width="26" height="24" rx="2" transform="rotate(-14 181 132)" fill="#0a0807" stroke="url(#gtf-gold)" stroke-width=".7" stroke-opacity=".5"/>
      <circle cx="120" cy="94" r="4.4" fill="url(#gtf-gold)" opacity=".8"/>
      <path d="M52 100C60 86 82 72 108 66" fill="none" stroke="${rgba(pal.glow, 0.25)}" stroke-width=".7" stroke-dasharray="1 4"/>
    </g>`;
  } else if (variant === 1) {
    // 弩炮
    out += `<g class="gt-art__ballista">
      <path d="M82 188L120 140L158 188" fill="none" stroke="#0a0807" stroke-width="5" stroke-linejoin="round"/>
      <path d="M74 142H166" stroke="#0a0807" stroke-width="4.4"/>
      <path d="M74 126C58 118 52 130 56 144M166 126C182 118 188 130 184 144" fill="none" stroke="#0a0807" stroke-width="3.4" stroke-linecap="round"/>
      <path d="M56 144C54 130 60 116 74 110M184 144C186 130 180 116 166 110" fill="none" stroke="${rgba(
        pal.glow,
        0.5
      )}" stroke-width=".9"/>
      <path d="M60 138H180" stroke="url(#gtf-gold)" stroke-width=".7" opacity=".5"/>
      <path d="M120 140L212 104" stroke="#0a0807" stroke-width="3"/>
      <path d="M212 104l-14 2 8 8Z" fill="url(#gtf-gold)" opacity=".7"/>
      <circle cx="120" cy="140" r="4" fill="url(#gtf-gold)" opacity=".8"/>
    </g>`;
  } else {
    // 攻城塔（带雉堞、斜撑与轮子）
    out += `<g class="gt-art__tower">
      <path d="M82 184V88H158V184Z" fill="#0a0807" stroke="${rgba(pal.glow, 0.22)}" stroke-width=".9"/>
      <path d="M82 88V76H94V88H104V76H116V88H126V76H138V88H146V76H158V88" fill="#0a0807" stroke="${rgba(
        pal.glow,
        0.25
      )}" stroke-width=".8"/>
      <path d="M82 112H158M82 138H158M82 162H158M96 88V184M120 88V184M144 88V184" fill="none" stroke="${rgba(
        pal.glow,
        0.16
      )}" stroke-width=".7"/>
      <path d="M64 184L82 138M176 184L158 138M64 184V196M176 184V196" fill="none" stroke="#090705" stroke-width="3.6"/>
      <circle cx="92" cy="192" r="11" fill="#080605" stroke="url(#gtf-gold)" stroke-width=".8" stroke-opacity=".55"/>
      <circle cx="148" cy="192" r="11" fill="#080605" stroke="url(#gtf-gold)" stroke-width=".8" stroke-opacity=".55"/>
      <path d="M92 185V199M85 192H99M148 185V199M141 192H155" stroke="url(#gtf-gold)" stroke-width=".6" opacity=".5"/>
      <path d="M120 76V20" stroke="#090705" stroke-width="2.8"/>
      <path d="M121 22L154 34L121 46Z" fill="${rgba(pal.core, 0.8)}" stroke="url(#gtf-gold)" stroke-width=".7" stroke-opacity=".55"/>
      ${miniSigil(pal.key, 134, 34, 17, 0.55)}
      <path d="M112 176H150" stroke="url(#gtf-gold)" stroke-width=".7" opacity=".4"/>
    </g>`;
  }
  out += emberGlow(ctx, { count: 4, sparks: 16 });
  out += `<g fill="none" stroke="${rgba(pal.glow, 0.18)}" stroke-width=".7">
    <path d="M28 170C22 154 26 138 38 128M212 166C218 150 214 134 202 124"/>
  </g>`;
  out += dustField(rng, { count: 20, color: shadeHex(pal.accent, 0.25) });
  return out;
}

/* ---- 法术 ---------------------------------------------------------------- */
function paintSpell(ctx) {
  const { rng, pal } = ctx;
  const kind = ctx.specialKind || "arcane";
  let out = moonScene(ctx, { x: range(rng, 40, 200), y: range(rng, 34, 60), r: range(rng, 14, 20) });
  out += fogWisps(ctx, { count: 2, y: 160 });
  out += runeRing(ctx, { opacity: 0.5, r: range(rng, 76, 86), cy: 104, count: 20 });
  // 中央法阵
  out += glowCircle(120, 104, 76, `url(#gtf-glow-${pal.key})`, 0.65);
  out += `<circle cx="120" cy="104" r="48" fill="#080605" opacity=".72" stroke="url(#gtf-gold)" stroke-width=".9" stroke-opacity=".55"/>`;
  out += `<circle cx="120" cy="104" r="41" fill="none" stroke="url(#gtf-gold)" stroke-width=".5" stroke-dasharray="2 6" opacity=".6"/>`;
  // 中心图形
  if (kind === "horn") {
    out += `<path d="M84 130C88 104 106 84 140 76C154 78 160 88 156 100C150 92 140 88 130 90C108 96 96 112 94 134C90 136 86 134 84 130Z" fill="none" stroke="url(#gtf-gold)" stroke-width="2.4" stroke-linejoin="round"/>`;
    out += `<path d="M84 130C90 122 96 116 104 112M140 78C134 82 128 86 122 90" fill="none" stroke="${rgba(
      pal.glow,
      0.5
    )}" stroke-width="1"/>`;
    out += glowCircle(152, 88, 18, `url(#gtf-bokeh)`, 0.6);
  } else if (kind === "scorch") {
    out += `<path d="M120 62c6 18 20 24 20 42 0 12-8 21-16 24 4-9 2-17-4-23-2 10-7 16-14 21 2-12-1-19-7-25-4 9-5 17 1 27-10-4-16-13-16-24 0-18 20-22 24-42 4 8 3 17 1 26 8-5 13-13 11-26Z" fill="url(#gtf-fire)" opacity=".9"/>`;
    out += glowCircle(120, 112, 42, "url(#gtf-ember-mo)", 0.55);
  } else if (kind === "decoy") {
    out += `<g stroke="url(#gtf-gold)" fill="none" stroke-width="1.4">
      <rect x="92" y="78" width="34" height="48" rx="2" transform="rotate(-9 109 102)"/>
      <rect x="114" y="74" width="34" height="48" rx="2" transform="rotate(8 131 98)"/>
    </g>
    <path d="M124 92l12 10-12 10" fill="none" stroke="${rgba(pal.glow, 0.6)}" stroke-width="1.6"/>
    ${miniSigil(pal.key, 109, 102, 20, 0.45)}`;
  } else if (kind === "mardroeme") {
    out += `<path d="M88 110c0-18 14-30 32-30s32 12 32 30c0 5-4 7-9 7H97c-5 0-9-2-9-7Z" fill="${rgba(
      pal.glow,
      0.35
    )}" stroke="url(#gtf-gold)" stroke-width="1.2"/>
    <path d="M108 118h24v18c0 6-5 9-12 9s-12-3-12-9Z" fill="#0b0908" stroke="url(#gtf-gold)" stroke-width="1.2"/>
    <circle cx="104" cy="100" r="3" fill="#050403" opacity=".6"/><circle cx="124" cy="94" r="2.4" fill="#050403" opacity=".6"/><circle cx="136" cy="104" r="3.4" fill="#050403" opacity=".6"/>`;
    out += glowCircle(120, 120, 44, "url(#gtf-ember-mo)", 0.4);
  } else {
    // 奥术之眼
    out += `<path d="M84 104C96 84 108 76 120 76C132 76 144 84 156 104C144 124 132 132 120 132C108 132 96 124 84 104Z" fill="none" stroke="url(#gtf-gold)" stroke-width="1.8"/>`;
    out += `<circle cx="120" cy="104" r="13" fill="url(#gtf-fire)" opacity=".55"/>`;
    out += `<circle cx="120" cy="104" r="6" fill="${shadeHex(pal.glow, 0.3)}"/>`;
    out += `<circle cx="120" cy="104" r="2.6" fill="#fff6dd"/>`;
  }
  // 环绕的符文与光点
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2 + range(rng, -0.1, 0.1);
    const r = range(rng, 58, 68);
    const x = 120 + Math.cos(a) * r;
    const y = 104 + Math.sin(a) * r;
    const g = RUNE_GLYPHS[irange(rng, 0, RUNE_GLYPHS.length - 1)];
    out += `<g transform="translate(${n(x)} ${n(y)}) rotate(${n((a * 180) / Math.PI + 90)}) scale(${n(
      range(rng, 0.45, 0.7)
    )})"><path d="${g}" fill="none" stroke="url(#gtf-gold)" stroke-width="1.2" opacity="${n(
      range(rng, 0.4, 0.8)
    )}"/></g>`;
  }
  // 漂浮的卡牌/书页
  if (rng() < 0.6) {
    out += `<g transform="translate(${range(rng, 40, 76)} ${range(rng, 60, 90)}) rotate(${range(
      rng,
      -30,
      -10
    )})"><rect x="-10" y="-14" width="20" height="28" rx="1.6" fill="${rgba("#e7dcc2", 0.14)}" stroke="url(#gtf-gold)" stroke-width=".6" stroke-opacity=".5"/><path d="M-6-8H6M-6-3H6M-6 2H6M-6 7H2" stroke="${rgba(
      "#e7dcc2",
      0.3
    )}" stroke-width=".6"/></g>`;
  }
  out += dustField(rng, { count: 26, color: "#f0d078" });
  out += emberGlow(ctx, { count: 2, sparks: 6 });
  return out;
}

/* ---- 天气 ---------------------------------------------------------------- */
function snowflake(ctx, cx, cy, r, opacity = 0.8) {
  const { pal } = ctx;
  let out = `<g stroke="${rgba(pal.glow, 0.85)}" stroke-linecap="round" fill="none" opacity="${opacity}">`;
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    out += `<path d="M${n(cx)} ${n(cy)}L${n(cx + dx * r)} ${n(cy + dy * r)}" stroke-width="1.5"/>`;
    [0.45, 0.72].forEach((t) => {
      const bx = cx + dx * r * t;
      const by = cy + dy * r * t;
      const ba = a + Math.PI / 3;
      const len = r * 0.28;
      out += `<path d="M${n(bx)} ${n(by)}L${n(bx + Math.cos(ba) * len)} ${n(
        by + Math.sin(ba) * len
      )}M${n(bx)} ${n(by)}L${n(bx + Math.cos(ba - (2 * Math.PI) / 3) * len)} ${n(
        by + Math.sin(ba - (2 * Math.PI) / 3) * len
      )}" stroke-width="1"/>`;
    });
  }
  out += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.16)}" fill="${rgba(pal.glow, 0.5)}" stroke="none"/>`;
  out += `</g>`;
  return out;
}

function paintWeather(ctx) {
  const { rng, pal } = ctx;
  const kind = ctx.weatherKind || "frost";
  let out = "";
  const tint = {
    frost: "rgba(156,196,228,",
    fog: "rgba(201,189,163,",
    rain: "rgba(130,160,180,",
    storm: "rgba(120,150,170,",
    clear: "rgba(240,208,120,",
  }[kind] || "rgba(201,189,163,";
  out += `<rect width="${ART_W}" height="${ART_H}" fill="${tint}0.07)"/>`;
  out += `<g class="gt-art__weather-scene gt-art__weather--${kind}">`;

  if (kind === "frost") {
    out += moonScene(ctx, { x: 172, y: 52, r: 20 });
    out += snowflake(ctx, 120, 100, 62, 0.85);
    out += snowflake(ctx, 66, 60, 20, 0.45);
    out += snowflake(ctx, 186, 128, 16, 0.35);
    // 冰刺
    for (let i = 0; i < 8; i += 1) {
      const x = 20 + i * 26 + range(rng, -6, 6);
      const h = range(rng, 14, 46);
      out += `<path d="M${n(x - 8)} 196L${n(x)} ${n(196 - h)}L${n(x + 8)} 196Z" fill="#0c1218" stroke="${rgba(
        pal.glow,
        0.35
      )}" stroke-width=".6"/>`;
    }
    out += `<path d="M0 188H240V210H0Z" fill="${rgba("#9cc4e4", 0.08)}"/>`;
    for (let i = 0; i < 16; i += 1) {
      out += sparkle(range(rng, 10, 230), range(rng, 20, 160), range(rng, 1, 2.6), "#dcecf7", range(rng, 0.3, 0.8));
    }
  } else if (kind === "fog") {
    out += moonScene(ctx, { eclipse: true, x: 120, y: 62, r: 26 });
    out += deadTree(rng, 44, 190, 92);
    out += deadTree(rng, 202, 194, 76);
    for (let i = 0; i < 5; i += 1) {
      const y = 92 + i * 22;
      out += `<path d="M-10 ${n(y)}C40 ${n(y - 12)} 90 ${n(y + 10)} 130 ${n(y - 2)}S220 ${n(
        y - 10
      )} 250 ${n(y + 2)}" fill="none" stroke="${rgba("#d9cbb3", 0.16)}" stroke-width="${n(
        range(rng, 8, 20)
      )}" stroke-linecap="round"/>`;
    }
    out += `<path d="M0 170H240V210H0Z" fill="${rgba("#0a0806", 0.4)}"/>`;
  } else if (kind === "rain" || kind === "storm") {
    // 乌云
    const cloud = (x, y, s) =>
      `<g transform="translate(${n(x)} ${n(y)}) scale(${n(s)})" fill="${rgba("#1a1e22", 0.85)}" stroke="${rgba(
        pal.glow,
        0.16
      )}" stroke-width=".7"><path d="M-58 8C-62-8-48-20-32-16C-30-30-10-36 2-26C16-34 34-28 36-14C52-16 60-4 54 8Z"/></g>`;
    out += cloud(48, 52, 1.1) + cloud(160, 38, 0.85) + cloud(206, 66, 0.6);
    // 雨丝
    for (let i = 0; i < 46; i += 1) {
      const x = range(rng, -10, 250);
      const y = range(rng, 60, 200);
      const len = range(rng, 8, 26);
      out += `<path d="M${n(x)} ${n(y)}l${n(len * 0.28)} ${n(len)}" stroke="${rgba(
        "#cfe0e8",
        range(rng, 0.1, 0.32)
      )}" stroke-width="${n(range(rng, 0.5, 1.1))}" stroke-linecap="round"/>`;
    }
    if (kind === "storm") {
      out += glowCircle(156, 92, 60, "url(#gtf-glow-sk)", 0.5);
      out += `<path d="M150 22L122 92H142L112 158L158 86H138L156 22Z" fill="#e8f4f8" opacity=".82"/>
        <path d="M150 22L122 92H142L112 158L158 86H138L156 22Z" fill="none" stroke="${rgba("#9adfd6", 0.5)}" stroke-width="2"/>
        <path d="M120 98L96 134M156 96L180 128" fill="none" stroke="${rgba("#cfe0e8", 0.35)}" stroke-width="1.2"/>`;
      out += `<path d="M0 182C30 168 60 176 90 184S150 174 180 182S220 176 240 184V210H0Z" fill="${rgba(
        "#0a1416",
        0.75
      )}" fill="${rgba("#0a1416", 0.75)}" stroke="${rgba("#9adfd6", 0.18)}" stroke-width=".6"/>`;
    } else {
      out += `<path d="M0 186C36 176 72 182 108 188S180 178 240 186V210H0Z" fill="${rgba("#0a0e10", 0.6)}"/>`;
      // 涟漪
      [70, 140, 190].forEach((x) => {
        out += `<ellipse cx="${x}" cy="${n(range(rng, 188, 200))}" rx="${n(range(rng, 10, 22))}" ry="2.4" fill="none" stroke="${rgba(
          "#cfe0e8",
          0.25
        )}" stroke-width=".6"/>`;
      });
    }
  } else {
    // clear weather —— 晴空
    out += glowCircle(150, 70, 130, "url(#gtf-ember-ne)", 0.7);
    out += `<circle cx="150" cy="66" r="34" fill="url(#gtf-moon)" opacity=".9"/>`;
    out += `<circle cx="150" cy="66" r="34" fill="none" stroke="#fff6dd" stroke-width=".8" opacity=".5"/>`;
    out += rayBurst(ctx, { cx: 150, cy: 66, count: 20, inner: 40, outer: 150, color: "#f0d078" });
    // 散开的云
    out += `<path d="M-10 150C30 128 76 142 96 160C70 168 30 172 -10 168Z" fill="${rgba("#e7dcc2", 0.1)}"/>`;
    out += `<path d="M250 142C210 120 160 136 140 156C170 164 210 166 250 158Z" fill="${rgba("#e7dcc2", 0.08)}"/>`;
    out += `<path d="M20 190C60 176 180 176 220 190" fill="none" stroke="${rgba(pal.accent, 0.22)}" stroke-width="1"/>`;
    // 飞鸟
    for (let i = 0; i < 5; i += 1) {
      const x = range(rng, 30, 210);
      const y = range(rng, 60, 130);
      out += `<path d="M${n(x)} ${n(y)}q4-4 8 0q4-4 8 0" fill="none" stroke="${rgba(
        "#0a0806",
        0.6
      )}" stroke-width="1.2"/>`;
    }
    out += dustField(rng, { count: 18, color: "#f0d078" });
  }
  out += `</g>`;
  // 天气符文环
  out += runeRing(ctx, { opacity: 0.45, r: 88, cy: 104, count: 22 });
  out += dustField(rng, { count: 14, color: shadeHex(pal.accent, 0.25) });
  return out;
}

/* ---- 召唤物 / 衍生 -------------------------------------------------------- */
function quadruped(ctx, variant) {
  const { pal } = ctx;
  const cow = variant === "cow";
  const body = cow
    ? "M70 128C70 112 86 104 108 104H166C186 104 198 114 198 130V148H70Z"
    : "M64 124C64 108 80 100 104 100H170C190 100 202 110 202 128V150H64Z";
  let out = `<g class="gt-art__creature">`;
  out += subject(ctx, body, { fill: "#090706", width: 1.2, rim: 0.6 });
  // 腿
  [80, 110, 158, 188].forEach((x) => {
    out += `<path d="M${x} 146V186H${x + 12}V146Z" fill="#090706"/>`;
  });
  if (cow) {
    out += `<path d="M70 126C58 120 46 124 42 136C50 134 58 138 62 146L70 140Z" fill="#090706"/>`;
    out += `<path d="M44 130C36 124 34 116 40 110C42 118 48 122 54 122Z" fill="#090706"/>`;
    out += `<path d="M70 132H198" stroke="${rgba(pal.accent, 0.25)}" stroke-width=".7"/>`;
    out += glowEyes(ctx, [[54, 126, 0.5]], { color: shadeHex(pal.glow, 0.2), r: 1.6 });
    out += `<path d="M70 118C82 108 96 104 108 104" fill="none" stroke="${rgba(pal.accent, 0.3)}" stroke-width=".8"/>`;
  } else {
    // 熊 / 兽首
    out += `<path d="M196 118C214 112 228 118 230 132C222 128 214 132 210 140L198 136Z" fill="#090706"/>`;
    out += subject(
      ctx,
      "M62 122C52 108 60 92 76 90C76 74 94 66 108 74C118 62 140 66 146 80C156 86 158 100 150 112Z",
      { fill: "#090706", width: 1.2, rim: 0.6 }
    );
    out += glowEyes(ctx, [[82, 100, 0.6], [120, 94, 0.6]], { color: "#ff6b5a", r: 1.8 });
    out += `<path d="M74 112l8 8M128 104l-6 10" fill="none" stroke="#e7dcc2" stroke-width="1.3" opacity=".5"/>`;
  }
  out += `</g>`;
  return out;
}

function paintToken(ctx) {
  const { rng, pal } = ctx;
  const id = String(ctx.card.id || "");
  const variant = /cow|bovine/.test(id) ? "cow" : /hemdall/.test(id) ? "hero" : "beast";
  let out = moonScene(ctx, { eclipse: rng() < 0.5, x: range(rng, 46, 194), y: range(rng, 34, 62), r: range(rng, 14, 22) });
  out += fogWisps(ctx, { count: 2, y: 160 });
  // 召唤法阵
  out += `<g class="gt-art__summon">
    ${glowCircle(120, 168, 94, `url(#gtf-glow-${pal.key})`, 0.6)}
    <ellipse cx="120" cy="176" rx="78" ry="24" fill="${rgba(pal.core, 0.16)}" stroke="url(#gtf-gold)" stroke-width=".8" stroke-opacity=".55"/>
    <ellipse cx="120" cy="176" rx="64" ry="18" fill="none" stroke="url(#gtf-gold)" stroke-width=".5" stroke-dasharray="2 5" opacity=".6"/>
    <ellipse cx="120" cy="176" rx="50" ry="13" fill="none" stroke="url(#gtf-gold)" stroke-width=".4" opacity=".4"/>`;
  for (let i = 0; i < 12; i += 1) {
    const a = (i / 12) * Math.PI * 2;
    const x = 120 + Math.cos(a) * 72;
    const y = 176 + Math.sin(a) * 22;
    const g = RUNE_GLYPHS[irange(rng, 0, RUNE_GLYPHS.length - 1)];
    out += `<g transform="translate(${n(x)} ${n(y)}) scale(${n(range(rng, 0.32, 0.5))})"><path d="${g}" fill="none" stroke="url(#gtf-gold)" stroke-width="1.2" opacity="${n(
      range(rng, 0.4, 0.8)
    )}"/></g>`;
  }
  out += `</g>`;
  out += `<g transform="translate(0 6)">`;
  out += quadruped(ctx, variant);
  out += `</g>`;
  // 上升的召唤光点
  for (let i = 0; i < 10; i += 1) {
    const x = range(rng, 70, 170);
    const y = range(rng, 70, 160);
    out += sparkle(x, y, range(rng, 0.8, 2.2), shadeHex(pal.glow, 0.25), range(rng, 0.2, 0.6));
  }
  out += dustField(rng, { count: 16, color: shadeHex(pal.glow, 0.2) });
  return out;
}

/* ---- 英雄（以角色本质为底 + 鎏金英雄装饰） -------------------------------- */
function paintHero(ctx) {
  const { rng, pal } = ctx;
  const baseKey = ctx.subjectMotif && ctx.subjectMotif !== "hero" ? ctx.subjectMotif : "warrior";
  const painter = PAINTERS[baseKey] || paintWarrior;
  let out = "";
  // 先铺金色射线（在角色之后会被部分覆盖，形成体积感）
  out += rayBurst(ctx, {
    count: irange(rng, 16, 22),
    outer: 175,
    inner: 26,
    opacityMin: 0.025,
    opacityMax: 0.085,
  });
  out += `<ellipse cx="120" cy="118" rx="98" ry="94" fill="#050403" opacity=".4"/>`;
  out += `<circle cx="120" cy="102" r="96" fill="none" stroke="url(#gtf-gold)" stroke-width=".7" opacity=".3" stroke-dasharray="2 8"/>`;
  out += `<circle cx="120" cy="102" r="89" fill="none" stroke="url(#gtf-gold)" stroke-width=".35" opacity=".2"/>`;
  out += painter({ ...ctx, hero: false, heroSubject: true });
  // 英雄金色浮尘 + 星芒
  out += `<g class="gt-art__hero-motes">`;
  for (let i = 0; i < 14; i += 1) {
    out += sparkle(range(rng, 22, 218), range(rng, 26, 180), range(rng, 1, 3.6), "#f0d078", range(rng, 0.25, 0.8));
  }
  out += dustField(rng, { count: 30, color: "#f0d078", y0: 24, y1: 190 });
  out += `</g>`;
  // 底部金色弧线
  out += `<path d="M18 186C58 172 182 172 222 186" fill="none" stroke="url(#gtf-gold)" stroke-width=".8" opacity=".35"/>`;
  out += `<path d="M32 194C70 182 170 182 208 194" fill="none" stroke="url(#gtf-gold)" stroke-width=".5" opacity=".22"/>`;
  out += `<rect width="${ART_W}" height="${ART_H}" fill="url(#gtf-dust)" opacity=".3"/>`;
  out += `<rect width="${ART_W}" height="${ART_H}" filter="url(#gtf-grain)" opacity=".16" style="mix-blend-mode:overlay"/>`;
  return out;
}

/* ---- 领袖 ----------------------------------------------------------------- */
function crownMarkup(ctx) {
  const { pal } = ctx;
  switch (pal.key) {
    case "st":
      return `<path d="M-22 0C-16-10-6-14 0-8C6-14 16-10 22 0C12-2 6 2 0 8C-6 2-12-2-22 0Z" fill="url(#gtf-gold)"/>
        <path d="M-16-2l-4-8 8 4M16-2l4-8-8 4M0-8V-18" stroke="url(#gtf-gold)" stroke-width="1.4" fill="none"/>`;
    case "mo":
      return `<path d="M-24 4L-20-8L-12 2L-6-14L0 2L6-14L12 2L20-8L24 4L16 10H-16Z" fill="#0b0806" stroke="url(#gtf-gold)" stroke-width="1.1"/>
        <path d="M-20-8L-28-18M20-8L28-18" stroke="url(#gtf-gold)" stroke-width="1.4" fill="none"/>`;
    case "sk":
      return `<path d="M-24 2H24M-20-6H20M-16-14H16" stroke="url(#gtf-gold)" stroke-width="2" fill="none"/>
        <path d="M0-20V2" stroke="url(#gtf-gold)" stroke-width="1.4"/>
        <circle cx="0" cy="-8" r="2.2" fill="url(#gtf-gold)"/>`;
    case "ng":
      return `<path d="M-24 4H24M-20-2L-14-12L-8-2L0-16L8-2L14-12L20-2" fill="none" stroke="url(#gtf-gold)" stroke-width="1.9"/>
        <circle cx="0" cy="-20" r="3.2" fill="url(#gtf-gold)"/>`;
    default:
      return `<path d="M-24 2L-20-12L-11 0L0-16L11 0L20-12L24 2Z" fill="url(#gtf-gold)"/>
        <circle cx="0" cy="-19" r="2.2" fill="url(#gtf-gold)"/>
        <circle cx="-20" cy="-14" r="1.7" fill="url(#gtf-gold)"/>
        <circle cx="20" cy="-14" r="1.7" fill="url(#gtf-gold)"/>`;
  }
}

function leaderProps(ctx) {
  const { rng, pal } = ctx;
  let out = "";
  switch (pal.key) {
    case "nr":
      out += `<g opacity=".82">${roundShield(ctx, { x: 40, y: 170, r: 22 })}
        <path d="M196 96V196h22V96Z" fill="${rgba(pal.core, 0.2)}" stroke="url(#gtf-gold)" stroke-width=".6" stroke-opacity=".35"/></g>`;
      break;
    case "ng":
      [-1, 1].forEach((sd) => {
        const x = 120 + sd * 84;
        out += `<g fill="#080605" stroke="url(#gtf-gold)" stroke-width=".6" stroke-opacity=".35" opacity=".9">
          <path d="M${x - 9} 196V86h18v-12h-6v-10h-6v10h-6v12h-9v110Z"/>
        </g>`;
      });
      break;
    case "st":
      out += `<g fill="none" stroke="url(#gtf-gold)" stroke-opacity=".38" stroke-width=".8" opacity=".9">
        <path d="M40 196C34 160 40 122 54 94M56 196C52 162 58 128 70 104M200 196C206 160 200 122 186 94M184 196C188 162 182 128 170 104"/>
        <path d="M54 94c-10-6-14-16-10-24 8 2 14 8 16 16M186 94c10-6 14-16 10-24-8 2-14 8-16 16"/>
      </g>`;
      break;
    case "mo":
      out += `<g fill="#080605" stroke="url(#gtf-rim-mo)" stroke-width=".9" stroke-opacity=".5" opacity=".95">
        <path d="M34 196V150C34 138 42 128 54 126L58 196Z"/>
        <path d="M44 128L38 108L50 120L54 100L58 122L64 108L60 130Z"/>
        <path d="M206 196V150C206 138 198 128 186 126L182 196Z"/>
        <path d="M196 128L202 108L190 120L186 100L182 122L176 108L180 130Z"/>
      </g>`;
      break;
    case "sk":
      out += `<g stroke="#080605" stroke-width="5" stroke-linecap="round" opacity=".9">
        <path d="M42 196L170 70M198 196L70 70" />
        <path d="M170 70L156 66L162 78Z" fill="url(#gtf-gold)" stroke="none"/>
        <path d="M70 70L84 66L78 78Z" fill="url(#gtf-gold)" stroke="none"/>
      </g>`;
      break;
    default:
      out += `<g fill="none" stroke="url(#gtf-gold)" stroke-opacity=".3" stroke-width=".8" opacity=".9">
        <circle cx="120" cy="110" r="104" stroke-dasharray="2 12"/>
        <path d="M120 6v14M120 196v14M16 110h14M210 110h14"/>
      </g>`;
  }
  return out;
}

function paintLeader(ctx) {
  const { rng, pal } = ctx;
  const flip = rng() < 0.4;
  const throneVariant = irange(rng, 0, 2);
  const framing = irange(rng, 0, 2);
  const figScale = range(rng, 0.94, 1.06) * [1.1, 1.0, 0.88][framing];
  const figShift = range(rng, -6, 6);
  const halo = rng() < 0.65;
  let out = rayBurst(ctx, {
    count: irange(rng, 16, 22),
    cx: 120,
    cy: 82,
    inner: 30,
    outer: 168,
    color: "#f0d078",
    opacityMin: 0.03,
    opacityMax: 0.1,
  });
  out += moonScene(ctx, {
    eclipse: rng() < 0.4,
    x: range(rng, 86, 154),
    y: range(rng, 44, 70),
    r: range(rng, 26, 38),
  });
  out += runeRing(ctx, { opacity: 0.32, r: range(rng, 86, 96), cy: 110, count: 22 });
  out += leaderProps(ctx);
  // 侧翼旗帜
  [-1, 1].forEach((sd) => {
    const bx = 120 + sd * 78;
    out += `<g opacity=".9">
      <path d="M${bx} 42V198" stroke="#080605" stroke-width="3"/>
      <path d="M${bx} 44C${bx + sd * 20} 40 ${bx + sd * 34} 46 ${bx + sd * 40} 56C${bx + sd * 30} 70 ${
        bx + sd * 32
      } 84 ${bx + sd * 38} 96C${bx + sd * 24} 92 ${bx + sd * 10} 96 ${bx} 100Z" fill="${shadeHex(
        pal.deep,
        -0.05
      )}" stroke="url(#gtf-gold)" stroke-width=".6" stroke-opacity=".45"/>
      <path d="M${bx} 42l-3 8 3 8 3-8Z" fill="url(#gtf-gold)" opacity=".8"/>
    </g>`;
  });
  // 王座（三种造型）
  const throneBack =
    throneVariant === 0
      ? `M60 196V124C60 96 86 74 120 74C154 74 180 96 180 124V196Z`
      : throneVariant === 1
      ? `M64 196V116L120 64L176 116V196Z`
      : `M56 196V104h20V88h88v16h20v92Z`;
  out += `<g class="gt-art__throne">
    <path d="${throneBack}" fill="#080605" stroke="url(#gtf-gold)" stroke-width="1.1" stroke-opacity=".6"/>
    <path d="M70 196V128C70 106 92 90 120 90C148 90 170 106 170 128V196Z" fill="#0c0906" stroke="${rgba(
      pal.core,
      0.5
    )}" stroke-width=".9"/>
    <path d="M70 132C96 116 144 116 170 132M70 152C96 136 144 136 170 152M70 172C96 158 144 158 170 172" fill="none" stroke="url(#gtf-gold)" stroke-width=".5" opacity=".32"/>
    <path d="M60 126L52 138L60 150L68 138ZM180 126L172 138L180 150L188 138Z" fill="url(#gtf-gold)" opacity=".55"/>
    <path d="M60 196H180" stroke="url(#gtf-gold)" stroke-width="1.2" opacity=".4"/>
  </g>`;
  // 肩甲 / 皮裘
  out += `<g transform="translate(120 0)">`;
  if (halo) {
    out += `<circle cx="0" cy="100" r="${n(range(rng, 34, 44))}" fill="none" stroke="url(#gtf-gold)" stroke-width=".9" opacity=".32"/>
      <circle cx="0" cy="100" r="${n(range(rng, 44, 54))}" fill="none" stroke="url(#gtf-gold)" stroke-width=".45" stroke-dasharray="2 7" opacity=".26"/>`;
  }
  out += subject(
    ctx,
    `M-58 196C-54 168 -40 150 -22 143L-16 136L16 136L22 143C40 150 54 168 58 196Z`,
    { fill: "#080605", width: 1.2, rim: 0.55 }
  );
  let fur = "";
  for (let i = 0; i < 12; i += 1) {
    const t = i / 11;
    const x = lerp(-56, 56, t);
    const y = 196 - Math.sin(t * Math.PI) * 48;
    fur += `M${n(x)} ${n(y)}l${n(range(rng, -3, 3))} ${n(-range(rng, 5, 12))}`;
  }
  out += `<path d="${fur}" stroke="#080605" stroke-width="3.4" fill="none" stroke-linecap="round"/>`;
  // 胸甲
  out += `<path d="M-30 150C-14 162 14 162 30 150L34 196H-34Z" fill="#0b0806" stroke="${rgba(
    pal.core,
    0.55
  )}" stroke-width=".8"/>`;
  out += `<path d="M-26 160C-12 168 12 168 26 160M-22 174C-10 180 10 180 22 174" fill="none" stroke="${rgba(
    pal.glow,
    0.2
  )}" stroke-width=".7"/>`;
  out += `<path d="M-46 152C-56 164 -62 178 -64 196M46 152C56 164 62 178 64 196" fill="none" stroke="url(#gtf-rim-${
    pal.key
  })" stroke-width="1.1" opacity=".5"/>`;
  out += miniSigil(pal.key, 0, 174, 30, 0.55);
  // 头
  out += subject(
    ctx,
    `M0 76C-12 76 -21 86 -21 99C-21 111 -13 121 0 126C13 121 21 111 21 99C21 86 12 76 0 76Z`,
    { fill: "#0c0907", width: 1.2, rim: 0.7 }
  );
  out += `<path d="M-14 96C-14 108 -8 117 0 122C8 117 14 108 14 96C14 88 8 82 0 82C-8 82 -14 88 -14 96Z" fill="#040303"/>`;
  out += glowEyes(ctx, [[-7, 97, 0.85], [7, 97, 0.85]], { color: shadeHex(pal.glow, 0.3) });
  out += `<path d="M-10 112q10 5 20 0" fill="none" stroke="${rgba(pal.glow, 0.25)}" stroke-width="1"/>`;
  // 王冠
  out += `<g transform="translate(0 78) scale(${n(range(rng, 0.9, 1.18))})">${crownMarkup(ctx)}</g>`;
  // 权杖 / 竖剑
  out += `<g transform="translate(0 0)" opacity=".9">`;
  out += `<path d="M0 140V196" stroke="url(#gtf-gold)" stroke-width="2.2" opacity=".7"/>`;
  out += `<circle cx="0" cy="140" r="7" fill="none" stroke="url(#gtf-gold)" stroke-width="1.3"/>`;
  out += `<circle cx="0" cy="140" r="3" fill="url(#gtf-gold)"/>`;
  out += `</g>`;
  out += `</g>`;
  // 金色浮尘与星芒
  for (let i = 0; i < 12; i += 1) {
    out += sparkle(range(rng, 24, 216), range(rng, 30, 170), range(rng, 1, 3.2), "#f0d078", range(rng, 0.25, 0.7));
  }
  out += dustField(rng, { count: 26, color: "#f0d078" });
  out += `<rect width="${ART_W}" height="${ART_H}" filter="url(#gtf-grain)" opacity=".35" style="mix-blend-mode:overlay"/>`;
  let result = `<g transform="translate(120 200) scale(${n(figScale)}) translate(-120 -200) translate(${n(
    figShift
  )} 0)">${out}</g>`;
  if (flip) result = `<g transform="translate(240 0) scale(-1 1)">${result}</g>`;
  return result;
}

const PAINTERS = {
  monster: paintMonster,
  beast: paintBeast,
  warrior: paintWarrior,
  mage: paintMage,
  elf: paintElf,
  dwarf: paintDwarf,
  vampire: paintVampire,
  witch: paintWitch,
  spirit: paintSpirit,
  hero: paintHero,
  siege: paintSiege,
  spell: paintSpell,
  weather: paintWeather,
  leader: paintLeader,
  token: paintToken,
};

/* ========================================================================== */
/*  Motif 归类                                                                */
/* ========================================================================== */

const MOTIF_ALIASES = {
  wolf: "beast",
  bear: "beast",
  boar: "beast",
  hound: "beast",
  horse: "beast",
  deer: "beast",
  dragon: "monster",
  griffin: "monster",
  raven: "beast",
  bird: "beast",
  knight: "warrior",
  soldier: "warrior",
  king: "warrior",
  queen: "warrior",
  guard: "warrior",
  mercenary: "warrior",
  archer: "elf",
  hunter: "elf",
  sorceress: "mage",
  sorcerer: "mage",
  druid: "mage",
  wizard: "mage",
  hag: "witch",
  crone: "witch",
  bat: "vampire",
  ghost: "spirit",
  wraith: "spirit",
  haunted: "spirit",
  catapult: "siege",
  trebuchet: "siege",
  ballista: "siege",
  tower: "siege",
  ship: "siege",
  longship: "siege",
  scroll: "spell",
  ritual: "spell",
  magic: "spell",
  summon: "token",
  familiar: "token",
  crown: "leader",
  monarch: "leader",
  emperor: "leader",
  frost: "weather",
  fog: "weather",
  rain: "weather",
  storm: "weather",
  clear: "weather",
};

const MOTIF_RULES = [
  [/^vampire|bruxa|ekimmara|fleder|garkain|katakan|emiel-regis/, "vampire"],
  [/crone|grave-hag|^witch/, "witch"],
  [
    /wolf|werewolf|bear|hound|roach|^cow$|kambi|transformed-vildkaarl|transformed-young-vildkaarl|botchling|fiend/,
    "beast",
  ],
  [
    /arachas|behemoth|cockatrice|endrega|elemental|foglet|forktail|frightener|gargoyle|ghoul|griffin|harpy|celaeno|ice-giant|leshen|nekker|plague-maiden|^toad$|wyvern|kayran|draug|imlerith|eredin|ghost|spirit/,
    "monster",
  ],
  [
    /ballista|catapult|trebuchet|mangonel|scorpion|siege|tower|engineer|technician|armorsmith|longship|draig-bon-dhu|holger-blackhand/,
    "siege",
  ],
  [
    /dwarf|mahakaman|yarpen|zoltan|dennis-cranmer|sheldon-skaggs|barclay-els|havekar-smuggler|riordain/,
    "dwarf",
  ],
  [
    /elf|elven|aen-|vrihedd|dol-blathanna|saesenthessis|iorveth|isengrim|filavandrel|milva|yaevinn|toruviel|ciaran|havekar-healer|schirru|eithne|francesca/,
    "elf",
  ],
  [
    /mage|sorcer|keira|triss|yennefer|sabrina|fringilla|philippa|sile-de|ida-emean|assire|albrich|cynthia|renuald|dethmold|ermion|stefan-skellen|shilard|dandelion|mysterious-elf/,
    "mage",
  ],
];

/** 从卡牌数据里识别天气种类 */
function detectWeatherKind(card) {
  const abilities = Array.isArray(card.abilities) ? card.abilities : [];
  const w = abilities.find((a) => a && a.id === "weather" && a.weather);
  if (w) return String(w.weather).toLowerCase();
  const text = `${card.id || ""} ${card.nameEn || ""}`.toLowerCase();
  if (/frost/.test(text)) return "frost";
  if (/fog/.test(text)) return "fog";
  if (/rain/.test(text)) return "rain";
  if (/storm/.test(text)) return "storm";
  if (/clear/.test(text)) return "clear";
  return "frost";
}

/** 从卡牌数据里识别特殊牌种类 */
function detectSpecialKind(card) {
  const abilities = Array.isArray(card.abilities) ? card.abilities : [];
  const ids = abilities.map((a) => a && a.id).filter(Boolean);
  if (ids.includes("horn")) return "horn";
  if (ids.includes("scorch")) return "scorch";
  if (ids.includes("decoy")) return "decoy";
  if (ids.includes("mardroeme")) return "mardroeme";
  const text = String(card.id || "");
  if (/horn/.test(text)) return "horn";
  if (/scorch/.test(text)) return "scorch";
  if (/decoy/.test(text)) return "decoy";
  if (/mardroeme/.test(text)) return "mardroeme";
  return "arcane";
}

/** 根据 id / 名称 / 阵营自动归类 motif（不依赖 art.motif） */
function autoMotif(card) {
  const id = String(card.id || "").toLowerCase();
  for (let i = 0; i < MOTIF_RULES.length; i += 1) {
    if (MOTIF_RULES[i][0].test(id)) return MOTIF_RULES[i][1];
  }
  const faction = String(card.faction || "neutral").toLowerCase();
  if (faction === "scoiatael") return "elf";
  if (faction === "monsters") return "monster";
  if (faction === "skellige") return "warrior";
  return "warrior";
}

/**
 * 解析一张卡的插画方案。
 * @param {object} card 卡牌数据（至少 id/faction/type/hero/abilities）
 * @returns {{motif:string, subjectMotif:string, hero:boolean, weatherKind:string,
 *            specialKind:string, seedText:string}}
 */
export function resolveCardArt(card = {}) {
  const type = String(card.type || "unit").toLowerCase();
  const hero = !!card.hero;
  const explicitRaw = card.art && card.art.motif ? String(card.art.motif).toLowerCase() : "";
  const explicit = MOTIFS.includes(explicitRaw)
    ? explicitRaw
    : MOTIF_ALIASES[explicitRaw] || "";
  const weatherKind = detectWeatherKind(card);
  const specialKind = detectSpecialKind(card);

  let motif;
  if (type === "weather") motif = "weather";
  else if (type === "special") motif = "spell";
  else if (explicit) motif = explicit;
  else motif = autoMotif(card);

  let subjectMotif = motif;
  if (hero) {
    if (motif === "hero") subjectMotif = autoMotif(card);
    else subjectMotif = motif;
    motif = "hero";
  }
  const seedText = `${card.id || "card"}:${card.faction || "neutral"}:${
    card.art && card.art.seed != null ? card.art.seed : ""
  }:${hero ? "hero" : type}:${subjectMotif}`;
  return { motif, subjectMotif, hero, weatherKind, specialKind, seedText };
}

/* ========================================================================== */
/*  构图合成                                                                  */
/* ========================================================================== */

/** 底层：背景、光位、阵营纹章水印、远山、裂纹 */
function backdropLayers(ctx) {
  const { rng, pal } = ctx;
  const k = pal.key;
  // 光源尽量落在主体头部附近，形成逆光轮廓（这是剪影"有体积"的关键）
  const lightX = 120 + range(rng, -30, 30);
  const lightY = 80 + range(rng, -22, 18);
  const lightR = range(rng, 104, 152);
  const sigilSize = range(rng, 158, 214);
  let out = `<rect width="${ART_W}" height="${ART_H}" fill="url(#gtf-bg-${k})"/>`;
  out += `<rect width="${ART_W}" height="${ART_H}" fill="${rgba(pal.core, 0.06)}"/>`;
  out += glowCircle(lightX, lightY, lightR, `url(#gtf-glow-${k})`, range(rng, 0.62, 0.95));
  out += glowCircle(
    range(rng, 24, 216),
    range(rng, 104, 176),
    range(rng, 44, 96),
    `url(#gtf-ember-${k})`,
    range(rng, 0.14, 0.34)
  );
  // 主体背后的暖光（让近黑剪影有逆光轮廓）
  out += `<ellipse cx="${n(120 + range(rng, -16, 16))}" cy="${n(112 + range(rng, -10, 10))}" rx="${n(
    range(rng, 88, 116)
  )}" ry="${n(range(rng, 84, 112))}" fill="url(#gtf-glow-${k})" opacity="${n(range(rng, 0.4, 0.62))}"/>`;
  out += `<ellipse cx="${n(120 + range(rng, -30, 30))}" cy="${n(180 + range(rng, -6, 6))}" rx="${n(
    range(rng, 96, 128)
  )}" ry="${n(range(rng, 22, 40))}" fill="url(#gtf-ember-${k})" opacity="${n(range(rng, 0.16, 0.3))}"/>`;
  out += renderSigil(ctx.factionId, {
    x: 120 + range(rng, -12, 12),
    y: 100 + range(rng, -10, 10),
    size: sigilSize,
    rotation: range(rng, -16, 16),
    opacity: range(rng, 0.09, 0.16),
    strokeWidth: 1,
  });
  out += fogWisps(ctx, { count: 2, y: range(rng, 108, 138) });
  out += `<path d="${ridgePath(rng, range(rng, 146, 168), range(rng, 8, 22), range(rng, 26, 40))}"
    fill="#050403" opacity="${n(range(rng, 0.62, 0.85))}"/>`;
  out += crackedGround(ctx, { count: irange(rng, 2, 4) });
  return out;
}

/** 前景：景深粒子、暗角、顶/底压暗、纸张颗粒 */
function foregroundLayers(ctx) {
  const { rng, pal, hero } = ctx;
  let out = "";
  // 环境天气：雨 / 雪 / 灰烬 / 雾（按卡牌种子稳定选择，明显增加氛围差异）
  const ambient = rng();
  if (ambient < 0.2) {
    for (let i = 0; i < 30; i += 1) {
      const x = range(rng, -10, 250);
      const y = range(rng, 10, 190);
      const len = range(rng, 6, 20);
      out += `<path d="M${n(x)} ${n(y)}l${n(len * 0.24)} ${n(len)}" stroke="${rgba(
        "#cfe0e8",
        range(rng, 0.08, 0.2)
      )}" stroke-width="${n(range(rng, 0.4, 0.9))}" stroke-linecap="round"/>`;
    }
  } else if (ambient < 0.42) {
    for (let i = 0; i < 34; i += 1) {
      out += `<circle cx="${n(range(rng, 6, 234))}" cy="${n(range(rng, 8, 190))}" r="${n(
        range(rng, 0.5, 1.5)
      )}" fill="${rgba("#e7f2f8", range(rng, 0.16, 0.42))}"/>`;
    }
  } else if (ambient < 0.62) {
    for (let i = 0; i < 22; i += 1) {
      const x = range(rng, 10, 230);
      const y = range(rng, 20, 190);
      out += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(range(rng, 0.4, 1.2))}" fill="${rgba(
        pal.accent,
        range(rng, 0.2, 0.5)
      )}"/>`;
    }
  } else if (ambient < 0.8) {
    out += `<ellipse cx="${n(range(rng, 50, 190))}" cy="${n(range(rng, 120, 170))}" rx="${n(
      range(rng, 80, 140)
    )}" ry="${n(range(rng, 10, 22))}" fill="url(#gtf-fog)" opacity="${n(
      range(rng, 0.35, 0.6)
    )}"/>`;
  }
  out += `<ellipse cx="${n(120 + range(rng, -14, 14))}" cy="198" rx="${n(
    range(rng, 58, 96)
  )}" ry="${n(range(rng, 9, 16))}" fill="#000" opacity=".5"/>`;
  out += fogWisps(ctx, { count: 2, y: range(rng, 168, 190) });
  out += dustField(rng, {
    count: irange(rng, 22, 38),
    color: shadeHex(pal.accent, 0.22),
    y0: 18,
    y1: 196,
  });
  out += `<rect width="${ART_W}" height="${ART_H}" fill="url(#gtf-vignette)"/>`;
  out += `<rect width="${ART_W}" height="${ART_H}" fill="url(#gtf-shade-bottom)" opacity="${n(
    range(rng, 0.42, 0.62)
  )}"/>`;
  out += `<rect width="${ART_W}" height="${ART_H}" fill="url(#gtf-shade-top)" opacity="${n(
    range(rng, 0.25, 0.45)
  )}"/>`;
  out += `<rect width="${ART_W}" height="${ART_H}" fill="url(#gtf-dust)" opacity=".34"/>`;
  if (hero) {
    out += `<rect width="${ART_W}" height="${ART_H}" fill="url(#gtf-shade-top)" opacity=".12"/>`;
  }
  return out;
}

/** 组合一张卡的完整插画 body */
function composeArt(card, overrideMotif) {
  const info = resolveCardArt(card);
  const pal = paletteFor(card && card.faction);
  const rng = makeRng(info.seedText);
  const ctx = {
    card: card || {},
    rng,
    pal,
    factionId: String((card && card.faction) || "neutral"),
    ...info,
    motif: overrideMotif || info.motif,
  };
  const painter = PAINTERS[ctx.motif] || paintWarrior;
  const sceneScale = {
    mage: 1.07,
    elf: 1.09,
    dwarf: 1.07,
    vampire: 1.09,
    witch: 1.09,
    spirit: 1.07,
    siege: 1.05,
    spell: 1.03,
  };
  let body = backdropLayers(ctx);
  body += subjectScale(
    painter(ctx),
    sceneScale[ctx.motif] || 1,
    120,
    212
  );
  body += foregroundLayers(ctx);
  return { ...info, motif: ctx.motif, body, ctx };
}

const artCache = new Map();
const artDataUrlCache = new Map();

function cardCacheKey(card) {
  if (!card) return "missing";
  const art = card.art || {};
  return [
    card.id || "",
    card.faction || "",
    card.type || "",
    card.hero ? 1 : 0,
    art.motif || "",
    art.seed == null ? "" : art.seed,
    art.palette || "",
  ].join("|");
}

/**
 * 拿到一张卡的插画（缓存）。返回 { motif, body, svg }。
 * 注意：DOM 版本 body 里的 defs 引用共享 sprite，因此 `svg` 是可直接 innerHTML 的字符串。
 */
export function getCardArt(card) {
  const key = cardCacheKey(card);
  const cached = artCache.get(key);
  if (cached) return cached;
  const composed = composeArt(card);
  const svg = `<svg class="gt-card__art-svg" viewBox="0 0 ${ART_W} ${ART_H}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${composed.body}</svg>`;
  const result = { motif: composed.motif, subjectMotif: composed.subjectMotif, body: composed.body, svg };
  artCache.set(key, result);
  return result;
}

/**
 * 卡牌插画 SVG 字符串（用于插入 DOM）。首次调用会注入共享 defs sprite。
 * @param {object} card
 * @returns {string}
 */
export function renderCardArtSvg(card) {
  ensureArtSprite();
  return getCardArt(card).svg;
}

/** 旗帜 / 卡背等需要自包含时的完整 defs */
function standaloneDefs(card) {
  const pal = paletteFor(card && card.faction);
  return `<defs>${globalDefs("gtf")}${factionDefs(pal, "gtf")}</defs>`;
}

/**
 * 独立（自包含）的插画 SVG —— 供 fx / canvas / img 使用。
 */
export function getCardArtStandaloneSvg(card) {
  ensureArtSprite();
  const art = getCardArt(card);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ART_W} ${ART_H}" width="${ART_W}" height="${ART_H}" preserveAspectRatio="xMidYMid slice">${standaloneDefs(
    card
  )}${art.body}</svg>`;
}

/**
 * 插画 dataURL（带缓存）—— 供 vfx 做幽灵卡、粒子贴图等。
 * @param {object} card
 * @returns {string}
 */
export function getCardArtDataUrl(card) {
  const key = cardCacheKey(card);
  const cached = artDataUrlCache.get(key);
  if (cached) return cached;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(getCardArtStandaloneSvg(card))}`;
  artDataUrlCache.set(key, url);
  return url;
}

/**
 * 预热若干张卡的美术缓存（同步生成字符串，代价很低；不会触发网络请求）。
 * @param {Array<object>} cards
 */
export function preloadArt(cards) {
  ensureArtSprite();
  const list = Array.isArray(cards) ? cards : cards ? [cards] : [];
  for (let i = 0; i < list.length; i += 1) {
    const card = list[i];
    if (!card || !card.id) continue;
    try {
      renderCardArtSvg(card);
    } catch (err) {
      // 美术失败不能影响游戏主流程
      if (typeof console !== "undefined") console.warn("[art] preloadArt failed:", card.id, err);
    }
  }
}

/* --------------------------------------------------------------- 领袖插画 */
const leaderArtCache = new Map();

/**
 * 领袖牌插画（王座 + 王冠 + 鎏金射线）。
 * @param {object} leader
 * @returns {string} SVG 字符串
 */
export function renderLeaderArtSvg(leader) {
  ensureArtSprite();
  const leaderId = (leader && leader.id) || "leader";
  if (leaderArtCache.has(leaderId)) return leaderArtCache.get(leaderId);
  const pseudoCard = {
    id: `leader:${leaderId}`,
    faction: (leader && leader.faction) || "neutral",
    type: "unit",
    hero: true,
    art: { motif: "leader", seed: leader && leader.art ? leader.art.seed : undefined },
  };
  const composed = composeArt(pseudoCard, "leader");
  const svg = `<svg class="gt-card__art-svg" viewBox="0 0 ${ART_W} ${ART_H}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${composed.body}</svg>`;
  leaderArtCache.set(leaderId, svg);
  return svg;
}

/* 额外导出：供主题/CSS 或调试使用 */
export const ART_SIZE = { width: ART_W, height: ART_H };

export { escHtml as escapeHtml };



