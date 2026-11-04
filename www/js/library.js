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

function statusText(book) {
  if (!book.openedAt) return 'New'
  if (book.progress >= 0.995) return 'Finished'
  return `${Math.floor(book.progress * 100)}%`
}

function render() {
  const has = books.length > 0
  $('#empty').hidden = has
  $('#shelf').hidden = !has
  renderHero()
  renderShelf()
}

function renderHero() {
  const host = $('#now')
  const current = books
    .filter(b => b.openedAt && b.progress < 0.995)
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

export function fillSegBar(bar, marks, progress) {
  const bounds = normalizeMarks(marks)
  const frag = document.createDocumentFragment()
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i], end = bounds[i + 1]
    const fill = Math.max(0, Math.min(1, (progress - start) / (end - start)))
    const seg = el('span', { class: 'seg', style: `flex-grow:${(end - start).toFixed(5)};--fill:${fill.toFixed(4)}` })
    frag.append(seg)
  }
  bar.replaceChildren(frag)
  // Many chapters: tighter gaps so the bar never grows past its box.
  const n = bounds.length - 1
  bar.style.setProperty('--seg-gap', n > 60 ? '1px' : n > 30 ? '2px' : '3px')
  bar.style.setProperty('--progress', progress.toFixed(4))
}

// Too many tiny segments read as noise; merge until each is visible.
function normalizeMarks(marks) {
  let m = Array.isArray(marks) ? marks.filter(x => Number.isFinite(x) && x > 0 && x < 1) : []
  m = [0, ...new Set(m.map(x => Math.round(x * 1e4) / 1e4)), 1].sort((a, b) => a - b)
  const minGap = 0.012
  const out = [0]
  for (const x of m.slice(1)) if (x - out[out.length - 1] >= minGap || x === 1) out.push(x)
  if (out.length > 2 && out[out.length - 1] - out[out.length - 2] < minGap) out.splice(out.length - 2, 1)
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
  menu.replaceChildren(
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
