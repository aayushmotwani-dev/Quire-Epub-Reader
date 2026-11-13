// The book opening: the cover you tapped grows toward you while the page
// comes up behind it, and settles back onto the shelf when you close the book.

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const EASE = 'cubic-bezier(.2, .8, .2, 1)'

let layer = null

function clear() { layer?.remove(); layer = null }

function makeLayer(coverEl, rect) {
  clear()
  layer = document.createElement('div')
  layer.className = 'openfx'
  const veil = document.createElement('div')
  veil.className = 'openfx-veil'
  const clone = coverEl.cloneNode(true)
  clone.classList.add('openfx-cover')
  Object.assign(clone.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
  layer.append(veil, clone)
  document.body.append(layer)
  return { veil, clone }
}

function target(rect) {
  const vw = innerWidth, vh = innerHeight
  const scale = Math.min((vh * 0.78) / rect.height, (vw * 0.78) / rect.width)
  const dx = vw / 2 - (rect.left + rect.width / 2), dy = vh / 2 - (rect.top + rect.height / 2)
  return `translate(${dx}px, ${dy}px) scale(${scale})`
}

// Call when a cover is tapped. Returns finish(), to call once the book is on screen.
export function playOpen(coverEl) {
  const rect = coverEl?.getBoundingClientRect?.()
  if (!rect || !rect.width || still()) return () => {}
  const { veil, clone } = makeLayer(coverEl, rect)
  const mine = layer
  veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out', fill: 'forwards' })
  const grow = clone.animate([{ transform: 'none' }, { transform: target(rect) }], { duration: 460, easing: EASE, fill: 'forwards' })
  let finished = false
  const safety = setTimeout(() => finish(), 6000)
  async function finish() {
    if (finished) return
    finished = true
    clearTimeout(safety)
    try { await grow.finished } catch { /* cancelled */ }
    if (layer !== mine) return
    const out = mine.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-in', fill: 'forwards' })
    clone.animate([{ transform: target(rect) }, { transform: `${target(rect)} scale(1.12)` }], { duration: 300, easing: 'ease-in', fill: 'forwards' })
    try { await out.finished } catch { /* cancelled */ }
    if (layer === mine) clear()
  }
  return finish
}

// Call after the library is back on screen, with the cover the book returns to.
export function playClose(coverEl) {
  const rect = coverEl?.getBoundingClientRect?.()
  if (!rect || !rect.width || still()) return
  if (rect.bottom < 0 || rect.top > innerHeight) return // its place on the shelf is off screen
  const { veil, clone } = makeLayer(coverEl, rect)
  const mine = layer
  coverEl.style.visibility = 'hidden'
  veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 340, easing: 'ease-out', fill: 'forwards' })
  const back = clone.animate([{ transform: target(rect), opacity: .0 }, { transform: target(rect), opacity: 1, offset: .12 }, { transform: 'none', opacity: 1 }], { duration: 440, easing: EASE, fill: 'forwards' })
  const done = () => { coverEl.style.visibility = ''; if (layer === mine) clear() }
  back.finished.then(done, done)
}
