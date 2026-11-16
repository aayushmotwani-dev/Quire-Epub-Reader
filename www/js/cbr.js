// CBR comics are RAR archives. Quire unpacks one here, on the device, and
// repacks its pages as a CBZ (a plain ZIP), which the reader already opens.
// The RAR code is the official unRAR source compiled to WebAssembly.

import { ZipStore } from './zipstore.js'

const MAX_PAGES = 3000
const MAX_UNPACKED = 1.5 * 1024 ** 3
const IMAGE = /\.(jpe?g|png|gif|webp|bmp|avif|jxl)$/i

export class RarError extends Error {}

export async function isRar(file) {
  try {
    const h = new Uint8Array(await file.slice(0, 8).arrayBuffer())
    // "Rar!" 1A 07 00 (RAR 4) or "Rar!" 1A 07 01 00 (RAR 5)
    return h[0] === 0x52 && h[1] === 0x61 && h[2] === 0x72 && h[3] === 0x21 && h[4] === 0x1a && h[5] === 0x07 && (h[6] === 0 || (h[6] === 1 && h[7] === 0))
  } catch { return false }
}

let lib = null
async function unrar() {
  lib ??= Promise.all([
    import('../vendor/unrar/unrar.js'),
    fetch(new URL('../vendor/unrar/unrar.wasm', import.meta.url)).then(r => { if (!r.ok) throw new Error('unrar.wasm'); return r.arrayBuffer() }),
  ])
  lib.catch(() => { lib = null })
  return lib
}

// Resolves to a .cbz File holding the comic's pages, in reading order.
export async function rarToCbz(file) {
  const label = file.name || 'This comic'
  let mod, wasmBinary
  try { [mod, wasmBinary] = await unrar() } catch { throw new RarError('The comic reader could not start on this device.') }

  let extractor
  try {
    extractor = await mod.createExtractorFromData({ wasmBinary, data: await file.arrayBuffer() })
  } catch (e) {
    throw new RarError(`${label} could not be opened. The file may be damaged.`)
  }

  const pages = []
  let total = 0
  let info = null // ComicInfo.xml: title, series and reading direction
  try {
    const { files } = extractor.extract({
      files: h => !h.flags.directory && (IMAGE.test(h.name) || /(^|\/)comicinfo\.xml$/i.test(h.name)) && !/(^|\/)(__MACOSX|\.)/.test(h.name),
    })
    for (const f of files) {
      const data = f.extraction
      if (!data?.length) continue
      total += data.length
      if (pages.length >= MAX_PAGES || total > MAX_UNPACKED) throw new RarError(`${label} is too large to open.`)
      if (/comicinfo\.xml$/i.test(f.fileHeader.name)) { if (data.length < 512 * 1024) info = data; continue }
      pages.push({ name: f.fileHeader.name, data })
    }
  } catch (e) {
    if (e instanceof RarError) throw e
    const reason = e?.reason || ''
    if (/PASSWORD/.test(reason)) throw new RarError(`${label} is locked with a password.`)
    if (/VOLUME|EOPEN/.test(reason) || /volume/i.test(e?.message || '')) throw new RarError(`${label} is one part of a split archive. Join the parts first.`)
    throw new RarError(`${label} could not be unpacked. The file may be damaged.`)
  }
  if (!pages.length) throw new RarError(`${label} has no pictures in it, so it is not a comic Quire can show.`)

  // Natural order (page2 before page10), folders included, then plain names in the ZIP.
  const order = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  pages.sort((a, b) => order.compare(a.name, b.name))
  const zip = new ZipStore({ tooLarge: `${label} is too large to open.` })
  const width = String(pages.length).length
  pages.forEach((p, i) => {
    const ext = p.name.match(IMAGE)[0].toLowerCase()
    zip.add(`page-${String(i + 1).padStart(Math.max(4, width), '0')}${ext}`, p.data)
  })
  if (info) zip.add('ComicInfo.xml', info)
  const base = (file.name || 'comic').replace(/\.(cbr|rar)$/i, '')
  return new File([zip.finish()], `${base}.cbz`, { type: 'application/vnd.comicbook+zip' })
}
