// Loopsmith: main process. Owns the window, the temp workspace and all FFmpeg work.
const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const unpacked = (p) => p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const FFMPEG = unpacked(require('ffmpeg-static'));
const FFPROBE = unpacked(require('ffprobe-static').path);

// Linux: run natively on Wayland when available, and capture the screen through PipeWire
// (the xdg-desktop-portal picker) so recording works on Wayland desktops like KDE Plasma and GNOME.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,WaylandWindowDecorations');
}

let win;
let workDir;
let frameCounter = 0;

function newWorkDir() {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopsmith-'));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#16181d',
    title: 'Loopsmith',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  newWorkDir();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('quit', () => {
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
});

// ---------- helpers ----------

function run(bin, args, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      err += d;
      if (onProgress) onProgress(d.toString());
      if (err.length > 200000) err = err.slice(-100000);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.split('\n').slice(-12).join('\n')));
    });
  });
}

function progress(label, value) {
  if (win && !win.isDestroyed()) win.webContents.send('progress', { label, value });
}

function timeToSec(t) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}

async function probe(file) {
  const out = await run(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name,avg_frame_rate,r_frame_rate:format=duration',
    '-of', 'json', file,
  ]);
  const j = JSON.parse(out);
  const s = (j.streams && j.streams[0]) || {};
  const rate = (r) => { const [a, b] = String(r || '0/1').split('/').map(Number); return b ? a / b : 0; };
  return {
    width: s.width, height: s.height, codec: s.codec_name,
    fps: rate(s.avg_frame_rate) || rate(s.r_frame_rate),
    duration: parseFloat(j.format && j.format.duration) || 0,
  };
}

async function frameDurations(file) {
  // Per-frame durations in ms, from timestamps (works for GIF, APNG and webm with variable timing).
  const out = await run(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'frame=best_effort_timestamp_time,duration_time,pkt_duration_time:format=duration',
    '-of', 'json', file,
  ]);
  const j = JSON.parse(out);
  const fr = j.frames || [];
  const ts = fr.map((f) => parseFloat(f.best_effort_timestamp_time));
  const end = parseFloat(j.format && j.format.duration);
  const d = fr.map((f, i) => {
    let s = i + 1 < ts.length ? ts[i + 1] - ts[i] : NaN;
    if (!(s > 0)) s = parseFloat(f.pkt_duration_time || f.duration_time);
    if (!(s > 0) && i === ts.length - 1 && end > ts[i]) s = end - ts[i];
    return s > 0 ? Math.round(s * 1000) : null;
  });
  return d;
}

function listFrames(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(dir, f));
}

// ---------- IPC ----------

ipcMain.handle('open-media', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'gif', 'apng', 'png', 'jpg', 'jpeg', 'bmp', 'wmv', 'm4v'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths;
});

ipcMain.handle('probe', async (_e, file) => probe(file));

// Import a video / GIF / webm into PNG frames.
// opts: { file, mode: 'fps'|'all', fps, maxWidth, start, end }
ipcMain.handle('import-video', async (_e, opts) => {
  const dir = path.join(workDir, 'imp-' + Date.now());
  fs.mkdirSync(dir);
  const info = await probe(opts.file);
  const filters = [];
  const keepTiming = opts.mode === 'all';
  if (!keepTiming) filters.push(`fps=${opts.fps}`);
  if (opts.maxWidth && info.width > opts.maxWidth) filters.push(`scale=${opts.maxWidth}:-2:flags=lanczos`);
  const args = ['-hide_banner', '-y'];
  if (opts.start > 0) args.push('-ss', String(opts.start));
  // libvpx decoder keeps webm alpha channels intact
  if (info.codec === 'vp9') args.push('-c:v', 'libvpx-vp9');
  else if (info.codec === 'vp8') args.push('-c:v', 'libvpx');
  args.push('-i', opts.file);
  if (opts.end > 0 && opts.end > (opts.start || 0)) args.push('-t', String(opts.end - (opts.start || 0)));
  if (filters.length) args.push('-vf', filters.join(','));
  if (keepTiming) args.push('-fps_mode', 'passthrough');
  args.push('-pix_fmt', 'rgba', path.join(dir, '%06d.png'));

  const total = (opts.end > 0 ? opts.end : info.duration) - (opts.start || 0);
  await run(FFMPEG, args, (s) => {
    const m = /time=(\S+)/.exec(s);
    if (m && total > 0) progress('Importing', Math.min(1, timeToSec(m[1]) / total));
  });
  const files = listFrames(dir);
  let delays;
  if (keepTiming && !(opts.start > 0) && !(opts.end > 0)) {
    delays = await frameDurations(opts.file);
  }
  const fallback = keepTiming ? Math.round(1000 / (info.fps || 10)) : Math.round(1000 / opts.fps);
  progress('', 1);
  let frames = files.map((f, i) => ({ path: f, delay: (delays && delays[i]) || fallback }));
  // a near-zero last frame is the end marker video exports use; drop it
  if (delays && frames.length > 1 && delays.length === frames.length && delays[delays.length - 1] !== null && delays[delays.length - 1] <= 5) frames.pop();
  return frames;
});

ipcMain.handle('import-images', async (_e, files) => {
  return files.map((f) => {
    const dst = path.join(workDir, `img-${Date.now()}-${++frameCounter}${path.extname(f)}`);
    fs.copyFileSync(f, dst);
    return { path: dst, delay: 100 };
  });
});

// Renderer sends edited PNG bytes; we store them as a new immutable frame file.
ipcMain.handle('save-frame', async (_e, bytes) => {
  const p = path.join(workDir, `f-${Date.now()}-${++frameCounter}.png`);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
});

ipcMain.handle('save-recording', async (_e, bytes) => {
  const p = path.join(workDir, `rec-${Date.now()}.webm`);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
});

const isWayland = process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

// On Wayland apps can't list screens themselves; the desktop shows its own picker when we ask for sources.
ipcMain.handle('screen-sources', async (_e, viaPortal) => {
  if (isWayland && !viaPortal) return [{ id: 'portal', name: 'Screen or window…', thumb: null }];
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  return sources.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
});

ipcMain.handle('set-recording-mode', async (_e, on) => {
  if (on) {
    win._restoreBounds = win.getBounds();
    win.setMinimumSize(320, 60);
    win.setBounds({ width: 360, height: 64 });
    win.setAlwaysOnTop(true, 'floating');
    win.setContentProtection(true); // keeps the recording bar out of the capture on Windows and macOS
  } else {
    win.setAlwaysOnTop(false);
    win.setContentProtection(false);
    win.setMinimumSize(900, 600);
    if (win._restoreBounds) win.setBounds(win._restoreBounds);
  }
});

// Export frames. opts: { frames:[{path,delay}], format:'gif'|'webp'|'webm'|'apng'|'mp4', loop, quality, lossless, dither, colors }
ipcMain.handle('export', async (_e, opts) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: `animation.${opts.format}`,
    filters: [{ name: opts.format.toUpperCase(), extensions: [opts.format] }],
  });
  if (r.canceled) return null;
  return doExport(opts, r.filePath);
});

async function doExport(opts, out) {
  const ext = opts.format;

  // ffconcat list with per-frame durations. "option framerate 1000" gives the stream a 1 ms timebase,
  // otherwise image inputs default to 1/25 s and the delays get rounded.
  const list = path.join(workDir, `list-${Date.now()}.txt`);
  const esc = (p) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
  const entry = (p) => `file '${esc(p)}'\noption framerate 1000\n`;
  let txt = 'ffconcat version 1.0\n';
  let total = 0;
  for (const f of opts.frames) {
    txt += entry(f.path) + `duration ${(f.delay / 1000).toFixed(3)}\n`;
    total += f.delay / 1000;
  }
  const last = opts.frames[opts.frames.length - 1];
  // GIF/APNG set the last frame's delay with final_delay; video formats need an end marker frame.
  if (ext === 'webm' || ext === 'mp4') txt += entry(last.path);
  fs.writeFileSync(list, txt);

  const args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list];
  const loop = opts.loop ?? 0; // 0 = forever
  if (ext === 'gif') {
    const colors = opts.colors || 256;
    const dither = opts.dither || 'sierra2_4a';
    args.push(
      '-vf', `split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff:reserve_transparent=1[p];[b][p]paletteuse=dither=${dither}:diff_mode=rectangle:alpha_threshold=128`,
      '-fps_mode', 'vfr', '-loop', String(loop), '-final_delay', String(Math.round(last.delay / 10)), out);
  } else if (ext === 'webm') {
    const crf = Math.round(63 - (opts.quality ?? 70) * 0.5); // quality 0..100 -> crf 63..13
    args.push('-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', String(crf),
      '-deadline', 'good', '-row-mt', '1', '-auto-alt-ref', '0', '-fps_mode', 'vfr', out);
  } else if (ext === 'webp') {
    // libwebp_anim; loop 0 = forever. The encoder guesses the last frame's duration, fixed below.
    args.push('-c:v', 'libwebp_anim', '-lossless', opts.lossless ? '1' : '0', '-q:v', String(opts.lossless ? 75 : (opts.quality ?? 75)),
      '-compression_level', '4', '-loop', String(loop), '-fps_mode', 'vfr', out);
  } else if (ext === 'apng') {
    args.push('-plays', String(loop), '-final_delay', String(last.delay / 1000), '-fps_mode', 'vfr', '-f', 'apng', out);
  } else if (ext === 'mp4') {
    const crf = Math.round(40 - (opts.quality ?? 70) * 0.25);
    args.push('-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(crf),
      '-movflags', '+faststart', '-fps_mode', 'vfr', out);
  }
  await run(FFMPEG, args, (s) => {
    const m = /time=(\S+)/.exec(s);
    if (m && total > 0) progress('Exporting', Math.min(1, timeToSec(m[1]) / total));
  });
  if (ext === 'webp') fixWebpTiming(out, Math.round(total * 1000));
  progress('', 1);
  const size = fs.statSync(out).size;
  return { path: out, size };
}

/**
 * Animated WebP stores each frame's duration in its ANMF chunk. FFmpeg can't know how long the last
 * frame should stay, so set it so the frames add up to the real total (also right if libwebp merged
 * identical frames).
 */
function fixWebpTiming(file, totalMs) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return;
  const frames = [];
  for (let p = 12; p + 8 <= b.length;) {
    const n = b.readUInt32LE(p + 4);
    if (b.toString('ascii', p, p + 4) === 'ANMF') frames.push(p + 8 + 12); // duration: 24-bit LE at offset 12 of the payload
    p += 8 + n + (n & 1);
  }
  if (!frames.length) return;
  const rd = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  const before = frames.slice(0, -1).reduce((a, o) => a + rd(o), 0);
  const last = Math.max(1, Math.min(0xffffff, totalMs - before));
  const o = frames[frames.length - 1];
  b[o] = last & 255; b[o + 1] = (last >> 8) & 255; b[o + 2] = (last >> 16) & 255;
  fs.writeFileSync(file, b);
}

ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));

// Test hook: only active with LOOPSMITH_TEST=1, lets automated checks export without a dialog.
if (process.env.LOOPSMITH_TEST) {
  ipcMain.handle('export-to', (_e, opts) => doExport(opts, opts.out));
}
ipcMain.on('is-test', (e) => { e.returnValue = !!process.env.LOOPSMITH_TEST; });
