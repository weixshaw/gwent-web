# 工程架构与模块契约 · v1.0

## 1. 技术栈（硬性约定）

- **纯原生 ES Modules + 浏览器 API**，**无构建步骤、无框架、无第三方运行时依赖**。
- Node.js 22 仅用于：静态服务器、`node --test` 单元测试、Playwright E2E。
- 所有资源自包含：不加载远程字体/图片/音频；牌面美术用 **程序化 SVG/CSS** 生成；音效用 **WebAudio 合成**。
- 中文 UI，卡名中英双语。视觉稿见 `docs/ART_DIRECTION.md`。
- 目标：Chrome/Safari 现代版本，桌面端优先，分辨率 1280×720 ~ 2560×1440 自适应。

## 2. 运行与测试

```bash
npm start          # node server.mjs → http://127.0.0.1:8788
npm test           # node --test tests/
npm run check      # 数据完整性 + 引擎烟测（tests/ 全跑）
```

`server.mjs`：零依赖静态文件服务器，端口 `process.env.PORT || 8788`，正确 MIME，`Cache-Control: no-store`。

## 3. 目录结构（含 Owner）

```
ktp/
├── index.html                  # Lead
├── server.mjs                  # Lead
├── package.json                # Lead
├── docs/                       # Lead（+QA 校正）
│   ├── GAME_RULES.md           # 权威规则
│   ├── ARCHITECTURE.md         # 本文件
│   ├── CARD_DATA_SPEC.md       # 数据规范
│   └── ART_DIRECTION.md        # 视觉/动效方向
├── research/                   # 已抓取的原始资料（只读，勿改）
│   ├── reference/cards.final.json     # ★ 163 张卡结构化英文数据（cardsmith 的输入）
│   ├── reference/leaders.final.json   # ★ 22 张领袖
│   ├── reference/factions.final.json  # ★ 5 阵营
│   ├── reference/CARD_LIST.md         # 可读版总表
│   └── upstream/                      # 上游 JSON 原始数据
├── src/
│   ├── data/                   # cardsmith
│   │   ├── cards.js            # 全部卡牌（含中英名/描述/能力结构/份数/美术提示）
│   │   ├── leaders.js          # 22 领袖
│   │   ├── factions.js         # 5 阵营 + 中立
│   │   ├── ability-text.js     # 能力 id → 中英描述/图标
│   │   ├── decks.js            # 预设牌组（每阵营 2 套）+ 收藏构建
│   │   └── db.js              # 索引：byId, byFaction, collection 等
│   ├── engine/                 # Lead
│   │   ├── rng.js              # 可复现随机
│   │   ├── cards.js            # 卡牌实例/查询工具
│   │   ├── scoring.js          # 战力计算（纯函数）
│   │   ├── engine.js           # 状态机 + 动作 + 事件 + pending 决策
│   │   ├── deck.js             # 牌组校验 + 洗牌
│   │   └── ai.js               # AI（ai-crafter）
│   ├── ui/
│   │   ├── card-render.js      # visualist：卡牌 DOM
│   │   ├── art.js              # visualist：程序化 SVG 牌面美术
│   │   ├── fx.js               # vfx：粒子/全屏特效
│   │   ├── audio.js            # vfx：WebAudio 音效
│   │   ├── board.js            # Lead：对局界面
│   │   ├── menu.js             # Lead：主菜单/阵营选择/设置
│   │   ├── deckbuilder.js      # deck-smith：组牌器
│   │   ├── tooltip.js          # Lead：卡牌详情浮层
│   │   └── i18n.js             # Lead：UI 文案（中文）
│   ├── styles/
│   │   ├── theme.css           # Lead：设计 token + 基础布局
│   │   ├── screens.css         # Lead：菜单/对局布局
│   │   ├── card.css            # visualist：卡牌样式
│   │   ├── fx.css              # vfx：特效层
│   │   └── deckbuilder.css     # deck-smith
│   ├── store.js                # Lead：localStorage（牌组/设置）
│   └── main.js                 # Lead：入口
├── tests/
│   ├── engine.test.mjs         # Lead：规则单测（核心）
│   ├── scoring.test.mjs        # Lead
│   ├── card-data.test.mjs      # QA：数据完整性
│   └── e2e.test.mjs            # QA：Playwright 烟测
└── assets/                     # 仅程序化生成产物，不放大图
```

## 4. 卡牌数据契约（cardsmith 必须遵守）

`src/data/cards.js`：

```js
export const CARDS = {
  "geralt-of-rivia": {
    id: "geralt-of-rivia",
    nameZh: "利维亚的杰洛特", nameEn: "Geralt of Rivia",
    faction: "neutral",                 // northern-realms | nilfgaard | scoiatael | monsters | skellige | neutral
    type: "unit",                       // unit | special | weather
    hero: true,
    rows: ["close"],                    // close | ranged | siege；agile 为 ["close","ranged"]
    strength: 15,
    copies: 1,                          // 收藏份数，0 = 不可收藏的衍生物
    deckable: true,
    abilities: [ {id:"hero"}, {id:"muster", group:"Roach", from:["deck"]} ],
    abilityZh: "英雄：不受任何特殊牌或能力影响。\n集结：从牌堆找出 Roach 并立即打出。",
    abilityEn: "Hero: …\nMuster: …",
    flavorZh: "……", flavorEn: "……",
    art: { motif: "wolf", palette: "neutral", seed: 42 },  // 交由 visualist 使用
    dlc: "",
  },
  // ...
};
export const CARD_LIST = Object.values(CARDS);
```

- **数据来源**：`research/reference/cards.final.json`（机器生成、英文、含结构化的 `abilities`/`copies`/`rows`/`strength`/`deckable`/`quoteEn`）。必须**逐字段保留**其中的 id、faction、type、rows、strength、copies、deckable、abilities；新增 `nameZh`/`abilityZh`/`flavorZh`/`art`。
- 4 张不可收藏衍生物也必须收录（`copies: 0, deckable: false`）：`bovine-defense-force`、`hemdall`、`transformed-vildkaarl`、`transformed-young-vildkaarl`。
- `leaders.js`：`export const LEADERS = { "foltest-king-of-temeria": {id, faction, nameZh, nameEn, abilityZh, abilityEn, quoteZh, quoteEn, ability:[{id...}], art:{...}} , ...}`，必须覆盖 `research/reference/leaders.final.json` 的 22 张。
- `factions.js`：`export const FACTIONS = { northern-realms: {id, nameZh, nameEn, sigil, colors:{primary,accent,glow}, abilityZh, abilityEn, ability:{id}, loreZh}, ... }`（5 阵营 + `neutral` 伪阵营）。
- `db.js`：
  ```js
  export const CARDS_BY_FACTION = ...;  // faction → card id list
  export const getCard = id => ...;
  export const getLeader = id => ...;
  export const getFaction = id => ...;
  export const collectionFor = factionId => [card...]; // 该阵营可用收藏：本阵营 + 中立，deckable 且 copies>0
  export function validateDeck(deckIds, leaderId, factionId) -> {ok, errors[], stats:{units, specials, heroes, strength}}
  ```
- `decks.js`：`export const PRESET_DECKS = { factionId: [ {nameZh, leaderId, cards:[{id, count}]} , ... ] }`，每阵营至少 1 套合法预设（AI 用），玩家默认可直接用。
- 卡牌 id 全部为小写 kebab-case，**不得改动**（引擎/UI/测试都以 id 为键）。
- 中文名必须使用 W3 官方/wiki 常用译名；无官方译名时使用贴切译名，并在 `abilityZh` 保持与英文能力一致的语义。

## 5. 引擎契约（Lead 实现；AI/UI 依赖）

```js
import { createGame } from './engine/engine.js';

const game = createGame({
  seed: 123456,
  players: [
    { id: 'player', faction: 'northern-realms', leaderId: 'foltest-king-of-temeria',
      deck: ['blue-stripes-commando','blue-stripes-commando', ...] }, // 卡 id 数组，已按份数展开
    { id: 'ai', faction: 'monsters', leaderId: 'eredin-king-of-the-wild-hunt', deck: [...] },
  ],
});

game.viewFor(0)        // 状态快照（对 0 号玩家：自己的手牌全可见，对手手牌仅数量）
game.getActions()      // 当前可执行动作列表（在 pending 时为空）
game.apply(action)     // -> { ok, events, error? }
game.pending           // null | { kind, player, ... }（需要某方做选择时）
game.respond(choice)   // 解决 pending -> { ok, events, error? }
game.clone()           // 深拷贝（AI 推演用）
game.result()          // null | { winner: 0|1|null, reason }
game.phase             // 'setup' | 'play' | 'round-end' | 'game-over'
```

### 5.1 动作（action）

| type | 字段 | 说明 |
|---|---|---|
| `mulligan` | `cards: [uid]`（0~2 张） | 换牌阶段，当前 pending 玩家提交 |
| `chooseFirst` | `first: 0\|1` | 松鼠党选择先手 |
| `playCard` | `uid`, `row?`（'close'\|'ranged'\|'siege'），`targetUid?` | 出牌；灵巧/间谍选行；Decoy 传 targetUid；号角/曼陀罗传 row（可为对方行） |
| `useLeader` | — | 使用领袖能力；随后可能进入 pending 选择 |
| `pass` | — | 本小局 Pass |
| — | `respond` 见下 | |

### 5.2 pending 决策（`game.respond(choice)`）

| kind | choice 格式 | 说明 |
|---|---|---|
| `mulligan` | `{cards:[uid...]}` | 当前玩家换牌（0~2），换完轮到对手 |
| `chooseFirstPlayer` | `{first:0\|1}` | 松鼠党先手选择 |
| `medic` | `{cardId?: string}` | 从 `options` 选 1 张复活；`{}` 或 `{skip:true}` 放弃 |
| `takeGraveUnit` | `{cardId?: string}` | 领袖：从弃牌堆取单位回手 |
| `discardCards` | `{cards:[uid...]}` | 弃 N 张（Eredin: Destroyer of Worlds） |
| `deckChoice` | `{cardId: string}` | 从牌堆选 1 张（天气/抽牌） |
| `chooseWeather` | `{weather:'frost'\|'fog'\|'rain'\|'storm'\|'clear'}` | Eredin: King of the Wild Hunt |
| `chooseRow` | `{row}` | 需要行选择的场合（可并入 action.row，减少 pending） |
| `viewHand` | `{ack:true}` | 信息展示后确认 |
| `repositionAgile` | `{}` | 自动执行，无交互（引擎内部，不暴露） |

原则：**能用 action 参数表达的交互不进入 pending**；只有"打出后立即连锁、需要额外选择"的（医师复活、弃牌、抽牌选择、查看手牌）才 pending。pending 期间 UI 高亮可选目标，AI 由控制器应答。

### 5.3 事件（events，供 UI/特效消费）

统一 `{ type, ... }`，可能含 `text`（中文日志）。UI 按顺序播放。主要类型：

`gameStart, draw, mulligan, firstPlayerChosen, cardPlayed, cardSummoned, spyDraw, muster, medic, cardRevived, scorch, weatherChanged, hornPlaced, mardroeme, transform, decoy, avenger, leaderUsed, leaderCanceled, powerUpdate, roundStarted, roundEnded, gemsUpdate, gameOver, toast, log, pending`

事件中包含最小必要数据（卡 id、uid、行、玩家、分数、pending 快照），UI 用数据层补全名称/描述。**UI 只读事件，不重新计算规则**。

### 5.4 状态视图（view）

```js
{
  version, phase, round, turn, activePlayer, firstPlayer,
  weather: {frost, fog, rain, storm},
  weatherCards: [cardView],             // 天气栏上的卡
  players: [{
    index, faction, leader: leaderView, leaderUsed, leaderAvailable, leaderCanceled,
    gems, score, passed, isAI,
    hand: [cardView] | null,            // null 时 UI 只显示数量
    handCount, deckCount, graveyard: [cardView],
    rows: { close:[unitView], ranged:[...], siege:[...] },
    rowEffects: { close:{horn:false, mardroeme:false}, ... },
    rowScores: { close:n, ranged:n, siege:n },
    factionState: { /* 如 monstersKept, nilfTie, ... */ },
  }],
  pending, log, result, animationHints
}
unitView = {
  uid, id, nameZh, nameEn, faction, hero, type, row, owner,
  basePower, power, bonus: {weather:bool, bond:number, morale:number, horn:bool, spyDouble:bool},
  isToken, abilities:[...], canTarget: bool
}
```

### 5.5 引擎实现约束

- **确定性**：所有随机走 `rng.js`（mulberry32），种子可复现；AI 推演用 `clone()`。
- 每步动作后 `events` 必须包含足够 UI 信息；`view` 由纯函数从 state 生成（可缓存）。
- `clone()` 使用 `structuredClone`；引擎 state 中不得有 DOM/函数引用。
- 核心不变量（测试覆盖）：
  1. 英雄不会被打断/加成/移除；
  2. 分数 = 三行和；顺序见规则 §2；
  3. 小局结束清场后：除怪物保留牌与 avenger token 外板面为空；
  4. 天气/号角/曼陀罗小局结束清空；
  5. 宝石结算与平局/尼弗迦德规则；
  6. 牌数守恒（手牌+牌堆+弃牌堆+场上+天气栏+token 追踪）。
- 日志：中英文均可，只放中文；示例："你打出了「蓝衣铁卫」到近战行（+12）"。

## 6. 卡牌渲染契约（visualist 实现，Lead 调用）

```js
// src/ui/card-render.js
export function initCardRenderer({ getCard, getLeader, getFaction }) {}
export function createCardEl(card, opts = {}) -> HTMLElement
// opts: { size:'xxs'|'xs'|'sm'|'md'|'lg', faceDown?, interactive?, powerOverride?, hidePower?, className? }
// 返回元素必须包含:
//   class: gt-card gt-card--{faction} [gt-card--hero] [gt-card--special|gt-card--weather] [gt-card--{size}]
//   dataset.cardId / dataset.uid（由调用方补 uid）
//   .gt-card__power 元素（若 hidePower=false），setCardPower 更新
export function setCardPower(el, power, { delta = 0, animate = true } = {}) {}
export function setCardState(el, state) // 'selected' | 'target' | 'disabled' | 'normal' | 'just-played'
export function createCardBack(factionId, size = 'md') -> HTMLElement
export function createLeaderCardEl(leader, opts = {}) -> HTMLElement   // 含领袖能力中文描述、可用/已用状态
export function renderRowIcon(row) -> string  // innerHTML SVG，用于行标题
export function getCardArtDataUrl(card) -> string   // 供 fx 粒子/幽灵卡使用（缓存）
export function preloadArt(cards) -> void
```

样式由 `src/styles/card.css` 提供，必须使用 `theme.css` 的设计 token。**卡牌尺寸必须完全由 CSS 变量控制**（`--card-w`, `--card-h`），以便手牌/面板缩放。

## 7. 特效契约（vfx 实现，Lead 调用）

```js
// src/ui/fx.js
export const fx = {
  init({ root, canvas, getCardRect }) {}
  onEvent(event, ctx) {}          // 引擎事件驱动（ctx: {board, view, prevView, stepIndex})
  cardPlay({fromRect, toEl, card, faceDown}) -> Promise
  cardSummon({toEl, card}) -> Promise
  powerPulse(uid, delta) -> void
  scorch({ els, cardEls }) -> Promise
  weather(kind, active) -> Promise        // frost|fog|rain|storm|clear
  horn(rowEl) -> Promise
  mardroeme(rowEl, transformedEls) -> Promise
  spy({fromEl, toRowEl, card}) -> Promise
  medic({fromEl, toRowEl, card}) -> Promise
  muster({cardEls}) -> Promise
  avenger({els, tokenEl}) -> Promise
  leaderActivate({el, faction}) -> Promise
  roundBanner({kind:'win'|'lose'|'draw', scores, gems}) -> Promise
  gameOver({winner, view}) -> Promise
  coinFlip({firstPlayer}) -> Promise
  screenFlash(color, alpha), shake(intensity), toast(text)
  setFactionTheme(factionId)
  menuAmbient(enabled)                    // 主菜单背景粒子
  destroy()
};
// src/ui/audio.js
export const audio = {
  init(), unlock(), setEnabled(bool), setVolume(0..1), isEnabled(),
  play(name, opts),                        // 见下 SFX 列表
  startAmbient(), stopAmbient()
};
```

SFX 名称：`ui-click, ui-hover, coin, card-draw, card-place, card-flip, hero-place, spy, medic, muster, scorch, weather-frost, weather-fog, weather-rain, weather-storm, weather-clear, horn, mardroeme, avenger, leader, pass, turn, round-win, round-lose, round-draw, gem-crack, victory, defeat, error`。
原则：音量克制、无爆音、可静音；未 `unlock()` 前不得自动播放；动画缺失时功能不阻塞（`fx.*` 返回 Promise 或直接 resolve）。

## 8. 协作与写作用域

| 角色 | 写作用域 |
|---|---|
| Lead | `index.html`,`server.mjs`,`package.json`,`src/main.js`,`src/app.js`,`src/store.js`,`src/engine/**`（除 ai.js）、`src/ui/board.js`,`src/ui/menu.js`,`src/ui/tooltip.js`,`src/ui/i18n.js`,`src/styles/theme.css`,`src/styles/screens.css`,`tests/engine.test.mjs`,`tests/scoring.test.mjs`,`docs/GAME_RULES.md`,`docs/ARCHITECTURE.md` |
| cardsmith | `src/data/**`、`tests/card-data.test.mjs` |
| visualist | `src/ui/card-render.js`,`src/ui/art.js`,`src/styles/card.css` |
| vfx | `src/ui/fx.js`,`src/ui/audio.js`,`src/styles/fx.css` |
| ai-crafter | `src/engine/ai.js`,`tests/ai.test.mjs` |
| deck-smith | `src/ui/deckbuilder.js`,`src/styles/deckbuilder.css` |
| QA | `tests/card-data.test.mjs`（与 cardsmith 协调）、`tests/e2e.test.mjs`、`research/QA_RULES_AUDIT.md`、只读其余 |

禁止跨作用域改文件；需要 Lead 修改时发消息说明。样式冲突：只允许改自己文件；公共 token 只能由 Lead 改 `theme.css`。

## 9. 里程碑

- M1（Lead）：引擎核心 + 数据占位 + 能跑通人机对局（命令行/极简 UI）。
- M2：卡牌数据（cardsmith）+ 卡牌渲染（visualist）→ 可用 UI。
- M3：AI（ai-crafter）+ 组牌器（deck-smith）。
- M4：特效/音效（vfx）+ 视觉打磨。
- M5：QA 全量验证 + 平衡与动画节奏打磨 + 交付。
