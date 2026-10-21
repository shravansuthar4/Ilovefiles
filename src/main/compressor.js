// Makes files smaller. Three levels for every supported type:
//   light     looks/sounds the same, moderate saving
//   balanced  tiny, usually invisible quality loss, big saving
//   smallest  maximum saving, visible quality loss
// The result is saved next to the original as "name (compressed).ext"; the original is never touched.
// If the result isn't smaller, it's thrown away and an AlreadySmallError is raised.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');
const { FORMATS } = require('./formats');
const { detect, runFfmpeg, withTempDir, uniquePath } = require('./converter');

const LEVELS = [
  { id: 'light', label: 'Light' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'smallest', label: 'Smallest' },
];

class AlreadySmallError extends Error {
  constructor() { super('Already as small as it gets'); this.alreadySmall = true; }
}

// ---------- images ----------

// Per level: quality settings and the longest side the picture is shrunk to (null = keep size).
const IMAGE = {
  light:    { jpg: 82, webp: 80, avif: 55, pngPalette: null, gifColors: 256, tiff: 'lzw', maxSide: null },
  balanced: { jpg: 70, webp: 68, avif: 45, pngPalette: 85,   gifColors: 128, tiff: 85,    maxSide: 3000 },
  smallest: { jpg: 55, webp: 52, avif: 35, pngPalette: 65,   gifColors: 64,  tiff: 70,    maxSide: 2000 },
};

function shrink(img, maxSide) {
  return maxSide ? img.resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true }) : img;
}

async function compressImage(input, output, from, level) {
  const q = IMAGE[level];
  const animated = from === 'gif' || from === 'webp';
  let img = sharp(input, { animated });
  if (!animated) img = img.rotate(); // bake in EXIF orientation before metadata is dropped
  img = shrink(img, q.maxSide).keepIccProfile(); // colours stay right; GPS and other metadata go
  switch (from) {
    case 'jpg':  img = img.jpeg({ quality: q.jpg, mozjpeg: true }); break;
    case 'webp': img = img.webp({ quality: q.webp, effort: 6 }); break;
    case 'avif': img = img.avif({ quality: q.avif, effort: 6 }); break;
    case 'gif':  img = img.gif({ colours: q.gifColors, effort: 10, dither: 0.8 }); break;
    case 'png':
      img = q.pngPalette
        ? img.png({ palette: true, quality: q.pngPalette, compressionLevel: 9, effort: 10 })
        : img.png({ compressionLevel: 9, effort: 10, adaptiveFiltering: true }); // lossless
      break;
    case 'tiff':
      img = q.tiff === 'lzw' ? img.tiff({ compression: 'lzw', predictor: 'horizontal' }) : img.tiff({ compression: 'jpeg', quality: q.tiff });
      break;
  }
  await img.toFile(output);
}

// ---------- video ----------

const EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
// Longest side no bigger than `max`, keeping the aspect ratio (and even dimensions for H.264).
const fitVideo = (max) => (max
  ? `scale=w='if(gte(iw,ih),min(${max},iw),-2)':h='if(gte(iw,ih),-2,min(${max},ih))',${EVEN}`
  : EVEN);

const VIDEO = {
  light:    { crf: 23, vp9: 36, maxSide: null, audio: '160k' },
  balanced: { crf: 27, vp9: 42, maxSide: 1920, audio: '128k' },
  smallest: { crf: 31, vp9: 48, maxSide: 1280, audio: '96k' },
};

// AVI/WMV/FLV become MP4: their old codecs are what makes them big.
const videoOutExt = (from) => (['mp4', 'mov', 'mkv', 'webm'].includes(from) ? from : 'mp4');

function videoArgs(from, level) {
  const v = VIDEO[level];
  const vf = ['-vf', fitVideo(v.maxSide)];
  if (videoOutExt(from) === 'webm') {
    return [...vf, '-c:v', 'libvpx-vp9', '-crf', String(v.vp9), '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus', '-b:a', v.audio];
  }
  return [...vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', String(v.crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', v.audio, ...(videoOutExt(from) === 'mp4' ? ['-movflags', '+faststart'] : [])];
}

// ---------- audio ----------

// Lossy formats are re-encoded at a lower bitrate in the same format. Uncompressed / lossless audio
// becomes FLAC at "light" (still lossless, about half the size) and AAC (.m4a) at the other levels.
const LOSSLESS_AUDIO = ['wav', 'aiff', 'flac'];
const AUDIO_BITRATE = {
  mp3:  { light: '192k', balanced: '128k', smallest: '80k' },
  m4a:  { light: '160k', balanced: '112k', smallest: '64k' },
  opus: { light: '128k', balanced: '80k',  smallest: '48k' },
  wma:  { light: '160k', balanced: '112k', smallest: '64k' },
};
const OGG_QUALITY = { light: '5', balanced: '3', smallest: '1' };

function audioPlan(from, level) {
  if (LOSSLESS_AUDIO.includes(from)) {
    if (level === 'light') return { ext: 'flac', args: ['-vn', '-c:a', 'flac', '-compression_level', '12'] };
    return { ext: 'm4a', args: ['-vn', '-c:a', 'aac', '-b:a', AUDIO_BITRATE.m4a[level === 'balanced' ? 'light' : 'balanced']] };
  }
  switch (from) {
    // MP3 keeps its cover art.
    case 'mp3':  return { ext: 'mp3', args: ['-map', '0:a', '-map', '0:v?', '-c:v', 'copy', '-c:a', 'libmp3lame', '-b:a', AUDIO_BITRATE.mp3[level], '-id3v2_version', '3'] };
    case 'm4a':  return { ext: 'm4a', args: ['-vn', '-c:a', 'aac', '-b:a', AUDIO_BITRATE.m4a[level]] };
    case 'opus': return { ext: 'opus', args: ['-vn', '-c:a', 'libopus', '-b:a', AUDIO_BITRATE.opus[level]] };
    case 'wma':  return { ext: 'wma', args: ['-vn', '-c:a', 'wmav2', '-b:a', AUDIO_BITRATE.wma[level]] };
    case 'ogg':  return { ext: 'ogg', args: ['-vn', '-c:a', 'libvorbis', '-q:a', OGG_QUALITY[level]] };
  }
  return null;
}

// ---------- PDF ----------
// PDFs get smaller by re-compressing the pictures inside them as JPEG (and shrinking oversized ones).
// Text and drawings are left exactly as they are, so they stay sharp and selectable.

const PDF = {
  light:    { quality: 80, maxSide: null },
  balanced: { quality: 65, maxSide: 2000 },
  smallest: { quality: 45, maxSide: 1300 },
};

async function compressPdf(input, output, from, level) {
  const { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFNumber, PDFRef } = require('pdf-lib');
  let doc;
  try {
    doc = await PDFDocument.load(await fs.promises.readFile(input), { updateMetadata: false });
  } catch (err) {
    throw new Error(/encrypt/i.test(err.message) ? 'This PDF is password-protected' : 'Could not read this PDF');
  }
  const ctx = doc.context;
  const N = (n) => PDFName.of(n);
  const lookup = (v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
  const settings = PDF[level];

  // Images that are themselves masks of other images are left alone.
  const maskRefs = new Set();
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    for (const key of ['SMask', 'Mask']) {
      const m = obj.dict.get(N(key));
      if (m instanceof PDFRef) maskRefs.add(m.toString());
    }
  }

  // Colour space as "rgb", "gray", or null when it's something we don't touch (CMYK, indexed, …).
  function colourOf(cs) {
    cs = lookup(cs);
    if (cs === N('DeviceRGB')) return 'rgb';
    if (cs === N('DeviceGray')) return 'gray';
    if (cs instanceof PDFArray && lookup(cs.get(0)) === N('ICCBased')) {
      const n = lookup(lookup(cs.get(1)).dict.get(N('N')));
      return n && n.asNumber() === 3 ? 'rgb' : n && n.asNumber() === 1 ? 'gray' : null;
    }
    return null;
  }

  let changed = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (dict.get(N('Subtype')) !== N('Image') || maskRefs.has(ref.toString())) continue;
    if (dict.get(N('ImageMask')) || dict.get(N('Decode')) || obj.contents.length < 20000) continue;

    let filter = lookup(dict.get(N('Filter')));
    if (filter instanceof PDFArray) filter = filter.size() === 1 ? lookup(filter.get(0)) : null;
    const colour = colourOf(dict.get(N('ColorSpace')));
    const width = lookup(dict.get(N('Width'))).asNumber();
    const height = lookup(dict.get(N('Height'))).asNumber();
    const bpc = lookup(dict.get(N('BitsPerComponent')));
    if (!colour || !bpc || bpc.asNumber() !== 8) continue;

    let source;
    if (filter === N('DCTDecode')) {
      source = sharp(Buffer.from(obj.contents));
    } else if (filter === N('FlateDecode') && !dict.get(N('DecodeParms'))) {
      const channels = colour === 'rgb' ? 3 : 1;
      let raw;
      try { raw = zlib.inflateSync(Buffer.from(obj.contents)); } catch { continue; }
      if (raw.length !== width * height * channels) continue;
      source = sharp(raw, { raw: { width, height, channels } });
    } else {
      continue; // other encodings (JPX, JBIG2, CCITT, predictors) stay as they are
    }

    try {
      // Images with a transparency mask keep their size, so the mask still lines up.
      const resize = settings.maxSide && !dict.get(N('SMask'));
      let img = resize ? shrink(source, settings.maxSide) : source;
      if (colour === 'gray') img = img.greyscale();
      const { data, info } = await img.jpeg({ quality: settings.quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      if (data.length >= obj.contents.length * 0.95) continue;

      const newDict = dict.clone(ctx);
      newDict.set(N('Filter'), N('DCTDecode'));
      newDict.delete(N('DecodeParms'));
      newDict.set(N('Width'), PDFNumber.of(info.width));
      newDict.set(N('Height'), PDFNumber.of(info.height));
      newDict.set(N('ColorSpace'), N(colour === 'rgb' ? 'DeviceRGB' : 'DeviceGray'));
      newDict.set(N('BitsPerComponent'), PDFNumber.of(8));
      ctx.assign(ref, PDFRawStream.of(newDict, data));
      changed++;
    } catch {
      // an image sharp can't read: leave it untouched
    }
  }

  // Object streams also pack the rest of the file tighter, even when no pictures changed.
  await fs.promises.writeFile(output, await doc.save({ useObjectStreams: true }));
  return changed;
}

// ---------- Office documents ----------
// DOCX / PPTX / XLSX (and their OpenDocument cousins) are zip files; their pictures sit in a media
// folder. Those pictures are re-compressed in their own format and name, so the document still finds them.

const OFFICE_MEDIA = /^(word|ppt|xl)\/media\/[^/]+\.(png|jpe?g)$|^Pictures\/[^/]+\.(png|jpe?g)$/i;

async function compressOffice(input, output, from, level) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(await fs.promises.readFile(input));
  const q = IMAGE[level];
  for (const name of Object.keys(zip.files)) {
    if (!OFFICE_MEDIA.test(name)) continue;
    const original = await zip.file(name).async('nodebuffer');
    try {
      let img = shrink(sharp(original).rotate(), q.maxSide);
      img = /\.png$/i.test(name)
        ? (q.pngPalette ? img.png({ palette: true, quality: q.pngPalette, compressionLevel: 9 }) : img.png({ compressionLevel: 9, effort: 10 }))
        : img.jpeg({ quality: q.jpg, mozjpeg: true });
      const smaller = await img.toBuffer();
      if (smaller.length < original.length) zip.file(name, smaller);
    } catch {
      // unreadable picture: keep it
    }
  }
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  await fs.promises.writeFile(output, out);
}

// ---------- which files can be compressed, and how ----------

const IMAGE_FORMATS = ['jpg', 'png', 'webp', 'avif', 'gif', 'tiff'];
const OFFICE_FORMATS = ['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods'];

// -> { ext, run(input, output, onProgress) } or null when `from` can't be compressed.
function planFor(from, level) {
  const kind = FORMATS[from] && FORMATS[from].kind;
  if (IMAGE_FORMATS.includes(from)) return { ext: FORMATS[from].exts[0], run: (i, o) => compressImage(i, o, from, level) };
  if (kind === 'video') return { ext: videoOutExt(from), run: (i, o, p) => runFfmpeg(i, videoArgs(from, level), o, p) };
  if (kind === 'audio') {
    const a = audioPlan(from, level);
    return a && { ext: a.ext, run: (i, o, p) => runFfmpeg(i, a.args, o, p) };
  }
  if (from === 'pdf') return { ext: 'pdf', run: (i, o) => compressPdf(i, o, from, level) };
  if (OFFICE_FORMATS.includes(from)) return { ext: from, run: (i, o) => compressOffice(i, o, from, level) };
  return null;
}

// The compress options for a format (empty when it can't be compressed).
function compressLevels(from) {
  return from && planFor(from, 'light') ? LEVELS : [];
}

// Compresses `input` at `level`. Resolves with { output, before, after } in bytes.
async function compress(input, level, onProgress) {
  const from = await detect(input);
  const plan = from && planFor(from, level);
  if (!plan) throw new Error(`Can't compress ${from ? FORMATS[from].label : 'this file'}`);

  const { dir, name } = path.parse(input);
  const output = uniquePath(dir, `${name} (compressed)`, plan.ext);
  // Work in a temp file so a failed or pointless result never appears next to the original.
  return withTempDir(async (tmp) => {
    const temp = path.join(tmp, `out.${plan.ext}`);
    await plan.run(input, temp, onProgress);
    const before = (await fs.promises.stat(input)).size;
    const after = (await fs.promises.stat(temp)).size;
    if (after >= before * 0.98) throw new AlreadySmallError();
    await fs.promises.copyFile(temp, output);
    return { output, before, after };
  });
}

module.exports = { LEVELS, compressLevels, compress, AlreadySmallError };
