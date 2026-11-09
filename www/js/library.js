import * as db from './db.js'
import { el, $, iconButton, toast, confirmDialog } from './ui.js'
import { getFlag, setFlag } from './settings.js'
import { exportHighlights } from './export.js'

const coverURLs = new Map() // book id -> object URL, revoked when the book leaves

let books = []
let query = ''
let sort = getFlag('sort', 'recent')
let handlers = { open: () => {}, add: () => {} }

export function initLibrary({ onOpen, onAdd }) {
  handlers = { open: onOpen, add: onAdd }
  $('#lib-search').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); renderShelf() })
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
  render()
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
  if (!current) return host.replaceChildren()
  const pct = Math.floor(current.progress * 100)
  host.replaceChildren(
    el('button', { type: 'button', class: 'now-cover', 'aria-label': `Continue reading ${current.title}`, onclick: () => handlers.open(current.id) }, cover(current, 'hero')),
    el('div', { class: 'now-body' },
      el('p', { class: 'now-kicker', text: 'Continue reading' }),
      el('h2', { class: 'now-title', text: current.title }),
      current.author ? el('p', { class: 'now-author', text: current.author }) : null,
      el('div', { class: 'now-progress' },
        el('p', { class: 'dot-number', 'aria-label': `${pct} percent read` },
          el('span', { text: String(pct) }), el('span', { class: 'dot-unit', text: '%' })),
        segBar(current.marks, current.progress)),
      current.chapter ? el('p', { class: 'now-chapter', text: current.chapter }) : null,
      el('button', { type: 'button', class: 'btn btn-solid', text: 'Continue', onclick: () => handlers.open(current.id) })))
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

function sorted() {
  const list = books.filter(b => !query || b.title.toLowerCase().includes(query) || b.author.toLowerCase().includes(query))
  const by = {
    recent: (a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
    author: (a, b) => (a.author || '￿').localeCompare(b.author || '￿', undefined, { sensitivity: 'base' }) || a.title.localeCompare(b.title),
  }
  return list.sort(by[sort] ?? by.recent)
}

function renderShelf() {
  $('#lib-count').textContent = books.length === 1 ? '1 book' : `${books.length} books`
  const grid = $('#grid')
  const list = sorted()
  if (!list.length && books.length) {
    grid.replaceChildren(el('li', { class: 'no-match', text: `Nothing matches “${query}”.` }))
    return
  }
  grid.replaceChildren(...list.map(book => el('li', { class: 'book' },
    el('button', { type: 'button', class: 'book-open', 'aria-label': `Open ${book.title}`, onclick: () => handlers.open(book.id) }, cover(book)),
    el('div', { class: 'book-meta' },
      el('p', { class: 'book-title', text: book.title, title: book.title }),
      iconButton('more', `More for ${book.title}`, e => openMenu(e.currentTarget, book), { class: 'book-more' })),
    el('p', { class: 'book-sub' },
      el('span', { class: 'book-author', text: book.author || 'Unknown author' }),
      el('span', { class: 'book-status' + (!book.openedAt ? ' is-new' : ''), text: statusText(book) })))))
}

function openMenu(anchor, book) {
  const menu = $('#book-menu')
  if (!menu.hidden && menu.dataset.id === book.id) return closeMenu()
  menu.dataset.id = book.id
  const finished = isFinished(book)
  menu.replaceChildren(
    el('button', { type: 'button', role: 'menuitem', icon: finished ? 'minus' : 'check', onclick: async () => {
      closeMenu()
      await db.updateBook(book.id, { finishedAt: finished ? 0 : Date.now() })
      await refreshLibrary()
      toast(finished ? 'Marked as not finished' : 'Marked as finished')
    } }, el('span', { text: finished ? 'Mark as not finished' : 'Mark as finished' })),
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
