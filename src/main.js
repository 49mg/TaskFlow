const { app, BrowserWindow, ipcMain, clipboard, shell, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { api, read, documentPath, DATA_FILE, DATA_DIR } = require('./store');
const { createManager } = require('./integrations');

const integrations = createManager({
  safeStorage,
  // Test hook: TASKFLOW_FAKE_SERVICES=1 routes Jira/Notion/Trello calls to in-memory fakes.
  fetchImpl: process.env.TASKFLOW_FAKE_SERVICES === '1' ? require('../scripts/fake-services').combinedFetch() : undefined,
  onChange: () => win && !win.isDestroyed() && win.webContents.send('integrations-changed'),
});
const wrap = (fn) => async (_e, ...args) => {
  try { return { ok: true, result: await fn(...args) }; } catch (err) { return { ok: false, error: err.message }; }
};
ipcMain.handle('int:providers', wrap(() => ({ providers: integrations.providers(), encrypted: integrations.encryptionAvailable() })));
ipcMain.handle('int:list', wrap((projectId) => integrations.list(projectId)));
ipcMain.handle('int:save', wrap((projectId, provider, cfg) => integrations.save(projectId, provider, cfg)));
ipcMain.handle('int:test', wrap((projectId, provider, draft) => integrations.test(projectId, provider, draft)));
ipcMain.handle('int:sync', wrap((projectId, provider) => integrations.sync(projectId, provider)));
ipcMain.handle('int:remove', wrap((projectId, provider) => integrations.remove(projectId, provider)));

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'TaskFlow',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Open links from issue descriptions in the system browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
}

// Every store method is exposed over IPC; errors are returned, not thrown, so the UI can show them.
ipcMain.handle('store', async (_e, method, ...args) => {
  try {
    if (method !== 'getAll' && typeof api[method] !== 'function') throw new Error(`Unknown method ${method}`);
    return { ok: true, result: api[method](...args) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mcp-info', () => {
  // When packaged, the MCP server is unpacked next to the asar so plain `node` can run it.
  const serverPath = path.join(__dirname, '..', 'mcp', 'server.js').replace('app.asar', 'app.asar.unpacked');
  return { serverPath, dataFile: DATA_FILE };
});
ipcMain.handle('copy', (_e, text) => { clipboard.writeText(text); return true; });
ipcMain.handle('open-data-dir', () => shell.openPath(DATA_DIR));

// ---- project documents ----
const docById = (id) => { const d = (read().documents || []).find(x => x.id === id); if (!d) throw new Error('Document not found'); return d; };
ipcMain.handle('doc:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Upload PDF', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF documents', extensions: ['pdf'] }] });
  if (r.canceled) return [];
  return r.filePaths.map(p => ({ path: p, name: path.basename(p), size: fs.statSync(p).size }));
});
ipcMain.handle('doc:stat', (_e, p) => { const s = fs.statSync(p); return { path: p, name: path.basename(p), size: s.size }; });
ipcMain.handle('doc:open', async (_e, id) => { const err = await shell.openPath(documentPath(docById(id))); if (err) throw new Error(err); return true; });
ipcMain.handle('doc:show', (_e, id) => { shell.showItemInFolder(documentPath(docById(id))); return true; });

// Watch the data file so edits from the MCP server (Claude) appear live.
function watchData() {
  api.getAll(); // ensures the file exists
  let timer;
  const notify = () => {
    clearTimeout(timer);
    timer = setTimeout(() => win && !win.isDestroyed() && win.webContents.send('data-changed'), 80);
  };
  // Watch the directory: atomic renames replace the file inode, which breaks file-level watches.
  fs.watch(DATA_DIR, (_evt, file) => { if (file === path.basename(DATA_FILE)) notify(); });
}

app.whenReady().then(() => {
  createWindow();
  watchData();
  // Auto-sync scheduler: checks every minute which connections are due.
  setInterval(() => integrations.tick().catch(() => {}), 60000);
  setTimeout(() => integrations.tick().catch(() => {}), 5000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
