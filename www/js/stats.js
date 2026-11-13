// Reading time, kept on this device only: seconds read per calendar day.
// Time counts while a book is open, the app is in view, and something happened
// in the last five minutes (a page turn, a tap, a key).

import { getFlag, setFlag } from './settings.js'

const STEP = 15            // seconds between counts
const IDLE = 5 * 60_000    // no activity for this long: stop counting
const KEEP_DAYS = 400

let timer = 0
let lastActive = 0

export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function readDays() {
  const raw = getFlag('readingDays', {})
  const out = {}
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw))
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(v) && v > 0) out[k] = Math.min(86_400, Math.round(v))
  }
  return out
}

function add(seconds) {
  const days = readDays()
  const key = dayKey()
  days[key] = Math.min(86_400, (days[key] || 0) + seconds)
  const keys = Object.keys(days).sort()
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[k]
  setFlag('readingDays', days)
}

export function active() { lastActive = Date.now() }

export function begin() {
  end()
  active()
  timer = setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - lastActive < IDLE) add(STEP)
  }, STEP * 1000)
}

export function end() { clearInterval(timer); timer = 0 }

// ---------------------------------------------------------------- summaries
const MIN_DAY = 60 // a day counts toward the streak from one minute of reading

export function summary(now = new Date()) {
  const days = readDays()
  const at = offset => { const d = new Date(now); d.setDate(d.getDate() - offset); return days[dayKey(d)] || 0 }
  // The streak may still be alive if today has no reading yet.
  let streak = 0
  let i = at(0) >= MIN_DAY ? 0 : 1
  while (at(i) >= MIN_DAY) { streak++; i++ }
  let best = 0, run = 0, prev = null
  for (const k of Object.keys(days).sort()) {
    if (days[k] < MIN_DAY) continue
    const d = new Date(k + 'T00:00:00')
    run = prev && Math.round((d - prev) / 86_400_000) === 1 ? run + 1 : 1
    best = Math.max(best, run); prev = d
  }
  const last = n => Array.from({ length: n }, (_, j) => at(n - 1 - j))
  const week = last(7).reduce((a, b) => a + b, 0)
  const total = Object.values(days).reduce((a, b) => a + b, 0)
  return { today: at(0), week, total, streak, best: Math.max(best, streak), series: last(28), tracked: Object.keys(days).length }
}

export function formatDuration(seconds) {
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60), r = m % 60
  return r ? `${h} h ${r} min` : `${h} h`
}
