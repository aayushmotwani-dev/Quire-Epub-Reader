import { makeBook } from '../vendor/foliate-js/view.js'
import * as db from './db.js'
import { isRar, rarToCbz, RarError } from './cbr.js'
import { formatAuthors, langMap } from './ui.js'

const MAX_BYTES = 600 * 1024 * 1024 // 600 MB, far above any normal novel
const THUMB_WIDTH = 360

export class ImportError extends Error {}

async function isZip(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
}

// ---------------------------------------------------------------- formats
// What Quire can open besides EPUB. The engine picks its parser by file name
// and type, so each kind carries the name ending and type it expects.
const KINDS = {
  epub: { ext: 'epub', type: 'application/epub+zip', label: 'EPUB' },
  mobi: { ext: 'mobi', type: 'application/x-mobipocket-ebook', label: 'Kindle' },
  fb2: { ext: 'fb2', type: 'application/x-fictionbook+xml', label: 'FictionBook' },
  fbz: { ext: 'fbz', type: 'application/x-zip-compressed-fb2', label: 'FictionBook' },
  cbz: { ext: 'cbz', type: 'application/vnd.comicbook+zip', label: 'Comic' },
}
const BOOK_EXT = /\.(epub|mobi|azw3?|prc|kf8|fb2|fb2\.zip|fbz|cbz|cbr)$/i

async function kindOf(file) {
  const name = (file.name || '').toLowerCase()
  if (await isZip(file)) {
    // A .cbr that is really a ZIP is common: it is a comic all the same.
    if (/\.cb[zr]$/.test(name) || file.type === KINDS.cbz.type) return 'cbz'
    if (name.endsWith('.fbz') || name.endsWith('.fb2.zip') || file.type === KINDS.fbz.type) return 'fbz'
    return 'epub'
  }
  try {
    const head = new Uint8Array(await file.slice(0, 2048).arrayBuffer())
    if (String.fromCharCode(...head.subarray(60, 68)) === 'BOOKMOBI') return 'mobi'
    if (name.endsWith('.fb2') || String.fromCharCode(...head).includes('<FictionBook')) return 'fb2'
  } catch { /* unreadable */ }
  return null
}

const asKind = (buffer, kind) => new File([buffer], `book.${KINDS[kind].ext}`, { type: KINDS[kind].type })

async function fingerprint(buffer, file) {
  // SHA-256 needs a secure context (https or localhost).
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
  }
  return `f-${file.size}-${file.lastModified || 0}-${file.name}`
}

export async function makeThumb(blob) {
  if (!blob || !blob.size) return null
  try {
    const bmp = await createImageBitmap(blob)
    const scale = Math.min(1, THUMB_WIDTH / bmp.width)
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close?.()
    const out = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.86))
    if (!out) return null
    return { buffer: await out.arrayBuffer(), type: out.type, width: w, height: h }
  } catch {
    return null // undecodable cover: the library draws a typographic one
  }
}

function cleanText(s, max = 300) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

// ---------------------------------------------------------------- series and genres
// Subjects in the wild are messy: "Fiction / Fantasy / Epic", "FIC009020",
// "fantasy; adventure". Keep a few short, readable genres.
export function cleanGenres(input) {
  const raw = (Array.isArray(input) ? input : [input]).map(x => typeof x === 'string' ? x : langMap(x?.name ?? x)).filter(Boolean)
  const out = []
  const seen = new Set()
  for (const piece of raw.flatMap(s => String(s).split(/\s*(?:\/|;|,|\||--|—|>)\s*/))) {
    const g = cleanText(piece.replace(/_/g, ' '), 60).replace(/^[\s.:-]+|[\s.:-]+$/g, '')
    if (g.length < 3 || g.length > 32) continue
    if (/^[A-Z]{3}\d{6}$/.test(g) || /^\d+$/.test(g) || /^(general|unknown|ebook|ebooks|book|books)$/i.test(g)) continue
    const nice = g === g.toLowerCase() || g === g.toUpperCase() ? g.toLowerCase().replace(/(^|[\s-])\p{L}/gu, c => c.toUpperCase()) : g
    const key = nice.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key); out.push(nice)
    if (out.length === 6) break
  }
  // "Fiction" on its own says little once a real genre is there.
  const broad = /^(fiction|non-?fiction)$/i
  return out.some(g => !broad.test(g)) ? out.filter(g => !broad.test(g)) : out
}

export function cleanSeriesIndex(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) && n >= 0 && n < 10_000 ? Math.round(n * 100) / 100 : null
}

function seriesOf(meta) {
  const b = meta.belongsTo ?? {}
  const first = x => (Array.isArray(x) ? x : x ? [x] : []).find(c => langMap(c?.name ?? ''))
  const hit = first(b.series) ?? first(b.collection)
  if (!hit) return { series: '', seriesIndex: null }
  return { series: cleanText(langMap(hit.name), 120), seriesIndex: cleanSeriesIndex(hit.position) }
}

// Some formats report the file's own name as the title, or "Unknown" as the author.
const realTitle = (meta, named) => { const t = cleanText(langMap(meta.title)); return t && t !== named.name ? t : '' }
const realAuthor = meta => { const a = cleanText(formatAuthors(meta.author)); return /^(unknown|anonymous)$/i.test(a) ? '' : a }

export const META_VERSION = 1
const extraMeta = meta => ({ ...seriesOf(meta), genres: cleanGenres(meta.subject ?? []), metaV: META_VERSION })

// Books added before Quire read series and genres get them from their file, once.
export async function readExtraMeta(id) {
  const file = await loadBookFile(id)
  const parsed = await makeBook(file)
  return extraMeta(parsed.metadata ?? {})
}

// Imports one file. Resolves to { book, status: 'added' | 'exists' }.
export async function importFile(file) {
  const label = file.name || 'This file'
  if (!file.size) throw new ImportError(`${label} is empty.`)
  if (file.size > MAX_BYTES) throw new ImportError(`${label} is larger than 600 MB.`)
  // A CBR comic is a RAR archive: its pages are repacked as a CBZ first.
  if (await isRar(file)) {
    try { file = await rarToCbz(file) } catch (e) { throw new ImportError(e instanceof RarError ? e.message : `${label} could not be opened.`) }
  }
  const kind = await kindOf(file)
  if (!kind) throw new ImportError(/\.(mobi|azw3?|prc|kf8)$/i.test(file.name || '')
    ? `${label} is an old or copy-protected Kindle file that Quire cannot open.`
    : `${label} is not a book Quire can open. It reads EPUB, PDF, Kindle (MOBI, AZW3), FB2 and comics (CBZ, CBR).`)

  const buffer = await file.arrayBuffer()
  const id = await fingerprint(buffer, file)
  const existing = await db.get('books', id)
  if (existing) return { book: existing, status: 'exists' }

  const named = asKind(buffer, kind)
  let parsed
  try {
    parsed = await makeBook(named)
  } catch {
    throw new ImportError(kind === 'mobi'
      ? `${label} could not be opened. It may be damaged, or copy-protected (books bought from Kindle usually are).`
      : `${label} could not be opened. The file may be damaged.`)
  }
  if (!parsed?.sections?.length) throw new ImportError(`${label} has no readable pages.`)

  const meta = parsed.metadata ?? {}
  let coverBlob = null
  try { coverBlob = await parsed.getCover?.() } catch { coverBlob = null }
  const thumb = await makeThumb(coverBlob)

  const fallbackTitle = (file.name || 'Untitled').replace(BOOK_EXT, '')
  const record = {
    id,
    title: realTitle(meta, named) || cleanText(fallbackTitle),
    author: realAuthor(meta),
    language: Array.isArray(meta.language) ? meta.language[0] : (meta.language || ''),
    fixedLayout: parsed.rendition?.layout === 'pre-paginated',
    format: kind,
    size: file.size,
    fileName: cleanText(file.name, 200),
    cover: thumb,
    ...extraMeta(meta),
    addedAt: Date.now(),
    openedAt: 0,
    progress: 0,
    cfi: null,
    chapter: '',
  }
  await db.addBook(record, { id, name: named.name, kind, buffer })
  return { book: record, status: 'added' }
}

// Asks the browser not to evict the library under storage pressure.
// Safari only grants this to Home Screen apps; that is fine, it just returns false.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && await navigator.storage.persisted()) return true
    return await navigator.storage?.persist?.() ?? false
  } catch { return false }
}

export async function loadBookFile(id) {
  const rec = await db.get('files', id)
  if (!rec) return null
  return asKind(rec.buffer, rec.kind in KINDS ? rec.kind : 'epub')
}

// The title, author and cover as the EPUB file itself states them.
export async function readOriginal(id) {
  const file = await loadBookFile(id)
  const parsed = await makeBook(file)
  const meta = parsed.metadata ?? {}
  let coverBlob = null
  try { coverBlob = await parsed.getCover?.() } catch { coverBlob = null }
  return {
    title: cleanText(langMap(meta.title)) || 'Untitled',
    author: cleanText(formatAuthors(meta.author)),
    cover: await makeThumb(coverBlob),
    ...extraMeta(meta),
  }
}

export const formatLabel = kind => KINDS[kind]?.label ?? 'EPUB'
export const isBookName = name => BOOK_EXT.test(name || '')
