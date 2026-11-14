// PDF to EPUB: rebuilds a text PDF as a reflowable book, on the device.
//
// What it can do: read the text of each page, drop the running headers and
// page numbers, join the lines back into paragraphs, find headings by their
// size, split the book into chapters (from the PDF's own outline when it has
// one), and put the first page on the cover.
//
// What it cannot do: a scanned PDF has no text, only pictures of pages, so it
// is refused with an explanation. Pictures, tables and footnote links inside
// the pages are not carried over, and complex layouts (magazines, textbooks
// with sidebars) can come out in the wrong reading order.

import { ZipStore } from './zipstore.js'

const MAX_PDF_BYTES = 400 * 1024 * 1024
const MAX_PAGES = 5000

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

// ---------------------------------------------------------------- headers, footers, page numbers
const edgeKey = t => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
const isPageNumber = t => /^(?:page\s+)?[-–—\s]*(?:\d{1,4}|[ivxlcdm]{1,7})[-–—\s]*$/i.test(t)

function stripFurniture(pages) {
  const counts = new Map()
  for (const lines of pages) {
    const seen = new Set()
    for (const l of lines) {
      if (l.top > 0.1 && l.top < 0.9) continue
      const k = edgeKey(l.text)
      if (k.length > 90 || seen.has(k)) continue
      seen.add(k); counts.set(k, (counts.get(k) || 0) + 1)
    }
  }
  const need = Math.max(3, pages.length * 0.25)
  return pages.map(lines => lines.filter(l => {
    if (l.top > 0.1 && l.top < 0.9) return true
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
  const flush = () => { if (para?.text) blocks.push(para); para = null }
  const startsLower = t => /^[a-zà-ÿ]/.test(t)

  pages.forEach((lines, pageIndex) => {
    let prev = null
    for (const l of lines) {
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
`

function buildEpub({ title, author, lang, chapters, cover, id }) {
  const zip = new ZipStore({ tooLarge: 'This PDF is too large to convert.' })
  zip.add('mimetype', 'application/epub+zip')
  zip.add('META-INF/container.xml', `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
  zip.add('OEBPS/style.css', CSS)

  const files = chapters.map((c, i) => ({ id: `c${i + 1}`, href: `chapter-${String(i + 1).padStart(4, '0')}.xhtml`, title: c.title }))
  chapters.forEach((c, i) => {
    let first = true
    const body = c.blocks.map(b => {
      if (b.type === 'h') { first = true; return `<h${b.level}>${esc(b.text)}</h${b.level}>` }
      const cls = first ? ' class="first"' : ''
      first = false
      return `<p${cls}>${esc(b.text)}</p>`
    }).join('\n')
    const hasHeading = c.blocks[0]?.type === 'h'
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
// Resolves to an EPUB File. onProgress(page, pages); signal cancels.
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
    const pages = []
    let chars = 0, emptyPages = 0
    for (let n = 1; n <= pdf.numPages; n++) {
      stop()
      const page = await pdf.getPage(n)
      const height = page.getViewport({ scale: 1 }).height
      const content = await page.getTextContent()
      const lines = linesOf(content.items, height)
      const count = lines.reduce((s, l) => s + l.text.length, 0)
      chars += count
      if (count < 30) emptyPages++
      pages.push(lines)
      page.cleanup()
      onProgress(n, pdf.numPages)
      // Give up early on an obvious scan instead of reading every page.
      if (n === 25 && chars < 400) break
    }
    const read = pages.length
    if (chars < read * 40 || emptyPages > read * 0.7)
      throw new ConvertError(`${label} looks like a scan: its pages are pictures, with no text to read. Quire cannot convert scanned PDFs yet.`)

    const sizes = new Map()
    for (const lines of pages) for (const l of lines) { const k = Math.round(l.size * 2) / 2; sizes.set(k, (sizes.get(k) || 0) + l.text.length) }
    const bodySize = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10

    const blocks = blocksOf(stripFurniture(pages), bodySize)
    if (!blocks.length) throw new ConvertError(`${label} has no readable text.`)
    stop()
    const chapters = chaptersOf(blocks, await outlineStarts(pdf), pdf.numPages)

    let info = {}
    try { info = (await pdf.getMetadata())?.info ?? {} } catch { info = {} }
    const fallback = (file.name || 'Untitled').replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled'
    const metaTitle = tidy(info.Title || '').trim()
    // Many PDFs carry a file name or "Microsoft Word - x.doc" as their title.
    const title = (metaTitle && metaTitle.length > 2 && !/\.(pdf|docx?|indd|qxd|tex)$/i.test(metaTitle) && !/^(untitled|microsoft word)/i.test(metaTitle) ? metaTitle : fallback).slice(0, 300)
    const rawAuthor = tidy(info.Author || '').trim().slice(0, 300)
    const author = /^(anonymous|unknown|user|admin|owner)$/i.test(rawAuthor) ? '' : rawAuthor
    const lang = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(info.Language || '') ? info.Language : 'en'

    const cover = await renderCover(pdf)
    stop()
    const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const blob = buildEpub({ title, author, lang, chapters, cover, id })
    return new File([blob], `${fallback.slice(0, 120)}.epub`, { type: 'application/epub+zip' })
  } finally {
    try { await task.destroy() } catch { /* already gone */ }
  }
}
