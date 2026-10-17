/**
 * Application controller: screen routing, game loop, AI orchestration, modals.
 * Owner: Lead.
 */

import { CARDS } from './data/cards.js';
import { LEADERS } from './data/leaders.js';
import { FACTIONS } from './data/factions.js';
import { getCard, getLeader, getFaction } from './data/db.js';
import { PRESET_DECKS, expandPreset, getDefaultPreset } from './data/decks.js';
import { createGame } from './engine/engine.js';
import { createBoard } from './ui/board.js';
import { createMenu } from './ui/menu.js';
import { T, FACTION_LABELS, ROW_LABELS } from './ui/i18n.js';
import { showCardTooltip, hideTooltipNow } from './ui/tooltip.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const FACTION_EMBLEM = {
  'northern-realms': '⚜',
  nilfgaard: '☀',
  scoiatael: '➶',
  monsters: '☠',
  skellige: '⚓',
  neutral: '✦',
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ── settings store ─────────────────────────────────────────────────────
const SETTINGS_KEY = 'gwent.settings.v1';
const defaultSettings = { sound: true, difficulty: 'normal' };
function loadSettings() {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...defaultSettings };
  }
}
function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

// ── no-op fallbacks ────────────────────────────────────────────────────
const noopFx = new Proxy(
  {},
  {
    get: () =>
      function noop() {
        return Promise.resolve();
      },
  },
);
const noopAudio = {
  init() {},
  unlock() {},
  setEnabled() {},
  isEnabled: () => false,
  setVolume() {},
  play() {},
  startAmbient() {},
  stopAmbient() {},
};

// ── module loading ─────────────────────────────────────────────────────
async function loadCardRenderer() {
  try {
    const mod = await import('./ui/card-render.js');
    if (mod && typeof mod.createCardEl === 'function') return { mod, real: true };
  } catch (err) {
    console.warn('[app] card-render.js unavailable, using fallback renderer:', err?.message || err);
  }
  return { mod: await import('./ui/card-fallback.js'), real: false };
}
async function loadFx() {
  try {
    const mod = await import('./ui/fx.js');
    if (mod?.fx) return mod.fx;
  } catch (err) {
    console.warn('[app] fx.js unavailable:', err?.message || err);
  }
  return noopFx;
}
async function loadAudio() {
  try {
    const mod = await import('./ui/audio.js');
    if (mod?.audio) return mod.audio;
  } catch (err) {
    console.warn('[app] audio.js unavailable:', err?.message || err);
  }
  return noopAudio;
}
function makeFallbackAI({ playerIndex }) {
  return {
    chooseAction(view, engine) {
      const actions = engine.getActions().filter((a) => a.type !== 'pass');
      if (!actions.length) return { type: 'pass' };
      return actions[Math.floor(Math.random() * actions.length)];
    },
    choosePending(pending) {
      switch (pending.kind) {
        case 'medic': {
          const units = pending.options || [];
          return units.length ? { uid: units[Math.floor(Math.random() * units.length)].uid } : { skip: true };
        }
        case 'reviveRow': return { row: pending.options?.[0] || 'close' };
        case 'takeGraveUnit':
        case 'deckChoice':
        case 'chooseWeather': return { uid: pending.options?.[0]?.uid };
        case 'viewHand': return { ack: true };
        case 'discardCards': return { cards: (pending.options || []).slice(0, pending.count).map((o) => o.uid) };
        case 'mulligan': {
          const hand = view?.players?.[playerIndex]?.hand || [];
          const picks = hand.filter((c) => !['unit'].includes('')).slice(0, 0);
          return { cards: [] };
        }
        case 'chooseFirstPlayer': return { first: 0 };
        default: return {};
      }
    },
    chooseMulligan() {
      return { cards: [] };
    },
  };
}

async function loadAI() {
  try {
    const mod = await import('./engine/ai.js');
    if (mod?.createAI) return mod.createAI;
  } catch (err) {
    console.warn('[app] ai.js unavailable, using fallback AI:', err?.message || err);
  }
  return null;
}
async function loadDeckBuilder() {
  try {
    const mod = await import('./ui/deckbuilder.js');
    if (mod?.createDeckBuilder) return mod.createDeckBuilder;
  } catch (err) {
    console.warn('[app] deckbuilder.js unavailable:', err?.message || err);
  }
  return null;
}

// ── app state ──────────────────────────────────────────────────────────
const app = {
  root: null,
  screenRoot: null,
  overlayRoot: null,
  bootScreen: null,
  renderer: null,
  cardRendererReal: false,
  fx: noopFx,
  audio: noopAudio,
  createAI: null,
  createDeckBuilder: null,
  settings: loadSettings(),
  screen: null,
  screenName: null,
  match: null,
  menu: null,
};

function setScreen(node, name) {
  if (app.screen && app.screen !== node) {
    try {
      app.screen.remove();
    } catch {
      /* noop */
    }
  }
  app.screen = node;
  app.screenName = name;
  if (node && !node.isConnected) app.screenRoot.appendChild(node);
  app.overlayRoot.innerHTML = '';
}

function clearOverlay() {
  app.overlayRoot.innerHTML = '';
}

function setBootDone() {
  app.bootScreen?.classList.add('is-gone');
  setTimeout(() => app.bootScreen?.remove(), 700);
}

// ── modal helpers ──────────────────────────────────────────────────────
function modal({ title, hint = '', body = null, actions = [], className = '', dismissible = false, onDismiss = null }) {
  const overlay = document.createElement('div');
  overlay.className = `modal-backdrop ${className}`;
  const box = document.createElement('div');
  box.className = 'modal gilded-panel';
  box.innerHTML = `
    <div class="modal__head">
      <div class="modal__title serif">${title}</div>
      ${hint ? `<div class="modal__hint">${hint}</div>` : ''}
    </div>
    <div class="modal__body"></div>
    <div class="modal__actions"></div>
  `;
  if (body) box.querySelector('.modal__body').appendChild(body);
  const actionsBox = box.querySelector('.modal__actions');
  const close = () => {
    overlay.remove();
    onDismiss?.();
  };
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${action.primary ? 'btn--gold' : 'btn--ghost'} ${action.className || ''}`;
    btn.textContent = action.label;
    btn.disabled = !!action.disabled;
    btn.addEventListener('click', async () => {
      if (action.keepOpen) {
        await action.onClick?.(close);
        return;
      }
      close();
      await action.onClick?.(close);
    });
    actionsBox.appendChild(btn);
  }
  overlay.appendChild(box);
  if (dismissible) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  }
  app.overlayRoot.appendChild(overlay);
  return { overlay, close, box };
}

function cardGrid(cards, { size = 'sm', onPick = null, disabledIds = new Set() } = {}) {
  const grid = document.createElement('div');
  grid.className = 'card-grid';
  for (const item of cards) {
    const card = getCard(item.cardId || item.id || item);
    if (!card) continue;
    const wrap = document.createElement('button');
    wrap.type = 'button';
    wrap.className = 'card-grid__item';
    const node = app.renderer.createCardEl(card, { size, interactive: true });
    wrap.appendChild(node);
    wrap.addEventListener('mouseenter', () => showCardTooltip(card, node));
    wrap.addEventListener('mouseleave', hideTooltipNow);
    if (onPick) wrap.addEventListener('click', () => onPick(item, card, wrap));
    grid.appendChild(wrap);
  }
  return grid;
}

// ── boot ───────────────────────────────────────────────────────────────
export async function boot() {
  app.root = document.getElementById('app');
  app.screenRoot = document.getElementById('screen-root');
  app.overlayRoot = document.getElementById('overlay-root');
  app.bootScreen = document.getElementById('boot-screen');
  app.fx = await loadFx();
  app.audio = await loadAudio();
  const { mod, real } = await loadCardRenderer();
  app.renderer = mod;
  app.cardRendererReal = real;
  app.createAI = await loadAI();
  app.createDeckBuilder = await loadDeckBuilder();

  try {
    app.fx.init?.({ root: app.root, canvas: document.getElementById('fx-canvas'), autoCoin: false, getCardRect: (uid) => app.match?.board?.getCardEl(uid)?.getBoundingClientRect() || null });
    app.fx.menuAmbient?.(true);
  } catch (err) {
    console.warn('[app] fx init failed', err);
  }
  try {
    app.audio.init?.();
    const unlock = () => {
      app.audio.unlock?.();
      app.audio.startAmbient?.();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  } catch (err) {
    console.warn('[app] audio init failed', err);
  }

  window.__gwent = {
    app,
    get match() {
      return app.match;
    },
    get game() {
      return app.match?.game;
    },
    view() {
      return app.match?.game?.viewFor(0);
    },
    actions() {
      return app.match?.game?.getActions();
    },
  };

  await showMenu();
  setBootDone();
}

// ── menu ───────────────────────────────────────────────────────────────
async function showMenu() {
  app.match?.dispose?.();
  app.match = null;
  app.fx?.menuAmbient?.(true);
  const menu = createMenu({
    renderer: app.renderer,
    cards: CARDS,
    leaders: LEADERS,
    factions: FACTIONS,
    presets: PRESET_DECKS,
    getDefaultPreset,
    settings: app.settings,
    audio: app.audio,
    onQuickPlay: (config) => startMatch(config),
    onDeckBuilder: (faction) => showDeckBuilder(faction),
    onSettingsChange: (next) => {
      app.settings = { ...app.settings, ...next };
      saveSettings(app.settings);
      app.audio.setEnabled?.(app.settings.sound);
    },
    fx: app.fx,
  });
  app.menu = menu;
  setScreen(menu.el, 'menu');
}

// ── deckbuilder screen ─────────────────────────────────────────────────
async function showDeckBuilder(faction = 'northern-realms') {
  app.fx?.menuAmbient?.(false);
  if (!app.createDeckBuilder) {
    modal({
      title: '组牌器暂不可用',
      hint: '组牌器模块仍在加载中，请稍后再试。',
      actions: [{ label: T.back, primary: true, onClick: () => {} }],
    });
    return;
  }
  if (app.deckBuilder) app.deckBuilder.close();
  const db = app.createDeckBuilder({
    onPlay: (config) => startMatch(configFromDeckBuilder(config)),
    onBack: () => showMenu(),
  });
  app.deckBuilder = db;
  setScreen(db.el, 'deckbuilder');
  db.open?.(faction);
}

function configFromDeckBuilder(config) {
  const faction = config.faction;
  const opponentFactions = Object.keys(PRESET_DECKS).filter((f) => f !== faction);
  const aiFaction = pick(opponentFactions);
  const aiPreset = getDefaultPreset(aiFaction);
  return {
    player: { faction, leaderId: config.leaderId, deck: config.cards },
    ai: { faction: aiFaction, leaderId: aiPreset.leaderId, deck: expandPreset(aiPreset) },
    difficulty: app.settings.difficulty,
  };
}

// ── match ──────────────────────────────────────────────────────────────
async function startMatch(config) {
  app.menu?.destroy?.();
  app.menu = null;
  app.deckBuilder?.close?.();
  app.deckBuilder = null;
  app.fx?.menuAmbient?.(false);
  app.fx?.setFactionTheme?.(config.player.faction);

  const game = createGame({
    seed: (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0,
    cards: CARDS,
    leaders: LEADERS,
    players: [
      { id: 'player', isAI: false, faction: config.player.faction, leaderId: config.player.leaderId, deck: config.player.deck },
      { id: 'ai', isAI: true, faction: config.ai.faction, leaderId: config.ai.leaderId, deck: config.ai.deck },
    ],
  });
  const ai = app.createAI
    ? app.createAI({ cards: CARDS, leaders: LEADERS, playerIndex: 1, difficulty: config.difficulty || 'normal', seed: 1234 })
    : makeFallbackAI({ playerIndex: 1 });

  const match = {
    game,
    ai,
    config,
    busy: false,
    disposed: false,
    board: null,
    view: null,
    aiTimer: 0,
    pendingModal: null,
    dispose() {
      this.disposed = true;
      clearTimeout(this.aiTimer);
      this.pendingModal?.remove?.();
      this.board?.el?.remove();
      app.fx?.menuAmbient?.(true);
    },
    async run(fn) {
      if (this.busy || this.disposed) return;
      this.busy = true;
      try {
        const res = fn();
        if (!res || !res.ok) {
          this.board?.showToast(res?.error || '操作无效', 'error');
          this.busy = false;
          this.syncTurn();
          return;
        }
        await this.handleEvents(res.events || []);
        this.busy = false;
        await this.afterState();
      } catch (err) {
        console.error('[match] action failed', err);
        this.busy = false;
        this.board?.showToast('发生错误：' + (err?.message || err), 'error');
      }
    },
    async handleEvents(events) {
      const board = this.board;
      // Stage 1: card-play flights using the pre-render DOM.
      for (const ev of events) {
        if (ev.type === 'cardPlayed' && !this.disposed) {
          const fromEl = board.getCardEl(ev.uid);
          const toEl = board.getRowEl(ev.boardOwner ?? ev.player, ev.row);
          if (fromEl && ev.row) {
            const card = getCard(ev.cardId);
            app.audio.play?.(ev.hero ? 'hero-place' : 'card-place');
            await safeFx(app.fx.cardPlay, { fromRect: fromEl.getBoundingClientRect(), toEl, card });
          }
        }
      }
      // Stage 2: event-driven spectacle + audio.
      for (const ev of events) {
        if (this.disposed) return;
        if (ev.type === 'cardPlayed') continue; // already handled
        if (ev.type === 'log') {
          continue;
        }
        if (ev.type === 'gameOver') continue;
        const view = this.game.viewFor(0);
        app.fx.onEvent?.(ev, { view, board });
        if (ev.type === 'roundEnded' || ev.type === 'roundStarted' || ev.type === 'weatherChanged' || ev.type === 'scorch' || ev.type === 'hornPlaced' || ev.type === 'leaderUsed') {
          await sleep(ev.type === 'roundEnded' ? 600 : 240);
        } else if (ev.type === 'muster' || ev.type === 'medic' || ev.type === 'cardSummoned' || ev.type === 'avenger') {
          await sleep(160);
        }
      }
      await sleep(80);
      this.view = this.game.viewFor(0);
      board.render(this.view);
    },
    async begin() {
      if (this.disposed) return;
      const view = this.game.viewFor(0);
      this.board.render(view);
      await this.showIntro(view);
      app.fx.onEvent?.({ type: 'gameStart', faction: this.config.player.faction }, { view, board: this.board });
      const startEvents = this.game.startEvents || [];
      for (const ev of startEvents) {
        if (this.disposed) return;
        if (ev.type === 'log') continue;
        app.fx.onEvent?.(ev, { view, board: this.board });
      }
      const stayPending = this.game.pending?.kind === 'chooseFirstPlayer';
      if (!stayPending && view.firstPlayer != null) {
        this.coinShown = true;
        await safeFx(app.fx.coinFlip, { firstPlayer: view.firstPlayer });
        this.board.showToast(view.firstPlayer === 0 ? '硬币落定 · 你先手' : '硬币落定 · 对手先手', 'info', 1600);
      }
      await sleep(200);
      this.afterState();
    },
    async showIntro(view) {
      const self = view.players[0];
      const opp = view.players[1];
      const selfFaction = getFaction(self.faction);
      const oppFaction = getFaction(opp.faction);
      const selfLeader = getLeader(self.leaderId);
      const oppLeader = getLeader(opp.leaderId);
      const overlay = document.createElement('div');
      overlay.className = 'match-intro';
      overlay.innerHTML = `
        <div class="match-intro__side">
          <div class="match-intro__emblem" style="color: var(--${self.faction === 'northern-realms' ? 'nr-glow' : self.faction === 'nilfgaard' ? 'ng-glow' : self.faction === 'scoiatael' ? 'st-glow' : self.faction === 'monsters' ? 'mo-glow' : 'sk-glow'})">${FACTION_EMBLEM[self.faction] || '✦'}</div>
          <div class="match-intro__name serif" style="color: var(--${self.faction === 'northern-realms' ? 'nr-glow' : self.faction === 'nilfgaard' ? 'ng-glow' : self.faction === 'scoiatael' ? 'st-glow' : self.faction === 'monsters' ? 'mo-glow' : 'sk-glow'})">${escHtml(selfFaction?.nameZh || self.faction)}</div>
          <div class="match-intro__leader">${escHtml(selfLeader?.nameZh || '')}</div>
          <div class="match-intro__tag">${T.you}</div>
          <div class="match-intro__card-slot" data-slot="0"></div>
        </div>
        <div class="match-intro__vs serif">VS</div>
        <div class="match-intro__side">
          <div class="match-intro__emblem" style="color: var(--${oppFaction?.id === 'northern-realms' ? 'nr-glow' : oppFaction?.id === 'nilfgaard' ? 'ng-glow' : oppFaction?.id === 'scoiatael' ? 'st-glow' : oppFaction?.id === 'monsters' ? 'mo-glow' : 'sk-glow'})">${FACTION_EMBLEM[opp.faction] || '✦'}</div>
          <div class="match-intro__name serif" style="color: var(--${opp.faction === 'northern-realms' ? 'nr-glow' : opp.faction === 'nilfgaard' ? 'ng-glow' : opp.faction === 'scoiatael' ? 'st-glow' : opp.faction === 'monsters' ? 'mo-glow' : 'sk-glow'})">${escHtml(oppFaction?.nameZh || opp.faction)}</div>
          <div class="match-intro__leader">${escHtml(oppLeader?.nameZh || '')}</div>
          <div class="match-intro__tag">${T.opponent} · AI</div>
          <div class="match-intro__card-slot" data-slot="1"></div>
        </div>
      `;
      app.overlayRoot.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('is-open'));
      try {
        const slot0 = overlay.querySelector('[data-slot="0"]');
        const slot1 = overlay.querySelector('[data-slot="1"]');
        if (selfLeader) slot0.appendChild(app.renderer.createLeaderCardEl(selfLeader, { size: 'sm' }));
        if (oppLeader) slot1.appendChild(app.renderer.createLeaderCardEl(oppLeader, { size: 'sm' }));
        app.fx.screenFlash?.('#f0d078', 0.08);
        app.fx.setFactionTheme?.(self.faction);
      } catch (err) {
        console.warn('[app] intro leader render failed', err);
      }
      await sleep(1650);
      overlay.classList.add('is-closing');
      await sleep(260);
      overlay.remove();
      this.board.showToast(`对手阵营：${oppFaction?.nameZh || ''} · ${T.opponent}手牌 ${opp.handCount} 张`, 'info', 2200);
    },
    async afterState() {
      if (this.disposed) return;
      const game = this.game;
      const view = game.viewFor(0);
      this.view = view;
      this.board.render(view);
      if (game.state.phase === 'game-over') {
        await sleep(500);
        await this.showResult(view);
        return;
      }
      if (game.pending) {
        await this.handlePending(game.pending);
        return;
      }
      if (game.state.phase === 'play') {
        if (!this.coinShown) {
          this.coinShown = true;
          const first = game.state.firstPlayer;
          safeFx(app.fx.coinFlip, { firstPlayer: first });
          this.board.showToast(first === 0 ? '硬币落定 · 你先手' : '硬币落定 · 对手先手', 'info', 1600);
        }
        if (game.state.turn === 0 && !game.state.passed[0]) {
          this.board.setPlayMode(game.getActions());
        } else {
          this.board.setWaiting(T.thinking);
          this.scheduleAI();
        }
      } else {
        this.board.setIdle();
      }
    },
    syncTurn() {
      if (this.disposed) return;
      const game = this.game;
      if (game.pending) return this.handlePending(game.pending);
      if (game.state.phase !== 'play') return;
      if (game.state.turn === 0 && !game.state.passed[0]) this.board.setPlayMode(game.getActions());
      else this.board.setWaiting(T.thinking);
    },
    scheduleAI(delay = null) {
      clearTimeout(this.aiTimer);
      if (this.disposed) return;
      const wait = delay ?? 550 + Math.random() * 650;
      this.aiTimer = setTimeout(() => this.aiStep(), wait);
    },
    async aiStep() {
      if (this.disposed || this.busy) return;
      const game = this.game;
      if (game.pending) {
        await this.handlePending(game.pending);
        return;
      }
      if (game.state.phase !== 'play' || game.state.turn !== 1 || game.state.passed[1]) {
        this.syncTurn();
        return;
      }
      const view = game.viewFor(1);
      let action = null;
      try {
        action = this.ai?.chooseAction(view, game) || null;
      } catch (err) {
        console.warn('[app] ai error', err);
      }
      const actions = game.getActions();
      if (!action || !actions.some((a) => actionMatches(a, action))) {
        action = actions.find((a) => a.type === 'pass') || actions[0];
      }
      if (!action) return;
      await this.run(() => game.apply(action));
    },
    async handlePending(pending) {
      const game = this.game;
      const player = pending.player;
      if (player === 0) {
        await this.playerPending(pending);
      } else {
        await sleep(450 + Math.random() * 350);
        let choice = null;
        try {
          choice = pending.kind === 'mulligan' ? this.ai?.chooseMulligan?.(game.viewFor(1), game) : this.ai?.choosePending?.(pending, game.viewFor(1), game);
        } catch (err) {
          console.warn('[app] ai pending error', err);
        }
        if (!choice) choice = fallbackChoice(pending);
        await this.run(() => game.respond(choice));
      }
    },
    async playerPending(pending) {
      const game = this.game;
      switch (pending.kind) {
        case 'chooseFirstPlayer': {
          return this.modalChoice({
            title: T.chooseFirstTitle,
            hint: T.chooseFirstHint,
            actions: [
              { label: T.goFirst, primary: true, onClick: () => this.run(() => game.respond({ first: 0 })) },
              { label: T.goSecond, onClick: () => this.run(() => game.respond({ first: 1 })) },
            ],
          });
        }
        case 'mulligan': {
          this.board.beginMulligan({ count: pending.count ?? 2 });
          this.board.render(this.game.viewFor(0));
          this.mulliganHandler = (uids) => {
            this.board.endMulligan();
            this.run(() => game.respond({ cards: uids }));
          };
          this.board.state.mulliganConfirm = this.mulliganHandler;
          // board's built-in mulligan bar calls options.onMulliganConfirm which we set at creation:
          this.onMulliganConfirm = this.mulliganHandler;
          return;
        }
        case 'medic': {
          const options = pending.options || [];
          return this.showCardChoice({
            title: T.medicTitle,
            hint: T.medicHint,
            cards: options,
            allowSkip: true,
            skipLabel: T.skip,
            onPick: (item) => this.run(() => game.respond({ uid: item.uid })),
            onSkip: () => this.run(() => game.respond({ skip: true })),
          });
        }
        case 'reviveRow': {
          return this.modalChoice({
            title: T.chooseRowTitle,
            hint: '医师复活：选择放置行',
            actions: (pending.options || ['close', 'ranged']).map((row) => ({
              label: ROW_LABELS[row] || row,
              primary: row === 'close',
              onClick: () => this.run(() => game.respond({ row })),
            })),
          });
        }
        case 'takeGraveUnit': {
          const cards = (pending.options || []).map((o) => ({ uid: o.uid, cardId: o.cardId }));
          return this.showCardChoice({
            title: T.takeGraveTitle,
            hint: '从弃牌堆取一张牌加入手牌',
            cards,
            allowSkip: true,
            skipLabel: T.skip,
            onPick: (item) => this.run(() => game.respond({ uid: item.uid })),
            onSkip: () => this.run(() => game.respond({})),
          });
        }
        case 'discardCards': {
          const selected = new Set();
          const options = pending.options || [];
          const grid = document.createElement('div');
          grid.className = 'card-grid';
          for (const item of options) {
            const card = getCard(item.cardId);
            if (!card) continue;
            const wrap = document.createElement('button');
            wrap.type = 'button';
            wrap.className = 'card-grid__item selectable';
            wrap.appendChild(app.renderer.createCardEl(card, { size: 'sm', interactive: true }));
            wrap.addEventListener('click', () => {
              if (selected.has(item.uid)) selected.delete(item.uid);
              else if (selected.size < pending.count) selected.add(item.uid);
              wrap.classList.toggle('is-selected', selected.has(item.uid));
              const btn = app.overlayRoot.querySelector('.modal__actions .btn--gold');
              if (btn) btn.disabled = selected.size !== pending.count;
            });
            wrap.addEventListener('mouseenter', () => showCardTooltip(card, wrap.firstChild));
            wrap.addEventListener('mouseleave', hideTooltipNow);
            grid.appendChild(wrap);
          }
          return this.modalChoice({
            title: T.discardTitle,
            hint: `选择 ${pending.count} 张手牌弃掉`,
            body: grid,
            actions: [
              {
                label: T.confirm,
                primary: true,
                disabled: true,
                keepOpen: true,
                onClick: () => {
                  if (selected.size !== pending.count) return;
                  clearOverlay();
                  this.run(() => game.respond({ cards: [...selected] }));
                },
              },
            ],
          });
        }
        case 'deckChoice': {
          const cards = (pending.options || []).map((o) => ({ uid: o.uid, cardId: o.cardId }));
          return this.showCardChoice({
            title: T.deckChoiceTitle,
            hint: '从牌堆选择一张牌加入手牌',
            cards,
            onPick: (item) => this.run(() => game.respond({ uid: item.uid })),
          });
        }
        case 'viewHand': {
          const cards = (pending.cards || []).map((o) => ({ uid: o.uid, cardId: o.cardId }));
          return this.modalChoice({
            title: T.viewHandTitle,
            hint: T.viewHandHint,
            body: cardGrid(cards, { size: 'sm' }),
            actions: [{ label: T.close, primary: true, onClick: () => this.run(() => game.respond({ ack: true })) }],
          });
        }
        case 'chooseWeather': {
          const cards = (pending.options || []).map((o) => ({ uid: o.uid, cardId: o.cardId }));
          return this.showCardChoice({
            title: T.chooseWeatherTitle,
            hint: '从牌堆选择一张天气牌立即打出',
            cards,
            onPick: (item) => this.run(() => game.respond({ uid: item.uid })),
          });
        }
        default:
          console.warn('[app] unhandled pending', pending);
          return this.run(() => game.respond(fallbackChoice(pending)));
      }
    },
    modalChoice({ title, hint, body = null, actions = [] }) {
      return new Promise((resolve) => {
        const m = modal({
          title,
          hint,
          body,
          className: 'modal-backdrop--choice',
          actions: actions.map((a) => ({
            ...a,
            onClick: async () => {
              await a.onClick?.();
              resolve();
            },
          })),
          dismissible: false,
        });
        this.pendingModal = m.overlay;
      });
    },
    showCardChoice({ title, hint, cards, onPick, allowSkip, skipLabel, onSkip }) {
      const grid = cardGrid(cards, {
        size: 'sm',
        onPick: (item, card, wrap) => {
          grid.querySelectorAll('.card-grid__item.is-selected').forEach((n) => n.classList.remove('is-selected'));
          wrap.classList.add('is-selected');
          const actionsBox = app.overlayRoot.querySelector('.modal__actions');
          const btn = actionsBox?.querySelector('.btn--gold');
          if (btn) btn.disabled = false;
          onPick?.(item, card);
        },
      });
      const actions = [
        {
          label: allowSkip ? skipLabel || T.skip : T.confirm,
          onClick: () => {
            onSkip?.();
          },
        },
      ];
      return this.modalChoice({ title, hint, body: grid, actions });
    },
    async showResult(view) {
      clearOverlay();
      const result = view.result || this.game.result();
      const winner = result?.winner;
      const title = winner === 0 ? T.gameWin : winner === 1 ? T.gameLose : T.gameDraw;
      const history = result?.history || view.roundHistory || [];
      const last = history[history.length - 1];
      const roundsWon = [0, 1].map((p) => history.filter((h) => h.winner === p).length);
      const rows = history
        .map((h) => `<div class="result__round"><span>第 ${h.round} 小局</span><span>${h.scores[0]} : ${h.scores[1]}</span><span>${h.winner === null ? '平' : h.winner === 0 ? '胜' : '负'}</span></div>`)
        .join('');
      const body = document.createElement('div');
      body.className = 'result';
      body.innerHTML = `
        <div class="result__banner result__banner--${winner === 0 ? 'win' : winner === 1 ? 'lose' : 'draw'}">
          <div class="result__title serif">${title}</div>
          <div class="result__score">${roundsWon[0]} : ${roundsWon[1]}</div>
          <div class="result__sub">小局比分 ${last ? `${last.scores[0]} : ${last.scores[1]}` : '—'} · 宝石 ${(result?.gems || view.gems || []).join(' : ')}</div>
        </div>
        <div class="result__rounds">${rows}</div>
        <div class="result__gems">${[0, 1].map((p) => `<div class="result__gem-col"><span>${p === 0 ? T.you : T.opponent}</span><span>${'◆'.repeat(Math.max(0, (result?.gems || view.gems || [])[p] || 0))}${'◇'.repeat(Math.max(0, 2 - ((result?.gems || view.gems || [])[p] || 0)))}</span></div>`).join('')}</div>
      `;
      await app.fx.roundBanner?.({ kind: winner === 0 ? 'win' : winner === 1 ? 'lose' : 'draw' });
      await app.fx.gameOver?.({ winner, view }).catch(() => {});
      modal({
        title: T.gameOverScores,
        body,
        className: 'modal-backdrop--result',
        actions: [
          { label: T.rematch, primary: true, onClick: () => startMatch(this.config) },
          { label: T.toMenu, onClick: () => showMenu() },
        ],
      });
    },
  };
  app.match = match;

  const board = createBoard(app.screenRoot, {
    renderer: app.renderer,
    getPlayerIndex: () => 0,
    onAction: (action) => {
      if (match.busy) return;
      match.run(() => match.game.apply(action));
    },
    onPass: () => {
      if (match.busy) return;
      match.modalChoice({
        title: T.pass,
        hint: T.passConfirm,
        actions: [
          { label: T.cancel, onClick: () => {} },
          { label: T.confirmPass, primary: true, onClick: () => match.run(() => match.game.apply({ type: 'pass' })) },
        ],
      });
    },
    onLeader: () => {
      if (match.busy) return;
      match.run(() => match.game.apply({ type: 'useLeader' }));
    },
    onPileClick: (player, type) => {
      const p = match.game.viewFor(0).players[player];
      const cards = type === 'graveyard' ? p.graveyard : [];
      if (type === 'deck') {
        board.showToast(`牌堆剩余 ${p.deckCount} 张牌`, 'info');
        return;
      }
      if (!cards.length) {
        board.showToast(T.emptyGrave, 'info');
        return;
      }
      modal({
        title: `${player === 0 ? T.you : T.opponent} · ${T.graveyard}（${cards.length}）`,
        body: cardGrid(cards, { size: 'sm' }),
        actions: [{ label: T.close, primary: true, onClick: () => {} }],
        dismissible: true,
        className: 'modal-backdrop--grave',
      });
    },
    onMulliganConfirm: (uids) => {
      match.board.endMulligan();
      match.run(() => match.game.respond({ cards: uids }));
    },
    onToggleSound: () => {
      app.settings.sound = !app.settings.sound;
      saveSettings(app.settings);
      app.audio.setEnabled?.(app.settings.sound);
      board.showToast(app.settings.sound ? '音效已开启' : '音效已关闭', 'info', 1200);
    },
    onMenu: () => {
      match.modalChoice({
        title: '离开对局？',
        hint: '当前进度将丢失',
        actions: [
          { label: T.cancel, onClick: () => {} },
          { label: T.toMenu, primary: true, onClick: () => showMenu() },
        ],
      });
    },
    onRuleHint: (key) => {
      if (key.startsWith('weather:')) {
        const kind = key.split(':')[1];
        board.showToast(`天气：降低对应行所有单位战力（双方）`, 'info', 2200);
      } else if (key.startsWith('leader:')) {
        const p = Number(key.split(':')[1]);
        const leader = getLeader(match.game.viewFor(0).players[p].leaderId);
        if (leader) {
          modal({
            title: leader.nameZh || leader.nameEn,
            hint: `领袖 · ${p === 0 ? T.you : T.opponent}`,
            body: Object.assign(document.createElement('div'), {
              className: 'rule-text',
              innerHTML: `<p>${leader.abilityZh || ''}</p>${leader.quoteZh ? `<p class="tt-flavor">${leader.quoteZh}</p>` : ''}`,
            }),
            actions: [{ label: T.close, primary: true, onClick: () => {} }],
            dismissible: true,
          });
        }
      } else if (key === 'opponent-hand') {
        board.showToast(`对手手牌：${match.game.viewFor(0).players[1].handCount} 张`, 'info', 1600);
      }
    },
  });
  match.board = board;
  setScreen(board.el, 'match');
  const view = match.game.viewFor(0);
  match.view = view;
  board.render(view);
  app.fx.setFactionTheme?.(config.player.faction);
  app.fx.onEvent?.({ type: 'gameStart', faction: config.player.faction }, { view, board });

  // intro + initial pending (mulligan / Scoia'tael first-player)
  setTimeout(() => match.begin(), 260);
}

function actionMatches(a, b) {
  if (!b) return false;
  if (a.type !== b.type) return false;
  if (b.type === 'playCard') return a.uid === b.uid && (a.row ?? null) === (b.row ?? null) && (a.targetUid ?? null) === (b.targetUid ?? null);
  return true;
}

function fallbackChoice(pending) {
  switch (pending.kind) {
    case 'medic':
      return { skip: true };
    case 'reviveRow':
      return { row: pending.options?.[0] || 'close' };
    case 'takeGraveUnit':
    case 'deckChoice':
    case 'chooseWeather':
      return { uid: pending.options?.[0]?.uid };
    case 'viewHand':
      return { ack: true };
    case 'discardCards':
      return { cards: (pending.options || []).slice(0, pending.count).map((o) => o.uid) };
    case 'mulligan':
      return { cards: [] };
    case 'chooseFirstPlayer':
      return { first: 0 };
    default:
      return {};
  }
}

async function safeFx(fn, args) {
  try {
    await fn?.call(app.fx, args);
  } catch (err) {
    console.warn('[app] fx error', err);
  }
}

export { app };
