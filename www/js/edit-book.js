// Book details: change a book's title, author and cover, by hand or from
// Open Library. Nothing is saved until Save is pressed, and the EPUB file
// itself is never changed, so "Reset to original" always works.

import * as db from './db.js'
import { $, el, showSheet, closeSheet, toast } from './ui.js'
import { makeThumb, readOriginal } from './importer.js'
import { searchBooks, fetchCover } from './metadata.js'

const MAX_IMAGE_BYTES = 15 * 1024 * 1024

let book = null
let cover = null        // the thumbnail that Save would store
let previewURL = ''
let onSaved = () => {}
let searching = null    // AbortController of the running search
let inited = false
let thumbURLs = []      // result thumbnails, freed when the list is replaced

function clearResults() {
  for (const u of thumbURLs) URL.revokeObjectURL(u)
  thumbURLs = []
  $('#edit-results').replaceChildren()
}

function setCover(thumb) {
  cover = thumb || null
  if (previewURL) URL.revokeObjectURL(previewURL)
  previewURL = cover?.buffer ? URL.createObjectURL(new Blob([cover.buffer], { type: cover.type || 'image/jpeg' })) : ''
  const box = $('#edit-cover')
  box.replaceChildren(previewURL
    ? el('img', { src: previewURL, alt: 'Cover' })
    : el('span', { class: 'edit-nocover', text: 'No cover' }))
}

function status(text) {
  const s = $('#edit-status')
  s.hidden = !text
  s.textContent = text || ''
}

async function useImage(blob) {
  const thumb = await makeThumb(blob)
  if (!thumb) { toast('That image could not be read'); return false }
  setCover(thumb)
  return true
}

function init() {
  if (inited) return
  inited = true

  $('#edit-pick').addEventListener('click', () => $('#edit-file').click())
  $('#edit-file').addEventListener('change', async e => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast('Choose a PNG, JPEG or WebP image')
    if (file.size > MAX_IMAGE_BYTES) return toast('That image is larger than 15 MB')
    await useImage(file)
  })

  $('#edit-reset').addEventListener('click', async () => {
    if (!book) return
    try {
      const o = await readOriginal(book.id)
      $('#edit-name').value = o.title
      $('#edit-author').value = o.author
      setCover(o.cover)
      toast('Original details restored. Press Save to keep them.')
    } catch { toast('The original details could not be read') }
  })

  $('#edit-form').addEventListener('submit', async e => {
    e.preventDefault()
    if (!book) return
    const title = $('#edit-name').value.replace(/\s+/g, ' ').trim().slice(0, 300)
    const author = $('#edit-author').value.replace(/\s+/g, ' ').trim().slice(0, 300)
    if (!title) { $('#edit-name').focus(); return toast('A book needs a title') }
    try {
      await db.updateBook(book.id, { title, author, cover })
    } catch { return toast('The details could not be saved') }
    const id = book.id
    closeSheet()
    toast('Details saved')
    onSaved(id)
  })

  $('#edit-search').addEventListener('click', runSearch)
}

async function runSearch() {
  const title = $('#edit-name').value, author = $('#edit-author').value
  const list = $('#edit-results')
  searching?.abort()
  const ctl = searching = new AbortController()
  clearResults()
  if (!title.trim() && !author.trim()) return status('Type a title or an author first.')
  status('Searching…')
  let results
  try {
    results = await searchBooks({ title, author }, { signal: ctl.signal })
  } catch (e) {
    if (ctl.signal.aborted) return
    return status(navigator.onLine === false ? 'You are offline. Searching needs the internet.' : 'Open Library could not be reached. Try again in a moment.')
  }
  if (ctl.signal.aborted) return
  if (!results.length) return status('Nothing found. Try a shorter title, or only the author.')
  status(`${results.length} ${results.length === 1 ? 'match' : 'matches'}. Pick one to fill in the details.`)
  list.replaceChildren(...results.map(r => {
    const img = r.coverId ? el('img', { alt: '', hidden: '' }) : null
    if (img) fetchCover(r.coverId, 'S').then(blob => {
      if (ctl.signal.aborted || !img.isConnected) return
      const url = URL.createObjectURL(blob)
      thumbURLs.push(url)
      img.src = url; img.hidden = false
    }, () => img.remove())
    return el('li', {}, el('button', { type: 'button', class: 'edit-result', onclick: () => pick(r) },
      el('span', { class: 'edit-result-cover' }, img),
      el('span', { class: 'edit-result-text' },
        el('span', { class: 'edit-result-title', text: r.title }),
        el('span', { class: 'edit-result-sub', text: [r.author, r.year || ''].filter(Boolean).join(', ') || 'Unknown author' }))))
  }))
}

async function pick(r) {
  const forBook = book
  $('#edit-name').value = r.title
  if (r.author) $('#edit-author').value = r.author
  if (!r.coverId) return status('Details filled in. This match has no cover. Press Save to keep them.')
  status('Getting the cover…')
  try {
    const blob = await fetchCover(r.coverId)
    if (book !== forBook) return
    status((await useImage(blob)) ? 'Details and cover filled in. Press Save to keep them.' : 'Details filled in, but the cover could not be read.')
  } catch {
    if (book === forBook) status('Details filled in, but the cover could not be downloaded. You can choose an image instead.')
  }
}

export function editBook(target, { saved = () => {} } = {}) {
  init()
  book = target
  onSaved = saved
  $('#edit-name').value = target.title || ''
  $('#edit-author').value = target.author || ''
  setCover(target.cover)
  status('')
  clearResults()
  showSheet('sheet-edit', { onClose: () => { searching?.abort(); book = null; setCover(null); clearResults() } })
}
