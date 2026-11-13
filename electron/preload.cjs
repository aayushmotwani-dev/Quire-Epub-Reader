const { contextBridge, ipcRenderer } = require('electron')

// Only plain data crosses into the page; the page builds the File itself.
contextBridge.exposeInMainWorld('quireNative', {
  platform: process.platform,
  onOpenBook(callback) {
    ipcRenderer.on('open-book', (_e, { name, data }) => callback({ name, data }))
  },
  setChromeColor(color) { ipcRenderer.send('chrome-color', color) },
  // A JPEG of part of the window, for the page flip. Resolves to bytes or null.
  capturePage(rect) { return ipcRenderer.invoke('capture-page', rect) },
  // Bytes of one Open Library cover, by its numeric id. Resolves to { data, type } or null.
  fetchCover(coverId, size) { return ipcRenderer.invoke('fetch-cover', coverId, size) },
})
