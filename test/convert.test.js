// End-to-end conversion test: creates sample files of every kind in a temp folder, converts each to
// every target the ring would offer, and checks the outputs. Runs inside Electron because the
// PDF engines need Chromium.  Usage: npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app } = require('electron');
const sharp = require('sharp');
const ffmpeg = require('ffmpeg-static');
const { convert, detect, targetsFor } = require('../src/main/converter');

async function makeSamples(dir) {
  const f = (n) => path.join(dir, n);
  await sharp({ create: { width: 120, height: 80, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toFile(f('image.png'));
  execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', f('audio.wav')]);
  execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=duration=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('video.mov')]);
  fs.writeFileSync(f('notes.md'), '# Notes\n\nSome **bold** text.\n\n- one\n- two\n');
  fs.writeFileSync(f('long.txt'), Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of a long document.`).join('\n'));
  // A real .docx needs Word or macOS's textutil; skipped elsewhere.
  if (process.platform === 'darwin') execFileSync('textutil', ['-convert', 'docx', f('long.txt'), '-output', f('letter.docx')]);
  await convert(f('long.txt'), 'pdf'); // multi-page PDF sample (long.pdf)
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i-love-files-test-'));
  let passed = 0, failed = 0;
  try {
    await makeSamples(dir);
    for (const name of fs.readdirSync(dir).sort()) {
      const input = path.join(dir, name);
      const from = await detect(input);
      for (const { id: to } of targetsFor(from).targets) {
        try {
          const outputs = [].concat(await convert(input, to));
          const ok = outputs.every((o) => fs.statSync(o).size > 0);
          if (!ok) throw new Error('empty output');
          passed++;
        } catch (err) {
          failed++;
          console.log(`FAIL ${name} -> ${to}: ${err.message}`);
        }
      }
    }
    console.log(`${passed} passed, ${failed} failed`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
  }
});
