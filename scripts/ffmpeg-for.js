// Downloads the FFmpeg binary for the target platform before packaging (ffmpeg-static only fetches the host one).
const { execSync } = require('child_process');
const path = require('path');
const platform = process.argv[2] || process.platform;
const dir = path.dirname(require.resolve('ffmpeg-static/package.json'));
for (const f of ['ffmpeg', 'ffmpeg.exe']) { try { require('fs').unlinkSync(path.join(dir, f)); } catch {} }
execSync('node install.js', { cwd: dir, stdio: 'inherit', env: { ...process.env, npm_config_platform: platform, npm_config_arch: 'x64' } });
