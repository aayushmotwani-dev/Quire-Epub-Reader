const { contextBridge, ipcRenderer } = require('electron')

// Only plain data crosses into the page; the page builds the File itself.
contextBridge.exposeInMainWorld('quireNative', {
  platform: process.platform,
  onOpenBook(callback) {
    ipcRenderer.on('open-book', (_e, { name, data }) => callback({ name, data }))
  },
  setChromeColor(color) { ipcRenderer.send('chrome-color', color) },
})
