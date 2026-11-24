# Loopsmith

A desktop app for making, editing and converting animated GIFs and webm clips.

- **Get frames in:** record your screen, a window or the webcam; open a video (mp4, mov, mkv, avi, webm, wmv, flv, mpg, ts/mts, ogv and more, in codecs such as H.264, HEVC, AV1, VP8/VP9 and ProRes), a GIF, an APNG, an animated WebP or a set of images (png, jpg, bmp, WebP); or drop files onto the window. Files are recognised by their content, so a video without a file extension opens too. Transparency in WebM, APNG and WebP is kept.
- **Edit frame by frame:** select (click, Ctrl+click, Shift+click), delete, duplicate (the x2 button above the strip puts each copy right after its original), drag to reorder, set each frame's delay, change speed, reverse, reduce the frame count, and remove near-identical frames. The frame strip moves under a fixed center box that always holds the current frame; scroll the strip (mouse wheel works) to scrub.
- **Yoyo:** the ⇄ Yoyo button plays forward, then backward. It adds a second strip for the backward pass that you edit on its own; the row that is playing or being edited is highlighted, backward frames are numbered after their sister frame (the one under 5 is -5), both rows share one scrollbar, and the two strips move in tandem and the backward strip is drawn mirrored, so each frame sits directly under its sister frame. The strips scroll one way during the forward pass and the opposite way during the backward pass. Frames where the two passes no longer mirror each other get a badge (+ only in backward, − missing from backward, ⏱ different delay), and the ‹ › buttons on the backward strip jump between them. Where one strip has a frame the other lacks, the other strip shows an empty slot with an arrow (it skips a frame there); drag the frame onto that slot to fill it. "Skip ends" (on by default) keeps the backward pass from repeating the first and last frame; those spots get a skip slot too. Drag frames from one strip onto the other to copy them.
- **Edit the image:** crop (the box starts at the full picture; drag its edges, corners or the whole box), resize, rotate, flip, add text captions, draw (pen, highlighter, line, arrow, rectangle, ellipse) and add a progress bar.
- **Export:** GIF (palette and dithering options), animated WebP (lossy or lossless, keeps transparency), webm (VP9, keeps transparency), animated PNG and MP4. Opening a GIF, webm or animated WebP and exporting it as another format converts between them, keeping each frame's timing.
- Undo and redo for everything.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play / pause |
| ← / → | Previous / next frame (Shift extends the selection) |
| Alt+← / Alt+→ | Move selected frames |
| Home / End | First / last frame |
| ↑ / ↓ | Switch between the forward and backward strip (yoyo) |
| Delete | Delete selected frames |
| Ctrl+A | Select all |
| Ctrl+D | Duplicate selection |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+O | Open |
| Ctrl+S | Export panel |
| Esc | Close the open panel or dialog |

## Running on Linux

Download `Loopsmith-<version>.AppImage`, make it executable and run it:

```
chmod +x Loopsmith-*.AppImage
./Loopsmith-*.AppImage
```

AppImages need FUSE 2 (`sudo pacman -S fuse2` on Arch/CachyOS). Without it, run `./Loopsmith-*.AppImage --appimage-extract-and-run`, or use the `.tar.gz` build: unpack it and run `./loopsmith`.

On Wayland, recording goes through your desktop's screen sharing dialog (xdg-desktop-portal with PipeWire), where you pick the screen or window. The small recording bar can appear in the capture there; crop it out afterwards.

## Running from source

Needs Node.js 18 or newer.

```
npm install
npm start
```

## Building the app

```
npm run dist:win     # dist/Loopsmith-<version>-win.zip
npm run dist:mac     # dist/Loopsmith-<version>-mac.zip
npm run dist:linux   # dist/Loopsmith-<version>.AppImage and .tar.gz
```

The app icon lives in `build/` (`icon.svg` is the source; the PNG sizes and `icon.ico` are made from it). Each script first downloads the FFmpeg build for the target platform.

## Tests

`node test/smoke.js` drives the real app with Playwright: it imports a video, runs the edits, undo and redo, exports every format and checks that frame timing survives a GIF and webm round trip. `node test/formats.js` builds test files in every supported input format (common video codecs, GIF, APNG, WebM with transparency, animated WebP, still WebP) and checks that each imports with the right frame count, size, timing and transparency. On a headless Linux machine, run them under `xvfb-run`.

## How it works

- `main.js` is the Electron main process. It runs FFmpeg/FFprobe to split media into PNG frames and to encode exports (an ffconcat list carries each frame's delay at 1 ms precision).
- `renderer/` is the editor UI. Pixel edits are done on a canvas and saved as new PNG files, so every frame file is immutable and undo is just a list swap.
