// A real page flip, on the desktop app and the phone apps.
//
// The web engine cannot draw a page twice, so the app takes a picture of the
// pages on screen: the desktop shell with quireNative.capturePage, the phone
// apps with a small native plugin (Capacitor.Plugins.PageSnapshot). The
// picture covers the reader, the real view moves to the next page underneath
// it without its own animation, and then the picture turns over like a paper
// leaf, showing the real next page below. Its back is plain paper with the
// faint show-through of the printed side. Without a picture (a web browser, or
// an Android phone older than Android 8) the reader slides the page instead.

const TURN_MS = 720 // the leaf turning over
const CURL_MS = 760 // the page curl (it travels further, so a little longer)
const SETTLE_MS = 150 // the landed leaf fading into the real page
const SAFETY_MS = 4000 // never leave the cover on screen longer than this

import { createCurl, parseColor, warmUpCurl } from './pagecurl.js'
export { warmUpCurl }

let busy = false

let failures = 0 // pictures that failed in a row; after a few, stop trying

const snapshotPlugin = () => window.Capacitor?.Plugins?.PageSnapshot
export const canFlip = () => failures < 3 && (
  typeof window.quireNative?.capturePage === 'function' ||
  typeof snapshotPlugin()?.capture === 'function')
export const isFlipping = () => busy

const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()))
const wait = ms => new Promise(r => setTimeout(r, ms))
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

// A picture of `rect` (CSS pixels), as an image address, or null.
async function capture(rect) {
  const area = { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  try {
    if (typeof window.quireNative?.capturePage === 'function') {
      const bytes = await window.quireNative.capturePage(area)
      if (bytes instanceof Uint8Array && bytes.length > 100) {
        failures = 0
        return { url: URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })), blob: true }
      }
    } else if (snapshotPlugin()) {
      const res = await Promise.race([
        snapshotPlugin().capture({ ...area, ratio: window.devicePixelRatio || 1 }),
        wait(1500).then(() => null),
      ])
      const data = res?.data
      if (typeof data === 'string' && data.length > 100 && /^[A-Za-z0-9+/=]+$/.test(data.slice(0, 64))) {
        failures = 0
        return { url: `data:image/jpeg;base64,${data}`, blob: false }
      }
    }
  } catch { /* counted below */ }
  failures++
  return null
}

function div(cls, style = {}) {
  const d = document.createElement('div')
  d.className = cls
  Object.assign(d.style, style)
  return d
}

// A window onto the captured picture, showing the part from `offsetX` on.
function slice(url, w, h, offsetX, width, cls = 'flip-slice') {
  const box = div(cls, { width: `${width}px`, height: `${h}px` })
  const img = document.createElement('img')
  img.alt = ''
  img.decoding = 'sync'
  img.draggable = false
  img.src = url
  Object.assign(img.style, { position: 'absolute', top: '0', left: `${-offsetX}px`, width: `${w}px`, height: `${h}px` })
  box.append(img)
  return { box, img }
}

/**
 * Turn the page with a flip. Resolves true when the flip ran (the view has
 * moved), false when it could not start (the caller then turns normally).
 *
 * rect      where the pages are on screen (viewport pixels)
 * columns   1 or 2 pages side by side
 * forward   true for the next page
 * paper     page colour, for the back of the leaf
 * dark      dark page theme (deeper shadows)
 * host      element to draw in
 * perform   moves the real view without its own animation; returns a promise
 * quick     more turns are waiting: turn faster
 */
export async function flipPage({ rect, columns, forward, paper, dark, host, perform, quick = false }) {
  if (busy) return false
  const W = Math.round(rect.width), H = Math.round(rect.height)
  if (!(W > 80 && H > 80)) return false
  busy = true
  let shot = null, cover = null
  const safety = setTimeout(() => { cover?.remove(); busy = false }, SAFETY_MS)
  try {
    shot = await capture(rect)
    if (!shot) return false
    const url = shot.url

    const two = columns >= 2
    const half = two ? Math.round(W / 2) : W
    const leafLeft = two ? (forward ? half : 0) : 0
    const leafWidth = two ? (forward ? W - half : half) : W

    // The page curl (WebGL). Without it, the simpler 3D leaf below.
    const picture = new Image()
    picture.src = url
    await picture.decode().catch(() => {})
    const curl = createCurl({
      img: picture, W, H, leaf: [leafLeft, leafLeft + leafWidth],
      still: two, forward, paper: parseColor(paper), dark,
    })
    if (curl) {
      cover = div('flip-cover', {
        left: `${Math.round(rect.left)}px`, top: `${Math.round(rect.top)}px`,
        width: `${W}px`, height: `${H}px`,
      })
      cover.append(curl.canvas)
      try {
        if (!curl.draw(0)) return false
        host.append(cover)
        await nextFrame(); await nextFrame()
        const moved = Promise.resolve().then(perform).catch(() => {})
        await Promise.race([moved, wait(50)])
        await nextFrame()
        const t0 = performance.now()
        await new Promise(resolve => {
          const step = now => {
            if (!cover.isConnected) return resolve()
            const t = Math.min(1, (now - t0) / (quick ? CURL_MS * 0.55 : CURL_MS))
            if (!curl.draw(ease(t))) return resolve()
            if (t < 1) requestAnimationFrame(step)
            else resolve()
          }
          requestAnimationFrame(step)
        })
        await Promise.race([moved, wait(1500)])
        if (cover.isConnected) {
          curl.canvas.style.transition = `opacity ${SETTLE_MS}ms ease-out`
          curl.canvas.style.opacity = '0'
          await wait(SETTLE_MS + 20)
        }
        return true
      } finally {
        curl.destroy()
      }
    }

    cover = div('flip-cover', {
      left: `${Math.round(rect.left)}px`, top: `${Math.round(rect.top)}px`,
      width: `${W}px`, height: `${H}px`,
      perspective: `${Math.max(1800, W * 1.9)}px`,
    })
    cover.classList.toggle('dark', !!dark)
    cover.classList.toggle('rev', !forward)

    // The page that stays put while the leaf turns (two pages only).
    let still = null
    if (two) {
      still = slice(url, W, H, forward ? 0 : half, W - half, 'flip-slice flip-still')
      still.box.style.left = forward ? '0px' : `${half}px`
    }
    // The soft shadow the leaf throws on the page below it.
    const shade = div('flip-shade', { height: `${H}px` })
    // The leaf: the printed side, and the back of the paper.
    const leaf = div('flip-leaf', {
      left: `${leafLeft}px`, width: `${leafWidth}px`, height: `${H}px`,
      transformOrigin: forward ? '0% 50%' : '100% 50%',
    })
    const front = slice(url, W, H, leafLeft, leafWidth, 'flip-slice flip-face flip-front')
    const frontTint = div('flip-tint')
    front.box.append(frontTint)
    const back = div('flip-face flip-back', { width: `${leafWidth}px`, height: `${H}px`, background: paper })
    const ghost = slice(url, W, H, leafLeft, leafWidth, 'flip-slice flip-ghost')
    const backTint = div('flip-tint')
    back.append(ghost.box, backTint)
    back.style.visibility = 'hidden'
    leaf.append(front.box, back)
    cover.append(...(still ? [still.box] : []), shade, leaf)

    // The picture must be on screen before the real page moves, or the next
    // page would show for a moment first.
    const imgs = [front.img, ghost.img, ...(still ? [still.img] : [])]
    await Promise.all(imgs.map(i => i.decode().catch(() => {})))
    host.append(cover)
    await nextFrame(); await nextFrame()

    const moved = Promise.resolve().then(perform).catch(() => {})
    await Promise.race([moved, wait(50)])
    await nextFrame()

    // Two pages turn the whole way over the spine; a single page lifts away
    // from its edge until it is gone.
    const maxAngle = two ? 180 : 108
    const sign = forward ? -1 : 1
    const shadeWidth = Math.round((two ? 0.26 : 0.3) * W)
    const shadeMax = dark ? 0.55 : 0.3
    const ghostMax = dark ? 0.1 : 0.07
    const t0 = performance.now()
    await new Promise(resolve => {
      const step = now => {
        if (!cover.isConnected) return resolve()
        const t = Math.min(1, (now - t0) / (quick ? TURN_MS * 0.55 : TURN_MS))
        const e = ease(t)
        const deg = e * maxAngle
        const rad = deg * Math.PI / 180
        leaf.style.transform = `rotateY(${sign * deg}deg)`
        // Show one side at a time (Chromium does not hide the back of a 3D
        // element reliably when it has pictures inside).
        const backSide = deg > 90
        front.box.style.visibility = backSide ? 'hidden' : 'visible'
        back.style.visibility = backSide ? 'visible' : 'hidden'
        // Light falls off as the leaf stands up, and returns as it lands.
        const lift = Math.sin(rad)
        frontTint.style.opacity = String(Math.min(1, lift * 0.85 + (deg > 90 ? 1 : 0)))
        backTint.style.opacity = String(lift * 0.6)
        // Where the free edge of the leaf is, ignoring perspective.
        const reach = leafWidth * Math.cos(rad)
        const edge = forward ? leafLeft + reach : leafLeft + leafWidth - reach
        shade.style.width = `${shadeWidth}px`
        shade.style.transform = `translateX(${Math.round(edge - shadeWidth / 2)}px)`
        shade.style.opacity = String(shadeMax * lift * (two ? 1 : Math.max(0, 1 - e * 1.1)))
        // The show-through fades before the leaf lands, so the real page
        // appears out of clean paper instead of over mirrored text.
        ghost.box.style.opacity = String(ghostMax * Math.max(0, Math.min(1, (maxAngle - 18 - deg) / 30)))
        if (!two) leaf.style.opacity = String(e < 0.55 ? 1 : Math.max(0, 1 - (e - 0.55) / 0.45))
        if (t < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })

    // Let a slow move (a new chapter) finish before uncovering.
    await Promise.race([moved, wait(1500)])
    if (cover.isConnected) {
      if (still) still.box.style.visibility = 'hidden' // under the landed leaf now
      shade.style.opacity = '0'
      leaf.style.transition = `opacity ${SETTLE_MS}ms ease-out`
      leaf.style.opacity = '0'
      await wait(SETTLE_MS + 20)
    }
    return true
  } finally {
    clearTimeout(safety)
    cover?.remove()
    if (shot?.blob) URL.revokeObjectURL(shot.url)
    busy = false
  }
}
