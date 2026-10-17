/**
 * Deterministic seeded RNG (mulberry32) + helpers.
 * Engine state stores `rngState`, so every random decision is reproducible.
 */

export function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  const str = String(seed ?? 'gwent');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function nextRandom(state) {
  // mulberry32 step, mutates state.rngState
  let t = (state.rngState = (state.rngState + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randInt(state, n) {
  if (n <= 0) return 0;
  return Math.floor(nextRandom(state) * n);
}

export function randFloat(state) {
  return nextRandom(state);
}

export function shuffle(state, arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(state, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function pickRandom(state, arr) {
  if (!arr.length) return null;
  return arr[randInt(state, arr.length)];
}

export function pickRandomMany(state, arr, n) {
  const pool = arr.slice();
  const out = [];
  while (out.length < n && pool.length) {
    const i = randInt(state, pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

export function coinFlip(state) {
  return nextRandom(state) < 0.5 ? 0 : 1;
}
