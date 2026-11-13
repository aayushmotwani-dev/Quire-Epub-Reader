// Book page: one book's cover, progress, and every highlight and note in it.

import * as db from './db.js'
import { $, el, showSheet, closeSheet } from './ui.js'
import { exportHighlights } from './export.js'
import { openQuoteCard } from './quote.js'
import { HIGHLIGHT_COLORS } from './reader.js'

function timeLeft(mins) {
  if (!Number.isFinite(mins) || mins <= 0) return ''
  if (mins < 60) return `${mins} min left`
  const h = Math.floor(mins / 60), m = mins % 60
  return m ? `${h} h ${m} min left` : `${h} h left`
}

// Closing a sheet steps back in history; wait for that before going anywhere new.
function closeThen(fn) {
  const viaHistory = !!history.state?.sheet
  closeSheet()
  if (!viaHistory) return fn()
  let done = false
  const go = () => { if (done) return; done = true; removeEventListener('popstate', go); setTimeout(fn, 0) }
  addEventListener('popstate', go)
  setTimeout(go, 400)
}

const dateText = ts => ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''

export async function openDetail(book, { coverEl, finished, onRead, onEdit, onJump }) {
  const pct = Math.floor((book.progress || 0) * 100)
  const facts = [
    finished ? 'Finished' : book.openedAt ? `${pct}% read` : 'Not started',
    !finished && book.openedAt ? timeLeft(book.minsLeft) : '',
    book.chapter && !finished ? book.chapter : '',
  ].filter(Boolean)

  $('#detail-top').replaceChildren(
    el('div', { class: 'detail-cover' }, coverEl),
    el('div', { class: 'detail-info' },
      el('h3', { class: 'detail-title', text: book.title }),
      el('p', { class: 'detail-author', text: book.author || 'Unknown author' }),
      el('div', { class: 'detail-bar', style: `--p:${finished ? 1 : Math.max(0, Math.min(1, book.progress || 0))}`, 'aria-hidden': 'true' }, el('i')),
      el('ul', { class: 'detail-facts' }, ...facts.map(f => el('li', { text: f }))),
      el('p', { class: 'detail-small', text: [book.addedAt ? `Added ${dateText(book.addedAt)}` : '', book.size ? `${(book.size / 1_048_576).toFixed(1)} MB` : ''].filter(Boolean).join(', ') }),
      el('div', { class: 'detail-actions' },
        el('button', { type: 'button', class: 'btn btn-solid', text: book.openedAt && !finished ? 'Continue' : 'Read', onclick: () => closeThen(onRead) }),
        el('button', { type: 'button', class: 'btn btn-quiet', text: 'Edit details', onclick: () => onEdit() }))))

  const host = $('#detail-notes')
  host.replaceChildren(el('p', { class: 'setting-note', text: 'Loading…' }))
  showSheet('sheet-detail')

  let all = []
  try { all = await db.annotationsFor(book.id) } catch { all = [] }
  const items = all.filter(a => a.type === 'highlight').sort((a, b) => (a.fraction ?? 0) - (b.fraction ?? 0))
  if (!items.length) {
    host.replaceChildren(el('p', { class: 'setting-note', text: 'No highlights yet. Select text on any page to highlight it.' }))
    return
  }
  host.replaceChildren(
    el('div', { class: 'detail-notes-head' },
      el('h3', { text: items.length === 1 ? '1 highlight' : `${items.length} highlights` }),
      el('button', { type: 'button', class: 'btn btn-quiet detail-export', icon: 'export', onclick: () => exportHighlights(book) }, el('span', { text: 'Export' }))),
    ...items.map(a => el('div', { class: 'note-row' },
      el('button', { type: 'button', class: 'note-main', style: `--c:${HIGHLIGHT_COLORS[a.color]?.value ?? HIGHLIGHT_COLORS.yellow.value}`, onclick: () => closeThen(() => onJump(a.cfi)) },
        a.chapter ? el('span', { class: 'note-chapter', text: a.chapter }) : null,
        el('span', { class: 'note-text quote', text: a.text }),
        a.note ? el('span', { class: 'note-note', text: a.note }) : null),
      el('button', { type: 'button', class: 'icon-btn', icon: 'export', 'aria-label': 'Make a quote card', title: 'Quote card',
        onclick: () => openQuoteCard({ text: a.text, title: book.title, author: book.author }) }))))
}
