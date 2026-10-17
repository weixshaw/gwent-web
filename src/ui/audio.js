// ============================================================================
//  src/ui/audio.js · 昆特牌 · WebAudio 合成音效 / 环境音
//  Owner: vfx   Contract: docs/ARCHITECTURE.md §7, docs/ART_DIRECTION.md §6
//  ---------------------------------------------------------------------------
//  全部音效由 WebAudio 实时合成：无外部音频资源、无第三方依赖。
//  音色方向：中世纪奇幻（纸牌摩擦、金属、铜管、风雷、低频氛围），
//  峰值受控（SFX 约 -14dBFS / 环境音更低）、无爆音、支持静音并记住设置。
//  Autoplay 策略：未 unlock() 前绝不播放；unlock() 后才有声音。
// ============================================================================

const STORE_KEY = 'gwent.audio.settings.v1';

const DEFAULTS = Object.freeze({
  enabled: true,   // 默认开启，但首次用户交互前不会出声
  volume: 0.72,    // 0..1 master volume
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed && parsed.enabled !== false,
      volume: parsed && isFiniteNum(parsed.volume) ? clamp(parsed.volume, 0, 1) : DEFAULTS.volume,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    /* localStorage 不可用时静默降级（隐私模式 / file://） */
  }
}

// 每个 SFX 的最小触发间隔（秒），防止同帧事件叠成噪音墙。
const RATE_LIMIT = {
  'ui-hover': 0.055,
  'ui-click': 0.035,
  'card-draw': 0.045,
  'card-place': 0.045,
  'card-flip': 0.045,
  'power-tick': 0.05,
  'toast': 0.12,
  'error': 0.35,
  'muster': 0.1,
};

// ---- 合成工具函数（放在模块级，SOUNDS 里以 this 调用 engine 的私有方法） ----
const volOf = (opts, base) => clamp((opts && isFiniteNum(opts.volume) ? opts.volume : 1) * base, 0, 2);
const pitchOf = (opts) => {
  const p = opts && (isFiniteNum(opts.pitch) ? opts.pitch : isFiniteNum(opts.rate) ? opts.rate : 1);
  return clamp(Number.isFinite(p) ? p : 1, 0.25, 4);
};
const panOf = (opts) => clamp(opts && isFiniteNum(opts.pan) ? opts.pan : 0, -1, 1);

// ============================================================================
//  SoundEngine
// ============================================================================
class SoundEngine {
  constructor() {
    this.settings = loadSettings();
    this.ctx = null;
    this.master = null; // final gain → limiter → destination
    this.sfxBus = null;
    this.ambientBus = null;
    this.limiter = null;
    this.white = null;
    this.brown = null;
    this.unlocked = false;
    this.failed = false;
    this._init = false;
    this._ambient = null;       // { bus, nodes }
    this._ambientTimers = [];
    this._ambientMuted = false; // 静音时是否保存了"环境音本来想开"的状态
    this.ambientDesired = false;
    this._lastPlayed = new Map();
    this._warned = new Set();
    this._visBound = false;
    this._onVisibility = null;
  }

  // ---------------------------------------------------------------- lifecycle
  init() {
    if (this._init) return this;
    this._init = true;
    this._bindVisibility();
    return this;
  }

  /**
   * 首次用户交互后调用（pointerdown / keydown）。不存在 AudioContext 时安全降级。
   * @returns {Promise<boolean>} 是否成功解锁
   */
  unlock() {
    this.init();
    const ctx = this._ensureContext();
    if (!ctx) return Promise.resolve(false);
    let resume;
    try {
      resume = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
    } catch {
      resume = Promise.resolve();
    }
    return Promise.resolve(resume)
      .then(() => {
        if (this.ctx.state !== 'running') return false;
        this.unlocked = true;
        this._silentTick();
        if (this.ambientDesired && this.settings.enabled) this.startAmbient();
        return true;
      })
      .catch(() => false);
  }

  setEnabled(on) {
    const next = !!on;
    const wasEnabled = this.settings.enabled;
    this.settings.enabled = next;
    saveSettings(this.settings);
    if (this.ctx) this._rampMaster(0.045);
    if (!next) {
      // 静音时暂停环境音以省资源；恢复音效时若之前想要环境音则重启
      this._ambientMuted = this.ambientDesired;
      this.stopAmbient();
    } else if (wasEnabled === false && this._ambientMuted && this.unlocked) {
      this.ambientDesired = true;
      this.startAmbient();
      this._ambientMuted = false;
    }
    return this.settings.enabled;
  }

  setVolume(v) {
    this.settings.volume = clamp(isFiniteNum(v) ? v : DEFAULTS.volume, 0, 1);
    saveSettings(this.settings);
    if (this.ctx) this._rampMaster(0.06);
    return this.settings.volume;
  }

  isEnabled() {
    return !!this.settings.enabled;
  }

  /** 是否已成功解锁（AudioContext running）。 */
  isUnlocked() {
    return !!(this.unlocked && this.ctx && this.ctx.state === 'running');
  }

  get volume() {
    return this.settings.volume;
  }

  get unlockedVersion() {
    return this.unlocked;
  }

  /**
   * 播放一个合成音效。
   * @param {string} name 见 ARCHITECTURE §7 SFX 列表
   * @param {{volume?:number, pitch?:number, rate?:number, pan?:number, delay?:number}} [opts]
   * @returns {boolean} 是否真的发声（未解锁/静音/未知音效 → false）
   */
  play(name, opts = {}) {
    if (!this.settings.enabled) return false;
    if (!this.unlocked || !this.ctx || this.ctx.state !== 'running') return false;
    const build = SOUNDS[name];
    if (!build) {
      if (name !== 'toast') this._warn('unknown sfx: ' + name);
      return false;
    }
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const last = this._lastPlayed.get(name);
    const gap = RATE_LIMIT[name] || 0;
    if (isFiniteNum(last) && now - last < gap) return false;
    this._lastPlayed.set(name, now);
    const delay = clamp(isFiniteNum(opts.delay) ? opts.delay : 0, 0, 2);
    try {
      build.call(this, now + delay, opts || {});
      return true;
    } catch (err) {
      this._warn('sfx failed: ' + name, err);
      return false;
    }
  }

  // ------------------------------------------------------------------ ambient
  startAmbient() {
    this.init();
    this.ambientDesired = true;
    if (!this.settings.enabled) return this;
    const ctx = this._ensureContext();
    if (!ctx) return this;
    if (ctx.state !== 'running' || !this.unlocked) return this; // unlock 后自动补播
    if (this._ambient) return this;
    try {
      this._buildAmbient();
    } catch (err) {
      this._warn('ambient failed', err);
    }
    return this;
  }

  stopAmbient() {
    this.ambientDesired = false;
    for (const timer of this._ambientTimers) clearTimeout(timer);
    this._ambientTimers = [];
    const ambient = this._ambient;
    if (!ambient) return this;
    this._ambient = null;
    try {
      const ctx = this.ctx;
      const t = ctx.currentTime;
      ambient.bus.gain.cancelScheduledValues(t);
      ambient.bus.gain.setValueAtTime(Math.max(ambient.bus.gain.value, 0.0001), t);
      ambient.bus.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      for (const node of ambient.nodes) {
        try {
          node.stop(t + 0.85);
        } catch {
          /* 部分节点无 stop */
        }
      }
      setTimeout(() => {
        try {
          ambient.bus.disconnect();
        } catch {
          /* noop */
        }
      }, 1000);
    } catch {
      /* noop */
    }
    return this;
  }

  destroy() {
    this.stopAmbient();
    if (this._visBound && this._onVisibility) {
      try {
        document.removeEventListener('visibilitychange', this._onVisibility);
      } catch {
        /* noop */
      }
    }
    this._visBound = false;
    this._onVisibility = null;
    try {
      if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
    } catch {
      /* noop */
    }
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.ambientBus = null;
    this._init = false;
    this.unlocked = false;
    return this;
  }

  // ------------------------------------------------------------------ private
  _warn(msg, err) {
    if (this._warned.has(msg)) return;
    this._warned.add(msg);
    try {
      console.warn('[audio]', msg, err || '');
    } catch {
      /* noop */
    }
  }

  _masterTarget() {
    return this.settings.enabled ? this.settings.volume * 0.92 : 0;
  }

  _rampMaster(timeConstant = 0.05) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const gain = this.master.gain;
    try {
      gain.cancelScheduledValues(t);
      gain.setTargetAtTime(this._masterTarget(), t, timeConstant);
    } catch {
      gain.value = this._masterTarget();
    }
  }

  _ensureContext() {
    if (this.ctx) return this.ctx;
    if (this.failed) return null;
    if (typeof window === 'undefined') {
      this.failed = true;
      return null;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      this.failed = true;
      this._warn('WebAudio unavailable');
      return null;
    }
    try {
      const ctx = new AC({ latencyHint: 'interactive' });
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -14;
      limiter.knee.value = 8;
      limiter.ratio.value = 7;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.24;
      const master = ctx.createGain();
      master.gain.value = this._masterTarget();
      const sfxBus = ctx.createGain();
      sfxBus.gain.value = 0.9;
      const ambientBus = ctx.createGain();
      ambientBus.gain.value = 0.85;
      sfxBus.connect(master);
      ambientBus.connect(master);
      master.connect(limiter);
      limiter.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      this.sfxBus = sfxBus;
      this.ambientBus = ambientBus;
      this.limiter = limiter;
      this.white = this._makeNoise(2, false);
      this.brown = this._makeNoise(3, true);
      return ctx;
    } catch (err) {
      this.failed = true;
      this._warn('AudioContext creation failed', err);
      return null;
    }
  }

  _silentTick() {
    try {
      const ctx = this.ctx;
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = 0.00001;
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start(0);
    } catch {
      /* noop */
    }
  }

  _bindVisibility() {
    if (this._visBound || typeof document === 'undefined') return;
    this._visBound = true;
    this._onVisibility = () => {
      if (!this.ctx) return;
      if (document.hidden) {
        if (this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
      } else if (this.unlocked && this.settings.enabled) {
        this.ctx.resume().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  _makeNoise(seconds, brown) {
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i += 1) {
      const white = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.018 * white) / 1.018;
        data[i] = last * 2.4;
      } else {
        data[i] = white;
      }
    }
    return buffer;
  }

  // ---- graph helpers --------------------------------------------------------
  _panner(pan) {
    const ctx = this.ctx;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      return p;
    }
    return ctx.createGain();
  }

  _out(pan = 0) {
    const node = this._panner(pan);
    node.connect(this.sfxBus);
    return node;
  }

  /** 包络增益：attack → 指数衰减到静音，结束点硬归零避免爆音。 */
  _env(t, peak, attack, dur) {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    const p = Math.max(clamp(peak, 0, 1.5), 0.0001);
    const a = Math.max(attack, 0.0015);
    const d = Math.max(dur, a + 0.02);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(p, t + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + d);
    gain.gain.setValueAtTime(0, t + d + 0.002);
    return gain;
  }

  _filter(type, freq, q = 0.8) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = clamp(freq, 20, 20000);
    f.Q.value = clamp(q, 0.0001, 30);
    return f;
  }

  _tone(t, opts) {
    const ctx = this.ctx;
    const {
      type = 'sine',
      f0 = 440,
      f1 = 0,
      dur = 0.2,
      vol = 0.06,
      attack = 0.005,
      pan = 0,
      filterType = '',
      filterFreq = 1200,
      q = 0.8,
      vibrato = 0,
      vibratoHz = 5.2,
    } = opts || {};
    const out = this._out(pan);
    const gain = this._env(t, vol, attack, dur);
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(f0, 1), t);
    if (f1 && f1 !== f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    }
    let tail = gain;
    if (filterType) {
      const filter = this._filter(filterType, filterFreq, q);
      gain.connect(filter);
      filter.connect(out);
    } else {
      gain.connect(out);
    }
    if (vibrato) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = vibratoHz;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = vibrato;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + dur + 0.04);
    return tail;
  }

  _noise(t, opts) {
    const ctx = this.ctx;
    const {
      dur = 0.2,
      vol = 0.06,
      type = 'bandpass',
      f0 = 1200,
      f1 = 0,
      q = 1,
      attack = 0.006,
      pan = 0,
      brown = false,
    } = opts || {};
    const src = ctx.createBufferSource();
    src.buffer = brown ? this.brown : this.white;
    src.loop = true;
    const filter = this._filter(type, f0, q);
    if (f1 && f1 !== f0) {
      filter.frequency.setValueAtTime(clamp(f0, 20, 20000), t);
      filter.frequency.exponentialRampToValueAtTime(clamp(f1, 20, 20000), t + dur);
    }
    const gain = this._env(t, vol, attack, dur);
    const out = this._out(pan);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    src.start(t, Math.random() * 0.4);
    src.stop(t + dur + 0.04);
    return gain;
  }

  /** 金属/钟片音：非谐振正弦分音叠加，金币、宝石、钟声共用。 */
  _metal(t, freq, dur, vol, opts = {}) {
    const ctx = this.ctx;
    const pan = opts.pan || 0;
    const out = this._out(pan);
    const ratios = opts.ratios || [1, 2.01, 2.76, 5.4, 8.93];
    const weights = [1, 0.55, 0.34, 0.2, 0.1];
    ratios.forEach((ratio, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = clamp(freq * ratio, 20, 18000);
      const peak = vol * weights[i];
      const decay = Math.max(0.05, dur / (1 + i * 0.55));
      const gain = this._env(t + i * 0.002, peak, 0.002, decay);
      osc.connect(gain);
      gain.connect(out);
      osc.start(t);
      osc.stop(t + decay + 0.05);
    });
    return out;
  }

  _chime(t, freq, dur, vol, pan = 0) {
    this._metal(t, freq, dur, vol, { pan, ratios: [1, 2, 3.01, 4.6], });
  }

  _horn(t, freq, dur, vol, pan = 0) {
    const ctx = this.ctx;
    const out = this._out(pan);
    const gain = this._env(t, vol, 0.09, dur);
    const lp = this._filter('lowpass', 900, 0.9);
    lp.frequency.setValueAtTime(420, t);
    lp.frequency.linearRampToValueAtTime(1500, t + Math.min(0.22, dur * 0.4));
    lp.frequency.exponentialRampToValueAtTime(700, t + dur);
    gain.connect(lp);
    lp.connect(out);
    const detunes = [-6, 0, 7];
    detunes.forEach((cents, i) => {
      const osc = ctx.createOscillator();
      osc.type = i === 1 ? 'sawtooth' : 'triangle';
      osc.frequency.value = freq * (i === 2 ? 0.999 : 1);
      osc.detune.value = cents;
      osc.connect(gain);
      osc.start(t);
      osc.stop(t + dur + 0.08);
    });
    // 轻微铜管亮音
    const shine = ctx.createOscillator();
    shine.type = 'sine';
    shine.frequency.value = freq * 2;
    const shineGain = this._env(t + 0.03, vol * 0.16, 0.05, dur * 0.8);
    shine.connect(shineGain);
    shineGain.connect(out);
    shine.start(t);
    shine.stop(t + dur + 0.05);
    // 气声
    this._noise(t, { dur: dur * 0.9, vol: vol * 0.22, type: 'bandpass', f0: 700, f1: 1400, q: 0.7, attack: 0.08, pan });
  }

  _pluck(t, freq, dur, vol, pan = 0) {
    const ctx = this.ctx;
    const out = this._out(pan);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq * 1.03, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + 0.05);
    const gain = this._env(t, vol, 0.004, dur);
    gain.connect(out);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + dur + 0.04);
    this._noise(t, { dur: 0.035, vol: vol * 0.3, type: 'highpass', f0: 2600, q: 0.7, pan });
  }

  _bell(t, freq, dur, vol, pan = 0) {
    this._metal(t, freq, dur, vol, { pan, ratios: [1, 2.4, 3.8, 5.3, 7.1], });
  }

  _thunder(t, vol = 0.1, pan = 0) {
    const ctx = this.ctx;
    const out = this._out(pan);
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    const lp = this._filter('lowpass', 420, 0.7);
    lp.frequency.setValueAtTime(420, t);
    lp.frequency.exponentialRampToValueAtTime(65, t + 1.9);
    const gain = this._env(t, vol, 0.025, 2.0);
    src.connect(lp);
    lp.connect(gain);
    gain.connect(out);
    src.start(t, Math.random());
    src.stop(t + 2.05);
    // 次低频轰鸣
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(58, t);
    sub.frequency.exponentialRampToValueAtTime(32, t + 1.7);
    const subGain = this._env(t, vol * 0.55, 0.02, 1.8);
    sub.connect(subGain);
    subGain.connect(out);
    sub.start(t);
    sub.stop(t + 1.9);
  }

  // ---- ambient --------------------------------------------------------------
  _buildAmbient() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.linearRampToValueAtTime(0.9, t + 1.8);
    bus.connect(this.ambientBus);

    // 低频 drone：55Hz + 纯五度 + 三角波泛音
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.045;
    const lp = this._filter('lowpass', 220, 0.4);
    droneGain.connect(lp);
    lp.connect(bus);
    const freqs = [55, 82.41, 110];
    const nodes = [];
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = i === 2 ? 'triangle' : 'sine';
      osc.frequency.value = f;
      osc.detune.value = (i - 1) * 5;
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.55 : i === 1 ? 0.24 : 0.12;
      osc.connect(g);
      g.connect(droneGain);
      osc.start(t);
      nodes.push(osc);
    });
    const breath = ctx.createOscillator();
    breath.frequency.value = 0.045;
    const breathGain = ctx.createGain();
    breathGain.gain.value = 0.016;
    breath.connect(breathGain);
    breathGain.connect(droneGain.gain);
    breath.start(t);
    nodes.push(breath);

    // 风
    const wind = ctx.createBufferSource();
    wind.buffer = this.white;
    wind.loop = true;
    const windFilter = this._filter('bandpass', 460, 0.55);
    const windGain = ctx.createGain();
    windGain.gain.value = 0.011;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(bus);
    wind.start(t);
    nodes.push(wind);
    const windLfo = ctx.createOscillator();
    windLfo.frequency.value = 0.07;
    const windLfoGain = ctx.createGain();
    windLfoGain.gain.value = 0.005;
    windLfo.connect(windLfoGain);
    windLfoGain.connect(windGain.gain);
    windLfo.start(t);
    nodes.push(windLfo);

    this._ambient = { bus, nodes };
    this._scheduleCrackle();
  }

  _scheduleCrackle() {
    if (!this._ambient) return;
    const delay = 4200 + Math.random() * 6500;
    const timer = setTimeout(() => {
      if (!this._ambient) return;
      try {
        const t = this.ctx.currentTime + 0.01;
        const bus = this._ambient.bus;
        const vol = 0.006 + Math.random() * 0.01;
        const src = this.ctx.createBufferSource();
        src.buffer = this.white;
        src.loop = true;
        const hp = this._filter('highpass', 1800 + Math.random() * 2200, 0.7);
        const gain = this._env(t, vol, 0.002, 0.03 + Math.random() * 0.05);
        src.connect(hp);
        hp.connect(gain);
        gain.connect(bus);
        src.start(t);
        src.stop(t + 0.1);
        if (Math.random() < 0.18) this._thunder(t + 0.05, 0.022, Math.random() * 1.2 - 0.6);
      } catch {
        /* noop */
      }
      this._scheduleCrackle();
    }, delay);
    this._ambientTimers.push(timer);
  }
}

// ============================================================================
//  SFX 合成配方
//  AudioContext.currentTime 为 t；opts 提供 volume/pitch/pan。
// ============================================================================
const SOUNDS = {
  'ui-click'(t, o) {
    const v = volOf(o, 0.8);
    const r = pitchOf(o);
    this._noise(t, { dur: 0.045, vol: 0.045 * v, type: 'highpass', f0: 2600 * r, q: 0.7, attack: 0.002, pan: panOf(o) });
    this._tone(t, { type: 'triangle', f0: 310 * r, f1: 205 * r, dur: 0.075, vol: 0.05 * v, pan: panOf(o) });
  },

  'ui-hover'(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    this._tone(t, { type: 'sine', f0: 880 * r, f1: 1180 * r, dur: 0.055, vol: 0.018 * v, attack: 0.006, pan: panOf(o) });
  },

  coin(t, o) {
    const v = volOf(o, 0.9);
    const r = pitchOf(o);
    this._metal(t, 2093 * r, 0.32, 0.052 * v, { pan: panOf(o) });
    this._metal(t + 0.018, 2793 * r, 0.26, 0.032 * v, { pan: panOf(o) });
    this._noise(t, { dur: 0.13, vol: 0.018 * v, type: 'bandpass', f0: 3200, f1: 1600, q: 2.4 });
    this._tone(t, { type: 'sine', f0: 1320 * r, f1: 1980 * r, dur: 0.18, vol: 0.01 * v });
  },

  'card-draw'(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    this._noise(t, { dur: 0.21, vol: 0.042 * v, type: 'bandpass', f0: 720 * r, f1: 2400 * r, q: 1.1, attack: 0.018, pan: panOf(o) });
    this._noise(t + 0.03, { dur: 0.09, vol: 0.016 * v, type: 'highpass', f0: 3200, q: 0.7, pan: panOf(o) * -0.5 });
  },

  'card-place'(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    this._noise(t, { dur: 0.13, vol: 0.05 * v, type: 'bandpass', f0: 1900 * r, f1: 620, q: 1.0, attack: 0.004, pan: panOf(o) });
    this._tone(t + 0.01, { type: 'sine', f0: 118 * r, f1: 52 * r, dur: 0.2, vol: 0.085 * v, attack: 0.004 });
    this._noise(t + 0.02, { dur: 0.07, vol: 0.03 * v, type: 'lowpass', f0: 500, q: 0.6 });
  },

  'card-flip'(t, o) {
    const v = volOf(o, 0.9);
    const r = pitchOf(o);
    this._noise(t, { dur: 0.1, vol: 0.04 * v, type: 'highpass', f0: 2400 * r, q: 0.7, pan: panOf(o) });
    this._noise(t + 0.015, { dur: 0.06, vol: 0.024 * v, type: 'bandpass', f0: 1200, q: 1.6 });
    this._tone(t, { type: 'triangle', f0: 520 * r, f1: 380 * r, dur: 0.05, vol: 0.02 * v });
  },

  'hero-place'(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    this._horn(t, 98 * r, 0.72, 0.075 * v, panOf(o));
    this._tone(t + 0.02, { type: 'sine', f0: 65 * r, f1: 44 * r, dur: 0.65, vol: 0.08 * v, attack: 0.02 });
    this._chime(t + 0.16, 1174 * r, 0.7, 0.02 * v);
    this._noise(t, { dur: 0.5, vol: 0.022 * v, type: 'lowpass', f0: 600, f1: 220, q: 0.6, attack: 0.08 });
  },

  spy(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    this._noise(t, { dur: 0.55, vol: 0.037 * v, type: 'lowpass', f0: 900 * r, f1: 380, q: 0.8, attack: 0.09, pan: panOf(o) });
    this._tone(t + 0.04, { type: 'sine', f0: 415 * r, f1: 210 * r, dur: 0.5, vol: 0.028 * v, attack: 0.05 });
    this._tone(t + 0.3, { type: 'triangle', f0: 277 * r, f1: 240, dur: 0.28, vol: 0.018 * v, attack: 0.03 });
    this._metal(t + 0.42, 880 * r, 0.22, 0.012 * v);
  },

  medic(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    const pan = panOf(o);
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      this._chime(t + i * 0.075, f * r, 0.85, 0.026 * v, pan);
    });
    this._noise(t, { dur: 0.75, vol: 0.014 * v, type: 'highpass', f0: 3600, q: 0.5, attack: 0.15, pan });
    this._tone(t, { type: 'sine', f0: 261.63 * r, f1: 392 * r, dur: 0.7, vol: 0.02 * v, attack: 0.12 });
  },

  muster(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    const pan = panOf(o);
    [196, 261.63, 329.63].forEach((f, i) => {
      this._pluck(t + i * 0.075, f * r, 0.28, 0.045 * v, pan + (i - 1) * 0.15);
    });
    this._noise(t, { dur: 0.22, vol: 0.022 * v, type: 'bandpass', f0: 900, f1: 2200, q: 0.9, attack: 0.02 });
  },

  scorch(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    this._noise(t, { dur: 0.95, vol: 0.095 * v, type: 'lowpass', f0: 900 * r, f1: 170, q: 0.7, attack: 0.05, brown: true, pan: panOf(o) });
    this._tone(t + 0.02, { type: 'sine', f0: 78 * r, f1: 38, dur: 0.8, vol: 0.08 * v, attack: 0.01 });
    this._noise(t + 0.05, { dur: 0.6, vol: 0.028 * v, type: 'highpass', f0: 2200, q: 0.6, attack: 0.03 });
    for (let i = 0; i < 4; i += 1) {
      this._noise(t + 0.08 + i * 0.13, { dur: 0.035, vol: 0.02 * v, type: 'highpass', f0: 2600 + Math.random() * 2000, q: 1.4 });
    }
  },

  'weather-frost'(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    [1568, 1318.5, 1046.5, 783.99].forEach((f, i) => {
      this._chime(t + i * 0.09, f * r, 0.9, 0.018 * v, panOf(o) * (i % 2 ? -1 : 1));
    });
    this._noise(t, { dur: 0.8, vol: 0.014 * v, type: 'highpass', f0: 4200, q: 0.4, attack: 0.2, pan: panOf(o) });
    this._tone(t, { type: 'sine', f0: 196 * r, f1: 146.83, dur: 0.9, vol: 0.016 * v, attack: 0.25 });
  },

  'weather-fog'(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    this._noise(t, { dur: 1.5, vol: 0.038 * v, type: 'bandpass', f0: 340, f1: 520, q: 0.55, attack: 0.4, pan: panOf(o) });
    this._tone(t, { type: 'sine', f0: 73.42 * r, f1: 55, dur: 1.4, vol: 0.022 * v, attack: 0.4 });
    this._tone(t + 0.2, { type: 'triangle', f0: 110 * r, f1: 98, dur: 1.0, vol: 0.01 * v, attack: 0.3 });
  },

  'weather-rain'(t, o) {
    const v = volOf(o, 1);
    this._noise(t, { dur: 1.6, vol: 0.042 * v, type: 'bandpass', f0: 3600, f1: 2600, q: 0.4, attack: 0.3, pan: panOf(o) });
    this._noise(t + 0.1, { dur: 1.3, vol: 0.03 * v, type: 'lowpass', f0: 1100, q: 0.5, attack: 0.35, brown: true });
    this._tone(t, { type: 'sine', f0: 110 * pitchOf(o), f1: 82, dur: 1.2, vol: 0.014 * v, attack: 0.3 });
  },

  'weather-storm'(t, o) {
    const v = volOf(o, 1);
    const pan = panOf(o);
    this._noise(t, { dur: 1.8, vol: 0.042 * v, type: 'bandpass', f0: 3200, f1: 2200, q: 0.4, attack: 0.25, pan });
    this._thunder(t + 0.18, 0.085 * v, pan * 0.7);
    this._tone(t, { type: 'sine', f0: 55 * pitchOf(o), f1: 41, dur: 1.6, vol: 0.018 * v, attack: 0.3 });
  },

  'weather-clear'(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    [659.25, 783.99, 987.77, 1318.5].forEach((f, i) => {
      this._chime(t + i * 0.075, f * r, 0.9, 0.017 * v, panOf(o) * (i % 2 ? 1 : -1));
    });
    this._noise(t, { dur: 1.0, vol: 0.012 * v, type: 'highpass', f0: 3000, q: 0.5, attack: 0.3 });
    this._tone(t, { type: 'triangle', f0: 196 * r, f1: 246.94 * r, dur: 1.0, vol: 0.016 * v, attack: 0.25 });
  },

  horn(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    const pan = panOf(o);
    this._horn(t, 196 * r, 0.95, 0.095 * v, pan);
    this._horn(t + 0.42, 293.66 * r, 0.72, 0.07 * v, pan * 0.4);
    this._noise(t, { dur: 0.9, vol: 0.012 * v, type: 'bandpass', f0: 900, f1: 1600, q: 0.7, attack: 0.15, pan });
    this._tone(t, { type: 'sine', f0: 98 * r, dur: 0.9, vol: 0.02 * v, attack: 0.1 });
  },

  mardroeme(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    this._tone(t, { type: 'sine', f0: 110 * r, f1: 54, dur: 0.7, vol: 0.075 * v, attack: 0.06, pan: panOf(o) });
    this._noise(t, { dur: 0.6, vol: 0.03 * v, type: 'lowpass', f0: 340, f1: 160, q: 0.8, attack: 0.1, brown: true });
    this._tone(t + 0.24, { type: 'sine', f0: 72 * r, f1: 48, dur: 0.3, vol: 0.05 * v, attack: 0.01 });
    this._tone(t + 0.5, { type: 'sine', f0: 72 * r, f1: 48, dur: 0.35, vol: 0.038 * v, attack: 0.01 });
    this._chime(t + 0.55, 311.13 * r, 0.5, 0.012 * v);
  },

  avenger(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    this._noise(t, { dur: 0.28, vol: 0.07 * v, type: 'highpass', f0: 1500, q: 0.6, attack: 0.002, pan: panOf(o) });
    this._metal(t, 880 * r, 0.35, 0.034 * v);
    this._metal(t + 0.03, 1320 * r, 0.45, 0.024 * v);
    this._tone(t + 0.06, { type: 'sine', f0: 220 * r, f1: 440 * r, dur: 0.5, vol: 0.03 * v, attack: 0.02 });
    this._tone(t + 0.2, { type: 'triangle', f0: 110 * r, f1: 82, dur: 0.6, vol: 0.025 * v, attack: 0.05 });
  },

  leader(t, o) {
    const v = volOf(o, 0.95);
    const r = pitchOf(o);
    this._bell(t, 130.81 * r, 1.5, 0.075 * v, panOf(o));
    this._horn(t + 0.04, 146.83 * r, 0.85, 0.055 * v, panOf(o));
    this._tone(t, { type: 'sine', f0: 49 * r, f1: 36.7, dur: 1.0, vol: 0.075 * v, attack: 0.02 });
    this._noise(t, { dur: 0.9, vol: 0.02 * v, type: 'lowpass', f0: 800, f1: 220, q: 0.7, attack: 0.06 });
    this._metal(t + 0.02, 392 * r, 0.8, 0.016 * v);
  },

  pass(t, o) {
    const v = volOf(o, 0.9);
    const r = pitchOf(o);
    this._tone(t, { type: 'triangle', f0: 196 * r, f1: 147 * r, dur: 0.45, vol: 0.042 * v, attack: 0.02, pan: panOf(o) });
    this._noise(t, { dur: 0.4, vol: 0.022 * v, type: 'lowpass', f0: 700, f1: 300, q: 0.6, attack: 0.05 });
    this._tone(t + 0.18, { type: 'sine', f0: 98 * r, f1: 73.42, dur: 0.4, vol: 0.028 * v, attack: 0.03 });
  },

  turn(t, o) {
    const v = volOf(o, 0.8);
    const r = pitchOf(o);
    this._tone(t, { type: 'triangle', f0: 660 * r, f1: 880 * r, dur: 0.06, vol: 0.024 * v, attack: 0.003, pan: panOf(o) });
    this._tone(t + 0.075, { type: 'triangle', f0: 880 * r, f1: 1046 * r, dur: 0.07, vol: 0.02 * v, attack: 0.003 });
    this._noise(t, { dur: 0.05, vol: 0.012 * v, type: 'highpass', f0: 3000, q: 0.8 });
  },

  'round-win'(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    const pan = panOf(o);
    const notes = [293.66, 392, 466.16, 587.33];
    notes.forEach((f, i) => {
      this._horn(t + i * 0.135, f * r, 0.55, 0.055 * v, pan + (i - 1.5) * 0.12);
    });
    [293.66, 392, 466.16].forEach((f) => this._horn(t + 0.56, f * r, 0.85, 0.028 * v, pan));
    this._chime(t + 0.5, 1174.66 * r, 0.9, 0.014 * v);
    this._tone(t + 0.55, { type: 'sine', f0: 49 * r, dur: 0.9, vol: 0.035 * v, attack: 0.02 });
  },

  'round-lose'(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    const pan = panOf(o);
    const notes = [220, 196, 164.81, 130.81];
    notes.forEach((f, i) => {
      this._tone(t + i * 0.2, { type: 'sawtooth', f0: f * r, f1: f * r * 0.985, dur: 0.65, vol: 0.03 * v, attack: 0.04, filterType: 'lowpass', filterFreq: 640, q: 0.7, pan });
    });
    this._tone(t, { type: 'sine', f0: 55 * r, f1: 41, dur: 1.2, vol: 0.045 * v, attack: 0.06 });
    this._noise(t, { dur: 1.1, vol: 0.016 * v, type: 'lowpass', f0: 500, f1: 180, q: 0.5, attack: 0.15, brown: true });
  },

  'round-draw'(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    this._tone(t, { type: 'triangle', f0: 293.66 * r, dur: 0.5, vol: 0.035 * v, attack: 0.02, pan: panOf(o) });
    this._tone(t + 0.2, { type: 'triangle', f0: 293.66 * r, dur: 0.6, vol: 0.028 * v, attack: 0.02 });
    this._bell(t + 0.45, 293.66 * r, 0.7, 0.02 * v);
  },

  'gem-crack'(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    this._noise(t, { dur: 0.06, vol: 0.05 * v, type: 'highpass', f0: 2600 * r, q: 0.8, attack: 0.001, pan: panOf(o) });
    this._metal(t + 0.01, 1760 * r, 0.3, 0.032 * v, { pan: panOf(o) });
    this._metal(t + 0.02, 2349 * r, 0.22, 0.02 * v);
    this._noise(t + 0.03, { dur: 0.22, vol: 0.028 * v, type: 'highpass', f0: 4200, q: 0.5, attack: 0.004 });
    this._tone(t, { type: 'sine', f0: 146.83 * r, f1: 110, dur: 0.25, vol: 0.025 * v, attack: 0.004 });
  },

  victory(t, o) {
    const v = volOf(o, 1);
    const r = pitchOf(o);
    const pan = panOf(o);
    const motif = [261.63, 329.63, 392, 523.25, 659.25];
    motif.forEach((f, i) => {
      this._horn(t + i * 0.17, f * r, 0.6, 0.055 * v, pan + (i - 2) * 0.1);
    });
    [261.63, 329.63, 392, 523.25].forEach((f) => this._horn(t + 0.86, f * r, 1.15, 0.03 * v, pan));
    this._chime(t + 0.8, 1046.5 * r, 1.4, 0.016 * v);
    this._chime(t + 1.0, 1318.5 * r, 1.2, 0.012 * v);
    this._tone(t + 0.86, { type: 'sine', f0: 65.41 * r, dur: 1.3, vol: 0.05 * v, attack: 0.03 });
    this._noise(t + 0.86, { dur: 1.1, vol: 0.018 * v, type: 'bandpass', f0: 1200, f1: 2400, q: 0.6, attack: 0.1 });
  },

  defeat(t, o) {
    const v = volOf(o, 0.95);
    const r = pitchOf(o);
    this._bell(t, 98 * r, 2.2, 0.05 * v, panOf(o));
    this._tone(t, { type: 'sine', f0: 55 * r, f1: 36.7, dur: 2.0, vol: 0.055 * v, attack: 0.15 });
    this._tone(t + 0.1, { type: 'sawtooth', f0: 82.41 * r, f1: 55, dur: 1.9, vol: 0.02 * v, attack: 0.2, filterType: 'lowpass', filterFreq: 260, q: 0.6 });
    this._noise(t, { dur: 2.1, vol: 0.022 * v, type: 'lowpass', f0: 420, f1: 120, q: 0.5, attack: 0.3, brown: true });
  },

  error(t, o) {
    const v = volOf(o, 0.8);
    const r = pitchOf(o);
    // 克制的木质双音，不刺耳
    this._tone(t, { type: 'triangle', f0: 196 * r, f1: 174.61 * r, dur: 0.14, vol: 0.04 * v, attack: 0.004, filterType: 'lowpass', filterFreq: 700, q: 0.6, pan: panOf(o) });
    this._tone(t + 0.13, { type: 'triangle', f0: 174.61 * r, f1: 146.83 * r, dur: 0.2, vol: 0.034 * v, attack: 0.004, filterType: 'lowpass', filterFreq: 640, q: 0.6 });
    this._noise(t, { dur: 0.06, vol: 0.012 * v, type: 'lowpass', f0: 900, q: 0.8 });
  },
};

// ============================================================================
//  Public singleton
// ============================================================================
export const audio = new SoundEngine();

// 便捷：页面首次 pointerdown/keydown 自动 unlock（Lead 也可手动调用）。
// 使用一次性监听，不劫持交互；capture 阶段尽早解锁。
export function installAudioUnlock(target = typeof window !== 'undefined' ? window : null) {
  if (!target || target.__gwentAudioUnlock) return;
  target.__gwentAudioUnlock = true;
  const unlock = () => {
    audio.unlock().then((ok) => {
      if (!ok) return;
      target.removeEventListener('pointerdown', unlock, true);
      target.removeEventListener('keydown', unlock, true);
      target.removeEventListener('touchstart', unlock, true);
    });
  };
  target.addEventListener('pointerdown', unlock, true);
  target.addEventListener('keydown', unlock, true);
  target.addEventListener('touchstart', unlock, true);
}

export default audio;
