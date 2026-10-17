# The Witcher 3 Gwent — 完整牌库参考（英文原始数据）

> 数据来源：witcher.fandom.com（MediaWiki API）+ aboe026/witcher-3-gwent-list 社区整理数据（Occurrences = 可拥有份数）。
> 本文件由脚本生成，供制作 `src/data/cards.js` 使用。中文名/描述需本地化。

## 阵营与阵营能力

- **Northern Realms** (北方领域) `northern-realms` — Draw a card from your deck whenever you win a round.
- **Nilfgaardian Empire** (尼弗迦德帝国) `nilfgaard` — Wins any round that ends in a draw.
- **Scoia'tael** (松鼠党) `scoiatael` — Decide who takes the first turn at the start of the game.
- **Monsters** (怪物) `monsters` — Keeps a random unit card on the battlefield after each round.
- **Skellige** (史凯利格) `skellige` — 2 random unit cards from the graveyard are placed on the battlefield at the start of the third round.

## 领袖牌（22 张）

| id | 阵营 | 名称 | 能力 |
|---|---|---|---|
| `crach-an-craite` | skellige | Crach an Craite | Shuffle all cards from each player's graveyard back into their decks. |
| `emhyr-var-emreis-emperor-of-nilfgaard` | nilfgaard | Emhyr var Emreis: Emperor of Nilfgaard | Look at 3 random cards from your opponent's hand. |
| `emhyr-var-emreis-his-imperial-majesty` | nilfgaard | Emhyr var Emreis: His Imperial Majesty | Pick a Torrential Rain card from your deck and play it instantly. |
| `emhyr-var-emreis-invader-of-the-north` | nilfgaard | Emhyr var Emreis: Invader of the North | Abilities that restore a unit to the battlefield restore a randomly-chosen unit. Affects both players. |
| `emhyr-var-emreis-the-relentless` | nilfgaard | Emhyr var Emreis: The Relentless | Draw a card from your opponent's discard pile. |
| `emhyr-var-emreis-the-white-flame` | nilfgaard | Emhyr var Emreis: The White Flame | Cancel your opponent's Leader Ability. |
| `eredin-breacc-glas-the-treacherous` | monsters | Eredin Bréacc Glas: The Treacherous | Doubles the strength of all spy cards (affects both players). |
| `eredin-bringer-of-death` | monsters | Eredin: Bringer of Death | Restore a card from your discard pile to your hand. |
| `eredin-commander-of-the-red-riders` | monsters | Eredin: Commander of the Red Riders | Double the strength of all your Close Combat units (unless a Commander's horn is also present on that row). |
| `eredin-destroyer-of-worlds` | monsters | Eredin: Destroyer of Worlds | Discard 2 card and draw 1 card of your choice from your deck. |
| `eredin-king-of-the-wild-hunt` | monsters | Eredin: King of the Wild Hunt | Pick any weather card from your deck and play it instantly. |
| `foltest-king-of-temeria` | northern-realms | Foltest: King of Temeria | Pick an Impenetrable Fog card from your deck and play it instantly. |
| `foltest-lord-commander-of-the-north` | northern-realms | Foltest: Lord Commander of the North | Clear any weather effects (resulting from Biting Frost, Torrential Rain or Impenetrable Fog cards) in play. |
| `foltest-son-of-medell` | northern-realms | Foltest: Son of Medell | Destroy your enemy's strongest Ranged Combat unit(s) if the combined strength of all his or her Ranged Combat units is 10 or more. |
| `foltest-the-siegemaster` | northern-realms | Foltest: The Siegemaster | Doubles the strength of all your Siege units (unless a Commander's Horn is also present on that row). |
| `foltest-the-steel-forged` | northern-realms | Foltest: The Steel-Forged | Destroy your enemy's strongest Siege unit(s) if the combined strength of all his or her Siege units is 10 or more. |
| `francesca-findabair-daisy-of-the-valley` | scoiatael | Francesca Findabair: Daisy of the Valley | Draw an extra card at the beginning of the battle |
| `francesca-findabair-hope-of-the-aen-seidhe` | scoiatael | Francesca Findabair: Hope of the Aen Seidhe | Move agile units to whichever valid row maximizes their strength (don't move units already in optimal row). |
| `francesca-findabair-pureblood-elf` | scoiatael | Francesca Findabair: Pureblood Elf | Pick a Biting Frost card from your deck and play it instantly. |
| `francesca-findabair-queen-of-dol-blathanna` | scoiatael | Francesca Findabair: Queen of Dol Blathanna | Destroy your enemy's strongest Close Combat unit(s) if the combined strength of all his or her Close Combat units is 10 or more. |
| `francesca-findabair-the-beautiful` | scoiatael | Francesca Findabair: The Beautiful | Doubles the strength of all your Ranged Combat units (unless a Commander's Horn is also present on that row). |
| `king-bran` | skellige | King Bran | Units only lose half their Strength in bad weather conditions. |

## 卡牌总表（163 张，含 4 张召唤衍生物）

| id | 阵营 | 类型 | 名称 | 力量 | 行 | 份数 | 能力 |
|---|---|---|---|---|---|---|---|
| `albrich` | nilfgaard | unit | Albrich | 2 | ranged | 1 |  |
| `arachas` | monsters | unit | Arachas | 4 | close | 3 | muster:Arachas |
| `arachas-behemoth` | monsters | unit | Arachas Behemoth | 6 | siege | 1 | muster:Arachas |
| `assire-var-anahid` | nilfgaard | unit | Assire var Anahid | 6 | ranged | 1 |  |
| `ballista` | northern-realms | unit | Ballista | 6 | siege | 1 |  |
| `barclay-els` | scoiatael | unit | Barclay Els | 6 | close/ranged | 1 | agile |
| `berserker` | skellige | unit | Berserker | 4 | close | 1 | berserker→transformed-vildkaarl |
| `birna-bran` | skellige | unit | Birna Bran | 2 | close | 1 | medic |
| `biting-frost` | neutral | weather | Biting Frost | — | — | 3 | weather:frost |
| `black-infantry-archer` | nilfgaard | unit | Black Infantry Archer | 10 | ranged | 2 |  |
| `blue-stripes-commando` | northern-realms | unit | Blue Stripes Commando | 4 | close | 3 | bond |
| `blueboy-lugos` | skellige | unit | Blueboy Lugos | 6 | close | 1 |  |
| `botchling` | monsters | unit | Botchling | 4 | close | 1 |  |
| `bovine-defense-force` | neutral | unit | Bovine Defense Force | 8 | close | 0 |  |
| `cahir-mawr-dyffryn-aep-ceallach` | nilfgaard | unit | Cahir Mawr Dyffryn aep Ceallach | 6 | close | 1 |  |
| `catapult` | northern-realms | unit | Catapult | 8 | siege | 2 | bond |
| `celaeno-harpy` | monsters | unit | Celaeno Harpy | 2 | close/ranged | 1 | agile |
| `cerys` | skellige | unit/hero | Cerys | 10 | close | 1 | hero, muster:Clan Drummond Shield Maiden(手牌+牌库) |
| `ciaran-aep-easnillien` | scoiatael | unit | Ciaran aep Easnillien | 3 | close/ranged | 1 | agile |
| `cirilla-fiona-elen-riannon` | neutral | unit/hero | Cirilla Fiona Elen Riannon | 15 | close | 1 | hero, muster:Roach |
| `clan-an-craite-warrior` | skellige | unit | Clan an Craite Warrior | 6 | close | 3 | bond |
| `clan-brokvar-archer` | skellige | unit | Clan Brokvar Archer | 6 | ranged | 3 |  |
| `clan-dimun-pirate` | skellige | unit | Clan Dimun Pirate | 6 | ranged | 1 | scorch:any |
| `clan-drummond-shield-maiden` | skellige | unit | Clan Drummond Shield Maiden | 4 | close | 3 | bond |
| `clan-heymaey-skald` | skellige | unit | Clan Heymaey Skald | 4 | close | 1 |  |
| `clan-tordarroch-armorsmith` | skellige | unit | Clan Tordarroch Armorsmith | 4 | close | 1 |  |
| `clear-weather` | neutral | weather | Clear Weather | — | — | 2 | weather:clear |
| `cockatrice` | monsters | unit | Cockatrice | 2 | ranged | 1 |  |
| `commander-s-horn` | neutral | special | Commander's Horn | — | — | 3 | horn |
| `cow` | neutral | unit | Cow | 0 | ranged | 1 | avenger:bovine-defense-force |
| `crinfrid-reavers-dragon-hunter` | northern-realms | unit | Crinfrid Reavers Dragon Hunter | 5 | ranged | 3 | bond |
| `crone-brewess` | monsters | unit | Crone Brewess | 6 | close | 1 | muster:Crone |
| `crone-weavess` | monsters | unit | Crone Weavess | 6 | close | 1 | muster:Crone |
| `crone-whispess` | monsters | unit | Crone Whispess | 6 | close | 1 | muster:Crone |
| `cynthia` | nilfgaard | unit | Cynthia | 4 | ranged | 1 |  |
| `dandelion` | neutral | unit | Dandelion | 2 | close | 1 | horn |
| `decoy` | neutral | special | Decoy | — | — | 3 | decoy |
| `dennis-cranmer` | scoiatael | unit | Dennis Cranmer | 6 | close | 1 |  |
| `dethmold` | northern-realms | unit | Dethmold | 6 | ranged | 1 |  |
| `dol-blathanna-archer` | scoiatael | unit | Dol Blathanna Archer | 4 | ranged | 1 |  |
| `dol-blathanna-scout` | scoiatael | unit | Dol Blathanna Scout | 6 | close/ranged | 3 | agile |
| `donar-an-hindar` | skellige | unit | Donar an Hindar | 4 | close | 1 |  |
| `draig-bon-dhu` | skellige | unit | Draig Bon-Dhu | 2 | siege | 1 | horn |
| `draug` | monsters | unit/hero | Draug | 10 | close | 1 | hero |
| `dun-banner-medic` | northern-realms | unit | Dun Banner Medic | 5 | siege | 1 | medic |
| `dwarven-skirmisher` | scoiatael | unit | Dwarven Skirmisher | 3 | close | 3 | muster:Dwarven Skirmisher |
| `earth-elemental` | monsters | unit | Earth Elemental | 6 | siege | 1 |  |
| `eithne` | scoiatael | unit/hero | Eithne | 10 | ranged | 1 | hero |
| `elven-skirmisher` | scoiatael | unit | Elven Skirmisher | 2 | ranged | 3 | muster:Elven Skirmisher |
| `emiel-regis-rohellec-terzieff` | neutral | unit | Emiel Regis Rohellec Terzieff | 5 | close | 1 |  |
| `endrega` | monsters | unit | Endrega | 2 | ranged | 1 |  |
| `ermion` | skellige | unit/hero | Ermion | 8 | ranged | 1 | hero, mardroeme |
| `esterad-thyssen` | northern-realms | unit/hero | Esterad Thyssen | 10 | close | 1 | hero |
| `etolian-auxiliary-archers` | nilfgaard | unit | Etolian Auxiliary Archers | 1 | ranged | 2 | medic |
| `fiend` | monsters | unit | Fiend | 6 | close | 1 |  |
| `filavandrel-aen-fidhail` | scoiatael | unit | Filavandrel aen Fidhail | 6 | close/ranged | 1 | agile |
| `fire-elemental` | monsters | unit | Fire Elemental | 6 | siege | 1 |  |
| `foglet` | monsters | unit | Foglet | 2 | close | 1 |  |
| `forktail` | monsters | unit | Forktail | 5 | close | 1 |  |
| `frightener` | monsters | unit | Frightener | 5 | close | 1 |  |
| `fringilla-vigo` | nilfgaard | unit | Fringilla Vigo | 6 | ranged | 1 |  |
| `gargoyle` | monsters | unit | Gargoyle | 2 | ranged | 1 |  |
| `gaunter-o-dimm` | neutral | unit | Gaunter O'Dimm | 2 | siege | 1 | muster:Gaunter O'Dimm Darkness |
| `gaunter-o-dimm-darkness` | neutral | unit | Gaunter O'Dimm Darkness | 4 | ranged | 3 | muster:Gaunter O'Dimm Darkness |
| `geralt-of-rivia` | neutral | unit/hero | Geralt of Rivia | 15 | close | 1 | hero, muster:Roach |
| `ghoul` | monsters | unit | Ghoul | 1 | close | 3 | muster:Ghoul |
| `grave-hag` | monsters | unit | Grave Hag | 5 | ranged | 1 |  |
| `griffin` | monsters | unit | Griffin | 5 | close | 1 |  |
| `harpy` | monsters | unit | Harpy | 2 | close/ranged | 1 | agile |
| `havekar-healer` | scoiatael | unit | Havekar Healer | 0 | ranged | 3 | medic |
| `havekar-smuggler` | scoiatael | unit | Havekar Smuggler | 5 | close | 3 | muster:Havekar Smuggler |
| `heavy-zerrikanian-fire-scorpion` | nilfgaard | unit | Heavy Zerrikanian Fire Scorpion | 10 | siege | 1 |  |
| `hemdall` | skellige | unit/hero | Hemdall | 11 | close | 0 | hero |
| `hjalmar` | skellige | unit/hero | Hjalmar | 10 | ranged | 1 | hero |
| `holger-blackhand` | skellige | unit | Holger Blackhand | 4 | siege | 1 |  |
| `ice-giant` | monsters | unit | Ice Giant | 5 | siege | 1 |  |
| `ida-emean-aep-sivney` | scoiatael | unit | Ida Emean aep Sivney | 6 | ranged | 1 |  |
| `imlerith` | monsters | unit/hero | Imlerith | 10 | close | 1 | hero |
| `impenetrable-fog` | neutral | weather | Impenetrable Fog | — | — | 3 | weather:fog |
| `impera-brigade-guard` | nilfgaard | unit | Impera Brigade Guard | 3 | close | 4 | bond |
| `iorveth` | scoiatael | unit/hero | Iorveth | 10 | ranged | 1 | hero |
| `isengrim-faoiltiarna` | scoiatael | unit/hero | Isengrim Faoiltiarna | 10 | close | 1 | hero, morale |
| `john-natalis` | northern-realms | unit/hero | John Natalis | 10 | close | 1 | hero |
| `kaedweni-siege-expert` | northern-realms | unit | Kaedweni Siege Expert | 1 | siege | 1 | morale |
| `kambi` | skellige | unit | Kambi | 0 | close | 1 | avenger:hemdall |
| `kayran` | monsters | unit/hero | Kayran | 8 | close/ranged | 1 | hero, morale, agile |
| `keira-metz` | northern-realms | unit | Keira Metz | 5 | ranged | 1 |  |
| `leshen` | monsters | unit/hero | Leshen | 10 | ranged | 1 | hero |
| `letho-of-gulet` | nilfgaard | unit/hero | Letho of Gulet | 10 | close | 1 | hero |
| `light-longship` | skellige | unit | Light Longship | 4 | ranged | 3 | muster:Light Longship |
| `madman-lugos` | skellige | unit | Madman Lugos | 6 | close | 1 |  |
| `mahakaman-defender` | scoiatael | unit | Mahakaman Defender | 5 | close | 5 |  |
| `mardroeme` | skellige | special | Mardroeme | — | — | 3 | mardroeme |
| `menno-coehoorn` | nilfgaard | unit/hero | Menno Coehoorn | 10 | close | 1 | hero, medic |
| `milva` | scoiatael | unit | Milva | 10 | ranged | 1 | morale |
| `morteisen` | nilfgaard | unit | Morteisen | 3 | close | 1 |  |
| `morvran-voorhis` | nilfgaard | unit/hero | Morvran Voorhis | 10 | siege | 1 | hero |
| `mysterious-elf` | neutral | unit/hero | Mysterious Elf | 0 | close | 1 | hero, spy |
| `nausicaa-cavalry-rider` | nilfgaard | unit | Nausicaa Cavalry Rider | 2 | close | 3 | bond |
| `nekker` | monsters | unit | Nekker | 2 | close | 3 | muster:Nekker |
| `olaf` | skellige | unit | Olaf | 12 | close/ranged | 1 | morale, agile |
| `olgierd-von-everec` | neutral | unit | Olgierd Von Everec | 6 | close/ranged | 1 | morale, agile |
| `philippa-eilhart` | northern-realms | unit/hero | Philippa Eilhart | 10 | ranged | 1 | hero |
| `plague-maiden` | monsters | unit | Plague Maiden | 5 | close | 1 |  |
| `poor-fucking-infantry` | northern-realms | unit | Poor Fucking Infantry | 1 | close | 3 | bond |
| `prince-stennis` | northern-realms | unit | Prince Stennis | 5 | close | 1 | spy |
| `puttkammer` | nilfgaard | unit | Puttkammer | 3 | ranged | 1 |  |
| `rainfarn` | nilfgaard | unit | Rainfarn | 4 | close | 1 |  |
| `redanian-foot-soldier` | northern-realms | unit | Redanian Foot Soldier | 1 | close | 2 |  |
| `renuald-aep-matsen` | nilfgaard | unit | Renuald aep Matsen | 5 | ranged | 1 |  |
| `riordain` | scoiatael | unit | Riordain | 1 | ranged | 1 |  |
| `roach` | neutral | unit | Roach | 3 | close | 1 |  |
| `rotten-mangonel` | nilfgaard | unit | Rotten Mangonel | 3 | siege | 1 |  |
| `sabrina-glevissig` | northern-realms | unit | Sabrina Glevissig | 4 | ranged | 1 |  |
| `saesenthessis` | scoiatael | unit/hero | Saesenthessis | 10 | ranged | 1 | hero |
| `schirru` | scoiatael | unit | Schirru | 8 | siege | 1 | scorch:row:siege |
| `scorch` | neutral | special | Scorch | — | — | 3 | scorch:any |
| `sheldon-skaggs` | northern-realms | unit | Sheldon Skaggs | 4 | ranged | 1 |  |
| `shilard-fitz-oesterlen` | nilfgaard | unit | Shilard Fitz-Oesterlen | 7 | close | 1 | spy |
| `siege-engineer` | nilfgaard | unit | Siege Engineer | 6 | siege | 1 |  |
| `siege-technician` | nilfgaard | unit | Siege Technician | 0 | siege | 1 | medic |
| `siege-tower` | northern-realms | unit | Siege Tower | 6 | siege | 1 |  |
| `siegfried-of-denesle` | northern-realms | unit | Siegfried of Denesle | 5 | close | 1 |  |
| `sigismund-dijkstra` | northern-realms | unit | Sigismund Dijkstra | 4 | close | 1 | spy |
| `sile-de-tansarville` | northern-realms | unit | Sile de Tansarville | 4 | close | 1 |  |
| `skellige-storm` | neutral | weather | Skellige Storm | — | — | 3 | weather:storm |
| `stefan-skellen` | nilfgaard | unit | Stefan Skellen | 9 | close | 1 | spy |
| `svanrige` | skellige | unit | Svanrige | 4 | close | 1 |  |
| `sweers` | nilfgaard | unit | Sweers | 2 | ranged | 1 |  |
| `thaler` | northern-realms | unit | Thaler | 1 | siege | 1 | spy |
| `tibor-eggebracht` | nilfgaard | unit/hero | Tibor Eggebracht | 10 | ranged | 1 | hero |
| `toad` | monsters | unit | Toad | 7 | ranged | 1 | scorch:row:ranged |
| `torrential-rain` | neutral | weather | Torrential Rain | — | — | 2 | weather:rain |
| `toruviel` | scoiatael | unit | Toruviel | 2 | ranged | 1 |  |
| `transformed-vildkaarl` | skellige | unit | Transformed Vildkaarl | 14 | close | 0 | morale |
| `transformed-young-vildkaarl` | skellige | unit | Transformed Young Vildkaarl | 8 | ranged | 0 | bond |
| `trebuchet` | northern-realms | unit | Trebuchet | 6 | siege | 2 |  |
| `triss-merigold` | neutral | unit/hero | Triss Merigold | 7 | close | 1 | hero |
| `udalryk` | skellige | unit | Udalryk | 4 | close | 1 |  |
| `vampire-bruxa` | monsters | unit | Vampire: Bruxa | 4 | close | 1 | muster:Vampire |
| `vampire-ekimmara` | monsters | unit | Vampire: Ekimmara | 4 | close | 1 | muster:Vampire |
| `vampire-fleder` | monsters | unit | Vampire: Fleder | 4 | close | 1 | muster:Vampire |
| `vampire-garkain` | monsters | unit | Vampire: Garkain | 4 | close | 1 | muster:Vampire |
| `vampire-katakan` | monsters | unit | Vampire: Katakan | 5 | close | 1 | muster:Vampire |
| `vanhemar` | nilfgaard | unit | Vanhemar | 4 | ranged | 1 |  |
| `vattier-de-rideaux` | nilfgaard | unit | Vattier de Rideaux | 4 | close | 1 | spy |
| `vernon-roche` | northern-realms | unit/hero | Vernon Roche | 10 | close | 1 | hero |
| `ves` | northern-realms | unit | Ves | 5 | close | 1 |  |
| `vesemir` | neutral | unit | Vesemir | 6 | close | 1 |  |
| `villentretenmerth` | neutral | unit | Villentretenmerth | 7 | close | 1 | scorch:row:close |
| `vreemde` | nilfgaard | unit | Vreemde | 2 | close | 1 |  |
| `vrihedd-brigade-recruit` | scoiatael | unit | Vrihedd Brigade Recruit | 4 | ranged | 1 |  |
| `vrihedd-brigade-veteran` | scoiatael | unit | Vrihedd Brigade Veteran | 5 | close/ranged | 2 | agile |
| `war-longship` | skellige | unit | War Longship | 6 | siege | 3 | bond |
| `werewolf` | monsters | unit | Werewolf | 5 | close | 1 |  |
| `wyvern` | monsters | unit | Wyvern | 2 | ranged | 1 |  |
| `yaevinn` | scoiatael | unit | Yaevinn | 6 | close/ranged | 1 | agile |
| `yarpen-zigrin` | northern-realms | unit | Yarpen Zigrin | 2 | close | 1 |  |
| `yennefer-of-vengerberg` | neutral | unit/hero | Yennefer of Vengerberg | 7 | ranged | 1 | hero, medic |
| `young-berserker` | skellige | unit | Young Berserker | 2 | ranged | 3 | berserker→transformed-young-vildkaarl |
| `young-emissary` | nilfgaard | unit | Young Emissary | 5 | close | 2 | bond |
| `zerrikanian-fire-scorpion` | nilfgaard | unit | Zerrikanian Fire Scorpion | 5 | siege | 1 |  |
| `zoltan-chivay` | neutral | unit | Zoltan Chivay | 5 | close | 1 |  |