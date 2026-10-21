const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const { FORMATS, ids, fromExtension } = require('./formats');

const isMac = process.platform === 'darwin';
// Installed app: ffmpeg ships in Resources/ffmpeg for its own platform (see scripts/build.js).
const bundledFfmpeg = process.resourcesPath
  && path.join(process.resourcesPath, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const FFMPEG = bundledFfmpeg && fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : require('ffmpeg-static');

// Built-in document/PDF engines need Electron windows; loaded lazily so this file also runs in plain Node.
const electronTools = () => require('./electron-tools');

// ---------- helpers ----------

function run(cmd, args, onStderr) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; if (onStderr) onStderr(String(d)); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(lastLine(stderr) || `${path.basename(cmd)} failed`))));
  });
}

const lastLine = (s) => s.trim().split('\n').filter(Boolean).pop() || '';

async function withTempDir(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'i-love-files-'));
  try { return await fn(dir); } finally { fs.promises.rm(dir, { recursive: true, force: true }); }
}

async function moveFile(from, to) {
  try { await fs.promises.rename(from, to); } catch {
    await fs.promises.copyFile(from, to); // different volume
    await fs.promises.unlink(from);
  }
}

// "photo.png", then "photo (1).png", ... so nothing is ever overwritten.
function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}.${ext}`);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i}).${ext}`);
  return candidate;
}

// ---------- images ----------

// Returns something sharp can open, converting formats it can't read first.
async function sharpSource(input, from, tmp) {
  if (from === 'bmp' || from === 'ico') {
    const png = path.join(tmp, 'src.png');
    await run(FFMPEG, ['-nostdin', '-y', '-i', input, '-frames:v', '1', png]);
    return png;
  }
  if (from === 'heic' && isMac) {
    const png = path.join(tmp, 'src.png');
    await run('sips', ['-s', 'format', 'png', input, '--out', png]);
    return png;
  }
  return input;
}

async function imageConvert(input, output, from, to) {
  await withTempDir(async (tmp) => {
    const src = await sharpSource(input, from, tmp);
    const animated = ['gif', 'webp'].includes(from) && ['gif', 'webp'].includes(to);
    let img = sharp(src, { animated });
    if (!animated) img = img.rotate(); // apply EXIF orientation

    switch (to) {
      case 'jpg':  return img.flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true }).toFile(output);
      case 'png':  return img.png().toFile(output);
      case 'webp': return img.webp({ quality: 90 }).toFile(output);
      case 'avif': return img.avif({ quality: 60 }).toFile(output);
      case 'gif':  return img.gif().toFile(output);
      case 'tiff': return img.tiff({ compression: 'lzw' }).toFile(output);
      case 'bmp': {
        const png = path.join(tmp, 'out.png');
        await img.png().toFile(png);
        return run(FFMPEG, ['-nostdin', '-y', '-i', png, '-pix_fmt', 'bgr24', output]);
      }
      case 'ico': {
        // An ICO file may embed a PNG directly: 6-byte header + 16-byte directory entry + PNG.
        const png = await img.resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
        const head = Buffer.alloc(22);
        head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
        head.writeUInt8(0, 6); head.writeUInt8(0, 7); // 0 = 256px
        head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
        head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
        return fs.promises.writeFile(output, Buffer.concat([head, png]));
      }
      case 'pdf': {
        const { PDFDocument } = require('pdf-lib');
        const png = await img.png().toBuffer();
        const { width, height } = await sharp(png).metadata();
        const doc = await PDFDocument.create();
        const page = doc.addPage([width, height]);
        page.drawImage(await doc.embedPng(png), { x: 0, y: 0, width, height });
        return fs.promises.writeFile(output, await doc.save());
      }
    }
  });
}

// ---------- audio & video (ffmpeg) ----------

const EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2'; // H.264 needs even dimensions
const H264 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p', '-vf', EVEN];

const FFMPEG_ARGS = {
  mp3:  ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'],
  wav:  ['-vn', '-c:a', 'pcm_s16le'],
  m4a:  ['-vn', '-c:a', 'aac', '-b:a', '192k'],
  flac: ['-vn', '-c:a', 'flac'],
  ogg:  ['-vn', '-c:a', 'libvorbis', '-q:a', '5'],
  opus: ['-vn', '-c:a', 'libopus', '-b:a', '128k'],
  aiff: ['-vn', '-c:a', 'pcm_s16be'],
  wma:  ['-vn', '-c:a', 'wmav2', '-b:a', '192k'],
  mp4:  [...H264, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'],
  mov:  [...H264, '-c:a', 'aac', '-b:a', '160k'],
  mkv:  [...H264, '-c:a', 'aac', '-b:a', '160k'],
  webm: ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '128k'],
  avi:  ['-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'libmp3lame', '-q:a', '3'],
  wmv:  ['-c:v', 'wmv2', '-q:v', '3', '-c:a', 'wmav2', '-b:a', '160k'],
  gif:  ['-an', '-vf', 'fps=12,scale=480:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', '-loop', '0'],
};

const toSeconds = (t) => t.split(':').reduce((acc, v) => acc * 60 + parseFloat(v), 0);

// Runs ffmpeg on `input` with `args`, reporting progress 0..1 from its stderr.
async function runFfmpeg(input, args, output, onProgress) {
  let duration = 0;
  try {
    await run(FFMPEG, ['-nostdin', '-y', '-hide_banner', '-i', input, ...args, output], (chunk) => {
      const d = chunk.match(/Duration: (\d+:\d+:[\d.]+)/);
      if (d) duration = toSeconds(d[1]);
      const t = chunk.match(/time=(\d+:\d+:[\d.]+)/);
      if (t && duration && onProgress) onProgress(Math.min(1, toSeconds(t[1]) / duration));
    });
  } catch (err) {
    fs.promises.rm(output, { force: true }); // don't leave a half-written file behind
    throw err;
  }
}

function ffmpegConvert(input, output, from, to, onProgress) {
  return runFfmpeg(input, FFMPEG_ARGS[to], output, onProgress);
}

// ---------- office documents (LibreOffice, if installed) ----------

function findSoffice() {
  const candidates = isMac
    ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
    : process.platform === 'win32'
      ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
          .map((p) => path.join(p, 'LibreOffice', 'program', 'soffice.exe'))
      : ['/usr/bin/soffice', '/usr/local/bin/soffice'];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const LO_FILTER = { txt: 'txt:Text (encoded):UTF8', csv: 'csv:Text - txt - csv (StarCalc):44,34,76' };

async function libreOfficeConvert(input, output, from, to) {
  await withTempDir(async (tmp) => {
    const profile = require('url').pathToFileURL(path.join(os.tmpdir(), 'i-love-files-lo-profile')).href;
    await run(findSoffice(), [
      '--headless', '--norestore', `-env:UserInstallation=${profile}`,
      '--convert-to', LO_FILTER[to] || to, '--outdir', tmp, input,
    ]);
    const produced = (await fs.promises.readdir(tmp))[0];
    if (!produced) throw new Error('LibreOffice produced no file');
    await moveFile(path.join(tmp, produced), output);
  });
}

// ---------- built-in documents (no LibreOffice needed) ----------

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const page = (body) => `<!doctype html><meta charset="utf-8"><style>
  body { font: 11pt/1.5 -apple-system, "Segoe UI", Arial, sans-serif; max-width: 48em; margin: 2em auto; color: #111; }
  img { max-width: 100%; } table { border-collapse: collapse; margin: 0.8em 0; }
  td, th { border: 1px solid #ccc; padding: 4px 8px; vertical-align: top; }
  td > p, th > p { margin: 0; } /* Word puts every cell's text in a paragraph */
  h1.title { font-size: 26pt; margin: 0 0 0.3em; } p.subtitle { font-size: 14pt; color: #555; margin-top: 0; }
  pre { white-space: pre-wrap; font: 10pt/1.45 Menlo, Consolas, monospace; }
</style>${body}`;

// Word styles mammoth doesn't map on its own.
const DOCX_STYLES = [
  "p[style-name='Title'] => h1.title:fresh",
  "p[style-name='Subtitle'] => p.subtitle:fresh",
];

async function toHtml(input, from) {
  if (from === 'docx') return page((await require('mammoth').convertToHtml({ path: input }, { styleMap: DOCX_STYLES })).value);
  const text = await fs.promises.readFile(input, 'utf8');
  if (from === 'md') return page(require('marked').marked.parse(text));
  if (from === 'txt') return page(`<pre>${escapeHtml(text)}</pre>`);
  return text; // html
}

async function builtinDocConvert(input, output, from, to) {
  if (to === 'txt' && from === 'docx') {
    return fs.promises.writeFile(output, (await require('mammoth').extractRawText({ path: input })).value);
  }
  if (to === 'html') return fs.promises.writeFile(output, await toHtml(input, from));
  if (to === 'pdf') {
    // Plain HTML files load from disk so their relative images resolve.
    const pdf = from === 'html'
      ? await electronTools().printToPdf({ file: input })
      : await electronTools().printToPdf({ html: await toHtml(input, from) });
    return fs.promises.writeFile(output, pdf);
  }
}

// PDF -> images (one file per page) or text.
async function pdfConvert(input, output, from, to) {
  if (to === 'txt') {
    const text = await electronTools().pdfText(input);
    if (!text.trim()) throw new Error('This PDF has no text (it may be a scan)');
    return fs.promises.writeFile(output, text);
  }
  const pages = await electronTools().renderPdf(input, to === 'jpg' ? 'image/jpeg' : 'image/png');
  if (pages.length === 1) return fs.promises.writeFile(output, pages[0]);
  const { dir, name, ext } = path.parse(output);
  const outputs = [];
  for (let i = 0; i < pages.length; i++) {
    const p = uniquePath(dir, `${name} - page ${i + 1}`, ext.slice(1));
    await fs.promises.writeFile(p, pages[i]);
    outputs.push(p);
  }
  return outputs;
}

// ---------- engine table ----------
// First matching engine wins, so better-quality engines come first.

const IMAGE_IN = ids('image');
const AUDIO = ids('audio');
const VIDEO = ids('video');
const WRITER = ['docx', 'doc', 'odt', 'rtf', 'txt', 'html'];
const CALC = ids('sheet');
const IMPRESS = ids('slides');

const ENGINES = [
  // Most-used formats first: they take the top of the ring.
  { from: IMAGE_IN, to: ['jpg', 'png', 'pdf', 'webp', 'gif', 'avif', 'tiff', 'bmp', 'ico'], run: imageConvert },
  { from: VIDEO, to: VIDEO.filter((v) => v !== 'flv'), run: ffmpegConvert },
  { from: ['gif'], to: ['mp4', 'webm'], run: ffmpegConvert },
  { from: VIDEO, to: ['gif', ...AUDIO], run: ffmpegConvert },
  { from: AUDIO, to: AUDIO, run: ffmpegConvert },
  { from: WRITER, to: ['pdf', ...WRITER], run: libreOfficeConvert, needs: 'libreoffice' },
  { from: CALC, to: ['pdf', ...CALC], run: libreOfficeConvert, needs: 'libreoffice' },
  { from: IMPRESS, to: ['pdf', ...IMPRESS], run: libreOfficeConvert, needs: 'libreoffice' },
  { from: ['docx'], to: ['pdf', 'html', 'txt'], run: builtinDocConvert },
  { from: ['md', 'txt'], to: ['pdf', 'html'], run: builtinDocConvert },
  { from: ['html'], to: ['pdf'], run: builtinDocConvert },
  { from: ['pdf'], to: ['png', 'jpg', 'txt'], run: pdfConvert },
];

const hasLibreOffice = () => !!findSoffice();
const usable = (e) => e.needs !== 'libreoffice' || hasLibreOffice();

function engineFor(from, to) {
  return ENGINES.find((e) => usable(e) && e.from.includes(from) && e.to.includes(to));
}

// Formats `from` can become, grouped by kind. Also reports whether LibreOffice would unlock more.
function targetsFor(from) {
  if (!from) return { targets: [], moreWithLibreOffice: false };
  // The file's own kind first (a video shows other video formats before GIF or audio).
  const order = ['image', 'video', 'audio', 'document', 'sheet', 'slides'].sort((a, b) => (b === FORMATS[from].kind) - (a === FORMATS[from].kind));
  const seen = new Set();
  for (const e of ENGINES) {
    if (usable(e) && e.from.includes(from)) e.to.forEach((t) => t !== from && seen.add(t));
  }
  const targets = [...seen]
    .sort((a, b) => order.indexOf(FORMATS[a].kind) - order.indexOf(FORMATS[b].kind))
    .map((id) => ({ id, label: FORMATS[id].label, kind: FORMATS[id].kind }));
  const moreWithLibreOffice = !hasLibreOffice()
    && ENGINES.some((e) => e.needs === 'libreoffice' && e.from.includes(from) && e.to.some((t) => t !== from && !seen.has(t)));
  return { targets, moreWithLibreOffice };
}

// Identify the real format from the contents where we can, falling back to the extension.
async function detect(filePath) {
  const byExt = fromExtension(filePath);
  if (byExt && FORMATS[byExt].kind !== 'image') return byExt;
  try {
    const meta = await sharp(filePath).metadata();
    if (meta.format === 'heif') return meta.compression === 'av1' ? 'avif' : 'heic';
    const map = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', tiff: 'tiff', svg: 'svg' };
    if (map[meta.format]) return map[meta.format];
  } catch {
    // not something sharp can read
  }
  return byExt;
}

// Converts `input` to `to` next to the original (which is never touched).
// Resolves with the output path, or an array of paths (e.g. a multi-page PDF to PNG).
async function convert(input, to, onProgress) {
  const from = await detect(input);
  if (!from) throw new Error('Unsupported file type');
  if (from === to) throw new Error(`File is already ${FORMATS[to].label}`);
  const engine = engineFor(from, to);
  if (!engine) throw new Error(`Can't convert ${FORMATS[from].label} to ${FORMATS[to].label}`);

  const { dir, name } = path.parse(input);
  const output = uniquePath(dir, name, FORMATS[to].exts[0]);
  const result = await engine.run(input, output, from, to, onProgress);
  return Array.isArray(result) ? result : output;
}

module.exports = {
  detect, convert, targetsFor, hasLibreOffice,
  // shared with compressor.js
  run, runFfmpeg, withTempDir, uniquePath, sharpSource,
};
