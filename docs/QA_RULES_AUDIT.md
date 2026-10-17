# 《巫师3》昆特牌 · 规则审计报告（QA）

> 审计对象：`docs/GAME_RULES.md` v1.0（权威规则规格）
> 审计人：qa-rules　｜　日期：2026-10-17
> 依据（按可信度排序）：
> 1. `research/reference/cards.final.json` / `leaders.final.json` / `factions.final.json`（项目最权威结构化数据）
> 2. `research/upstream/units.json`（含 `Occurrences` / `Effect Prefix` 的上游原始数据）
> 3. `research/decks/rules-main.txt`（W3 规则页原始抓取）、`research/pages/cat-*.txt`（分类页抓取，含英雄/领袖/特殊牌分类）
> 4. `research/decks/deck-*.txt`（官方 wiki 各阵营指南，含阵营能力与 combo 细节）
> 5. `research/wiki/Gwent_leader_cards.wiki`、`Decoy_gwent_card_.wiki`、`research/wiki/Gwent_hero_cards` 等单卡/页面抓取
> 6. W3 原版昆特牌通用规则知识（仅用于交叉验证；与以上资料冲突时以资料为准并注明）
>
> 约定：标 **错误** = 与原版/权威数据明确冲突；**存疑** = 资料不足或资料间冲突，需 Lead 裁定；**裁定可接受** = 文档已标"实现裁定"且无法证伪，保留即可；**建议改** = 表述/边界需完善。
> `GAME_RULES.md §9` 的实现裁定条目单独审：只标"可接受/建议改"，不推翻既定裁定。

---

## 0. 结论摘要

| 指标 | 数量 |
|---|---|
| 审计条目 | 58 |
| 一致（含可接受裁定） | 36 |
| 存疑（需 Lead 裁定/补依据） | 9 |
| 错误（与原版/数据冲突，已全部被 Lead 采纳修复） | 5 |
| 遗漏（边界未写，建议补充） | 8 |
| 文档内部矛盾 | 6（均需改为单一表述） |

### 0.1 Lead 裁定执行状态（2026-10-17 21:32，全部采纳）

> Lead 已逐条裁定并修复引擎/文档；本节是审计结论的最终状态。详细证据见 §A~§C。

| 审计项 | Lead 裁定 | 状态 |
|---|---|---|
| A-01 无情者/死亡使者取牌类型 | 取**任意非衍生物牌**（单位/特殊/天气/英雄均可；Cow/Kambi/token 不可取） | ✅ 引擎已改 + 测试 |
| A-02 Muster 同组匹配 | 引擎改为 **uid 排除 + 归一化名匹配 + 家族组规则**；oracle 冻结（`gaunter-o-dimm.group = "Gaunter O'Dimm: Darkness"`）；cardsmith 把 4 张 display nameEn 改为官方冒号写法（显示名差异允许，不影响数据审计） | ✅ 引擎 17/17 场景 + QA data-audit 11/11 绿 |
| A-03 King Bran 天气公式 | **remaining = min(ceil(base/2), base)**：base1→1、4→2、5→3 | ✅ scoring.js 已改 + 数值测试 |
| A-04 史凯利格第三小局复活 | 只复活**非英雄**单位 | ✅ 引擎已排除英雄 + 测试 |
| A-05 Avenger token 计分时机 | **分数在双方 Pass 瞬间冻结**；清场/Avenger/怪物保留不改变本小局分数，token 从下一小局起计分 | ✅ 引擎原本即先算分 + §1.3 已写明 + 回归测试 |
| A-06 King Bran 归属措辞 | "**该单位拥有者**的领袖为 King Bran" | ✅ 文档已改 |
| 英雄自身能力 | 照常生效（士气/医师/曼陀罗/间谍/召唤），只是自身不受效果影响 | ✅ 文档 §2.1 已补 |
| Decoy 归属 | 可选**己方场地任意非英雄单位**（含对方打来的间谍），回**诱饵使用者手牌**、所有权转移，再打出按自己牌处理（+3 卡差成立） | ✅ 引擎 + 文档 §4.2 |
| Avenger token 行 | 放到**自身卡面行**（BDF/Hemdall 均近战），不继承原牌行 | ✅ 文档 §3.8 |
| Ermion / 特殊效果位 | 曼陀罗牌占行特殊位、与号角牌互斥；Ermion 是单位光环不占位，可与号角牌共存 | ✅ 文档 §3.11 保留裁定（措辞待清理，见 §H） |
| 领袖无合法目标 | 仍消耗使用次数（视为使用过） | ✅ 文档 §5 已补 |
| 双方都是尼弗迦德平局 | 按普通平局（双方各掉 1 宝石） | ✅ 文档 §1 已补 |

**阻断级发现（6 项，建议在引擎定型前修复，见 §A）**

1. **A-01** 无情者/死亡使者取牌类型被限定为"单位牌"，原版两项领袖能力均取"任意卡牌"。
2. **A-02** Muster 同组匹配规则（§3.3）与实际卡牌 `nameEn` 不一致：`Crone`（3 张）与 `Gaunter O'Dimm: Darkness`（3 张）按文档规则**无法解析**，怪物核心 combo 直接失效。需数据或引擎二选一修复。
3. **A-03** King Bran 天气公式在文档内自相矛盾（§2 的 `floor(base/2)` vs §5 的"只失去一半"），且 1 力单位会被算成 0。
4. **A-04** 史凯利格第三小局复活漏掉"**非英雄**单位"限制（权威资料明确）。
5. **A-05** Avenger token 的计分/入场时机未明确：按 §1.3 的结算顺序，token 战力可能被计入**刚结束的小局**（应只从下一小局开始计分）。

**数据面结论（详见 §E）**

- `src/data/cards.js` 与 `cards.final.json` 当前（21:30）**逐字段一致**：163 卡 / 22 领袖 / 5 阵营，无重复 id，全部 kebab-case。
- 4 张衍生物 `copies:0, deckable:false` 正确；`upstream` 的 Kambi Hero=Yes 为上游数据错误，参考数据（Hero=No）与 wiki 分类页一致。
- ⚠️ `research/reference/cards.final.json` 在本审计期间（21:26）被改动过（Gaunter group、Kambi hero）。**oracle 应在开发期冻结并版本化**，否则 `tests/data-audit.test.mjs` 会出现"数据被人改了才变红"的假象。
- ⚠️ `research/reference/CARD_LIST.md`（21:19 生成）已落后于 `cards.final.json`（Gaunter group 不同）——**以 JSON 为准**，CARD_LIST 仅供参考。

---

## A. 阻断级问题（✅ 均已由 Lead 裁定并修复；以下保留原始审计证据）

### A-01【错误】无情者 / 死亡使者：应取"任意卡牌"，不是"单位牌"

| 项 | 内容 |
|---|---|
| 文档位置 | §5 表格：`Emhyr: The Relentless → 从对手弃牌堆取 1 张单位牌加入手牌`；`Eredin: Bringer of Death → 从己方弃牌堆取 1 张单位牌回手` |
| 原版文本 | `leaders.final.json`：The Relentless `"Draw a card from your opponent's discard pile."`；Bringer of Death `"Restore a card from your discard pile to your hand."` —— **均是 a card，不是 a unit card** |
| 结论 | **错误**（数据名 `takeGraveyardUnitToHand` 是上游归一化 id，不代表规则限制） |
| 影响 | 玩家无法回收 Scorch/Horn/Decoy/天气等关键牌，两套尼弗迦德/怪物 leader 强度显著低于原版；AI 评估与 UI 提示也会错 |
| 建议 | 实现为"任意卡牌（special/weather/unit 均可）"；`ARCHITECTURE §5.2` 的 pending kind `takeGraveUnit` 与 data ability id 可保留不动，但语义按"任意卡"注释。若坚持单位限定，必须明确标注为**刻意平衡裁定**并写入 §9 |
| 裁定 | ✅ **采纳任意非衍生物牌**（Cow/Kambi/token 不可取），引擎已改 + 测试通过 |

### A-02【错误/阻断】Muster 同组匹配规则与卡牌名称数据不一致

| 项 | 内容 |
|---|---|
| 文档位置 | §3.3："同组 = 牌名完全等于 group 或 以 `group + ":"` 开头的牌" |
| 数据现状 | `crone-brewess/weavess/whispess` 的 `nameEn` 为 `Crone Brewess` 等（**无冒号**），group=`Crone` → 文档规则匹配 **0 张**；`gaunter-o-dimm-darkness` 的 `nameEn` 为 `Gaunter O'Dimm Darkness`（无冒号），其 group=`Gaunter O'Dimm: Darkness` → 匹配 **0 张**；`gaunter-o-dimm` 的 group=`Gaunter O'Dimm`，需要前缀 `Gaunter O'Dimm:` 才能召唤 Darkness → 同样 **0 张** |
| 官方名称 | wiki 原页面/阵营指南中这些卡的真实名称带冒号：`Crone: Brewess`、`Gaunter O'Dimm: Darkness`（见 `research/decks/deck-monsters.txt`、`research/pages/cat-*.txt`） |
| 影响 | 怪物族核心 combo：三老妪（3×6 + 集结）与 Gaunter 套完全无法触发；引擎若"修复"为按 `group` 字段匹配，又会把 `Arachas Behemoth` 错误地当成 Arachas 同组召唤对象（不同名，原版不召唤） |
| 建议 | **首选**：cardsmith 将 6 张卡的 `nameEn` 修正为游戏内带冒号名称（`Crone: Brewess/Weavess/Whispess`、`Gaunter O'Dimm: Darkness` ×3），文档规则不变即可全绿；**同时** Lead 在引擎 muster 匹配中不要用"候选卡自身 group"来判断（会导致 Arachas 误招 Behemoth），只按 §3.3 名称规则或按"被召唤卡名称命中 group 前缀"实现。修改后由 `tests/data-audit.test.mjs` 的 group 可解析性检查保护 |
| 裁定 | ✅ **已解决**：引擎改为 uid 排除 + 归一化名匹配 + 家族组规则，17/17 Muster 场景回归通过；4 张 display nameEn 已改为官方冒号写法（Crone: Brewess/Weavess/Whispess、Gaunter O'Dimm: Darkness），oracle `gaunter-o-dimm.group` 更新为 `Gaunter O'Dimm: Darkness`；QA 独立核对 data-audit 11/11 绿、无精确匹配告警 |

### A-03【错误/矛盾】King Bran 天气公式

| 项 | 内容 |
|---|---|
| 文档位置 | §2 第 4 条：若 King Bran 为领袖，战力 = `min(floor(基础力量/2), 基础力量)`；§5 表格：`只失去一半力量（向下取整）`；§9.9 引用 §2 |
| 权威文本 | `leaders.final.json` / `Gwent_leader_cards.wiki`：`Units only lose half their Strength in bad weather conditions.` |
| 矛盾点 | "剩余 = floor(base/2)" 与 "失去 = floor(base/2)" 是相反语义；且 base=1 时公式得 0（天气正常只降到 1，Bran 反而更差，明显错误） |
| 建议 | 统一为一种并给样例表；建议语义（待 Lead 定）：**受天气影响后 = max(1, base - floor(base/2))**（即"只失去一半，向下取整"），或 **= max(1, floor(base/2))**（剩余一半）；两种对偶数一致、奇数不同。必须补 base=1/2/3/5 的例子并写入 `scoring.test.mjs`。同时把"向下取整"改成"损失向下取整/剩余向下取整"的明确措辞 |
| 备注 | 该计算只影响 Bran 持有者的单位（见 A-06 措辞） |
| 裁定 | ✅ **采纳** `min(ceil(base/2), base)`，scoring.js 已改 + 测试通过 |

### A-04【错误/遗漏】史凯利格阵营能力复活对象应排除英雄

| 项 | 内容 |
|---|---|
| 文档位置 | §1.3 第 6 步、§6 表格：`从墓地带回 2 张随机单位牌`（未排除英雄） |
| 权威依据 | `research/decks/deck-skellige.txt`："two random normal (**non-hero** or 'special') cards are returned to the board" |
| 结论 | **错误/遗漏**：英雄牌（多数 10~15 力）不应被第三小局能力复活；该错误会显著破坏平衡 |
| 建议 | 两处均改为"2 张随机**非英雄单位牌**（不含衍生物）"；同时明确：从**己方**弃牌堆取、不足 2 张取可用数、复活触入场能力 |
| 裁定 | ✅ **采纳非英雄**，引擎已排除英雄 + 测试覆盖。⚠️ 文档 §6 已改，但 §1.3 第 6 步仍写"2 张随机单位牌"未同步（见 §H-1） |

### A-05【错误/遗漏】Avenger token 的入场时机与计分时机

| 项 | 内容 |
|---|---|
| 文档位置 | §1.3 第 2 步（Avenger 在清场过程中触发，token 保留到下一小局）与第 4 步（比较总战力）顺序；§3.8；§9.14 |
| 冲突资料 | `research/pages/cat-special.txt`："When these cards are removed from the battlefield, they will summon a powerful card **in its place at the start of the next round**."；卡牌自身文本只说 "summons ... to take its place" |
| 风险 | 若引擎按文档 §1.3 顺序实现：**先**清场/Avenger 召唤，**后**比较总战力 → token 的 8/11 力会被计入刚结束的小局，从而改变胜负/宝石扣除（严重） |
| 建议 | 明确写入：① 小局胜负在"双方 Pass（或自动 Pass）且最后一张牌结算完成"时**立即冻结分数**；② 清场、怪物保留、Avenger 召唤、北方抽牌、史凯利格复活均**不改变已结束小局的分数**；③ token 从下一小局起计入。另需裁定：小局中通过 Decoy 等触发 Avenger 时 token 是**立即入场**（计本局）还是下一小局入场（推荐立即入场，因为原版文本"in its place"；但需与 wiki "next round" 说法取舍并写清） |
| 裁定 | ✅ **采纳分数冻结**：§1.3 新增第 1 步"分数冻结"；引擎原本即先算分→再清场/复仇者；新增回归测试（Cow 局末变 BDF 不计入刚结束小局、下一小局起计 8 分） |

### A-06【错误/措辞】"天气方领袖为 King Bran"歧义

| 项 | 内容 |
|---|---|
| 文档位置 | §2 第 4 条："若天气方领袖为 King Bran（史凯利格）" |
| 问题 | 天气作用于**双方同一行**；"天气方"容易被实现成"打出天气牌的玩家"。Bran 保护的是**拥有该单位的玩家**（Bran 持有者），与谁打出天气无关 |
| 建议 | 改为"若**该单位的拥有者**的领袖为 King Bran，则……"；测试用例：A 打 Frost，B 有 Bran，B 的单位半效、A 的单位仍降为 1 |
| 裁定 | ✅ **采纳措辞**，文档 §2.4 已改为"若该单位拥有者的领袖为 King Bran" |

---

## B. 文档内部矛盾（必须统一表述）

| # | 位置 | 矛盾内容 | 建议 |
|---|---|---|---|
| B-01 | §2.4 vs §5 / §9.9 | Bran 公式"剩余 floor(base/2)" vs"失去一半" | 见 A-03，统一公式+样例 |
| B-02 | §3.11 vs §4.3 | §3.11 说曼陀罗与号角"共享每行 1 个特殊效果位"，又说"Ermion 在场时该行仍可放号角牌…曼陀罗与号角可共存"；§4.3 说"曼陀罗牌占用该行特殊位，阻止同排号角" | 明确区分**特殊卡效果位**（号角牌/曼陀罗牌二选一）与**单位提供的行效果**（Dandelion/Draig/Ermion，不占位、可与特殊卡效果叠加）。§3.11 的问句删掉，写成唯一裁定 |
| B-03 | §4 开头 vs §4.1/§1.3 | "特殊牌打出后立即进弃牌堆" vs"号角/曼陀罗作为行附加效果留在该行直到小局结束" | 改为："号角/曼陀罗牌打出后留在行上（占用行效果位），小局结束时进弃牌堆；Decoy 占位卡同理留到小局结束；其余特殊牌（Scorch）打出后立即进弃牌堆" |
| B-04 | §1.1 第 2 步 | "见 §7 领袖被动、§8 阵营能力" —— 章节号错误（§7 是牌组、§8 是术语表） | 改为 §5/§6；"灵能"疑似笔误，改为"领袖被动/阵营开局效果" |
| B-05 | §2 第 1 条 | "英雄仍可被'Decoy'？**不能**" 用问答残留；§5 白焰"可用次数仍为 1？**实现裁定**…" 同样残留 | 改为陈述句（"英雄不能被任何方式选中，包括 Decoy/灼烧/医师复活"；"白焰开局即视为已消耗"），权威规范不保留问号 |
| B-06 | §1.3 顺序 vs §6 | §1.3 第 8 步才"宝石归 0 时比赛结束"，但第 5/6 步已执行"下一小局开始"类能力（北方抽牌、史凯利格第三局复活） | 调整顺序："扣宝石 → **判定比赛是否结束** → 若继续：北方抽牌 → 第三小局开始时史凯利格复活 → 进入下一小局"；2:0 时不得触发第三小局能力 |

---

## C. 与原版/权威资料不一致（含需补依据的条目）

| # | 位置 | 文档内容 | 审计结论 | 依据 | 建议 |
|---|---|---|---|---|---|
| C-01 | §5 两处领袖 | 墓地取"单位牌" | **错误** | A-01 | 改任意卡 |
| C-02 | §6/§1.3 史凯利格 | "2 张随机单位牌" | **错误**（漏非英雄） | A-04 | 补"非英雄" |
| C-03 | §2.4/§5 Bran | 天气半效公式 | **错误/矛盾** | A-03 | 统一公式 |
| C-04 | §3.3 Muster | 名称前缀匹配 | **错误**（与数据不一致） | A-02 | 修 nameEn 或改匹配实现 |
| C-05 | §1.1 步骤 3 / §6 松鼠党 | "比赛开始时决定一次" | **存疑**（裁定可接受） | `deck-scoiatael.txt`："chooses who goes first **at the start of a round**"；官方能力文本为 "Decide who takes the first turn at the start of the game"（`factions.final.json`）。两者措辞冲突，实际游戏只在开局提供一次选择 | 保留"一次性"裁定，但在 §9 注明依据冲突；引擎测试固化"仅第一小局" |
| C-06 | §1.3 步骤 7 | 平局后由"上一小局先手方"先手 | **存疑**（裁定可接受） | research 资料未记载；原版可观测行为少 | 保留并写入 §9；补测试 |
| C-07 | §1 平局规则 | 仅写"一方是尼弗迦德"；**双方都是尼弗迦德**时未定义 | **遗漏/存疑** | 原版可让玩家用尼弗迦德对战尼弗迦德 AI | 裁定：双方各扣 1（推荐，与原版"平局双方各扣"一致）；写入 §9 |
| C-08 | §2.5 间谍翻倍顺序 | 天气 → 顺手翻倍 | **存疑**（裁定可接受） | 无权威文本；原版只能观测 | 保留，建议 scoring 测试固化（Frost + Treacherous：1→2） |
| C-09 | §2.6/§2.7/§2.8 顺序 | 紧缚 → 士气 +1 → 号角 ×2 | **裁定可接受** | 原版无文档化公式；示例（3×BSC 霜+号角 9/18）与社区共识一致 | 保留；固化 3 组测试：bond+morale、morale+horn、bond+horn |
| C-10 | §5 领袖使用 | "视为一次行动，本回合结束" | **裁定可接受** | `Gwent_leader_cards.wiki` 只说 "once per match"，未载是否消耗回合 | 保留；注意它与"任意时点使用"的组合已自洽（不能先出牌再用）；在 §9 明确"使用后立即结束回合" |
| C-11 | §5 天气类领袖 | 牌堆无对应天气→无效但算使用过 | **裁定可接受**（仅天气类明确） | 原版行为 | 扩大到所有领袖：统一"目标不存在/无效果时：能力不可用（不消耗）"或"可用但算消耗"，二选一写清（建议后者，减少 AI/UI 分支） |
| C-12 | §3.9 狂战士 | 原牌不进弃牌堆、变身牌小局结束进弃牌堆、原牌不返场 | **裁定可接受** | 原版无明确记载 | 保留；补充与 §5.5 不变量"牌数守恒"的协调：变身牌/token 作为衍生物单独登记，不参与原始 163 张牌数量守恒 |
| C-13 | §3.8 Avenger | "召唤单位放到原牌所在行"同时又说"Bovine Defense Force 固定近战" | **矛盾/存疑** | Cow 是**远程** 0 力（参考数据/upstream/wiki 三者一致），BDF 是**近战** 8 力；Kambi/Hemdall 均为近战（无歧义） | 建议明确"token 按**自身卡面行**放置（BDF/Hemdall 近战），不继承原牌行"；若选择继承 Cow 行（远程）必须显式写明并承担与卡面行不一致 |
| C-14 | §3.2 医师 | 不可复活衍生物/Decoy；可复活 Cow/Kambi 本体 | **一致**（裁定可接受） | 参考数据衍生物 `copies:0/deckable:false`；Cow/Kambi 为可收藏单位 | 保留；建议明确"修复活间谍→去对方场地并抽 2"、"复活医师→可连锁"两个例子 |
| C-15 | §3.3 灵巧召唤 | "被召唤的灵巧单位自动放入更有利行" | **冗余（当前牌库无此实例）** | 所有 Muster 目标（Arachas/老妪/吸血鬼/Gaunter/盾女/Roach/矮人/精灵/食尸鬼/走私者/长船/孽鬼）均为固定行 | 保留但标注"当前牌库无灵巧 Muster 目标；为未来扩展保留" |
| C-16 | §2.8 号角单位 | "号角单位不会被自己号角翻倍；若该行同时存在号角牌+号角单位，则号角单位可被翻倍" | **存疑**（需明确合法顺序） | 因"每行限 1 号角效果"，号角**牌**不能放到已有号角效果的行；唯一合法路径是**先放号角牌，再把号角单位打到该行**（单位牌不受限，其号角效果冗余） | 明确该顺序合法，且此时号角单位被行上号角牌翻倍；反向（先号角单位再放号角牌）非法 |
| C-17 | §4.2 Decoy | "选择己方场上 1 张非英雄单位牌：该牌回到手牌" | **遗漏**（归属细节） | `Decoy_gwent_card_.wiki`："can be used to replace regular **spy and medic cards on one's side of the field**, allowing a player to gain more cards in their hand"；`deck-nilfgaard.txt`/`deck-northern-realms.txt` 均把"用 Decoy 回收**对手打过来的间谍**"计入自己的 +3/3 张卡差 | 补："Decoy 可选**我方场地上的任意非英雄牌**（含对手打到我方的间谍）；被换回的牌进入**Decoy 使用者的手牌**（即使原属对手）"。这条对卡差与 AI 评估影响很大 |
| C-18 | §4.2 Decoy 占位卡 | 留场 0 力占位卡，不可被任何效果选中 | **存疑**（裁定可接受） | `cat-special.txt` 说 "discarding the decoy card immediately after use"，与"占位留场"冲突；原版视觉上 Decoy 确实留在行上 | 保留占位裁定，但注明资料冲突；补"占位卡小局结束进弃牌堆、不可被 Decoy/医师/Scorch 选中、不占号角位" |
| C-19 | §4.2 | 未写 Decoy 对 **0 力非英雄**（Cow/Kambi）是否可用 | **遗漏** | 原版可选中非英雄牌 | 建议允许（并触发 Avenger，见 A-05） |
| C-20 | §6 怪物保留 | "随机保留 1 张单位（含英雄）" | **裁定可接受** | wiki："Keeps random Unit Card out after each round"（英雄也是 Unit Card）；无排除证据 | 保留；补"若场上无己方单位则不保留；保留牌计入下一小局战力" |
| C-21 | §5 White Flame | 双方都带则双方能力都取消；持有者能力开局即消耗 | **裁定可接受** | 原版双白焰极罕见 | 保留并转陈述句；补"取消后对手领袖按钮禁用，UI 显示'已取消'" |
| C-22 | §5 Invader | "所有'复活/召唤回场'效果改为随机选择（双方）" | **存疑（范围过宽）** | 原文："Abilities that **restore a unit to the battlefield** restore a randomly-chosen unit." —— 指**复活类**（医师、史凯利格第三局），不含 Muster（从牌堆召唤）与 Avenger（固定 token） | 收窄为"复活类效果（医生、史凯利格阵营能力等）随机选择目标；Muster/Avenger 不受影响"；并明确随机池 = 合法目标集合（非英雄、可复活） |
| C-23 | §5 Destroyer | 弃 2 抽 1 | **遗漏边界** | 原文 "Discard 2 card and draw 1 card of your choice from your deck." 未写手牌不足 | 裁定：手牌<2 时能力不可用（推荐，避免"弃 1"歧义）；写入 §9 |
| C-24 | §5 Emperor | 查看随机 3 张 | **遗漏边界** | 原文 3 random cards | 补"对手手牌<3 时看全部；只展示不抽牌；信息类不计入回合结束？"——按 §5 领袖使用即结束回合处理即可 |
| C-25 | §5 Relentless | 对手弃牌堆为空时 | **遗漏边界** | 同 C-11 统一策略 | 统一"目标不存在时不可用/可用无效"策略 |
| C-26 | §5 Hope of the Aen Seidhe | "移动到使总战力最大的行" | **存疑（算法细节）** | 原文 "maximizes their strength (don't move units already in optimal row)"；多个灵巧单位 + 紧缚/士气/号角时存在组合优化，且需要"当前有效战力"还是"基础战力"未写 | 建议裁定为贪心（逐个移动到当前有效战力增量最大的行，平手取近战），并写入测试；或直接用"每个单位独立最优、不动已最优" |
| C-27 | §1.2/§9.16 | 手牌 0 且无领袖能力自动 Pass | **一致** | 原版行为 | 补"若仍有可用领袖能力则不自动 Pass，玩家可选择使用；用完后自动 Pass" |
| C-28 | §2.1 | 重复天气无叠加、后牌进弃牌堆 | **一致** | 原版行为 | 补"Clear Weather 在无天气时打出：无效果，进弃牌堆" |
| C-29 | §2.1 | 5 种天气；Skellige Storm 远程+攻城 | **一致** | `cards.final.json`（storm rows ranged+siege）、`deck-neutral.txt` | — |
| C-30 | §3.7 灼烧阈值 | 单行灼烧需敌方该行"当前总战力≥10" | **一致** | `cards.final.json` ability `requireEnemyRowTotalAtLeast:10`；`deck-neutral.txt` Villentretenmerth 原文 | 明确阈值用**当前有效战力**（文档已写"当前"，保留） |
| C-31 | §3.7 全场灼烧 | Clan Dimun Pirate 全场最强非英雄 | **一致** | data `scorch mode:any`；wiki cat-special | 补"0 力非英雄（Cow/Kambi）在无更高非英雄时可被摧毁"的边界 |
| C-32 | §3.1 间谍 | 放对方战场、抽 2、计数给对方 | **一致** | data `spy draw:2`；wiki | 补"英雄间谍 Mysterious Elf 同样抽 2、免疫效果"已写，OK |
| C-33 | §3.3 Muster 默认牌堆 / Cerys 手牌+牌堆 | **一致** | data `from:["deck"]` / `["deck","hand"]` | 保留；补"从手牌召唤的盾女不进弃牌堆、不触发抽牌" |
| C-34 | §5/§6 阵营与领袖文本 | 22 领袖能力与能力文本 | **一致**（除 A-01、A-03、C-22） | `leaders.final.json` 逐条比对 | 见逐条表 §F |
| C-35 | §7 牌组 | 单位≥22、特殊≤10、领袖 1、本阵营+中立、份数≤copies（普通单位 1~5、特殊 2~3） | **一致** | `rules-main.txt`（min 22 units）、wiki（max 10 special）；data 实际分布：copies=5 有 Mahakaman Defender、=4 有 Impera Brigade Guard、特殊/天气 2~3 | 补"领袖必须与阵营一致（隐式）"；copies 描述无需改 |
| C-36 | §9.17 | 牌堆抽空：无牌可抽、无疲劳 | **一致** | 原版无疲劳机制 | — |
| C-37 | §3.11 Ermion | 英雄 8 远程、提供曼陀罗效果 | **一致** | data（hero,mardroeme,ranged,8） | 明确英雄能力照常生效（R-07） |
| C-38 | §3.10 号角单位 | Dandelion 近战 2 / Draig Bon-Dhu 攻城 2 | **一致** | data | — |
| C-39 | §2.7 士气 | 不含自身、多士气叠加、英雄不吃 | **一致** | data（Isengrim/Kayran/Milva/Olgierd/Olaf/Transformed Vildkaarl/Kaedweni） | 补"英雄的士气能力仍给他人 +1，只是自身不吃加成" |
| C-40 | §2.1 英雄 | 英雄免疫天气/号角/士气/紧缚/间谍翻倍/灼烧/领袖/特殊 | **一致** | wiki hero cards 原文 | 见 R-07：补"英雄自身能力照常生效" |

---

## D. 遗漏边界（建议补充到 §9）

| # | 遗漏点 | 建议裁定 |
|---|---|---|
| D-01 | 双方都是尼弗迦德且平局 | 双方各扣 1 宝石（不要让"尼弗迦德赢平局"叠加成双方不掉） |
| D-02 | 领袖能力触发"无目标"时是否消耗 | 统一：可用但无效，仍计已使用（与 §5 天气类一致）；UI 仍可点 |
| D-03 | Destroyer 手牌不足 2 | 不可用（按钮禁用） |
| D-04 | 双方同时宝石归 0 | 比赛平局（§1 已写，保留） |
| D-05 | 小局开始时双方都无手牌 | 双方连续自动 Pass → 0:0 平局 → 按平局扣宝石 |
| D-06 | 史凯利格墓地不足 2 单位 | 取可用数量（§6 已写，保留）；无英雄、无衍生物 |
| D-07 | 回合中打出 Avenger 牌被 Decoy 换回 | Decoy 触发离场 → token 入场；Cow 回手可再次打出（会再次触发） |
| D-08 | 抽牌效果导致手牌无上限 | 原版无手牌上限，保留 |
| D-09 | 小局结束清场后，Decoy 占位卡与号角/曼陀罗牌的去向 | 均进其拥有者弃牌堆（§1.3 第 3 步已覆盖，建议明确点名） |
| D-10 | 天气牌在天气栏被 Clear Weather 清除后的去向 | Clear Weather 打出时，被清除的天气牌进各自拥有者弃牌堆（不是移出游戏） |

---

## E. 数据独立核对（reference vs src/data vs upstream）

### E-1 当前一致性（2026-10-17 21:30 快照）

| 检查项 | 结果 |
|---|---|
| `src/data/cards.js` 卡数 | 163 ✅ |
| 与 `cards.final.json` id 集合 | 完全一致 ✅ |
| 每卡 faction/type/hero/rows/strength/copies/deckable/abilities | 逐字段一致 ✅（自动核对脚本 0 diff） |
| `src/data/leaders.js` | 22 张、ability 结构逐字段一致 ✅ |
| `src/data/factions.js` | 5 阵营 + neutral，能力 id 与参考一致 ✅ |
| 无重复 id / 全部 kebab-case | ✅ |
| 4 张衍生物 `copies:0,deckable:false` | ✅ |
| 能力 id 词表 | hero/agile/bond/spy/medic/muster/morale/horn/scorch/avenger/berserker/mardroeme/decoy/weather ✅ |
| 阵营卡数分布 | NR 25 / NG 29 / ST 23 / MO 35 / SK 27 / 中立 24 = 163 ✅ |

### E-2 `cards.final.json` vs `upstream/units.json` 差异（已逐条核实，参考数据更正确）

| 卡 | upstream | 参考数据 | 结论 |
|---|---|---|---|
| Kambi | `Hero: Yes` | `hero: false`，无 hero ability | **参考正确**：`cards-wiki-extra.json` 中 Kambi `type: "Unit"`、能力文本无 "Hero:"；wiki 英雄分类页不含 Kambi（Hemdall 标注为 "Transformed version of Kambi"）。raw 的 hero=true 是上游数据错误 |
| 4 张衍生物 | `Occurrences` 1/1/1/3 | `copies: 0` | **参考正确**（衍生物不可收藏；ARCHITECTURE §4 要求） |
| 5 天气 / 4 特殊 | 继承上游 Combat 行（如 Biting Frost 有 combat row） | `rows: []` | **参考正确**（天气/特殊无行） |
| Gaunter 组 | `Effect Prefix: Gaunter O'Dimm Darkness`（无冒号） | 21:26 更新为 `Gaunter O'Dimm` / `Gaunter O'Dimm: Darkness` | 需和 nameEn 冒号问题一起看（A-02） |

### E-3 数据面待办（✅ 已闭环，保留记录）

1. **P0 ✅ 已闭环**：`nameEn` 冒号修正（Crone ×3、Gaunter O'Dimm: Darkness ×3）。cardsmith 已把 4 个 id 的 display nameEn 改为官方写法（Crone: Brewess/Weavess/Whispess、Gaunter O'Dimm: Darkness），`research` 未改动；reference 与 src 的结构化 `abilities` 保持逐字段一致。
2. **P1 ✅ 已冻结**：Lead 明确 oracle = `research/reference/cards.final.json + leaders.final.json + factions.final.json`（`gaunter-o-dimm.group` 已改为 `Gaunter O'Dimm: Darkness`；Kambi hero=false 为最终裁定）。`cards.final.json` 21:31 为最新版；`CARD_LIST.md` 已过期，**不作为比对来源**。display nameEn 冒号差异为有意差异（显示名，不参与数据审计）。
3. **P2**：`src/data/db.js` 的 `DECK_RULES.MIN_UNIT_STRENGTH: 0` 无规则依据（W3 无最低力量限制），可保留为 UI 提示用途，但不参与校验即可。
4. **P2**：cardsmith 的 `tests/card-data.test.mjs` 断言 `nameEn === ref.nameEn`，若修 A-02 需同步更新 reference 与断言。
5. **P3（数据观察，非问题）**：份数分布 0×4 / 1×122 / 2×9 / 3×26 / 4×1 / 5×1，与文档"普通单位 1~5、特殊牌 2~3"吻合；其中 `clear-weather`、`torrential-rain` 参考数据为 **2 份**（与 upstream `Occurrences` 一致），而 wiki 阵营指南文字描述为 3 份——**以 reference 2 份为准**，文档 §7 的"2~3"表述正确，无需改。

### E-4 `tests/data-audit.test.mjs`（QA 独立核对，可一键复跑）

- 独立读取 `research/reference/*.json`（不 import 任何业务校验函数），与 `src/data/*.js` 深比较。
- 覆盖：163/22 数量、id 集合、关键字段、abilities 深比较（忽略中文/附加字段）、无重复 id、kebab-case、衍生物约束、Muster group 可解析性（advisory）、预设牌组**独立计数**校验（单位≥22、特殊≤10、份数≤copies、仅本阵营+中立、领袖阵营、非衍生物）。
- `src/data/**` 缺失时输出 SKIP 并 `exit 0`（当前数据已就绪，不会 skip）。

---

## F. 逐章审计表

### F-1 §1 对局总览 / 开局 / 小局流程

| 条目 | 文档内容 | 结论 | 依据/建议 |
|---|---|---|---|
| 双人、同一套规则 | 玩家 vs AI | 一致 | — |
| 牌组构成 | 1 领袖 + ≥22 单位 + ≤10 特殊 | 一致 | rules-main.txt / wiki |
| 三局两胜、各 2 宝石 | 赢局扣对方 1 宝石 | 一致 | rules-main.txt |
| 平局双方各扣 1 | 尼弗迦德例外 | 基本一致；双方均为尼弗迦德未定义 | D-01 |
| 宝石归 0 立即结束；同时归 0 平局 | — | 一致 | — |
| 小局间不自动抽牌 | 手牌 10 为主要资源 | 一致 | rules-main.txt |
| 桌面效果只持续到小局结束 | 天气/号角/曼陀罗清空 | 一致 | — |
| 开局抽 10 张 | — | 一致 | — |
| 被动效果在抽牌后、mulligan 前生效 | Daisy +1 张 | 基本一致（建议明确 Daisy 的 +1 计入起手 11 张） | — |
| 松鼠党决定先手 | 比赛开始一次 | **存疑**（C-05） | 资料冲突；保留裁定 |
| 抛硬币决定先手 | 第一小局先手先行动 | 一致 | — |
| Mulligan ≤2 张、一次完成 | 洗回补抽同量 | 一致 | rules-main.txt |
| 轮流 1 张 / 领袖 1 次 / Pass | 已 Pass 不能再行动 | 一致 | — |
| 手牌 0 自动 Pass | 无领袖能力时 | 基本一致；补 C-27 | — |
| 小局结束结算顺序 | 怪物保留→Avenger→清场→比分→北方→史凯利格→下一局 | **需改**（A-05/A-04/B-06） | 见上 |
| 下一小局先手 | 上局胜方；平局由上局先手方 | **存疑**（C-06） | 无资料；裁定可接受 |
| 3 局 2 胜可能 2:0 结束 | — | 一致 | — |

### F-2 §2 结算（战力计算）

| 条目 | 结论 | 依据/建议 |
|---|---|---|
| 英雄：基础力量、免疫一切 | 一致；但**英雄自身能力仍生效**未写（R-07） | wiki hero cards；data 中英雄带 morale/medic/spy/muster |
| Decoy 占位卡 0 力、不参与加成 | 裁定可接受（C-18） | 资料冲突 |
| 天气：通常降到 1（0 仍 0） | 一致 | — |
| 天气 + King Bran 半效 | **错误/矛盾**（A-03/A-06） | — |
| 天气影响双方 | 一致 | — |
| 间谍翻倍（Treacherous，双方） | 一致；顺序存疑（C-08） | data doubleSpy passive |
| 紧缚 ×n 同排同名 | 一致 | data bond copies 1~4 |
| 士气：同排他人 +1、不含自身、可叠加 | 一致 | — |
| 号角：行 ×2、每行 1 个、英雄不吃 | 一致；号角单位与号角牌共存语义（C-16） | — |
| 计算顺序：天气→间谍→紧缚→士气→号角 | **裁定可接受**，需固化测试（C-09） | — |
| 示例：3×BSC 霜=9、号角=18 | 一致（社区共识，建议单测固化） | — |
| 行总分/玩家总分 | 一致 | — |

### F-3 §2.1 天气

| 条目 | 结论 | 建议 |
|---|---|---|
| 5 种天气（含 Skellige Storm、Clear Weather） | 一致 | — |
| 影响双方；持续到小局结束 | 一致 | — |
| 重复天气无叠加、后牌进墓地 | 一致 | 补 Clear Weather 空放边界（C-28） |
| 多天气可共存；Clear 清全部 | 一致 | 补被清天气牌进墓地（D-10） |
| 天气牌放中央栏、小局结束进墓地 | 一致 | — |

### F-4 §3 单位能力

| 条目 | 结论 | 建议 |
|---|---|---|
| Spy：对方场地、抽 2、英雄间谍同 | 一致 | — |
| Medic：己方墓地非英雄单位、可放弃、触发入场、可连锁、灵巧选行、不可复活英雄/特殊/占位/衍生物；Cow/Kambi 可复活 | 一致 | 补两个例子（修复活间谍/医师） |
| Muster：默认牌堆、Cerys 手牌+牌堆、同组规则、连锁、灵巧行 | **错误/阻断**（A-02） | — |
| Tight Bond | 一致 | — |
| Morale | 一致；措辞"可放在任意行（固定行）"需改（R-23） | — |
| Agile 落子不可移 | 一致 | — |
| Scorch 变体（全场/单行阈值 10） | 一致 | 补 0 力边缘（C-31） |
| Avenger（Cow→BDF 8 近战；Kambi→Hemdall 11 英雄近战） | 一致 | token 行/时机（A-05/C-13） |
| Berserker 变身（14 士气 / 8 紧缚） | 一致 | 牌数守恒协调（C-12） |
| 号角单位 Dandelion/Draig | 一致 | — |
| 曼陀罗单位 Ermion | 一致；与号角特殊位矛盾（B-02） | — |
| Cerys 召唤盾女 | 一致 | — |

### F-5 §4 特殊牌

| 条目 | 结论 | 建议 |
|---|---|---|
| 特殊牌去向 | **矛盾**（B-03） | 改表述 |
| 号角：己方一行、每行 1、与曼陀罗互斥、小局结束墓地 | 一致 | 补 C-16 合法顺序 |
| Decoy：己方场地非英雄、回手、占位 0 力、不可被选中、英雄不能选、触发离场 | **遗漏**（C-17 回收对方间谍归属）+ 存疑（C-18/C-19） | — |
| Mardroeme：任一行（双方）、立即+持续转化、占特殊位 | **存疑**（B-02 与 §3.11 矛盾）；"双方行均可"资料不充分 | — |
| Scorch 特殊牌：全场最强非英雄、并列全毁、当前战力 | 一致 | — |

### F-6 §5 领袖牌（22 张逐条）

| # | 领袖 | 文档 | 结论 |
|---|---|---|---|
| 1 | Foltest: Lord Commander of the North | 清除所有天气 | 一致 |
| 2 | Foltest: King of Temeria | 从牌堆打出 Impenetrable Fog | 一致 |
| 3 | Foltest: The Siegemaster | 己方攻城行号角（已有则无效） | 一致 |
| 4 | Foltest: The Steel-Forged | 敌攻城行≥10 摧毁最强 | 一致 |
| 5 | Foltest: Son of Medell | 敌远程行≥10 摧毁最强 | 一致 |
| 6 | Emhyr: Emperor of Nilfgaard | 看对手随机 3 张手牌 | 一致（补 <3 张边界） |
| 7 | Emhyr: His Imperial Majesty | 从牌堆打出 Torrential Rain | 一致 |
| 8 | Emhyr: The Relentless | 取对手弃牌堆 1 张**单位牌** | **错误**（A-01） |
| 9 | Emhyr: The White Flame | 取消对手领袖（被动） | 裁定可接受（C-21） |
| 10 | Emhyr: Invader of the North | 复活类改随机（双方） | 存疑（C-22 范围过宽） |
| 11 | Eredin: Bringer of Death | 取己方弃牌堆 1 张**单位牌**回手 | **错误**（A-01） |
| 12 | Eredin: Commander of the Red Riders | 己方近战行号角（已有则无效） | 一致 |
| 13 | Eredin: Destroyer of Worlds | 弃 2 抽 1（自选） | 一致（补 C-23） |
| 14 | Eredin: King of the Wild Hunt | 从牌堆打出任意天气 | 一致 |
| 15 | Eredin Bréacc Glas: The Treacherous | 被动：间谍战力 ×2（双方） | 一致 |
| 16 | Francesca: Daisy of the Valley | 被动：开局额外抽 1 | 一致 |
| 17 | Francesca: Pureblood Elf | 从牌堆打出 Biting Frost | 一致 |
| 18 | Francesca: Queen of Dol Blathanna | 敌近战行≥10 摧毁最强 | 一致 |
| 19 | Francesca: The Beautiful | 己方远程行号角 | 一致 |
| 20 | Francesca: Hope of the Aen Seidhe | 灵巧单位移动到最优行 | 裁定可接受（C-26 算法） |
| 21 | Crach an Craite | 双方墓地洗回牌堆 | 一致 |
| 22 | King Bran | 被动：天气只失去一半力量 | **错误/矛盾**（A-03） |

通用：领袖一局比赛 1 次、使用后结束回合、被动不消耗 —— 裁定可接受（C-10/C-11）。

### F-7 §6 阵营能力

| 阵营 | 文档 | 结论 |
|---|---|---|
| 北方 | 赢小局→下一小局开始抽 1 | 一致（注意 B-06 顺序） |
| 尼弗迦德 | 平局获胜（只扣对手） | 一致；双方尼弗迦德未定义（D-01） |
| 松鼠党 | 比赛开始决定先手 | 存疑（C-05） |
| 怪物 | 每小局结束随机保留 1 张（含英雄） | 裁定可接受（C-20） |
| 史凯利格 | 第三小局开始复活 2 张随机单位 | **错误**（漏非英雄，A-04） |

### F-8 §7 牌组 / §8 术语 / §9 裁定

| 条目 | 结论 |
|---|---|
| 阵营收藏 = 本阵营 + 中立 | 一致 |
| 份数上限 = copies | 一致（普通单位实际 1~5，特殊 2~3，见 C-35） |
| 单位≥22、特殊≤10、领袖恰好 1 | 一致；补"领袖须同阵营" |
| 预设牌组 + 自由组牌 | 一致 |
| 换牌 ≤2 | 一致 |
| §8 术语表 | 完整；建议补"衍生物 token""行效果位""宝石" |
| §9 裁定 1-20 | 除 3（Bran 见 A-03）、13（间谍抽牌一致）、14（Avenger 时机 A-05/C-13）、15（清场顺序 B-06）外均可接受；建议新增双方尼弗迦德平局、领袖无目标、Destroyer 边界等裁定 |

---

## G. 给引擎/测试的可执行断言建议（Lead 与 qa 共用）

> 建议加入 `tests/engine.test.mjs` / `tests/scoring.test.mjs`（引擎实现完成后由 QA 复核）。

1. **分数冻结**：双方 Pass 后分数在 Avenger 召唤/怪物保留/清场前后**不变**（A-05）。
2. **英雄免疫 + 英雄能力**：英雄不吃天气/号角/士气/紧缚/翻倍/灼烧/Decoy/医师；但 Isengrim 仍给同行 +1、Menno/Yennefer 仍可复活、Mysterious Elf 仍抽 2、Ermion 仍触发曼陀罗、Cerys/Geralt/Ciri 仍能 Muster。
3. **Bran**：敌我各一张 4 力单位，Bran 方受 Frost；按最终公式 `min(ceil(base/2), base)` 断言（建议 base 1/2/3/4/5 全测：1→1、2→1、3→2、4→2、5→3）。
4. **Bond 顺序**：3×Blue Stripes（4）：Frost → 每张 3（共 9）；再 Horn → 每张 6（共 18）；Morale +1 后再 Horn → (3+1)*2=8/张。
5. **Muster**：打出 Arachas Behemoth → 从牌堆拉 3 张 Arachas，**不拉** Behemoth；三老妪互相召唤（需先修 A-02）；Cerys 从手牌+牌堆拉 3 盾女并触发紧缚。
6. **Decoy**：对手间谍在我方场地 → Decoy 后进**我方手牌**；再次打出应继续放对方场地并抽 2（A-02 相关归属逻辑）。
7. **Avenger**：Decoy Cow → 触发 BDF（按裁定立即或下局）；Cow/Kambi 不进墓地或按裁定处理。
8. **Skellige**：第三小局复活只取非英雄；复活医师可继续复活；复活 Muster 可继续召唤。
9. **Nilfgaard**：平局只扣对手 1 宝石；双方尼弗迦德按 D-01 裁定。
10. **Leader**：每局 1 次；使用后回合结束；Pass 后不可用；白焰取消对手；Treacherous 让双方间谍 ×2（含天气/号角后的顺序）。
11. **Mulligan**：≤2 张、洗回补抽、双方各一次。
12. **牌数守恒**：手牌+牌堆+墓地+场上+天气栏 = 163 原始卡；变身/token 单独登记（C-12）。

---

## H. 文档同步残余项（Lead 已裁定，建议 GAME_RULES.md 补齐；不影响引擎实现）

> 这些是文档层面的收尾项（审计时仍存在，非阻断）。引擎以 Lead 裁定为准；本清单供 Lead 同步文档。

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| I-1 | §1.3 第 6 步 | 仍写"2 张随机**单位牌**"，未同步 §6 的"**非英雄**单位牌"裁定 | 改为"2 张随机非英雄单位牌" |
| I-2 | §9 实现裁定汇总 | 缺少本轮新裁定：任意非衍生物取牌、Bran 公式 `min(ceil(base/2),base)`、史凯利格非英雄、分数冻结、Decoy 归属转移、token 放自身行、英雄自身能力生效、双方尼弗迦德平局、领袖无目标仍消耗 | 在 §9 补 9~10 条（§9 是引擎实现清单，应完整） |
| I-3 | §1.1 第 2 步 | 引用错误"见 §7 领袖被动、§8 阵营能力"（§7 是牌组、§8 是术语表）；"灵能"疑似笔误 | 改为 §5/§6；"灵能/被动"→"领袖被动/阵营开局效果" |
| I-4 | §4 开头 | "特殊牌打出后立即进弃牌堆（但号角/曼陀罗作为行附加效果留在该行）"自相矛盾 | 改为："号角/曼陀罗牌留在行上（占行特殊位），小局结束时进弃牌堆；Decoy 占位卡留到小局结束；Scorch 等其余特殊牌打出后立即进弃牌堆" |
| I-5 | §3.5 | "士气单位可放在任意行（固定行）"自相矛盾 | 改为"士气单位按卡面固定行放置" |
| I-6 | §5 白焰说明 / §3.11 Ermion | 仍保留"可用次数仍为 1？"/"…使用号角？"等疑问句（已裁定却未改成陈述） | 改为陈述句：白焰持有者开局即视为已消耗；Ermion 在场时该行可放号角牌（单位光环+号角牌共存） |
| I-7 | §1.3 第 5~8 步 | "下一小局开始"类能力（北方抽牌、史凯利格复活）排在第 7/8 步"若比赛未结束/宝石归 0 结束"之前；2:0 时可能误触发第三小局能力 | 把"判定比赛是否结束"放在扣宝石后立即执行；仅当比赛继续时才执行第 5/6 步 |
| I-8 | §3.3 | 文档写"牌名完全等于 group 或以 group+':' 开头"，而引擎实际是"uid 排除 + 归一化名匹配 + 家族组规则"（Arachas/Behemoth、Gaunter/Crone 等特例） | 把引擎实际匹配规则写进 §3.3，保持"文档=实现"；或注明 §3.3 是数据约束、引擎实现见 ARCHITECTURE |
| I-9 | §3.7 单行灼烧 | 阈值"≥10"未注明是否用当前有效战力（第 3 点只说了"计算最强"用当前战力） | 补"阈值同样使用当前有效战力" |

---

## I. 引擎实现独立核验（research/qa/rules-verify.mjs）

> 目的：不依赖 Lead 的 `tests/engine.test.mjs`，用**真实 163 张卡数据 + 真实预设牌组**独立复验规则裁定与引擎不变量。
> 运行：`node research/qa/rules-verify.mjs`（只读 src/，不修改业务代码）。

### J-1 覆盖与结果（最终：23/23 通过）

| 分组 | 内容 | 结果 |
|---|---|---|
| §1 计分矩阵（scoring.js 纯函数） | 基础战力、Frost/Fog/Rain/Storm 行范围、King Bran 半效（4→2、5→3、1→1、0→0）、紧缚 ×n、霜+紧缚 9、+号角 18、士气叠加/自身不加/英雄免疫、号角×2/英雄不翻倍/号角单位不自翻、间谍×2 与天气顺序、英雄完全免疫、Decoy 占位不计分 | 11/11 ✅ |
| §2 引擎集成（真实预设） | 开局 10 张+牌堆、Mulligan 2 张、天气影响双方、号角行效果与第二张拒绝、**Decoy 回收对方间谍→归属转移→再打出抽 2**、**Muster（Behemoth→3 Arachas 不拉 Behemoth、Crone 家族组）**、**Avenger 分数冻结（局末 Cow→BDF 不计入刚结束小局，下一小局计 8 力）**、尼弗迦德平局只扣对手、双方尼弗迦德按普通平局、**Decoy 占位卡小局结束清场进墓地** | 12/12 ✅ |
| §3 随机对局不变量 | 10 组真实预设双人随机对局，每步校验：分数=三行和、view 与 computeScores 一致、uid 全场景唯一、cardId 合法、阶段/回合/宝石合法、pending 时无动作、至少 8 组自然结束 | 10 组全通过（均自然结束） ✅ |

### J-2 独立核验发现并已修复的引擎 BUG（回归由本脚本守护）

| # | BUG | 发现方式 | 修复 | 回归用例 |
|---|---|---|---|---|
| 1 | **Decoy 占位卡缺少 `row`/`boardOwner`**：小局结束 `_removeFromBoard` 找不到所在行 → 占位卡残留到下一小局，且同一 uid 同时出现在场上与墓地（牌数守恒/uid 唯一破坏） | QA §3 随机对局不变量（uid 重复报警）+ 定向最小复现 | `src/engine/engine.js` decoy 分支创建占位卡时补齐 `row`/`boardOwner` | rules-verify §2.11 + §3 模糊测试 |
| 2 | **`reviveRow`（医师复活灵巧单位选行）流程缺陷**（Lead 修复，QA 回归覆盖） | 引擎回归 / Lead 自查 | 引擎流程修复 | rules-verify §3 随机对局（医师复活频繁触发） |
| 3 | Muster 家族组 / Gaunter / Arachas-vs-Behemoth 匹配（A-02 修复后回归） | QA 数据审计 + 引擎集成用例 | Lead 重写匹配（uid 排除+归一化名+家族组） | rules-verify §2.6/§2.7 |

### J-3 当前结论

- 截至最终验收：`rules-verify.mjs` **23/23 通过**，未发现与 `GAME_RULES.md`（含 Lead 裁定）冲突的引擎行为。
- 浏览器 E2E：`node scripts/e2e.mjs` 完整对局通过（21 次我方动作 / 10 次 AI 回合 / 3 小局 / 比赛结束 / 结算弹窗数据与引擎一致 / console 0 error / pageerror 0 / HTTP 4xx 0）。
- 可玩性巡检：`node research/qa/final-tour.mjs` **25/25 通过**（1280×800 与 1920×1080 双分辨率、首页/VS/换牌/对局/tooltip/重复天气/号角单位行/结算/组牌器/图鉴，无溢出、无乱码）。
- 遗留仅剩 §H 的**文档表述同步项**与 2 条 P3 观感/文案项（引擎日志 `frost 生效`、`close行` 未本地化），不影响规则正确性与玩法。

---

## J. 审计变更记录

| 时间 | 变更 |
|---|---|
| 2026-10-17 21:45 | 初版：完成 §1~§9 逐条审计、数据核对、A 类阻断问题 6 项、数据面待办 3 项 |
| 2026-10-17 22:00 | 最终验收：新增 §I「引擎实现独立核验」（rules-verify 23/23；记录 Decoy 占位卡/reviveRow 两个 BUG 已修复）；全流程 E2E 与 25/25 可玩性巡检通过；结论：规则/数据/玩法验收通过，仅余 §H 文档同步与 P3 文案项 |
| 2026-10-17 21:38 | 同步 Lead 裁定（全部采纳）：A-01~A-06 标记已修复；新增 §0.1 裁定执行状态表；Bran 公式更新为 `min(ceil(base/2), base)`；数据面更新（4 张 display nameEn 冒号修正、oracle 冻结、data-audit 11/11 绿）；新增 §H 文档同步残余项 |
