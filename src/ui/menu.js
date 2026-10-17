/**
 * Main menu, faction select, card gallery. Owner: Lead.
 */

import { T, FACTION_LABELS } from './i18n.js';
import { showCardTooltip, showLeaderTooltip, hideTooltipNow } from './tooltip.js';

const FACTION_IDS = ['northern-realms', 'nilfgaard', 'scoiatael', 'monsters', 'skellige'];
const EMBLEM = {
  'northern-realms': '⚜',
  nilfgaard: '☀',
  scoiatael: '➶',
  monsters: '☠',
  skellige: '⚓',
  neutral: '✦',
};
const FACTION_TAGLINE = {
  'northern-realms': '钢铁、纪律与紧缚阵线。',
  nilfgaard: '黑金帝国，以平局为胜。',
  scoiatael: '森林的箭雨与灵巧游击。',
  monsters: '以数量与集结碾碎对手。',
  skellige: '风暴、墓地与第三局的怒吼。',
};

const DIFFICULTIES = [
  { id: 'easy', label: T.easy },
  { id: 'normal', label: T.normal },
  { id: 'hard', label: T.hard },
];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function h(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

export function createMenu(options) {
  const { renderer, cards, leaders, factions, presets, getDefaultPreset, settings, audio, fx } = options;
  const el = h('div', 'menu-screen');
  let panel = null;

  el.innerHTML = `
    <div class="menu-bg" aria-hidden="true">
      <svg viewBox="0 0 900 900" fill="none">
        <defs>
          <radialGradient id="menuGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#f0d078" stop-opacity=".16"/>
            <stop offset="60%" stop-color="#c9a227" stop-opacity=".04"/>
            <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <circle cx="450" cy="450" r="330" fill="url(#menuGlow)"/>
        <circle cx="450" cy="450" r="300" stroke="#c9a227" stroke-opacity=".22" stroke-width="1"/>
        <circle cx="450" cy="450" r="252" stroke="#c9a227" stroke-opacity=".14" stroke-width="1" stroke-dasharray="2 9"/>
        <circle cx="450" cy="450" r="176" stroke="#c9a227" stroke-opacity=".12" stroke-width="1"/>
        <circle cx="450" cy="450" r="120" stroke="#c9a227" stroke-opacity=".1" stroke-width="1" stroke-dasharray="1 7"/>
        <path d="M450 110 L470 430 L790 450 L470 470 L450 790 L430 470 L110 450 L430 430 Z" fill="#c9a227" fill-opacity=".05" stroke="#c9a227" stroke-opacity=".16"/>
        <path d="M450 150 L466 434 L750 450 L466 466 L450 750 L434 466 L150 450 L434 434 Z" stroke="#c9a227" stroke-opacity=".12" stroke-width="1"/>
        <g fill="#c9a227" fill-opacity=".42" font-size="26" font-family="serif" text-anchor="middle">
          <text x="450" y="118">⚜</text>
          <text x="792" y="462">☀</text>
          <text x="450" y="812">➶</text>
          <text x="108" y="462">☠</text>
          <text x="620" y="650">⚓</text>
        </g>
        <g stroke="#c9a227" stroke-opacity=".25">
          <path d="M450 96v18M450 786v18M96 450h18M786 450h18"/>
        </g>
      </svg>
    </div>
    <div class="menu-corners" aria-hidden="true"></div>
    <div class="menu-inner">
      <header class="menu-header">
        <div class="menu-crest" aria-hidden="true">⚜</div>
        <h1 class="menu-title serif">${T.title}</h1>
        <div class="menu-subtitle">${T.subtitle}</div>
        <div class="menu-divider" aria-hidden="true"></div>
        <p class="menu-tagline">命运的牌局，由你执掌。</p>
      </header>

      <nav class="menu-actions">
        <button type="button" class="menu-btn menu-btn--primary" data-action="quick">
          <span class="menu-btn__icon">⚔</span>
          <span class="menu-btn__text"><b>${T.quickPlay}</b><small>${T.quickPlayDesc}</small></span>
        </button>
        <button type="button" class="menu-btn" data-action="deck">
          <span class="menu-btn__icon">▤</span>
          <span class="menu-btn__text"><b>${T.deckBuilder}</b><small>${T.deckBuilderDesc}</small></span>
        </button>
        <button type="button" class="menu-btn" data-action="gallery">
          <span class="menu-btn__icon">✦</span>
          <span class="menu-btn__text"><b>${T.collection}</b><small>浏览全部 ${Object.keys(cards).length} 张卡牌与 22 位领袖</small></span>
        </button>
      </nav>

      <footer class="menu-footer">
        <div class="menu-setting" data-setting="difficulty">
          <span class="menu-setting__label">${T.difficulty}</span>
          <div class="segmented"></div>
        </div>
        <div class="menu-setting" data-setting="sound">
          <span class="menu-setting__label">音效</span>
          <button type="button" class="sound-toggle" aria-pressed="${settings.sound ? 'true' : 'false'}">
            <span class="sound-toggle__icon">${settings.sound ? '♪' : '♪̸'}</span>
            <span class="sound-toggle__label">${settings.sound ? '开启' : '静音'}</span>
          </button>
        </div>
        <div class="menu-copy">非官方粉丝作品 · 规则与牌库还原《巫师3：狂猎》昆特牌 · 无外部素材</div>
      </footer>
    </div>
    <div class="menu-panel-layer"></div>
  `;

  const panelLayer = el.querySelector('.menu-panel-layer');
  const segmented = el.querySelector('.segmented');
  DIFFICULTIES.forEach((d) => {
    const btn = h('button', `seg ${settings.difficulty === d.id ? 'is-active' : ''}`, d.label);
    btn.type = 'button';
    btn.dataset.difficulty = d.id;
    btn.addEventListener('click', () => {
      settings.difficulty = d.id;
      segmented.querySelectorAll('.seg').forEach((n) => n.classList.toggle('is-active', n.dataset.difficulty === d.id));
      options.onSettingsChange?.({ difficulty: d.id });
      audio.play?.('ui-click');
    });
    segmented.appendChild(btn);
  });

  el.querySelector('.sound-toggle').addEventListener('click', () => {
    settings.sound = !settings.sound;
    const btn = el.querySelector('.sound-toggle');
    btn.setAttribute('aria-pressed', String(settings.sound));
    btn.querySelector('.sound-toggle__icon').textContent = settings.sound ? '♪' : '♪̸';
    btn.querySelector('.sound-toggle__label').textContent = settings.sound ? '开启' : '静音';
    options.onSettingsChange?.({ sound: settings.sound });
  });

  el.querySelectorAll('.menu-btn').forEach((btn) => {
    btn.addEventListener('mouseenter', () => audio.play?.('ui-hover'));
    btn.addEventListener('click', () => {
      audio.play?.('ui-click');
      const action = btn.dataset.action;
      if (action === 'quick') openFactionSelect();
      else if (action === 'deck') options.onDeckBuilder?.(null);
      else if (action === 'gallery') openGallery();
    });
  });

  // ── faction select ──────────────────────────────────────────────
  function closePanel() {
    if (!panel) return;
    panel.el.classList.add('is-closing');
    const node = panel.el;
    panel = null;
    setTimeout(() => node.remove(), 240);
  }

  function openFactionSelect() {
    closePanel();
    const container = h('div', 'faction-select');
    container.innerHTML = `
      <div class="faction-select__panel gilded-panel">
        <div class="panel-head">
          <div class="panel-title serif">${T.chooseFaction}</div>
          <button type="button" class="panel-close" aria-label="关闭">✕</button>
        </div>
        <div class="faction-grid"></div>
        <div class="faction-detail">
          <div class="faction-detail__empty">选择你的阵营</div>
        </div>
      </div>
    `;
    const grid = container.querySelector('.faction-grid');
    const detail = container.querySelector('.faction-detail');
    let selected = null;

    FACTION_IDS.forEach((id, i) => {
      const faction = factions[id];
      const tile = h('button', `faction-tile`);
      tile.type = 'button';
      tile.dataset.faction = id;
      tile.style.setProperty('--faction-delay', `${i * 40}ms`);
      tile.innerHTML = `
        <span class="faction-tile__emblem">${EMBLEM[id]}</span>
        <span class="faction-tile__name serif">${esc(faction?.nameZh || FACTION_LABELS[id] || id)}</span>
        <span class="faction-tile__en">${esc(faction?.nameEn || id.toUpperCase())}</span>
      `;
      tile.addEventListener('mouseenter', () => audio.play?.('ui-hover'));
      tile.addEventListener('click', () => {
        audio.play?.('ui-click');
        selected = id;
        grid.querySelectorAll('.faction-tile').forEach((n) => n.classList.toggle('is-selected', n.dataset.faction === id));
        renderDetail(id);
      });
      grid.appendChild(tile);
    });

    function renderDetail(id) {
      const faction = factions[id];
      const preset = getDefaultPreset?.(id);
      const leader = preset ? leaders[preset.leaderId] : null;
      const presetCards = preset ? preset.cards.reduce((a, c) => a + c.count, 0) : 0;
      detail.innerHTML = '';
      const left = h('div', 'faction-detail__info');
      left.innerHTML = `
        <div class="faction-detail__name serif" style="color: var(--${id === 'northern-realms' ? 'nr' : id === 'nilfgaard' ? 'ng' : id === 'scoiatael' ? 'st' : id === 'monsters' ? 'mo' : 'sk'})">${esc(faction?.nameZh || id)}</div>
        <div class="faction-detail__tagline">${esc(FACTION_TAGLINE[id] || '')}</div>
        <div class="faction-detail__ability"><span class="ability-label">阵营能力</span><p>${esc(faction?.abilityZh || '')}</p></div>
        <div class="faction-detail__preset">预组牌库：<b>${esc(preset?.nameZh || '默认')}</b> · ${presetCards} 张</div>
      `;
      detail.appendChild(left);
      if (leader) {
        const right = h('div', 'faction-detail__leader');
        const leaderWrap = h('div', 'faction-detail__leader-card');
        leaderWrap.appendChild(renderer.createLeaderCardEl(leader, { size: 'sm' }));
        leaderWrap.addEventListener('mouseenter', () => showLeaderTooltip(leader, leaderWrap));
        leaderWrap.addEventListener('mouseleave', hideTooltipNow);
        const start = h('button', 'btn btn--gold faction-start', `${T.startGame} · ${T.vsAI}`);
        start.type = 'button';
        start.addEventListener('click', async () => {
          audio.play?.('ui-click');
          start.disabled = true;
          const playerDeck = preset ? expand(preset) : [];
          const opponentFactions = FACTION_IDS.filter((f) => f !== id);
          const aiFaction = opponentFactions[Math.floor(Math.random() * opponentFactions.length)];
          const aiPreset = getDefaultPreset?.(aiFaction);
          const aiDeck = aiPreset ? expand(aiPreset) : [];
          closePanel();
          await fx?.menuAmbient?.(false);
          options.onQuickPlay?.({
            player: { faction: id, leaderId: preset.leaderId, deck: playerDeck },
            ai: { faction: aiFaction, leaderId: aiPreset?.leaderId, deck: aiDeck, presetName: aiPreset?.nameZh },
            difficulty: settings.difficulty,
          });
        });
        right.appendChild(leaderWrap);
        right.appendChild(start);
        const aiHint = h('div', 'faction-detail__ai-hint', `对手阵营：随机 5 选 1`);
        right.appendChild(aiHint);
        detail.appendChild(right);
      }
    }

    function expand(preset) {
      const ids = [];
      for (const c of preset.cards) for (let i = 0; i < c.count; i++) ids.push(c.id);
      return ids;
    }

    container.querySelector('.panel-close').addEventListener('click', closePanel);
    container.addEventListener('click', (e) => {
      if (e.target === container) closePanel();
    });
    panelLayer.appendChild(container);
    panel = { el: container, close: closePanel };
    requestAnimationFrame(() => container.classList.add('is-open'));
  }

  // ── gallery ─────────────────────────────────────────────────────
  function openGallery() {
    closePanel();
    const container = h('div', 'gallery-screen');
    container.innerHTML = `
      <div class="gallery gilded-panel">
        <div class="panel-head">
          <div class="panel-title serif">${T.collection}</div>
          <div class="gallery-filters"></div>
          <input class="gallery-search" type="search" placeholder="搜索卡牌（中文/英文）" />
          <button type="button" class="panel-close" aria-label="关闭">✕</button>
        </div>
        <div class="gallery-body">
          <div class="gallery-tabs"></div>
          <div class="gallery-grid"></div>
        </div>
      </div>
    `;
    const tabs = container.querySelector('.gallery-tabs');
    const grid = container.querySelector('.gallery-grid');
    const filters = container.querySelector('.gallery-filters');
    const search = container.querySelector('.gallery-search');
    let currentTab = 'all';
    let currentType = 'all';

    const TAB_LIST = [{ id: 'all', label: '全部' }, ...FACTION_IDS.map((id) => ({ id, label: FACTION_LABELS[id] })), { id: 'leaders', label: '领袖' }];
    for (const tab of TAB_LIST) {
      const btn = h('button', `gallery-tab ${tab.id === currentTab ? 'is-active' : ''}`, tab.label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        currentTab = tab.id;
        tabs.querySelectorAll('.gallery-tab').forEach((n) => n.classList.toggle('is-active', n === btn));
        renderGrid();
      });
      tabs.appendChild(btn);
    }
    const TYPE_LIST = [
      { id: 'all', label: '全部' },
      { id: 'unit', label: '单位' },
      { id: 'special', label: '特殊' },
      { id: 'weather', label: '天气' },
    ];
    for (const t of TYPE_LIST) {
      const btn = h('button', `gallery-filter ${t.id === currentType ? 'is-active' : ''}`, t.label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        currentType = t.id;
        filters.querySelectorAll('.gallery-filter').forEach((n) => n.classList.toggle('is-active', n === btn));
        renderGrid();
      });
      filters.appendChild(btn);
    }
    search.addEventListener('input', renderGrid);

    function renderGrid() {
      grid.innerHTML = '';
      const q = search.value.trim().toLowerCase();
      const list = [];
      if (currentTab === 'leaders') {
        for (const leader of Object.values(leaders)) {
          if (q && !(`${leader.nameZh} ${leader.nameEn}`.toLowerCase().includes(q))) continue;
          list.push({ kind: 'leader', data: leader });
        }
      } else {
        for (const card of Object.values(cards)) {
          if (currentTab !== 'all' && card.faction !== currentTab) continue;
          if (currentType !== 'all' && card.type !== currentType) continue;
          if (q && !`${card.nameZh} ${card.nameEn} ${card.abilityZh}`.toLowerCase().includes(q)) continue;
          list.push({ kind: 'card', data: card });
        }
      }
      const frag = document.createDocumentFragment();
      for (const entry of list) {
        const wrap = h('div', 'gallery-item');
        const node =
          entry.kind === 'leader'
            ? renderer.createLeaderCardEl(entry.data, { size: 'xs' })
            : renderer.createCardEl(entry.data, { size: 'xs', interactive: true });
        wrap.appendChild(node);
        wrap.addEventListener('mouseenter', () => {
          if (entry.kind === 'leader') showLeaderTooltip(entry.data, wrap);
          else showCardTooltip(entry.data, wrap);
        });
        wrap.addEventListener('mouseleave', hideTooltipNow);
        frag.appendChild(wrap);
      }
      grid.appendChild(frag);
      const count = h('div', 'gallery-count', `共 ${list.length} 项`);
      grid.appendChild(count);
    }
    renderGrid();
    container.querySelector('.panel-close').addEventListener('click', () => {
      hideTooltipNow();
      container.classList.add('is-closing');
      setTimeout(() => container.remove(), 240);
    });
    el.appendChild(container);
    requestAnimationFrame(() => container.classList.add('is-open'));
  }

  return {
    el,
    destroy() {
      panel?.el?.remove();
      el.remove();
    },
    openFactionSelect,
  };
}
