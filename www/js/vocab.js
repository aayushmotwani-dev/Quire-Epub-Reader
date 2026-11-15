// Vocabulary: every word looked up inside a book is kept, with the sentence
// it was met in, so it can be reviewed later. Kept on this device only.

import { getFlag, setFlag } from './settings.js'

const MAX_WORDS = 600
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

export function vocabList() {
  const raw = getFlag('vocab', [])
  if (!Array.isArray(raw)) return []
  return raw.filter(v => v && typeof v.w === 'string' && v.w).map(v => ({
    w: clean(v.w, 60), d: clean(v.d, 400), p: clean(v.p, 20), s: clean(v.s, 320), b: clean(v.b, 200),
    t: Number.isFinite(v.t) ? v.t : 0, k: v.k === true,
  })).slice(0, MAX_WORDS)
}

const save = list => setFlag('vocab', list.slice(0, MAX_WORDS))

// entry is a dictionary entry; sentence and book say where the word was met.
export function rememberWord(entry, { sentence = '', book = '' } = {}) {
  if (!entry?.found) return
  const w = clean(entry.lemma || entry.word, 60).toLowerCase()
  const first = entry.groups?.[0]
  const d = clean(first?.senses?.[0]?.definition, 400)
  if (!w || !d) return
  const list = vocabList()
  const old = list.find(v => v.w === w)
  const item = { w, d, p: clean(first.label, 20), s: clean(sentence, 320) || old?.s || '', b: clean(book, 200) || old?.b || '', t: Date.now(), k: false }
  save([item, ...list.filter(v => v.w !== w)])
}

export function forgetWord(w) { save(vocabList().filter(v => v.w !== w)) }
export function markKnown(w, known = true) { save(vocabList().map(v => v.w === w ? { ...v, k: known } : v)) }

// The sentence around a selection, for context.
export function sentenceAround(range) {
  try {
    const block = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)?.closest('p, li, blockquote, dd, td, div, h1, h2, h3, h4, h5, h6')
    const text = (block?.textContent || '').replace(/\s+/g, ' ').trim()
    const word = range.toString().replace(/\s+/g, ' ').trim()
    if (!text || !word) return ''
    const at = text.indexOf(word)
    if (at < 0) return ''
    let seg
    try { seg = new Intl.Segmenter(undefined, { granularity: 'sentence' }) } catch { return text.slice(Math.max(0, at - 120), at + 160).trim() }
    for (const { segment, index } of seg.segment(text)) if (at >= index && at < index + segment.length) return segment.trim()
    return ''
  } catch { return '' }
}
