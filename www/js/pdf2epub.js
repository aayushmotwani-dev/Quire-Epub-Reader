// PDF to EPUB: rebuilds a text PDF as a reflowable book, on the device.
//
// What it can do: read the text of each page, drop the running headers and
// page numbers, join the lines back into paragraphs, find headings by their
// size, split the book into chapters (from the PDF's own outline when it has
// one), and put the first page on the cover.
//
// Pictures inside the pages come across too: each one is cut out of the
// rendered page and placed where it stood between the paragraphs. Logos and
// backgrounds that repeat on many pages are left out.
//
// A scanned PDF has no text, only pictures of pages. It still becomes a book,
// one page picture per page, but its text cannot be resized, searched or
// highlighted.
//
// What it cannot do: tables and footnote links are not rebuilt, and complex
// layouts (magazines, textbooks with sidebars) can come out in the wrong
// reading order.

import { ZipStore } from './zipstore.js'

const MAX_PDF_BYTES = 400 * 1024 * 1024
const MAX_PAGES = 5000
const MAX_SCAN_PAGES = 1200
const MAX_IMAGES = 2500
const MAX_IMAGE_BYTES = 350 * 1024 * 1024

export class ConvertError extends Error {}

let pdfjsPromise = null
function loadPdfjs() {
  pdfjsPromise ??= import('../vendor/pdfjs/pdf.min.js').then(lib => {
    lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href
    return lib
  })
  pdfjsPromise.catch(() => { pdfjsPromise = null })
  return pdfjsPromise
}

export async function isPdf(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer())
    const s = String.fromCharCode(...head)
    return s.includes('%PDF-')
  } catch { return false }
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
// Characters XML 1.0 does not allow would make the whole chapter unreadable.
const tidy = s => String(s).replace(/[^\x09\x0A\x0D\x20-퟿-�]/g, '').replace(/[ \t ]+/g, ' ')
const median = arr => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[a.length >> 1] }

// ---------------------------------------------------------------- pages to lines
// One page's text items, grouped into lines in the order the PDF wrote them
// (that keeps two-column pages in column order).
function linesOf(items, pageHeight) {
  const lines = []
  let cur = null
  for (const it of items) {
    if (typeof it.str !== 'string') continue
    const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 0
    const x = it.transform[4], y = it.transform[5]
    if (!it.str.trim()) { if (cur && it.hasEOL) cur.eol = true; continue }
    const sameLine = cur && !cur.eol && Math.abs(y - cur.y) < Math.max(2, cur.size * 0.45) && x >= cur.x1 - cur.size * 0.5
    if (sameLine) {
      const gap = x - cur.x1
      cur.text += (gap > cur.size * 0.18 && !cur.text.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + it.str
      cur.x1 = x + (it.width || 0)
      cur.chars += it.str.length; cur.sizeSum += size * it.str.length
    } else {
      if (cur) lines.push(cur)
      cur = { text: it.str, x0: x, x1: x + (it.width || 0), y, size, chars: it.str.length, sizeSum: size * it.str.length, eol: false }
    }
    if (it.hasEOL) cur.eol = true
  }
  if (cur) lines.push(cur)
  for (const l of lines) {
    l.size = l.chars ? l.sizeSum / l.chars : l.size
    l.text = tidy(l.text).trim()
    l.top = pageHeight ? 1 - l.y / pageHeight : 0.5 // 0 at the top of the page, 1 at the bottom
  }
  return lines.filter(l => l.text)
}

// ---------------------------------------------------------------- pictures
const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
]

// Where each picture sits on a page, in the page's own coordinates.
async function imagesOn(page, OPS) {
  let list
  try { list = await page.getOperatorList() } catch { return [] }
  const out = []
  let ctm = [1, 0, 0, 1, 0, 0]
  const stack = []
  const paint = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintJpegXObject].filter(v => v !== undefined))
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i], args = list.argsArray[i]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
    else if (fn === OPS.transform) ctm = mul(ctm, args)
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(args?.[0]) && args[0].length === 6) ctm = mul(ctm, args[0]) }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
    else if (paint.has(fn)) {
      const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]]
      const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]]
      const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
      const w = box.x1 - box.x0, h = box.y1 - box.y0
      if (!(w > 0 && h > 0) || !Number.isFinite(w + h)) continue
      out.push({ ...box, w, h, key: `${typeof args?.[0] === 'string' ? args[0] : 'inline'}:${Math.round(w)}x${Math.round(h)}` })
    }
  }
  return out
}

async function renderPage(page, maxWidth, maxScale = 2.2) {
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: Math.min(maxScale, maxWidth / base.width) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(viewport.width)); canvas.height = Math.max(1, Math.round(viewport.height))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport }).promise
  return { canvas, viewport }
}

async function toJpeg(canvas, quality = 0.86) {
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality))
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}

// Cut the kept pictures out of one rendered page.
async function cropImages(page, boxes) {
  const { canvas, viewport } = await renderPage(page, 1500)
  const out = []
  for (const b of boxes) {
    const [ax, ay, bx, by] = viewport.convertToViewportRectangle([b.x0, b.y0, b.x1, b.y1])
    const x = Math.max(0, Math.floor(Math.min(ax, bx))), y = Math.max(0, Math.floor(Math.min(ay, by)))
    const w = Math.min(canvas.width - x, Math.ceil(Math.abs(bx - ax))), h = Math.min(canvas.height - y, Math.ceil(Math.abs(by - ay)))
    if (w < 24 || h < 24) { out.push(null); continue }
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    c.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h)
    const data = await toJpeg(c)
    out.push(data ? { data, w, h } : null)
    c.width = c.height = 0
  }
  canvas.width = canvas.height = 0
  return out
}

// ---------------------------------------------------------------- headers, footers, page numbers
const edgeKey = t => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
const isPageNumber = t => /^(?:page\s+)?[-–—\s]*(?:\d{1,4}|[ivxlcdm]{1,7})[-–—\s]*$/i.test(t)

function stripFurniture(pages) {
  const counts = new Map()
  for (const lines of pages) {
    const seen = new Set()
    for (const l of lines) {
      if (l.img || (l.top > 0.1 && l.top < 0.9)) continue
      const k = edgeKey(l.text)
      if (k.length > 90 || seen.has(k)) continue
      seen.add(k); counts.set(k, (counts.get(k) || 0) + 1)
    }
  }
  const need = Math.max(3, pages.length * 0.25)
  return pages.map(lines => lines.filter(l => {
    if (l.img || (l.top > 0.1 && l.top < 0.9)) return true
    if (isPageNumber(l.text)) return false
    return (counts.get(edgeKey(l.text)) || 0) < need
  }))
}

// ---------------------------------------------------------------- lines to blocks
function blocksOf(pages, bodySize) {
  const blocks = []
  const allX = [], allW = []
  for (const lines of pages) for (const l of lines) if (Math.abs(l.size - bodySize) < bodySize * 0.12 && l.text.length > 40) { allX.push(Math.round(l.x0)); allW.push(l.x1) }
  const left = median(allX), right = median(allW)
  const width = Math.max(1, right - left)

  let para = null
  let waiting = [] // pictures met in mid sentence wait for the paragraph to end
  const flush = () => { if (para?.text) blocks.push(para); para = null; if (waiting.length) { blocks.push(...waiting); waiting = [] } }
  const startsLower = t => /^[a-zà-ÿ]/.test(t)

  pages.forEach((lines, pageIndex) => {
    let prev = null
    for (const l of lines) {
      if (l.img) {
        const block = { type: 'img', ...l.img, page: pageIndex }
        if (para && !/[.!?:;"”’»)\]]$/.test(para.text)) waiting.push(block)
        else { flush(); blocks.push(block); prev = { ...l, isHeading: true } }
        continue
      }
      const ratio = l.size / bodySize
      const short = l.text.length <= 140
      if (ratio >= 1.18 && short && /\p{L}/u.test(l.text)) {
        // A heading. Two heading lines in a row, same size, are one heading.
        const last = blocks[blocks.length - 1]
        if (!para && last?.type === 'h' && last.page === pageIndex && Math.abs(last.size - l.size) < 0.6 && prev && prev.isHeading) last.text += ' ' + l.text
        else { flush(); blocks.push({ type: 'h', level: ratio >= 1.55 ? 1 : 2, text: l.text, size: l.size, page: pageIndex }) }
        prev = { ...l, isHeading: true }
        continue
      }
      const gap = prev && !prev.isHeading ? prev.y - l.y : 0
      const lineGap = l.size * 1.2
      const newPara =
        !para ||
        (prev && prev.isHeading) ||
        (gap > lineGap * 1.6 && gap < l.size * 30) ||                         // a blank line between them
        (l.x0 - left > l.size * 0.9 && l.x0 - left < width * 0.25) ||           // an indented first line
        (prev && prev.x1 < right - width * 0.14 && /[.!?:;"”’»)\]]$/.test(prev.text) && !startsLower(l.text)) // the last line ended early
      if (newPara && !(para && prev === null && startsLower(l.text))) { // a page break in mid sentence is not a new paragraph
        flush()
        para = { type: 'p', text: l.text, page: pageIndex }
      } else if (/[\p{L}]-$/u.test(para.text) && startsLower(l.text)) {
        para.text = para.text.slice(0, -1) + l.text // a word broken across two lines
      } else {
        para.text += ' ' + l.text
      }
      prev = l
    }
  })
  flush()
  return blocks
}

// ---------------------------------------------------------------- blocks to chapters
async function outlineStarts(pdf) {
  let outline = null
  try { outline = await pdf.getOutline() } catch { return [] }
  if (!Array.isArray(outline) || !outline.length) return []
  const out = []
  for (const item of outline.slice(0, 400)) {
    try {
      let dest = item.dest
      if (typeof dest === 'string') dest = await pdf.getDestination(dest)
      if (!Array.isArray(dest) || !dest[0]) continue
      const page = typeof dest[0] === 'object' ? await pdf.getPageIndex(dest[0]) : Number(dest[0])
      const title = tidy(item.title || '').trim().slice(0, 200)
      if (Number.isInteger(page) && page >= 0 && title) out.push({ page, title })
    } catch { /* a broken bookmark: skip it */ }
  }
  out.sort((a, b) => a.page - b.page)
  return out.filter((o, i) => i === 0 || o.page !== out[i - 1].page)
}

function chaptersOf(blocks, starts, pageCount) {
  const chapters = []
  if (starts.length >= 2) {
    // The PDF's own outline says where chapters begin.
    const bounds = starts[0].page > 0 ? [{ page: 0, title: 'Front matter' }, ...starts] : starts
    bounds.forEach((s, i) => {
      const end = bounds[i + 1]?.page ?? Infinity
      const mine = blocks.filter(b => b.page >= s.page && b.page < end)
      if (mine.length) chapters.push({ title: s.title, blocks: mine })
    })
    return chapters
  }
  const headings = blocks.filter(b => b.type === 'h')
  const level = headings.some(h => h.level === 1) && headings.filter(h => h.level === 1).length >= 2 ? 1 : 2
  const breaks = headings.filter(h => h.level <= level)
  if (breaks.length >= 2 && breaks.length <= 600) {
    let cur = { title: 'Front matter', blocks: [] }
    for (const b of blocks) {
      if (b.type === 'h' && b.level <= level) { if (cur.blocks.length) chapters.push(cur); cur = { title: b.text.slice(0, 200), blocks: [b] } }
      else cur.blocks.push(b)
    }
    if (cur.blocks.length) chapters.push(cur)
    return chapters
  }
  // No structure to go on: equal parts, so no single file is enormous.
  const per = 20
  for (let p = 0; p < pageCount; p += per) {
    const mine = blocks.filter(b => b.page >= p && b.page < p + per)
    if (mine.length) chapters.push({ title: `Pages ${p + 1} to ${Math.min(pageCount, p + per)}`, blocks: mine })
  }
  return chapters
}

// ---------------------------------------------------------------- the EPUB
const XHTML = (title, body, lang) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${esc(lang)}" xml:lang="${esc(lang)}">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>`

const CSS = `body { margin: 0; padding: 0; }
h1, h2 { text-align: left; line-height: 1.25; margin: 2em 0 1em; page-break-after: avoid; }
h1 { font-size: 1.5em; }
h2 { font-size: 1.2em; }
p { margin: 0; text-indent: 1.4em; }
h1 + p, h2 + p, p.first { text-indent: 0; }
.cover { text-align: center; margin: 0; padding: 0; }
.cover img { max-width: 100%; max-height: 100%; }
.fig { text-align: center; margin: 1.2em 0; text-indent: 0; page-break-inside: avoid; }
.fig img { max-width: 100%; height: auto; }
.scan { text-align: center; margin: 0; padding: 0; }
.scan img { max-width: 100%; max-height: 100vh; height: auto; }
`

function buildEpub({ title, author, lang, chapters, cover, id, images = [] }) {
  const zip = new ZipStore({ tooLarge: 'This PDF is too large to convert.' })
  zip.add('mimetype', 'application/epub+zip')
  zip.add('META-INF/container.xml', `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
  zip.add('OEBPS/style.css', CSS)
  for (const im of images) zip.add(`OEBPS/${im.href}`, im.data)

  const files = chapters.map((c, i) => ({ id: `c${i + 1}`, href: `chapter-${String(i + 1).padStart(4, '0')}.xhtml`, title: c.title }))
  chapters.forEach((c, i) => {
    let first = true
    const body = c.blocks.map(b => {
      if (b.type === 'h') { first = true; return `<h${b.level}>${esc(b.text)}</h${b.level}>` }
      if (b.type === 'scan') return `<div class="scan"><img src="${esc(b.href)}" alt="Page ${b.page + 1}" width="${b.w}" height="${b.h}"/></div>`
      if (b.type === 'img') { first = true; return `<div class="fig"><img src="${esc(b.href)}" alt="" width="${b.w}" height="${b.h}"/></div>` }
      const cls = first ? ' class="first"' : ''
      first = false
      return `<p${cls}>${esc(b.text)}</p>`
    }).join('\n')
    const hasHeading = c.blocks[0]?.type === 'h' || c.plain
    zip.add(`OEBPS/${files[i].href}`, XHTML(c.title, (hasHeading ? '' : `<h1>${esc(c.title)}</h1>\n`) + body, lang))
  })

  if (cover) {
    zip.add('OEBPS/cover.jpg', cover)
    zip.add('OEBPS/cover.xhtml', XHTML(title, `<div class="cover"><img src="cover.jpg" alt="${esc(title)}"/></div>`, lang))
  }
  zip.add('OEBPS/nav.xhtml', XHTML(title, `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${files.map(f => `<li><a href="${f.href}">${esc(f.title)}</a></li>`).join('\n')}
</ol></nav>`, lang))

  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  zip.add('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${esc(lang)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:${esc(id)}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
${author ? `<dc:creator>${esc(author)}</dc:creator>\n` : ''}<dc:language>${esc(lang)}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
${cover ? '<meta name="cover" content="cover-image"/>\n' : ''}</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
${cover ? '<item id="cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>\n<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>\n' : ''}${files.map(f => `<item id="${f.id}" href="${f.href}" media-type="application/xhtml+xml"/>`).join('\n')}
${images.map((im, i) => `<item id="i${i + 1}" href="${im.href}" media-type="image/jpeg"/>`).join('\n')}
</manifest>
<spine>
${cover ? '<itemref idref="cover" linear="no"/>\n' : ''}${files.map(f => `<itemref idref="${f.id}"/>`).join('\n')}
</spine>
</package>`)
  return zip.finish('application/epub+zip')
}

async function renderCover(pdf) {
  try {
    const page = await pdf.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: Math.min(2.5, 900 / base.width) })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height)
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85))
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null
  } catch { return null }
}

// ---------------------------------------------------------------- the conversion
// Resolves to { file, scanned, pictures }. onProgress(page, pages, what); signal cancels.
export async function pdfToEpub(file, { onProgress = () => {}, signal } = {}) {
  const label = file.name || 'This PDF'
  if (file.size > MAX_PDF_BYTES) throw new ConvertError(`${label} is larger than 400 MB.`)
  const stop = () => { if (signal?.aborted) throw new ConvertError('Conversion cancelled.') }

  let pdfjs
  try { pdfjs = await loadPdfjs() } catch { throw new ConvertError('The PDF reader could not start on this device.') }
  let pdf, task
  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      isEvalSupported: false,       // never build code from what a PDF says
      enableXfa: false,
      disableAutoFetch: true, disableRange: true, disableStream: true,
      cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href, cMapPacked: true,
      verbosity: 0,
    })
    pdf = await task.promise
  } catch (e) {
    if (e?.name === 'PasswordException') throw new ConvertError(`${label} is locked with a password. Remove the password first.`)
    throw new ConvertError(`${label} could not be opened. The file may be damaged.`)
  }

  try {
    if (pdf.numPages > MAX_PAGES) throw new ConvertError(`${label} has more than ${MAX_PAGES} pages.`)
    const OPS = pdfjs.OPS
    const pages = []
    const found = [] // per page: the pictures on it
    let chars = 0, emptyPages = 0, scan = false
    for (let n = 1; n <= pdf.numPages; n++) {
      stop()
      const page = await pdf.getPage(n)
      const view = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const lines = linesOf(content.items, view.height)
      const count = lines.reduce((s, l) => s + l.text.length, 0)
      chars += count
      if (count < 30) emptyPages++
      const imgs = (await imagesOn(page, OPS)).map(im => ({ ...im, pageArea: view.width * view.height, textChars: count }))
      pages.push(lines); found.push(imgs)
      page.cleanup()
      onProgress(n, pdf.numPages, 'Reading')
      // An obvious scan: stop reading for text that is not there.
      if (n === 25 && chars < 400) { scan = true; break }
    }
    const read = pages.length
    if (chars < read * 40 || emptyPages > read * 0.7) scan = true

    let info = {}
    try { info = (await pdf.getMetadata())?.info ?? {} } catch { info = {} }
    const fallback = (file.name || 'Untitled').replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled'
    const metaTitle = tidy(info.Title || '').trim()
    // Many PDFs carry a file name or "Microsoft Word - x.doc" as their title.
    const title = (metaTitle && metaTitle.length > 2 && !/\.(pdf|docx?|indd|qxd|tex)$/i.test(metaTitle) && !/^(untitled|microsoft word)/i.test(metaTitle) ? metaTitle : fallback).slice(0, 300)
    const rawAuthor = tidy(info.Author || '').trim().slice(0, 300)
    const author = /^(anonymous|unknown|user|admin|owner)$/i.test(rawAuthor) ? '' : rawAuthor
    const lang = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(info.Language || '') ? info.Language : 'en'
    const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const name = `${fallback.slice(0, 120)}.epub`
    const starts = await outlineStarts(pdf)

    // ---- a scan: one picture per page
    if (scan) {
      if (pdf.numPages > MAX_SCAN_PAGES) throw new ConvertError(`${label} is a scan with more than ${MAX_SCAN_PAGES} pages, which is too large to convert.`)
      const images = []
      const blocks = []
      let bytes = 0
      for (let n = 1; n <= pdf.numPages; n++) {
        stop()
        const page = await pdf.getPage(n)
        try {
          const { canvas } = await renderPage(page, 1400, 3.4)
          const data = await toJpeg(canvas, 0.8)
          if (data) {
            const href = `images/page-${String(n).padStart(4, '0')}.jpg`
            images.push({ href, data }); bytes += data.length
            blocks.push({ type: 'scan', href, w: canvas.width, h: canvas.height, page: n - 1 })
          }
          canvas.width = canvas.height = 0
        } catch { /* a page that cannot be drawn is left out */ }
        page.cleanup()
        onProgress(n, pdf.numPages, 'Copying')
        if (bytes > MAX_IMAGE_BYTES) throw new ConvertError(`${label} is too large to convert: its page pictures pass ${Math.round(MAX_IMAGE_BYTES / 1048576)} MB.`)
      }
      if (!blocks.length) throw new ConvertError(`${label} has no pages that could be read.`)
      const bounds = starts.length >= 2 ? (starts[0].page > 0 ? [{ page: 0, title: 'Start' }, ...starts] : starts)
        : Array.from({ length: Math.ceil(pdf.numPages / 10) }, (_, i) => ({ page: i * 10, title: `Page ${i * 10 + 1}` }))
      const chapters = bounds.map((s, i) => ({ title: s.title, plain: true, blocks: blocks.filter(b => b.page >= s.page && b.page < (bounds[i + 1]?.page ?? Infinity)) })).filter(c => c.blocks.length)
      const blob = buildEpub({ title, author, lang, chapters, cover: images[0]?.data ?? null, id, images })
      return { file: new File([blob], name, { type: 'application/epub+zip' }), scanned: true, pictures: 0 }
    }

    // ---- pictures worth keeping
    const seenOn = new Map()
    found.forEach(imgs => { for (const k of new Set(imgs.map(i => i.key))) seenOn.set(k, (seenOn.get(k) || 0) + 1) })
    const repeats = Math.max(3, read * 0.2)
    const images = []
    let bytes = 0
    for (let n = 0; n < read; n++) {
      const keep = found[n].filter(im => {
        if (im.w < 40 || im.h < 40 || im.w / im.h > 20 || im.h / im.w > 20) return false   // rules, bullets, icons
        if ((seenOn.get(im.key) || 0) >= repeats) return false                              // a logo or background on many pages
        if (im.w * im.h > im.pageArea * 0.85 && im.textChars > 300) return false            // a backdrop behind the text
        return true
      }).slice(0, 12)
      if (!keep.length || images.length >= MAX_IMAGES || bytes > MAX_IMAGE_BYTES) continue
      stop()
      const page = await pdf.getPage(n + 1)
      let crops = []
      try { crops = await cropImages(page, keep) } catch { crops = [] }
      page.cleanup()
      keep.forEach((im, i) => {
        const c = crops[i]
        if (!c) return
        const href = `images/p${String(n + 1).padStart(4, '0')}-${i + 1}.jpg`
        images.push({ href, data: c.data }); bytes += c.data.length
        // Put it between the lines, where it stood on the page.
        const lines = pages[n]
        const at = lines.findIndex(l => !l.img && l.y < im.y0)
        lines.splice(at < 0 ? lines.length : at, 0, { img: { href, w: c.w, h: c.h }, text: '', y: im.y1, size: 0, top: 0.5 })
      })
      onProgress(n + 1, read, 'Copying pictures')
    }

    const sizes = new Map()
    for (const lines of pages) for (const l of lines) { if (l.img) continue; const k = Math.round(l.size * 2) / 2; sizes.set(k, (sizes.get(k) || 0) + l.text.length) }
    const bodySize = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10

    const blocks = blocksOf(stripFurniture(pages), bodySize)
    if (!blocks.length) throw new ConvertError(`${label} has no readable text.`)
    stop()
    const chapters = chaptersOf(blocks, starts, pdf.numPages)
    const used = new Set(blocks.filter(b => b.type === 'img').map(b => b.href))
    const cover = await renderCover(pdf)
    stop()
    const blob = buildEpub({ title, author, lang, chapters, cover, id, images: images.filter(im => used.has(im.href)) })
    return { file: new File([blob], name, { type: 'application/epub+zip' }), scanned: false, pictures: used.size }
  } finally {
    try { await task.destroy() } catch { /* already gone */ }
  }
}
