# E2E / 可玩性巡检说明（QA）

> Owner: qa-rules　｜　脚本：`scripts/e2e.mjs`　｜　包装测试：`tests/e2e.test.mjs`
> 报告：`research/qa/e2e-report.json`　｜　截图：`research/qa/screenshots/`　｜　DOM 诊断：`research/qa/e2e-dom.txt`

## 1. 运行前提

- Node ≥ 20（当前 v22.22.3）。
- 浏览器自动化：Playwright 仅作测试依赖（项目本身无构建/无运行时依赖）。
  - 本机已具备：全局 `playwright@1.58.2` + 系统 Chrome（脚本自动按 `bundled → 系统 Chrome → ms-playwright 缓存 Chrome for Testing` 回退，实测使用 `system-chrome`）。
  - 其它环境：`npm i -D playwright && npx playwright install chromium`。
- 静态服务器：`node server.mjs`（默认 `http://127.0.0.1:8788`）。脚本会先探测，已在跑则复用，否则自动拉起并在结束后关闭（`--keep-server` 可保留）。

## 2. 一键命令

```bash
# 首页烟测 + 双分辨率截图（约 10s，UI 早期也可跑）
node scripts/e2e.mjs --mode=smoke

# 完整流程：首页→选阵营→预设牌组开局→换牌（选 2 张/跳过）→出牌（含行/目标/待决策）
# →Pass→AI 回合→小局结束→比赛结束；收集 console error + 截图（约 1~3 分钟）
node scripts/e2e.mjs

# 有头观察 / 指定地址 / 不复用服务器
node scripts/e2e.mjs --headed
node scripts/e2e.mjs --base-url=http://127.0.0.1:8788
node scripts/e2e.mjs --no-server

# 作为 node --test 用例运行
E2E=1      node --test tests/e2e.test.mjs   # smoke
E2E_FULL=1 node --test tests/e2e.test.mjs   # full
```

最终验收可玩性巡检（25 项检查 + 18 张截图到 `research/qa/final/`）：

```bash
node research/qa/final-tour.mjs
```

退出码：`0` 通过（无 console.error / pageerror / 流程完成）；`1` 流程失败；`2` 环境不满足（Playwright/浏览器/服务器）。

## 3. 覆盖流程与产物

| 阶段 | 选择器策略 | 产物 |
|---|---|---|
| 首页加载 | `#app/.app/main/canvas` + 正文非空 | `01-home-1280x800.png`、`01b-home-1920x1080.png`、横向溢出检查 |
| 选择阵营 | `[data-faction]` / `.gt-faction` / 文本"北方领域/尼弗迦德/…" | `02-faction.png` |
| 开始对局 | `[data-action=start]` / 文本"开始/快速开始/使用预设" 等 | `03-game-start.png` |
| 换牌 | 手牌 `.gt-card` 选 2 张 + "确认/跳过"；无界面则跳过 | `04-mulligan.png` |
| 出牌 | 手牌容器/几何兜底（视口下半部）→ 行选择（`[data-selectable]`）→ 目标 → 确认 | `06-play-mid.png`、`06b-play-1920-*.png` |
| Pass / 小局 | `[data-action=pass]` 或文本"放弃/Pass" | `05-round-*.png` |
| AI 回合 | 无我方可操作元素时等待，连续 12 次无进展判卡住 | `stuck-no-turn.png` |
| 比赛结束 | `.gt-gameover` / 文本"比赛结束/再来一局"等 | `08-game-over.png` |
| 失败诊断 | 任意步骤失败 | `fail-*.png` + `e2e-dom.txt` |

报告包含：`steps[]`、`screenshots[]`、`consoleErrors[]`、`pageErrors[]`、`httpErrors[]`（4xx/5xx/requestfailed）、`browser`、耗时与结果。

## 4. 当前状态（最终验收，2026-10-17 22:00 ✅ 通过）

- ✅ **完整 E2E 通过**：`node scripts/e2e.mjs`（约 72s）
  - 首页 → 快速对局 → 选阵营（北方领域）→ 开始 → 换牌（选 2/2 + 确认）→ 出牌（固定行/行选择/Decoy 目标/医师等 pending）→ Pass → AI 回合 → 小局 1/2/3 → 结算弹窗 → 比赛结束
  - 结果：21 次我方动作 / 10 次 AI 回合 / 3 小局 / `game-over`；**console.error=0、pageerror=0、HTTP 4xx=0、issues=0**
  - 结算弹窗自动断言与引擎 `roundHistory` 一致（小局胜场 / 小局比分 / 宝石），本轮实测「失败 1:2 · 小局比分 23:30 · 宝石 0:1」
- ✅ **可玩性巡检通过**：`node research/qa/final-tour.mjs` → **25/25 检查通过**（1280×800 + 1920×1080；首页新符文/纹章背景、VS 开场、换牌、对局、tooltip、重复天气、号角单位行、结算、组牌器、图鉴；无横向溢出、无乱码、无 console 错误）。截图见 `research/qa/final/`。
- ✅ 两条交互裁定已验证：① 重复天气允许打出并提示「该天气已经生效」（牌进弃牌堆、不叠加）；② 号角单位所在行不再提供号角动作/落子高亮。
- 说明：`npm test` 当前 **106 tests / 104 pass / 2 skipped（E2E 默认 skip）**；规则独立核验 `node research/qa/rules-verify.mjs` **23/23 通过**。

## 5. 可玩性巡检清单（最终验收结果）

| 检查项 | 结果 | 备注/截图（`research/qa/final/`） |
|---|---|---|
| 首页渲染、进入对局路径 | ✅ | `1280-01-home.png`、`1920-01-home.png`（符文/阵营纹章背景） |
| 阵营/领袖选择交互 | ✅ | `1280-02-faction-select.png`、`1280-03-faction-detail.png` |
| VS 开场 / 硬币 | ✅ | `1280-04-vs-opening.png`、`1280-04b-vs-coin.png` |
| 预设牌组可用、换牌流程 | ✅ | 选 2/2 + 确认；`1280-05-mulligan-after.png` |
| 卡牌渲染（163 张、手牌/场上/墓地/牌堆计数） | ✅ | 手牌扇形/牌面/英雄金框；`1280-06-board.png`、`1920-04-board.png` |
| 牌面 hover tooltip | ✅ | `1280-07-card-tooltip.png` |
| 出牌交互（行选择/目标选择/待决策弹层） | ✅ | E2E 通过；pending 截图 `pending-*.png` |
| 分数实时更新（含天气/号角/紧缚/士气） | ✅ | `1280-08-midgame-scores.png`、`1280-09-duplicate-weather.png`（霜+雪粒子） |
| 重复天气裁定（允许、提示、进墓地） | ✅ | `1280-09-duplicate-weather.png`（中央提示「该天气已经生效」） |
| 号角单位行禁止再放号角 | ✅ | `1280-10-horn-unit-row.png`（近战行无高亮/无动作） |
| AI 是否行动、回合推进 | ✅ | E2E 10 次 AI 回合；`已放弃`/`你的回合` 状态正常 |
| 小局结算/宝石/下一小局先手 | ✅ | `1280-11-result.png` 前的小局结算弹层；E2E roundHistory 断言 |
| 比赛结束/平局/再来一局 | ✅ | 结算弹窗 `1280-11-result.png`（再来一局/返回主菜单） |
| 中文文案错误/乱码/英文残留 | ✅（P3 备注） | 无乱码；引擎日志会泄漏原始行/天气 key（`close行`、`frost 生效`），建议 P3 本地化 |
| 布局溢出（1280×800 / 1920×1080） | ✅ | 各页面 scrollWidth 检查通过 |
| console error / pageerror | ✅ | 0 / 0（E2E 与巡检双验证） |
| 组牌器 | ✅ | `1280-12-deckbuilder.png`、`1920-02-deckbuilder.png`（牌组合法提示、首领/收藏/份数正常） |
| 牌库图鉴 | ✅ | `1280-13-gallery.png`、`1920-03-gallery.png` |

## 6. 问题清单（最终：无 P0/P1/P2 遗留；P3 见下）

| # | 时间 | 严重度 | 现象 | 证据（截图/console/复现步骤） | 状态 |
|---|---|---|---|---|---|
| 1 | 21:46 | P3 | 引擎日志泄漏原始 key：`P0 在close行吹响号角`、`天气：frost 生效`、`到自己的siege行` | 对局日志面板截图；`src/engine/engine.js` `_log` | 建议本地化（不阻塞） |
| 2 | 21:52 | P3 | VS 开场领袖卡底部名字在卡片宽度内被截断（如「尔泰斯特：北方…」） | `research/qa/final/1280-04-vs-opening.png` | 建议 visualist 检查字号/省略策略 |
| 3 | 21:45 | P3（工具层） | 扇形手牌重叠导致自动化点击卡牌中心可能命中相邻卡；E2E 已改为点可见区域 + DOM click 兜底，真人可正常点击 | `scripts/e2e.mjs` `clickElementSafe`；截图 | 建议 hover 提升 z-index（UX 优化，可选） |
| — | — | — | P0/P1/P2 问题：**无**（Decoy 占位卡/reviveRow 引擎 bug 已在开发期修复并回归） | — | — |

## 7. 已知环境注意

- `npm test`（`node --test tests/`）在 Node v22.22.3 下会把目录当模块执行而报 `Cannot find module .../tests`；请改用 `node --test 'tests/**/*.test.mjs'`（已通知 Lead 修 package.json）。
- Playwright 版本与 `~/Library/Caches/ms-playwright` 缓存 revision 不一致时，脚本会自动回退到系统 Chrome，无需手动下载浏览器。
- 每次运行会覆盖 `research/qa/screenshots/` 中同名截图；重要缺陷截图建议复制为 `issue-<描述>.png` 保留。
