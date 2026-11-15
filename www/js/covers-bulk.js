// Find missing covers: looks up every book that has no cover, shows what it
// found, and saves only the ones the person leaves ticked.

import * as db from './db.js'
import { $, el, showSheet, toast } from './ui.js'
import { searchBooks, fetchCover } from './metadata.js'
import { makeThumb } from './importer.js'

let run = 0
let found = []   // { book, thumb, url, use }
let onDone = () => {}

const words = s => new Set(String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2))
// How much of the book's title appears in the match's title.
function alike(a, b) {
  const A = words(a), B = words(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const w of A) if (B.has(w)) hit++
  return hit / A.size
}

function clear() {
  for (const f of found) URL.revokeObjectURL(f.url)
  found = []
  $('#covers-list').replaceChildren()
}

export async function missingCount() {
  try { return (await db.getAll('books')).filter(b => !b.cover?.buffer).length } catch { return 0 }
}

async function start() {
  const mine = ++run
  clear()
  const status = $('#covers-status'), apply = $('#covers-apply'), stop = $('#covers-stop')
  apply.hidden = true
  const books = (await db.getAll('books')).filter(b => !b.cover?.buffer)
  if (!books.length) { status.textContent = 'Every book already has a cover.'; return }
  stop.hidden = false
  let failed = 0
  for (const [i, book] of books.entries()) {
    if (mine !== run) return
    status.textContent = `Looking up ${i + 1} of ${books.length}: ${book.title.slice(0, 60)}`
    try {
      const results = await searchBooks({ title: book.title, author: book.author })
      const hit = results.find(r => r.coverId && alike(book.title, r.title) >= 0.6)
      if (hit) {
        const thumb = await makeThumb(await fetchCover(hit.coverId, 'L'))
        if (mine !== run) return
        if (thumb) {
          const item = { book, thumb, url: URL.createObjectURL(new Blob([thumb.buffer], { type: thumb.type })), use: true }
          found.push(item)
          $('#covers-list').append(el('li', { class: 'covers-item' },
            el('img', { src: item.url, alt: '' }),
            el('span', { class: 'covers-text' }, el('b', { text: book.title }), el('span', { text: `Matched: ${hit.title}${hit.author ? `, ${hit.author}` : ''}` })),
            el('input', { type: 'checkbox', class: 'switch', checked: '', 'aria-label': `Use this cover for ${book.title}`, onchange: e => { item.use = e.target.checked } })))
        }
      }
    } catch { failed++ }
    await new Promise(r => setTimeout(r, 350)) // be gentle with the service
  }
  if (mine !== run) return
  finish(books.length, failed)
}

function finish(total, failed) {
  $('#covers-stop').hidden = true
  $('#covers-apply').hidden = !found.length
  $('#covers-status').textContent = found.length
    ? `Found covers for ${found.length} of ${total} ${total === 1 ? 'book' : 'books'}. Untick any that look wrong.`
    : failed === total ? (navigator.onLine === false ? 'You are offline. Finding covers needs the internet.' : 'Open Library could not be reached. Try again in a moment.')
    : 'No matching covers were found. You can still choose an image in Edit details.'
}

export function initCoversBulk({ done = () => {} } = {}) {
  onDone = done
  $('#covers-open').addEventListener('click', () => { showSheet('sheet-covers', { onClose: () => { run++; clear() } }); start() })
  $('#covers-stop').addEventListener('click', () => { run++; finish(found.length, 0) })
  $('#covers-apply').addEventListener('click', async () => {
    const chosen = found.filter(f => f.use)
    let saved = 0
    for (const f of chosen) { try { await db.updateBook(f.book.id, { cover: f.thumb }); saved++ } catch { /* keep going */ } }
    $('#covers-apply').hidden = true
    $('#covers-status').textContent = `${saved} ${saved === 1 ? 'cover' : 'covers'} saved.`
    toast(`${saved} ${saved === 1 ? 'cover' : 'covers'} saved`)
    clear()
    await onDone()
  })
}
