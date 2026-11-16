// Backup and restore. Quire keeps everything on one device, so this is how a
// library survives a lost phone or moves to another computer: one file holding
// the books, where you are in each, highlights, notes, goals, stats and settings.
//
// A backup is an ordinary ZIP (stored, not compressed: EPUBs already are):
//   quire-backup.json   the manifest
//   covers/<id>         cover thumbnails
//   books/<id>.epub     the books themselves (optional)
//
// A backup file is untrusted input when it comes back. Restore reads only the
// fields it knows, checks every value, checks each book's bytes against its
// SHA-256 id, and sends books through the same importer as any other EPUB.

import * as db from './db.js'
import { getSettings, setSettings, getFlag, setFlag } from './settings.js'
import { importFile, makeThumb, cleanGenres, cleanSeriesIndex } from './importer.js'
import { ZipStore } from './zipstore.js'

const MANIFEST = 'quire-backup.json'
const FORMAT = 1
const MAX_ZIP_BYTES = 3.5 * 1024 ** 3      // the simple ZIP layout stops at 4 GB
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
const MAX_BOOKS = 5000
const MAX_ANNOTATIONS = 200_000
const MAX_COVER_BYTES = 4 * 1024 * 1024
const MAX_BOOK_BYTES = 600 * 1024 * 1024
const ID = /^[a-f0-9]{64}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'purple'])

// ---------------------------------------------------------------- saving
const BOOK_FIELDS = ['id', 'title', 'author', 'language', 'fixedLayout', 'size', 'fileName', 'addedAt', 'openedAt', 'progress', 'cfi', 'chapter', 'finishedAt', 'minsLeft', 'series', 'seriesIndex', 'genres', 'format', 'shelves', 'dir', 'rtl', 'kind']
const NOTE_FIELDS = ['id', 'bookId', 'type', 'cfi', 'index', 'color', 'text', 'note', 'chapter', 'fraction', 'createdAt']
const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]))

export async function librarySize() {
  const books = await db.getAll('books')
  return { count: books.length, bytes: books.reduce((n, b) => n + (b.size || 0), 0) }
}

export async function makeBackup({ withBooks = true, onProgress = () => {} } = {}) {
  const books = await db.getAll('books')
  if (books.length > 65_000) throw new Error('This library has too many books for one backup file.')
  const annotations = await db.getAll('annotations')
  const zip = new ZipStore({ maxBytes: MAX_ZIP_BYTES, tooLarge: 'This library is too large for one backup file. Save a backup without the books.' })
  const manifest = {
    app: 'quire', format: FORMAT, created: new Date().toISOString(), withBooks,
    settings: getSettings(),
    flags: { goal: getFlag('goal', null), readingDays: getFlag('readingDays', {}), sort: getFlag('sort', null), dictRecent: getFlag('dictRecent', []), vocab: getFlag('vocab', []), shelves: getFlag('shelves', []), customTheme: getFlag('customTheme', null) },
    books: books.map(b => ({ ...pick(b, BOOK_FIELDS), cover: b.cover?.buffer ? { type: b.cover.type || 'image/jpeg' } : null })),
    annotations: annotations.map(a => pick(a, NOTE_FIELDS)),
  }
  zip.add(MANIFEST, new TextEncoder().encode(JSON.stringify(manifest)))
  let done = 0
  for (const b of books) {
    if (b.cover?.buffer) zip.add(`covers/${b.id}`, b.cover.buffer)
    if (withBooks) {
      const rec = await db.get('files', b.id)
      if (rec?.buffer) zip.add(`books/${b.id}.epub`, rec.buffer)
    }
    onProgress(++done, books.length)
    if (done % 4 === 0) await new Promise(r => setTimeout(r)) // let the screen breathe
  }
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return new File([zip.finish()], `Quire backup ${stamp}.zip`, { type: 'application/zip' })
}

// ---------------------------------------------------------------- reading
const text = (v, max) => typeof v === 'string' ? v.slice(0, max) : ''
const time = v => Number.isFinite(v) && v > 0 && v < 4_102_444_800_000 ? Math.round(v) : 0
const unit = v => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0

function cleanBook(raw) {
  if (!raw || typeof raw !== 'object' || !ID.test(raw.id)) return null
  const out = {
    id: raw.id,
    title: text(raw.title, 300).replace(/\s+/g, ' ').trim(),
    author: text(raw.author, 300).replace(/\s+/g, ' ').trim(),
    addedAt: time(raw.addedAt), openedAt: time(raw.openedAt),
    progress: unit(raw.progress),
    cfi: typeof raw.cfi === 'string' && raw.cfi.length <= 2000 && raw.cfi.startsWith('epubcfi(') ? raw.cfi : null,
    chapter: text(raw.chapter, 300),
    hasCover: !!raw.cover,
    ext: ({ cbz: 'cbz', fbz: 'fbz', fb2: 'fb2', mobi: 'mobi' })[raw.format] ?? 'epub',
  }
  if (typeof raw.series === 'string') { out.series = text(raw.series, 120).replace(/\s+/g, ' ').trim(); out.seriesIndex = out.series ? cleanSeriesIndex(raw.seriesIndex) : null }
  if (Array.isArray(raw.genres)) out.genres = cleanGenres(raw.genres.filter(g => typeof g === 'string').slice(0, 12))
  if (raw.dir === 'rtl' || raw.dir === 'ltr') out.dir = raw.dir
  if (raw.kind === 'comic' || raw.kind === 'book') out.kind = raw.kind
  if (Array.isArray(raw.shelves)) out.shelves = [...new Set(raw.shelves.filter(n => typeof n === 'string').map(n => n.replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean))].slice(0, 60)
  if (raw.finishedAt !== undefined) out.finishedAt = time(raw.finishedAt)
  if (Number.isFinite(raw.minsLeft) && raw.minsLeft >= 0 && raw.minsLeft < 100_000) out.minsLeft = Math.round(raw.minsLeft)
  return out
}

function cleanNote(raw, bookIds) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || !/^[\w.-]{1,80}$/.test(raw.id)) return null
  if (!bookIds.has(raw.bookId)) return null
  if (raw.type !== 'highlight' && raw.type !== 'bookmark') return null
  if (typeof raw.cfi !== 'string' || raw.cfi.length > 2000 || !raw.cfi.startsWith('epubcfi(')) return null
  const out = {
    id: raw.id, bookId: raw.bookId, type: raw.type, cfi: raw.cfi,
    text: text(raw.text, 20_000), chapter: text(raw.chapter, 300),
    fraction: unit(raw.fraction), createdAt: time(raw.createdAt) || Date.now(),
  }
  if (raw.type === 'highlight') {
    out.color = COLORS.has(raw.color) ? raw.color : 'yellow'
    out.note = text(raw.note, 20_000)
    if (Number.isInteger(raw.index) && raw.index >= 0 && raw.index < 100_000) out.index = raw.index
  }
  return out
}

async function openZip(file) {
  const { configure, ZipReader, BlobReader, TextWriter, BlobWriter } = await import('../vendor/foliate-js/vendor/zip.js')
  configure({ useWebWorkers: false })
  let entries
  try { entries = await new ZipReader(new BlobReader(file)).getEntries() } catch { throw new Error('That file is not a Quire backup.') }
  const map = new Map(entries.filter(e => !e.directory).map(e => [e.filename, e]))
  return {
    size: name => map.get(name)?.uncompressedSize ?? -1,
    text: name => map.get(name).getData(new TextWriter()),
    blob: (name, type) => map.get(name).getData(new BlobWriter(type)),
  }
}

async function readManifest(zip) {
  const size = zip.size(MANIFEST)
  if (size < 0) throw new Error('That file is not a Quire backup.')
  if (size > MAX_MANIFEST_BYTES) throw new Error('That backup is damaged.')
  let m
  try { m = JSON.parse(await zip.text(MANIFEST)) } catch { throw new Error('That backup is damaged.') }
  if (m?.app !== 'quire' || !Array.isArray(m.books)) throw new Error('That file is not a Quire backup.')
  if (m.format !== FORMAT) throw new Error('That backup was made by a newer Quire. Update the app, then try again.')
  if (m.books.length > MAX_BOOKS || (Array.isArray(m.annotations) && m.annotations.length > MAX_ANNOTATIONS)) throw new Error('That backup is damaged.')
  return m
}

// What a backup holds, for the confirmation before restoring.
export async function inspectBackup(file) {
  const zip = await openZip(file)
  const m = await readManifest(zip)
  const books = m.books.map(cleanBook).filter(Boolean)
  const ids = new Set(books.map(b => b.id))
  const notes = (Array.isArray(m.annotations) ? m.annotations : []).map(a => cleanNote(a, ids)).filter(Boolean)
  const created = typeof m.created === 'string' && !Number.isNaN(Date.parse(m.created)) ? new Date(m.created) : null
  return { books: books.length, withFiles: books.filter(b => zip.size(`books/${b.id}.epub`) > 0).length, highlights: notes.filter(n => n.type === 'highlight').length, created }
}

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------- restoring
// Adds what is missing and never deletes. For a book already in the library,
// the copy that was read more recently wins.
export async function restoreBackup(file, { onProgress = () => {} } = {}) {
  const zip = await openZip(file)
  const m = await readManifest(zip)
  const wanted = m.books.map(cleanBook).filter(Boolean)
  const have = new Map((await db.getAll('books')).map(b => [b.id, b]))
  const result = { added: 0, updated: 0, skipped: 0, notes: 0 }
  const present = new Set()

  let done = 0
  for (const b of wanted) {
    onProgress(++done, wanted.length)
    const local = have.get(b.id)
    const state = pick(b, ['openedAt', 'progress', 'cfi', 'chapter', 'finishedAt', 'minsLeft'])
    if (local) {
      present.add(b.id)
      const extra = (b.shelves || []).filter(n => !(local.shelves || []).includes(n))
      if (extra.length) await db.updateBook(b.id, { shelves: [...(local.shelves || []), ...extra] })
      if (b.openedAt > (local.openedAt || 0)) { await db.updateBook(b.id, state); result.updated++ }
      continue
    }
    const name = `books/${b.id}.epub`
    const size = zip.size(name)
    if (size <= 0 || size > MAX_BOOK_BYTES) { result.skipped++; continue }
    try {
      const blob = await zip.blob(name, 'application/epub+zip')
      // The id is the SHA-256 of the book: if the bytes do not match, it is not that book.
      if (await sha256(await blob.arrayBuffer()) !== b.id) { result.skipped++; continue }
      // The importer works out the format from the bytes; the name only helps with comics and FictionBook.
      const { book } = await importFile(new File([blob], `book.${b.ext}`))
      if (book.id !== b.id) { result.skipped++; continue }
      const patch = { ...state }
      if (b.title) patch.title = b.title
      if (b.author) patch.author = b.author
      if (b.addedAt) patch.addedAt = b.addedAt
      if (b.series !== undefined) { patch.series = b.series; patch.seriesIndex = b.seriesIndex }
      if (b.genres !== undefined) patch.genres = b.genres
      if (b.dir) patch.dir = b.dir
      if (b.kind) patch.kind = b.kind
      if (b.shelves?.length) patch.shelves = b.shelves
      const coverSize = zip.size(`covers/${b.id}`)
      if (b.hasCover && coverSize > 0 && coverSize <= MAX_COVER_BYTES) {
        // Re-drawn through a canvas, so only pixels come across.
        const thumb = await makeThumb(await zip.blob(`covers/${b.id}`, 'image/jpeg'))
        if (thumb) patch.cover = thumb
      }
      await db.updateBook(b.id, patch)
      present.add(b.id); result.added++
    } catch { result.skipped++ }
  }

  // Highlights and bookmarks, for books that are now here.
  const existing = new Set((await db.getAll('annotations')).map(a => a.id))
  for (const raw of Array.isArray(m.annotations) ? m.annotations : []) {
    const a = cleanNote(raw, present)
    if (!a || existing.has(a.id)) continue
    await db.put('annotations', a)
    existing.add(a.id); result.notes++
  }

  // Settings go through the same checks as any saved setting.
  if (m.settings && typeof m.settings === 'object' && !Array.isArray(m.settings)) setSettings(m.settings)
  const f = m.flags && typeof m.flags === 'object' ? m.flags : {}
  if (f.goal && typeof f.goal === 'object' && !Array.isArray(f.goal)) {
    const n = v => Number.isInteger(v) && v >= 1 && v <= 365 ? v : undefined
    const goal = { month: n(f.goal.month), year: n(f.goal.year) }
    if (goal.month || goal.year) setFlag('goal', goal)
  }
  if (f.readingDays && typeof f.readingDays === 'object' && !Array.isArray(f.readingDays)) {
    // Keep the larger number for each day, so restoring twice never double counts.
    const days = { ...(getFlag('readingDays', {}) || {}) }
    for (const [k, v] of Object.entries(f.readingDays).slice(0, 2000))
      if (DAY.test(k) && Number.isFinite(v) && v > 0) days[k] = Math.max(Number(days[k]) || 0, Math.min(86_400, Math.round(v)))
    setFlag('readingDays', days)
  }
  if (Array.isArray(f.shelves)) {
    const mine = Array.isArray(getFlag('shelves', [])) ? getFlag('shelves', []) : []
    const names = f.shelves.filter(n => typeof n === 'string').map(n => n.replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean)
    setFlag('shelves', [...new Set([...mine, ...names])].slice(0, 60))
  }
  if (Array.isArray(f.vocab)) {
    // Words are plain text; anything else is dropped. Words already here are kept.
    const str = (v, n) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : ''
    const mine = Array.isArray(getFlag('vocab', [])) ? getFlag('vocab', []) : []
    const have = new Set(mine.map(v => v?.w))
    const extra = f.vocab.slice(0, 600).map(v => v && typeof v === 'object' ? { w: str(v.w, 60).toLowerCase(), d: str(v.d, 400), p: str(v.p, 20), s: str(v.s, 320), b: str(v.b, 200), t: time(v.t), k: v.k === true } : null)
      .filter(v => v && v.w && v.d && !have.has(v.w))
    setFlag('vocab', [...mine, ...extra].slice(0, 600))
  }
  return result
}
