// Downloads the native binaries every installer needs, for every target platform:
//   vendor/ffmpeg/<platform>-<arch>/ffmpeg(.exe)   (via ffmpeg-static's own downloader)
//   node_modules/@img/sharp-*                       (sharp's prebuilt packages for each target)
// They are too large / platform-specific to keep in git. Safe to re-run: existing files are kept.
// Usage: npm run setup
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const TARGETS = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'win32', arch: 'x64' },
];

function fetchFfmpeg({ platform, arch }) {
  const dest = path.join(root, 'vendor', 'ffmpeg', `${platform}-${arch}`, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(dest)) return console.log(`ffmpeg ${platform}-${arch}: already there`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  console.log(`ffmpeg ${platform}-${arch}: downloading…`);
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'ffmpeg-static', 'install.js')], {
    stdio: 'inherit',
    env: { ...process.env, FFMPEG_BIN: dest, npm_config_platform: platform, npm_config_arch: arch },
  });
}

function fetchSharp() {
  const sharpPkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'sharp', 'package.json'), 'utf8'));
  const wanted = Object.entries(sharpPkg.optionalDependencies)
    .filter(([name]) => TARGETS.some((t) => name.endsWith(`-${t.platform}-${t.arch}`)))
    .filter(([name]) => !fs.existsSync(path.join(root, 'node_modules', name)))
    .map(([name, version]) => `${name}@${version}`);
  if (!wanted.length) return console.log('sharp: all platform packages already there');
  console.log(`sharp: installing ${wanted.join(' ')}`);
  // --force: these packages are for other OSes/CPUs; --no-save keeps package.json unchanged.
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-save', '--force', ...wanted], {
    cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
  });
}

TARGETS.forEach(fetchFfmpeg);
fetchSharp();
console.log('All native binaries are in place.');
