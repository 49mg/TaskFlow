const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(method, ...args) {
  const res = await ipcRenderer.invoke('store', method, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

contextBridge.exposeInMainWorld('taskflow', {
  call,
  mcpInfo: () => ipcRenderer.invoke('mcp-info'),
  copy: (text) => ipcRenderer.invoke('copy', text),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  docs: {
    pick: () => ipcRenderer.invoke('doc:pick'),
    // Drag & drop: turn a dropped File into its path on disk, plus its size.
    fromDropped: (file) => ipcRenderer.invoke('doc:stat', webUtils.getPathForFile(file)),
    open: (id) => ipcRenderer.invoke('doc:open', id),
    show: (id) => ipcRenderer.invoke('doc:show', id),
  },
  onDataChanged: (cb) => ipcRenderer.on('data-changed', cb),
  integrations: async (action, ...args) => {
    const res = await ipcRenderer.invoke(`int:${action}`, ...args);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  },
  onIntegrationsChanged: (cb) => ipcRenderer.on('integrations-changed', cb),
});
