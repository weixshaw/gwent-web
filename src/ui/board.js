/**
 * Match board renderer & interaction layer. Owner: Lead.
 *
 * Renders an engine view (docs/ARCHITECTURE.md §5.4) into DOM, keeps card
 * elements stable across renders (FLIP animations), and turns user input into
 * engine actions through callbacks.
 *
 * The card visual renderer is injected (contract: docs/ARCHITECTURE.md §6) so
 * the board never depends on card art internals.
 */

import { getCard, getLeader, getFaction } from '../data/db.js';
import { showCardTooltip, showLeaderTooltip, hideTooltip, hideTooltipNow } from './tooltip.js';
import { T, ROW_LABELS, ROW_ORDER_TOP, ROW_ORDER_BOTTOM, FACTION_LABELS, WEATHER_META } from './i18n.js';

const FACTION_EMBLEM = {
  'northern-realms': '⚜',
  nilfgaard: '☀',
  scoiatael: '➶',
  monsters: '☠',
  skellige: '⚓',
  neutral: '✦',
};

const WEATHER_KEY_ORDER = ['frost', 'fog', 'rain', 'storm'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

export function createBoard(root, options = {}) {
  const renderer = options.renderer;
  const getPlayerIndex = options.getPlayerIndex || (() => 0);
  const callbacks = {
    onAction: options.onAction || (() => {}),
    onPass: options.onPass || (() => {}),
    onLeader: options.onLeader || (() => {}),
    onPileClick: options.onPileClick || (() => {}),
    onMulliganConfirm: options.onMulliganConfirm || (() => {}),
    onRuleHint: options.onRuleHint || (() => {}),
  };

  const state = {
    view: null,
    mode: 'idle', // idle | play | waiting | mulligan
    actions: [],
    selectedUid: null,
    mulliganSelected: new Set(),
    mulliganCount: 2,
    handOrder: [],
    leaderKey: [null, null],
    lastScores: [0, 0],
    currentFaction: null,
  };

  const cardEls = new Map();

  // ── DOM skeleton ──────────────────────────────────────────────────
  const screen = el('div', 'match-screen');
  screen.innerHTML = `
    <div class="match-topbar">
      <div class="side-badge side-badge--opponent" data-side="1">
        <div class="side-leader" data-fx-leader="1"></div>
        <div class="side-info">
          <div class="side-name-row">
            <span class="side-emblem"></span>
            <span class="side-faction"></span>
            <span class="side-ai-tag">AI</span>
          </div>
          <div class="side-piles">
            <button class="pile-btn pile-btn--hand" type="button" title="手牌"><span class="pile-ico">▭</span><span class="pile-num">0</span></button>
            <button class="pile-btn pile-btn--deck" type="button" title="牌堆" data-fx-deck="1"><span class="pile-ico">▤</span><span class="pile-num">0</span></button>
            <button class="pile-btn pile-btn--grave" type="button" title="弃牌堆" data-fx-grave="1"><span class="pile-ico">⌾</span><span class="pile-num">0</span></button>
          </div>
        </div>
        <div class="side-score-wrap">
          <div class="side-gems"></div>
          <div class="side-score">0</div>
        </div>
        <div class="pass-stamp">${T.passed}</div>
      </div>
      <div class="match-title">
        <div class="match-title-round">第 1 小局</div>
        <div class="match-title-phase">${T.yourTurn}</div>
      </div>
      <div class="match-controls">
        <button class="ctrl-btn ctrl-btn--sound" type="button" title="音效">♪</button>
        <button class="ctrl-btn ctrl-btn--menu" type="button" title="菜单">☰</button>
      </div>
    </div>

    <div class="match-board">
      <div class="board-side board-side--ai"></div>
      <div class="weather-strip">
        <div class="weather-slots"></div>
      </div>
      <div class="board-side board-side--me"></div>
      <div class="board-weather-layer" aria-hidden="true"></div>
      <div class="board-vignette" aria-hidden="true"></div>
    </div>

    <div class="match-bottom">
      <div class="side-badge side-badge--me" data-side="0">
        <div class="side-leader" data-fx-leader="0"></div>
        <div class="side-info">
          <div class="side-name-row">
            <span class="side-emblem"></span>
            <span class="side-faction"></span>
            <span class="side-you-tag">${T.you}</span>
          </div>
          <div class="side-piles">
            <button class="pile-btn pile-btn--deck" type="button" title="牌堆" data-fx-deck="0"><span class="pile-ico">▤</span><span class="pile-num">0</span></button>
            <button class="pile-btn pile-btn--grave" type="button" title="弃牌堆" data-fx-grave="0"><span class="pile-ico">⌾</span><span class="pile-num">0</span></button>
          </div>
        </div>
        <div class="side-score-wrap">
          <div class="side-gems"></div>
          <div class="side-score">0</div>
        </div>
        <div class="pass-stamp">${T.passed}</div>
      </div>

      <div class="hand-zone">
        <div class="hand-cards"></div>
        <div class="hand-hint"></div>
      </div>

      <div class="action-bar">
        <button class="pass-btn" type="button">${T.pass}</button>
        <div class="action-hint">${T.selectCard}</div>
        <div class="mulligan-bar hidden">
          <div class="mulligan-hint">${T.mulliganHint}</div>
          <div class="mulligan-actions">
            <button class="btn btn--ghost mulligan-skip" type="button">${T.mulliganSkip}</button>
            <button class="btn btn--gold mulligan-confirm" type="button">${T.mulliganConfirm}</button>
          </div>
        </div>
      </div>
    </div>

    <div class="match-log"></div>
    <div class="match-toast"></div>
  `;
  root.appendChild(screen);

  const $ = (sel) => screen.querySelector(sel);
  const rowsEl = { 0: {}, 1: {} };
  const rowInfo = { 0: {}, 1: {} };
  const sideEls = { 0: $('.side-badge--me'), 1: $('.side-badge--opponent') };
  const weatherSlots = $('.weather-slots');
  const weatherLayer = $('.board-weather-layer');
  const handCards = $('.hand-cards');
  const handHint = $('.hand-hint');
  const actionHint = $('.action-hint');
  const passBtn = $('.pass-btn');
  const mulliganBar = $('.mulligan-bar');
  const logEl = $('.match-log');
  const toastEl = $('.match-toast');
  const titleRound = $('.match-title-round');
  const titlePhase = $('.match-title-phase');

  function buildRow(playerIndex, row) {
    const wrap = el('div', 'board-row');
    wrap.dataset.fxRow = row;
    wrap.dataset.fxPlayer = String(playerIndex);
    wrap.innerHTML = `
      <div class="board-row__label">
        <span class="board-row__icon">${renderer?.renderRowIcon ? renderer.renderRowIcon(row) : ''}</span>
        <span class="board-row__name">${ROW_LABELS[row]}</span>
        <span class="board-row__score">0</span>
      </div>
      <div class="board-row__watermark" aria-hidden="true"></div>
      <div class="board-row__special"></div>
      <div class="board-row__cards"></div>
      <div class="board-row__weather"></div>
    `;
    const cardsBox = wrap.querySelector('.board-row__cards');
    cardsBox.addEventListener('dragover', (e) => e.preventDefault());
    wrap.addEventListener('click', (e) => {
      if (e.target.closest('.gt-card')) return;
      onRowClick(playerIndex, row);
    });
    const info = {
      el: wrap,
      cards: cardsBox,
      score: wrap.querySelector('.board-row__score'),
      special: wrap.querySelector('.board-row__special'),
      weather: wrap.querySelector('.board-row__weather'),
      watermark: wrap.querySelector('.board-row__watermark'),
    };
    rowsEl[playerIndex][row] = cardsBox;
    rowInfo[playerIndex][row] = info;
    return wrap;
  }

  const aiSide = $('.board-side--ai');
  const meSide = $('.board-side--me');
  for (const row of ROW_ORDER_TOP) aiSide.appendChild(buildRow(1, row));
  for (const row of ROW_ORDER_BOTTOM) meSide.appendChild(buildRow(0, row));

  // weather slots
  for (const key of WEATHER_KEY_ORDER) {
    const slot = el('div', `weather-slot weather-slot--${key}`);
    const SHORT = { frost: '严寒', fog: '浓雾', rain: '暴雨', storm: '风暴' }[key] || WEATHER_META[key].zh;
    slot.innerHTML = `<span class="weather-slot__icon">${WEATHER_META[key].icon}</span><span class="weather-slot__label">${SHORT}</span>`;
    slot.title = `${WEATHER_META[key].zh} · 受影响行：${WEATHER_META[key].rows.map((r) => ROW_LABELS[r]).join('、')}（双方）`;
    slot.addEventListener('click', () => callbacks.onRuleHint(`weather:${key}`));
    weatherSlots.appendChild(slot);
  }

  // ── callbacks wiring ─────────────────────────────────────────────
  passBtn.addEventListener('click', () => {
    if (state.mode !== 'play') return;
    callbacks.onPass();
  });
  $('.ctrl-btn--sound').addEventListener('click', () => options.onToggleSound?.());
  $('.ctrl-btn--menu').addEventListener('click', () => options.onMenu?.());
  $('.side-badge--me .side-leader').addEventListener('click', () => {
    if (state.mode === 'play' && state.view?.players?.[0]?.leaderAvailable) callbacks.onLeader();
    else if (state.view?.players?.[0]) callbacks.onRuleHint('leader:0');
  });
  $('.side-badge--opponent .side-leader').addEventListener('click', () => {
    if (state.view?.players?.[1]) callbacks.onRuleHint('leader:1');
  });
  sideEls[0].querySelector('.pile-btn--grave').addEventListener('click', () => callbacks.onPileClick(0, 'graveyard'));
  sideEls[1].querySelector('.pile-btn--grave').addEventListener('click', () => callbacks.onPileClick(1, 'graveyard'));
  sideEls[0].querySelector('.pile-btn--deck').addEventListener('click', () => callbacks.onPileClick(0, 'deck'));
  sideEls[1].querySelector('.pile-btn--deck').addEventListener('click', () => callbacks.onPileClick(1, 'deck'));
  sideEls[1].querySelector('.pile-btn--hand').addEventListener('click', () => callbacks.onRuleHint('opponent-hand'));
  mulliganBar.querySelector('.mulligan-skip').addEventListener('click', () => finishMulligan([]));
  mulliganBar.querySelector('.mulligan-confirm').addEventListener('click', () => finishMulligan([...state.mulliganSelected]));

  screen.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelSelection();
  });
  const onDocKeyDown = (e) => {
    if (e.key === 'Escape' && screen.isConnected) cancelSelection();
  };
  const onDocPointerDown = (e) => {
    if (!screen.isConnected) return;
    if (state.selectedUid && !e.target.closest('.gt-card') && !e.target.closest('.board-row') && !e.target.closest('.action-bar')) {
      cancelSelection();
    }
  };
  document.addEventListener('keydown', onDocKeyDown);
  document.addEventListener('pointerdown', onDocPointerDown);

  // ── helpers ──────────────────────────────────────────────────────
  function cardMeta(cardId) {
    return getCard(cardId);
  }

  function makeCardEl(card, size, opts = {}) {
    const node = renderer.createCardEl(card, { size, interactive: true, ...opts });
    node.dataset.uid = opts.uid || '';
    if (opts.uid) cardEls.set(opts.uid, node);
    node.addEventListener('mouseenter', () => showCardTooltip(card, node));
    node.addEventListener('mouseleave', hideTooltip);
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      const uid = node.dataset.uid;
      if (!uid) return;
      if (opts.onClick) opts.onClick(uid, node);
    });
    return node;
  }

  function setStates() {
    if (!state.view) return;
    const view = state.view;
    const player = view.players[0];
    const isPlay = state.mode === 'play';
    const playableUids = new Set();
    if (isPlay) for (const a of state.actions) if (a.type === 'playCard') playableUids.add(a.uid);
    // hand cards
    for (const node of handCards.children) {
      const uid = node.dataset.uid;
      if (!uid) continue;
      node.classList.toggle('is-selected', state.selectedUid === uid || state.mulliganSelected.has(uid));
      if (state.mode === 'mulligan') {
        node.classList.toggle('is-disabled', false);
      } else if (isPlay) {
        node.classList.toggle('is-disabled', !playableUids.has(uid));
      } else {
        node.classList.toggle('is-disabled', true);
      }
    }
    // board card targets (decoy)
    const targetUids = new Set();
    if (isPlay && state.selectedUid) {
      for (const a of state.actions) if (a.uid === state.selectedUid && a.targetUid) targetUids.add(a.targetUid);
      if (!targetUids.size) {
        for (const a of state.actions) if (a.uid === state.selectedUid && a.targetUid) targetUids.add(a.targetUid);
      }
    }
    for (const [, node] of cardEls) {
      if (!node.isConnected) continue;
      if (node.closest('.hand-cards')) continue;
      node.classList.toggle('is-target', targetUids.has(node.dataset.uid));
    }
    // rows highlight
    const playRows = new Set();
    const selectedActions = isPlay ? state.actions.filter((a) => a.uid === state.selectedUid) : [];
    for (const a of selectedActions) {
      if (a.type !== 'playCard') continue;
      if (a.row != null) playRows.add(`${a.rowOwner ?? (a.targetBoard ?? 0)}:${a.row}`);
    }
    for (const p of [0, 1]) {
      for (const row of ['close', 'ranged', 'siege']) {
        const node = rowInfo[p][row].el;
        node.classList.toggle('is-playable-row', playRows.has(`${p}:${row}`));
      }
    }
    // hint text
    if (state.mode === 'mulligan') {
      actionHint.textContent = `${T.mulliganTitle} · 已选 ${state.mulliganSelected.size}/${state.mulliganCount}`;
    } else if (isPlay) {
      if (state.selectedUid) {
        const card = cardMeta(view.players[0].hand?.find((c) => c.uid === state.selectedUid)?.cardId || '');
        const needsTarget = selectedActions.some((a) => a.targetUid);
        actionHint.textContent = needsTarget ? T.selectTarget : T.selectRow;
        if (!needsTarget && !selectedActions.some((a) => a.row != null)) actionHint.textContent = T.selectCard;
      } else {
        actionHint.textContent = T.selectCard;
      }
    }
  }

  function cancelSelection() {
    state.selectedUid = null;
    state.view && setStates();
    setHoverRows(null);
  }

  let hoverRows = null;
  function setHoverRows(key) {
    hoverRows = key;
  }

  // ── interaction ──────────────────────────────────────────────────
  function onHandCardClick(uid, node) {
    if (!state.view) return;
    if (state.mode === 'mulligan') {
      if (state.mulliganSelected.has(uid)) state.mulliganSelected.delete(uid);
      else if (state.mulliganSelected.size < state.mulliganCount) state.mulliganSelected.add(uid);
      setStates();
      return;
    }
    if (state.mode !== 'play') return;
    const cardActions = state.actions.filter((a) => a.type === 'playCard' && a.uid === uid);
    if (!cardActions.length) {
      flashDisabled(node);
      return;
    }
    if (state.selectedUid === uid) {
      cancelSelection();
      return;
    }
    const needsTarget = cardActions.some((a) => a.targetUid != null);
    const rowKeys = new Set(cardActions.map((a) => (a.row != null ? `${a.rowOwner ?? a.targetBoard ?? 0}:${a.row}` : 'none')));
    if (!needsTarget && rowKeys.size === 1 && rowKeys.has('none')) {
      // no placement decision — play immediately
      state.selectedUid = null;
      callbacks.onAction(cardActions[0]);
      return;
    }
    if (!needsTarget && rowKeys.size === 1) {
      // fixed row decision: play immediately
      state.selectedUid = null;
      callbacks.onAction(cardActions[0]);
      return;
    }
    state.selectedUid = uid;
    setStates();
    showHoverRowsForCard(uid);
  }

  function showHoverRowsForCard(uid) {
    const cardActions = state.actions.filter((a) => a.type === 'playCard' && a.uid === uid);
    for (const p of [0, 1]) {
      for (const row of ['close', 'ranged', 'siege']) {
        const wanted = cardActions.some((a) => {
          if (a.row !== row) return false;
          if (a.rowOwner != null) return a.rowOwner === p;
          return (a.targetBoard ?? 0) === p;
        });
        rowInfo[p][row].el.classList.toggle('is-playable-row', wanted);
      }
    }
  }

  function onRowClick(playerIndex, row) {
    if (state.mode !== 'play' || !state.selectedUid) return;
    const cardActions = state.actions.filter((a) => a.type === 'playCard' && a.uid === state.selectedUid);
    const action = cardActions.find((a) => a.row === row && (a.rowOwner != null ? a.rowOwner === playerIndex : (a.targetBoard ?? 0) === playerIndex));
    if (action) {
      state.selectedUid = null;
      hideTooltipNow();
      callbacks.onAction(action);
    }
  }

  function onBoardCardClick(uid) {
    if (!state.view) return;
    if (state.mode === 'play' && state.selectedUid) {
      const action = state.actions.find((a) => a.type === 'playCard' && a.uid === state.selectedUid && a.targetUid === uid);
      if (action) {
        state.selectedUid = null;
        hideTooltipNow();
        callbacks.onAction(action);
        return;
      }
    }
    // otherwise: rule hint / inspect
    const unit = findUnitView(state.view, uid);
    if (unit) callbacks.onRuleHint(`unit:${uid}`);
  }

  function findUnitView(view, uid) {
    for (const p of view.players) {
      for (const row of ['close', 'ranged', 'siege']) {
        const found = p.rows[row].find((u) => u.uid === uid);
        if (found) return found;
      }
    }
    return null;
  }

  function flashDisabled(node) {
    if (!node) return;
    node.classList.remove('is-shake');
    void node.offsetWidth;
    node.classList.add('is-shake');
    setTimeout(() => node.classList.remove('is-shake'), 400);
  }

  // ── rendering ────────────────────────────────────────────────────
  function renderCardInto(container, uid, card, size, viewUnit, opts = {}) {
    let node = cardEls.get(uid);
    const isNew = !node;
    if (isNew) {
      node = makeCardEl(card, size, { uid, onClick: opts.onClick });
    } else {
      // Cards move between hand (md) and board (sm): keep the size class in sync.
      const wanted = `gt-card--${size}`;
      if (!node.classList.contains(wanted)) {
        for (const s of ['xxs', 'xs', 'sm', 'md', 'lg']) node.classList.remove(`gt-card--${s}`);
        node.classList.add(wanted);
      }
    }
    // update power
    if (viewUnit) {
      const prev = Number(node.dataset.powerShown ?? '');
      renderer.setCardPower(node, viewUnit.power, { animate: true, delta: Number.isFinite(prev) ? viewUnit.power - prev : 0 });
      node.dataset.powerShown = String(viewUnit.power);
      node.classList.toggle('is-hero', !!viewUnit.hero);
      node.classList.toggle('is-buffed', viewUnit.power > (viewUnit.basePower ?? 0));
      node.classList.toggle('is-debuffed', viewUnit.power < (viewUnit.basePower ?? 0));
      if (viewUnit.kind === 'decoy') node.classList.add('is-decoy-token');
    } else {
      renderer.setCardPower(node, card.strength ?? null, { animate: false });
      node.dataset.powerShown = String(card.strength ?? '');
    }
    if (isNew && opts.animateIn !== false) {
      node.classList.add('is-entering');
      setTimeout(() => node.classList.remove('is-entering'), 500);
    }
    container.appendChild(node);
    return node;
  }

  function fitRow(container) {
    requestAnimationFrame(() => {
      const kids = [...container.children];
      const n = kids.length;
      if (!n) return;
      const avail = container.clientWidth - 4;
      const cw = kids[0].getBoundingClientRect().width || 90;
      const natural = n * cw;
      let overlap = 0;
      if (natural > avail && n > 1) overlap = Math.ceil((natural - avail) / (n - 1)) + 1;
      overlap = Math.min(overlap, Math.round(cw * 0.55));
      container.style.setProperty('--row-overlap', String(-overlap));
    });
  }

  function captureRects() {
    const map = new Map();
    for (const [uid, node] of cardEls) {
      if (node.isConnected && node.offsetParent !== null) map.set(uid, node.getBoundingClientRect());
    }
    return map;
  }

  function playFlip(prevRects) {
    for (const [uid, node] of cardEls) {
      if (!node.isConnected) continue;
      const prev = prevRects.get(uid);
      if (!prev) continue;
      const next = node.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) continue;
      try {
        node.animate(
          [
            { transform: `translate(${dx}px, ${dy}px) scale(${Math.min(1.15, prev.width / Math.max(1, next.width))})`, zIndex: 40 },
            { transform: 'translate(0,0) scale(1)', zIndex: 40 },
          ],
          { duration: 380, easing: 'cubic-bezier(.22,.8,.3,1)' },
        );
      } catch {
        /* noop */
      }
    }
  }

  function renderSideBadge(playerIndex) {
    const p = state.view.players[playerIndex];
    const badge = sideEls[playerIndex];
    const faction = getFaction(p.faction);
    badge.querySelector('.side-emblem').textContent = FACTION_EMBLEM[p.faction] || '✦';
    badge.querySelector('.side-emblem').className = `side-emblem side-emblem--${p.faction}`;
    badge.querySelector('.side-faction').textContent = faction?.nameZh || FACTION_LABELS[p.faction] || p.faction;
    badge.querySelector('.side-score').textContent = String(p.score);
    badge.querySelector('.side-score').classList.toggle('is-leading', p.score > (state.view.players[1 - playerIndex]?.score ?? 0));
    const pulse = badge.querySelector('.side-score');
    if (state.lastScores[playerIndex] !== p.score) {
      pulse.classList.remove('is-score-up', 'is-score-down');
      void pulse.offsetWidth;
      pulse.classList.add(p.score > state.lastScores[playerIndex] ? 'is-score-up' : 'is-score-down');
    }
    // gems
    const gemsBox = badge.querySelector('.side-gems');
    gemsBox.innerHTML = '';
    for (let i = 0; i < 2; i++) {
      const gem = el('span', `gem ${i < p.gems ? 'gem--on' : 'gem--off'}`);
      gemsBox.appendChild(gem);
    }
    // piles
    badge.querySelectorAll('.pile-btn--hand .pile-num').forEach((n) => (n.textContent = String(p.handCount)));
    badge.querySelectorAll('.pile-btn--deck .pile-num').forEach((n) => (n.textContent = String(p.deckCount)));
    badge.querySelectorAll('.pile-btn--grave .pile-num').forEach((n) => (n.textContent = String(p.graveyard.length)));
    // passed
    badge.classList.toggle('is-passed', !!p.passed);
    badge.classList.toggle('is-active', state.view.phase === 'play' && state.view.turn === playerIndex);
    // leader
    const leader = getLeader(p.leaderId);
    const leaderEl = badge.querySelector('.side-leader');
    const key = `${p.leaderId}`;
    if (leader && state.leaderKey[playerIndex] !== key) {
      leaderEl.innerHTML = '';
      const card = renderer.createLeaderCardEl(leader, { size: 'xs' });
      card.dataset.leaderMini = String(playerIndex);
      leaderEl.appendChild(card);
      state.leaderKey[playerIndex] = key;
      leaderEl.addEventListener('mouseenter', () => showLeaderTooltip(leader, leaderEl));
      leaderEl.addEventListener('mouseleave', hideTooltip);
    }
    leaderEl.classList.toggle('is-used', p.leaderUsed || p.leaderCanceled);
    leaderEl.classList.toggle('is-available', p.leaderAvailable);
    leaderEl.title = p.leaderCanceled ? T.leaderCanceled : p.leaderUsed ? T.leaderUsed : leader?.abilityZh || T.leader;
  }

  function renderRows() {
    for (const p of [0, 1]) {
      const playerView = state.view.players[p];
      for (const row of ['close', 'ranged', 'siege']) {
        const info = rowInfo[p][row];
        const computed = playerView.rowScores[row] ?? 0;
        info.score.textContent = String(computed);
        info.score.classList.toggle('is-empty', computed === 0);
        // cards
        const target = playerView.rows[row] || [];
        for (const unit of target) {
          const card = getCard(unit.cardId);
          if (!card) continue;
          const node = renderCardInto(info.cards, unit.uid, card, 'sm', unit, { onClick: (uid) => onBoardCardClick(uid) });
          node.dataset.boardPlayer = String(p);
          node.dataset.boardRow = row;
        }
        // remove stale nodes in this row
        for (const node of [...info.cards.children]) {
          const uid = node.dataset.uid;
          if (!target.some((u) => u.uid === uid)) {
            node.remove();
            cardEls.delete(uid);
          }
        }
        fitRow(info.cards);
        // special (horn/mardroeme)
        const special = playerView.rowSpecials[row];
        info.special.innerHTML = '';
        if (special) {
          const icon = el('div', `row-special row-special--${special.kind}`, special.kind === 'horn' ? '♬' : '☘');
          icon.title = special.kind === 'horn' ? '号角：本行战力 ×2' : '曼陀罗：狂战士会变身';
          info.special.appendChild(icon);
        }
        // weather overlays
        const active = Object.entries(state.view.weather).filter(([, v]) => v).map(([k]) => k);
        const affecting = active.filter((k) => WEATHER_KEY_ORDER.includes(k) && WEATHER_META[k].rows.includes(row));
        info.weather.className = `board-row__weather ${affecting.map((k) => `is-${k}`).join(' ')}`;
        const faction = state.view.players[p].faction;
        info.el.dataset.faction = faction;
        if (info.watermark.textContent !== (FACTION_EMBLEM[faction] || '')) {
          info.watermark.textContent = FACTION_EMBLEM[faction] || '';
        }
        info.el.classList.toggle('is-weathered', affecting.length > 0);
        info.el.classList.toggle('is-horned', !!special && special.kind === 'horn');
        info.el.classList.toggle('is-mardroeme', !!special && special.kind === 'mardroeme');
      }
    }
  }

  function renderWeather() {
    for (const [i, key] of WEATHER_KEY_ORDER.entries()) {
      const slot = weatherSlots.children[i];
      slot.classList.toggle('is-active', !!state.view.weather[key]);
    }
    const active = Object.entries(state.view.weather).filter(([, v]) => v).map(([k]) => k);
    weatherLayer.className = `board-weather-layer ${active.map((k) => `is-${k}`).join(' ')}`;
  }

  function renderHand(view) {
    const me = view.players[getPlayerIndex()];
    const hand = me.hand || [];
    const targetUids = hand.map((c) => c.uid);
    for (const entry of hand) {
      const card = getCard(entry.cardId);
      if (!card) continue;
      renderCardInto(handCards, entry.uid, card, 'md', null, {
        onClick: (uid, node) => onHandCardClick(uid, node),
        animateIn: false,
      });
    }
    for (const node of [...handCards.children]) {
      if (!targetUids.includes(node.dataset.uid)) {
        node.remove();
        cardEls.delete(node.dataset.uid);
      }
    }
    // fan layout
    const count = handCards.children.length;
    handCards.style.setProperty('--hand-count', String(count));
    handCards.style.setProperty('--hand-overlap', String(count > 10 ? -62 : count > 8 ? -48 : -34));
    [...handCards.children].forEach((node, i) => {
      const mid = (count - 1) / 2;
      const offset = i - mid;
      const rot = count > 1 ? offset * Math.min(3.4, 26 / count) : 0;
      const lift = Math.abs(offset) * (count > 6 ? 5 : 9);
      node.style.setProperty('--fan-rot', `${rot}deg`);
      node.style.setProperty('--fan-y', `${lift}px`);
      node.style.zIndex = String(10 + i);
      node.dataset.handIndex = String(i);
    });
    handHint.textContent = hand.length ? '' : '手牌已空';
    requestAnimationFrame(fitHand);
  }

  function fitHand() {
    const kids = [...handCards.children];
    if (!kids.length) return;
    const avail = handCards.clientWidth - 8;
    const cardW = kids[0].getBoundingClientRect().width || 120;
    const n = kids.length;
    if (!cardW) return;
    const natural = n * cardW;
    let overlap = 0;
    if (natural > avail && n > 1) {
      overlap = Math.ceil((natural - avail) / (n - 1)) + 2;
    }
    const maxOverlap = Math.round(cardW * 0.72);
    overlap = Math.min(overlap, maxOverlap);
    handCards.style.setProperty('--hand-overlap', String(-overlap));
    // rotate fan
    const mid = (n - 1) / 2;
    kids.forEach((node, i) => {
      const offset = i - mid;
      const rot = n > 1 ? offset * Math.min(3.2, 22 / n) : 0;
      const lift = Math.abs(offset) * (n > 6 ? 4 : 8);
      node.style.setProperty('--fan-rot', `${rot}deg`);
      node.style.setProperty('--fan-y', `${lift}px`);
    });
  }

  function renderHud(view) {
    const inSetup = view.phase === 'setup' || !view.round;
    titleRound.textContent = inSetup ? '备牌阶段' : `第 ${view.round} 小局`;
    const my = view.players[getPlayerIndex()];
    const opp = view.players[1 - getPlayerIndex()];
    if (view.phase === 'game-over') titlePhase.textContent = '对局结束';
    else if (inSetup) titlePhase.textContent = state.mode === 'mulligan' ? '选择换牌' : '准备中';
    else if (view.pending) titlePhase.textContent = '等待选择';
    else if (view.turn === getPlayerIndex()) titlePhase.textContent = T.yourTurn;
    else titlePhase.textContent = `${T.opponent}回合`;
    passBtn.disabled = !(state.mode === 'play');
    passBtn.classList.toggle('hidden', state.mode === 'mulligan');
    // log
    const lines = (view.log || []).slice(-3);
    logEl.innerHTML = lines.map((l) => `<div class="match-log__line">${esc(l)}</div>`).join('');
    logEl.classList.toggle('is-empty', lines.length === 0);
    // leader availability
    sideEls[0].querySelector('.side-leader').classList.toggle('is-available', !!my.leaderAvailable);
  }

  function render(view) {
    if (!view) return;
    hideTooltipNow();
    const prevRects = captureRects();
    state.view = view;
    const my = view.players[getPlayerIndex()];
    if (my) state.currentFaction = my.faction;
    renderSideBadge(0);
    renderSideBadge(1);
    renderRows();
    renderWeather();
    renderHand(view);
    renderHud(view);
    state.lastScores = [view.players[0].score, view.players[1].score];
    setStates();
    playFlip(prevRects);
  }

  // ── public API ───────────────────────────────────────────────────
  const api = {
    el: screen,
    render,
    getCardEl(uid) {
      const node = cardEls.get(uid);
      return node && node.isConnected ? node : null;
    },
    getRowEl(playerIndex, row) {
      return rowInfo[playerIndex]?.[row]?.el || null;
    },
    getDeckEl(playerIndex) {
      return sideEls[playerIndex]?.querySelector('.pile-btn--deck') || null;
    },
    getGraveEl(playerIndex) {
      return sideEls[playerIndex]?.querySelector('.pile-btn--grave') || null;
    },
    getLeaderEl(playerIndex) {
      return sideEls[playerIndex]?.querySelector('.side-leader') || null;
    },
    setPlayMode(actions) {
      state.mode = 'play';
      state.actions = actions || [];
      state.selectedUid = null;
      mulliganBar.classList.add('hidden');
      setStates();
      renderHud(state.view);
    },
    setWaiting(text = T.waiting) {
      state.mode = 'waiting';
      state.actions = [];
      state.selectedUid = null;
      actionHint.textContent = text;
      mulliganBar.classList.add('hidden');
      setStates();
      renderHud(state.view);
    },
    setIdle() {
      state.mode = 'idle';
      state.actions = [];
      state.selectedUid = null;
      setStates();
    },
    cancelSelection,
    beginMulligan({ count = 2, selected = [] } = {}) {
      state.mode = 'mulligan';
      state.mulliganCount = count;
      state.mulliganSelected = new Set(selected);
      state.selectedUid = null;
      mulliganBar.classList.remove('hidden');
      passBtn.classList.add('hidden');
      actionHint.textContent = `${T.mulliganTitle}`;
      setStates();
    },
    endMulligan() {
      state.mode = 'waiting';
      state.mulliganSelected.clear();
      mulliganBar.classList.add('hidden');
      setStates();
    },
    finishMulliganSelection() {
      finishMulligan([...state.mulliganSelected]);
    },
    showToast(text, kind = 'info', duration = 1800) {
      toastEl.textContent = text;
      toastEl.className = `match-toast is-visible is-${kind}`;
      clearTimeout(api._toastTimer);
      api._toastTimer = setTimeout(() => (toastEl.className = 'match-toast'), duration);
    },
    flashPlayer(playerIndex) {
      const badge = sideEls[playerIndex];
      if (!badge) return;
      badge.classList.remove('is-flash');
      void badge.offsetWidth;
      badge.classList.add('is-flash');
    },
    getFaction() {
      return state.currentFaction;
    },
    destroy() {
      screen.remove();
      document.removeEventListener('keydown', onDocKeyDown);
      document.removeEventListener('pointerdown', onDocPointerDown);
      clearTimeout(api._toastTimer);
      cardEls.clear();
      hideTooltipNow();
    },
    state,
  };

  function finishMulligan(uids) {
    state.mode = 'waiting';
    mulliganBar.classList.add('hidden');
    state.mulliganSelected.clear();
    callbacks.onMulliganConfirm(uids);
    setStates();
  }

  return api;
}
