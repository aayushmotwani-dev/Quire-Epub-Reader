import * as db from './db.js'
import { toast } from './ui.js'

// Highlights and notes as a Markdown file, in book order.
export async function exportHighlights(book) {
  const all = await db.annotationsFor(book.id)
  const items = all.filter(a => a.type === 'highlight').sort((a, b) => (a.fraction ?? 0) - (b.fraction ?? 0))
  if (!items.length) {
    toast('This book has no highlights yet')
    return
  }
  const lines = [`# ${book.title}`]
  if (book.author) lines.push('', `*${book.author}*`)
  let chapter = null
  for (const h of items) {
    if (h.chapter && h.chapter !== chapter) {
      chapter = h.chapter
      lines.push('', `## ${chapter}`)
    }
    lines.push('', ...h.text.split('\n').map(l => `> ${l}`))
    if (h.note) lines.push('', h.note)
  }
  lines.push('')
  const name = `${book.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 80) || 'Highlights'} - highlights.md`
  const file = new File([lines.join('\n')], name, { type: 'text/markdown' })

  // Phones: the share sheet is the natural way to save or send a file.
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name })
      return
    } catch (e) {
      if (e?.name === 'AbortError') return
      // fall through to a normal download
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  toast(`Saved ${items.length} ${items.length === 1 ? 'highlight' : 'highlights'}`)
}
