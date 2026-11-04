// Quire desktop shell (Windows, macOS).
// The reader itself is the same code as on phones; this file only provides a
// window, opens books from the file manager, and serves www/ safely.
const { app, BrowserWindow, protocol, net, shell, Menu, ipcMain, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const { pathToFileURL } = require('node:url')

const WWW = path.join(__dirname, '..', 'www')
const MAX_BOOK_BYTES = 600 * 1024 * 1024 // same cap as the importer

// Own scheme instead of file://, so ES modules, IndexedDB and the CSP behave
// like on a normal secure origin.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

let win = null
const pendingFiles = []

const isEpub = p => typeof p === 'string' && p.toLowerCase().endsWith('.epub')

function epubsFromArgv(argv) {
  // Packaged Windows: [exe, file]; dev: [electron, appPath, file]
  return argv.slice(app.isPackaged ? 1 : 2).filter(isEpub)
}

async function sendBook(filePath) {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size > MAX_BOOK_BYTES) return
    const data = await fs.readFile(filePath)
    win?.webContents.send('open-book', { name: path.basename(filePath), data })
  } catch (e) {
    console.error('Could not read', filePath, e.message)
  }
}

function flushPending() {
  while (pendingFiles.length) sendBook(pendingFiles.shift())
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 360,
    minHeight: 520,
    show: false,
    title: 'Quire',
    backgroundColor: dark ? '#000000' : '#ffffff',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.loadURL('app://quire/index.html')

  // Nothing in a book may navigate or open windows inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://quire/')) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url) }
  })
  win.webContents.once('did-finish-load', () => setTimeout(flushPending, 400))
  win.on('closed', () => { win = null })
}

function serveApp() {
  protocol.handle('app', req => {
    const url = new URL(req.url)
    let rel = decodeURIComponent(url.pathname)
    if (rel === '/' || rel === '') rel = '/index.html'
    const full = path.normalize(path.join(WWW, rel))
    if (!full.startsWith(WWW + path.sep)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(full).toString())
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus() }
    for (const f of epubsFromArgv(argv)) pendingFiles.push(f)
    flushPending()
  })

  // macOS: double-click an .epub or drop it on the Dock icon.
  app.on('open-file', (e, filePath) => {
    e.preventDefault()
    pendingFiles.push(filePath)
    if (win && !win.webContents.isLoading()) flushPending()
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    serveApp()
    for (const f of epubsFromArgv(process.argv)) pendingFiles.push(f)
    createWindow()
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
  })

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}

ipcMain.on('chrome-color', (_e, color) => {
  if (!win || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return
  win.setBackgroundColor(color)
})
