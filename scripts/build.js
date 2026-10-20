// Builds the installers people share:
//   release/I love files - Mac (Apple Silicon).dmg
//   release/I love files - Mac (Intel).dmg
//   release/I love files - Windows Setup.exe
// Usage: npm run release            (all)    |   node scripts/build.js mac-arm64 win-x64   (some)
//
// sharp and ffmpeg ship one native binary per platform, so each installer gets only its own:
// sharp's @img/* packages for every target must be in node_modules, and ffmpeg binaries in vendor/ffmpeg/.
const fs = require('fs');
const path = require('path');
const { build, Platform, Arch } = require('electron-builder');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');

const TARGETS = {
  'mac-arm64': { platform: Platform.MAC, arch: Arch.arm64, img: 'darwin-arm64', ffmpeg: 'darwin-arm64', out: 'Mac (Apple Silicon)', ext: 'dmg' },
  'mac-x64':   { platform: Platform.MAC, arch: Arch.x64,   img: 'darwin-x64',   ffmpeg: 'darwin-x64',   out: 'Mac (Intel)', ext: 'dmg' },
  'win-x64':   { platform: Platform.WINDOWS, arch: Arch.x64, img: 'win32-x64',  ffmpeg: 'win32-x64',    out: 'Windows Setup', ext: 'exe' },
};

function checkBinaries(t) {
  const need = [`node_modules/@img/sharp-${t.img}`, `vendor/ffmpeg/${t.ffmpeg}`];
  if (t.img.startsWith('darwin')) need.push(`node_modules/@img/sharp-libvips-${t.img}`);
  const missing = need.filter((p) => !fs.existsSync(path.join(root, p)));
  if (missing.length) throw new Error(`Missing native binaries for ${t.img}: ${missing.join(', ')}`);
}

async function buildTarget(name) {
  const t = TARGETS[name];
  checkBinaries(t);
  const otherImg = Object.values(TARGETS).map((o) => o.img).filter((i) => i !== t.img);

  const config = {
    ...pkg.build,
    directories: { output: path.join(root, 'dist', name), buildResources: 'build' },
    npmRebuild: false, // every native module ships prebuilt N-API binaries for all targets
    toolsets: { nsis: '1.2.1' }, // NSIS 3.12 bundle: runs natively on Apple Silicon (the legacy one needs Rosetta)
    files: [
      ...pkg.build.files,
      '!node_modules/ffmpeg-static/ffmpeg*', // replaced by the per-platform copy below
      ...otherImg.flatMap((i) => [`!node_modules/@img/sharp-${i}/**`, `!node_modules/@img/sharp-libvips-${i}/**`]),
      '!node_modules/@img/sharp-wasm32/**',
      // A locally compiled uiohook (from npm install or an earlier build) is loaded before its
      // per-platform prebuilds, so it must never ship: it would be the wrong OS/arch on other targets.
      '!node_modules/uiohook-napi/build/**',
      // pdf.js's optional Node canvas (installed for the build machine only). PDFs render in Chromium instead.
      '!node_modules/@napi-rs/**',
    ],
    extraResources: [{ from: `vendor/ffmpeg/${t.ffmpeg}`, to: 'ffmpeg' }],
    artifactName: `\${productName} - ${t.out}.\${ext}`,
  };

  console.log(`\n=== Building ${t.out} ===`);
  const artifacts = await build({ targets: t.platform.createTarget(t.ext === 'dmg' ? 'dmg' : 'nsis', t.arch), config });
  const file = artifacts.find((a) => a.endsWith(`.${t.ext}`));
  fs.mkdirSync(path.join(root, 'release'), { recursive: true });
  const dest = path.join(root, 'release', path.basename(file));
  fs.copyFileSync(file, dest);
  console.log(`-> ${path.relative(root, dest)}`);
}

(async () => {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TARGETS);
  for (const name of names) await buildTarget(name);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
