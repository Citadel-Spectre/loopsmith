/* Loopsmith renderer: frame editor UI. */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
// `api` is the bridge exposed by preload.js

let uid = 0;
const S = {
  fwd: [],           // forward pass [{id, path, delay}]
  back: [],          // backward pass, played after fwd when yoyo is on
  yoyo: false,
  skipEnds: true,    // yoyo: don't repeat the first / last frame at the turnarounds
  track: 'fwd',      // the strip being edited / played: 'fwd' | 'back'
  curT: { fwd: 0, back: 0 }, // current frame index on each strip
  sel: new Set(),    // selected frame ids
  anchor: 0,         // index for shift-click range selection
  w: 0, h: 0,        // frame size
  scale: 1,
  undo: [], redo: [],
  playing: false,
  panel: null,       // name of the open tool panel
  busy: false,
};

// S.frames / S.cur are the active strip's frame list and current index.
Object.defineProperty(S, 'frames', {
  get() { return this.track === 'back' ? this.back : this.fwd; },
  set(v) { if (this.track === 'back') this.back = v; else this.fwd = v; },
});
Object.defineProperty(S, 'cur', { get() { return this.curT[this.track]; }, set(v) { this.curT[this.track] = v; } });
const listOf = (t) => (t === 'back' ? S.back : S.fwd);
const other = (t) => (t === 'back' ? 'fwd' : 'back');
/** Frames in the order they play (forward, then backward when yoyo is on). */
const played = () => (S.yoyo ? S.fwd.concat(S.back) : S.fwd);
/** Every frame on both strips (pixel-size changes must hit them all). */
const everything = () => S.fwd.concat(S.back);
/** Frames that play and get exported: hidden (skipped) frames are left out. */
const shown = () => played().filter((f) => !f.skip);
const totalMs = () => shown().reduce((a, f) => a + f.delay, 0);

const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');

// ---------- utils ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (ms) => (ms / 1000).toFixed(2) + 's';
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(2) + ' MB' : (b / 1024).toFixed(0) + ' KB');
const newFrame = (path, delay) => ({ id: ++uid, path, delay: Math.max(10, Math.round(delay)) });

function fileUrl(p) {
  let u = p.replace(/\\/g, '/');
  if (!u.startsWith('/')) u = '/' + u;
  return 'file://' + encodeURI(u).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

const imgCache = new Map();
function loadImg(p) {
  if (!imgCache.has(p)) {
    imgCache.set(p, new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Could not load ' + p));
      i.src = fileUrl(p);
    }));
    if (imgCache.size > 400) imgCache.delete(imgCache.keys().next().value);
  }
  return imgCache.get(p);
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async (_, w) => {
    while (i < items.length) { const k = i++; await fn(items[k], k, w); }
  });
  await Promise.all(workers);
}

function toast(msg) { $('#statusText').textContent = msg; setTimeout(updateStatus, 4000); }

function showProgress(label, v) {
  const w = $('#progressWrap');
  if (!label || v >= 1) { w.classList.remove('on'); return; }
  w.classList.add('on');
  $('#progressLabel').textContent = label;
  $('#progress').value = v;
}
api.onProgress((p) => showProgress(p.label, p.value));

async function busy(label, fn) {
  if (S.busy) return;
  S.busy = true; document.body.style.cursor = 'progress'; showProgress(label, 0.001);
  try { return await fn(); }
  catch (e) { console.error(e); alert(label + ' failed:\n\n' + e.message); }
  finally { S.busy = false; document.body.style.cursor = ''; showProgress('', 1); }
}

// ---------- history ----------
const snapshot = () => ({ fwd: S.fwd.map((f) => ({ ...f })), back: S.back.map((f) => ({ ...f })), yoyo: S.yoyo, skipEnds: S.skipEnds, track: S.track,
  curT: { ...S.curT }, w: S.w, h: S.h, sel: [...S.sel] });
function commit() { S.undo.push(snapshot()); if (S.undo.length > 100) S.undo.shift(); S.redo = []; }
function restore(s) { Object.assign(S, { fwd: s.fwd, back: s.back, yoyo: s.yoyo, skipEnds: s.skipEnds, track: s.track, curT: s.curT, w: s.w, h: s.h, sel: new Set(s.sel) }); refresh(); }
function undo() { if (!S.undo.length || S.busy) return; S.redo.push(snapshot()); restore(S.undo.pop()); }
function redo() { if (!S.redo.length || S.busy) return; S.undo.push(snapshot()); restore(S.redo.pop()); }

// ---------- selection ----------
function selIdx() {
  const idx = S.frames.map((f, i) => (S.sel.has(f.id) ? i : -1)).filter((i) => i >= 0);
  return idx.length ? idx : (S.frames.length ? [S.cur] : []);
}
const allIdx = () => S.frames.map((_, i) => i);
/** 'all' = every frame that plays (both strips in yoyo), otherwise the selection on the active strip. */
function scopeFrames(scope) { return scope === 'all' ? played() : selIdx().map((i) => S.frames[i]); }
/** Replace frames (matched by id) on both strips. */
function updateFrames(ids, fn) {
  const m = (l) => l.map((f) => (ids.has(f.id) ? fn(f) : f));
  S.fwd = m(S.fwd); S.back = m(S.back);
}
function selectOnly(i) { S.sel = new Set([S.frames[i].id]); S.cur = i; S.anchor = i; }

// ---------- rendering ----------
function refresh() {
  if (!S.yoyo) S.track = 'fwd';
  for (const t of ['fwd', 'back']) S.curT[t] = clamp(S.curT[t], 0, Math.max(0, listOf(t).length - 1));
  const ids = new Set(everything().map((f) => f.id));
  for (const id of [...S.sel]) if (!ids.has(id)) S.sel.delete(id);
  const has = S.fwd.length > 0 || S.back.length > 0;
  $('#empty').classList.toggle('hidden', has);
  $$('[data-needs-frames]').forEach((el) => el.querySelectorAll('button,select').forEach((b) => (b.disabled = !has)));
  $('#player').style.visibility = has ? 'visible' : 'hidden';
  $('#btnUndo').disabled = !S.undo.length;
  $('#btnRedo').disabled = !S.redo.length;
  $('#btnYoyo').classList.toggle('active', S.yoyo);
  $('#skipEnds').checked = S.skipEnds;
  if (has) {
    $('[data-act="deleteHidden"]').disabled = !everything().some((f) => f.skip);
    const d = S.yoyo ? yoyoDiff() : null;
    $('[data-act="equalize"]').disabled = !d || !d.list.some((x) => x.kind === 'missing' || x.kind === 'extra');
  }
  if (!has && S.panel && S.panel !== 'theme') closePanel();
  renderStrip();
  layoutStage();
  drawCurrent();
  updateStatus();
  if (S.panel && panels[S.panel].onRefresh) panels[S.panel].onRefresh();
}

function updateStatus() {
  if (!S.fwd.length && !S.back.length) { $('#statusText').textContent = 'No frames'; $('#frameInfo').textContent = ''; return; }
  const n = S.sel.size;
  const count = S.yoyo ? `${S.fwd.length} forward + ${S.back.length} backward frames` : `${S.fwd.length} frames`;
  $('#statusText').textContent = `${count} · ${S.w}×${S.h} · ${fmtTime(totalMs())}` + (n > 1 ? ` · ${n} selected` : '');
  const f = S.frames[S.cur];
  const info = $('#frameInfo');
  info.textContent = f ? (S.track === 'back' ? `${backName(S.cur)} · ${f.delay} ms` : `${S.cur + 1} / ${S.frames.length} · ${f.delay} ms`) + (f.skip ? ' · hidden' : '') : 'Empty strip';
  info.title = f ? (S.yoyo ? (S.track === 'fwd' ? 'Forward ' : 'Backward ') : '') + `frame ${S.cur + 1} of ${S.frames.length}, shown for ${f.delay} ms` : '';
}

function layoutStage() {
  if (!S.w) return;
  const z = $('#zoom').value;
  const st = $('#stage');
  if (z === 'fit') {
    S.scale = Math.min((st.clientWidth - 24) / S.w, (st.clientHeight - 24) / S.h, 2);
  } else S.scale = +z;
  S.scale = Math.max(0.05, S.scale);
  for (const c of [canvas, overlay]) {
    c.style.width = Math.round(S.w * S.scale) + 'px';
    c.style.height = Math.round(S.h * S.scale) + 'px';
  }
  st.classList.toggle('pixel', S.scale >= 2);
}
window.addEventListener('resize', () => { layoutStage(); syncStrip(); });

let drawToken = 0;
/** Show the current frame. opts.scroll = false leaves the strips where they are. */
async function drawCurrent(opts = {}) {
  syncStrip(opts.scroll ?? true);
  updateStatus();
  const f = S.frames[S.cur];
  const tok = ++drawToken;
  if (!f) { ctx.clearRect(0, 0, canvas.width, canvas.height); drawOverlay(); return; }
  const img = await loadImg(f.path).catch(() => null);
  if (tok !== drawToken) return;
  if (canvas.width !== S.w || canvas.height !== S.h) {
    canvas.width = overlay.width = S.w; canvas.height = overlay.height = S.h;
  }
  ctx.clearRect(0, 0, S.w, S.h);
  if (img) ctx.drawImage(img, 0, 0, S.w, S.h);
  drawOverlay();
}

function drawOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const p = S.panel && panels[S.panel];
  if (p && p.overlay) p.overlay(octx);
}

// ---------- yoyo differences ----------
/** Forward frames the backward pass repeats: all of them, or all but the first and last with "Skip ends". */
const mirrorSource = () => (S.skipEnds ? S.fwd.slice(1, -1) : S.fwd.slice());
/**
 * Compare the backward strip with what a pure mirror of the forward strip would be
 * (forward without its first and last frame, reversed). Frames are matched by image
 * (longest common subsequence), so one inserted frame does not flag everything after it.
 * Returns { fwd: Map(id -> kind), back: Map(id -> kind), twin: Map(id -> id), list: [{track, id, kind}] }
 * kinds: 'missing' (forward frame with no backward copy), 'extra' (backward frame not in forward),
 *        'timing' (same image, different delay).
 */
function yoyoDiff() {
  const res = { fwd: new Map(), back: new Map(), twin: new Map(), list: [], align: [] };
  if (!S.yoyo) return res;
  const exp = mirrorSource().reverse();
  const bk = S.back;
  const n = exp.length, m = bk.length;
  const pairs = [];
  if (n * m <= 4e6) {
    const L = new Uint16Array((n + 1) * (m + 1));
    const at = (i, j) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      L[at(i, j)] = exp[i].path === bk[j].path ? L[at(i + 1, j + 1)] + 1 : Math.max(L[at(i + 1, j)], L[at(i, j + 1)]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (exp[i].path === bk[j].path) { pairs.push([i, j]); res.align.push({ i, j }); i++; j++; }
      else if (L[at(i + 1, j)] >= L[at(i, j + 1)]) res.align.push({ i: i++ }); else res.align.push({ j: j++ });
    }
    while (i < n) res.align.push({ i: i++ });
    while (j < m) res.align.push({ j: j++ });
  } else {
    for (let k = 0; k < Math.max(n, m); k++) {
      if (k < n && k < m && exp[k].path === bk[k].path) { pairs.push([k, k]); res.align.push({ i: k, j: k }); }
      else { if (k < n) res.align.push({ i: k }); if (k < m) res.align.push({ j: k }); }
    }
  }
  const mi = new Set(pairs.map((p) => p[0])), mj = new Set(pairs.map((p) => p[1]));
  for (const [i, j] of pairs) {
    res.twin.set(exp[i].id, bk[j].id); res.twin.set(bk[j].id, exp[i].id);
    if (exp[i].delay !== bk[j].delay) { res.fwd.set(exp[i].id, 'timing'); res.back.set(bk[j].id, 'timing'); }
  }
  exp.forEach((f, i) => { if (!mi.has(i)) res.fwd.set(f.id, 'missing'); });
  bk.forEach((f, j) => { if (!mj.has(j)) res.back.set(f.id, 'extra'); });
  for (const f of S.fwd) if (res.fwd.has(f.id)) res.list.push({ track: 'fwd', id: f.id, kind: res.fwd.get(f.id) });
  for (const f of S.back) if (res.back.has(f.id) && res.back.get(f.id) !== 'timing') res.list.push({ track: 'back', id: f.id, kind: res.back.get(f.id) });
  return res;
}
const DIFF_TIP = {
  missing: 'Not in the backward strip',
  extra: 'Only in the backward strip (not in forward)',
  timing: 'Delay differs from its twin in the other strip',
};
const DIFF_BADGE = { missing: '−', extra: '+', timing: '⏱' };

// ---------- frame strips ----------
const timeline = $('#timeline');
let diff = yoyoDiff();
const laneEl = (t) => $(`.lane[data-track="${t}"]`);
const stripEl = (t) => $(`.lane[data-track="${t}"] .strip`);

/**
 * Lay out the rows as columns. In yoyo the backward row is drawn mirrored (right to left), so every
 * backward frame sits directly under its sister frame in the forward row. A frame that exists in only one
 * row leaves an empty "skip" slot in the other. With "Skip ends" the forward row's two turnaround frames get a skip
 * slot under them. Playing forward the strips scroll one way, playing backward they scroll the other way.
 */
function buildRows() {
  const rows = { fwd: [], back: [], A: 0 };
  const n = S.fwd.length;
  if (!S.yoyo) { rows.fwd = S.fwd.map((_, i) => ({ i })); return rows; }
  const al = diff.align;
  rows.A = al.length;
  const base = S.skipEnds ? n - 2 : n - 1; // exp[i] is forward frame base - i
  rows.back = al.map((x) => (x.j != null ? { i: x.j } : { gap: 'fwd', src: base - x.i }));
  const mid = [...al].reverse().map((x) => (x.i != null ? { i: base - x.i } : { gap: 'back', src: x.j }));
  rows.fwd = S.skipEnds && n ? [{ i: 0 }, ...mid, ...(n > 1 ? [{ i: n - 1 }] : [])] : mid;
  for (const t of ['fwd', 'back']) {
    let count = 0;
    rows[t].forEach((x) => { if (x.gap) x.ins = count; else count++; });
  }
  // mirror the backward row into forward-row columns
  // with "Skip ends" the first / last forward frame get a skip slot under them
  const endSlot = (src, ins) => ({ gap: 'fwd', src, ins, end: true });
  rows.back = [...[...rows.back].reverse()];
  if (S.skipEnds && n) {
    rows.back.unshift(endSlot(0, S.back.length));
    if (n > 1) rows.back.push(endSlot(n - 1, 0));
  }
  return rows;
}
let rows = { fwd: [], back: [], A: 0 };
const backName = (i) => (diff.backLabel && diff.backLabel.get(i)) || `#${i + 1}`;
const slotOf = (t, i) => rows[t].findIndex((x) => x.i === i);
/** Column in the other row that lines up with frame i of row t: the same column, since the rows are mirrored. */
function partnerSlot(t, i) { return slotOf(t, i); }

function renderStrip() {
  diff = yoyoDiff();
  rows = buildRows();
  timeline.classList.toggle('yoyo', S.yoyo);
  timeline.classList.toggle('hidden', !S.fwd.length && !S.back.length);
  for (const t of ['back', 'fwd']) {
    const strip = stripEl(t);
    strip.innerHTML = '';
    if (t === 'back' && !S.yoyo) continue;
    const list = listOf(t);
    const frag = document.createDocumentFragment();
    frag.appendChild(Object.assign(document.createElement('div'), { className: 'pad' }));
    const dm = diff[t];
    if (t === 'back') diff.backLabel = new Map();
    rows[t].forEach((x, col) => {
      // backward frames are named after their sister frame above: the one under 5 is -5
      if (t === 'back' && !x.gap) { const sis = rows.fwd[col]; diff.backLabel.set(x.i, sis && sis.i != null ? `-${sis.i + 1}` : '–'); }
    });
    for (const x of rows[t]) {
      const el = document.createElement('div');
      if (x.gap) {
        el.className = 'slot gap' + (x.end ? ' endskip' : '');
        el.dataset.ins = x.ins;
        el.title = x.end
          ? `"Skip ends" is on, so the backward pass doesn't repeat forward frame ${x.src + 1}. Untick it to include it.`
          : x.gap === 'fwd'
          ? `Forward frame ${x.src + 1} is skipped here. Drag it here to add it.`
          : `Backward frame ${backName(x.src)} has no match in the forward strip, so forward skips it here.`;
        el.innerHTML = `<span class="skipArrow">${t === 'back' ? '⟵' : '⟶'}</span><span class="skipTxt">skips</span>`;
      } else {
        const f = list[x.i], k = dm.get(f.id);
        el.className = 'slot thumb' + (S.sel.has(f.id) ? ' sel' : '') + (k ? ' diff diff-' + k : '') + (f.skip ? ' skipped' : '');
        el.draggable = true;
        el.dataset.i = x.i;
        if (k) el.title = DIFF_TIP[k];
        el.innerHTML = `<img loading="lazy" src="${fileUrl(f.path)}"><div class="meta"><span>${t === 'back' ? diff.backLabel.get(x.i) : x.i + 1}</span>` +
          `<button class="skipBtn" title="${f.skip ? 'Hidden: playback and export skip this frame. Click to show it again (H)' : 'Hide this frame to see how the animation looks without it (H)'}">${f.skip ? EYE_OFF : EYE}</button>` +
          `<span>${f.delay} ms</span></div>` +
          (k ? `<span class="badge">${DIFF_BADGE[k]}</span>` : '');
      }
      frag.appendChild(el);
    }
    if (!list.length && !rows[t].length) frag.appendChild(Object.assign(document.createElement('div'), { className: 'emptyLane', textContent: 'No frames. Drag frames here from the forward strip, or reset it from the Sequence panel.' }));
    frag.appendChild(Object.assign(document.createElement('div'), { className: 'pad' }));
    strip.appendChild(frag);
  }
  const n = diff.list.length;
  $('#diffInfo').textContent = `${n} difference${n > 1 ? 's' : ''}`;
  $('.diffNav').classList.toggle('hidden', !n);
}

// Strips jump straight to the new position (no sliding), so every step is a crisp frame change.
function scrollStrip(el, target) {
  target = clamp(Math.round(target), 0, el.scrollWidth - el.clientWidth);
  if (Math.abs(target - el.scrollLeft) < 1) return;
  el._auto = performance.now() + 80;
  el.scrollLeft = target;
}

function centerSlot(t, slot) {
  const strip = stripEl(t), slots = $$('.slot', strip);
  if (!slots.length || slot == null || slot < -1) return;
  const w = slots[0].offsetWidth;
  const stride = slots.length > 1 ? slots[1].offsetLeft - slots[0].offsetLeft : w + 6;
  scrollStrip(strip, slots[0].offsetLeft + slot * stride + w / 2 - strip.clientWidth / 2);
}
const thumbAt = (t, i) => $(`.thumb[data-i="${i}"]`, stripEl(t));

/**
 * Mark the active strip and its current frame, and move the strips so the current frame sits in the center box.
 * In yoyo the other strip moves in tandem, keeping the current frame's duplicate (or the empty skip slot)
 * in the box right above / below it.
 */
function syncStrip(mode = true) {
  for (const t of ['fwd', 'back']) laneEl(t).classList.toggle('active', t === S.track);
  $$('.slot.cur,.slot.twin').forEach((el) => el.classList.remove('cur', 'twin'));
  const cur = thumbAt(S.track, S.cur);
  if (cur) cur.classList.add('cur');
  if (mode) centerSlot(S.track, slotOf(S.track, S.cur));
  if (!S.yoyo || !S.frames.length) return;
  const o = other(S.track), slot = partnerSlot(S.track, S.cur);
  const el = $$('.slot', stripEl(o))[slot];
  if (el) {
    el.classList.add('twin');
    if (el.dataset.i != null) S.curT[o] = +el.dataset.i;
  }
  if (mode) centerSlot(o, slot);
}
const scrollToCurrent = () => syncStrip();

function setTrack(t) {
  if (t === S.track || (t === 'back' && !S.yoyo)) return;
  S.track = t;
}

function goTo(i, t = S.track) {
  setTrack(t);
  if (!S.frames.length) return;
  S.cur = clamp(i, 0, S.frames.length - 1);
  drawCurrent();
}

function jumpDiff(dir) {
  const L = diff.list; if (!L.length) return;
  stopPlay();
  const order = (d) => (d.track === 'fwd' ? 0 : 1e6) + listOf(d.track).findIndex((f) => f.id === d.id);
  const here = (S.track === 'fwd' ? 0 : 1e6) + S.cur;
  const sorted = L.map((d) => ({ ...d, o: order(d) })).sort((a, b) => a.o - b.o);
  const pick = dir > 0 ? (sorted.find((d) => d.o > here) || sorted[0]) : ([...sorted].reverse().find((d) => d.o < here) || sorted[sorted.length - 1]);
  setTrack(pick.track);
  const i = S.frames.findIndex((f) => f.id === pick.id);
  selectOnly(i); renderStrip(); drawCurrent();
}
$('#diffPrev').onclick = () => jumpDiff(-1);
$('#diffNext').onclick = () => jumpDiff(1);
$('#btnDup').onclick = () => { stopPlay(); actions.duplicate(); };
$('#diffInfo').onclick = () => jumpDiff(1);

// ---------- hidden frames ----------
const EYE = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
/** Hide or show frames without removing them; hidden frames are skipped in playback and export. */
function toggleSkip(frames) {
  if (!frames.length) return;
  const hide = frames.some((f) => !f.skip); // mixed selection: hide them all
  commit();
  updateFrames(new Set(frames.map((f) => f.id)), (f) => ({ ...f, skip: hide || undefined }));
  refresh();
}
timeline.addEventListener('click', (e) => {
  const b = e.target.closest('.skipBtn'); if (!b) return;
  e.stopPropagation();
  const t = b.closest('.thumb'), f = listOf(laneOf(t))[+t.dataset.i];
  stopPlay();
  toggleSkip([f]);
}, true);

// ---------- strip interaction ----------
const laneOf = (el) => el.closest('.lane')?.dataset.track;

timeline.addEventListener('mousedown', (e) => {
  if (e.target.closest('.skipBtn')) return;
  const t = e.target.closest('.thumb'); if (!t) return;
  const track = laneOf(t);
  if (track !== S.track) { setTrack(track); if (!(e.ctrlKey || e.metaKey)) S.sel.clear(); }
  const i = +t.dataset.i, id = S.frames[i].id;
  if (e.shiftKey) {
    const [a, b] = [Math.min(S.anchor, i), Math.max(S.anchor, i)];
    if (!(e.ctrlKey || e.metaKey)) S.sel.clear();
    for (let k = a; k <= b; k++) S.sel.add(S.frames[k].id);
    S.cur = i;
  } else if (e.ctrlKey || e.metaKey) {
    S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id);
    S.cur = i; S.anchor = i;
  } else if (!S.sel.has(id) || S.sel.size <= 1) {
    selectOnly(i);
  } else { S.cur = i; S.pendingSingle = i; }
  stopPlay();
  $$('.thumb').forEach((el) => { const l = listOf(laneOf(el))[+el.dataset.i]; el.classList.toggle('sel', !!l && S.sel.has(l.id)); });
  // don't slide the strip yet: that would pull the frame out from under the mouse before a drag starts
  drawCurrent({ scroll: false });
});
timeline.addEventListener('click', (e) => {
  const t = e.target.closest('.thumb');
  if (t && S.pendingSingle === +t.dataset.i) { selectOnly(S.pendingSingle); renderStrip(); updateStatus(); }
  S.pendingSingle = null;
  if (t) syncStrip(); // now center the clicked frame
});

// Scrolling a strip by hand scrubs: the frame under the center box becomes the current frame.
function onStripScroll(t) {
  const strip = stripEl(t);
  if (performance.now() < (strip._auto || 0) || dragIds) return;
  // the two rows are columns of one timeline: keep them scrolled together
  if (S.yoyo) { const o = stripEl(other(t)); o._auto = performance.now() + 80; o.scrollLeft = strip.scrollLeft; }
  if (S.playing) return;
  const slots = $$('.slot', strip); if (!slots.length) return;
  const c = strip.scrollLeft + strip.clientWidth / 2;
  let col = 0, bd = Infinity;
  slots.forEach((el, k) => { const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - c); if (d < bd) { bd = d; col = k; } });
  // the frame in that column on the row being edited, or on the other row if this one skips it
  let tr = S.track, el = $$('.slot', stripEl(tr))[col];
  if ((!el || el.dataset.i == null) && S.yoyo) { tr = other(tr); el = $$('.slot', stripEl(tr))[col]; }
  if (el && el.dataset.i != null) {
    const i = +el.dataset.i;
    if (tr !== S.track || i !== S.cur) { setTrack(tr); S.cur = i; S.anchor = i; drawCurrent({ scroll: false }); }
  }
  clearTimeout(strip._snap);
  strip._snap = setTimeout(() => syncStrip(), 180);
}
for (const t of ['fwd', 'back']) {
  const strip = stripEl(t);
  strip.addEventListener('scroll', () => onStripScroll(t));
  // vertical mouse wheel scrolls the strip sideways
  strip.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); strip._auto = 0; strip.scrollLeft += e.deltaY; }
  }, { passive: false });
}

let dragIds = null, dragFrom = null;
timeline.addEventListener('dragstart', (e) => {
  const t = e.target.closest('.thumb'); if (!t) return;
  S.pendingSingle = null;
  dragFrom = laneOf(t);
  const id = listOf(dragFrom)[+t.dataset.i].id;
  dragIds = S.sel.has(id) ? new Set(S.sel) : new Set([id]);
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('text/x-frames', '1');
});
const clearDrop = () => $$('.dropL,.dropR,.dropLane').forEach((el) => el.classList.remove('dropL', 'dropR', 'dropLane'));
timeline.addEventListener('dragover', (e) => {
  if (!dragIds) return;
  const lane = e.target.closest('.lane'); if (!lane || (lane.dataset.track === 'back' && !S.yoyo)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = lane.dataset.track === dragFrom ? 'move' : 'copy';
  clearDrop();
  const gap = e.target.closest('.gap');
  if (gap) { gap.classList.add('dropL'); return; }
  const t = e.target.closest('.thumb');
  if (!t) { lane.classList.add('dropLane'); return; }
  const r = t.getBoundingClientRect();
  t.classList.add(e.clientX < r.left + r.width / 2 ? 'dropL' : 'dropR');
});
timeline.addEventListener('drop', (e) => {
  if (!dragIds) return;
  const lane = e.target.closest('.lane');
  e.preventDefault(); e.stopPropagation();
  clearDrop();
  if (!lane) { dragIds = null; return; }
  const to = lane.dataset.track;
  const t = e.target.closest('.thumb');
  const dest = listOf(to);
  let target = dest.length;
  const gap = e.target.closest('.gap');
  if (gap) target = +gap.dataset.ins;
  else if (t) { const r = t.getBoundingClientRect(); const left = e.clientX < r.left + r.width / 2; target = +t.dataset.i + ((to === 'back' ? !left : left) ? 0 : 1); }
  commit();
  const src = listOf(dragFrom);
  const moving = src.filter((f) => dragIds.has(f.id));
  if (to === dragFrom) {
    const before = dest.slice(0, target).filter((f) => !dragIds.has(f.id)).length;
    const rest = dest.filter((f) => !dragIds.has(f.id));
    rest.splice(before, 0, ...moving);
    S.track = to; S.frames = rest; S.cur = before;
  } else {
    // dropping on the other strip copies the frames there
    const copies = moving.map((f) => newFrame(f.path, f.delay));
    const out = dest.slice(); out.splice(target, 0, ...copies);
    S.track = to; S.frames = out; S.cur = target;
    S.sel = new Set(copies.map((f) => f.id));
  }
  dragIds = null;
  refresh();
});
timeline.addEventListener('dragend', () => { dragIds = null; clearDrop(); });

// ---------- playback ----------
let playTimer = null;
function step1() {
  if (S.cur + 1 < S.frames.length) { S.cur++; return; }
  if (S.yoyo && listOf(other(S.track)).length) { S.track = other(S.track); S.cur = 0; return; }
  S.cur = 0;
}
/** Next frame in playing order, jumping over hidden ones. */
function advance() {
  const n = played().length;
  for (let k = 0; k < n; k++) { step1(); if (!S.frames[S.cur].skip) return; }
}
function play() {
  if (S.playing || shown().length < 2) return;
  if (!S.frames.length) setTrack('fwd');
  if (S.frames[S.cur].skip) advance();
  S.playing = true; $('#btnPlay').textContent = '❚❚';
  const step = () => {
    if (!S.playing) return;
    const d = S.frames[S.cur].delay;
    playTimer = setTimeout(() => { advance(); drawCurrent(); step(); }, d);
  };
  step();
}
function stopPlay() {
  if (!S.playing) return;
  S.playing = false; clearTimeout(playTimer); $('#btnPlay').textContent = '▶';
  syncStrip();
}
$('#btnPlay').onclick = () => (S.playing ? stopPlay() : play());
$('#btnFirst').onclick = () => { stopPlay(); goTo(0, 'fwd'); };
$('#btnLast').onclick = () => { stopPlay(); S.yoyo && S.back.length ? goTo(S.back.length - 1, 'back') : goTo(S.fwd.length - 1, 'fwd'); };
$('#btnPrev').onclick = () => { stopPlay(); goTo(S.cur - 1); };
$('#btnNext').onclick = () => { stopPlay(); goTo(S.cur + 1); };
$('#zoom').onchange = () => { layoutStage(); };

/** Turn yoyo mode on or off. The first time it is turned on, the backward strip starts as a mirror of the forward one. */
function setYoyo(on) {
  if (on === S.yoyo) return;
  stopPlay();
  commit();
  S.yoyo = on;
  if (on && !S.back.length) S.back = mirrorBack();
  if (!on) S.track = 'fwd';
  refresh();
}
const mirrorBack = () => mirrorSource().reverse().map((f) => newFrame(f.path, f.delay));
$('#btnYoyo').onclick = () => setYoyo(!S.yoyo);

/** "Skip ends": whether the backward pass repeats the first and last frame. Adds or removes those copies on the backward strip. */
function setSkipEnds(on) {
  if (on === S.skipEnds) return;
  stopPlay();
  commit();
  S.skipEnds = on;
  const n = S.fwd.length;
  if (S.yoyo && n > 1) {
    const first = S.fwd[0], last = S.fwd[n - 1];
    if (!on) S.back = [newFrame(last.path, last.delay), ...S.back, newFrame(first.path, first.delay)];
    else {
      const b = S.back.slice();
      if (b.length && b[0].path === last.path) b.shift();
      if (b.length && b[b.length - 1].path === first.path) b.pop();
      S.back = b;
    }
  }
  refresh();
}
$('#skipEnds').onchange = (e) => setSkipEnds(e.target.checked);

// ---------- pixel operations ----------
/**
 * Render `items` (frame objects) through draw(ctx, img, frame) onto an outW×outH canvas and save new frame files.
 * Returns Map(key -> new path) where key is the source path (frames sharing an image are rendered once),
 * or the frame id when perFrame is set (the drawing depends on the frame, e.g. a progress bar).
 */
async function mapFrames(items, outW, outH, draw, label = 'Applying', perFrame = false) {
  const keyOf = (f) => (perFrame ? f.id : f.path);
  const uniq = [...new Map(items.map((f) => [keyOf(f), f])).values()];
  const canvases = Array.from({ length: 4 }, () => {
    const c = document.createElement('canvas'); c.width = outW; c.height = outH;
    return { c, x: c.getContext('2d', { willReadFrequently: false }) };
  });
  const paths = new Map();
  let done = 0;
  await pool(uniq, 4, async (f, _k, w) => {
    const { c, x } = canvases[w];
    const img = await loadImg(f.path);
    x.save(); x.clearRect(0, 0, outW, outH);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    draw(x, img, f);
    x.restore();
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    paths.set(keyOf(f), await api.saveFrame(new Uint8Array(await blob.arrayBuffer())));
    showProgress(label, ++done / uniq.length);
  });
  return paths;
}

async function applyPixels(label, items, outW, outH, draw, perFrame = false) {
  return busy(label, async () => {
    const paths = await mapFrames(items, outW, outH, draw, label, perFrame);
    commit();
    updateFrames(new Set(items.map((f) => f.id)), (f) => ({ ...f, path: paths.get(perFrame ? f.id : f.path) }));
    S.w = outW; S.h = outH;
    refresh();
  });
}

// ---------- frame operations ----------
const actions = {
  delete() {
    const idx = new Set(selIdx());
    if (!idx.size) return;
    commit();
    S.frames = S.frames.filter((_, i) => !idx.has(i));
    S.sel.clear();
    S.cur = Math.min(S.cur, S.frames.length - 1);
    if (!S.fwd.length && !S.back.length) { S.w = S.h = 0; }
    refresh();
  },
  duplicate() {
    const idx = new Set(selIdx()); if (!idx.size) return;
    commit();
    // every copy goes right after its original
    const out = [], copies = [];
    let cur = 0;
    S.frames.forEach((f, i) => {
      out.push(f);
      if (idx.has(i)) { const c = newFrame(f.path, f.delay); out.push(c); copies.push(c); if (i === S.cur || !cur) cur = out.length - 1; }
    });
    S.frames = out;
    S.sel = new Set(copies.map((f) => f.id)); S.cur = cur;
    refresh();
  },
  /** Delete every hidden frame on both strips. */
  deleteHidden() {
    if (!everything().some((f) => f.skip)) return;
    commit();
    const keep = (l, t) => { const cur = l[S.curT[t]]; const out = l.filter((f) => !f.skip); S.curT[t] = Math.max(0, cur ? out.findIndex((f) => f.id === cur.id) : 0); return out; };
    S.fwd = keep(S.fwd, 'fwd'); S.back = keep(S.back, 'back');
    S.sel.clear(); refresh();
  },
  /** Delete all frames before (dir -1) or after (dir 1) the current frame on the strip being edited. */
  deleteSide(dir) {
    const n = S.frames.length;
    if (!n || (dir < 0 && S.cur === 0) || (dir > 0 && S.cur === n - 1)) return;
    commit();
    if (dir < 0) { S.frames = S.frames.slice(S.cur); S.cur = 0; } else S.frames = S.frames.slice(0, S.cur + 1);
    S.sel.clear(); refresh();
  },
  deleteBefore() { actions.deleteSide(-1); },
  deleteAfter() { actions.deleteSide(1); },
  /** Yoyo: frames deleted on one strip are deleted on the other too, so both passes match again. */
  equalize() {
    if (!S.yoyo) return;
    const d = yoyoDiff();
    const gone = new Set([...d.fwd].filter(([, k]) => k === 'missing').map(([id]) => id).concat([...d.back].filter(([, k]) => k === 'extra').map(([id]) => id)));
    if (!gone.size) { toast('The strips already match'); return; }
    commit();
    for (const t of ['fwd', 'back']) {
      const l = listOf(t), cur = l[S.curT[t]];
      const out = l.filter((f) => !gone.has(f.id));
      let i = cur ? out.findIndex((f) => f.id === cur.id) : 0;
      if (i < 0) i = Math.min(out.length - 1, l.slice(0, S.curT[t]).filter((f) => !gone.has(f.id)).length);
      S.curT[t] = Math.max(0, i);
      if (t === 'fwd') S.fwd = out; else S.back = out;
    }
    S.sel.clear(); refresh();
    toast(`Deleted ${gone.size} frame${gone.size > 1 ? 's' : ''} so both strips match`);
  },
  moveLeft() { moveSel(-1); },
  moveRight() { moveSel(1); },
};

/** Move the selection one step; dir is on screen (-1 = left), so it flips on the mirrored backward row. */
function moveSel(dir) {
  if (S.track === 'back') dir = -dir;
  const idx = selIdx();
  if (!idx.length) return;
  if ((dir < 0 && idx[0] === 0) || (dir > 0 && idx[idx.length - 1] === S.frames.length - 1)) return;
  commit();
  const ids = new Set(idx.map((i) => S.frames[i].id));
  const order = dir < 0 ? idx : [...idx].reverse();
  for (const i of order) {
    const j = i + dir;
    [S.frames[i], S.frames[j]] = [S.frames[j], S.frames[i]];
  }
  S.sel = ids; S.cur = clamp(S.cur + dir, 0, S.frames.length - 1);
  refresh(); scrollToCurrent();
}

$$('[data-act]').forEach((b) => (b.onclick = () => { stopPlay(); actions[b.dataset.act](); }));

// ---------- panels ----------
function field(label, inner) { return `<div class="field"><span>${label}</span><span class="row">${inner}</span></div>`; }
function scopeField(def = 'all') {
  return field('Apply to', `<select data-k="scope"><option value="all"${def === 'all' ? ' selected' : ''}>All frames</option><option value="sel"${def === 'sel' ? ' selected' : ''}>Selected frames</option></select>`);
}
const val = (k) => { const el = $(`#panel [data-k="${k}"]`); return el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? +el.value : el.value; };

function openPanel(name) {
  stopPlay();
  if (S.panel === name) { closePanel(); return; }
  if (S.panel && panels[S.panel].close) panels[S.panel].close();
  S.panel = name;
  const p = panels[name];
  const old = $('#panel'); const el = old.cloneNode(false); old.replaceWith(el);
  el.innerHTML = `<h2>${p.title}</h2>` + p.html();
  $$('[data-panel]').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  if (p.init) p.init(el);
  el.addEventListener('input', () => { if (p.onInput) p.onInput(); drawOverlay(); });
  const close = $('[data-close]', el); if (close) close.onclick = closePanel;
  overlay.style.cursor = p.cursor || 'default';
  overlay.style.pointerEvents = p.mouse ? 'auto' : 'none';
  requestAnimationFrame(() => { layoutStage(); drawOverlay(); });
}
function closePanel() {
  if (S.panel && panels[S.panel].close) panels[S.panel].close();
  S.panel = null;
  const el = $('#panel'); const clone = el.cloneNode(false); el.replaceWith(clone);
  $$('[data-panel]').forEach((b) => b.classList.remove('active'));
  overlay.style.pointerEvents = 'none';
  requestAnimationFrame(() => { layoutStage(); drawOverlay(); });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-panel]');
  if (b && !b.disabled) openPanel(b.dataset.panel);
});

// overlay mouse -> panel
function imgPt(e) {
  const r = overlay.getBoundingClientRect();
  return { x: (e.clientX - r.left) / S.scale, y: (e.clientY - r.top) / S.scale };
}
let mouseDown = false;
overlay.addEventListener('mousedown', (e) => { const p = panels[S.panel]; if (!p || !p.mouse) return; mouseDown = true; p.mouse('down', imgPt(e), e); drawOverlay(); });
window.addEventListener('mousemove', (e) => { const p = panels[S.panel]; if (!p || !p.mouse) return; p.mouse(mouseDown ? 'drag' : 'move', imgPt(e), e); if (mouseDown) drawOverlay(); });
window.addEventListener('mouseup', (e) => { const p = panels[S.panel]; if (!mouseDown) return; mouseDown = false; if (p && p.mouse) { p.mouse('up', imgPt(e), e); drawOverlay(); } });

const LW = () => 1 / S.scale; // one screen pixel in image units

const panels = {};

// --- Timing ---
panels.timing = {
  title: 'Timing',
  html: () => `
    <p class="hint">Delay is how long each frame stays on screen.</p>
    ${scopeField('sel')}
    <h3>Set delay</h3>
    ${field('Delay (ms)', `<input type="number" data-k="delay" min="10" step="10" value="${S.frames[S.cur]?.delay || 100}">`)}
    <button id="tSet">Set delay</button>
    <h3>Frame rate</h3>
    ${field('Frames per second', `<input type="number" data-k="fps" min="1" max="100" value="15">`)}
    <button id="tFps">Set frame rate</button>
    <h3>Speed</h3>
    ${field('Speed (%)', `<input type="number" data-k="speed" min="5" max="1000" value="200">`)}
    <p class="hint">200% plays twice as fast, 50% at half speed.</p>
    <button id="tSpeed">Change speed</button>
    <div class="actions"><button data-close>Close</button></div>`,
  init() {
    const setD = (fn) => { commit(); updateFrames(new Set(scopeFrames(val('scope')).map((f) => f.id)), (f) => ({ ...f, delay: Math.max(10, Math.round(fn(f.delay))) })); refresh(); };
    $('#tSet').onclick = () => setD(() => val('delay'));
    $('#tFps').onclick = () => setD(() => 1000 / val('fps'));
    $('#tSpeed').onclick = () => setD((d) => d * 100 / val('speed'));
  },
  onRefresh() { const el = $('#panel [data-k="delay"]'); if (el && document.activeElement !== el) el.value = S.frames[S.cur]?.delay || 100; },
};

// --- Sequence ---
panels.reorder = {
  title: 'Sequence',
  html: () => `
    <div class="stack">
      <button id="qAll">Select all frames</button>
      <button id="qInv">Invert selection</button>
    </div>
    <h3>Order</h3>
    <div class="stack">
      <button id="qRev">Reverse order</button>
    </div>
    <p class="hint">Reverse, reduce and remove duplicates work on the strip you are editing. Reverse works on the selection if more than one frame is selected.</p>
    <h3>Yoyo</h3>
    <div class="stack">
      <button id="qYoyo">${S.yoyo ? 'Turn yoyo off' : 'Turn yoyo on (play forward, then backward)'}</button>
      ${S.yoyo ? `<button id="qMirror">Reset backward strip to mirror forward</button>
      <button id="qFlatten">Join both strips into one</button>` : ''}
    </div>
    <p class="hint">${S.yoyo
      ? 'The bottom strip is the backward pass and can be edited on its own. Frames that no longer mirror the forward strip are marked: + only in backward, − missing from backward, ⏱ different delay.'
      : 'Adds a second strip below for the backward pass, which you can edit separately.'}</p>
    <h3>Reduce frame count</h3>
    ${field('Keep 1 of every', `<input type="number" data-k="every" min="2" max="20" value="2"> frames`)}
    <button id="qReduce">Reduce</button>
    <p class="hint">Removed frames' time is added to the frame kept, so the speed stays the same.</p>
    <h3>Remove duplicates</h3>
    ${field('Similarity (%)', `<input type="number" data-k="sim" min="80" max="100" step="0.5" value="99.5">`)}
    <button id="qDup">Remove near-identical frames</button>
    <p class="hint">Great for screen recordings where nothing moves for a while.</p>
    <div class="actions"><button data-close>Close</button></div>`,
  init() {
    $('#qAll').onclick = () => { S.sel = new Set(S.frames.map((f) => f.id)); refresh(); };
    $('#qInv').onclick = () => { S.sel = new Set(S.frames.filter((f) => !S.sel.has(f.id)).map((f) => f.id)); refresh(); };
    $('#qRev').onclick = () => {
      commit();
      const idx = S.sel.size > 1 ? selIdx() : allIdx();
      const items = idx.map((i) => S.frames[i]).reverse();
      idx.forEach((i, k) => (S.frames[i] = items[k]));
      refresh();
    };
    this.yo = S.yoyo;
    $('#qYoyo').onclick = () => setYoyo(!S.yoyo);
    if (S.yoyo) {
      $('#qMirror').onclick = () => { commit(); S.back = mirrorBack(); S.curT.back = 0; refresh(); };
      $('#qFlatten').onclick = () => {
        commit(); S.fwd = played(); S.curT.fwd = S.track === 'back' ? S.fwd.length - S.back.length + S.curT.back : S.curT.fwd;
        S.back = []; S.yoyo = false; S.track = 'fwd'; refresh();
      };
    }
    $('#qReduce').onclick = () => {
      const n = val('every'); if (n < 2) return;
      commit();
      const out = [];
      S.frames.forEach((f, i) => { if (i % n === 0) out.push({ ...f }); else out[out.length - 1].delay += f.delay; });
      S.frames = out; S.sel.clear(); refresh();
    };
    $('#qDup').onclick = () => removeDuplicates(val('sim'));
  },
  // rebuild the panel when yoyo is switched elsewhere (player bar, undo)
  onRefresh() { if (this.yo !== S.yoyo) { this.yo = S.yoyo; setTimeout(() => { if (S.panel === 'reorder') { closePanel(); openPanel('reorder'); } }); } },
};

async function removeDuplicates(sim) {
  await busy('Comparing frames', async () => {
    const W = 96, H = Math.max(1, Math.round(96 * S.h / S.w));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    const data = async (f) => { x.clearRect(0, 0, W, H); x.drawImage(await loadImg(f.path), 0, 0, W, H); return x.getImageData(0, 0, W, H).data; };
    const out = [{ ...S.frames[0] }];
    let prev = await data(S.frames[0]);
    for (let i = 1; i < S.frames.length; i++) {
      const d = await data(S.frames[i]);
      let same = 0;
      for (let k = 0; k < d.length; k += 4) {
        const diff = Math.abs(d[k] - prev[k]) + Math.abs(d[k + 1] - prev[k + 1]) + Math.abs(d[k + 2] - prev[k + 2]) + Math.abs(d[k + 3] - prev[k + 3]);
        if (diff < 24) same++;
      }
      if ((same / (W * H)) * 100 >= sim) out[out.length - 1].delay += S.frames[i].delay;
      else { out.push({ ...S.frames[i] }); prev = d; }
      if (i % 10 === 0) showProgress('Comparing frames', i / S.frames.length);
    }
    const removed = S.frames.length - out.length;
    if (removed) { commit(); S.frames = out; S.sel.clear(); refresh(); }
    toast(removed ? `Removed ${removed} duplicate frame${removed > 1 ? 's' : ''}` : 'No duplicate frames found');
  });
}

// --- Crop ---
// The crop box starts as the whole image. Drag an edge or corner to pull it in, drag inside it to move it.
panels.crop = {
  title: 'Crop',
  cursor: 'default',
  html: () => `
    <p class="hint">The box starts at the full picture. Drag its edges or corners to pull them in, and drag inside the box to move it. Crop applies to all frames.</p>
    ${field('X', '<input type="number" data-k="x" min="0">')}
    ${field('Y', '<input type="number" data-k="y" min="0">')}
    ${field('Width', '<input type="number" data-k="w" min="1">')}
    ${field('Height', '<input type="number" data-k="h" min="1">')}
    <div class="row" style="margin-top:8px"><button id="cReset">Reset to full picture</button></div>
    <div class="actions"><button data-close>Cancel</button><button class="primary" id="cApply">Crop</button></div>`,
  init() {
    this.r = { x: 0, y: 0, w: S.w, h: S.h };
    this.drag = null;
    this.sync();
    $('#cReset').onclick = () => { this.r = { x: 0, y: 0, w: S.w, h: S.h }; this.sync(); drawOverlay(); };
    $('#cApply').onclick = () => {
      const r = this.norm();
      if (r.w < 1 || r.h < 1) return;
      closePanel();
      applyPixels('Cropping', everything(), r.w, r.h, (x, img) => x.drawImage(img, -r.x, -r.y, S.w, S.h));
    };
  },
  norm() {
    const r = this.r;
    let x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
    x = clamp(x, 0, S.w - 1); y = clamp(y, 0, S.h - 1);
    w = clamp(w, 1, S.w - x); h = clamp(h, 1, S.h - y);
    return { x, y, w, h };
  },
  sync() { const r = this.norm(); for (const k of ['x', 'y', 'w', 'h']) $(`#panel [data-k="${k}"]`).value = r[k]; },
  onInput() { this.r = { x: val('x'), y: val('y'), w: val('w'), h: val('h') }; },
  /** Which part of the box is under p: a string of edges ('l','r','t','b', e.g. 'tl' for a corner), 'move' or null. */
  hit(p) {
    const r = this.norm(), g = 10 * LW();
    const inX = p.x > r.x - g && p.x < r.x + r.w + g, inY = p.y > r.y - g && p.y < r.y + r.h + g;
    if (!inX || !inY) return null;
    let e = '';
    if (Math.abs(p.y - r.y) <= g) e += 't'; else if (Math.abs(p.y - (r.y + r.h)) <= g) e += 'b';
    if (Math.abs(p.x - r.x) <= g) e += 'l'; else if (Math.abs(p.x - (r.x + r.w)) <= g) e += 'r';
    if (e) return e;
    return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h ? 'move' : null;
  },
  mouse(type, p) {
    const CUR = { t: 'ns-resize', b: 'ns-resize', l: 'ew-resize', r: 'ew-resize', tl: 'nwse-resize', br: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize', move: 'move' };
    if (type === 'move') { overlay.style.cursor = CUR[this.hit(p)] || 'default'; return; }
    if (type === 'down') {
      const h = this.hit(p);
      this.drag = h && { h, p0: p, r0: this.norm() };
    } else if (type === 'drag' && this.drag) {
      const { h, p0, r0 } = this.drag, dx = p.x - p0.x, dy = p.y - p0.y, MIN = 4;
      if (h === 'move') {
        this.r = { x: clamp(r0.x + dx, 0, S.w - r0.w), y: clamp(r0.y + dy, 0, S.h - r0.h), w: r0.w, h: r0.h };
      } else {
        let L = r0.x, T = r0.y, Rr = r0.x + r0.w, B = r0.y + r0.h;
        if (h.includes('l')) L = clamp(L + dx, 0, Rr - MIN);
        if (h.includes('r')) Rr = clamp(Rr + dx, L + MIN, S.w);
        if (h.includes('t')) T = clamp(T + dy, 0, B - MIN);
        if (h.includes('b')) B = clamp(B + dy, T + MIN, S.h);
        this.r = { x: L, y: T, w: Rr - L, h: B - T };
      }
      this.sync();
    } else if (type === 'up') { this.drag = null; this.sync(); }
  },
  overlay(o) {
    const r = this.norm(), lw = LW();
    o.fillStyle = 'rgba(0,0,0,.55)';
    o.fillRect(0, 0, S.w, S.h);
    o.clearRect(r.x, r.y, r.w, r.h);
    o.strokeStyle = '#ff8f5c'; o.lineWidth = 2 * lw; o.setLineDash([6 * lw, 4 * lw]);
    o.strokeRect(r.x + lw, r.y + lw, r.w - 2 * lw, r.h - 2 * lw);
    o.setLineDash([]);
    // handles on the corners and edge midpoints
    const hs = 8 * lw;
    o.fillStyle = '#ff8f5c'; o.strokeStyle = '#16181d'; o.lineWidth = lw;
    for (const [hx, hy] of [[0, 0], [.5, 0], [1, 0], [0, .5], [1, .5], [0, 1], [.5, 1], [1, 1]]) {
      const cx = clamp(r.x + r.w * hx, hs / 2, S.w - hs / 2), cy = clamp(r.y + r.h * hy, hs / 2, S.h - hs / 2);
      o.fillRect(cx - hs / 2, cy - hs / 2, hs, hs); o.strokeRect(cx - hs / 2, cy - hs / 2, hs, hs);
    }
    o.fillStyle = '#fff'; o.font = `${12 * lw}px system-ui`;
    o.fillText(`${r.w} × ${r.h}`, r.x + 6 * lw, r.y + 18 * lw);
  },
};

// --- Resize ---
panels.resize = {
  title: 'Resize',
  html: () => `
    <p class="hint">Current size: ${S.w} × ${S.h}. Applies to all frames.</p>
    ${field('Width', `<input type="number" data-k="w" min="1" value="${S.w}">`)}
    ${field('Height', `<input type="number" data-k="h" min="1" value="${S.h}">`)}
    ${field('Keep aspect ratio', '<input type="checkbox" data-k="keep" checked>')}
    <div class="row" style="margin-top:8px">${[25, 50, 75, 150, 200].map((p) => `<button data-pct="${p}">${p}%</button>`).join('')}</div>
    <div class="actions"><button data-close>Cancel</button><button class="primary" id="rApply">Resize</button></div>`,
  init(el) {
    const w = $('[data-k="w"]', el), h = $('[data-k="h"]', el);
    w.oninput = () => { if (val('keep')) h.value = Math.max(1, Math.round(w.value * S.h / S.w)); };
    h.oninput = () => { if (val('keep')) w.value = Math.max(1, Math.round(h.value * S.w / S.h)); };
    $$('[data-pct]', el).forEach((b) => (b.onclick = () => { w.value = Math.round(S.w * b.dataset.pct / 100); h.value = Math.round(S.h * b.dataset.pct / 100); }));
    $('#rApply').onclick = () => {
      const W = Math.max(1, val('w')), H = Math.max(1, val('h'));
      if (W === S.w && H === S.h) return;
      closePanel();
      applyPixels('Resizing', everything(), W, H, (x, img) => x.drawImage(img, 0, 0, W, H));
    };
  },
};

// --- Rotate ---
panels.rotate = {
  title: 'Rotate & flip',
  html: () => `
    <p class="hint">Applies to all frames.</p>
    <div class="stack">
      <button data-rot="90">Rotate 90° clockwise</button>
      <button data-rot="-90">Rotate 90° counter-clockwise</button>
      <button data-rot="180">Rotate 180°</button>
      <button data-rot="fh">Flip horizontally</button>
      <button data-rot="fv">Flip vertically</button>
    </div>
    <div class="actions"><button data-close>Close</button></div>`,
  init(el) {
    $$('[data-rot]', el).forEach((b) => (b.onclick = () => {
      const r = b.dataset.rot, w = S.w, h = S.h;
      const swap = r === '90' || r === '-90';
      applyPixels('Rotating', everything(), swap ? h : w, swap ? w : h, (x, img) => {
        if (r === '90') { x.translate(h, 0); x.rotate(Math.PI / 2); }
        else if (r === '-90') { x.translate(0, w); x.rotate(-Math.PI / 2); }
        else if (r === '180') { x.translate(w, h); x.rotate(Math.PI); }
        else if (r === 'fh') { x.translate(w, 0); x.scale(-1, 1); }
        else if (r === 'fv') { x.translate(0, h); x.scale(1, -1); }
        x.drawImage(img, 0, 0, w, h);
      });
    }));
  },
};

// --- Text ---
function drawText(o, t) {
  if (!t.text) return;
  const lines = t.text.split('\n');
  o.font = `${t.bold ? 'bold ' : ''}${t.italic ? 'italic ' : ''}${t.size}px ${t.font}`;
  o.textAlign = t.align; o.textBaseline = 'top';
  const lh = t.size * 1.2;
  const widths = lines.map((l) => o.measureText(l).width);
  const bw = Math.max(...widths), bh = lh * lines.length;
  const left = t.align === 'center' ? t.x - bw / 2 : t.align === 'right' ? t.x - bw : t.x;
  if (t.box) {
    const pad = t.size * 0.3;
    o.fillStyle = t.boxColor; o.globalAlpha = t.boxAlpha / 100;
    o.fillRect(left - pad, t.y - pad, bw + pad * 2, bh + pad * 2);
    o.globalAlpha = 1;
  }
  lines.forEach((l, i) => {
    const y = t.y + i * lh;
    if (t.outline > 0) { o.lineJoin = 'round'; o.lineWidth = t.outline * 2; o.strokeStyle = t.outlineColor; o.strokeText(l, t.x, y); }
    o.fillStyle = t.color; o.fillText(l, t.x, y);
  });
  return { left, top: t.y, w: bw, h: bh };
}

panels.text = {
  title: 'Text',
  cursor: 'move',
  html: () => `
    <textarea data-k="text" rows="3" placeholder="Type your caption">Your text here</textarea>
    <p class="hint">Drag the text on the image to place it.</p>
    ${field('Font', `<select data-k="font">
      <option value="system-ui, sans-serif">Sans</option><option value="Georgia, serif">Serif</option>
      <option value="Consolas, 'Courier New', monospace">Mono</option><option value="Impact, 'Arial Black', sans-serif">Impact</option>
      <option value="'Comic Sans MS', 'Comic Neue', cursive">Comic</option></select>`)}
    ${field('Size', `<input type="number" data-k="size" min="6" max="400" value="${Math.max(12, Math.round(S.h / 10))}">`)}
    ${field('Style', '<label><input type="checkbox" data-k="bold" checked> Bold</label><label><input type="checkbox" data-k="italic"> Italic</label>')}
    ${field('Align', '<select data-k="align"><option value="left">Left</option><option value="center" selected>Center</option><option value="right">Right</option></select>')}
    ${field('Color', '<input type="color" data-k="color" value="#ffffff">')}
    ${field('Outline', '<input type="color" data-k="outlineColor" value="#000000"><input type="number" data-k="outline" min="0" max="40" value="3">')}
    ${field('Background', '<input type="checkbox" data-k="box"><input type="color" data-k="boxColor" value="#000000"><input type="number" data-k="boxAlpha" min="0" max="100" value="60">%')}
    <h3>Position</h3>
    <div class="row">${['Top', 'Middle', 'Bottom'].map((p) => `<button data-pos="${p}">${p}</button>`).join('')}</div>
    ${scopeField(S.sel.size > 1 ? 'sel' : 'all')}
    <div class="actions"><button data-close>Cancel</button><button class="primary" id="xApply">Add text</button></div>`,
  init(el) {
    this.x = S.w / 2; this.y = S.h * 0.8;
    $$('[data-pos]', el).forEach((b) => (b.onclick = () => {
      const t = this.opts(); const h = (t.text.split('\n').length) * t.size * 1.2;
      this.x = t.align === 'center' ? S.w / 2 : t.align === 'right' ? S.w - t.size * 0.6 : t.size * 0.6;
      this.y = b.dataset.pos === 'Top' ? t.size * 0.5 : b.dataset.pos === 'Middle' ? (S.h - h) / 2 : S.h - h - t.size * 0.5;
      drawOverlay();
    }));
    $('#xApply').onclick = () => {
      const t = this.opts(); const idx = scopeFrames(val('scope'));
      closePanel();
      applyPixels('Adding text', idx, S.w, S.h, (x, img) => { x.drawImage(img, 0, 0, S.w, S.h); drawText(x, t); });
    };
    setTimeout(() => $('[data-k="text"]', el).select(), 0);
  },
  opts() {
    return { text: val('text'), font: val('font'), size: val('size'), bold: val('bold'), italic: val('italic'), align: val('align'),
      color: val('color'), outline: val('outline'), outlineColor: val('outlineColor'), box: val('box'), boxColor: val('boxColor'), boxAlpha: val('boxAlpha'),
      x: this.x, y: this.y };
  },
  mouse(type, p) {
    if (type === 'down') this.drag = { dx: p.x - this.x, dy: p.y - this.y };
    else if (type === 'drag' && this.drag) { this.x = p.x - this.drag.dx; this.y = p.y - this.drag.dy; }
    else if (type === 'up') this.drag = null;
  },
  overlay(o) {
    const b = drawText(o, this.opts());
    if (b) { o.strokeStyle = 'rgba(255,143,92,.9)'; o.lineWidth = LW(); o.setLineDash([4 * LW(), 3 * LW()]); o.strokeRect(b.left - 4, b.top - 4, b.w + 8, b.h + 8); o.setLineDash([]); }
  },
};

// --- Draw ---
function drawShape(o, s) {
  o.save();
  o.strokeStyle = s.color; o.fillStyle = s.color; o.lineWidth = s.width; o.lineCap = 'round'; o.lineJoin = 'round';
  o.globalAlpha = s.tool === 'marker' ? 0.4 : 1;
  const [a, b] = [s.pts[0], s.pts[s.pts.length - 1]];
  o.beginPath();
  if (s.tool === 'pen' || s.tool === 'marker') {
    o.moveTo(a.x, a.y);
    for (const p of s.pts) o.lineTo(p.x, p.y);
    if (s.pts.length === 1) o.lineTo(a.x + 0.1, a.y);
    o.stroke();
  } else if (s.tool === 'line' || s.tool === 'arrow') {
    o.moveTo(a.x, a.y); o.lineTo(b.x, b.y); o.stroke();
    if (s.tool === 'arrow') {
      const ang = Math.atan2(b.y - a.y, b.x - a.x), L = Math.max(10, s.width * 4);
      o.beginPath();
      o.moveTo(b.x, b.y);
      o.lineTo(b.x - L * Math.cos(ang - 0.45), b.y - L * Math.sin(ang - 0.45));
      o.lineTo(b.x - L * Math.cos(ang + 0.45), b.y - L * Math.sin(ang + 0.45));
      o.closePath(); o.fill();
    }
  } else if (s.tool === 'rect') {
    s.fill ? o.fillRect(a.x, a.y, b.x - a.x, b.y - a.y) : o.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  } else if (s.tool === 'ellipse') {
    o.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    s.fill ? o.fill() : o.stroke();
  }
  o.restore();
}

panels.draw = {
  title: 'Draw',
  cursor: 'crosshair',
  html: () => `
    ${field('Tool', `<select data-k="tool"><option value="pen">Pen</option><option value="marker">Highlighter</option><option value="line">Line</option>
      <option value="arrow">Arrow</option><option value="rect">Rectangle</option><option value="ellipse">Ellipse</option></select>`)}
    ${field('Color', '<input type="color" data-k="color" value="#ff3b30">')}
    ${field('Thickness', `<input type="number" data-k="width" min="1" max="100" value="${Math.max(3, Math.round(S.w / 150))}">`)}
    ${field('Filled shapes', '<input type="checkbox" data-k="fill">')}
    <div class="row" style="margin-top:8px"><button id="dUndo">Undo stroke</button><button id="dClear">Clear</button></div>
    ${scopeField(S.sel.size > 1 ? 'sel' : 'all')}
    <div class="actions"><button data-close>Cancel</button><button class="primary" id="dApply">Apply drawing</button></div>`,
  init() {
    this.shapes = [];
    $('#dUndo').onclick = () => { this.shapes.pop(); drawOverlay(); };
    $('#dClear').onclick = () => { this.shapes = []; drawOverlay(); };
    $('#dApply').onclick = () => {
      const shapes = this.shapes; if (!shapes.length) return;
      const idx = scopeFrames(val('scope'));
      closePanel();
      applyPixels('Drawing', idx, S.w, S.h, (x, img) => { x.drawImage(img, 0, 0, S.w, S.h); shapes.forEach((s) => drawShape(x, s)); });
    };
  },
  mouse(type, p) {
    if (type === 'down') this.cur = { tool: val('tool'), color: val('color'), width: val('width'), fill: val('fill'), pts: [p] };
    else if (type === 'drag' && this.cur) {
      if (this.cur.tool === 'pen' || this.cur.tool === 'marker') this.cur.pts.push(p); else this.cur.pts[1] = p;
    } else if (type === 'up' && this.cur) { this.shapes.push(this.cur); this.cur = null; }
  },
  overlay(o) { this.shapes.forEach((s) => drawShape(o, s)); if (this.cur) drawShape(o, this.cur); },
};

// --- Progress bar ---
function drawProgress(o, t, frac) {
  const y = t.pos === 'top' ? 0 : S.h - t.size;
  if (t.bg) { o.fillStyle = t.bgColor; o.fillRect(0, y, S.w, t.size); }
  o.fillStyle = t.color; o.fillRect(0, y, S.w * frac, t.size);
}
panels.progressbar = {
  title: 'Progress bar',
  html: () => `
    <p class="hint">Adds a bar that fills up as the animation plays. Add it after you are done changing frame timing.</p>
    ${field('Position', '<select data-k="pos"><option value="bottom">Bottom</option><option value="top">Top</option></select>')}
    ${field('Thickness', `<input type="number" data-k="size" min="1" max="200" value="${Math.max(3, Math.round(S.h / 60))}">`)}
    ${field('Color', '<input type="color" data-k="color" value="#f0743a">')}
    ${field('Background', '<input type="checkbox" data-k="bg" checked><input type="color" data-k="bgColor" value="#333333">')}
    <div class="actions"><button data-close>Cancel</button><button class="primary" id="pApply">Add bar</button></div>`,
  init() {
    $('#pApply').onclick = () => {
      const t = this.opts(); const ends = this.ends();
      closePanel();
      applyPixels('Adding progress bar', played(), S.w, S.h, (x, img, f) => { x.drawImage(img, 0, 0, S.w, S.h); drawProgress(x, t, ends.get(f.id)); }, true);
    };
  },
  ends() { const total = totalMs(); let acc = 0; return new Map(played().map((f) => [f.id, (acc += f.skip ? 0 : f.delay) / total])); },
  opts() { return { pos: val('pos'), size: val('size'), color: val('color'), bg: val('bg'), bgColor: val('bgColor') }; },
  overlay(o) { const f = S.frames[S.cur]; if (f) drawProgress(o, this.opts(), this.ends().get(f.id) ?? 0); },
};

// --- Theme ---
// Four colors drive the whole look; the in-between shades are mixed from them.
const THEMES = {
  Dark: { bg: '#16181d', text: '#e6e8ee', line: '#333845', accent: '#f0743a' },
  Light: { bg: '#f3f4f7', text: '#1d2027', line: '#c9cdd6', accent: '#e8692f' },
  Midnight: { bg: '#0e1524', text: '#dbe5f5', line: '#2a3a57', accent: '#3d8ef0' },
  Forest: { bg: '#121914', text: '#e0ebe2', line: '#2d3e32', accent: '#4fb06f' },
  Graphite: { bg: '#1b1b1d', text: '#eeeeee', line: '#3d3d42', accent: '#b9bec8' },
  Plum: { bg: '#1a1420', text: '#efe6f5', line: '#3d2f4a', accent: '#c25bd6' },
};
const hexRgb = (h) => { h = h.replace('#', ''); return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)); };
const rgbHex = (c) => '#' + c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const x = hexRgb(a), y = hexRgb(b); return rgbHex(x.map((v, k) => v + (y[k] - v) * t)); };
const lum = (h) => { const [r, g, b] = hexRgb(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
let theme = { ...THEMES.Dark };
function applyTheme(t) {
  theme = { ...THEMES.Dark, ...t };
  const st = document.documentElement.style, { bg, text, line, accent } = theme;
  const light = lum(bg) > 0.5;
  st.setProperty('--bg', bg);
  st.setProperty('--bg2', mix(bg, text, light ? 0.04 : 0.05));
  st.setProperty('--bg3', mix(bg, text, light ? 0.09 : 0.11));
  st.setProperty('--text', text);
  st.setProperty('--muted', mix(text, bg, 0.38));
  st.setProperty('--line', line);
  st.setProperty('--accent', accent);
  st.setProperty('--accent2', mix(accent, light ? '#000000' : '#ffffff', 0.18));
  st.colorScheme = light ? 'light' : 'dark';
  try { localStorage.setItem('loopsmith-theme', JSON.stringify(theme)); } catch {}
}
try { const saved = JSON.parse(localStorage.getItem('loopsmith-theme') || 'null'); if (saved) applyTheme(saved); } catch {}

panels.theme = {
  title: 'Theme',
  html: () => `
    <p class="hint">Pick a preset or set the four colors yourself. Your choice is remembered.</p>
    <div class="swatches">${Object.entries(THEMES).map(([n, t]) => `<button data-theme="${n}"><span class="chips">${[t.bg, t.text, t.line, t.accent].map((c) => `<i style="background:${c}"></i>`).join('')}</span>${n}</button>`).join('')}</div>
    <h3>Colors</h3>
    ${field('Backdrop', '<input type="color" data-k="bg">')}
    ${field('Text', '<input type="color" data-k="text">')}
    ${field('Outlines', '<input type="color" data-k="line">')}
    ${field('Highlighted buttons', '<input type="color" data-k="accent">')}
    <div class="actions"><button id="thReset">Reset</button><button data-close>Close</button></div>`,
  init(el) {
    this.sync();
    $$('[data-theme]', el).forEach((b) => (b.onclick = () => { applyTheme(THEMES[b.dataset.theme]); this.sync(); }));
    $('#thReset').onclick = () => { applyTheme(THEMES.Dark); this.sync(); };
  },
  sync() { for (const k of ['bg', 'text', 'line', 'accent']) $(`#panel [data-k="${k}"]`).value = theme[k]; },
  onInput() { applyTheme({ bg: val('bg'), text: val('text'), line: val('line'), accent: val('accent') }); },
};

// --- Export ---
panels.export = {
  title: 'Export',
  html: () => `
    ${field('Format', `<select data-k="format">
      <option value="gif">GIF</option><option value="webp">WebP (animated)</option><option value="webm">WebM (video)</option><option value="apng">Animated PNG</option><option value="mp4">MP4 (video)</option></select>`)}
    <div data-for="gif">
      ${field('Colors', '<select data-k="colors"><option>256</option><option>128</option><option>64</option><option>32</option><option>16</option></select>')}
      ${field('Dithering', `<select data-k="dither"><option value="sierra2_4a">Smooth (Sierra)</option><option value="floyd_steinberg">Floyd–Steinberg</option>
        <option value="bayer:bayer_scale=3">Pattern (Bayer)</option><option value="none">None (smallest file)</option></select>`)}
    </div>
    <div data-for="webp">
      ${field('Lossless', '<input type="checkbox" data-k="lossless">')}
    </div>
    <div data-for="webm mp4 webp">
      ${field('Quality', '<input type="range" data-k="quality" min="0" max="100" value="75">')}
    </div>
    <div data-for="gif apng webp">
      ${field('Loop forever', '<input type="checkbox" data-k="loop" checked>')}
    </div>
    <p class="hint" id="eInfo"></p>
    <div class="actions"><button data-close>Close</button><button class="primary" id="eGo">Export…</button></div>
    <div id="eResult"></div>`,
  init(el) {
    this.onInput();
    $('#eGo').onclick = async () => {
      const opts = {
        frames: shown().map((f) => ({ path: f.path, delay: f.delay })),
        format: val('format'), colors: +val('colors'), dither: val('dither'), quality: val('quality'), loop: val('loop') ? 0 : -1,
        lossless: val('lossless'),
      };
      if (opts.format === 'apng' || opts.format === 'webp') opts.loop = val('loop') ? 0 : 1;
      const r = await busy('Exporting', () => api.export(opts));
      if (r) {
        $('#eResult', el).innerHTML = `<div class="result">Saved ${esc(fmtSize(r.size))}<br><span class="muted">${esc(r.path)}</span><br><button id="eShow" style="margin-top:6px">Show in folder</button></div>`;
        $('#eShow').onclick = () => api.showInFolder(r.path);
      }
    };
  },
  onInput() {
    const f = val('format');
    $$('#panel [data-for]').forEach((d) => d.classList.toggle('hidden', !d.dataset.for.split(' ').includes(f)));
    const n = shown().length, hid = played().length - n;
    $('#eInfo').textContent = `${n} frames${S.yoyo ? ' (forward, then backward)' : ''}, ${S.w}×${S.h}, ${fmtTime(totalMs())}.` +
      (hid ? ` ${hid} hidden frame${hid > 1 ? 's are' : ' is'} left out.` : '') +
      (f === 'gif' ? ' GIF stores delays in 10 ms steps.' : f === 'webp' ? ' Full color and transparency, usually much smaller than GIF.' : '');
    const q = $('#panel [data-k="quality"]'); if (q) q.disabled = f === 'webp' && val('lossless');
  },
};

// ---------- import ----------
// Plain pictures go straight in as frames; anything else (or a picture format that may be animated,
// like WebP) is probed first so videos, GIF, WebM, APNG and animated WebP all open in the import dialog.
const IMG_EXT = /\.(png|jpe?g|bmp)$/i;

function modal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBox').innerHTML = ''; }

async function openFiles(paths) {
  if (!paths || !paths.length) return;
  const imgs = [], vids = [], bad = [];
  for (const p of paths) {
    if (IMG_EXT.test(p)) { imgs.push(p); continue; }
    try {
      const info = await api.probe(p);
      (info.kind === 'image' ? imgs : vids).push({ p, info });
    } catch (e) { bad.push(p.split(/[\\/]/).pop() + ': ' + e.message.split('\n')[0]); }
  }
  const imgPaths = imgs.map((x) => (typeof x === 'string' ? x : x.p)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (vids.length) return importVideoDialog(vids[0].p, {}, vids[0].info);
  if (imgPaths.length) {
    await busy('Importing images', async () => addFrames(await api.importImages(imgPaths), S.frames.length ? 'append' : 'replace'));
  } else if (bad.length) {
    alert('Could not open:\n\n' + bad.join('\n'));
  }
}

/**
 * Animated WebP: FFmpeg 6 can't decode it, but Chromium can. ImageDecoder gives each fully composited
 * frame; durations come from the file itself (info.durations). Same options as the FFmpeg import.
 */
async function importAnimatedWebp(opts, info) {
  if (typeof ImageDecoder === 'undefined') throw new Error('This system cannot decode animated WebP.');
  const data = await api.readFile(opts.file);
  const dec = new ImageDecoder({ data, type: 'image/webp' });
  try {
    await dec.tracks.ready;
    const count = dec.tracks.selectedTrack.frameCount || info.frames;
    const durs = Array.from({ length: count }, (_, i) => (info.durations && info.durations[i]) || 100);
    const starts = []; let t = 0;
    for (const d of durs) { starts.push(t); t += d; }
    const total = t;
    const from = Math.max(0, (opts.start || 0) * 1000);
    const to = opts.end > 0 && opts.end * 1000 > from ? Math.min(total, opts.end * 1000) : total;
    // which source frame to show, and for how long
    const plan = [];
    if (opts.mode === 'fps') {
      const step = 1000 / (opts.fps || 15);
      let k = 0;
      for (let x = from; x < to - 0.001; x = from + ++k * step) {
        let i = starts.length - 1; while (i > 0 && starts[i] > x) i--;
        plan.push({ i, delay: Math.round(Math.min(step, to - x)) });
      }
    } else {
      for (let i = 0; i < count; i++) {
        const a = Math.max(starts[i], from), b = Math.min(starts[i] + durs[i], to);
        if (b > a) plan.push({ i, delay: Math.round(b - a) });
      }
    }
    const W = info.width, H = info.height;
    const k = opts.maxWidth && W > opts.maxWidth ? opts.maxWidth / W : 1;
    const outW = Math.max(1, Math.round(W * k)), outH = Math.max(1, k === 1 ? H : Math.round((H * k) / 2) * 2);
    const c = new OffscreenCanvas(outW, outH);
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    const saved = new Map(); // a source frame sampled more than once is stored once
    const frames = [];
    for (let n = 0; n < plan.length; n++) {
      const { i, delay } = plan[n];
      if (!saved.has(i)) {
        const { image } = await dec.decode({ frameIndex: i, completeFramesOnly: true });
        x.clearRect(0, 0, outW, outH);
        x.drawImage(image, 0, 0, outW, outH);
        image.close();
        const blob = await c.convertToBlob({ type: 'image/png' });
        saved.set(i, await api.saveFrame(new Uint8Array(await blob.arrayBuffer())));
      }
      frames.push({ path: saved.get(i), delay: Math.max(10, delay) });
      showProgress('Importing', (n + 1) / plan.length);
    }
    return frames;
  } finally { dec.close(); }
}

const importAny = (opts, info) => (info.codec === 'webp-anim' ? importAnimatedWebp(opts, info) : api.importVideo(opts));

async function importVideoDialog(file, preset = {}, info = null) {
  if (!info) { try { info = await api.probe(file); } catch (e) { alert('Could not read this file:\n\n' + e.message); return; } }
  const animated = (['gif', 'apng', 'webp-anim'].includes(info.codec) || /\.(gif|apng|webm|webp)$/i.test(file)) && !preset.fps;
  const name = file.split(/[\\/]/).pop();
  modal(`
    <h2>Import ${esc(name)}</h2>
    <p class="muted">${info.width}×${info.height} · ${info.duration ? info.duration.toFixed(2) + 's' : 'unknown length'}${info.fps ? ' · ' + info.fps.toFixed(1) + ' fps' : ''}</p>
    <div class="field"><span>Frames</span>
      <label><input type="radio" name="mode" value="all" ${animated ? 'checked' : ''}> Keep every frame and its timing</label></div>
    <div class="field"><span></span>
      <label><input type="radio" name="mode" value="fps" ${animated ? '' : 'checked'}> Sample at <input type="number" id="iFps" min="1" max="60" value="${preset.fps || 15}"> frames per second</label></div>
    <div class="field"><span>Max width</span><input type="number" id="iMaxW" min="0" value="${preset.maxWidth ?? (info.width > 960 && !animated ? 800 : 0)}"> <span class="muted">px (0 = original size)</span></div>
    <div class="field"><span>Start at</span><input type="number" id="iStart" min="0" step="0.1" value="0"> <span class="muted">seconds</span></div>
    <div class="field"><span>End at</span><input type="number" id="iEnd" min="0" step="0.1" value="0"> <span class="muted">seconds (0 = to the end)</span></div>
    ${S.frames.length ? `<div class="field"><span>Current frames</span><select id="iWhere"><option value="replace">Replace them</option><option value="append">Add after them</option></select></div>` : ''}
    <p class="muted" id="iEst"></p>
    <div class="actions"><button id="iCancel">Cancel</button><button class="primary" id="iGo">Import</button></div>`);
  const est = () => {
    const fps = $('#iFps').value, s = +$('#iStart').value, e = +$('#iEnd').value || info.duration;
    const mode = $('input[name=mode]:checked').value;
    const n = mode === 'fps' ? Math.ceil((e - s) * fps) : Math.ceil((e - s) * (info.fps || 10));
    $('#iEst').textContent = info.duration && n > 0 ? `About ${n} frames.` + (n > 1500 ? ' That is a lot; consider a lower frame rate or a shorter range.' : '') : '';
  };
  $('#modalBox').oninput = est; est();
  $('#iCancel').onclick = closeModal;
  $('#iGo').onclick = async () => {
    const opts = {
      file, mode: $('input[name=mode]:checked').value, fps: +$('#iFps').value || 15,
      maxWidth: +$('#iMaxW').value || 0, start: +$('#iStart').value || 0, end: +$('#iEnd').value || 0,
    };
    const where = $('#iWhere') ? $('#iWhere').value : 'replace';
    closeModal();
    await busy('Importing', async () => addFrames(await importAny(opts, info), where));
  };
}

/** Add imported frames ({path, delay}) to the project; fits them to the project size when appending. */
async function addFrames(list, where) {
  if (!list.length) { alert('No frames were found in that file.'); return; }
  let frames = list.map((f) => newFrame(f.path, f.delay));
  const first = await loadImg(frames[0].path);
  const appending = where === 'append' && S.w > 0;
  const targetW = appending ? S.w : first.naturalWidth;
  const targetH = appending ? S.h : first.naturalHeight;
  // normalize any frame that has a different size (letterbox to fit)
  const sizes = await Promise.all(frames.map((f) => loadImg(f.path)));
  const odd = frames.map((_, i) => i).filter((i) => sizes[i].naturalWidth !== targetW || sizes[i].naturalHeight !== targetH);
  if (odd.length) {
    const oddFrames = odd.map((i) => frames[i]);
    const paths = await mapFrames(oddFrames, targetW, targetH, (x, img) => {
      const k = Math.min(targetW / img.naturalWidth, targetH / img.naturalHeight);
      const w = img.naturalWidth * k, h = img.naturalHeight * k;
      x.drawImage(img, (targetW - w) / 2, (targetH - h) / 2, w, h);
    }, 'Fitting frames', true);
    frames = frames.map((f) => (paths.has(f.id) ? { ...f, path: paths.get(f.id) } : f));
  }
  commit();
  if (appending) {
    // new frames go at the end of the strip being edited
    S.cur = S.frames.length;
    S.frames = S.frames.concat(frames);
  } else {
    Object.assign(S, { fwd: frames, back: [], yoyo: false, track: 'fwd', curT: { fwd: 0, back: 0 }, w: targetW, h: targetH });
  }
  S.sel.clear();
  refresh(); scrollToCurrent();
}

$('#btnOpen').onclick = $('#emptyOpen').onclick = async () => openFiles(await api.openMedia());

// drag & drop files from the OS
document.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); document.body.classList.add('drag'); } });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drag'); });
document.addEventListener('drop', (e) => {
  document.body.classList.remove('drag');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  openFiles([...e.dataTransfer.files].map((f) => api.pathForFile(f)));
});

// ---------- recording ----------
const REC = { stream: null, recorder: null, chunks: [], t0: 0, paused: 0, pauseStart: 0, timer: null, fps: 15 };

async function recordDialog() {
  stopPlay();
  let sources = [];
  try { sources = await api.screenSources(); } catch (e) { console.warn(e); }
  modal(`
    <h2>Record</h2>
    <p class="muted">Choose what to record. You can crop and trim afterwards.</p>
    <div class="sources">
      ${sources.map((s) => `<div class="source" data-id="${esc(s.id)}">${s.thumb ? `<img src="${s.thumb}">` : '<div style="aspect-ratio:16/9;display:grid;place-items:center;font-size:32px;background:#000;border-radius:4px">🖥</div>'}<div class="nm">${esc(s.name)}</div></div>`).join('')}
      <div class="source" data-id="webcam"><div style="aspect-ratio:16/9;display:grid;place-items:center;font-size:32px;background:#000;border-radius:4px">📷</div><div class="nm">Webcam</div></div>
    </div>
    <div class="field"><span>Frames per second</span><select id="rFps"><option>5</option><option>10</option><option selected>15</option><option>20</option><option>30</option></select></div>
    <div class="field"><span>Record audio</span><span class="muted">No (GIFs have no sound)</span></div>
    <div class="actions"><button id="rCancel">Cancel</button><button class="primary" id="rGo" disabled>Start recording</button></div>`);
  let chosen = null;
  $$('.source').forEach((el) => (el.onclick = () => { $$('.source').forEach((x) => x.classList.remove('sel')); el.classList.add('sel'); chosen = el.dataset.id; $('#rGo').disabled = false; }));
  $('#rCancel').onclick = closeModal;
  $('#rGo').onclick = () => startRecording(chosen, +$('#rFps').value);
}

async function startRecording(id, fps) {
  REC.fps = fps;
  if (id === 'portal') {
    // Wayland: the desktop's own dialog picks the screen or window
    closeModal();
    let picked = [];
    try { picked = await api.screenSources(true); } catch (e) { console.warn(e); }
    if (!picked.length) { toast('Recording cancelled'); return; }
    id = picked[0].id;
  }
  try {
    REC.stream = id === 'webcam'
      ? await navigator.mediaDevices.getUserMedia({ video: { frameRate: fps, width: { ideal: 1280 } }, audio: false })
      : await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxFrameRate: fps, minFrameRate: 1 } } });
  } catch (e) { alert('Could not start recording:\n\n' + e.message); return; }
  for (let n = 3; n > 0; n--) { modal(`<div class="countdown">${n}</div><p class="muted" style="text-align:center">Recording starts…</p>`); await new Promise((r) => setTimeout(r, 800)); }
  closeModal();
  document.body.classList.add('recording');
  await api.setRecordingMode(true);
  await new Promise((r) => setTimeout(r, 250));
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  REC.chunks = [];
  REC.recorder = new MediaRecorder(REC.stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  REC.recorder.ondataavailable = (e) => e.data.size && REC.chunks.push(e.data);
  REC.recorder.start(1000);
  REC.t0 = Date.now(); REC.paused = 0;
  $('#recPause').textContent = 'Pause'; $('#recbar').classList.remove('paused');
  REC.timer = setInterval(() => {
    const ms = (REC.recorder.state === 'paused' ? REC.pauseStart : Date.now()) - REC.t0 - REC.paused;
    const s = Math.floor(ms / 1000);
    $('#rectime').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
}

$('#recPause').onclick = () => {
  const r = REC.recorder; if (!r) return;
  if (r.state === 'recording') { r.pause(); REC.pauseStart = Date.now(); $('#recPause').textContent = 'Resume'; $('#recbar').classList.add('paused'); }
  else if (r.state === 'paused') { r.resume(); REC.paused += Date.now() - REC.pauseStart; $('#recPause').textContent = 'Pause'; $('#recbar').classList.remove('paused'); }
};
$('#recStop').onclick = async () => {
  const r = REC.recorder; if (!r) return;
  const done = new Promise((res) => (r.onstop = res));
  r.stop(); await done;
  clearInterval(REC.timer);
  REC.stream.getTracks().forEach((t) => t.stop());
  REC.recorder = null;
  await api.setRecordingMode(false);
  document.body.classList.remove('recording');
  const blob = new Blob(REC.chunks, { type: 'video/webm' });
  const file = await api.saveRecording(new Uint8Array(await blob.arrayBuffer()));
  setTimeout(() => importVideoDialog(file, { fps: REC.fps, maxWidth: 0 }), 300);
};
$('#btnRecord').onclick = $('#emptyRecord').onclick = recordDialog;

// ---------- toolbar + keys ----------
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') { if (!$('#modal').classList.contains('hidden')) closeModal(); else if (S.panel) closePanel(); return; }
  if (typing || S.busy || !$('#modal').classList.contains('hidden')) return;
  const k = e.key.toLowerCase();
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (mod && k === 'o') { e.preventDefault(); $('#btnOpen').click(); }
  else if (!S.fwd.length && !S.back.length) return;
  else if (mod && k === 'a') { e.preventDefault(); S.sel = new Set(S.frames.map((f) => f.id)); refresh(); }
  else if (mod && k === 'd') { e.preventDefault(); actions.duplicate(); }
  else if (!mod && k === 'h') { e.preventDefault(); stopPlay(); toggleSkip(selIdx().map((i) => S.frames[i])); }
  else if (mod && k === 's') { e.preventDefault(); if (S.panel !== 'export') openPanel('export'); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); actions.delete(); }
  else if (e.key === ' ') { e.preventDefault(); S.playing ? stopPlay() : play(); }
  else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); moveSel(-1); }
  else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); moveSel(1); }
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && S.frames.length) {
    e.preventDefault(); stopPlay();
    const i = clamp(S.cur + ((e.key === 'ArrowLeft') !== (S.track === 'back') ? -1 : 1), 0, S.frames.length - 1);
    if (e.shiftKey) { S.sel.add(S.frames[i].id); S.cur = i; renderStrip(); drawCurrent(); scrollToCurrent(); }
    else { selectOnly(i); renderStrip(); drawCurrent(); scrollToCurrent(); }
  }
  else if (e.key === 'Home') { stopPlay(); goTo(0); }
  else if (e.key === 'End') { stopPlay(); goTo(S.frames.length - 1); }
  else if (S.yoyo && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault(); stopPlay();
    const t = e.key === 'ArrowUp' ? 'fwd' : 'back';
    if (t !== S.track && listOf(t).length) { setTrack(t); S.sel.clear(); renderStrip(); drawCurrent(); }
  }

});

// Expose a small hook for automated tests.
if (api.isTest) window.__loopsmith = { S, toggleSkip, shown, advance, applyTheme, THEMES, setYoyo, setSkipEnds, yoyoDiff, played, mirrorBack, jumpDiff, openFiles, importVideoDialog, importAny, addFrames, actions, panels, openPanel, closePanel, applyPixels, removeDuplicates, undo, redo, refresh };

refresh();
