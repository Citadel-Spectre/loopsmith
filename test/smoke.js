// End-to-end smoke test: drives the real app through Playwright's Electron support.
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-test-'));
  const app = await electron.launch({ executablePath: process.env.LOOPSMITH_EXE || require('electron'), args: process.env.LOOPSMITH_EXE ? ['--no-sandbox'] : [path.join(__dirname, '..'), '--no-sandbox'], env: { ...process.env, LOOPSMITH_TEST: '1' } });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize?.({ width: 1280, height: 800 });
  const sample = path.join(__dirname, 'sample.mp4');
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const state = () => ev(() => ({ n: __loopsmith.played().length, w: __loopsmith.S.w, h: __loopsmith.S.h, total: __loopsmith.played().reduce((a, f) => a + f.delay, 0) }));
  const check = (c, msg) => { if (!c) { throw new Error('FAIL: ' + msg); } console.log('ok -', msg); };

  await page.screenshot({ path: path.join(out, '0-empty.png') });
  await ev(async (f) => __loopsmith.addFrames(await api.importVideo({ file: f, mode: 'fps', fps: 10, maxWidth: 480, start: 0, end: 0 }), 'replace'), sample);
  let s = await state();
  check(s.n === 30 && s.w === 480 && s.h === 270, `import video -> ${s.n} frames ${s.w}x${s.h}`);

  await ev(() => { const L = __loopsmith; L.S.sel = new Set([L.S.frames[0].id, L.S.frames[1].id]); L.actions.delete(); });
  check((await state()).n === 28, 'delete 2 frames');
  await ev(() => __loopsmith.undo());
  check((await state()).n === 30, 'undo');
  await ev(() => __loopsmith.redo());
  check((await state()).n === 28, 'redo');
  await ev(() => { const L = __loopsmith; L.S.sel = new Set([L.S.frames[0].id]); L.actions.duplicate(); });
  check((await state()).n === 29, 'duplicate');
  // x2 button: with frames 3 and 6 selected, each copy lands right after its original
  const dup = await ev(() => {
    const L = __loopsmith, a = L.S.frames[3], b = L.S.frames[6];
    L.S.sel = new Set([a.id, b.id]); document.querySelector('#btnDup').click();
    const F = L.S.frames; const r = [F[3].id === a.id, F[4].path === a.path && F[4].id !== a.id, F[7].id === b.id, F[8].path === b.path && F[8].id !== b.id];
    L.undo(); return r.every(Boolean);
  });
  check(dup, 'x2 places each copy right after its original');

  // crop via panel
  await ev(() => __loopsmith.openPanel('crop'));
  await page.waitForTimeout(100);
  const cr0 = await ev(() => ({ ...__loopsmith.panels.crop.norm() }));
  check(cr0.x === 0 && cr0.y === 0 && cr0.w === 480 && cr0.h === 270, 'crop box starts at the full picture');
  // drag the top-left corner in by (40, 20), then the right edge in, then move the box with the mouse
  const ob = await page.locator('#overlay').boundingBox();
  const sc = await ev(() => __loopsmith.S.scale);
  const at = (x, y) => [ob.x + x * sc, ob.y + y * sc];
  const dragPts = async (a, b) => { await page.mouse.move(...at(...a)); await page.mouse.down(); await page.mouse.move(...at(...b), { steps: 5 }); await page.mouse.up(); };
  await dragPts([2, 2], [42, 22]);
  await dragPts([478, 150], [398, 150]);
  let cr = await ev(() => ({ ...__loopsmith.panels.crop.norm() }));
  check(Math.abs(cr.x - 40) <= 1 && Math.abs(cr.y - 20) <= 1 && Math.abs(cr.w - 360) <= 2 && Math.abs(cr.h - 250) <= 1, `crop edges pulled in: ${JSON.stringify(cr)}`);
  await dragPts([200, 150], [190, 140]);
  cr = await ev(() => ({ ...__loopsmith.panels.crop.norm() }));
  check(Math.abs(cr.x - 30) <= 1 && Math.abs(cr.y - 10) <= 1 && Math.abs(cr.w - 360) <= 2, `crop box moved: ${JSON.stringify(cr)}`);
  await page.screenshot({ path: path.join(out, '0b-crop.png') });
  await ev(() => { __loopsmith.panels.crop.r = { x: 40, y: 20, w: 320, h: 200 }; });
  await page.click('#cApply'); await page.waitForFunction(() => !__loopsmith.S.busy && __loopsmith.S.w === 320);
  s = await state(); check(s.w === 320 && s.h === 200, 'crop to 320x200');

  await ev(() => __loopsmith.openPanel('resize'));
  await page.fill('#panel [data-k="w"]', '160'); await page.dispatchEvent('#panel [data-k="w"]', 'input');
  await page.click('#rApply'); await page.waitForFunction(() => !__loopsmith.S.busy && __loopsmith.S.w === 160);
  s = await state(); check(s.w === 160 && s.h === 100, 'resize to 160x100');
  await ev(() => __loopsmith.undo());
  check((await state()).w === 320, 'undo resize');

  await ev(() => __loopsmith.openPanel('text'));
  await page.screenshot({ path: path.join(out, '1-text-panel.png') });
  await page.click('#xApply'); await page.waitForFunction(() => !__loopsmith.S.busy);

  await ev(() => { const L = __loopsmith; L.openPanel('draw'); L.panels.draw.shapes = [{ tool: 'arrow', color: '#ff0000', width: 4, pts: [{ x: 20, y: 20 }, { x: 150, y: 100 }] }]; });
  await page.click('#dApply'); await page.waitForFunction(() => !__loopsmith.S.busy);

  await ev(() => __loopsmith.openPanel('progressbar'));
  await page.click('#pApply'); await page.waitForFunction(() => !__loopsmith.S.busy);

  await ev(() => __loopsmith.openPanel('rotate'));
  await page.click('[data-rot="90"]'); await page.waitForFunction(() => !__loopsmith.S.busy && __loopsmith.S.w === 200);
  check((await state()).h === 320, 'rotate 90');
  await ev(() => __loopsmith.undo());

  // duplicates: append 5 copies of one frame
  await ev(() => { const L = __loopsmith; const f = L.S.frames[5]; L.S.sel = new Set([f.id]); for (let i = 0; i < 5; i++) L.actions.duplicate(); });
  const before = await state();
  await ev(() => __loopsmith.removeDuplicates(99.5));
  const after = await state();
  check(after.n === before.n - 6 && after.total === before.total, `remove duplicates ${before.n} -> ${after.n}, time kept`);

  await ev(() => { const L = __loopsmith; L.openPanel('timing'); });
  await page.selectOption('#panel [data-k="scope"]', 'all');
  await page.fill('#panel [data-k="speed"]', '50'); await page.click('#tSpeed');
  check((await state()).total === after.total * 2, 'speed 50% doubles length');

  // yoyo: a second, separately editable backward strip
  await ev(() => { __loopsmith.openPanel('reorder'); });
  await page.click('#qYoyo');
  let y = await ev(() => { const L = __loopsmith; return { yoyo: L.S.yoyo, f: L.S.fwd.length, b: L.S.back.length, played: L.played().length, diffs: L.yoyoDiff().list.length }; });
  check(y.yoyo && y.f === after.n && y.b === after.n - 2 && y.played === after.n * 2 - 2 && y.diffs === 0, `yoyo on: ${y.f} forward + ${y.b} backward, no differences`);
  check(await page.isVisible('.lane[data-track="back"] .thumb'), 'backward strip is shown');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, '2a-yoyo.png') });
  // play through: the backward strip becomes active after the forward pass
  await ev(() => { const L = __loopsmith; L.S.fwd.forEach((f) => (f.delay = 20)); L.S.back.forEach((f) => (f.delay = 20)); L.refresh(); });
  await page.click('#btnPlay');
  await page.waitForFunction(() => __loopsmith.S.track === 'back', null, { timeout: 5000 });
  check(await page.isVisible('.lane.active[data-track="back"]'), 'playback moves onto the backward strip and highlights it');
  await page.waitForFunction(() => __loopsmith.S.track === 'fwd', null, { timeout: 5000 });
  await page.click('#btnPlay');
  check(true, 'playback loops back to the forward strip');
  // the current frame sits in the center box
  const centered = await ev(() => {
    const strip = document.querySelector('.lane.active .strip'), cur = strip.querySelector('.thumb.cur'), box = strip.parentElement.querySelector('.playbox');
    return new Promise((r) => setTimeout(() => { const a = cur.getBoundingClientRect(), b = box.getBoundingClientRect(); r(Math.abs((a.left + a.width / 2) - (b.left + b.width / 2))); }, 500));
  });
  check(centered < 3, `current frame centered in the box (off by ${centered.toFixed(1)}px)`);
  // tandem: for every step, the frame in the other strip's box is the current frame's duplicate
  const tandem = await ev(() => {
    const L = __loopsmith, bad = [];
    const boxCenter = (t) => { const b = document.querySelector(`.lane[data-track="${t}"] .playbox`).getBoundingClientRect(); return b.left + b.width / 2; };
    const inBox = (t) => { const c = boxCenter(t); const el = [...document.querySelectorAll(`.lane[data-track="${t}"] .thumb`)].find((el) => { const r = el.getBoundingClientRect(); return r.left < c && r.right > c; }); return el ? +el.dataset.i : -1; };
    const steps = [['fwd', 0], ['fwd', 1], ['fwd', 5], ['fwd', L.S.fwd.length - 2], ['fwd', L.S.fwd.length - 1], ['back', 0], ['back', 7], ['back', L.S.back.length - 1]];
    for (const [t, i] of steps) {
      L.S.track = t; L.S.curT[t] = i; L.refresh();
      const o = t === 'fwd' ? 'back' : 'fwd', n = L.S.fwd.length;
      const want = n - 2 - i; // mirror index; -1 or past the end means an empty slot
      const got = inBox(o);
      const exp = want >= 0 && want < (o === 'fwd' ? n : L.S.back.length) ? want : -1;
      if (got !== exp || inBox(t) !== i) bad.push(`${t}${i}: other box shows ${got}, want ${exp}`);
    }
    return bad;
  });
  const dirs = await ev(() => {
    const L = __loopsmith, sl = () => document.querySelector('.lane[data-track="fwd"] .strip').scrollLeft;
    L.S.track = 'fwd'; L.S.curT.fwd = 5; L.refresh(); const a = sl(); L.S.curT.fwd = 6; L.refresh(); const b = sl();
    L.S.track = 'back'; L.S.curT.back = 5; L.refresh(); const c = sl(); L.S.curT.back = 6; L.refresh(); const d = sl();
    return { fwd: b - a, back: d - c };
  });
  check(dirs.fwd > 0 && dirs.back < 0, `rows scroll one way going forward and the other way going backward (${dirs.fwd}, ${dirs.back})`);
  check(tandem.length === 0, 'strips move in tandem, duplicate lined up in the box ' + tandem.join('; '));
  // backward frames are numbered as minus their sister frame, column by column
  const lab = await ev(() => {
    const f = [...document.querySelectorAll('.lane[data-track="fwd"] .slot')], b = [...document.querySelectorAll('.lane[data-track="back"] .slot')];
    const bad = [];
    b.forEach((el, c) => { if (el.dataset.i == null) return; const top = f[c].querySelector('.meta span').textContent, me = el.querySelector('.meta span').textContent; if (me !== '-' + top) bad.push(`${top}/${me}`); });
    return { bad, n: b.length === f.length };
  });
  check(lab.n && lab.bad.length === 0, 'backward frames are named -N under frame N ' + lab.bad.join(' '));
  // one shared scrollbar: scrolling the bottom row moves the top row with it
  const sh = await ev(() => new Promise((r) => {
    const fs = document.querySelector('.lane[data-track="fwd"] .strip'), bs = document.querySelector('.lane[data-track="back"] .strip');
    bs._auto = 0; bs.scrollLeft = bs.scrollLeft + 300;
    setTimeout(() => r({ same: Math.abs(fs.scrollLeft - bs.scrollLeft) < 1, fwdBar: getComputedStyle(fs).scrollbarWidth }), 100);
  }));
  check(sh.same && sh.fwdBar === 'none', 'rows share the bottom scrollbar and scroll together ' + JSON.stringify(sh));
  // only one outline on the current frame: the center box itself draws none
  const pb = await ev(() => getComputedStyle(document.querySelector('.lane.active .playbox')).borderTopColor);
  check(pb === 'rgba(0, 0, 0, 0)', 'center box has no outline of its own');
  // theme panel: a preset and a custom color change the app colors
  await page.click('[data-panel="theme"]');
  await page.click('[data-theme="Light"]');
  let th = await ev(() => ({ bg: getComputedStyle(document.body).backgroundColor, acc: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() }));
  check(th.bg === 'rgb(243, 244, 247)', 'Light theme preset applies ' + JSON.stringify(th));
  await page.screenshot({ path: path.join(out, '2c-theme-light.png') });
  await page.fill('#panel [data-k="accent"]', '#2266ee');
  th = await ev(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  check(th === '#2266ee', 'custom highlight color applies');
  await page.click('#thReset'); await ev(() => __loopsmith.closePanel());
  await page.waitForTimeout(300);
  // "Skip ends" off: the backward pass also repeats the first and last frame, still a clean mirror
  const se = await ev(() => {
    const L = __loopsmith; L.setSkipEnds(false);
    const off = { b: L.S.back.length, d: L.yoyoDiff().list.length, gaps: document.querySelectorAll('.gap').length };
    L.setSkipEnds(true);
    const on = { b: L.S.back.length, d: L.yoyoDiff().list.length, ends: document.querySelectorAll('.lane[data-track="back"] .gap.endskip').length };
    return { off, on, n: L.S.fwd.length };
  });
  check(se.off.b === se.n && se.off.d === 0 && se.off.gaps === 0 && se.on.b === se.n - 2 && se.on.d === 0 && se.on.ends === 2,
    `skip ends toggle: off ${se.off.b} backward frames, on ${se.on.b} with ${se.on.ends} end skip slots`);
  // edit only the backward strip and check the differences are flagged
  await ev(() => { const L = __loopsmith; L.S.track = 'back'; L.S.sel = new Set([L.S.back[2].id]); L.actions.delete(); L.S.sel = new Set([L.S.back[4].id]); L.openPanel('timing'); });
  await page.fill('#panel [data-k="delay"]', '500'); await page.click('#tSet');
  y = await ev(() => { const L = __loopsmith; const d = L.yoyoDiff(); return { kinds: d.list.map((x) => x.kind).sort().join(','), f: L.S.fwd.length, b: L.S.back.length }; });
  check(y.kinds === 'missing,timing' && y.f === after.n && y.b === after.n - 3, `backward edits flagged: ${y.kinds}`);
  check((await page.locator('.thumb.diff').count()) === 3, 'difference badges shown');
  // the backward row has an empty skip slot where the missing forward frame would be, lined up with it
  const skip = await ev(() => {
    const L = __loopsmith, d = L.yoyoDiff(), miss = d.list.find((x) => x.kind === 'missing');
    L.S.track = 'fwd'; L.S.curT.fwd = L.S.fwd.findIndex((f) => f.id === miss.id); L.refresh();
    const box = document.querySelector('.lane[data-track="back"] .playbox').getBoundingClientRect(), c = box.left + box.width / 2;
    const inBox = [...document.querySelectorAll('.lane[data-track="back"] .slot')].find((el) => { const r = el.getBoundingClientRect(); return r.left < c && r.right > c; });
    return { gaps: document.querySelectorAll('.lane[data-track="back"] .gap:not(.endskip)').length, fwdGaps: document.querySelectorAll('.lane[data-track="fwd"] .gap').length, gapInBox: !!inBox && inBox.classList.contains('gap') };
  });
  check(skip.gaps === 1 && skip.fwdGaps === 0 && skip.gapInBox, 'skip slot shown in the backward row, under the missing frame');
  await ev(() => { __loopsmith.closePanel(); __loopsmith.jumpDiff(1); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, '2b-yoyo-diff.png') });
  await ev(() => __loopsmith.undo()); await ev(() => __loopsmith.undo());
  check((await ev(() => __loopsmith.yoyoDiff().list.length)) === 0, 'undo restores the mirror');
  // a text edit on all frames hits both strips the same way, so they still mirror
  await ev(() => __loopsmith.openPanel('text'));
  await page.click('#xApply'); await page.waitForFunction(() => !__loopsmith.S.busy);
  check((await ev(() => __loopsmith.yoyoDiff().list.length)) === 0, 'edit on all frames keeps the strips mirrored');

  await ev(() => __loopsmith.openPanel('export'));
  await page.screenshot({ path: path.join(out, '2-editor.png') });
  const frames = await ev(() => __loopsmith.played().map((f) => ({ path: f.path, delay: f.delay })));
  check(frames.length === after.n * 2 - 2, 'export uses forward then backward frames');
  for (const fmt of ['gif', 'webp', 'webm', 'apng', 'mp4']) {
    const r = await ev((o) => api.exportTo(o), { frames, format: fmt, colors: 256, dither: 'sierra2_4a', quality: 70, loop: 0, out: path.join(out, 'out.' + fmt) });
    check(r.size > 1000, `export ${fmt} (${r.size} bytes)`);
  }

  // WebP: check per-frame durations straight from the file
  const wb = fs.readFileSync(path.join(out, 'out.webp')); const wd = [];
  for (let p = 12; p + 8 <= wb.length;) { const n = wb.readUInt32LE(p + 4); if (wb.toString('ascii', p, p + 4) === 'ANMF') wd.push(wb[p + 20] | (wb[p + 21] << 8) | (wb[p + 22] << 16)); p += 8 + n + (n & 1); }
  const wTotal = wd.reduce((a, b) => a + b, 0), fTotal = frames.reduce((a, f) => a + f.delay, 0);
  check(wTotal === fTotal && wd[wd.length - 1] === frames[frames.length - 1].delay, `webp timing ${wd.length} frames, ${wTotal}ms vs ${fTotal}ms`);
  const r2 = await ev((o) => api.exportTo(o), { frames, format: 'webp', lossless: true, loop: 1, out: path.join(out, 'lossless.webp') });
  check(r2.size > 1000, `export lossless webp (${r2.size} bytes)`);

  // round trip: import the GIF keeping its timing, and the webm
  const total = (await state()).total;
  await ev(async (f) => __loopsmith.addFrames(await api.importVideo({ file: f, mode: 'all', fps: 15, maxWidth: 0 }), 'replace'), path.join(out, 'out.gif'));
  s = await state();
  check(s.n === frames.length && Math.abs(s.total - total) <= frames.length * 10, `re-import GIF: ${s.n} frames, ${s.total}ms vs ${total}ms`);
  await ev(async (f) => __loopsmith.addFrames(await api.importVideo({ file: f, mode: 'all', fps: 15, maxWidth: 0 }), 'replace'), path.join(out, 'out.webm'));
  s = await state();
  check(s.n === frames.length && Math.abs(s.total - total) <= frames.length * 2, `re-import webm: ${s.n} frames, ${s.total}ms vs ${total}ms`);
  await page.screenshot({ path: path.join(out, '3-reimported.png') });

  check(errors.length === 0, 'no page errors ' + errors.join(' | '));
  console.log('output in', out);
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
