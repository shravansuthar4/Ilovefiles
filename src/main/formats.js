// Every file format the app knows. `kind` groups them; which conversions are actually
// possible is decided by the engines in converter.js.
const FORMATS = {
  // images
  jpg:  { kind: 'image', label: 'JPG',  exts: ['jpg', 'jpeg', 'jfif', 'jpe'], mimes: ['image/jpeg', 'image/pjpeg'] },
  png:  { kind: 'image', label: 'PNG',  exts: ['png'], mimes: ['image/png'] },
  webp: { kind: 'image', label: 'WEBP', exts: ['webp'], mimes: ['image/webp'] },
  avif: { kind: 'image', label: 'AVIF', exts: ['avif'], mimes: ['image/avif'] },
  gif:  { kind: 'image', label: 'GIF',  exts: ['gif'], mimes: ['image/gif'] },
  tiff: { kind: 'image', label: 'TIFF', exts: ['tif', 'tiff'], mimes: ['image/tiff'] },
  bmp:  { kind: 'image', label: 'BMP',  exts: ['bmp'], mimes: ['image/bmp', 'image/x-ms-bmp'] },
  ico:  { kind: 'image', label: 'ICO',  exts: ['ico'], mimes: ['image/x-icon', 'image/vnd.microsoft.icon'] },
  svg:  { kind: 'image', label: 'SVG',  exts: ['svg'], mimes: ['image/svg+xml'] },
  heic: { kind: 'image', label: 'HEIC', exts: ['heic', 'heif'], mimes: ['image/heic', 'image/heif'] },

  // audio
  mp3:  { kind: 'audio', label: 'MP3',  exts: ['mp3'], mimes: ['audio/mpeg', 'audio/mp3'] },
  wav:  { kind: 'audio', label: 'WAV',  exts: ['wav'], mimes: ['audio/wav', 'audio/x-wav', 'audio/wave'] },
  m4a:  { kind: 'audio', label: 'M4A',  exts: ['m4a', 'aac'], mimes: ['audio/mp4', 'audio/x-m4a', 'audio/aac'] },
  flac: { kind: 'audio', label: 'FLAC', exts: ['flac'], mimes: ['audio/flac', 'audio/x-flac'] },
  ogg:  { kind: 'audio', label: 'OGG',  exts: ['ogg', 'oga'], mimes: ['audio/ogg'] },
  opus: { kind: 'audio', label: 'OPUS', exts: ['opus'], mimes: ['audio/opus'] },
  aiff: { kind: 'audio', label: 'AIFF', exts: ['aif', 'aiff'], mimes: ['audio/aiff', 'audio/x-aiff'] },
  wma:  { kind: 'audio', label: 'WMA',  exts: ['wma'], mimes: ['audio/x-ms-wma'] },

  // video
  mp4:  { kind: 'video', label: 'MP4',  exts: ['mp4', 'm4v'], mimes: ['video/mp4', 'video/x-m4v'] },
  mov:  { kind: 'video', label: 'MOV',  exts: ['mov'], mimes: ['video/quicktime'] },
  mkv:  { kind: 'video', label: 'MKV',  exts: ['mkv'], mimes: ['video/x-matroska'] },
  webm: { kind: 'video', label: 'WEBM', exts: ['webm'], mimes: ['video/webm'] },
  avi:  { kind: 'video', label: 'AVI',  exts: ['avi'], mimes: ['video/x-msvideo', 'video/avi'] },
  wmv:  { kind: 'video', label: 'WMV',  exts: ['wmv'], mimes: ['video/x-ms-wmv'] },
  flv:  { kind: 'video', label: 'FLV',  exts: ['flv'], mimes: ['video/x-flv'] },

  // documents
  pdf:  { kind: 'document', label: 'PDF',  exts: ['pdf'], mimes: ['application/pdf'] },
  docx: { kind: 'document', label: 'DOCX', exts: ['docx'], mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
  doc:  { kind: 'document', label: 'DOC',  exts: ['doc'], mimes: ['application/msword'] },
  odt:  { kind: 'document', label: 'ODT',  exts: ['odt'], mimes: ['application/vnd.oasis.opendocument.text'] },
  rtf:  { kind: 'document', label: 'RTF',  exts: ['rtf'], mimes: ['application/rtf', 'text/rtf'] },
  txt:  { kind: 'document', label: 'TXT',  exts: ['txt', 'text'], mimes: ['text/plain'] },
  md:   { kind: 'document', label: 'MD',   exts: ['md', 'markdown'], mimes: ['text/markdown', 'text/x-markdown'] },
  html: { kind: 'document', label: 'HTML', exts: ['html', 'htm'], mimes: ['text/html'] },

  // spreadsheets
  xlsx: { kind: 'sheet', label: 'XLSX', exts: ['xlsx'], mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] },
  xls:  { kind: 'sheet', label: 'XLS',  exts: ['xls'], mimes: ['application/vnd.ms-excel'] },
  ods:  { kind: 'sheet', label: 'ODS',  exts: ['ods'], mimes: ['application/vnd.oasis.opendocument.spreadsheet'] },
  csv:  { kind: 'sheet', label: 'CSV',  exts: ['csv'], mimes: ['text/csv'] },

  // presentations
  pptx: { kind: 'slides', label: 'PPTX', exts: ['pptx'], mimes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'] },
  ppt:  { kind: 'slides', label: 'PPT',  exts: ['ppt'], mimes: ['application/vnd.ms-powerpoint'] },
  odp:  { kind: 'slides', label: 'ODP',  exts: ['odp'], mimes: ['application/vnd.oasis.opendocument.presentation'] },
};

const ids = (kind) => Object.keys(FORMATS).filter((id) => FORMATS[id].kind === kind);

function fromMime(mime) {
  if (!mime) return null;
  mime = mime.toLowerCase();
  return Object.keys(FORMATS).find((id) => FORMATS[id].mimes.includes(mime)) || null;
}

function fromExtension(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  return Object.keys(FORMATS).find((id) => FORMATS[id].exts.includes(ext)) || null;
}

module.exports = { FORMATS, ids, fromMime, fromExtension };
