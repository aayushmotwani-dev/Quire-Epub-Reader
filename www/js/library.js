import * as db from './db.js'
import { el, $, iconButton, toast, confirmDialog, showSheet } from './ui.js'
import { getFlag, setFlag } from './settings.js'
import { exportHighlights } from './export.js'
import { editBook } from './edit-book.js'
import { openDetail } from './book-detail.js'
import { openStats } from './stats-ui.js'
import { readExtraMeta, META_VERSION } from './importer.js'

const coverURLs = new Map() // book id -> object URL, revoked when the book leaves

let books = []
let query = ''
let sort = getFlag('sort', 'recent')
// Comics (CBZ and CBR files) live on their own tab. Any book can be moved by hand.
export const isComic = b => b.kind ? b.kind === 'comic' : b.format === 'cbz'
let tab = getFlag('libTab', 'books') === 'comics' ? 'comics' : 'books'
const hasComics = () => books.some(isComic)
const hasBooks = () => books.some(b => !isComic(b))
// What the shelf shows: everything, until there is something for both tabs.
const onTab = () => (hasComics() && hasBooks()) ? books.filter(b => (tab === 'comics') === isComic(b)) : books
const STATUSES = { all: 'All', reading: 'Reading', unread: 'Unread', finished: 'Finished' }
const filter = { status: 'all', author: '', genre: '', series: '', shelf: '' }
const filtering = () => filter.status !== 'all' || !!filter.author || !!filter.genre || !!filter.series || !!filter.shelf
let handlers = { open: () => {}, add: () => {}, jump: () => {} }

export function initLibrary({ onOpen, onAdd, onJump }) {
  handlers = { open: onOpen, add: onAdd, jump: onJump }
  // The top bar stays on screen; it gains its frosted ground once the page
  // has moved under it.
  const head = $('.lib-head')
  let headFrame = 0
  const markStuck = () => {
    headFrame = 0
    head.classList.toggle('stuck', window.scrollY > 4)
  }
  window.addEventListener('scroll', () => { if (!headFrame) headFrame = requestAnimationFrame(markStuck) }, { passive: true })
  $('#open-stats').addEventListener('click', () => {
    const year = new Date().getFullYear()
    const done = books.filter(isFinished)
    openStats({ finishedTotal: done.length, finishedThisYear: done.filter(b => new Date(finishedTime(b)).getFullYear() === year).length })
  })
  // Hold a cover (or right-click it) for the book's own page.
  const grid = $('#shelf')
  let hold = 0, held = false
  const bookOf = target => { const li = target.closest?.('.book'); return li ? books.find(b => b.id === li.dataset.id) : null }
  grid.addEventListener('contextmenu', e => { const b = bookOf(e.target); if (b && e.target.closest('.book-open')) { e.preventDefault(); clearTimeout(hold); held = true; showDetail(b) } })
  grid.addEventListener('pointerdown', e => {
    held = false
    if (e.pointerType === 'mouse' || !e.target.closest('.book-open')) return
    const b = bookOf(e.target)
    clearTimeout(hold)
    hold = setTimeout(() => { if (b) { held = true; showDetail(b) } }, 520)
  })
  for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'pointermove'])
    grid.addEventListener(type, e => { if (type !== 'pointermove' || Math.abs(e.movementX) + Math.abs(e.movementY) > 6) clearTimeout(hold) })
  grid.addEventListener('click', e => { if (held) { held = false; e.preventDefault(); e.stopPropagation() } }, true)
  let searchTimer = 0
  $('#lib-search').addEventListener('input', e => {
    query = e.target.value.trim().toLowerCase()
    clearTimeout(searchTimer)
    // A large library waits a moment for the typing to pause.
    if (books.length > 150) searchTimer = setTimeout(renderShelf, 110)
    else renderShelf()
  })
  $('#f-status').replaceChildren(...Object.entries(STATUSES).map(([key, label]) => el('button', {
    type: 'button', class: 'chip', 'data-status': key, 'aria-pressed': String(key === filter.status), text: label,
    onclick: () => { filter.status = key; renderShelf() },
  })))
  for (const key of ['author', 'genre', 'series', 'shelf'])
    $(`#f-${key}`).addEventListener('change', e => { filter[key] = e.target.value; renderShelf() })
  $('#f-clear').addEventListener('click', () => { Object.assign(filter, { status: 'all', author: '', genre: '', series: '', shelf: '' }); renderShelf() })
  const sortSel = $('#lib-sort')
  sortSel.value = sort
  sortSel.addEventListener('change', e => { sort = e.target.value; setFlag('sort', sort); renderShelf() })
  for (const b of document.querySelectorAll('[data-action="add"]')) b.addEventListener('click', () => handlers.add())
  document.addEventListener('click', e => {
    const menu = $('#book-menu')
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('.book-more')) closeMenu()
  })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu() })
}

export async function refreshLibrary() {
  books = await db.getAll('books')
  const ids = new Set(books.map(b => b.id))
  for (const [id, url] of coverURLs) if (!ids.has(id)) { URL.revokeObjectURL(url); coverURLs.delete(id) }
  for (const id of tiles.keys()) if (!ids.has(id)) tiles.delete(id)
  render()
  backfillMeta()
}

export const libraryCount = () => books.length

function coverURL(book) {
  if (!book.cover?.buffer) return null
  let url = coverURLs.get(book.id)
  if (!url) {
    url = URL.createObjectURL(new Blob([book.cover.buffer], { type: book.cover.type || 'image/jpeg' }))
    coverURLs.set(book.id, url)
  }
  return url
}

// Covers are objects, so they are the one place that gets a shadow.
function cover(book, size = 'grid') {
  const url = coverURL(book)
  if (url) {
    const ratio = book.cover.width && book.cover.height ? book.cover.width / book.cover.height : 2 / 3
    return el('div', { class: `cover cover-${size}`, style: `--ratio:${ratio.toFixed(4)}` },
      el('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }))
  }
  // No cover in the file: set the title like a plain cloth binding.
  const tone = 'tone-' + (hash(book.id) % 6)
  return el('div', { class: `cover cover-${size} cover-plain ${tone}`, style: '--ratio:0.6667' },
    el('span', { class: 'plain-title', text: book.title }),
    book.author ? el('span', { class: 'plain-author', text: book.author }) : null)
}

function hash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

// A book is finished when the reader reached its end (finishedAt is the time)
// or marked it so. finishedAt 0 means it was marked not finished. Books from
// before this was recorded count as finished at their last opening.
export function isFinished(book) {
  if (book.finishedAt > 0) return true
  return book.finishedAt === undefined && book.progress >= 0.995
}
function finishedTime(book) {
  if (book.finishedAt > 0) return book.finishedAt
  return isFinished(book) ? book.openedAt || book.addedAt || 0 : 0
}

function statusText(book) {
  if (isFinished(book)) return 'Finished'
  if (!book.openedAt) return 'New'
  return `${Math.floor(book.progress * 100)}%`
}

function render() {
  const has = books.length > 0
  renderTips(has)
  $('#empty').hidden = has
  $('#shelf').hidden = !has
  renderGoal()
  renderHero()
  renderShelf()
}

// ---------------------------------------------------------------- reading goal

// Two goals: books a month and books a year. The year goal can never be
// lower than the month goal (a year holds every month).
const MAX_GOAL = 365
const okGoal = n => Number.isInteger(n) && n >= 1 && n <= MAX_GOAL
export function getGoal() {
  const g = getFlag('goal', null) ?? {}
  let month = okGoal(g.month) ? g.month : null
  let year = okGoal(g.year) ? g.year : null
  // Saved by the first version (one number for "month" or "year").
  if (month == null && year == null && okGoal(g.target)) {
    if (g.period === 'year') year = g.target
    else month = g.target
  }
  month ??= 2
  year ??= Math.min(MAX_GOAL, Math.max(24, month * 12))
  return { month, year: Math.max(year, month) }
}

function periodStart(period, now = new Date()) {
  return period === 'year'
    ? new Date(now.getFullYear(), 0, 1).getTime()
    : new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

// One row of the card: "3 of 4 books in November" and its bar.
function goalRow(label, done, target) {
  // One segment per book while the goal is small enough to count at a glance.
  const bar = el('div', { class: 'goal-bar' + (target > 24 ? ' smooth' : ''), role: 'progressbar',
    'aria-label': `Books read ${label}`, 'aria-valuemin': '0', 'aria-valuemax': String(target), 'aria-valuenow': String(Math.min(done, target)) })
  if (target > 24) bar.append(el('span', { class: 'goal-fill', style: `--fill:${Math.min(1, done / target).toFixed(4)}` }))
  else for (let i = 0; i < target; i++) bar.append(el('span', { class: 'goal-seg' + (i < done ? ' on' : '') }))
  const left = target - done
  return el('div', { class: 'goal-row' },
    el('p', { class: 'goal-count' },
      el('span', { class: 'dot-number goal-done', text: String(done) }),
      el('span', { class: 'goal-of', text: ` of ${target} ${target === 1 ? 'book' : 'books'} ${label}` })),
    bar,
    el('p', { class: 'goal-note', text: left <= 0 ? 'Goal reached.' : `${left} to go` }))
}

function renderGoal() {
  const host = $('#goal')
  host.hidden = books.length === 0
  if (host.hidden) return host.replaceChildren()
  const { month, year } = getGoal()
  const now = new Date()
  const doneMonth = books.filter(b => finishedTime(b) >= periodStart('month', now)).length
  const doneYear = books.filter(b => finishedTime(b) >= periodStart('year', now)).length
  const reading = books.filter(b => b.openedAt && !isFinished(b) && b.progress > 0.005).length
  host.replaceChildren(
    el('div', { class: 'goal-head' },
      el('h2', { id: 'goal-title', class: 'goal-title', text: 'Reading goals' }),
      el('p', { class: 'goal-reading', text: `${reading} reading now` }),
      el('button', { type: 'button', class: 'goal-edit', text: 'Change', onclick: editGoal })),
    el('div', { class: 'goal-rows' },
      goalRow(`in ${now.toLocaleDateString(undefined, { month: 'long' })}`, doneMonth, month),
      goalRow(`in ${now.getFullYear()}`, doneYear, year)))
}

function editGoal() {
  const dlg = $('#goal-dialog')
  let { month, year } = getGoal()
  const sync = () => {
    $('#goal-month').textContent = String(month)
    $('#goal-year').textContent = String(year)
    $('#goal-month-less').disabled = month <= 1
    $('#goal-month-more').disabled = month >= MAX_GOAL
    $('#goal-year-less').disabled = year <= month // never below the month goal
    $('#goal-year-more').disabled = year >= MAX_GOAL
    $('#goal-month-unit').textContent = month === 1 ? 'book a month' : 'books a month'
    $('#goal-year-unit').textContent = year === 1 ? 'book a year' : 'books a year'
  }
  const step = (which, d) => {
    if (which === 'month') {
      month = Math.max(1, Math.min(MAX_GOAL, month + d))
      year = Math.max(year, month) // a higher month goal lifts the year goal with it
    } else {
      year = Math.max(month, Math.min(MAX_GOAL, year + d))
    }
    sync()
  }
  $('#goal-month-less').onclick = () => step('month', -1)
  $('#goal-month-more').onclick = () => step('month', 1)
  $('#goal-year-less').onclick = () => step('year', -1)
  $('#goal-year-more').onclick = () => step('year', 1)
  const finish = save => {
    dlg.close()
    if (save) { setFlag('goal', { month, year }); renderGoal() }
  }
  $('#goal-save').onclick = () => finish(true)
  $('#goal-cancel').onclick = () => finish(false)
  dlg.oncancel = e => { e.preventDefault(); finish(false) }
  sync()
  dlg.showModal()
  $('#goal-save').focus()
}

function renderHero() {
  const host = $('#now')
  const current = books
    .filter(b => b.openedAt && !isFinished(b))
    .sort((a, b) => b.openedAt - a.openedAt)[0]
  host.hidden = !current
  if (!current) { setAmbient(null); return host.replaceChildren() }
  const pct = Math.floor(current.progress * 100)
  const m = current.minsLeft
  const left = Number.isFinite(m) && m > 0 ? (m < 60 ? `${m} min left` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min ` : ''}left`) : ''
  // The next unfinished book of the same series, if this one belongs to a series.
  const next = current.series && current.seriesIndex != null
    ? books.filter(b => b.series === current.series && b.id !== current.id && !isFinished(b) && (b.seriesIndex ?? -1) > current.seriesIndex).sort(bySeries)[0]
    : null
  host.replaceChildren(
    el('button', { type: 'button', class: 'now-cover', 'data-cover-of': current.id, 'aria-label': current.cover?.buffer ? `Continue reading ${current.title}` : null, onclick: e => handlers.open(current.id, e.currentTarget.querySelector('.cover')) },
      current.cover?.buffer ? null : el('span', { class: 'sr', text: 'Continue reading ' }), cover(current, 'hero')),
    el('div', { class: 'now-body' },
      el('p', { class: 'now-kicker', text: 'Continue reading' }),
      el('h2', { class: 'now-title', text: current.title }),
      current.author ? el('p', { class: 'now-author', text: current.author }) : null,
      el('div', { class: 'now-progress' },
        el('p', { class: 'dot-number', 'aria-label': `${pct} percent read` },
          el('span', { text: String(pct) }), el('span', { class: 'dot-unit', text: '%' })),
        segBar(current.marks, current.progress)),
      (current.chapter || left) ? el('p', { class: 'now-chapter', text: [(current.chapter || '').replace(/[\s.,;:]+$/, ''), left].filter(Boolean).join(', ') }) : null,
      el('div', { class: 'now-actions' },
        el('button', { type: 'button', class: 'btn btn-solid', text: 'Continue', onclick: () => handlers.open(current.id, host.querySelector('.cover')) }),
        el('button', { type: 'button', class: 'btn btn-quiet', text: 'Book page', onclick: () => showDetail(current) })),
      next ? el('p', { class: 'now-next' }, el('span', { text: `Next in ${current.series}: ` }), el('button', { type: 'button', class: 'link', text: next.title, onclick: () => showDetail(next) })) : null))
  setAmbient(current)
}

// Progress bar split at chapter boundaries (Nothing's segmented meters,
// Play Books' chapter ticks).
export function segBar(marks, progress, { interactive = false } = {}) {
  const bar = el('div', { class: 'segbar' + (interactive ? ' interactive' : ''), role: interactive ? null : 'presentation' })
  fillSegBar(bar, marks, progress)
  return bar
}

export function fillSegBar(bar, marks, progress, { parts = [] } = {}) {
  const partSet = (parts ?? []).filter(x => Number.isFinite(x) && x > 0 && x < 1).map(x => Math.round(x * 1e4) / 1e4)
  const bounds = normalizeMarks([...(Array.isArray(marks) ? marks : []), ...partSet], partSet)
  const frag = document.createDocumentFragment()
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i], end = bounds[i + 1]
    const fill = Math.max(0, Math.min(1, (progress - start) / (end - start)))
    const isPartStart = i > 0 && partSet.includes(start)
    const seg = el('span', { class: 'seg' + (isPartStart ? ' part-start' : ''), style: `flex-grow:${(end - start).toFixed(5)};--fill:${fill.toFixed(4)}` })
    seg.dataset.start = String(start)
    seg.dataset.end = String(end)
    frag.append(seg)
  }
  bar.replaceChildren(frag)
  // Many chapters: tighter gaps so the bar never grows past its box.
  const n = bounds.length - 1
  bar.style.setProperty('--seg-gap', n > 60 ? '1px' : n > 30 ? '2px' : '3px')
  bar.style.setProperty('--progress', progress.toFixed(4))
}

// Too many tiny segments read as noise; merge until each is visible.
// Part boundaries (`keep`) always stay.
function normalizeMarks(marks, keep = []) {
  let m = Array.isArray(marks) ? marks.filter(x => Number.isFinite(x) && x > 0 && x < 1) : []
  m = [0, ...new Set(m.map(x => Math.round(x * 1e4) / 1e4)), 1].sort((a, b) => a - b)
  const minGap = 0.012
  const out = [0]
  for (const x of m.slice(1)) {
    const last = out[out.length - 1]
    if (x === 1 || x - last >= minGap) out.push(x)
    else if (keep.includes(x) && !keep.includes(last) && out.length > 1) out[out.length - 1] = x // a part start wins over a chapter
  }
  if (out.length > 2 && out[out.length - 1] - out[out.length - 2] < minGap && !keep.includes(out[out.length - 2])) out.splice(out.length - 2, 1)
  return out
}

const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true })
const bySeries = (a, b) => (a.seriesIndex ?? 1e9) - (b.seriesIndex ?? 1e9) || byTitle(a, b)
const SORTERS = {
  recent: (a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt),
  title: byTitle,
  author: (a, b) => (a.author || '￿').localeCompare(b.author || '￿', undefined, { sensitivity: 'base' }) || byTitle(a, b),
  added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
}
const statusOf = b => isFinished(b) ? 'finished' : b.openedAt ? 'reading' : 'unread'

function sorted() {
  const list = onTab().filter(b => {
    if (query && !(b.title.toLowerCase().includes(query) || b.author.toLowerCase().includes(query) || (b.series || '').toLowerCase().includes(query))) return false
    if (filter.status !== 'all' && statusOf(b) !== filter.status) return false
    if (filter.author && b.author !== filter.author) return false
    if (filter.genre && !(b.genres || []).includes(filter.genre)) return false
    if (filter.series && b.series !== filter.series) return false
    if (filter.shelf && !(b.shelves || []).includes(filter.shelf)) return false
    return true
  })
  return list.sort(filter.series ? bySeries : SORTERS[sort] ?? SORTERS.recent)
}

// One book on a shelf. `inSeries` shows its number in place of the author.
// Tiles are kept and reused while the book's record is the same object, so
// searching, sorting and filtering a large library only moves existing tiles.
const tiles = new Map()
function tile(book, { inSeries = false, fresh = false } = {}) {
  if (fresh) return buildTile(book, inSeries) // a second copy, for a book that stands on two shelves
  const kept = tiles.get(book.id)
  if (kept && kept.book === book && kept.inSeries === inSeries) return kept.node
  const node = buildTile(book, inSeries)
  tiles.set(book.id, { book, inSeries, node })
  return node
}

function buildTile(book, inSeries) {
  const num = inSeries && book.seriesIndex != null ? `Book ${book.seriesIndex}` : ''
  return el('li', { class: 'book' + (isFinished(book) ? ' is-done' : ''), 'data-id': book.id, style: `--p:${Math.max(0, Math.min(1, book.progress || 0))}` },
    // A picture cover needs a spoken name; a typeset one already shows its title, so it only gets the word "Open".
    el('button', { type: 'button', class: 'book-open', 'aria-label': book.cover?.buffer ? `Open ${book.title}` : null, onclick: e => handlers.open(book.id, e.currentTarget.querySelector('.cover')) },
      book.cover?.buffer ? null : el('span', { class: 'sr', text: 'Open ' }), cover(book)),
    el('div', { class: 'book-meta' },
      el('p', { class: 'book-title', text: book.title, title: book.title }),
      iconButton('more', `More for ${book.title}`, e => openMenu(e.currentTarget, book), { class: 'book-more' })),
    el('p', { class: 'book-sub' },
      el('span', { class: 'book-author', text: num || book.author || 'Unknown author' }),
      el('span', { class: 'book-status' + (!book.openedAt ? ' is-new' : ''), text: statusText(book) })),
    (book.openedAt && !isFinished(book) && book.progress > 0.005) ? el('span', { class: 'book-bar', 'aria-hidden': 'true' }, el('i')) : null)
}

// The filter menus list what is actually in the library, with counts.
function fillSelect(id, label, values, current) {
  const sel = $(id)
  const counts = new Map()
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1)
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  sel.replaceChildren(el('option', { value: '', text: label }), ...names.map(n => el('option', { value: n, text: `${n} (${counts.get(n)})` })))
  sel.value = counts.has(current) ? current : ''
  sel.closest('.filter-select').hidden = names.length < (id === '#f-author' ? 2 : 1)
  sel.closest('.filter-select').classList.toggle('is-on', !!sel.value)
  return sel.value
}

function renderTabs() {
  const both = hasComics() && hasBooks()
  const host = $('#lib-tabs')
  host.hidden = !both
  if (!both) return
  const comics = books.filter(isComic).length, other = books.length - comics
  host.replaceChildren(...[['books', 'Books', other], ['comics', 'Comics', comics]].map(([key, label, n]) => el('button', {
    type: 'button', role: 'tab', class: 'lib-tab', id: `tab-${key}`, 'aria-selected': String(tab === key), tabindex: tab === key ? '0' : '-1',
    onclick: () => switchTab(key),
    onkeydown: e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); switchTab(key === 'books' ? 'comics' : 'books'); $(`#tab-${tab}`)?.focus() } },
  }, el('span', { text: label }), el('span', { class: 'count', text: String(n) }))))
}

function switchTab(key) {
  if (tab === key) return
  tab = key
  setFlag('libTab', key)
  // Filters belong to one tab; a writer or series from the other would show nothing.
  Object.assign(filter, { author: '', genre: '', series: '', shelf: '' })
  renderShelf()
}

function renderShelf() {
  renderTabs()
  const pool = onTab()
  const noun = (hasComics() && hasBooks() && tab === 'comics') || (!hasBooks() && hasComics()) ? ['comic', 'comics'] : ['book', 'books']
  $('#lib-count').textContent = pool.length === 1 ? `1 ${noun[0]}` : `${pool.length} ${noun[1]}`
  filter.author = fillSelect('#f-author', 'Author', pool.map(b => b.author), filter.author)
  filter.genre = fillSelect('#f-genre', 'Genre', pool.flatMap(b => b.genres || []), filter.genre)
  filter.series = fillSelect('#f-series', 'Series', pool.map(b => b.series), filter.series)
  filter.shelf = fillSelect('#f-shelf', 'Shelf', pool.flatMap(b => b.shelves || []), filter.shelf)
  for (const chip of $('#f-status').children) chip.setAttribute('aria-pressed', String(chip.dataset.status === filter.status))
  $('#f-clear').hidden = !filtering()
  $('.filters').hidden = pool.length < 2

  const grid = $('#grid'), shelves = $('#series-shelves'), gridTitle = $('#grid-title')
  const list = sorted()
  if (!list.length && books.length) {
    shelves.hidden = gridTitle.hidden = true
    shelves.replaceChildren()
    // The search may match on the other tab: say so, with a way there.
    const other = tab === 'comics' ? 'books' : 'comics'
    const there = query && hasComics() && hasBooks() ? books.filter(b => (other === 'comics') === isComic(b) && (b.title.toLowerCase().includes(query) || b.author.toLowerCase().includes(query) || (b.series || '').toLowerCase().includes(query))).length : 0
    grid.replaceChildren(el('li', { class: 'no-match' },
      el('span', { text: query ? `Nothing here matches “${query}”.` : `No ${noun[1]} match these filters.` }),
      there ? el('button', { type: 'button', class: 'link no-match-go', text: `${there} on ${other === 'comics' ? 'Comics' : 'Books'}`, onclick: () => switchTab(other) }) : ''))
    return
  }

  // With nothing filtered, books of one series stand together on their own shelf.
  const groups = new Map()
  if (!filtering() && !query) for (const b of list) if (b.series) groups.set(b.series, [...(groups.get(b.series) || []), b])
  const series = [...groups.entries()].filter(([, items]) => items.length >= 2)
  // Your own shelves come first. A book can stand on several of them.
  const mine = new Map()
  if (!filtering() && !query) for (const name of shelfNames()) {
    const items = list.filter(b => (b.shelves || []).includes(name))
    if (items.length) mine.set(name, items)
  }
  const placed = new Set()
  const ownRows = [...mine.entries()].map(([name, items]) => el('section', { class: 'series-shelf own-shelf', 'aria-label': `${name}, your shelf` },
    el('header', { class: 'series-head' },
      el('h3', { text: name }),
      el('span', { class: 'count', text: items.length === 1 ? '1 book' : `${items.length} books` }),
      iconButton('trash', `Remove the shelf ${name}`, () => removeShelf(name), { class: 'shelf-remove' })),
    el('ul', { class: 'shelf-row' }, ...items.map(b => { const node = tile(b, { fresh: placed.has(b.id) }); placed.add(b.id); return node }))))
  const shelved = new Set([...series.flatMap(([, items]) => items.filter(b => !placed.has(b.id)).map(b => b.id)), ...placed])
  shelves.hidden = !series.length && !ownRows.length
  shelves.replaceChildren(...ownRows, ...series.map(([name, items]) => {
    const done = items.filter(isFinished).length
    return el('section', { class: 'series-shelf', 'aria-label': `${name}, a series` },
      el('header', { class: 'series-head' },
        el('h3', { text: name }),
        el('span', { class: 'count', text: `${items.length} books${done ? `, ${done} finished` : ''}` })),
      el('ul', { class: 'shelf-row' }, ...items.sort(bySeries).map(b => tile(b, { inSeries: true, fresh: placed.has(b.id) }))))
  }))
  const rest = list.filter(b => !shelved.has(b.id))
  gridTitle.hidden = (!series.length && !ownRows.length) || !rest.length
  grid.replaceChildren(...rest.map(b => tile(b, { inSeries: !!filter.series })))
}

function openMenu(anchor, book) {
  const menu = $('#book-menu')
  if (!menu.hidden && menu.dataset.id === book.id) return closeMenu()
  menu.dataset.id = book.id
  const finished = isFinished(book)
  menu.replaceChildren(
    el('button', { type: 'button', role: 'menuitem', icon: 'contents', onclick: () => { closeMenu(); showDetail(book) } }, el('span', { text: 'Book page' })),
    book.fixedLayout ? el('button', { type: 'button', role: 'menuitem', icon: 'contents', onclick: async () => {
      closeMenu()
      const rtl = (book.dir ?? (book.rtl ? 'rtl' : 'ltr')) === 'rtl'
      await db.updateBook(book.id, { dir: rtl ? 'ltr' : 'rtl' })
      toast(rtl ? 'Pages now turn left to right' : 'Pages now turn right to left, like manga')
      await refreshLibrary()
    } }, el('span', { text: (book.dir ?? (book.rtl ? 'rtl' : 'ltr')) === 'rtl' ? 'Read left to right' : 'Read right to left (manga)' })) : '',
    el('button', { type: 'button', role: 'menuitem', icon: finished ? 'minus' : 'check', onclick: async () => {
      closeMenu()
      await db.updateBook(book.id, { finishedAt: finished ? 0 : Date.now() })
      await refreshLibrary()
      toast(finished ? 'Marked as not finished' : 'Marked as finished')
    } }, el('span', { text: finished ? 'Mark as not finished' : 'Mark as finished' })),
    el('button', { type: 'button', role: 'menuitem', icon: 'note', onclick: () => {
      closeMenu()
      edit(book)
    } }, el('span', { text: 'Edit details' })),
    el('button', { type: 'button', role: 'menuitem', icon: 'bookmark', onclick: () => { closeMenu(); chooseShelves(book) } }, el('span', { text: 'Shelves' })),
    el('button', { type: 'button', role: 'menuitem', icon: 'export', onclick: async () => {
      closeMenu()
      const toComics = !isComic(book)
      await db.updateBook(book.id, { kind: toComics ? 'comic' : 'book' })
      toast(toComics ? 'Moved to Comics' : 'Moved to Books')
      await refreshLibrary()
    } }, el('span', { text: isComic(book) ? 'Move to Books' : 'Move to Comics' })),
    el('button', { type: 'button', role: 'menuitem', icon: 'export', onclick: async () => { closeMenu(); await exportHighlights(book) } }, el('span', { text: 'Export highlights' })),
    el('button', { type: 'button', role: 'menuitem', class: 'danger', icon: 'trash', onclick: async () => { closeMenu(); await removeBook(book) } }, el('span', { text: 'Remove from library' })))
  menu.hidden = false
  const r = anchor.getBoundingClientRect()
  const mw = menu.offsetWidth, mh = menu.offsetHeight
  let left = Math.min(window.innerWidth - mw - 12, r.right - mw)
  let top = r.bottom + 6
  if (top + mh > window.innerHeight - 12) top = r.top - mh - 6
  menu.style.left = `${Math.max(12, left)}px`
  menu.style.top = `${Math.max(12, top)}px`
  menu.querySelector('button').focus()
}

function closeMenu() {
  const menu = $('#book-menu')
  menu.hidden = true
  delete menu.dataset.id
}

async function removeBook(book) {
  const ok = await confirmDialog({
    title: `Remove “${book.title}”?`,
    body: 'This deletes the book, your place in it, and its highlights and bookmarks from this device. It cannot be undone.',
    confirm: 'Remove',
    danger: true,
  })
  if (!ok) return
  await db.removeBook(book.id)
  await refreshLibrary()
  toast('Removed from library')
}

function edit(book) {
  editBook(book, { knownSeries: [...new Set(books.map(b => b.series).filter(Boolean))].sort(), saved: async id => {
    // The cover may have changed: drop the cached picture so the shelf redraws it.
    const old = coverURLs.get(id)
    if (old) { URL.revokeObjectURL(old); coverURLs.delete(id) }
    await refreshLibrary()
  } })
}

function showDetail(book) {
  openDetail(book, {
    coverEl: cover(book, 'hero'),
    finished: isFinished(book),
    onRead: () => handlers.open(book.id),
    onEdit: () => edit(book),
    onJump: cfi => handlers.jump(book.id, cfi),
  })
}

// Where a book sits on screen, for the closing animation: the big cover if it
// is the one being read, otherwise its place on the shelf.
export function coverElementFor(id) {
  const hero = document.querySelector('.now-cover')
  if (hero?.dataset.coverOf === id) return hero.querySelector('.cover')
  for (const li of document.querySelectorAll('#shelf .book')) if (li.dataset.id === id) return li.querySelector('.cover')
  return null
}

// ---------------------------------------------------------------- ambient
// The home screen picks up a soft tint from the cover of the book being read.
let ambientFor = ''
async function setAmbient(book) {
  const root = document.body
  const key = book?.cover?.buffer ? `${book.id}:${book.cover.buffer.byteLength}` : ''
  if (key === ambientFor) return
  ambientFor = key
  if (!key) { root.style.removeProperty('--ambient'); return }
  try {
    const bmp = await createImageBitmap(new Blob([book.cover.buffer], { type: book.cover.type || 'image/jpeg' }))
    const c = document.createElement('canvas')
    c.width = c.height = 16
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(bmp, 0, 0, 16, 16)
    bmp.close?.()
    const d = ctx.getImageData(0, 0, 16, 16).data
    // Average, leaning on the colourful pixels so a grey border does not win.
    let r = 0, g = 0, b = 0, n = 0
    for (let i = 0; i < d.length; i += 4) {
      const max = Math.max(d[i], d[i + 1], d[i + 2]), min = Math.min(d[i], d[i + 1], d[i + 2])
      const w = 0.15 + (max - min) / 255
      r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; n += w
    }
    if (ambientFor !== key || !n) return
    root.style.setProperty('--ambient', `rgb(${Math.round(r / n)} ${Math.round(g / n)} ${Math.round(b / n)})`)
  } catch { root.style.removeProperty('--ambient') }
}

// ---------------------------------------------------------------- series and genres for older books
// Books added before Quire read series and genres get them from their own
// file, one at a time, in the background. Each book is only ever read once.
let backfilling = false
async function backfillMeta() {
  if (backfilling) return
  const todo = books.filter(b => b.metaV !== META_VERSION)
  if (!todo.length) return
  backfilling = true
  let changed = false
  try {
    for (const b of todo) {
      await new Promise(r => setTimeout(r, 60))
      let extra = { series: '', seriesIndex: null, genres: [], metaV: META_VERSION }
      try { extra = await readExtraMeta(b.id) } catch { /* unreadable: mark it done, with nothing */ }
      // Never overwrite what the person typed in Edit details.
      const patch = { metaV: META_VERSION }
      if (!b.series && extra.series) { patch.series = extra.series; patch.seriesIndex = extra.seriesIndex }
      if (!(b.genres || []).length && extra.genres.length) patch.genres = extra.genres
      try { await db.updateBook(b.id, patch); changed ||= Object.keys(patch).length > 1 } catch { /* try again next time */ }
    }
  } finally { backfilling = false }
  if (changed && !document.body.classList.contains('reading')) await refreshLibrary()
}

// ---------------------------------------------------------------- your own shelves
// Shelf names live in one list (their order on screen); each book keeps the
// names of the shelves it stands on.
const cleanShelf = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
function shelfNames() {
  const saved = getFlag('shelves', [])
  const names = (Array.isArray(saved) ? saved : []).map(cleanShelf).filter(Boolean)
  // A shelf that came in with a restored book is still a shelf.
  for (const b of books) for (const n of b.shelves || []) if (!names.includes(n)) names.push(n)
  return [...new Set(names)].slice(0, 60)
}

function chooseShelves(book) {
  const draw = () => {
    const on = new Set(books.find(b => b.id === book.id)?.shelves || [])
    const names = shelfNames()
    $('#shelves-list').replaceChildren(...(names.length ? names.map(name => el('label', { class: 'row switch-row' },
      el('span', { text: name }),
      el('input', { type: 'checkbox', class: 'switch', checked: on.has(name) ? '' : null, onchange: async e => {
        const cur = new Set(books.find(b => b.id === book.id)?.shelves || [])
        e.target.checked ? cur.add(name) : cur.delete(name)
        await db.updateBook(book.id, { shelves: [...cur] })
        await refreshLibrary()
      } }))) : [el('p', { class: 'setting-note', text: 'No shelves yet. Name your first one below, for example “To read” or “Favourites”.' })]))
  }
  $('#shelves-title').textContent = `Shelves for “${book.title.slice(0, 40)}”`
  $('#shelves-form').onsubmit = async e => {
    e.preventDefault()
    const name = cleanShelf($('#shelves-new').value)
    if (!name) return
    $('#shelves-new').value = ''
    if (!shelfNames().includes(name)) setFlag('shelves', [...shelfNames(), name])
    const cur = new Set(books.find(b => b.id === book.id)?.shelves || [])
    cur.add(name)
    await db.updateBook(book.id, { shelves: [...cur] })
    await refreshLibrary()
    draw()
  }
  draw()
  showSheet('sheet-shelves')
}

async function removeShelf(name) {
  const ok = await confirmDialog({ title: `Remove the shelf “${name}”?`, body: 'The books stay in your library. Only the shelf goes.', confirm: 'Remove shelf' })
  if (!ok) return
  for (const b of books) if ((b.shelves || []).includes(name)) await db.updateBook(b.id, { shelves: b.shelves.filter(n => n !== name) })
  setFlag('shelves', shelfNames().filter(n => n !== name))
  if (filter.shelf === name) filter.shelf = ''
  await refreshLibrary()
  toast('Shelf removed')
}

// ---------------------------------------------------------------- first tips
// Shown once, above the library, when there is a book to try them on.
function renderTips(has) {
  const host = $('#tips')
  if (!has || getFlag('tipsSeen', false)) { host.hidden = true; return }
  if (!host.hidden && host.childElementCount) return
  const tip = (title, text) => el('li', {}, el('b', { text: title }), el('span', { text }))
  host.replaceChildren(
    el('div', { class: 'tips-head' },
      el('h2', { id: 'tips-title', text: 'Three things worth knowing' }),
      el('button', { type: 'button', class: 'btn btn-quiet tips-done', text: 'Got it', onclick: () => { setFlag('tipsSeen', true); host.hidden = true } })),
    el('ul', { class: 'tips-list' },
      tip('Hold a cover', 'Hold a cover, or right-click it, to see the book\u2019s own page with your progress and every highlight.'),
      tip('Select any text', 'Inside a book, select a word for its meaning, or a passage to highlight it, add a note or make a quote card.'),
      tip('Make it yours', 'Settings has six app styles, accent colours and a backup of your whole library. The Aa button inside a book changes the page.')))
  host.hidden = false
}
