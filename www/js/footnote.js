// Footnotes: tapping a note number shows the note in a small card instead of
// jumping to the back of the book. Only text is ever taken from the book.

const NOTE_TYPES = /(^|\s)(noteref|footnote|endnote|rearnote)(\s|$)/
const MAX_NOTE = 1800

// Decided at once, while the tap is being handled.
export function isNoteLink(a) {
  if (!a) return false
  const type = a.getAttribute('epub:type') || a.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type') || ''
  if (NOTE_TYPES.test(type) || /doc-noteref/.test(a.getAttribute('role') || '') || a.getAttribute('type') === 'note') return true
  const text = (a.textContent || '').trim()
  if (!text || text.length > 6) return false
  const href = a.getAttribute('href') || ''
  if (!href.includes('#')) return false
  const marker = /^[\[(]?(\d{1,4}|[*†‡§¶]{1,3}|[a-z])[\])]?$/i.test(text)
  if (!marker) return false
  const raised = !!a.closest('sup') || !!a.querySelector('sup') || /super/.test(a.ownerDocument.defaultView?.getComputedStyle(a).verticalAlign || '')
  const named = /note|fn|foot|endn|ftn/i.test(href + ' ' + a.className + ' ' + a.id)
  // A bare number is only a note when it is raised, bracketed or named like one (a contents page is full of bare numbers).
  return raised || named || /^[\[(*†‡§¶]/.test(text)
}

const BLOCK = '[epub\\:type~="footnote"], [epub\\:type~="endnote"], [epub\\:type~="rearnote"], [role="doc-footnote"], [role="doc-endnote"], aside, li, dd, p, div, section, td, blockquote'

function textOf(block) {
  const copy = block.cloneNode(true)
  // Drop the "back to the text" arrows and links.
  for (const a of copy.querySelectorAll('a')) {
    const t = (a.textContent || '').trim()
    const type = a.getAttribute('epub:type') || ''
    if (/backlink/.test(type) || /doc-backlink/.test(a.getAttribute('role') || '') || /^[↩↑⏎←^]+$/.test(t) || /^(back|return)$/i.test(t)) a.remove()
  }
  for (const n of copy.querySelectorAll('script, style, rt, rp')) n.remove()
  let text = (copy.textContent || '').replace(/\s+/g, ' ').trim()
  text = text.replace(/^[\[(]?(\d{1,4}|[*†‡§¶]{1,3})[\]).:]?\s+/, '') // the note's own number
  return text
}

// Resolves to the note's text, or null when the link is not a readable note
// (then the reader follows the link as usual).
export async function noteText(view, docs, href) {
  let resolved
  try { resolved = view.resolveNavigation(href) } catch { return null }
  if (!resolved || !Number.isInteger(resolved.index) || typeof resolved.anchor !== 'function') return null
  let doc = docs.get(resolved.index)
  if (!doc) {
    try { doc = await view.book.sections[resolved.index]?.createDocument?.() } catch { doc = null }
  }
  if (!doc) return null
  let target
  try { target = resolved.anchor(doc) } catch { return null }
  if (!target || typeof target === 'number') return null
  let node = target.nodeType === 1 ? target : target.startContainer ?? target.commonAncestorContainer
  if (node?.nodeType !== 1) node = node?.parentElement
  if (!node) return null
  const block = node.matches?.(BLOCK) ? node : node.closest?.(BLOCK)
  if (!block || block === doc.body) return null
  const text = textOf(block)
  // Too short to be a note, or so long it is a chapter that happens to be linked.
  if (text.length < 2 || text.length > 6000) return null
  return text.length > MAX_NOTE ? text.slice(0, MAX_NOTE).replace(/\s+\S*$/, '') + '…' : text
}
