// Finds out which file(s) are being dragged *before* the drag reaches our overlay,
// so the format options can be shown the instant C is pressed.
const { spawn, execFile } = require('child_process');

// macOS: every Cocoa drag writes its items to the shared drag pasteboard, readable by any app.
// While Finder runs a drag, macOS doesn't report mouse moves or the release to other apps,
// so the real button state is read here too. One osascript process stays alive and answers
// a JSON line for every line it reads, so a query takes milliseconds.
const MAC_SERVER = `ObjC.import("AppKit");
var stdin = $.NSFileHandle.fileHandleWithStandardInput;
var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
var pb = $.NSPasteboard.pasteboardWithName("Apple CFPasteboard drag");
while (stdin.availableData.length > 0) {
  var urls = pb.readObjectsForClassesOptions($([$.NSURL]), $({}));
  var files = [];
  if (urls) for (var i = 0; i < urls.count; i++) { var u = urls.objectAtIndex(i); if (u.isFileURL) files.push(u.path.js); }
  var line = JSON.stringify({ count: Number(pb.changeCount), files: files, buttonDown: ($.NSEvent.pressedMouseButtons & 1) === 1 }) + "\\n";
  stdout.writeData($(line).dataUsingEncoding($.NSUTF8StringEncoding));
}`;

// Exits as soon as the left mouse button is released.
const MAC_WAIT_FOR_RELEASE = `ObjC.import("AppKit");
while (($.NSEvent.pressedMouseButtons & 1) === 1) delay(0.05);
"up"`;

// Persistent line-based helper process: each request line gets one JSON response line.
function lineServer(cmd, args) {
  let child = null;
  const pending = [];
  function start() {
    child = spawn(cmd, args, { windowsHide: true });
    let buffer = '';
    child.stdout.on('data', (d) => {
      buffer += d;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const resolve = pending.shift();
        if (!resolve) continue;
        try { resolve(JSON.parse(line || 'null')); } catch { resolve(null); }
      }
    });
    child.on('exit', () => { child = null; pending.splice(0).forEach((r) => r(null)); });
  }
  return {
    ask() {
      if (!child) start();
      return new Promise((resolve) => {
        pending.push(resolve);
        child.stdin.write('q\n');
        setTimeout(() => { const i = pending.indexOf(resolve); if (i >= 0) { pending.splice(i, 1); resolve(null); } }, 1500);
      });
    },
    start() { if (!child) start(); },
    stop() { if (child) child.kill(); },
  };
}

const mac = lineServer('osascript', ['-l', 'JavaScript', '-e', MAC_SERVER]);

// Drag pasteboard change count when no drag was in progress. A drag in progress has bumped it;
// an unchanged count means the pasteboard still holds an old drag.
let macBaseline = null;

async function macProbe() {
  const r = await mac.ask();
  if (!r) return { files: [], buttonDown: null };
  return { files: r.count !== macBaseline ? r.files : [], buttonDown: r.buttonDown };
}

// Call whenever no drag is in progress (after a click or a finished drag).
async function resetBaseline() {
  if (process.platform !== 'darwin') return;
  const r = await mac.ask();
  if (r) macBaseline = r.count;
}

let releaseWatcher = null;

// Calls `onRelease` once the mouse button goes up. Only needed on macOS (see above).
function watchRelease(onRelease) {
  if (process.platform !== 'darwin' || releaseWatcher) return;
  releaseWatcher = execFile('osascript', ['-l', 'JavaScript', '-e', MAC_WAIT_FOR_RELEASE], () => {
    releaseWatcher = null;
    onRelease();
  });
}

// Windows: there is no public API to read another app's drag, but a drag in Explorer
// always carries the selected items, so ask the foreground Explorer window for its selection.
// Like on macOS, one PowerShell process stays alive and answers a line per request.
const WIN_SCRIPT = `
Add-Type -Namespace DC -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'
$shell = New-Object -ComObject Shell.Application
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $fg = [int64][DC.W]::GetForegroundWindow()
  $paths = @()
  foreach ($w in $shell.Windows()) {
    try { if ([int64]$w.HWND -eq $fg) { foreach ($i in $w.Document.SelectedItems()) { $paths += $i.Path } } } catch {}
  }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @($paths)))
}`;

const win = lineServer('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64'),
]);

async function winDraggedFiles() {
  const r = await win.ask();
  return Array.isArray(r) ? r : r ? [r] : [];
}

// -> { files: paths being dragged, buttonDown: true/false, or null when unknown }
async function probe() {
  if (process.platform === 'darwin') return macProbe();
  if (process.platform === 'win32') return { files: await winDraggedFiles(), buttonDown: null };
  return { files: [], buttonDown: null };
}

// Called at startup so the first C press is already fast.
function warmUp() {
  if (process.platform === 'darwin') resetBaseline();
  if (process.platform === 'win32') win.start();
}

function stop() {
  mac.stop();
  win.stop();
  if (releaseWatcher) releaseWatcher.kill();
}

module.exports = { probe, resetBaseline, watchRelease, warmUp, stop };
