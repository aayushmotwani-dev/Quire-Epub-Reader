// "Your words" in the Dictionary sheet: the list, and a simple flashcard review.

import { $, el, toast } from './ui.js'
import { vocabList, forgetWord, markKnown } from './vocab.js'

let pick = () => {}
let deck = []
let at = 0
let flipped = false

export function drawVocab() {
  const list = vocabList()
  const box = $('#vocab')
  if ($('#vocab-cards').hidden) box.hidden = !list.length
  const learning = list.filter(v => !v.k).length
  $('#vocab-title').textContent = `Your words (${list.length})`
  $('#vocab-review').textContent = learning ? `Review ${learning}` : 'Review all'
  $('#vocab-list').replaceChildren(...list.map(v => el('li', { class: 'vocab-item' + (v.k ? ' is-known' : '') },
    el('button', { type: 'button', class: 'vocab-main', onclick: () => pick(v.w) },
      el('span', { class: 'vocab-word' }, el('b', { text: v.w }), v.p ? el('i', { text: v.p }) : null, v.k ? el('span', { class: 'vocab-known', text: 'Known' }) : null),
      el('span', { class: 'vocab-def', text: v.d }),
      v.s ? el('span', { class: 'vocab-ctx', text: `“${v.s}”${v.b ? `, ${v.b}` : ''}` }) : null),
    el('button', { type: 'button', class: 'icon-btn vocab-x', icon: 'close', 'aria-label': `Remove ${v.w}`, title: 'Remove',
      onclick: () => { forgetWord(v.w); drawVocab() } }))))
}

function showCard() {
  const v = deck[at]
  if (!v) return endReview(true)
  flipped = false
  $('#card-count').textContent = `Word ${at + 1} of ${deck.length}. Tap the card to see the meaning.`
  drawCard()
}

function drawCard() {
  const v = deck[at]
  $('#card').replaceChildren(
    el('span', { class: 'flash-word', text: v.w }),
    flipped
      ? el('span', { class: 'flash-def' }, v.p ? el('i', { text: v.p + ' ' }) : null, el('span', { text: v.d }))
      : (v.s ? el('span', { class: 'flash-ctx', text: `“${v.s}”` }) : el('span', { class: 'flash-ctx', text: 'What does it mean?' })))
  $('#card').setAttribute('aria-label', flipped ? `${v.w}: ${v.d}` : `${v.w}. Tap to see the meaning.`)
}

function startReview() {
  const all = vocabList()
  const learning = all.filter(v => !v.k)
  deck = (learning.length ? learning : all).slice(0, 40)
  if (!deck.length) return
  at = 0
  $('#vocab').hidden = true
  $('#dict-result').hidden = true
  $('#vocab-cards').hidden = false
  showCard()
}

function endReview(finished = false) {
  $('#vocab-cards').hidden = true
  $('#dict-result').hidden = false
  drawVocab()
  if (finished) toast('Review finished')
}

export function initVocabUI({ onPick }) {
  pick = onPick
  $('#vocab-review').addEventListener('click', startReview)
  $('#card').addEventListener('click', () => { flipped = !flipped; drawCard() })
  $('#card-again').addEventListener('click', () => { at++; showCard() })
  $('#card-known').addEventListener('click', () => { markKnown(deck[at].w); at++; showCard() })
  $('#card-done').addEventListener('click', () => endReview())
}

export const closeReview = () => { if (!$('#vocab-cards').hidden) endReview() }
