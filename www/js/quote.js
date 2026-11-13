// Quote cards: a highlight or selection as a picture to keep or share.
// Drawn on a canvas on the device; nothing is uploaded.

import { $, el, showSheet, toast } from './ui.js'
import { saveFile, safeName } from './share.js'

const W = 1080, H = 1350, PAD = 108
const MAX_CHARS = 620

// The "quire." mark, dot by dot (same letterforms as the home screen).
const G = {
  q: ['.......', '.......', '.......', '.###.#.', '#...##.', '#....#.', '#....#.', '#....#.', '#...##.', '.###.#.', '.....#.', '.....#.', '....###'],
  u: ['.......', '.......', '.......', '##..##.', '.#...#.', '.#...#.', '.#...#.', '.#...#.', '.#..##.', '..##.##', '.......', '.......', '.......'],
  i: ['.....', '..#..', '.....', '###..', '..#..', '..#..', '..#..', '..#..', '..#..', '#####', '.....', '.....', '.....'],
  r: ['......', '......', '......', '##.##.', '.##..#', '.#....', '.#....', '.#....', '.#....', '####..', '......', '......', '......'],
  e: ['......', '......', '......', '.####.', '#....#', '#....#', '######', '#.....', '#....#', '.####.', '......', '......', '......'],
  '.': ['..', '..', '..', '..', '..', '..', '..', '..', '##', '##', '..', '..', '..'],
}

const STYLES = {
  paper: { name: 'Paper', bg: '#ffffff', ink: '#141414', soft: '#6e6e6e', dot: 'rgba(0,0,0,.10)' },
  ink: { name: 'Ink', bg: '#0a0a0a', ink: '#f2f2f2', soft: '#9a9a9a', dot: 'rgba(255,255,255,.13)' },
  linen: { name: 'Linen', bg: '#f1e8d9', ink: '#33291f', soft: '#7d6d5b', dot: 'rgba(60,40,10,.13)' },
}

let current = null // { text, title, author, style }
let inited = false

const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--signal').trim() || '#ff5f00'

function drawMark(ctx, x, bottom, pitch, s, signal) {
  // Returns the width drawn. x is the left edge, bottom the baseline row.
  let col = 0
  const r = pitch * 0.4
  const top = bottom - 10 * pitch // row 9 is the baseline of the x-height
  for (const ch of 'quire.') {
    const g = G[ch]
    for (let row = 0; row < g.length; row++) for (let c = 0; c < g[row].length; c++) {
      if (g[row][c] !== '#') continue
      ctx.fillStyle = ch === '.' ? signal : s.ink
      ctx.beginPath(); ctx.arc(x + (col + c) * pitch + pitch / 2, top + row * pitch + pitch / 2, r, 0, Math.PI * 2); ctx.fill()
    }
    col += g[0].length + 1
  }
  return (col - 1) * pitch
}
const markWidth = pitch => ('quire.'.split('').reduce((n, ch) => n + G[ch][0].length + 1, 0) - 1) * pitch

function wrap(ctx, text, maxWidth) {
  const lines = []
  for (const para of text.split(/\n+/)) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = word } else line = next
    }
    if (line) lines.push(line)
  }
  return lines
}

async function draw(canvas, { text, title, author, style }) {
  const s = STYLES[style] ?? STYLES.paper
  const signal = accent()
  const serif = "'Quire Literata', Georgia, serif"
  const sans = "'Quire UI', system-ui, sans-serif"
  try { await Promise.all([document.fonts.load(`500 60px ${serif}`), document.fonts.load(`600 34px ${sans}`)]) } catch { /* fall back to system fonts */ }

  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = s.bg; ctx.fillRect(0, 0, W, H)

  // A field of dots fading out from the top right corner.
  for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) {
    const px = W - 30 - x * 30, py = 30 + y * 30
    const fade = Math.max(0, 1 - Math.hypot(x, y) / 22)
    if (fade <= 0) continue
    ctx.globalAlpha = fade
    ctx.fillStyle = (x + y) % 7 === 0 && x + y < 12 ? signal : s.dot
    ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill()
  }
  ctx.globalAlpha = 1

  // The quote, as large as fits.
  const quote = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS).replace(/\s+\S*$/, '') + '…' : text
  const boxTop = 250, boxBottom = H - 330, width = W - PAD * 2
  let size = 76, lines = []
  for (; size >= 30; size -= 2) {
    ctx.font = `500 ${size}px ${serif}`
    lines = wrap(ctx, quote, width)
    if (lines.length * size * 1.36 <= boxBottom - boxTop) break
  }
  const lh = size * 1.36
  // An opening mark in the accent colour.
  ctx.fillStyle = signal
  ctx.font = `600 150px ${serif}`
  ctx.textBaseline = 'alphabetic'
  ctx.fillText('“', PAD - 8, boxTop - 6)
  ctx.fillStyle = s.ink
  ctx.font = `500 ${size}px ${serif}`
  let y = boxTop + size
  for (const line of lines) { ctx.fillText(line, PAD, y); y += lh }

  // Who said it.
  const footY = H - 150
  ctx.fillStyle = signal
  ctx.fillRect(PAD, footY - 78, 64, 5)
  ctx.fillStyle = s.ink
  ctx.font = `600 34px ${sans}`
  const mw = markWidth(7)
  const maxText = W - PAD * 2 - mw - 60
  const fit = str => { let t = str; while (t.length > 4 && ctx.measureText(t).width > maxText) t = t.slice(0, -2).trimEnd() + '…'; return t }
  ctx.fillText(fit(title || 'Untitled'), PAD, footY - 22)
  if (author) { ctx.fillStyle = s.soft; ctx.font = `400 30px ${sans}`; ctx.fillText(fit(author), PAD, footY + 24) }

  drawMark(ctx, W - PAD - mw, footY + 24, 7, s, signal)
}

async function render() {
  if (!current) return
  await draw($('#quote-canvas'), current)
  for (const b of $('#quote-styles').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.style === current.style))
}

function init() {
  if (inited) return
  inited = true
  $('#quote-styles').replaceChildren(...Object.entries(STYLES).map(([key, s]) => el('button', {
    type: 'button', class: 'quote-style', 'data-style': key, 'aria-pressed': 'false',
    style: `--q-bg:${s.bg};--q-ink:${s.ink}`, onclick: () => { current.style = key; render() },
  }, el('span', { class: 'quote-dot', 'aria-hidden': 'true' }), el('span', { text: s.name }))))
  $('#quote-save').addEventListener('click', async () => {
    if (!current) return
    const blob = await new Promise(r => $('#quote-canvas').toBlob(r, 'image/png'))
    if (!blob) return toast('The card could not be made')
    const file = new File([blob], `${safeName(current.title)} - quote.png`, { type: 'image/png' })
    if (await saveFile(file)) toast('Quote card saved')
  })
}

export function openQuoteCard({ text, title, author }) {
  const clean = String(text ?? '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
  if (!clean) return toast('Select some text first')
  init()
  current = { text: clean, title: String(title ?? ''), author: String(author ?? ''), style: document.documentElement.dataset.ui === 'dark' ? 'ink' : 'paper' }
  showSheet('sheet-quote', { onClose: () => { current = null } })
  render()
}
