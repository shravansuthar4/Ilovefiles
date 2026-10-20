// Conversions that borrow Chromium from Electron: HTML -> PDF printing and PDF rendering.
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

function hiddenWindow(webPreferences = {}) {
  return new BrowserWindow({ show: false, width: 1200, height: 1600, webPreferences: { ...webPreferences } });
}

// Renders an HTML string or file to PDF. Scripts are disabled: the content comes from user files.
async function printToPdf({ html, file }) {
  const win = hiddenWindow({ javascript: false });
  try {
    if (file) await win.loadFile(file);
    else await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
  } finally {
    win.destroy();
  }
}

// Opens a PDF with pdf.js in a hidden window and hands back the window to query it.
async function withPdf(input, fn) {
  const win = hiddenWindow();
  try {
    await win.loadFile(path.join(__dirname, '../renderer/pdf-worker.html'));
    const data = (await fs.promises.readFile(input)).toString('base64');
    const pages = await win.webContents.executeJavaScript(`openPdf(${JSON.stringify(data)})`);
    return await fn(win, pages);
  } finally {
    win.destroy();
  }
}

async function renderPdf(input, mime) {
  return withPdf(input, async (win, pages) => {
    const out = [];
    for (let i = 1; i <= pages; i++) {
      const dataUrl = await win.webContents.executeJavaScript(`renderPage(${i}, ${JSON.stringify(mime)})`);
      out.push(Buffer.from(dataUrl.split(',')[1], 'base64'));
    }
    return out;
  });
}

async function pdfText(input) {
  return withPdf(input, (win) => win.webContents.executeJavaScript('allText()'));
}

module.exports = { printToPdf, renderPdf, pdfText };
