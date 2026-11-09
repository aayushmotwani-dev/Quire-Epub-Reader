import { makeBook } from '../vendor/foliate-js/view.js'
import { Overlayer } from '../vendor/foliate-js/overlayer.js'
import * as CFI from '../vendor/foliate-js/epubcfi.js'
import * as db from './db.js'
import { loadBookFile } from './importer.js'
import { guardBook } from './sanitize.js'
import { readingCSS, themeVars } from './reading-style.js'
import { getSettings, setSettings, effectiveTurn, systemWantsStill, onSettings, resolveThemeKey, onSystemThemeChange, applyAppMode, THEMES, FONTS, MARGINS, LIMITS, TURNS, PAGES, SPEED_FACTOR } from './settings.js'
import { lookup, lookupable, speak, canSpeak } from './dictionary.js'
import { el, $, $$, ICONS, iconButton, toast, showSheet, closeSheet, isSheetOpen, openSheetId, noteDialog, langMap, formatMinutes, isTouch, isCompact } from './ui.js'
import { fillSegBar } from './library.js'
import { exportHighlights } from './export.js'
import { canFlip, flipPage, isFlipping, warmUpCurl } from './pageflip.js'

export const HIGHLIGHT_COLORS = {
  yellow: { label: 'Yellow', value: '#f2c94c' },
  green: { label: 'Green', value: '#7ccf8a' },
  blue: { label: 'Blue', value: '#6fa8f5' },
  pink: { label: 'Pink', value: '#f28bb3' },
  purple: { label: 'Purple', value: '#b794f4' },
}

let R = null // the open book's state; null when the library is showing
let onExit = () => {}

export const isReading = () => !!R

export function initReader({ exit }) {
  onExit = exit
  $('#r-back').addEventListener('click', () => onExit())
  $('#r-toc').addEventListener('click', () => openContents())
  $('#r-search').addEventListener('click', () => openSearch())
  $('#r-mark').addEventListener('click', () => toggleBookmark())
  $('#r-aa').addEventListener('click', () => openAppearance())
  $('#r-full').addEventListener('click', () => toggleFullscreen())
  $('#r-jump').addEventListener('click', () => { R?.view.history.back(); hideJump() })
  document.addEventListener('fullscreenchange', syncFullscreenIcon)
  $('#r-full').hidden = !document.fullscreenEnabled || isTouch()

  const scrub = $('#r-scrub')
  scrub.addEventListener('input', () => { previewScrub(parseFloat(scrub.value)); showScrubTip(parseFloat(scrub.value)) })
  scrub.addEventListener('change', () => { commitScrub(parseFloat(scrub.value)); hideScrubTip(700) })
  scrub.addEventListener('pointerdown', () => { if (R) { R.scrubbing = true; showScrubTip(parseFloat(scrub.value)) } })
  for (const type of ['pointerup', 'pointercancel']) scrub.addEventListener(type, () => hideScrubTip(700))
  scrub.addEventListener('blur', () => { if (R) R.scrubbing = false; hideScrubTip(0) })
  // With a mouse, hovering over the bar shows where each point would take you.
  scrub.addEventListener('pointermove', e => {
    if (!R || e.pointerType !== 'mouse' || e.buttons) return
    const r = scrub.getBoundingClientRect(), thumb = 18
    showScrubTip((e.clientX - r.left - thumb / 2) / (r.width - thumb))
  })
  scrub.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !R?.scrubbing) hideScrubTip(0) })

  $('#search-form').addEventListener('submit', e => { e.preventDefault(); runSearch($('#search-input').value) })
  $('#search-input').addEventListener('input', e => { if (!e.target.value) clearSearch() })

  for (const tab of $$('#toc-tabs [role="tab"]')) tab.addEventListener('click', () => selectTab(tab.dataset.tab))

  buildAppearanceSheet()
  onSettings(() => R && applySettings())
  onSystemThemeChange(() => R && applySettings())

  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', () => hideSelectionPop())
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveProgress(true) })
  window.addEventListener('pagehide', () => saveProgress(true))

}

// ---------------------------------------------------------------- open / close

export async function openBook(id) {
  if (R) await closeBook({ silent: true })
  const record = await db.get('books', id)
  const file = record ? await loadBookFile(id) : null
  if (!record || !file) {
    toast('That book is no longer in your library')
    return false
  }

  let book
  try {
    book = await makeBook(file)
  } catch {
    toast('This book could not be opened. The file may be damaged.')
    return false
  }
  guardBook(book)

  const view = document.createElement('foliate-view')
  view.setAttribute('autohide-cursor', '')
  R = {
    id, record, book, view,
    docs: new Map(),          // section index -> document
    annotations: new Map(),   // cfi -> highlight record
    bookmarks: [],
    location: null,
    chromeOn: true,
    scrubbing: false,
    marks: [],
    jumpTurns: 0,
    saveTimer: 0,
    selection: null,
    popToken: 0,
    lastAnnotationClick: 0,
    searchGen: 0,
  }

  $('#r-title').textContent = record.title
  document.title = `${record.title} · Quire`
  $('#reader').dataset.fixed = record.fixedLayout ? 'true' : 'false'
  wireView(view)
  $('#stage').replaceChildren(view)

  try {
    await view.open(book)
  } catch {
    $('#stage').replaceChildren()
    R = null
    toast('This book could not be opened. The file may be damaged.')
    return false
  }

  view.renderer.addEventListener?.('scroll', scheduleTurnFx)
  applySettings()
  const stored = await db.annotationsFor(id)
  for (const a of stored) {
    if (a.type === 'highlight') R.annotations.set(a.cfi, a)
    else if (a.type === 'bookmark') R.bookmarks.push(a)
  }
  R.bookmarks.sort(byFraction)

  // Right-to-left books progress from the right, like Play Books.
  // Only the bar flips; the labels are interface text and stay left to right.
  $('#r-bottom .scrub').dir = book.dir === 'rtl' ? 'rtl' : 'ltr'
  R.marks = chapterMarks()
  buildTOC()

  try {
    await view.init({ lastLocation: record.cfi, showTextStart: !record.cfi })
  } catch {
    await view.init({ showTextStart: true }).catch(() => view.next())
  }
  setChrome(true)
  R.hideTimer = setTimeout(() => setChrome(false), 2200)
  db.updateBook(id, { openedAt: Date.now(), marks: R.marks }).catch(() => {})
  return true
}

export async function closeBook({ silent = false } = {}) {
  if (!R) return
  const r = R
  clearTimeout(r.hideTimer)
  await saveProgress(true)
  closeSheet({ silent: true })
  hideSelectionPop()
  hideJump()
  r.view.close()
  r.view.remove()
  $('#stage').replaceChildren()
  $('#toc-list').replaceChildren()
  $('#search-results').replaceChildren()
  $('#search-input').value = ''
  R = null
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  document.title = 'Quire'
  $('#ribbon').classList.remove('on')
  $('#turn-fx').style.opacity = '0'
  applyAppMode() // back to the app's own light or dark
}

function wireView(view) {
  new ResizeObserver(() => requestAnimationFrame(() => requestAnimationFrame(fillMarginals))).observe(view)
  // Clicks on the page margins (outside the book's iframe) land here.
  view.addEventListener('click', e => onTap(e.clientX, null, undefined, e.detail))
  view.addEventListener('wheel', onWheel, { passive: false })
  installSwipeFlip(view, document) // swipes on the page margins, outside the book's frame
  view.addEventListener('load', e => onSectionLoad(e.detail))
  view.addEventListener('relocate', e => onRelocate(e.detail))
  view.addEventListener('create-overlay', e => {
    const { index } = e.detail
    for (const a of R.annotations.values()) {
      if (a.index === index) view.addAnnotation({ value: a.cfi, color: a.color })
    }
  })
  view.addEventListener('draw-annotation', e => {
    const { draw, annotation } = e.detail
    const color = HIGHLIGHT_COLORS[annotation.color]?.value ?? HIGHLIGHT_COLORS.yellow.value
    draw(Overlayer.highlight, { color })
  })
  view.addEventListener('show-annotation', e => {
    R.lastAnnotationClick = performance.now()
    const a = R.annotations.get(e.detail.value)
    if (a) showSelectionPop({ range: e.detail.range, index: e.detail.index, existing: a })
  })
  view.addEventListener('external-link', e => {
    e.preventDefault() // we open it ourselves, without giving the page a handle on us
    const href = e.detail.a.getAttribute('href') || ''
    if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer')
  })
  view.addEventListener('link', e => {
    let index
    try { index = view.resolveNavigation(e.detail.href)?.index } catch { index = undefined }
    if (!Number.isInteger(index)) return
    R.jumpTurns = 0
    R.jumpIndex = index
    R.pendingJump = true
  })
}

function onSectionLoad({ doc, index }) {
  R.docs.set(index, doc)
  installSwipeFlip(doc.defaultView, doc)
  if (canFlip() && !R.curlReady) { R.curlReady = true; setTimeout(warmUpCurl, 600) } // so the first flip starts at once
  doc.addEventListener('keydown', onKey)
  doc.addEventListener('click', e => {
    const frame = doc.defaultView.frameElement?.getBoundingClientRect()
    onTap((frame?.left ?? 0) + e.clientX, e.target, doc, e.detail)
  })
  doc.addEventListener('wheel', onWheel, { passive: false })
  doc.addEventListener('mousemove', e => {
    const frame = doc.defaultView.frameElement?.getBoundingClientRect()
    onPointerMove((frame?.top ?? 0) + e.clientY)
  })
  const check = () => checkSelection(doc, index)
  doc.addEventListener('pointerup', () => setTimeout(check, 10))
  doc.addEventListener('keyup', e => { if (e.shiftKey) check() })
  // Touch selection handles only report through selectionchange.
  let t
  doc.addEventListener('selectionchange', () => { clearTimeout(t); t = setTimeout(check, isTouch() ? 450 : 250) })
}

// ---------------------------------------------------------------- settings

function applySettings() {
  const s = getSettings()
  if (R) R.pageStats = null // font, size or margins may have changed: measure pages again
  const themeKey = resolveThemeKey(s)
  const vars = themeVars(themeKey)
  const reader = $('#reader')
  for (const [k, v] of Object.entries(vars)) reader.style.setProperty(k, v)
  reader.dataset.pageTheme = themeKey
  reader.classList.toggle('focus', !!s.focus)
  reader.dataset.dark = THEMES[themeKey].dark ? 'true' : 'false'
  // Sheets and dialogs take the page's light or dark, not the device's.
  const root = document.documentElement
  root.dataset.ui = THEMES[themeKey].dark ? 'dark' : 'light'
  root.dataset.pageTheme = themeKey
  root.dataset.fixed = R.view.isFixedLayout ? 'true' : 'false'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEMES[themeKey].bg)
  window.quireNative?.setChromeColor?.(THEMES[themeKey].bg)
  document.body.style.background = THEMES[themeKey].bg

  const { renderer } = R.view
  if (!R.view.isFixedLayout) {
    renderer.setAttribute('flow', s.flow)
    renderer.setAttribute('gap', `${MARGINS[s.margin]}%`)
    renderer.setAttribute('margin', isCompact() ? '44px' : '56px')
    // One page uses the whole window width (the margin slider sets the side space).
    renderer.setAttribute('max-inline-size', s.pages === 'one' ? '4000px' : `${Math.round(s.size * 36)}px`)
    renderer.setAttribute('max-column-count', s.pages === 'one' ? '1' : '2')
    const turn = effectiveTurn(s)
    renderer.toggleAttribute('animated', turn !== 'none')
    // "Page flip" without a page picture (a browser): a slower slide with a shadow along the moving edge.
    renderer.setAttribute('turn-duration', String(Math.round((turn === 'page' ? 520 : 300) * SPEED_FACTOR[s.speed])))
    renderer.setAttribute('turn-ease', turn === 'page' ? 'in-out' : 'out')
    R.fxOn = turn === 'page'
    renderer.setStyles?.(readingCSS(s, themeKey))
    setTimeout(fillMarginals, 300)
  }
  syncAppearanceSheet()
}

// ---------------------------------------------------------------- page-turn shadow
// The engine slides the page strip. While two pages are both partly visible,
// a soft shadow and a lit edge run along the seam, so it reads as paper moving
// over paper. It follows the real scroll position, so dragging a finger and
// the animated snap both get the same effect.

let fxFrame = 0
function scheduleTurnFx() { if (!fxFrame) fxFrame = requestAnimationFrame(updateTurnFx) }

function updateTurnFx() {
  fxFrame = 0
  const fx = $('#turn-fx')
  const r = R?.view?.renderer
  const hide = () => { fx.style.opacity = '0' }
  if (!R || !R.fxOn || !r || R.view.isFixedLayout || r.scrolled) return hide()
  const size = r.size
  if (!size) return hide()
  const frac = (r.start / size) % 1
  if (!(frac > 0.006 && frac < 0.994)) return hide()
  const box = r.getBoundingClientRect()
  const rtl = R.book.dir === 'rtl'
  const x = rtl ? size * frac : size * (1 - frac)
  fx.style.left = `${box.left + (box.width - size) / 2}px`
  fx.style.width = `${size}px`
  fx.classList.toggle('flip', rtl)
  fx.firstElementChild.style.transform = `translate3d(${rtl ? x - 120 : x}px, 0, 0)`
  fx.style.opacity = String(Math.min(1, frac * 6, (1 - frac) * 6))
}

// ---------------------------------------------------------------- relocation

function onRelocate(detail) {
  if (!R) return
  R.location = detail
  const { fraction = 0, tocItem, time, section } = detail
  const chapter = tocItem?.label?.trim() || ''
  R.chapter = chapter
  R.sectionIndex = section?.current

  // jump "Back" pill: show after a link jump, drop after a few page turns
  // The engine reports many relocations per jump (layout, fonts), so the pill
  // is dropped by user page turns (see turn) or by leaving the destination.
  if (R.pendingJump && section?.current === R.jumpIndex) { R.pendingJump = false; showJump() }
  else if (!R.pendingJump && !$('#r-jump').hidden && section?.current !== R.jumpIndex) hideJump()

  const renderer = R.view.renderer
  const fixed = R.view.isFixedLayout
  const scrolled = renderer.scrolled
  let pagesLeft = null
  if (!fixed && !scrolled && Number.isFinite(renderer.pages)) {
    const total = renderer.pages - 2
    pagesLeft = Math.max(0, total - renderer.page)
  }
  const pct = Math.floor(fraction * 100)
  const leftInChapter = pagesLeft == null
    ? (time?.section ? `${formatMinutes(time.section)} left in chapter` : '')
    : pagesLeft === 0 ? 'Last page in chapter' : `${pagesLeft} ${pagesLeft === 1 ? 'page' : 'pages'} left in chapter`

  $('#r-chapter').textContent = chapter
  $('#r-left').textContent = leftInChapter
  $('#r-pct').textContent = `${pct}%`
  $('#r-total').textContent = time?.total ? `${formatMinutes(time.total)} left in book` : ''
  if (!R.scrubbing) {
    $('#r-scrub').value = String(fraction)
    fillSegBar($('#r-segbar'), R.marks, fraction, { parts: R.partMarks })
  }
  $('#r-scrub').setAttribute('aria-valuetext', `${pct}%${chapter ? ', ' + chapter : ''}`)

  samplePages()
  R.marginal = { chapter, pct, leftInChapter, hasPages: pagesLeft != null, leftInBook: time?.total ? `${formatMinutes(time.total)} left in book` : '' }
  fillMarginals()

  syncBookmarkButton()
  hideSelectionPop()
  markCurrentTOC(tocItem?.href)
  scheduleSave()
}

// Running head and foot, like a printed page. The engine rebuilds these
// elements on every layout, so they are refilled after resizes too.
function fillMarginals() {
  const m = R?.marginal
  if (!m) return
  const renderer = R.view.renderer
  const heads = renderer.heads ?? [], feet = renderer.feet ?? []
  const s = getSettings()
  if (s.focus) { for (const x of [...heads, ...feet]) x.textContent = ''; return } // focus mode: text only
  if (heads.length === 1) heads[0].textContent = m.chapter || R.record.title
  else if (heads.length > 1) { heads[0].textContent = R.record.title; heads[heads.length - 1].textContent = m.chapter }
  // The foot: what the reader chose in Settings, Advanced. With two pages, the
  // left foot and the right foot can each say one thing.
  const pct = `${m.pct}%`
  let [one, left, right] = [m.hasPages ? m.leftInChapter : pct, pct, m.leftInChapter]
  if (s.footer === 'pages') [one, left, right] = [m.leftInChapter, '', m.leftInChapter]
  else if (s.footer === 'percent') [one, left, right] = [pct, pct, '']
  else if (s.footer === 'time') [one, left, right] = [m.leftInBook || pct, '', m.leftInBook || pct]
  else if (s.footer === 'none') [one, left, right] = ['', '', '']
  for (const f of feet) f.textContent = ''
  if (feet.length === 1) feet[0].textContent = one
  else if (feet.length > 1) { feet[0].textContent = left; feet[feet.length - 1].textContent = right }
}

function scheduleSave() {
  clearTimeout(R.saveTimer)
  R.saveTimer = setTimeout(() => saveProgress(), 900)
}

async function saveProgress(now = false) {
  if (!R?.location) return
  if (now) clearTimeout(R.saveTimer)
  const { cfi, fraction } = R.location
  if (!cfi) return
  const patch = { cfi, progress: fraction ?? 0, chapter: R.chapter || '', openedAt: Date.now() }
  const perPage = measuredPageSize()
  if (perPage) patch.pageSize = { layout: layoutKey(), perPage: Math.round(perPage) }
  // Reaching the end counts the book as read (for the reading goal).
  if ((fraction ?? 0) >= 0.995 && !(R.record.finishedAt > 0)) patch.finishedAt = Date.now()
  R.record = { ...R.record, ...patch }
  try { await db.updateBook(R.id, patch) } catch { /* storage full or blocked: keep reading */ }
}

// ---------------------------------------------------------------- input

// Every page turn the reader makes goes through here.
function turn(where) {
  if (!R) return
  // Presses during a flip are kept (up to four) and done straight after it,
  // as quicker flips, so quick readers do not lose turns.
  if (isFlipping()) { if ((R.queuedTurns ??= []).length < 4) R.queuedTurns.push(where); return }
  if (!$('#r-jump').hidden && ++R.jumpTurns > 3) hideJump()
  if (shouldFlip(where)) flipTurn(where)
  else R.view[where]()
}

// With Page flip on a phone, a sideways swipe flips the page instead of
// dragging it. The listener runs before the engine's own (capture phase on the
// window), so the engine never starts its drag. Taps, long presses (selecting
// text), pinch zoom and scroll mode are left alone.
function installSwipeFlip(target, doc) {
  if (!target || target.quireSwipe) return
  target.quireSwipe = true
  let start = null
  const active = () => R && canFlip() && R.fxOn && !R.view.isFixedLayout && !R.view.renderer.scrolled && R.book.dir !== 'rtl'
  target.addEventListener('touchstart', e => {
    start = e.touches.length === 1 && active()
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: e.timeStamp, moved: false }
      : null
  }, { capture: true, passive: true })
  target.addEventListener('touchmove', e => {
    if (!start || e.touches.length !== 1 || (globalThis.visualViewport?.scale ?? 1) > 1) { start = null; return }
    const sel = doc?.getSelection?.()
    if (sel && !sel.isCollapsed) { start = null; return } // extending a text selection
    const dx = e.touches[0].clientX - start.x, dy = e.touches[0].clientY - start.y
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) start.moved = true
    e.stopPropagation() // keep the engine from dragging the page
    if (Math.abs(dx) > Math.abs(dy)) e.preventDefault()
  }, { capture: true, passive: false })
  target.addEventListener('touchend', e => {
    const s = start
    start = null
    if (!s) return
    // The engine snaps the page back into place after every touch, with an
    // animation that would undo the flip's move. It never dragged, so it has
    // nothing to snap: keep the end of the touch from it.
    e.stopPropagation()
    if (!s.moved) return // a tap: the click handler turns the page
    const t = e.changedTouches[0]
    const dx = t.clientX - s.x, dy = t.clientY - s.y
    if (Math.abs(dx) > 34 && Math.abs(dx) > Math.abs(dy) * 1.3 && e.timeStamp - s.t < 900) {
      if (R?.chromeOn) setChrome(false)
      turn(dx < 0 ? 'goRight' : 'goLeft')
    }
  }, { capture: true })
}

// The desktop and phone apps can turn the page over like paper (see pageflip.js).
function shouldFlip(where) {
  if (!canFlip() || !R.fxOn) return false
  const r = R.view.renderer
  if (R.view.isFixedLayout || r.scrolled || R.book.dir === 'rtl') return false
  if (R.chromeOn || !$('#sel-pop').hidden || isSheetOpen() || document.querySelector('dialog[open]')) return false
  if ((globalThis.visualViewport?.scale ?? 1) !== 1) return false // pinch-zoomed: the picture would not line up
  const forward = where === 'next' || where === 'goRight'
  return !(forward ? r.atEnd : r.atStart) // nothing to turn to: let the engine decide
}

async function flipTurn(where) {
  const reader = R
  const r = reader.view.renderer
  const box = r.getBoundingClientRect()
  const size = r.size
  const theme = THEMES[resolveThemeKey(getSettings())]
  let moved = false
  try {
    await flipPage({
      rect: { left: box.left + (box.width - size) / 2, top: box.top, width: size, height: box.height },
      columns: Math.max(1, Math.min(2, r.heads?.length || 1)),
      forward: where === 'next' || where === 'goRight',
      paper: theme.bg,
      dark: !!theme.dark,
      host: $('#reader'),
      quick: !!reader.queuedTurns?.length,
      speed: SPEED_FACTOR[getSettings().speed] ?? 1,
      perform: async () => {
        const animated = r.hasAttribute('animated')
        r.removeAttribute('animated')
        moved = true
        try { await reader.view[where]() } finally { r.toggleAttribute('animated', animated) }
      },
    })
  } catch { /* fall through */ }
  // The flip could not start (no picture): turn the usual way. Never turn twice.
  if (!moved && R === reader) reader.view[where]()
  if (R === reader && reader.queuedTurns?.length) turn(reader.queuedTurns.shift())
}

function setChrome(on) {
  if (!R) return
  clearTimeout(R.hideTimer)
  if (on) setIdle(false)
  R.chromeOn = on
  $('#reader').classList.toggle('chrome-on', on)
  $('#r-top').inert = !on
  $('#r-bottom').inert = !on
  if (!on) hideSelectionPop()
}

let tapTimer = 0
function onTap(x, target, doc, detail = 1) {
  if (!R) return
  // A second click of a double-click (selecting a word) must not also turn the page.
  clearTimeout(tapTimer)
  if (detail > 1) return
  if (target?.closest?.('a[href]')) return
  if (performance.now() - R.lastAnnotationClick < 400) return
  const sel = doc?.getSelection?.()
  if (sel && !sel.isCollapsed && sel.toString().trim()) return
  if (!$('#sel-pop').hidden) { hideSelectionPop(); return }
  // A mouse waits a moment to see if a double-click follows; a finger acts at once.
  // A highlight's own click handler may be running too.
  tapTimer = setTimeout(() => {
    if (!R || performance.now() - R.lastAnnotationClick < 400) return
    const s2 = doc?.getSelection?.()
    if (s2 && !s2.isCollapsed && s2.toString().trim()) return
    if (R.chromeOn) { setChrome(false); return }
    const w = window.innerWidth
    const scrolled = R.view.renderer.scrolled
    // Left edge: back, or forward for one-handed reading (Settings, Advanced).
    const leftGo = getSettings().leftTap === 'forward' ? (R.book.dir === 'rtl' ? 'goLeft' : 'goRight') : 'goLeft'
    if (!scrolled && x < w * 0.28) turn(leftGo)
    else if (!scrolled && x > w * 0.72) turn('goRight')
    else setChrome(true)
  }, isTouch() ? 0 : 260)
}

let hoverShown = false
function onPointerMove(y) {
  wakePointer()
  window.dispatchEvent(new CustomEvent('quire-pointer', { detail: y })) // full window: the X at the top
  // Focus mode: the menu only comes with a click in the middle (or Esc / Space-free keys).
  if (!R || isTouch() || isSheetOpen() || getSettings().focus) return
  const h = window.innerHeight
  const nearEdge = y < 72 || y > h - 96
  if (nearEdge && !R.chromeOn) { hoverShown = true; setChrome(true) }
  else if (!nearEdge && R.chromeOn && hoverShown) { hoverShown = false; R.hideTimer = setTimeout(() => setChrome(false), 500) }
}
document.addEventListener('mousemove', e => { if (R && e.target.closest?.('#reader')) onPointerMove(e.clientY) })

// Focus mode hides the mouse pointer while you read; any movement brings it back.
let idleTimer = 0
function wakePointer() {
  clearTimeout(idleTimer)
  setIdle(false)
  if (R && getSettings().focus && !isTouch()) idleTimer = setTimeout(() => setIdle(true), 2200)
}
function setIdle(on) {
  if (!R) return
  $('#reader').classList.toggle('idle', on && !R.chromeOn && !isSheetOpen())
  for (const doc of R.docs?.values?.() ?? []) doc.documentElement?.classList.toggle('q-idle', on && !R.chromeOn && !isSheetOpen())
}

let wheelAcc = 0, wheelLock = 0
function onWheel(e) {
  if (!R || e.ctrlKey || R.view.renderer.scrolled) return // ctrl+wheel is browser zoom
  e.preventDefault()
  const now = performance.now()
  if (now < wheelLock) return
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1 // lines, pages
  wheelAcc += (Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * unit
  if (Math.abs(wheelAcc) > 40) {
    turn(wheelAcc > 0 ? 'next' : 'prev')
    wheelAcc = 0
    wheelLock = now + 380
  }
}

function onKey(e) {
  if (!R) return
  const t = e.target
  const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); return }
  if (e.key === 'Escape') {
    // Esc leaves full window first (the browser does it); it must not also close the book.
    if (document.fullscreenElement || performance.now() - fullscreenLeftAt < 500) { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); return }
    if (!$('#sel-pop').hidden) { hideSelectionPop(); return }
    if (isSheetOpen() || document.querySelector('dialog[open]')) return // the sheet handles it
    if (R.chromeOn) { setChrome(false); return }
    onExit()
    return
  }
  if (typing || mod || e.altKey || isSheetOpen() || document.querySelector('dialog[open]')) return
  const scrolled = R.view.renderer.scrolled
  switch (e.key) {
    case 'ArrowLeft': e.preventDefault(); turn('goLeft'); break
    case 'ArrowRight': e.preventDefault(); turn('goRight'); break
    case 'ArrowUp': if (!scrolled) { e.preventDefault(); turn('prev') } break
    case 'ArrowDown': if (!scrolled) { e.preventDefault(); turn('next') } break
    case 'PageUp': e.preventDefault(); turn('prev'); break
    case 'PageDown': e.preventDefault(); turn('next'); break
    case ' ': if (!scrolled) { e.preventDefault(); turn(e.shiftKey ? 'prev' : 'next') } break
    case 'b': case 'B': toggleBookmark(); break
    case 't': case 'T': openContents(); break
    case 'f': case 'F': toggleFullscreen(); break
  }
}

let fullscreenLeftAt = -1e9
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) fullscreenLeftAt = performance.now() })

function toggleFullscreen() {
  if (!document.fullscreenEnabled) return
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  else document.documentElement.requestFullscreen().catch(() => {})
}
function syncFullscreenIcon() {
  const b = $('#r-full')
  const on = !!document.fullscreenElement
  b.replaceChildren()
  b.insertAdjacentHTML('afterbegin', on ? ICONS.shrink : ICONS.expand)
  b.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen')
  b.title = b.getAttribute('aria-label')
}

// ---------------------------------------------------------------- scrubber

function previewScrub(f) {
  if (!R) return
  R.scrubbing = true
  fillSegBar($('#r-segbar'), R.marks, f, { parts: R.partMarks })
  $('#r-pct').textContent = `${Math.floor(f * 100)}%`
  $('#r-chapter').textContent = chapterAt(f) || R.chapter || ''
}
async function commitScrub(f) {
  if (!R) return
  R.scrubbing = false
  hideJump()
  await R.view.goToFraction(f)
}

// Top-level chapters as fractions of the book, for the segmented bar.
// Chapters and parts from the book's own table of contents, as fractions of
// the book, for the segmented bar and the label above it. A book with parts
// ("Part One", each holding chapters) gets wider gaps between its parts.
function chapterMarks() {
  const { view, book } = R
  const fractions = view.getSectionFractions()
  let items = book.toc ?? []
  // One entry wrapping everything (often the book's own title): look inside.
  for (let i = 0; i < 3 && items.length === 1 && items[0].subitems?.length > 1; i++) items = items[0].subitems
  const where = item => {
    try {
      const { index } = view.resolveNavigation(item.href) ?? {}
      return Number.isInteger(index) && fractions[index] != null ? fractions[index] : null
    } catch { return null } // unresolvable entry
  }
  // An entry is a part when its chapters start in at least two different
  // files. Entries whose sub-entries are only headings inside one file are
  // chapters, and their headings are left out.
  const spread = item => new Set((item.subitems ?? []).map(where).filter(x => x != null)).size
  const hasParts = items.length >= 2 && items.filter(i => spread(i) >= 2).length >= 2
  if (!hasParts && items.length <= 2 && items[0] && spread(items[0]) > 2) items = items.flatMap(i => [i, ...(i.subitems ?? [])])
  const marks = [], parts = []
  R.chapterIndex = []
  for (const item of items) {
    const label = item.label?.trim() || ''
    const f = where(item)
    if (hasParts && spread(item) >= 2) {
      const starts = item.subitems.map(where).filter(x => x != null)
      const partStart = f ?? (starts.length ? Math.min(...starts) : null)
      if (partStart == null) continue
      parts.push(partStart)
      R.chapterIndex.push({ fraction: partStart, label, part: label })
      for (const sub of item.subitems) {
        const sf = where(sub)
        if (sf == null) continue
        marks.push(sf)
        R.chapterIndex.push({ fraction: sf, label: sub.label?.trim() || '', part: label })
      }
    } else if (f != null) {
      marks.push(f)
      R.chapterIndex.push({ fraction: f, label, part: null })
    }
  }
  // Several entries in one file: the first names it (the chapter, not its
  // last heading). A part's own entry gives way to its first chapter.
  const seen = new Map()
  for (const c of R.chapterIndex) {
    const key = c.fraction.toFixed(6)
    const prev = seen.get(key)
    if (!prev || (prev.label === prev.part && c.label !== c.part)) seen.set(key, c)
  }
  R.chapterIndex = [...seen.values()]
  R.chapterIndex.sort((a, b) => a.fraction - b.fraction)
  R.partMarks = parts
  return marks
}

// The entry (chapter, and its part) at fraction f.
function entryAt(f) {
  let hit = null
  for (const c of R.chapterIndex ?? []) { if (c.fraction <= f + 1e-6) hit = c; else break }
  return hit
}

// ---------------------------------------------------------------- page numbers
// A book file has no fixed pages, so Quire counts them from the layout on
// screen: how much of the book fits on one page here, measured in the
// chapters you have read. Like any e-reader, the count changes with the font
// size. Fixed-layout books (comics, picture books) count one page per page.

function linearSize(s) { return s && s.linear !== 'no' && s.size > 0 ? s.size : 0 }

function samplePages() {
  const r = R?.view?.renderer
  if (!r || R.view.isFixedLayout || r.scrolled || !Number.isFinite(r.pages)) return
  const size = linearSize(R.book.sections?.[R.sectionIndex])
  // The engine adds a blank page at each end; a spread is two pages.
  const pages = (r.pages - 2) * Math.max(1, Math.min(2, r.heads?.length || 1))
  // Short pieces (a title page, a dedication) say little about a full page.
  if (!(size > 0) || pages < 3) return
  ;(R.pageStats ??= new Map()).set(R.sectionIndex, [size, pages])
}

function pageAt(f) {
  const sections = R.book.sections ?? []
  if (R.view.isFixedLayout) {
    const fractions = R.view.getSectionFractions?.() ?? []
    const total = Math.max(1, sections.filter(linearSize).length || sections.length)
    let i = 0
    while (i + 1 < fractions.length && fractions[i + 1] <= f + 1e-9) i++
    return { page: Math.min(total, i + 1), total }
  }
  let size = 0, pages = 0
  for (const [s, p] of R.pageStats?.values() ?? []) { size += s; pages += p }
  // Until a chapter has been measured: about 1,800 letters to a page, using
  // how much of this file is text (books full of formulas or markup have far
  // fewer letters per byte). Never an absurd value either way.
  let guess = 2400
  const remembered = R.record?.pageSize
  const doc = R.docs?.get(R.sectionIndex)
  const fileSize = linearSize(sections[R.sectionIndex])
  const letters = doc?.body?.textContent?.length ?? 0
  if (fileSize > 2000 && letters > 200) guess = 1800 * (fileSize / letters)
  // The size measured last time with the same layout is better than a guess.
  if (remembered?.layout === layoutKey() && remembered.perPage > 0) guess = remembered.perPage
  const perPage = Math.max(600, Math.min(40000, pages ? size / pages : guess))
  const total = Math.max(1, Math.round(sections.reduce((a, s) => a + linearSize(s), 0) / perPage))
  return { page: Math.min(total, Math.floor(f * total) + 1), total }
}

// Pages depend on the font, size, spacing, margins, page mode and window.
function layoutKey() {
  const s = getSettings()
  return [s.font, s.size, s.lineHeight, s.margin, s.pages, s.flow, Math.round(innerWidth / 40), Math.round(innerHeight / 40)].join('|')
}
function measuredPageSize() {
  let size = 0, pages = 0
  for (const [s, p] of R?.pageStats?.values() ?? []) { size += s; pages += p }
  return pages >= 6 ? size / pages : 0
}

let tipTimer = 0
function showScrubTip(f) {
  if (!R || !Number.isFinite(f)) return
  f = Math.max(0, Math.min(1, f))
  clearTimeout(tipTimer)
  const tip = $('#scrub-tip')
  const { page, total } = pageAt(f)
  const entry = entryAt(f)
  const part = entry?.part && entry.part !== entry.label ? entry.part : ''
  $('#scrub-part').textContent = part
  $('#scrub-page').textContent = `Page ${page}`
  $('#scrub-total').textContent = `of ${total}`
  $('#scrub-chapter').textContent = entry?.label || ''
  tip.hidden = false
  // Above the point, kept inside the bar.
  const w = $('#r-scrub').clientWidth, thumb = 18
  const x = thumb / 2 + f * (w - thumb)
  const half = tip.offsetWidth / 2
  tip.style.left = `${Math.max(half, Math.min(w - half, x))}px`
  // Light up the chapter under the point.
  for (const seg of $('#r-segbar').children) seg.classList.toggle('hot', f >= +seg.dataset.start && f < +seg.dataset.end + (seg.dataset.end === '1' ? 1e-9 : 0))
  $('#r-scrub').setAttribute('aria-valuetext', `Page ${page} of ${total}${entry?.label ? ', ' + entry.label : ''}${part ? ', ' + part : ''}`)
}
function hideScrubTip(delay = 0) {
  clearTimeout(tipTimer)
  tipTimer = setTimeout(() => {
    $('#scrub-tip').hidden = true
    for (const seg of $('#r-segbar').children) seg.classList.remove('hot')
  }, delay)
}

function chapterAt(f) {
  return entryAt(f)?.label || ''
}

// ---------------------------------------------------------------- jump back

function showJump() {
  const b = $('#r-jump')
  b.hidden = false
  b.textContent = 'Back'
  b.insertAdjacentHTML('afterbegin', ICONS.back)
}
function hideJump() {
  $('#r-jump').hidden = true
  if (R) R.pendingJump = false
}

// ---------------------------------------------------------------- bookmarks

function pageBounds() {
  const cfi = R?.location?.cfi
  if (!cfi) return null
  try { return [CFI.collapse(cfi), CFI.collapse(cfi, true)] } catch { return null }
}

function bookmarkOnPage() {
  const b = pageBounds()
  if (!b) return null
  return R.bookmarks.find(m => {
    try { return CFI.compare(m.cfi, b[0]) >= 0 && CFI.compare(m.cfi, b[1]) <= 0 } catch { return false }
  }) ?? null
}

function syncBookmarkButton() {
  const on = !!bookmarkOnPage()
  const btn = $('#r-mark')
  btn.replaceChildren()
  btn.insertAdjacentHTML('afterbegin', on ? ICONS.bookmarkOn : ICONS.bookmark)
  btn.setAttribute('aria-pressed', String(on))
  btn.setAttribute('aria-label', on ? 'Remove bookmark' : 'Add bookmark')
  btn.title = btn.getAttribute('aria-label')
  $('#ribbon').classList.toggle('on', on)
}

async function toggleBookmark() {
  if (!R?.location) return
  const existing = bookmarkOnPage()
  if (existing) {
    await db.del('annotations', existing.id)
    R.bookmarks = R.bookmarks.filter(b => b.id !== existing.id)
    toast('Bookmark removed')
  } else {
    const bounds = pageBounds()
    if (!bounds) return
    const text = (R.location.range?.toString() ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)
    const mark = {
      id: crypto.randomUUID?.() ?? String(Date.now() + Math.random()),
      bookId: R.id, type: 'bookmark', cfi: bounds[0],
      fraction: R.location.fraction ?? 0, chapter: R.chapter || '', text,
      createdAt: Date.now(),
    }
    await db.put('annotations', mark)
    R.bookmarks.push(mark)
    R.bookmarks.sort(byFraction)
    toast('Page bookmarked')
  }
  syncBookmarkButton()
  if (openSheetId() === 'sheet-toc') renderBookmarks()
}

const byFraction = (a, b) => (a.fraction ?? 0) - (b.fraction ?? 0)

// ---------------------------------------------------------------- selection + highlights

function checkSelection(doc, index) {
  if (!R) return
  const sel = doc.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    if (R.selection && !R.selection.existing) hideSelectionPop()
    return
  }
  const range = sel.getRangeAt(0)
  if (!range.toString().trim()) return
  showSelectionPop({ range: range.cloneRange(), index })
}

const dictCache = new Map()

async function showSelectionPop({ range, index, existing = null }) {
  const doc = range.startContainer.ownerDocument
  const frame = doc.defaultView?.frameElement?.getBoundingClientRect()
  const rects = Array.from(range.getClientRects()).filter(r => r.width > 0.5 && r.height > 0.5)
  if (!frame || !rects.length) return
  // Keep only rects inside the visible page (multi-column documents are wide).
  const vis = rects.map(r => ({ top: r.top + frame.top, bottom: r.bottom + frame.top, left: r.left + frame.left, right: r.right + frame.left }))
    .filter(r => r.right > 0 && r.left < window.innerWidth)
  if (!vis.length) return
  const first = vis[0], last = vis[vis.length - 1]

  const text = range.toString()
  const key = `${index}:${text}:${existing?.id ?? ''}:${existing?.color ?? ''}:${existing?.note ?? ''}`
  const pop = $('#sel-pop')
  // The same selection reported again (touch handles fire often): keep what is on screen.
  if (!pop.hidden && R.selection?.key === key) { R.selection.range = range; return }

  const token = ++R.popToken
  R.selection = { range, index, existing, key }

  // One to three words get a dictionary card above the menu.
  const word = lookupable(text)
  let entry = null
  if (word) {
    entry = dictCache.get(word)
    if (!entry) {
      entry = await Promise.race([lookup(word).catch(() => null), new Promise(r => setTimeout(() => r(null), 900))])
      if (entry) dictCache.set(word, entry)
    }
    if (!R || token !== R.popToken || !R.selection || R.selection.key !== key) return // moved on while loading
  }

  const swatches = () => el('div', { class: 'swatches', role: 'group', 'aria-label': 'Highlight color' },
    ...Object.entries(HIGHLIGHT_COLORS).map(([colorKey, c]) => el('button', {
      type: 'button', class: 'swatch' + (existing?.color === colorKey ? ' on' : ''),
      style: `--c:${c.value}`, 'aria-label': `${existing ? 'Change to' : 'Highlight'} ${c.label.toLowerCase()}`,
      'aria-pressed': existing ? String(existing.color === colorKey) : null,
      onclick: () => applyHighlight(colorKey),
    })))

  const row = (icon, label, onclick, sub) => el('button', { type: 'button', class: 'pop-row', role: 'menuitem', onclick },
    el('span', { class: 'pop-ic', icon, 'aria-hidden': 'true' }),
    el('span', { class: 'pop-label' }, el('span', { text: label }), sub ? el('small', { text: sub }) : null))

  const place = () => placePop(first, last)

  // The meaning card, with the highlight colours underneath.
  const showDefine = async () => {
    if (!entry && word) entry = await lookup(word).catch(() => null)
    if (!R || R.selection?.key !== key) return
    const card = dictCard(entry ?? { word, found: false }, place)
    const bar = el('div', { class: 'pop-bar' },
      iconButton('back', 'Back', () => showMenu()),
      el('span', { class: 'pop-sep', 'aria-hidden': 'true' }),
      swatches())
    pop.classList.add('wide')
    pop.replaceChildren(card, bar)
    place()
  }

  // One line of the meaning under "Define" so a word's sense is visible at once.
  let preview = null
  if (entry?.found) {
    const g = entry.groups[0], s = g?.senses[0]
    if (s) preview = `${g.label}: ${s.definition}`
  }

  const showMenu = () => {
    const rows = [
      row('noteAdd', existing?.note ? 'Edit note' : 'Add note', () => editNote()),
      row('copy', 'Copy', () => copySelection()),
      word ? row('define', 'Define', showDefine, preview) : null,
      row('search', 'Search book', () => searchSelection()),
      existing ? row('trash', 'Remove highlight', () => removeHighlight(existing)) : null,
    ]
    pop.classList.remove('wide')
    pop.replaceChildren(el('div', { class: 'pop-menu', role: 'menu' }, ...rows.filter(Boolean)),
      el('div', { class: 'pop-colors' }, swatches()))
    place()
  }

  pop.hidden = false
  showMenu()
}

// Above the words on a mouse, below them on touch (the system menu sits above).
function placePop(first, last) {
  const pop = $('#sel-pop')
  const card = pop.querySelector('.dict')
  const gap = 12, edge = 12
  const roomAbove = first.top - 60, roomBelow = window.innerHeight - last.bottom - edge
  if (card) {
    const barH = pop.querySelector('.pop-bar')?.offsetHeight ?? 52
    const room = Math.max(roomAbove, roomBelow) - barH - gap
    card.style.maxHeight = `${Math.max(150, Math.min(340, room))}px`
  }
  const pw = pop.offsetWidth, ph = pop.offsetHeight
  let below = isTouch()
  if (below && ph + gap > roomBelow && roomAbove > roomBelow) below = false
  if (!below && ph + gap > roomAbove && roomBelow > roomAbove) below = true
  let top = below ? last.bottom + gap : first.top - ph - gap
  top = Math.max(edge, Math.min(window.innerHeight - ph - edge, top))
  let left = (below ? last.left + last.right : first.left + first.right) / 2 - pw / 2
  left = Math.max(edge, Math.min(window.innerWidth - pw - edge, left))
  pop.style.top = `${top}px`
  pop.style.left = `${left}px`
}

// The dictionary card. Everything from the dictionary goes in as text.
export function dictCard(entry, relayout = () => {}) {
  const card = el('div', { class: 'dict', role: 'region', 'aria-label': 'Dictionary' })
  if (!entry.found) {
    card.append(el('p', { class: 'dict-state' }, el('b', { text: entry.word }), ' is not in the dictionary.'))
    return card
  }
  let expanded = false
  const senseList = (groups, perGroup) => groups.map(g => el('section', { class: 'dict-pos' },
    el('h4', { class: 'dict-label', text: g.label }),
    el('ol', { class: 'dict-senses' }, ...g.senses.slice(0, perGroup).map(sense => el('li', { class: 'dict-sense' },
      el('p', { class: 'dict-def', text: sense.definition }),
      sense.examples[0] ? el('p', { class: 'dict-ex', text: `“${sense.examples[0]}”` }) : null,
      sense.synonyms.length ? el('p', { class: 'dict-syn' }, 'Similar: ', el('b', { text: sense.synonyms.slice(0, 5).join(', ') })) : null)))))

  const total = entry.groups.reduce((n, g) => n + g.senses.length, 0)
  const render = () => {
    const perGroup = expanded ? 8 : 2
    const groups = expanded ? entry.groups : entry.groups.slice(0, 3)
    const head = el('header', { class: 'dict-head' },
      el('div', {},
        el('p', { class: 'dict-word', text: entry.word }),
        entry.ipa ? el('p', { class: 'dict-ipa', text: `/${entry.ipa}/` }) : null),
      canSpeak() ? iconButton('speaker', 'Hear it', () => speak(entry.word)) : null)
    const parts = [head]
    if (entry.inflected) parts.push(el('p', { class: 'dict-from', text: entry.short ?? `Form of “${entry.lemma}”` }))
    parts.push(...senseList(groups, perGroup))
    for (const base of entry.also ?? []) {
      parts.push(el('div', { class: 'dict-base' },
        el('p', { class: 'dict-from', text: `Also, a form of “${base.lemma}”` }),
        ...senseList(base.groups, expanded ? 6 : 1)))
    }
    const more = total > groups.reduce((n, g) => n + Math.min(g.senses.length, perGroup), 0) || (!expanded && entry.groups.length > 3)
    if (more || expanded) {
      parts.push(el('button', {
        type: 'button', class: 'dict-more', text: expanded ? 'Show fewer' : `Show all ${total} meanings`,
        onclick: () => { expanded = !expanded; render(); card.scrollTop = 0; relayout() },
      }))
    }
    card.replaceChildren(...parts)
  }
  render()
  return card
}

function hideSelectionPop() {
  const pop = $('#sel-pop')
  if (pop) pop.hidden = true
  if (R) { R.selection = null; R.popToken++ }
}

async function applyHighlight(color) {
  const s = R?.selection
  if (!s) return
  if (s.existing) {
    const a = { ...s.existing, color }
    await db.put('annotations', a)
    R.annotations.set(a.cfi, a)
    await R.view.addAnnotation({ value: a.cfi, color })
  } else {
    const cfi = R.view.getCFI(s.index, s.range)
    const a = {
      id: crypto.randomUUID?.() ?? String(Date.now() + Math.random()),
      bookId: R.id, type: 'highlight', cfi, index: s.index, color,
      text: s.range.toString().replace(/[ \t]+/g, ' ').trim().slice(0, 4000),
      note: '', chapter: R.chapter || '', fraction: R.location?.fraction ?? 0,
      createdAt: Date.now(),
    }
    await db.put('annotations', a)
    R.annotations.set(cfi, a)
    await R.view.addAnnotation({ value: cfi, color })
    s.range.startContainer.ownerDocument.getSelection()?.removeAllRanges()
  }
  hideSelectionPop()
}

function searchSelection() {
  const text = (R?.selection?.range.toString() ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  hideSelectionPop()
  if (!R) return
  openSearch()
  if (text.length >= 2) { $('#search-input').value = text; runSearch(text) }
}

async function editNote() {
  const s = R?.selection
  if (!s) return
  if (!s.existing) {
    await applyHighlight('yellow')
    const cfi = R.view.getCFI(s.index, s.range)
    s.existing = R.annotations.get(cfi)
  }
  const a = s.existing
  hideSelectionPop()
  if (!a) return
  const note = await noteDialog({ title: a.note ? 'Edit note' : 'Add note', value: a.note, quote: a.text })
  if (note === null) return
  const updated = { ...a, note }
  await db.put('annotations', updated)
  R.annotations.set(updated.cfi, updated)
  toast(note ? 'Note saved' : 'Note removed')
  if (openSheetId() === 'sheet-toc') renderHighlights()
}

async function copySelection() {
  const text = R?.selection?.range.toString() ?? ''
  hideSelectionPop()
  try {
    await navigator.clipboard.writeText(text.trim())
    toast('Copied')
  } catch {
    toast('Copying is blocked here. Select the text and use your device’s copy command.')
  }
}

async function removeHighlight(a) {
  await db.del('annotations', a.id)
  R.annotations.delete(a.cfi)
  await R.view.deleteAnnotation({ value: a.cfi })
  hideSelectionPop()
  toast('Highlight removed')
  if (openSheetId() === 'sheet-toc') renderHighlights()
}

// ---------------------------------------------------------------- contents panel

let tocItems = [] // [{ href, el }]

function buildTOC() {
  const list = $('#toc-list')
  tocItems = []
  const make = (items, depth) => el('ol', { class: 'toc-level', style: `--depth:${depth}` },
    ...items.map(item => {
      const label = langMap(item.label)?.trim() || 'Untitled'
      const btn = el('button', { type: 'button', class: 'toc-item', onclick: () => goAndClose(item.href) },
        el('span', { class: 'toc-label', text: label }))
      tocItems.push({ href: item.href, el: btn })
      return el('li', {}, btn, item.subitems?.length && depth < 3 ? make(item.subitems, depth + 1) : null)
    }))
  const toc = R.book.toc ?? []
  list.replaceChildren(toc.length ? make(toc, 0) : el('p', { class: 'panel-empty', text: 'This book has no table of contents.' }))
}

function markCurrentTOC(href) {
  for (const { href: h, el: b } of tocItems) b.classList.toggle('current', !!href && h === href)
}

function goAndClose(target) {
  closeSheet()
  hideJump()
  R?.view.goTo(target).catch(() => toast('That location could not be found in the book'))
}

function selectTab(name) {
  for (const t of $$('#toc-tabs [role="tab"]')) {
    const on = t.dataset.tab === name
    t.setAttribute('aria-selected', String(on))
    t.tabIndex = on ? 0 : -1
  }
  for (const p of $$('#sheet-toc [role="tabpanel"]')) p.hidden = p.dataset.tab !== name
  if (name === 'marks') renderBookmarks()
  if (name === 'notes') renderHighlights()
}

function openContents() {
  if (!R) return
  setChrome(false)
  showSheet('sheet-toc')
  selectTab($('#toc-tabs [aria-selected="true"]')?.dataset.tab || 'toc')
  requestAnimationFrame(() => $('#toc-list .current')?.scrollIntoView({ block: 'center' }))
}

function whenText(ts) {
  if (!ts) return ''
  const d = new Date(ts), now = new Date()
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

function renderBookmarks() {
  const host = $('#marks-list')
  if (!R.bookmarks.length) {
    host.replaceChildren(el('p', { class: 'panel-empty', text: 'No bookmarks yet. Tap the bookmark button, or press B, to keep your place on a page.' }))
    return
  }
  host.replaceChildren(...R.bookmarks.map(m => {
    const pct = Math.floor((m.fraction ?? 0) * 100)
    return el('div', { class: 'mark-card' },
      el('button', { type: 'button', class: 'mark-main', 'aria-label': `Go to bookmark in ${m.chapter || 'the book'}, ${pct} percent`, onclick: () => goAndClose(m.cfi) },
        el('span', { class: 'mark-top' },
          el('span', { class: 'mark-flag', 'aria-hidden': 'true' }),
          el('span', { class: 'mark-chapter', text: m.chapter || 'Bookmark' })),
        m.text ? el('span', { class: 'mark-text', text: m.text }) : null,
        el('span', { class: 'mark-foot' },
          el('span', { class: 'mark-where', style: `--p:${(m.fraction ?? 0).toFixed(4)}`, 'aria-hidden': 'true' }, el('i')),
          el('span', { text: `${pct}%` }),
          el('span', { text: whenText(m.createdAt) }))),
      iconButton('trash', 'Delete bookmark', async () => {
        await db.del('annotations', m.id)
        R.bookmarks = R.bookmarks.filter(b => b.id !== m.id)
        syncBookmarkButton()
        renderBookmarks()
      }))
  }))
}

function renderHighlights() {
  const host = $('#notes-list')
  const items = Array.from(R.annotations.values()).sort(byFraction)
  if (!items.length) {
    host.replaceChildren(el('p', { class: 'panel-empty', text: 'No highlights yet. Select text on any page to highlight it.' }))
    return
  }
  host.replaceChildren(
    ...items.map(a => el('div', { class: 'note-row' },
      el('button', { type: 'button', class: 'note-main', style: `--c:${HIGHLIGHT_COLORS[a.color]?.value}`, onclick: () => goAndClose(a.cfi) },
        a.chapter ? el('span', { class: 'note-chapter', text: a.chapter }) : null,
        el('span', { class: 'note-text quote', text: a.text }),
        a.note ? el('span', { class: 'note-note', text: a.note }) : null),
      iconButton('trash', 'Delete highlight', async () => {
        await db.del('annotations', a.id)
        R.annotations.delete(a.cfi)
        await R.view.deleteAnnotation({ value: a.cfi })
        renderHighlights()
      }))),
    el('button', { type: 'button', class: 'btn btn-quiet panel-foot-btn', icon: 'export', onclick: () => exportHighlights(R.record) }, el('span', { text: 'Export as Markdown' })))
}

// ---------------------------------------------------------------- search

function openSearch() {
  if (!R) return
  setChrome(false)
  showSheet('sheet-search')
  $('#search-input').select()
}

async function runSearch(query) {
  query = query.trim()
  if (!R || query.length < 2) return
  const gen = ++R.searchGen
  const host = $('#search-results')
  const status = el('p', { class: 'search-status', role: 'status', text: 'Searching…' })
  host.replaceChildren(status)
  let count = 0
  const t = THEMES[resolveThemeKey()]
  try {
    for await (const result of R.view.search({ query, drawOptions: { color: t.muted } })) {
      if (!R || gen !== R.searchGen) return
      if (result === 'done') break
      if (result.progress != null) { status.textContent = `Searching… ${Math.round(result.progress * 100)}%`; continue }
      if (!result.subitems) continue
      const group = el('section', { class: 'search-group' },
        el('h3', { class: 'search-chapter', text: result.label || 'Untitled section' }),
        ...result.subitems.map(item => {
          count++
          const { pre = '', match = '', post = '' } = item.excerpt ?? {}
          return el('button', { type: 'button', class: 'search-hit', onclick: () => goAndClose(item.cfi) },
            el('span', { text: pre }), el('mark', { text: match }), el('span', { text: post }))
        }))
      host.append(group)
    }
  } catch {
    if (gen === R?.searchGen) status.textContent = 'Search stopped because part of this book could not be read.'
    return
  }
  if (gen !== R?.searchGen) return
  status.textContent = count ? `${count} ${count === 1 ? 'result' : 'results'} for “${query}”` : `No results for “${query}”`
}

function clearSearch() {
  if (!R) return
  R.searchGen++
  R.view.clearSearch()
  $('#search-results').replaceChildren()
}

// ---------------------------------------------------------------- appearance sheet

function openAppearance() {
  if (!R) return
  setChrome(false)
  showSheet('sheet-aa')
}

function buildAppearanceSheet() {
  const themes = $('#aa-themes')
  themes.replaceChildren(...Object.entries(THEMES).map(([key, t]) => el('button', {
    type: 'button', class: 'theme-chip', dataset: { theme: key },
    style: `--bg:${t.bg};--fg:${t.fg};--line:${t.line}`,
    'aria-label': `${t.name} theme`, onclick: () => setSettings({ theme: key }),
  }, el('span', { class: 'theme-sample', 'aria-hidden': 'true', text: 'Aa' }), el('span', { class: 'theme-name', text: t.name }))))
  $('#aa-auto').addEventListener('change', e => setSettings({ theme: e.target.checked ? 'auto' : resolveThemeKey() }))

  $('#aa-smaller').addEventListener('click', () => setSettings({ size: getSettings().size - 1 }))
  $('#aa-larger').addEventListener('click', () => setSettings({ size: getSettings().size + 1 }))

  const fonts = $('#aa-fonts')
  fonts.replaceChildren(...Object.entries(FONTS).map(([key, f]) => el('label', { class: 'font-opt', dataset: { font: key } },
    el('input', { type: 'radio', name: 'aa-font', value: key, onchange: () => setSettings({ font: key }) }),
    el('span', { class: 'font-name', text: f.name }))))

  const lh = $('#aa-line')
  lh.min = LIMITS.lineHeight[0]; lh.max = LIMITS.lineHeight[1]
  lh.addEventListener('input', () => setSettings({ lineHeight: parseFloat(lh.value) }))
  const mg = $('#aa-margin')
  mg.max = MARGINS.length - 1
  mg.addEventListener('input', () => setSettings({ margin: parseInt(mg.value, 10) }))

  for (const key of ['justify', 'hyphenate', 'focus'])
    $(`#aa-${key}`).addEventListener('change', e => setSettings({ [key]: e.target.checked }))
  $('#aa-pages').replaceChildren(...Object.entries(PAGES).map(([key, label]) => el('label', {},
    el('input', { type: 'radio', name: 'aa-pages', value: key, onchange: () => setSettings({ pages: key }) }),
    el('span', { text: label }))))
  const turnIcons = { slide: 'turnSlide', page: 'turnCurl', none: 'turnNone' }
  $('#aa-turn').replaceChildren(...Object.entries(TURNS).map(([key, label]) => el('label', { class: 'menu-row' },
    el('input', { type: 'radio', name: 'aa-turn', value: key, onchange: () => setSettings({ turn: key, turnChosen: true }) }),
    el('span', { class: 'menu-check', icon: 'check' }),
    el('span', { class: 'menu-label', text: label }),
    el('span', { class: 'menu-icon', icon: turnIcons[key] }))))
  for (const r of $$('input[name="aa-flow"]')) r.addEventListener('change', () => setSettings({ flow: r.value }))
}

function syncAppearanceSheet() {
  const s = getSettings()
  const active = resolveThemeKey(s)
  for (const chip of $$('#aa-themes .theme-chip')) {
    const on = chip.dataset.theme === active
    chip.classList.toggle('on', on)
    chip.setAttribute('aria-pressed', String(on))
  }
  $('#aa-auto').checked = s.theme === 'auto'
  $('#aa-size').textContent = `${s.size}`
  $('#aa-smaller').disabled = s.size <= LIMITS.size[0]
  $('#aa-larger').disabled = s.size >= LIMITS.size[1]
  for (const r of $$('input[name="aa-font"]')) r.checked = r.value === s.font
  $('#aa-line').value = String(s.lineHeight)
  $('#aa-line-val').textContent = s.lineHeight.toFixed(2)
  $('#aa-margin').value = String(s.margin)
  for (const key of ['justify', 'hyphenate', 'focus']) $(`#aa-${key}`).checked = s[key]
  for (const r of $$('input[name="aa-pages"]')) r.checked = r.value === s.pages
  for (const r of $$('input[name="aa-turn"]')) r.checked = r.value === effectiveTurn(s)
  $('#aa-turn-note').hidden = !(systemWantsStill() && !s.turnChosen)
  for (const r of $$('input[name="aa-flow"]')) r.checked = r.value === s.flow
  $('#aa-pages-row').hidden = s.flow === 'scrolled'
  $('#aa-turn-row').hidden = s.flow === 'scrolled'
}
