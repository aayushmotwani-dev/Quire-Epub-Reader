import * as db from './db.js'
import { toast } from './ui.js'
import { saveFile } from './share.js'

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

  if (await saveFile(file)) toast(`Saved ${items.length} ${items.length === 1 ? 'highlight' : 'highlights'}`)
}
