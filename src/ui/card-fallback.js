/**
 * Fallback card renderer (Lead-owned, used only while src/ui/card-render.js is
 * unavailable, or as a resilient fallback if the real renderer throws).
 * Implements the same contract as docs/ARCHITECTURE.md §6 but with simple markup.
 *
 * The real visual renderer (visualist) takes precedence whenever it loads.
 */

const FACTION_VAR = {
  'northern-realms': 'nr',
  nilfgaard: 'ng',
  scoiatael: 'st',
  monsters: 'mo',
  skellige: 'sk',
  neutral: 'neutral',
};

const MOTIF_GLYPH = {
  monster: '☠',
  beast: '🐾',
  warrior: '⚔',
  mage: '✦',
  elf: '➶',
  dwarf: '⚒',
  vampire: '🦇',
  witch: '☾',
  spirit: '✧',
  hero: '✵',
  siege: '⌂',
  spell: '✶',
  weather: '❄',
  leader: '♛',
  token: '◆',
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initCardRenderer() {
  /* no precomputation needed */
}

export function createCardEl(card, opts = {}) {
  const size = opts.size || 'md';
  const el = document.createElement('div');
  el.className = [
    'gt-card',
    'gt-fb-card',
    `gt-card--${FACTION_VAR[card.faction] || 'neutral'}`,
    card.hero ? 'gt-card--hero' : '',
    card.type === 'special' ? 'gt-card--special' : '',
    card.type === 'weather' ? 'gt-card--weather' : '',
    `gt-card--${size}`,
    opts.interactive ? 'is-interactive' : '',
    opts.className || '',
  ]
    .filter(Boolean)
    .join(' ');
  el.dataset.cardId = card.id;
  if (opts.faceDown) {
    el.classList.add('is-facedown');
    el.innerHTML = `<div class="gt-fb-back">⚜</div>`;
    return el;
  }
  const motif = card.art?.motif || (card.hero ? 'hero' : card.type === 'special' ? 'spell' : card.type === 'weather' ? 'weather' : 'monster');
  const glyph = MOTIF_GLYPH[motif] || '✦';
  const power = card.strength ?? '';
  el.innerHTML = `
    <div class="gt-fb-art" aria-hidden="true"><span class="gt-fb-glyph">${esc(glyph)}</span><span class="gt-fb-sigil">${esc(card.nameEn?.[0] || '·')}</span></div>
    <div class="gt-fb-name serif">${esc(card.nameZh || card.nameEn || card.id)}</div>
    <div class="gt-fb-en">${esc(card.nameEn || '')}</div>
    <div class="gt-fb-ability">${esc((card.abilityZh || '').split('\n')[0] || (card.type === 'weather' ? '天气牌' : card.type === 'special' ? '特殊牌' : ''))}</div>
    ${power === '' ? '' : `<div class="gt-card__power">${power}</div>`}
    <div class="gt-fb-row">${(card.rows || []).map((r) => ({ close: '近', ranged: '远', siege: '攻' }[r] || '')).join('·') || (card.type === 'weather' ? '天' : '')}</div>
  `;
  return el;
}

export function setCardPower(el, power, opts = {}) {
  if (!el) return;
  let node = el.querySelector('.gt-card__power');
  if (power === null || power === undefined || power === '') {
    if (node) node.remove();
    return;
  }
  if (!node) {
    node = document.createElement('div');
    node.className = 'gt-card__power';
    el.appendChild(node);
  }
  const prev = Number(node.dataset.power || 0);
  node.textContent = String(power);
  node.dataset.power = String(power);
  if (opts.animate !== false && Number(power) !== prev) {
    node.classList.remove('is-up', 'is-down');
    void node.offsetWidth;
    node.classList.add(Number(power) > prev ? 'is-up' : 'is-down');
  }
}

export function setCardState(el, state) {
  if (!el) return;
  el.classList.remove('is-selected', 'is-target', 'is-disabled', 'is-just-played');
  if (state && state !== 'normal') el.classList.add(`is-${state}`);
}

export function createCardBack(factionId = 'neutral', size = 'md') {
  const el = document.createElement('div');
  el.className = `gt-card gt-card--back gt-card--${FACTION_VAR[factionId] || 'neutral'} gt-card--${size}`;
  el.innerHTML = '<div class="gt-fb-back">⚜</div>';
  return el;
}

export function createLeaderCardEl(leader, opts = {}) {
  const el = document.createElement('div');
  el.className = `gt-card gt-fb-card gt-fb-leader gt-card--${FACTION_VAR[leader.faction] || 'neutral'} gt-card--${opts.size || 'sm'}`;
  el.dataset.leaderId = leader.id;
  el.innerHTML = `
    <div class="gt-fb-art gt-fb-art--leader" aria-hidden="true"><span class="gt-fb-glyph">♛</span></div>
    <div class="gt-fb-name serif">${esc(leader.nameZh || leader.nameEn)}</div>
    <div class="gt-fb-ability">${esc(leader.abilityZh || leader.abilityEn || '')}</div>
    <div class="gt-fb-leader-state"></div>
  `;
  return el;
}

export function renderRowIcon(row) {
  const glyph = { close: '⚔', ranged: '➶', siege: '⌂', weather: '❄', agile: '⇄' }[row] || '◆';
  return `<span class="gt-row-icon">${glyph}</span>`;
}

export function getCardArtDataUrl() {
  return '';
}

export function preloadArt() {}

export default {
  initCardRenderer,
  createCardEl,
  setCardPower,
  setCardState,
  createCardBack,
  createLeaderCardEl,
  renderRowIcon,
  getCardArtDataUrl,
  preloadArt,
};
