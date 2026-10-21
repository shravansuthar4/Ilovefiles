// Prints docs/install-guide.html to release/Install-Guide.pdf (the guide shipped with the installers).
// Usage: npm run guide
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadFile(path.join(root, 'docs', 'install-guide.html'));
  const pdf = await win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true });
  fs.mkdirSync(path.join(root, 'release'), { recursive: true });
  const out = path.join(root, 'release', 'Install-Guide.pdf');
  fs.writeFileSync(out, pdf);
  console.log(`-> ${path.relative(root, out)}`);
  app.quit();
});
