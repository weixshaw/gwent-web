/**
 * Pure scoring helpers.  All power calculations must live here so the rules
 * (docs/GAME_RULES.md §2) are implemented in exactly one place.
 *
 * Canonical order:
 *   hero immunity -> decoy 0 -> weather (or King Bran half) -> spy doubling
 *   -> tight bond multiplier -> morale (+1 per other morale unit) -> horn x2
 */

export const ROW_KEYS = ['close', 'ranged', 'siege'];

export function abilityIds(card) {
  return (card?.abilities ?? []).map((a) => (typeof a === 'string' ? a : a.id));
}

export function hasAbility(card, id) {
  return abilityIds(card).includes(id);
}

export function getAbility(card, id) {
  return (card?.abilities ?? []).find((a) => (typeof a === 'string' ? a : a.id) === id) ?? null;
}

/** Which rows a weather id affects. */
export const WEATHER_ROWS = {
  frost: ['close'],
  fog: ['ranged'],
  rain: ['siege'],
  storm: ['ranged', 'siege'],
  clear: [],
};

export const WEATHER_LABELS = {
  frost: 'Biting Frost',
  fog: 'Impenetrable Fog',
  rain: 'Torrential Rain',
  storm: 'Skellige Storm',
  clear: 'Clear Weather',
};

/** Row specials (horn / mardroeme) are stored as state.players[p].rowSpecials[row] = {kind, uid}. */
export function rowHornSources(state, p, row, cardDb) {
  let count = 0;
  const special = state.players[p].rowSpecials?.[row];
  if (special?.kind === 'horn') count += 1;
  for (const inst of state.players[p].rows[row]) {
    const card = cardDb[inst.cardId];
    if (card && card.type === 'unit' && hasAbility(card, 'horn')) count += 1;
  }
  return count;
}

export function rowHasMardroeme(state, p, row, cardDb) {
  const special = state.players[p].rowSpecials?.[row];
  if (special?.kind === 'mardroeme') return true;
  for (const inst of state.players[p].rows[row]) {
    const card = cardDb[inst.cardId];
    if (card && card.type === 'unit' && hasAbility(card, 'mardroeme')) return true;
  }
  return false;
}

/** Does weather affect this row type right now? */
export function weatherAffects(state, row) {
  for (const [kind, rows] of Object.entries(WEATHER_ROWS)) {
    if (rows.includes(row) && state.weather?.[kind]) return true;
  }
  return false;
}

export function playerHasPassive(state, p, passive) {
  return state.players[p].passives?.includes(passive) ?? false;
}

/**
 * Compute every unit's effective power for one row.
 * @returns {{cards: Array<{inst, card, power, breakdown}>, total:number, horn:boolean, mardroeme:boolean}}
 */
export function computeRow(state, p, row, cardDb) {
  const insts = state.players[p].rows[row] ?? [];
  const units = insts
    .map((inst) => ({ inst, card: cardDb[inst.cardId] }))
    .filter((x) => x.card && x.card.type === 'unit');

  const weather = weatherAffects(state, row);
  const doubleSpy = state.passives?.doubleSpy ?? false;
  const halfWeather = playerHasPassive(state, p, 'halfWeather');
  const hornSources = rowHornSources(state, p, row, cardDb);
  const hornActive = hornSources > 0;
  const mardroeme = rowHasMardroeme(state, p, row, cardDb);

  const bondCounts = new Map();
  for (const { inst, card } of units) {
    if (hasAbility(card, 'bond')) {
      bondCounts.set(inst.cardId, (bondCounts.get(inst.cardId) ?? 0) + 1);
    }
  }
  const moraleCount = units.filter(({ card }) => hasAbility(card, 'morale')).length;

  const cards = units.map(({ inst, card }) => {
    const base = card.strength ?? 0;
    const breakdown = { base, weather: false, spyDouble: false, bond: 1, morale: 0, horn: false, hero: !!card.hero };
    let power = base;

    if (card.hero) {
      cardsPush(inst, card, power, breakdown, card);
      return { inst, card, power, breakdown };
    }

    if (weather) {
      // King Bran: unit only *loses half* its strength (rounded down), so base 1 -> 1.
      const min = halfWeather ? Math.ceil(base / 2) : 1;
      power = Math.min(min, base);
      breakdown.weather = true;
    }
    if (doubleSpy && hasAbility(card, 'spy')) {
      power *= 2;
      breakdown.spyDouble = true;
    }
    if (hasAbility(card, 'bond')) {
      const n = bondCounts.get(inst.cardId) ?? 1;
      if (n > 1) {
        power *= n;
        breakdown.bond = n;
      }
    }
    const ownMorale = hasAbility(card, 'morale');
    const morale = Math.max(0, moraleCount - (ownMorale ? 1 : 0));
    if (morale > 0) {
      power += morale;
      breakdown.morale = morale;
    }
    if (hornActive) {
      const isHornUnit = hasAbility(card, 'horn');
      if (!isHornUnit || hornSources > 1) {
        power *= 2;
        breakdown.horn = true;
      }
    }
    return { inst, card, power, breakdown };
  });

  return {
    cards,
    total: cards.reduce((sum, c) => sum + c.power, 0),
    horn: hornActive,
    mardroeme,
  };
}

function cardsPush() {
  /* no-op helper kept for readability; card computation above is self-contained */
}

export function computeAllRows(state, p, cardDb) {
  const rows = {};
  let score = 0;
  for (const row of ROW_KEYS) {
    const computed = computeRow(state, p, row, cardDb);
    rows[row] = computed;
    score += computed.total;
  }
  return { rows, score };
}

export function computeScores(state, cardDb) {
  return state.players.map((_, p) => computeAllRows(state, p, cardDb));
}

/** Row total for a specific player/row. */
export function rowTotal(state, p, row, cardDb) {
  return computeRow(state, p, row, cardDb).total;
}

/** Every non-hero unit on the board with its current power. */
export function allUnits(state, cardDb) {
  const out = [];
  state.players.forEach((pl, p) => {
    for (const row of ROW_KEYS) {
      const computed = computeRow(state, p, row, cardDb);
      for (const entry of computed.cards) {
        if (!entry.card.hero) out.push({ ...entry, p, row });
      }
    }
  });
  return out;
}

/** Strongest non-hero unit(s) on the whole board. */
export function strongestOnBoard(state, cardDb) {
  const units = allUnits(state, cardDb);
  if (!units.length) return [];
  const max = Math.max(...units.map((u) => u.power));
  return units.filter((u) => u.power === max);
}

/** Strongest non-hero unit(s) of a specific player's row. */
export function strongestInRow(state, p, row, cardDb) {
  const computed = computeRow(state, p, row, cardDb);
  const units = computed.cards.filter((c) => !c.card.hero);
  if (!units.length) return [];
  const max = Math.max(...units.map((u) => u.power));
  return units.filter((u) => u.power === max);
}

/** Effective power lookup for one unit (fallback 0). */
export function powerOf(state, uid, cardDb) {
  for (let p = 0; p < state.players.length; p++) {
    for (const row of ROW_KEYS) {
      const computed = computeRow(state, p, row, cardDb);
      const found = computed.cards.find((c) => c.inst.uid === uid);
      if (found) return found.power;
    }
  }
  return 0;
}
