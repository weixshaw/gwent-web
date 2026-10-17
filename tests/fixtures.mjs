/**
 * Test fixtures: a miniature card database that exercises every rule in the
 * engine.  Real card data lives in src/data/ and is validated separately.
 */

const unit = (id, over = {}) => ({
  id,
  nameEn: over.nameEn ?? id,
  nameZh: over.nameZh ?? id,
  faction: over.faction ?? 'neutral',
  type: 'unit',
  hero: !!over.hero,
  rows: over.rows ?? ['close'],
  strength: over.strength ?? 0,
  copies: over.copies ?? 3,
  deckable: over.deckable !== false,
  abilities: over.abilities ?? [],
  ...over,
});
const special = (id, abilities, over = {}) => ({
  id,
  nameEn: over.nameEn ?? id,
  nameZh: over.nameZh ?? id,
  faction: 'neutral',
  type: 'special',
  hero: false,
  rows: [],
  strength: null,
  copies: 3,
  deckable: true,
  abilities,
});
const weather = (id, kind) => ({
  id,
  nameEn: id,
  nameZh: id,
  faction: 'neutral',
  type: 'weather',
  hero: false,
  rows: [],
  strength: null,
  copies: 3,
  deckable: true,
  abilities: [{ id: 'weather', weather: kind }],
});

export const CARDS = {};
const add = (...cards) => cards.forEach((c) => (CARDS[c.id] = c));

add(
  // vanilla units / rows
  unit('soldier', { strength: 4, rows: ['close'], copies: 5 }),
  unit('archer', { strength: 5, rows: ['ranged'], copies: 5 }),
  unit('siege', { strength: 6, rows: ['siege'], copies: 5 }),
  unit('agile', { strength: 3, rows: ['close', 'ranged'], abilities: [{ id: 'agile' }] }),
  // bond
  unit('bond', { strength: 4, rows: ['close'], copies: 4, abilities: [{ id: 'bond' }] }),
  // morale / horn / hero
  unit('morale', { strength: 2, rows: ['close'], abilities: [{ id: 'morale' }] }),
  unit('hornman', { strength: 2, rows: ['close'], abilities: [{ id: 'horn' }] }),
  unit('hero', { strength: 15, rows: ['close'], hero: true, copies: 1 }),
  unit('hero-morale', { strength: 8, rows: ['ranged'], hero: true, copies: 1, abilities: [{ id: 'hero' }, { id: 'morale' }] }),
  // spy / medic
  unit('spy', { strength: 1, rows: ['close'], abilities: [{ id: 'spy', draw: 2 }] }),
  unit('medic', { strength: 0, rows: ['ranged'], abilities: [{ id: 'medic' }] }),
  unit('revived', { strength: 7, rows: ['close'] }),
  // muster
  unit('muster', { strength: 4, rows: ['close'], abilities: [{ id: 'muster', group: 'muster', from: ['deck'] }] }),
  unit('muster-copy', { strength: 4, rows: ['close'], nameEn: 'muster', abilities: [{ id: 'muster', group: 'muster', from: ['deck'] }], copies: 2 }),
  unit('behemoth', { strength: 6, rows: ['siege'], abilities: [{ id: 'muster', group: 'Arachas', from: ['deck'] }] }),
  unit('arachas', { strength: 4, rows: ['close'], copies: 3, abilities: [{ id: 'muster', group: 'Arachas', from: ['deck'] }] }),
  // scourge
  unit('scorcher', { strength: 6, rows: ['close'], abilities: [{ id: 'scorch', mode: 'any' }] }),
  unit('row-scorcher', { strength: 7, rows: ['close'], abilities: [{ id: 'scorch', mode: 'row', row: 'close', requireEnemyRowTotalAtLeast: 10 }] }),
  // avenger
  unit('cow', { strength: 0, rows: ['ranged'], abilities: [{ id: 'avenger', token: 'bdf' }] }),
  unit('bdf', { strength: 8, rows: ['close'], deckable: false, copies: 0 }),
  // berserker
  unit('berserk', { strength: 4, rows: ['close'], abilities: [{ id: 'berserker', transformTo: 'bear' }] }),
  unit('bear', { strength: 14, rows: ['close'], deckable: false, copies: 0, abilities: [{ id: 'morale' }] }),
  // family-group muster (colon names)
  unit('crone-a', { strength: 6, rows: ['close'], nameEn: 'Crone: Brewess', abilities: [{ id: 'muster', group: 'Crone', from: ['deck'] }] }),
  unit('crone-b', { strength: 6, rows: ['close'], nameEn: 'Crone: Weavess', abilities: [{ id: 'muster', group: 'Crone', from: ['deck'] }] }),
  unit('crone-c', { strength: 6, rows: ['close'], nameEn: 'Crone: Whispess', abilities: [{ id: 'muster', group: 'Crone', from: ['deck'] }] }),
  unit('gaunter', { strength: 2, rows: ['siege'], nameEn: "Gaunter O'Dimm", abilities: [{ id: 'muster', group: "Gaunter O'Dimm: Darkness", from: ['deck'] }] }),
  unit('gaunter-dark', { strength: 4, rows: ['ranged'], nameEn: "Gaunter O'Dimm: Darkness", copies: 3, abilities: [{ id: 'muster', group: "Gaunter O'Dimm: Darkness", from: ['deck'] }] }),
  unit('lone-behemoth', { strength: 6, rows: ['siege'], copies: 1, nameEn: 'Arachas Behemoth', abilities: [{ id: 'muster', group: 'Arachas', from: ['deck'] }] }),
  // cerys-style summon set
  unit('cerys', { strength: 10, rows: ['close'], hero: true, copies: 1, abilities: [{ id: 'hero' }, { id: 'muster', group: 'maiden', from: ['deck', 'hand'] }] }),
  unit('maiden', { strength: 4, rows: ['close'], copies: 3, abilities: [{ id: 'bond' }] }),
  // specials
  special('horn', [{ id: 'horn' }]),
  special('decoy', [{ id: 'decoy' }]),
  special('scorch', [{ id: 'scorch', mode: 'any' }]),
  special('mardroeme', [{ id: 'mardroeme' }]),
  weather('frost', 'frost'),
  weather('fog', 'fog'),
  weather('rain', 'rain'),
  weather('storm', 'storm'),
  weather('clear', 'clear'),
);

export const LEADERS = {
  'l-north': { id: 'l-north', faction: 'northern-realms', nameEn: 'North Leader', nameZh: '北方领袖', abilities: [{ id: 'clearWeather' }] },
  'l-nilf': { id: 'l-nilf', faction: 'nilfgaard', nameEn: 'Nilf Leader', nameZh: '尼弗迦德领袖', abilities: [{ id: 'clearWeather' }] },
  'l-elf': { id: 'l-elf', faction: 'scoiatael', nameEn: 'Elf Leader', nameZh: '松鼠党领袖', abilities: [{ id: 'clearWeather' }] },
  'l-mons': { id: 'l-mons', faction: 'monsters', nameEn: 'Monster Leader', nameZh: '怪物领袖', abilities: [{ id: 'clearWeather' }] },
  'l-skell': { id: 'l-skell', faction: 'skellige', nameEn: 'Skellige Leader', nameZh: '史凯利格领袖', abilities: [{ id: 'clearWeather' }] },
  // active ability leaders for tests
  'l-weather': { id: 'l-weather', faction: 'northern-realms', nameEn: 'Weather Leader', nameZh: '天气领袖', abilities: [{ id: 'playWeatherFromDeck', weather: 'frost' }] },
  'l-horn': { id: 'l-horn', faction: 'northern-realms', nameEn: 'Horn Leader', nameZh: '号角领袖', abilities: [{ id: 'leaderHorn', row: 'close' }] },
  'l-scorch': { id: 'l-scorch', faction: 'northern-realms', nameEn: 'Scorch Leader', nameZh: '灼烧领袖', abilities: [{ id: 'scorchRow', row: 'close', requireEnemyRowTotalAtLeast: 10 }] },
  'l-shuffle': { id: 'l-shuffle', faction: 'skellige', nameEn: 'Shuffle Leader', nameZh: '洗牌领袖', abilities: [{ id: 'shuffleGraveyards' }] },
  'l-revive': { id: 'l-revive', faction: 'monsters', nameEn: 'Revive Leader', nameZh: '复活领袖', abilities: [{ id: 'takeGraveyardUnitToHand', from: 'own' }] },
  'l-discard': { id: 'l-discard', faction: 'monsters', nameEn: 'Discard Leader', nameZh: '弃牌领袖', abilities: [{ id: 'discardDraw', discard: 2, draw: 1 }] },
  'l-passive-spy': { id: 'l-passive-spy', faction: 'monsters', nameEn: 'Spy Leader', nameZh: '间谍领袖', abilities: [{ id: 'doubleSpy', passive: true }] },
  'l-passive-half': { id: 'l-passive-half', faction: 'skellige', nameEn: 'Half Weather Leader', nameZh: '半天气领袖', abilities: [{ id: 'halfWeather', passive: true }] },
  'l-passive-extra': { id: 'l-passive-extra', faction: 'scoiatael', nameEn: 'Extra Draw Leader', nameZh: '多抽领袖', abilities: [{ id: 'drawExtraStart', count: 1, passive: true }] },
  'l-white-flame': { id: 'l-white-flame', faction: 'nilfgaard', nameEn: 'White Flame', nameZh: '白焰', abilities: [{ id: 'cancelLeader' }] },
};
