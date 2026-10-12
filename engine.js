'use strict';
/* WebGBA engine: everything that is not UI. mGBA (WebAssembly) in, pixels/sound/files out.
   The React UI in ui.js only talks to this through the global `GBA` object. */
(() => {
const W = 240, H = 160;
const BTN = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };
const DEFAULT_KEYS = {
  UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight',
  A: 'KeyX', B: 'KeyZ', L: 'KeyA', R: 'KeyS', START: 'Enter', SELECT: 'Backspace',
  TURBO: 'Tab', PAUSE: 'KeyP', SAVE: 'F5', LOAD: 'F8', SLOT: 'KeyN',
};
// Standard-mapping gamepad indices: 0 south, 1 east, 2 west, 3 north, 4/5 bumpers, 6/7 triggers, 8 select, 9 start, 12-15 d-pad. -1 = unbound.
const DEFAULT_PAD = { A: 1, B: 0, L: 4, R: 5, START: 9, SELECT: 8, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, TURBO: 2, SAVE: 3, LOAD: 6, SLOT: 7, PAUSE: -1 };
const defaults = () => ({
  v: 1,
  settings: { vol: 70, filter: 'sharp', scale: 'fit', pauseHidden: true, turboSpeed: 4, turboAudio: 'fast', glow: true, touch: 'auto', slot: 1 },
  keys: { ...DEFAULT_KEYS }, pad: { ...DEFAULT_PAD }, cheats: {}, meta: {}, covers: {},
});
const FRAME_MS = 1000 / 59.7275;
const ROM_RE = /\.(gba|agb|bin|mb)$/i;

/* ------------------------------------------------------------ observable state */
let state = {
  ready: false, serverMode: false, running: false, paused: false, turbo: false, audioStatus: 'off',
  title: '', romName: '', id: '', fps: 0, library: [], libHint: '', config: defaults(),
  toast: null, busy: null, dragging: false, flash: 0, bios: false,
  pad: { connected: false, family: 'generic', name: '' }, input: 'mouse', padListening: null,
};
const subs = new Set();
const set = (p) => { state = { ...state, ...p }; subs.forEach((f) => f()); };
let toastT;
function toast(msg) { set({ toast: { msg, id: Date.now() } }); clearTimeout(toastT); toastT = setTimeout(() => set({ toast: null }), 2600); }

const R = { kbd: 0, pad: 0, touch: 0, acc: 0, last: 0, frames: 0, fpsAt: 0, dirty: false, audio: null, level: 0,
  lastSave: null, lastRom: null, codes: {}, overlayPaused: false, autoPaused: false, dec: { n: 0, l: 0, r: 0 },
  glowAt: 0, gc: null, canvas: null, ctx: null, drag: 0,
  input: 0, combo: false, rep: {}, padPrev: new Set(), nav: { active: false, handler: null }, menuCb: null,
  turboSticky: false, turboKbd: false, turboPad: false, listen: null, listenT: 0, coverT: 0, importing: false, legacyId: '' };
const glowCanvas = document.createElement('canvas'); glowCanvas.width = 4; glowCanvas.height = 3;
const gctx = glowCanvas.getContext('2d', { willReadFrequently: true });

/* ---------------------------------------------------------------------- storage */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('webgba', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const idbReq = (mode, fn) => idb().then((db) => new Promise((res, rej) => {
  const tx = db.transaction('kv', mode), q = fn(tx.objectStore('kv'));
  tx.oncomplete = () => res(q.result); tx.onerror = () => rej(tx.error);
}));
const idbGet = (k) => idbReq('readonly', (s) => s.get(k)).then((v) => v || null);
const idbPut = (k, v) => idbReq('readwrite', (s) => s.put(v, k));
const idbKeys = () => idbReq('readonly', (s) => s.getAllKeys());
const idbDel = (k) => idbReq('readwrite', (s) => s.delete(k));

/* With the Rust server, everything is a real file in ./data. Served as plain static
   files (e.g. GitHub Pages) it falls back to this browser's IndexedDB/localStorage. */
const store = {
  server: false,
  url: (kind, key) => (kind === 'save' ? `/api/save/${key}` : `/api/state/${key}`),
  async get(kind, key) {
    if (this.server) {
      const r = await fetch(this.url(kind, key));
      if (!r.ok || r.status === 204) return null;
      const b = new Uint8Array(await r.arrayBuffer());
      return b.length ? b : null;
    }
    const v = await idbGet(`${kind}:${key}`);
    return v ? new Uint8Array(v) : null;
  },
  async put(kind, key, bytes) {
    if (this.server) {
      const r = await fetch(this.url(kind, key), { method: 'PUT', body: bytes });
      if (!r.ok) throw new Error('server refused write');
    } else await idbPut(`${kind}:${key}`, bytes);
  },
  async list() {
    if (this.server) return (await fetch('/api/data')).json();
    const keys = await idbKeys();
    return {
      saves: keys.filter((k) => k.startsWith('save:')).map((k) => k.slice(5)),
      states: keys.filter((k) => k.startsWith('state:')).map((k) => { const [id, slot] = k.slice(6).split('/'); return { id, slot }; }),
    };
  },
  async getConfig() {
    if (this.server) { const r = await fetch('/api/config'); return r.ok && r.status !== 204 ? r.json() : null; }
    try { return JSON.parse(localStorage.getItem('webgba.config') || 'null'); } catch (e) { return null; }
  },
  async putConfig(obj) {
    const txt = JSON.stringify(obj);
    if (this.server) { const r = await fetch('/api/config', { method: 'PUT', body: txt }); if (!r.ok) throw new Error('server refused config write'); }
    else localStorage.setItem('webgba.config', txt);
  },
};

/* ----------------------------------------------------------------- game library */
/* Games you scan or open are SAVED: as files in roms/ when the Rust server runs, otherwise in this browser. */
const Library = {
  async list() {
    if (store.server) return (await fetch('/api/roms')).json();
    return (await idbGet('romidx')) || [];
  },
  async get(name) {
    if (store.server) {
      const r = await fetch('/rom/' + encodeURIComponent(name));
      if (!r.ok) throw new Error('server returned ' + r.status);
      return new Uint8Array(await r.arrayBuffer());
    }
    const b = await idbGet('rom:' + name);
    if (!b) throw new Error('game not found');
    return new Uint8Array(b);
  },
  async add(name, bytes) {
    if (store.server) {
      const r = await fetch('/api/rom/' + encodeURIComponent(name), { method: 'PUT', body: bytes });
      if (!r.ok) throw new Error('server refused ' + r.status);
      return;
    }
    await idbPut('rom:' + name, bytes);
    const idx = (await idbGet('romidx')) || [], e = { name, size: bytes.length }, i = idx.findIndex((x) => x.name === name);
    i >= 0 ? (idx[i] = e) : idx.push(e);
    await idbPut('romidx', idx);
  },
  async remove(name) {
    if (store.server) { await fetch('/api/rom/' + encodeURIComponent(name), { method: 'DELETE' }); return; }
    await idbDel('rom:' + name);
    await idbPut('romidx', ((await idbGet('romidx')) || []).filter((x) => x.name !== name));
  },
};

/* ----------------------------------------------------------------------- config */
let cfgT;
function rebuildKeys() { R.codes = {}; for (const [a, c] of Object.entries(state.config.keys)) R.codes[c] = a; }
function commitConfig(c, persist = true) {
  set({ config: c }); rebuildKeys(); applyVolume();
  if (!persist) return;
  clearTimeout(cfgT); cfgT = setTimeout(() => store.putConfig(c).catch((e) => console.warn('config not saved', e)), 400);
}
function updateConfig(fn) { const c = structuredClone(state.config); fn(c); commitConfig(c); }
/* Everything read from a config file or backup zip is untrusted: keep only known keys, clamp numbers,
   and only accept our own jpeg/png data URLs for images (so a doctored backup can't make the page fetch anything). */
const CHOICES = { filter: ['sharp', 'smooth', 'lcd'], scale: ['fit', '2', '3', '4', '5'], turboAudio: ['fast', 'mute'], touch: ['auto', 'on', 'off'] };
const badKey = (k) => k === '__proto__' || k === 'constructor' || k === 'prototype' || k.length > 200;
const isImg = (u) => typeof u === 'string' && u.length < 200000 && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(u);
function mergeConfig(raw) {
  const d = defaults(); raw = raw && typeof raw === 'object' ? raw : {};
  const rs = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const num = (v, lo, hi, def) => { v = Math.round(+v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
  const settings = { ...d.settings };
  settings.vol = num(rs.vol, 0, 100, 70); settings.turboSpeed = num(rs.turboSpeed, 2, 16, 4); settings.slot = num(rs.slot, 1, 4, 1);
  for (const k of Object.keys(CHOICES)) settings[k] = CHOICES[k].includes(rs[k]) ? rs[k] : d.settings[k];
  settings.pauseHidden = rs.pauseHidden !== false; settings.glow = rs.glow !== false;
  const keys = { ...d.keys }, pad = { ...d.pad };
  for (const a of Object.keys(d.keys)) if (raw.keys && typeof raw.keys[a] === 'string' && raw.keys[a].length < 32) keys[a] = raw.keys[a];
  for (const a of Object.keys(d.pad)) if (raw.pad && Number.isInteger(raw.pad[a]) && raw.pad[a] >= -1 && raw.pad[a] < 32) pad[a] = raw.pad[a];
  const covers = {}, meta = {}, cheats = {};
  for (const [k, v] of Object.entries(raw.covers || {})) if (!badKey(k) && isImg(v)) covers[k] = v;
  for (const [id, slots] of Object.entries(raw.meta || {})) {
    if (badKey(id) || !slots || typeof slots !== 'object') continue;
    const m = {};
    for (const [n, e] of Object.entries(slots)) if (/^[1-4]$/.test(n) && e && Number.isFinite(+e.t) && isImg(e.thumb)) m[n] = { t: +e.t, thumb: e.thumb };
    meta[id] = m;
  }
  for (const [id, t] of Object.entries(raw.cheats || {})) if (!badKey(id) && typeof t === 'string' && t.length < 20000) cheats[id] = t;
  return { v: 1, settings, keys, pad, cheats, meta, covers };
}
function bindKey(action, code) {
  updateConfig((c) => {
    const other = Object.keys(c.keys).find((a) => a !== action && c.keys[a] === code);
    if (other) c.keys[other] = c.keys[action]; // swap instead of leaving two actions on one key
    c.keys[action] = code;
  });
}
const resetKeys = () => updateConfig((c) => { c.keys = { ...DEFAULT_KEYS }; });

/* ------------------------------------------------------------------------- core */
const Core = {
  m: null,
  async init() { this.m = await createMgba({ locateFile: (f) => 'core/' + f }); },
  heap() { return this.m.HEAPU8; },
  put(bytes) { const p = this.m._wg_alloc(bytes.length); if (!p) throw new Error('Not enough emulator memory'); this.m.HEAPU8.set(bytes, p); return p; },
  load(rom, save, bios) {
    const m = this.m;
    if (bios) { const p = this.put(bios); m._wg_set_bios(p, bios.length); m._wg_free(p); } else m._wg_set_bios(0, 0);
    if (save && save.length > SAVE_MAX) throw new Error('Stored save exceeds 128 KB');
    if (bios && bios.length !== 16384) throw new Error('Invalid BIOS size');
    if (save) { const p = this.put(save); m._wg_set_pending_save(p, save.length); m._wg_free(p); } else m._wg_set_pending_save(0, 0);
    const p = this.put(rom), ok = m._wg_load_rom(p, rom.length);
    m._wg_free(p);
    return !!ok;
  },
  frame(keys) { this.m._wg_set_keys(keys); this.m._wg_run_frame(); },
  video() { return new Uint8ClampedArray(this.heap().buffer, this.m._wg_video_ptr(), W * H * 4); },
  audio() { const n = this.m._wg_audio_count(); return n > 0 ? new Int16Array(this.heap().buffer, this.m._wg_audio_ptr(), n * 2) : null; },
  saveData() { const n = this.m._wg_save_size(), p = this.m._wg_save_ptr(); return n && p ? this.heap().slice(p, p + n) : null; },
  reset() { this.m._wg_reset(); },
  stateSave() { const n = this.m._wg_state_save(); if (!n) return null; const p = this.m._wg_state_ptr(); return this.heap().slice(p, p + n); },
  stateLoad(b) { const p = this.put(b), ok = this.m._wg_state_load(p, b.length); this.m._wg_free(p); return !!ok; },
  cheatClear() { this.m._wg_cheat_clear(); },
  cheatAdd(l) { return !!this.m.ccall('wg_cheat_add', 'number', ['string'], [l]); },
};

/* ------------------------------------------------------------------------ audio */
const WORKLET = `
class P extends AudioWorkletProcessor {
  constructor() {
    super(); this.cap = 16384; this.buf = new Float32Array(this.cap * 2); this.r = 0; this.w = 0; this.n = 0; this.t = 0;
    this.port.onmessage = (e) => { const d = e.data;
      for (let i = 0; i + 1 < d.length && this.n < this.cap; i += 2) {
        this.buf[this.w * 2] = d[i]; this.buf[this.w * 2 + 1] = d[i + 1]; this.w = (this.w + 1) % this.cap; this.n++; } };
  }
  process(_i, out) {
    const L = out[0][0], Rr = out[0][1] || out[0][0];
    for (let i = 0; i < L.length; i++) {
      if (this.n > 0) { L[i] = this.buf[this.r * 2]; Rr[i] = this.buf[this.r * 2 + 1]; this.r = (this.r + 1) % this.cap; this.n--; }
      else { L[i] = 0; Rr[i] = 0; } }
    if ((this.t++ & 15) === 0) this.port.postMessage(this.n);
    return true;
  }
}
registerProcessor('gba-audio', P);`;
async function ensureAudio() {
  if (R.audio) {
    if (R.audio.ctx.state !== 'running') {
      // Do not await resume: on Safari it can remain pending until the next tap.
      R.audio.ctx.resume().catch((e) => console.warn('Audio resume needs a tap', e));
      set({ audioStatus: 'tap' });
    } else set({ audioStatus: 'ready' });
    return;
  }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio is unavailable');
    const ctx = new Ctx({ sampleRate: Core.m._wg_sample_rate(), latencyHint: 'interactive' });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); }
    finally { URL.revokeObjectURL(url); }
    const node = new AudioWorkletNode(ctx, 'gba-audio', { outputChannelCount: [2] }), gain = ctx.createGain();
    node.connect(gain).connect(ctx.destination);
    node.port.onmessage = (e) => { R.level = e.data; };
    R.audio = { ctx, node, gain }; applyVolume();
    ctx.onstatechange = () => set({ audioStatus: ctx.state === 'running' ? 'ready' : 'tap' });
    set({ audioStatus: ctx.state === 'running' ? 'ready' : 'tap' });
    if (ctx.state === 'suspended') ctx.resume().catch((e) => console.warn('Audio waiting for tap', e));
  } catch (e) {
    console.warn('audio unavailable', e);
    set({ audioStatus: 'unavailable' }); toast('Sound unavailable; games can still run');
  }
}
const unlockAudio = () => { if (Core.m) ensureAudio(); };

function applyVolume() { if (R.audio) R.audio.gain.gain.value = (state.config.settings.vol / 100) ** 2; }
function pushAudio() {
  const a = R.audio; if (!a) return;
  const s = Core.audio(); if (!s) return;
  if (R.level > a.ctx.sampleRate * 0.14) return; // drop instead of building up latency
  const N = state.turbo ? state.config.settings.turboSpeed : 1;
  let out;
  if (N === 1) {
    out = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s[i] / 32768;
  } else if (state.config.settings.turboAudio === 'fast') {
    // Turbo with sound: average every N samples into one (a box low-pass + decimate), so the
    // game plays N times faster and higher-pitched, like a sped-up tape, with no harsh aliasing.
    const buf = new Float32Array((Math.ceil(s.length / 2 / N) + 1) * 2), d = R.dec; let o = 0;
    for (let i = 0; i < s.length; i += 2) {
      d.l += s[i]; d.r += s[i + 1];
      if (++d.n >= N) { buf[o++] = d.l / (d.n * 32768); buf[o++] = d.r / (d.n * 32768); d.n = d.l = d.r = 0; }
    }
    if (!o) return;
    out = buf.slice(0, o);
  } else return;
  a.node.port.postMessage(out, [out.buffer]);
}

/* ------------------------------------------------------------------ video + loop */
function draw() { R.ctx.putImageData(new ImageData(Core.video(), W, H), 0, 0); R.dirty = false; }
function glowSample(now) {
  if (!state.config.settings.glow || now - R.glowAt < 200) return;
  R.glowAt = now;
  gctx.drawImage(R.canvas, 0, 0, 4, 3);
  const d = gctx.getImageData(0, 0, 4, 3).data; let r = 0, g = 0, b = 0;
  for (let i = 0; i < 48; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const t = [r / 12, g / 12, b / 12], gc = R.gc || (R.gc = t.slice());
  for (let i = 0; i < 3; i++) gc[i] += (t[i] - gc[i]) * 0.3; // smooth in JS instead of animating in CSS
  document.documentElement.style.setProperty('--glow', `rgb(${gc[0] | 0} ${gc[1] | 0} ${gc[2] | 0})`);
}
const PAD_GAME = ['A', 'B', 'L', 'R', 'START', 'SELECT', 'UP', 'DOWN', 'LEFT', 'RIGHT'];
function padFamily(id = '') {
  if (/054c|dualshock|dualsense|playstation|wireless controller/i.test(id)) return 'ps';
  if (/057e|nintendo|switch|joy-con/i.test(id)) return 'nintendo';
  if (/xbox|045e|xinput/i.test(id)) return 'xbox';
  return 'generic';
}
function readPads() {
  const down = new Set(); let x = 0, y = 0, id = null;
  for (const p of (navigator.getGamepads ? navigator.getGamepads() : [])) {
    if (!p || !p.connected) continue;
    id = id || p.id;
    p.buttons.forEach((b, i) => { if (b.pressed) down.add(i); });
    if (Math.abs(p.axes[0] || 0) > Math.abs(x)) x = p.axes[0];
    if (Math.abs(p.axes[1] || 0) > Math.abs(y)) y = p.axes[1];
  }
  return { down, x, y, id };
}
function setInput(k) { if (state.input !== k) set({ input: k }); }
function setPadInfo(id) {
  const cur = state.pad;
  if (!!id !== cur.connected || (id && cur.name !== id)) set({ pad: { connected: !!id, family: id ? padFamily(id) : 'generic', name: id || '' } });
}
function applyTurbo() {
  const on = R.turboSticky || R.turboKbd || R.turboPad;
  if (on !== state.turbo && state.running) { R.dec = { n: 0, l: 0, r: 0 }; set({ turbo: on }); }
}
const curSlot = () => state.config.settings.slot || 1;
function nextSlot() { const n = (curSlot() % 4) + 1; updateConfig((c) => { c.settings.slot = n; }); toast('Slot ' + n + ' selected'); }

/* One place that turns pad + keyboard + touch into (a) game input, or (b) menu navigation when a layer is open. */
function handlePads(now) {
  const pad = readPads(), cfg = state.config.pad, prev = R.padPrev, down = pad.down;
  setPadInfo(pad.id);
  const edge = (i) => i >= 0 && down.has(i) && !prev.has(i), held = (i) => i >= 0 && down.has(i);
  const fresh = [...down].find((b) => !prev.has(b));
  R.padPrev = down;
  if (fresh !== undefined) { setInput('pad'); dispatchEvent(new Event('webgba-activity')); }
  if (R.listen) {                                   // rebinding: the next button pressed wins
    if (fresh !== undefined) { bindPad(R.listen, fresh); cancelListenPad(); }
    R.input = 0; return;
  }
  const sx = pad.x < -0.5 ? -1 : pad.x > 0.5 ? 1 : 0, sy = pad.y < -0.5 ? -1 : pad.y > 0.5 ? 1 : 0;
  let bits = 0;
  for (const a of PAD_GAME) if (held(cfg[a])) bits |= BTN[a];
  if (sx < 0) bits |= BTN.LEFT; if (sx > 0) bits |= BTN.RIGHT; if (sy < 0) bits |= BTN.UP; if (sy > 0) bits |= BTN.DOWN;
  const raw = bits | R.kbd | R.touch;
  if ((raw & BTN.START) && (raw & BTN.SELECT) && !R.combo) { R.combo = true; R.menuCb && R.menuCb(); }   // Select + Start = game list
  if (!(raw & (BTN.START | BTN.SELECT))) R.combo = false;
  const nav = R.nav;
  if (nav.active) {
    R.input = 0;
    const dirs = { up: held(cfg.UP) || sy < 0, down: held(cfg.DOWN) || sy > 0, left: held(cfg.LEFT) || sx < 0, right: held(cfg.RIGHT) || sx > 0 };
    for (const [d, on] of Object.entries(dirs)) {
      const r = R.rep[d] || (R.rep[d] = { on: false, next: 0 });
      if (on && !r.on) { r.on = true; r.next = now + 380; nav.handler && nav.handler(d); }
      else if (on && now >= r.next) { r.next = now + 110; nav.handler && nav.handler(d); }
      else if (!on) r.on = false;
    }
    if (edge(cfg.A)) nav.handler && nav.handler('confirm');
    if (edge(cfg.B)) nav.handler && nav.handler('back');
    if (edge(cfg.L)) nav.handler && nav.handler('l');
    if (edge(cfg.R)) nav.handler && nav.handler('r');
    R.turboPad = false; applyTurbo();
    return;
  }
  R.input = raw & ~(R.combo ? BTN.START | BTN.SELECT : 0);
  R.turboPad = held(cfg.TURBO); applyTurbo();
  if (state.running) {
    if (edge(cfg.SAVE)) saveState(curSlot());
    if (edge(cfg.LOAD)) loadState(curSlot());
    if (edge(cfg.SLOT)) nextSlot();
    if (edge(cfg.PAUSE)) togglePause();
  }
}
function bindPad(action, i) {
  updateConfig((c) => { const o = Object.keys(c.pad).find((a) => a !== action && c.pad[a] === i); if (o) c.pad[o] = c.pad[action]; c.pad[action] = i; });
}
const resetPad = () => updateConfig((c) => { c.pad = { ...DEFAULT_PAD }; });
function listenPad(a) { R.listen = a; set({ padListening: a }); clearTimeout(R.listenT); R.listenT = setTimeout(cancelListenPad, 10000); }
function cancelListenPad() { clearTimeout(R.listenT); if (R.listen) { R.listen = null; set({ padListening: null }); } }

function stepFrame() { Core.frame(R.input); pushAudio(); R.frames++; R.dirty = true; }
function tick(now) {
  requestAnimationFrame(tick);
  handlePads(now);
  if (!state.running || !R.canvas) { R.last = now; return; }
  if (state.paused) { R.last = now; return; }
  R.acc += Math.min(now - R.last, 100); R.last = now;
  const step = FRAME_MS / (state.turbo ? state.config.settings.turboSpeed : 1);
  let n = 0;
  while (R.acc >= step && n < 24) { R.acc -= step; stepFrame(); n++; }
  if (R.acc > step * 24) R.acc = 0;
  if (R.dirty) { draw(); glowSample(now); }
  if (now - R.fpsAt >= 1000) { set({ fps: Math.round(R.frames * 1000 / (now - R.fpsAt)) }); R.frames = 0; R.fpsAt = now; }
}
requestAnimationFrame(tick);

/* ------------------------------------------------------------------------ input */
const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
addEventListener('keydown', (e) => {
  if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  setInput('kbd');
  const a = R.codes[e.code], playing = state.running && !R.nav.active;
  if (a) {
    if (BTN[a]) { R.kbd |= BTN[a]; e.preventDefault(); }
    else if (a === 'TURBO') { e.preventDefault(); R.turboKbd = true; applyTurbo(); }
    else {
      e.preventDefault();
      if (e.repeat || !playing) return;
      if (a === 'PAUSE') togglePause(); else if (a === 'SAVE') saveState(curSlot()); else if (a === 'LOAD') loadState(curSlot()); else if (a === 'SLOT') nextSlot();
    }
    return;
  }
  const m = /^Digit([1-4])$/.exec(e.code);
  if (m && playing && !e.repeat) e.shiftKey ? saveState(+m[1]) : loadState(+m[1]);
});
addEventListener('keyup', (e) => {
  const a = R.codes[e.code];
  if (BTN[a]) { R.kbd &= ~BTN[a]; e.preventDefault(); }
  if (a === 'TURBO') { R.turboKbd = false; applyTurbo(); }
});
addEventListener('blur', () => { R.kbd = 0; R.touch = 0; R.turboKbd = false; applyTurbo(); });
addEventListener('pointerdown', () => setInput('mouse'), { passive: true });
addEventListener('gamepadconnected', (e) => setPadInfo(e.gamepad.id));
addEventListener('gamepaddisconnected', () => setPadInfo(null));
const touchSet = (bit, on) => { R.touch = on ? R.touch | bit : R.touch & ~bit; };

/* --------------------------------------------------------------------- zip I/O */
const ZIP_LIMIT = 64 * 1024 * 1024; // Individual entry cap
const ZIP_TOTAL_LIMIT = 512 * 1024 * 1024;
const ZIP_CD_LIMIT = 4 * 1024 * 1024;
const ZIP_ENTRY_LIMIT = 1024;
const ROM_MAX = 32 * 1024 * 1024;
const SAVE_MAX = 128 * 1024;
async function inflateRaw(b) {
  const rd = new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    n += value.length; if (n > ZIP_LIMIT) { rd.cancel(); throw new Error('a file inside the zip is too large'); }
    parts.push(value);
  }
  const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const deflateRaw = async (b) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crcUp = (c, b) => { for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return c; };
const crc32 = (b) => (crcUp(0xFFFFFFFF, b) ^ 0xFFFFFFFF) >>> 0;
async function crcBlob(blob) {
  let c = 0xFFFFFFFF; const rd = blob.stream().getReader();
  for (;;) { const { done, value } = await rd.read(); if (done) break; c = crcUp(c, value); }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
/* Reads straight from the File with slice(), so even a multi-GB backup never sits in memory. */
async function zipEntries(file) {
  if (file.size < 22) throw new Error('ZIP is too short');
  const tl = Math.min(file.size, 65557), tail = new DataView(await file.slice(file.size - tl).arrayBuffer());
  let e = tl - 22;
  while (e >= 0 && tail.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0 || e + 22 + tail.getUint16(e + 20, true) !== tl) throw new Error('invalid ZIP end record');
  const count = tail.getUint16(e + 10, true), cdSize = tail.getUint32(e + 12, true), cdOff = tail.getUint32(e + 16, true);
  if (tail.getUint16(e + 4, true) || tail.getUint16(e + 6, true) || tail.getUint16(e + 8, true) !== count)
    throw new Error('multi-volume ZIP is unsupported');
  if (count > ZIP_ENTRY_LIMIT || cdSize > ZIP_CD_LIMIT || count === 0xffff || cdOff === 0xffffffff)
    throw new Error('ZIP exceeds supported limits');
  if (cdOff + cdSize > file.size - tl + e) throw new Error('invalid ZIP directory offset');
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer()), dec = new TextDecoder(), out = [];
  let p = 0, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt ZIP directory');
    const flags = cd.getUint16(p + 8, true), method = cd.getUint16(p + 10, true);
    const nl = cd.getUint16(p + 28, true), el = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
    const csize = cd.getUint32(p + 20, true), usize = cd.getUint32(p + 24, true), lho = cd.getUint32(p + 42, true);
    if (p + 46 + nl + el + cl > cd.byteLength || (flags & 1) || (method !== 0 && method !== 8) ||
        csize > ZIP_LIMIT || usize > ZIP_LIMIT || lho === 0xffffffff || lho + 30 > cdOff)
      throw new Error('unsupported or oversized ZIP entry');
    total += usize;
    if (total > ZIP_TOTAL_LIMIT) throw new Error('ZIP total expanded size exceeds limit');
    const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nl));
    if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || !name)
      throw new Error('unsafe ZIP path');
    out.push({ method, flags, csize, usize, lho, crc: cd.getUint32(p + 16, true), name });
    p += 46 + nl + el + cl;
  }
  if (p !== cd.byteLength) throw new Error('ZIP directory contains unexpected data');
  return out;
}
async function zipRead(file, e) {
  if (e.csize > ZIP_LIMIT || e.usize > ZIP_LIMIT) throw new Error('ZIP entry exceeds limit');
  const lh = new DataView(await file.slice(e.lho, e.lho + 30).arrayBuffer());
  if (lh.byteLength !== 30 || lh.getUint32(0, true) !== 0x04034b50 ||
      lh.getUint16(8, true) !== e.method || lh.getUint16(6, true) !== e.flags)
    throw new Error('invalid ZIP local header');
  const start = e.lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  if (start + e.csize > file.size) throw new Error('truncated ZIP entry');
  const raw = new Uint8Array(await file.slice(start, start + e.csize).arrayBuffer());
  let bytes;
  if (e.method === 0) bytes = raw;
  else {
    if (typeof DecompressionStream === 'undefined') throw new Error('ZIP decompression unavailable; open a .gba file directly');
    bytes = await inflateRaw(raw);
  }
  if (bytes.length !== e.usize || crc32(bytes) !== e.crc)
    throw new Error('ZIP entry failed size/CRC validation');
  return bytes;
}

class ZipWriter {
  constructor() { this.parts = []; this.cd = []; this.off = 0; }
  async add(name, data, { compress = true } = {}) {
    const nameB = new TextEncoder().encode(name); let crc, usize, body = data, method = 0;
    if (data instanceof Blob) { usize = data.size; crc = await crcBlob(data); }
    else {
      usize = data.length; crc = crc32(data);
      if (compress && usize > 64) { const c = await deflateRaw(data); if (c.length < usize) { body = c; method = 8; } }
    }
    const csize = body instanceof Blob ? body.size : body.length;
    if (this.off + csize > 0xFFFFFF00) throw new Error('over the 4 GB zip limit; export without game files');
    const now = new Date(), time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
      date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, method, true);
    h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true); h.setUint32(18, csize, true);
    h.setUint32(22, usize, true); h.setUint16(26, nameB.length, true);
    this.parts.push(h.buffer, nameB, body);
    this.cd.push({ nameB, method, time, date, crc, csize, usize, off: this.off });
    this.off += 30 + nameB.length + csize;
  }
  addText(name, text) { return this.add(name, new TextEncoder().encode(text)); }
  finish() {
    const cdp = []; let size = 0;
    for (const e of this.cd) {
      const h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, 0x02014b50, true); h.setUint16(4, 20, true); h.setUint16(6, 20, true); h.setUint16(8, 0x0800, true);
      h.setUint16(10, e.method, true); h.setUint16(12, e.time, true); h.setUint16(14, e.date, true); h.setUint32(16, e.crc, true);
      h.setUint32(20, e.csize, true); h.setUint32(24, e.usize, true); h.setUint16(28, e.nameB.length, true); h.setUint32(42, e.off, true);
      cdp.push(h.buffer, e.nameB); size += 46 + e.nameB.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, this.cd.length, true); end.setUint16(10, this.cd.length, true);
    end.setUint32(12, size, true); end.setUint32(16, this.off, true);
    return new Blob([...this.parts, ...cdp, end.buffer], { type: 'application/zip' });
  }
}
function download(name, data, type = 'application/octet-stream') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

/* ------------------------------------------------------------------ ROM loading */
function legacyRomId(rom) {
  const txt = (a, b) => String.fromCharCode(...rom.subarray(a, b)).replace(/[^A-Za-z0-9]/g, '');
  const code = txt(0xAC, 0xB0), title = txt(0xA0, 0xAC);
  if (code.length === 4) return `${code}_${title}`.slice(0, 40);
  let h = 2166136261; for (let i = 0; i < rom.length; i += 17) h = Math.imul(h ^ rom[i], 16777619);
  return 'rom_' + (h >>> 0).toString(16);
}
async function romId(rom) {
  const digest = await crypto.subtle.digest('SHA-256', rom);
  return 'sha256_' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function openFile(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    let bytes, name = file.name;
    if (/\.zip$/i.test(name) || (head[0] === 0x50 && head[1] === 0x4B)) {
      const e = (await zipEntries(file)).find((x) => ROM_RE.test(x.name));
      if (!e) throw new Error('no .gba file inside the zip');
      if (e.usize < 0xC0 || e.usize > ROM_MAX) throw new Error('ROM inside ZIP exceeds supported size');
      bytes = await zipRead(file, e); name = e.name.split('/').pop();
    } else { if (file.size < 0xC0 || file.size > ROM_MAX) throw new Error('ROM exceeds supported size'); bytes = new Uint8Array(await file.arrayBuffer()); }
    if (await startRom(bytes, name)) await saveToLibrary(name, bytes);   // "open 1 game and save it"
  } catch (err) { toast('Could not open: ' + err.message); }
}
async function saveToLibrary(name, bytes) {
  try {
    if (state.library.some((g) => g.name === name && g.size === bytes.length)) return;
    await Library.add(name, bytes); await refreshLibrary(); toast('Saved to your games');
  } catch (e) { toast('Opened, but could not save it to your games: ' + e.message); }
}
async function openLibrary(name) {
  try { await startRom(await Library.get(name), name); } catch (e) { toast('Could not load: ' + e.message); }
}
async function startRom(rom, name, opts = {}) {
  if (!Core.m) { toast('Emulator core is still loading, try again in a moment'); return false; }
  if (rom.length < 0xC0 || rom.length > ROM_MAX) { toast('That does not look like a GBA ROM'); return false; }
  if (!opts.skipOutgoingSave && await saveSaveNow() === false) throw new Error('Previous game could not be saved; game switch cancelled');
  if (opts.skipOutgoingSave) await saveWrites.catch(() => {});
  await ensureAudio();
  const id = await romId(rom), legacyId = legacyRomId(rom); let save = opts.saveOverride || null, bios = null;
  if (!save) {
    try { save = await store.get('save', id) || await store.get('save', legacyId); } catch (e) { console.warn(e); }
  }
  try { const b = await idbGet('bios:gba'); bios = b ? new Uint8Array(b) : null; } catch (e) { /* optional */ }
  let loaded = false;
  try { loaded = Core.load(rom, save, bios); }
  catch (e) { console.error('mGBA load failed', e); }
  if (!loaded) {
    set({ running: false, paused: false, id: '', title: '', romName: '' });
    toast('mGBA could not load this ROM'); return false;
  }
  Object.assign(R, { lastRom: { bytes: rom, name }, legacyId, lastSave: save, acc: 0, frames: 0,
    fpsAt: performance.now(), dec: { n: 0, l: 0, r: 0 }, overlayPaused: false, autoPaused: false });
  const title = String.fromCharCode(...rom.subarray(0xA0, 0xAC)).replace(/\0/g, '').trim() || name.replace(/\.[^.]+$/, '');
  R.turboSticky = false; R.turboKbd = false;
  set({ running: true, paused: false, turbo: false, id, romName: name, title });
  document.title = title + ' | WebGBA';
  const cheats = state.config.cheats[id] || state.config.cheats[legacyId] || '';
  if (cheats.trim()) applyCheats(cheats, true);
  clearTimeout(R.coverT); R.coverT = setTimeout(captureCover, 8000);
  return true;
}
async function refreshLibrary() {
  try { set({ library: (await Library.list()).sort((a, b) => a.name.localeCompare(b.name)) }); } catch (e) { set({ library: [] }); }
}
const ROMISH = /\.(gba|agb|bin|mb|zip)$/i;
async function walkDir(dir, out, depth = 0) {
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'directory') { if (depth < 6) await walkDir(h, out, depth + 1); }
    else if (ROMISH.test(name)) out.push({ name, get: () => h.getFile() });
  }
}
function pickFolderFallback() {   // Firefox/Safari: no folder handles, so read the chosen folder once
  return new Promise((resolve) => {
    const i = document.createElement('input'); i.type = 'file'; i.webkitdirectory = true; i.multiple = true;
    i.onchange = () => resolve([...i.files].filter((f) => ROMISH.test(f.name)).map((f) => ({ name: f.name, get: async () => f })));
    i.oncancel = () => resolve(null);
    i.click();
  });
}
async function scanFolder() {
  try {
    let files;
    if (window.showDirectoryPicker) {
      const dir = await showDirectoryPicker({ id: 'webgba-games', mode: 'read' });
      set({ busy: 'Looking for games...' }); files = []; await walkDir(dir, files);
    } else files = await pickFolderFallback();
    if (files === null) return;
    if (!files.length) { toast('No GBA games found in that folder'); return; }
    await importFiles(files);
  } catch (e) {
    if (e.name === 'SecurityError') toast('Browsers need a real mouse click to pick a folder');
    else if (e.name !== 'AbortError') toast('Scan failed: ' + e.message);
  } finally { set({ busy: null }); }
}
async function importFiles(files) {
  const have = new Map(state.library.map((g) => [g.name, g.size]));
  let added = 0, skipped = 0, i = 0;
  for (const f of files) {
    set({ busy: `Adding games... ${++i}/${files.length}` });
    try {
      const file = await f.get(); let bytes, name = f.name.split('/').pop();
      if (/\.zip$/i.test(name)) {
        const e = (await zipEntries(file)).find((x) => ROM_RE.test(x.name) && !x.name.endsWith('/'));
        if (!e) { skipped++; continue; }
        if (e.usize < 0xC0 || e.usize > ROM_MAX) { skipped++; continue; }
        bytes = await zipRead(file, e); name = e.name.split('/').pop();
      } else {
        if (file.size < 0xC0 || file.size > 32 * 1024 * 1024) { skipped++; continue; }
        bytes = new Uint8Array(await file.arrayBuffer());
      }
      if (/\.bin$/i.test(name) && bytes[0xB2] !== 0x96) { skipped++; continue; }   // .bin is ambiguous: require the GBA header marker
      if (have.get(name) === bytes.length) continue;                              // already in your games
      await Library.add(name, bytes); have.set(name, bytes.length); added++;
    } catch (e) { skipped++; }
  }
  await refreshLibrary(); set({ busy: null });
  toast(added ? `Added ${added} game${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}` : skipped ? `Nothing new (${skipped} skipped)` : 'Already up to date');
}
async function removeGame(name) {
  try {
    await Library.remove(name); await refreshLibrary();
    updateConfig((c) => { delete c.covers[name]; });
    toast('Removed ' + name.replace(/\.[^.]+$/, ''));
  } catch (e) { toast('Could not remove: ' + e.message); }
}
function captureCover() {   // the tile art is a screenshot of your own game
  if (!state.running || !R.canvas) return;
  const c = document.createElement('canvas'); c.width = 168; c.height = 112;
  c.getContext('2d').drawImage(R.canvas, 0, 0, 168, 112);
  const url = c.toDataURL('image/jpeg', 0.72), name = state.romName;
  updateConfig((cf) => { cf.covers[name] = url; });
}

/* ----------------------------------------------------------------- saves, states */
const isBlank = (d) => { for (let i = 0; i < d.length; i++) if (d[i] !== 0xFF) return false; return true; };
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
let saveWrites = Promise.resolve();
function writeSave(id, bytes) {
  const write = saveWrites.catch(() => {}).then(() => store.put('save', id, bytes));
  saveWrites = write;
  return write;
}
async function saveSaveNow() {
  if (!state.running || !state.id || R.importing) return true;
  const d = Core.saveData(), id = state.id;
  if (!d || isBlank(d) || same(d, R.lastSave)) return true;
  try {
    await writeSave(id, d);
    if (state.id === id) R.lastSave = d;
    return true;
  } catch (e) { toast('Could not write save: ' + e.message); return false; }
}
setInterval(saveSaveNow, 2000);
addEventListener('pagehide', saveSaveNow);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    R.touch = 0; R.kbd = 0; R.turboKbd = false; applyTurbo();
    saveSaveNow();
    if (state.config.settings.pauseHidden && state.running && !state.paused) { set({ paused: true }); R.autoPaused = true; }
  } else if (R.autoPaused) { set({ paused: false }); R.autoPaused = false; }
});
async function saveState(n) {
  if (!state.running) return;
  const st = Core.stateSave();
  if (!st) { toast('Save state failed'); return; }
  try {
    await store.put('state', `${state.id}/${n}`, st);
    const c = document.createElement('canvas'); c.width = 120; c.height = 80;
    c.getContext('2d').drawImage(R.canvas, 0, 0, 120, 80);
    const thumb = c.toDataURL('image/jpeg', 0.7), id = state.id;
    updateConfig((cf) => { (cf.meta[id] = cf.meta[id] || {})[n] = { t: Date.now(), thumb }; cf.settings.slot = n; });
    set({ flash: Date.now() }); toast(`Saved to slot ${n}`);
  } catch (e) { toast('Could not store state: ' + e.message); }
}
async function loadState(n) {
  if (!state.running) return;
  try {
    const st = await store.get('state', `${state.id}/${n}`) || (R.legacyId && await store.get('state', `${R.legacyId}/${n}`));
    if (!st) { toast(`Slot ${n} is empty`); return; }
    if (Core.stateLoad(st)) { updateConfig((c) => { c.settings.slot = n; }); toast(`Loaded slot ${n}`); stepFrame(); draw(); set({ flash: Date.now() }); } else toast('State does not match this game');
  } catch (e) { toast('Could not read state: ' + e.message); }
}
function applyCheats(text, silent) {
  const id = state.id;
  Core.cheatClear(); let ok = 0, bad = 0;
  for (const raw of text.split('\n')) {
    const hex = raw.replace(/[\s-]/g, '').toUpperCase();
    if (!hex || hex.startsWith('#')) continue;
    Core.cheatAdd(/^[0-9A-F]{16}$/.test(hex) ? hex.slice(0, 8) + ' ' + hex.slice(8) : raw.trim()) ? ok++ : bad++;
  }
  if (!silent) { updateConfig((c) => { c.cheats[id] = text; }); toast(`Cheats: ${ok} applied${bad ? `, ${bad} rejected` : ''}`); }
  return { ok, bad };
}
const exportSav = () => { const d = Core.saveData(); d ? download((state.title || 'game') + '.sav', d) : toast('No save data yet'); };
async function importSav(file) {
  if (!state.running || R.importing) return;
  if (!file.size || file.size > SAVE_MAX) { toast('Invalid save size (max 128 KB)'); return; }
  const wasPaused = state.paused;
  set({ paused: true }); R.importing = true;
  try {
    const b = new Uint8Array(await file.arrayBuffer());
    // Keep a retrievable copy of the previous in-game save before replacing it.
    const prior = Core.saveData();
    const hasPrevious = !!prior && !isBlank(prior);
    if (hasPrevious) download((state.title || 'game') + '-before-import.sav', prior);
    await writeSave(state.id, b);
    if (!await startRom(R.lastRom.bytes, R.lastRom.name, { skipOutgoingSave: true, saveOverride: b }))
      throw new Error('emulator rejected imported save');
    toast(hasPrevious ? 'Save imported; backup download requested' : 'Save imported');
  } catch (e) { toast('Import failed: ' + e.message); }
  finally { R.importing = false; if (wasPaused && state.running) set({ paused: true }); }
}

/* ---------------------------------------------------------------------- controls */
function togglePause() { if (state.running) { set({ paused: !state.paused }); R.autoPaused = false; } }
function setTurbo(on) { R.turboSticky = !!on; applyTurbo(); }
function setOverlay(on) {
  if (on && state.running) captureCover();
  if (on && state.running && !state.paused) { set({ paused: true }); R.overlayPaused = true; }
  else if (!on && R.overlayPaused) { set({ paused: false }); R.overlayPaused = false; }
}
const screenshot = () => R.canvas.toBlob((b) => b && download(`${state.title || 'screenshot'}-${Date.now()}.png`, b));
const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());
async function setBios(file) {
  if (file.size !== 16384) { toast('A GBA BIOS is exactly 16 KB'); return; }
  const b = new Uint8Array(await file.arrayBuffer());
  if (b.length !== 16384) { toast('A GBA BIOS is exactly 16 KB'); return; }
  await idbPut('bios:gba', b); set({ bios: true }); toast('BIOS saved. Used the next time you load a game');
}
async function clearBios() { await idbPut('bios:gba', null); set({ bios: false }); toast('BIOS cleared'); }

/* ----------------------------------------------------------------------- backup */
async function exportBackup({ roms = false } = {}) {
  set({ busy: 'Collecting files...' });
  try {
    const z = new ZipWriter(), { saves, states } = await store.list();
    const games = state.library;
    const total = saves.length + states.length + (roms ? games.length : 0); let i = 0;
    const tick1 = () => set({ busy: `Packing ${++i}/${total}` });
    await z.addText('settings.json', JSON.stringify(state.config, null, 1));
    for (const id of saves) { const b = await store.get('save', id); if (b) await z.add(`saves/${id}.sav`, b); tick1(); }
    for (const { id, slot } of states) { const b = await store.get('state', `${id}/${slot}`); if (b) await z.add(`states/${id}/${slot}.state`, b); tick1(); }
    if (roms) for (const g of games) {
      try { await z.add('roms/' + g.name, new Blob([await Library.get(g.name)]), { compress: false }); } catch (e) { console.warn(e); }
      tick1();
    }
    await z.addText('manifest.json', JSON.stringify({ app: 'webgba', version: 1, created: new Date().toISOString(), games, includesRoms: roms }, null, 1));
    const blob = z.finish();
    download(`webgba-backup-${new Date().toISOString().slice(0, 10)}.zip`, blob);
    toast(`Backup ready: ${saves.length} saves, ${states.length} states${roms ? `, ${games.length} games` : ''}`);
    return blob;
  } catch (e) { toast('Backup failed: ' + e.message); } finally { set({ busy: null }); }
}
async function importBackup(file) {
  set({ busy: 'Reading backup...' });
  const n = { saves: 0, states: 0, roms: 0, skipped: 0 };
  try {
    const ents = await zipEntries(file); let cfg = null, i = 0;
    // Validate every archive member before mutating any save, state, or ROM record.
    for (const e of ents) {
      if (e.name.endsWith('/')) continue;
      set({ busy: `Checking backup... ${++i}/${ents.length}` });
      await zipRead(file, e);
    }
    const settingsEntry = ents.find((e) => e.name === 'settings.json');
    if (settingsEntry) cfg = mergeConfig(JSON.parse(new TextDecoder().decode(await zipRead(file, settingsEntry))));
    i = 0;
    for (const e of ents) {
      set({ busy: `Restoring ${++i}/${ents.length}` });
      if (e.name.startsWith('saves/') && e.usize > SAVE_MAX) throw new Error('Save in backup exceeds 128 KB');
      if (e.name.startsWith('roms/') && e.usize > ROM_MAX) throw new Error('Game in backup exceeds 32 MB');
      if (e.name.endsWith('/') || e.name.includes('..') || e.name.startsWith('/')) continue;
      let m;
      if (e.name === 'settings.json') continue;
      else if ((m = /^saves\/([A-Za-z0-9_.-]{1,96})\.sav$/.exec(e.name))) { await store.put('save', m[1], await zipRead(file, e)); n.saves++; }
      else if ((m = /^states\/([A-Za-z0-9_.-]{1,96})\/([A-Za-z0-9_.-]{1,16})\.state$/.exec(e.name))) { await store.put('state', `${m[1]}/${m[2]}`, await zipRead(file, e)); n.states++; }
      else if ((m = /^roms\/([^/\\]+)$/.exec(e.name))) {
        if (ROM_RE.test(m[1])) { try { await Library.add(m[1], await zipRead(file, e)); n.roms++; } catch (err) { n.skipped++; } } else n.skipped++;
      }
    }
    if (cfg) commitConfig(cfg);
    await refreshLibrary();
    toast(`Restored ${n.saves} saves, ${n.states} states, ${n.roms} games${n.skipped ? ` (${n.skipped} games skipped)` : ''}`);
  } catch (e) { toast('Restore failed: ' + e.message); } finally { set({ busy: null }); }
}

/* -------------------------------------------------------------- drag and drop */
addEventListener('dragenter', (e) => { e.preventDefault(); R.drag++; set({ dragging: true }); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('dragleave', () => { if (--R.drag <= 0) { R.drag = 0; set({ dragging: false }); } });
addEventListener('drop', (e) => { e.preventDefault(); R.drag = 0; set({ dragging: false }); const f = e.dataTransfer.files[0]; if (f) openFile(f); });

/* ------------------------------------------------------------------------- boot */
(async () => {
  try { store.server = (await fetch('/api/ping')).ok; } catch (e) { store.server = false; }
  set({ serverMode: store.server });
  commitConfig(mergeConfig(await store.getConfig().catch(() => null)), false);
  await refreshLibrary();
  try { await Core.init(); } catch (e) { toast('Failed to start the emulator core: ' + e.message); console.error(e); return; }
  try { set({ bios: !!(await idbGet('bios:gba')) }); } catch (e) { /* ignore */ }
  set({ ready: true });
})();

window.GBA = {
  subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
  getState: () => state,
  BTN, DEFAULT_KEYS, DEFAULT_PAD,
  attachCanvas(c) { R.canvas = c; R.ctx = c.getContext('2d', { alpha: false }); },
  openFile, openLibrary, refreshLibrary, scanFolder, removeGame, togglePause, setTurbo, setOverlay,
  reset: async () => { if (state.running) { if (await saveSaveNow() === false) return; Core.reset(); toast('Reset'); } },
  screenshot, fullscreen, saveState, loadState, nextSlot, applyCheats, exportSav, importSav,
  updateConfig, bindKey, resetKeys, bindPad, resetPad, listenPad, cancelListenPad,
  setNav: (active, handler) => { R.nav = { active, handler }; },   // the UI tells the engine when a menu layer is open
  setMenu: (fn) => { R.menuCb = fn; },                              // called on Select + Start
  setBios, clearBios, exportBackup, importBackup, touchSet, unlockAudio,
  _debug: () => ({ level: R.level, turbo: state.turbo, frames: R.frames, nav: R.nav.active }),
  _import: importFiles,
};
})();
