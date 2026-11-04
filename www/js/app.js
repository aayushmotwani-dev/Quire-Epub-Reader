import { initLibrary, refreshLibrary } from './library.js'
import { initReader, openBook, closeBook, isReading } from './reader.js'
import { importFile, requestPersistence, ImportError } from './importer.js'
import { openDB } from './db.js'
import { $, $$, el, toast, showSheet, closeSheet, handleSheetPop, isSheetOpen } from './ui.js'
import { getFlag, setFlag, getSettings, setSettings, onSettings, applyAppMode, onSystemThemeChange, APPEARANCES } from './settings.js'

const splashStart = performance.now()

let enteredReaderFromLibrary = false

// Running inside the installed desktop or phone app rather than a browser tab.
const isNative = location.protocol === 'app:' || !!window.quireNative || !!window.Capacitor?.isNativePlatform?.()

// ---------------------------------------------------------------- routing
// #/            library
// #/read/<id>   reader

function parseRoute() {
  const m = location.hash.match(/^#\/read\/([A-Za-z0-9._-]{1,200})$/)
  return m ? { name: 'read', id: m[1] } : { name: 'library' }
}

async function route() {
  const r = parseRoute()
  if (r.name === 'read') {
    showView('reader')
    const ok = await openBook(r.id)
    if (!ok) { location.replace('#/'); return }
  } else {
    if (isReading()) await closeBook()
    showView('library')
    await refreshLibrary()
  }
}

function showView(name) {
  const reading = name === 'reader'
  $('#library').hidden = reading
  $('#reader').hidden = !reading
  document.body.classList.toggle('reading', reading)
  if (!reading) {
    $('#reader').classList.remove('chrome-on')
    applyAppMode()
  }
}

export function goRead(id) {
  enteredReaderFromLibrary = true
  location.hash = `#/read/${id}`
}

function goLibrary() {
  if (enteredReaderFromLibrary) { enteredReaderFromLibrary = false; history.back() }
  else location.replace('#/')
}

// ---------------------------------------------------------------- importing

async function importFiles(files) {
  const list = Array.from(files).filter(f => f && f.size !== undefined)
  if (!list.length) return []
  const added = [], existing = [], failed = []
  for (const [i, file] of list.entries()) {
    if (list.length > 1) toast(`Adding ${i + 1} of ${list.length}…`, { duration: 0 })
    else toast(`Adding ${file.name || 'book'}…`, { duration: 0 })
    try {
      const { book, status } = await importFile(file)
      ;(status === 'added' ? added : existing).push(book)
    } catch (e) {
      failed.push(e instanceof ImportError ? e.message : `${file.name || 'A file'} could not be added.`)
      if (!(e instanceof ImportError)) console.error(e)
    }
  }
  if (added.length) requestPersistence()
  if (!isReading()) await refreshLibrary()

  const parts = []
  if (added.length === 1) parts.push(`Added “${added[0].title}”`)
  else if (added.length) parts.push(`Added ${added.length} books`)
  if (existing.length) parts.push(existing.length === 1 ? `“${existing[0].title}” is already in your library` : `${existing.length} were already in your library`)
  if (failed.length) parts.push(failed.length === 1 ? failed[0] : `${failed.length} files could not be added`)
  toast(parts.map(s => s.replace(/\.$/, '')).join('. ') + '.', { duration: failed.length ? 7000 : 3600 })
  return [...added, ...existing]
}

function pickFiles() {
  const input = $('#file-input')
  // Phone file pickers map ".epub" to a type they often don't know and grey
  // the books out. On touch devices, show every file; the import checks it.
  if (matchMedia('(pointer: coarse)').matches) input.removeAttribute('accept')
  input.value = ''
  input.click()
}

function initDrop() {
  let depth = 0
  const hasFiles = e => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  window.addEventListener('dragenter', e => {
    if (!hasFiles(e) || isReading()) return
    e.preventDefault()
    depth++
    document.body.classList.add('dragging')
  })
  window.addEventListener('dragover', e => { if (hasFiles(e) && !isReading()) e.preventDefault() })
  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return
    depth = Math.max(0, depth - 1)
    if (!depth) document.body.classList.remove('dragging')
  })
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth = 0
    document.body.classList.remove('dragging')
    if (!isReading()) importFiles(e.dataTransfer.files)
  })
}

// Installed on Windows/macOS/ChromeOS: "Open with Quire" from the file manager.
function initFileHandling() {
  // Desktop app: the shell reads the file and hands it over.
  if (window.quireNative?.onOpenBook) {
    window.quireNative.onOpenBook(async ({ name, data }) => {
      const books = await importFiles([new File([data], name, { type: 'application/epub+zip' })])
      if (books.length === 1) goRead(books[0].id)
    })
    return
  }
  if (!('launchQueue' in window)) return
  window.launchQueue.setConsumer(async params => {
    if (!params.files?.length) return
    const files = await Promise.all(params.files.map(h => h.getFile().catch(() => null)))
    const books = await importFiles(files.filter(Boolean))
    if (books.length === 1) goRead(books[0].id)
  })
}

// Phone app: "Open in Quire" from Files, the Share sheet, Downloads or another app.
// The system hands over a file address; the app reads it and adds it to the library.
function initNativeOpen() {
  const cap = window.Capacitor
  const app = cap?.Plugins?.App
  if (!cap?.isNativePlatform?.() || !app) return
  const ios = cap.getPlatform?.() === 'ios'
  let last = { url: '', at: 0 }
  const open = async url => {
    // iPhone gives a file address, Android a content address. Nothing else is accepted.
    if (typeof url !== 'string' || !url.startsWith(ios ? 'file://' : 'content://')) return
    const now = Date.now()
    if (url === last.url && now - last.at < 4000) return // the same file reported twice
    last = { url, at: now }
    try {
      const res = await fetch(cap.convertFileSrc(url))
      if (!res.ok) throw new Error(`status ${res.status}`)
      const blob = await res.blob()
      const base = decodeURIComponent(url.split('?')[0].split('/').pop() || '')
      const name = /\.epub$/i.test(base) ? base : 'Shared book.epub'
      const books = await importFiles([new File([blob], name, { type: 'application/epub+zip' })])
      if (books.length === 1) goRead(books[0].id)
    } catch {
      toast('Could not open that file.')
    }
  }
  // Files opened before this point (a cold start) are held until the listener exists.
  app.addListener('appUrlOpen', e => open(e?.url))
}

function initIOSHint() {
  const ua = navigator.userAgent
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches
  if (isNative || !iOS || standalone || getFlag('iosHintDismissed', false)) return
  $('#ios-hint').hidden = false
  $('#ios-hint-close').addEventListener('click', () => { $('#ios-hint').hidden = true; setFlag('iosHintDismissed', true) })
}

// Phone app: keep the status bar icons readable on whichever page color is showing.
function initNativeStatusBar() {
  const bar = window.Capacitor?.Plugins?.StatusBar
  const meta = document.querySelector('meta[name="theme-color"]')
  if (!bar || !meta) return
  const apply = () => {
    const m = /^#([0-9a-f]{6})$/i.exec(meta.content || '')
    if (!m) return
    const n = parseInt(m[1], 16)
    const lum = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
    // 'DARK' means light icons, for dark backgrounds.
    bar.setStyle({ style: lum < 0.5 ? 'DARK' : 'LIGHT' }).catch(() => {})
  }
  new MutationObserver(apply).observe(meta, { attributes: true, attributeFilter: ['content'] })
  apply()
}

// ---------------------------------------------------------------- welcome screen

function fillSplash() {
  const { name } = getSettings()
  $('.splash-hello').textContent = name ? 'Welcome,' : 'Welcome'
  const host = $('#splash-name')
  host.replaceChildren(...(name ? [document.createTextNode(name), el('span', { class: 'splash-dot', 'aria-hidden': 'true' })] : []))
  // Long names get a smaller size so they stay on one line.
  const width = Math.min(window.innerWidth, 1400) * 0.82
  host.style.setProperty('--splash-size', `${Math.round(Math.max(36, Math.min(150, width / (0.64 * Math.max(name.length + 1, 5)))))}px`)
}

async function hideSplash() {
  const splash = $('#splash')
  if (!splash) return
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const minimum = reduced ? 400 : 1700 // long enough to read, short enough not to nag
  await new Promise(r => setTimeout(r, Math.max(0, minimum - (performance.now() - splashStart))))
  splash.classList.add('done')
  setTimeout(() => splash.remove(), 700)
}

// ---------------------------------------------------------------- settings sheet

function initSettingsSheet() {
  const seg = $('#set-appearance')
  seg.replaceChildren(...Object.entries(APPEARANCES).map(([key, label]) => el('label', {},
    el('input', { type: 'radio', name: 'set-appearance', value: key, onchange: () => setSettings({ appearance: key }) }),
    el('span', { text: label }))))
  const name = $('#set-name')
  name.addEventListener('input', () => setSettings({ name: name.value }))
  const sync = () => {
    const s = getSettings()
    for (const r of $$('input[name="set-appearance"]')) r.checked = r.value === s.appearance
    if (document.activeElement !== name) name.value = s.name
  }
  onSettings(sync)
  sync()
  $('#open-settings').addEventListener('click', () => showSheet('sheet-settings'))
}

// ---------------------------------------------------------------- boot

async function boot() {
  applyAppMode()
  fillSplash()
  try {
    await openDB()
  } catch (e) {
    $('#empty').hidden = false
    $('#empty h2').textContent = 'Storage is unavailable'
    $('#empty p').textContent = e.message || 'This browser is blocking local storage, so Quire cannot keep books. Private browsing often does this.'
    for (const b of $$('[data-action="add"]')) b.disabled = true
    hideSplash()
    return
  }

  initLibrary({ onOpen: goRead, onAdd: pickFiles })
  initReader({ exit: goLibrary })
  $('#file-input').addEventListener('change', e => importFiles(e.target.files))

  for (const b of $$('[data-close]')) b.addEventListener('click', () => closeSheet())
  $('#scrim').addEventListener('click', () => closeSheet())
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isSheetOpen()) { e.preventDefault(); closeSheet() } })

  window.addEventListener('popstate', () => { handleSheetPop() })
  window.addEventListener('hashchange', () => route())
  onSystemThemeChange(() => { if (!isReading()) applyAppMode() })
  onSettings(() => { if (!isReading()) applyAppMode() })
  initSettingsSheet()

  initDrop()
  initFileHandling()
  initIOSHint()
  initNativeStatusBar()

  if (!location.hash) history.replaceState(history.state, '', '#/')
  await route()
  hideSplash()
  initNativeOpen() // last, so the library is ready for a book that launched the app
}

boot()
