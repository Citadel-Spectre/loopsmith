// Import test for every supported kind of input: common video containers/codecs, GIF, APNG, WebM
// (with alpha), animated WebP (lossy, lossless+alpha, variable timing) and still pictures.
// Builds its own test files with the bundled FFmpeg, then drives the real app. Run: xvfb-run node test/formats.js
const { _electron: electron } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const FF = require('ffmpeg-static');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-formats-'));
const ff = (...a) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
const SRC = ['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=10:d=2'];
const ALPHA = ['-f', 'lavfi', '-i', "testsrc2=s=160x120:r=10:d=2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,80),255,0)'"];
const p = (n) => path.join(dir, n);

// name, ffmpeg args, expected { n: frames when keeping every frame, w, h, alpha: left opaque + right clear, total ms }
const cases = [
  ['h264.mp4', [...SRC, '-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
  ['hevc.mkv', [...SRC, '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error']],
  ['av1.mkv', [...SRC, '-c:v', 'libaom-av1', '-cpu-used', '8']],
  ['prores.mov', [...SRC, '-c:v', 'prores']],
  ['mpeg4.avi', [...SRC, '-c:v', 'mpeg4']],
  ['wmv2.wmv', [...SRC, '-c:v', 'wmv2']],
  ['flv.flv', [...SRC, '-c:v', 'flv']],
  ['mpeg2.mpg', [...SRC, '-c:v', 'mpeg2video']],
  ['theora.ogv', [...SRC, '-c:v', 'libtheora']],
  ['h264.ts', [...SRC, '-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
  ['vp8.webm', [...SRC, '-c:v', 'libvpx']],
  ['vp9.webm', [...SRC, '-c:v', 'libvpx-vp9']],
  ['vp9alpha.webm', [...ALPHA, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p'], { w: 160, h: 120, alpha: true }],
  ['anim.gif', [...SRC]],
  ['anim.apng', [...ALPHA, '-f', 'apng'], { w: 160, h: 120, alpha: true }],
  ['lossy.webp', [...SRC, '-c:v', 'libwebp_anim', '-loop', '0']],
  ['alpha.webp', [...ALPHA, '-c:v', 'libwebp_anim', '-lossless', '1', '-loop', '0'], { w: 160, h: 120, alpha: true }],
  ['UPPER.WEBP', [...SRC, '-c:v', 'libwebp_anim', '-loop', '0']],
  ['no-extension', [...SRC, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mp4']],
];

(async () => {
  for (const [name, args] of cases) ff(...args, p(name));
  for (const [i, c] of ['red', 'green', 'blue'].entries()) ff('-f', 'lavfi', '-i', `color=c=${c}:s=200x100`, '-frames:v', '1', p(`v${i}.png`));
  ff('-f', 'lavfi', '-i', 'testsrc2=s=320x240', '-frames:v', '1', '-c:v', 'libwebp', p('still.webp'));

  const app = await electron.launch({ executablePath: process.env.LOOPSMITH_EXE || require('electron'), args: process.env.LOOPSMITH_EXE ? ['--no-sandbox'] : [path.join(__dirname, '..'), '--no-sandbox'], env: { ...process.env, LOOPSMITH_TEST: '1' } });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.waitForLoadState('domcontentloaded');
  let failed = 0;
  const check = (c, msg) => { console.log((c ? 'ok   - ' : 'FAIL - ') + msg); if (!c) failed++; };

  // Imports a file the way the dialog does; returns frame count, size, total ms and alpha of frame 0.
  const imp = (file, mode, extra = {}) => page.evaluate(async ({ file, mode, extra }) => {
    const L = window.__loopsmith;
    const info = await api.probe(file);
    const frames = await L.importAny({ file, mode, fps: 10, maxWidth: 0, start: 0, end: 0, ...extra }, info);
    await L.addFrames(frames, 'replace');
    const img = new Image(); img.src = 'file://' + L.S.frames[0].path; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const a = (px, py) => x.getImageData(px, py, 1, 1).data[3];
    return { kind: info.kind, codec: info.codec, n: L.S.frames.length, w: L.S.w, h: L.S.h,
      total: L.S.frames.reduce((s, f) => s + f.delay, 0), delays: L.S.frames.map((f) => f.delay),
      aL: a(10, Math.floor(img.height / 2)), aR: a(img.width - 10, Math.floor(img.height / 2)) };
  }, { file, mode, extra });

  for (const [name, , exp = {}] of cases) {
    const w = exp.w || 320, h = exp.h || 240;
    try {
      const all = await imp(p(name), 'all');
      check(all.kind === 'animation' && all.n === 20 && all.w === w && all.h === h && Math.abs(all.total - 2000) <= 100,
        `${name} (${all.codec}) every frame: ${all.n} frames ${all.w}x${all.h} ${all.total}ms`);
      if (exp.alpha) check(all.aL === 255 && all.aR === 0, `${name} keeps transparency (alpha ${all.aL}/${all.aR})`);
      const s = await imp(p(name), 'fps', { fps: 5 });
      check(s.n === 10 && Math.abs(s.total - 2000) <= 100, `${name} sampled at 5 fps: ${s.n} frames ${s.total}ms`);
    } catch (e) { check(false, `${name}: ${e.message.split('\n')[0]}`); }
  }

  // animated WebP specifics: per-frame timing (file written by Loopsmith's own WebP export)
  await page.evaluate((o) => api.exportTo({ frames: [0, 1, 2].map((i) => ({ path: o.dir + `/v${i}.png`, delay: [100, 300, 600][i] })), format: 'webp', lossless: true, loop: 0, out: o.dir + '/vartime.webp' }), { dir });
  const v = await imp(p('vartime.webp'), 'all');
  check(v.n === 3 && v.delays.join() === '100,300,600', `vartime.webp keeps per-frame timing: ${v.delays.join()}`);
  const r = await imp(p('lossy.webp'), 'all', { start: 0.5, end: 1.5, maxWidth: 160 });
  check(r.n === 10 && r.w === 160 && r.h === 120, `lossy.webp range 0.5-1.5s at max width 160: ${r.n} frames ${r.w}x${r.h}`);

  // the real Open path: an animated WebP opens the import dialog with "keep every frame" picked
  await page.evaluate((f) => { window.__loopsmith.openFiles([f]); }, p('lossy.webp'));
  await page.waitForSelector('#iGo');
  const keep = await page.evaluate(() => document.querySelector('input[name=mode]:checked').value);
  await page.screenshot({ path: path.join(dir, 'dialog.png') });
  await page.click('#iGo');
  await page.waitForFunction(() => window.__loopsmith.S.frames.length === 20 && !window.__loopsmith.S.busy);
  check(keep === 'all', 'Open on animated WebP shows the import dialog and imports all 20 frames');

  // still WebP goes in as one picture, through the same path as dropping/opening files
  const st = await page.evaluate(async (f) => { const L = window.__loopsmith; L.S.fwd = []; await L.openFiles([f]); return { n: L.S.frames.length, w: L.S.w, p: L.S.frames[0] && L.S.frames[0].path }; }, p('still.webp'));
  check(st.n === 1 && st.w === 320 && /\.png$/.test(st.p), `still.webp opens as one picture (${st.n} frame, stored as PNG)`);

  // round trip: import an animated WebP, export it as GIF and WebP, re-import both
  await imp(p('alpha.webp'), 'all');
  for (const fmt of ['gif', 'webp', 'webm']) {
    const out = p('rt.' + fmt);
    await page.evaluate((o) => api.exportTo({ frames: window.__loopsmith.S.frames.map((f) => ({ path: f.path, delay: f.delay })), format: o.fmt, colors: 256, dither: 'sierra2_4a', quality: 80, loop: 0, out: o.out }), { fmt, out });
    const back = await imp(out, 'all');
    check(back.n === 20 && back.w === 160 && Math.abs(back.total - 2000) <= 100, `animated WebP -> ${fmt} -> import: ${back.n} frames ${back.total}ms`);
  }

  // a file that is not media gives a clear error instead of a broken import
  fs.writeFileSync(p('notes.txt'), 'hello');
  const bad = await page.evaluate((f) => api.probe(f).then(() => 'opened', (e) => e.message), p('notes.txt'));
  check(/not a video|No video/.test(bad), 'text file is refused with a clear message');

  await page.screenshot({ path: path.join(dir, 'formats.png') });
  check(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await app.close();
  console.log(failed ? `${failed} FAILED` : 'all passed', '· files in', dir);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
