/**
 * Card / leader tooltip singleton.  Owner: Lead.
 * API: showCardTooltip(card, anchorEl), showLeaderTooltip(leader, anchorEl, extra), hideTooltip()
 */

import { getCard, getFaction } from '../data/db.js';

let root = null;
let currentAnchor = null;
let hideTimer = 0;

const ROW_LABEL = { close: '近战', ranged: '远程', siege: '攻城' };
const TYPE_LABEL = { unit: '单位', special: '特殊', weather: '天气' };

function ensureRoot() {
  if (!root) root = document.getElementById('tooltip-root');
  return root;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function position(el, anchor) {
  if (!anchor || !anchor.isConnected) return;
  const rect = anchor.getBoundingClientRect();
  const pad = 14;
  el.style.visibility = 'hidden';
  el.classList.add('is-open');
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let x = rect.left + rect.width / 2 - w / 2;
  let y = rect.top - h - pad;
  if (y < 8) y = rect.bottom + pad;
  x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
  y = Math.max(8, Math.min(window.innerHeight - h - 8, y));
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  el.style.visibility = 'visible';
}

export function showCardTooltip(cardOrId, anchorEl, opts = {}) {
  const card = typeof cardOrId === 'string' ? getCard(cardOrId) : cardOrId;
  if (!card) return;
  const rootEl = ensureRoot();
  if (!rootEl) return;
  clearTimeout(hideTimer);
  currentAnchor = anchorEl;
  const faction = getFaction(card.faction);
  const rows = (card.rows || []).map((r) => ROW_LABEL[r]).join(' / ') || '—';
  const powerText = card.strength ?? '—';
  const ability = (card.abilityZh || card.abilityEn || '').split('\n').filter(Boolean);
  const body = `
    <div class="tt-head">
      <div class="tt-name serif">${esc(card.nameZh || card.nameEn)}</div>
      <div class="tt-en">${esc(card.nameEn || '')}</div>
    </div>
    <div class="tt-meta">
      <span class="tt-badge tt-badge--${card.faction}">${esc(faction?.nameZh || card.faction)}</span>
      <span class="tt-badge">${esc(TYPE_LABEL[card.type] || card.type)}</span>
      <span class="tt-badge">${rows}</span>
      <span class="tt-power">${esc(powerText)}</span>
      ${card.hero ? '<span class="tt-badge tt-badge--hero">英雄</span>' : ''}
      ${card.copies ? `<span class="tt-badge tt-badge--dim">收藏 ${card.copies}</span>` : ''}
    </div>
    <div class="tt-ability">${ability.map((line) => `<p>${esc(line)}</p>`).join('')}</div>
    ${card.flavorZh ? `<div class="tt-flavor">${esc(card.flavorZh)}</div>` : ''}
  `;
  rootEl.innerHTML = `<div class="card-tooltip" role="tooltip">${body}</div>`;
  position(rootEl.firstElementChild, anchorEl);
  if (opts.floating && opts.x != null && opts.y != null) {
    const el = rootEl.firstElementChild;
    el.style.transform = `translate(${Math.round(Math.min(opts.x + 16, window.innerWidth - el.offsetWidth - 8))}px, ${Math.round(
      Math.min(opts.y + 16, window.innerHeight - el.offsetHeight - 8),
    )}px)`;
  }
}

export function showLeaderTooltip(leader, anchorEl) {
  if (!leader) return;
  const rootEl = ensureRoot();
  if (!rootEl) return;
  clearTimeout(hideTimer);
  currentAnchor = anchorEl;
  rootEl.innerHTML = `
    <div class="card-tooltip card-tooltip--leader" role="tooltip">
      <div class="tt-head">
        <div class="tt-name serif">${esc(leader.nameZh || leader.nameEn)}</div>
        <div class="tt-en">${esc(leader.nameEn || '')}</div>
      </div>
      <div class="tt-meta"><span class="tt-badge">领袖</span><span class="tt-badge">每局一次</span></div>
      <div class="tt-ability"><p>${esc(leader.abilityZh || leader.abilityEn || '')}</p></div>
      ${leader.quoteZh ? `<div class="tt-flavor">${esc(leader.quoteZh)}</div>` : ''}
    </div>
  `;
  position(rootEl.firstElementChild, anchorEl);
}

export function hideTooltip() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    const rootEl = ensureRoot();
    if (!rootEl) return;
    const el = rootEl.firstElementChild;
    if (!el) return;
    el.classList.remove('is-open');
    rootEl.innerHTML = '';
  }, 80);
}

export function hideTooltipNow() {
  clearTimeout(hideTimer);
  const rootEl = ensureRoot();
  if (rootEl) rootEl.innerHTML = '';
}
