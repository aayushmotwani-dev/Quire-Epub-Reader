// Reading preferences, shared by every book (like Apple Books).
// localStorage can throw (private mode, blocked storage), so every access is guarded.

const KEY = 'quire.settings.v1'

export const THEMES = {
  paper: { name: 'Paper', bg: '#ffffff', fg: '#1c1c1c', muted: '#6e6e6e', line: '#e8e8e8', link: '#1c1c1c', sel: 'rgba(255,95,0,.22)', dark: false },
  linen: { name: 'Linen', bg: '#f4ecdf', fg: '#3a2f25', muted: '#766756', line: '#e3d7c4', link: '#3a2f25', sel: 'rgba(90,60,20,.18)', dark: false },
  slate: { name: 'Slate', bg: '#2b2c2f', fg: '#d2d2d4', muted: '#9c9da2', line: '#3b3c40', link: '#e6e6e8', sel: 'rgba(255,106,26,.3)', dark: true },
  ember: { name: 'Ember', bg: '#17110c', fg: '#e8d5b9', muted: '#96826a', line: '#2b2218', link: '#ff9a52', sel: 'rgba(255,106,26,.32)', dark: true },
  night: { name: 'Night', bg: '#000000', fg: '#bdbdbd', muted: '#7d7d7d', line: '#1f1f1f', link: '#dcdcdc', sel: 'rgba(255,106,26,.34)', dark: true },
}

// ---------------------------------------------------------------- your own theme
// A sixth theme made from two colours the person picks: page and text.
// Everything else (quiet text, rules, selection) is worked out from those two.
const HEX = /^#[0-9a-f]{6}$/i
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const lum = hex => { const [r, g, b] = rgb(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
export const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
const mix = (a, b, t) => '#' + rgb(a).map((v, i) => Math.round(v + (rgb(b)[i] - v) * t).toString(16).padStart(2, '0')).join('')

function buildCustom({ bg, fg } = {}) {
  if (!HEX.test(bg || '') || !HEX.test(fg || '') || contrast(bg, fg) < 3) { bg = '#f6f1e7'; fg = '#2a2a2e' }
  const dark = lum(bg) < 0.2
  return { name: 'Custom', bg: bg.toLowerCase(), fg: fg.toLowerCase(), muted: mix(fg, bg, 0.48), line: mix(fg, bg, 0.86), link: fg.toLowerCase(), sel: dark ? 'rgba(255,106,26,.32)' : 'rgba(255,95,0,.22)', dark }
}
const storedCustom = () => { try { return JSON.parse(localStorage.getItem('quire.flag.customTheme')) ?? {} } catch { return {} } }
THEMES.custom = buildCustom(storedCustom())

// Returns false (and changes nothing) when the two colours are too close to read.
export function setCustomTheme(bg, fg) {
  if (!HEX.test(bg) || !HEX.test(fg) || contrast(bg, fg) < 3) return false
  THEMES.custom = buildCustom({ bg, fg })
  try { localStorage.setItem('quire.flag.customTheme', JSON.stringify({ bg: THEMES.custom.bg, fg: THEMES.custom.fg })) } catch { /* kept for this session */ }
  setSettings({ theme: 'custom' })
  return true
}

export const FONTS = {
  publisher: { name: 'Original', family: null },
  literata: { name: 'Literata', family: "'Quire Literata', Georgia, serif", file: 'literata', opsz: true },
  source: { name: 'Source Serif', family: "'Quire Source Serif', Georgia, serif", file: 'source-serif-4', opsz: true },
  garamond: { name: 'EB Garamond', family: "'Quire Garamond', Georgia, serif", file: 'eb-garamond' },
  lora: { name: 'Lora', family: "'Quire Lora', Georgia, serif", file: 'lora' },
  crimson: { name: 'Crimson Pro', family: "'Quire Crimson', Georgia, serif", file: 'crimson-pro' },
  bitter: { name: 'Bitter', family: "'Quire Bitter', Georgia, serif", file: 'bitter' },
  geist: { name: 'Geist', family: "'Quire Geist', system-ui, sans-serif", file: 'geist', noItalic: true },
  atkinson: { name: 'Atkinson', family: "'Quire Atkinson', system-ui, sans-serif", file: 'atkinson-hyperlegible-next' },
  inter: { name: 'Inter', family: "'Quire Inter', system-ui, sans-serif", file: 'inter' },
  dyslexic: { name: 'OpenDyslexic', family: "'Quire Dyslexic', system-ui, sans-serif", file: 'opendyslexic', weights: [400, 700], noExt: true },
  typewriter: { name: 'Typewriter', family: "'Quire Typewriter', 'Courier New', monospace", file: 'courier-prime', weights: [400, 700] },
}

// Side margin as a percentage of the page width, per step of the slider.
export const MARGINS = [3, 5, 7, 9, 12]

export const TURNS = { slide: 'Slide', page: 'Curl', none: 'None' }
export const APPEARANCES = { system: 'System', light: 'Light', dark: 'Dark', evening: 'Evening' }

// Advanced settings: how the app itself looks and behaves.
export const STYLES = { quire: 'Quire', paperback: 'Paperback', studio: 'Studio', blueprint: 'Blueprint', typewriter: 'Typewriter', matrix: 'Dot matrix' }
// What each style brings with it. The person can change any of these afterwards.
const STYLE_PRESETS = {
  quire: { pattern: 'dots', corners: 'round', accent: 'orange' },
  paperback: { pattern: 'none', corners: 'round', accent: 'red' },
  studio: { pattern: 'none', corners: 'round', accent: 'orange' },
  blueprint: { pattern: 'grid', corners: 'square', accent: 'blue' },
  typewriter: { pattern: 'lines', corners: 'square', accent: 'orange' },
  matrix: { pattern: 'dots', corners: 'round', accent: 'orange' },
}
export const UI_FONTS = { geist: 'Geist', atkinson: 'Atkinson', typewriter: 'Typewriter', system: 'System' }
export const ACCENTS = { orange: 'Orange', red: 'Red', blue: 'Blue', green: 'Green', graphite: 'Graphite' }
export const PATTERNS = { dots: 'Dots', grid: 'Grid', lines: 'Lines', diagonal: 'Diagonal', none: 'None' }
export const OPEN_ON = { last: 'Where I stopped', library: 'The library' }
export const CORNERS = { round: 'Round', square: 'Square' }
export const UI_SIZES = { small: 'Small', default: 'Default', large: 'Large' }
export const FOOTERS = { full: 'Pages left and percent', pages: 'Pages left in chapter', percent: 'Percent read', time: 'Time left in book', none: 'Nothing' }
export const TAPS = { back: 'Goes back', forward: 'Goes forward' }
export const SPEEDS = { slow: 'Slow', normal: 'Normal', fast: 'Fast' }
export const SPEED_FACTOR = { slow: 1.45, normal: 1, fast: 0.6 }

export const DEFAULTS = {
  appearance: 'system', // the whole app: system, light or dark
  name: 'Aayush',       // shown on the welcome screen
  turn: 'page',         // how a page change looks: page, slide or none
  turnChosen: false,    // true once the reader picked a turn style themselves
  theme: 'auto',       // auto = Paper in light mode, Night in dark mode
  font: 'literata',
  size: 19,            // px
  lineHeight: 1.55,
  margin: 2,           // index into MARGINS
  justify: true,
  hyphenate: true,
  focus: false,        // focus mode: nothing on the page but the text
  dropCaps: false,     // a large first letter where a chapter starts
  haptics: true,       // a light tap in the hand when a page turns (phones)
  flow: 'paginated',   // or 'scrolled'
  pages: 'two',        // 'two' = a spread on wide windows, 'one' = one page filling the window
  // advanced
  style: 'quire',      // quire, typewriter or matrix
  uiFont: 'geist',     // the interface typeface
  accent: 'orange',
  corners: 'round',
  openOn: 'last',      // when Quire starts: back into the book, or the library
  pattern: 'dots',     // the texture behind the home screen
  uiSize: 'default',   // interface text size (the book has its own)
  footer: 'full',      // what the bottom of the page shows
  leftTap: 'back',     // what a tap on the left edge does
  speed: 'normal',     // how fast pages turn
}

const ADVANCED = { style: STYLES, uiFont: UI_FONTS, accent: ACCENTS, pattern: PATTERNS, openOn: OPEN_ON, corners: CORNERS, uiSize: UI_SIZES, footer: FOOTERS, leftTap: TAPS, speed: SPEEDS }

export const PAGES = { two: 'Two pages', one: 'One page' }

export const LIMITS = { size: [13, 34], lineHeight: [1.2, 2.1] }

const listeners = new Set()
let state = load()

function load() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    return sanitize(JSON.parse(raw))
  } catch {
    return { ...DEFAULTS }
  }
}

// Never trust stored values: a bad value would break the reading CSS.
function sanitize(obj) {
  const s = { ...DEFAULTS }
  if (obj && typeof obj === 'object') {
    if (has(APPEARANCES, obj.appearance)) s.appearance = obj.appearance
    if (typeof obj.name === 'string') s.name = obj.name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24)
    if (has(TURNS, obj.turn)) s.turn = obj.turn
    else if (obj.animate === false) s.turn = 'none' // setting from an earlier version
    if (typeof obj.turnChosen === 'boolean') s.turnChosen = obj.turnChosen
    if (obj.theme === 'auto' || has(THEMES, obj.theme)) s.theme = obj.theme
    if (has(FONTS, obj.font)) s.font = obj.font
    if (Number.isFinite(obj.size)) s.size = clamp(Math.round(obj.size), ...LIMITS.size)
    if (Number.isFinite(obj.lineHeight)) s.lineHeight = clamp(Math.round(obj.lineHeight * 100) / 100, ...LIMITS.lineHeight)
    if (Number.isInteger(obj.margin)) s.margin = clamp(obj.margin, 0, MARGINS.length - 1)
    for (const k of ['justify', 'hyphenate', 'focus', 'dropCaps', 'haptics'])
      if (typeof obj[k] === 'boolean') s[k] = obj[k]
    if (has(PAGES, obj.pages)) s.pages = obj.pages
    else if (obj.spread === false) s.pages = 'one' // setting from an earlier version
    if (obj.flow === 'paginated' || obj.flow === 'scrolled') s.flow = obj.flow
    for (const [k, options] of Object.entries(ADVANCED))
      if (has(options, obj[k])) s[k] = obj[k]
  }
  return s
}

// Own keys only, so a stored value like "toString" is not accepted.
// (Function declarations, so they exist before the saved settings are read.)
function has(obj, key) { return typeof key === 'string' && Object.hasOwn(obj, key) }
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)) }

// Windows, macOS and phones can switch animations off for the whole system, and the
// browser engine reports that. It sets the starting point only: once the reader
// picks a turn style in the app, that choice wins.
export const systemWantsStill = () => matchMedia('(prefers-reduced-motion: reduce)').matches
export function effectiveTurn(s) { return systemWantsStill() && !s.turnChosen ? 'none' : s.turn }

export function getSettings() {
  return { ...state }
}

export function setSettings(patch) {
  state = sanitize({ ...state, ...patch })
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* storage blocked: keep in memory */ }
  for (const fn of listeners) fn(getSettings())
}

// Choosing a style also sets the type that belongs to it. Leaving Typewriter
// puts back the usual faces, so nothing stays in Courier by surprise.
export function setStyle(style) {
  const s = state
  if (style === 'typewriter') return setSettings({ style, ...STYLE_PRESETS.typewriter, uiFont: 'typewriter', font: 'typewriter', justify: false, hyphenate: false })
  const patch = { style, ...STYLE_PRESETS[style] }
  if (s.uiFont === 'typewriter') patch.uiFont = DEFAULTS.uiFont
  if (s.font === 'typewriter') { patch.font = DEFAULTS.font; patch.justify = DEFAULTS.justify; patch.hyphenate = DEFAULTS.hyphenate }
  setSettings(patch)
}

// Everything back to how Quire starts, except the reader's name.
export function resetSettings() {
  state = { ...DEFAULTS, name: state.name }
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* ignore */ }
  for (const fn of listeners) fn(getSettings())
}

export function onSettings(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const darkQuery = matchMedia('(prefers-color-scheme: dark)')

// True when the app itself should be dark (its own setting, else the device).
// "Evening" is light by day and dark from seven in the evening to seven in the morning.
const isEvening = (d = new Date()) => d.getHours() >= 19 || d.getHours() < 7

export function isDarkScheme(s = state) {
  return s.appearance === 'dark' || (s.appearance === 'system' && darkQuery.matches) || (s.appearance === 'evening' && isEvening())
}

export function resolveThemeKey(s = state) {
  if (s.theme !== 'auto') return s.theme
  return isDarkScheme(s) ? 'night' : 'paper'
}

export function onSystemThemeChange(fn) {
  darkQuery.addEventListener('change', fn)
  // The clock can change the answer too (Evening), so look once a minute.
  let last = isDarkScheme()
  setInterval(() => { const now = isDarkScheme(); if (now !== last) { last = now; fn() } }, 60_000)
}

// Library and dialogs follow the app setting. The reader overrides this with
// its page theme while a book is open (see reader.js).
export function applyAppMode() {
  applyLook()
  const root = document.documentElement
  const dark = isDarkScheme()
  root.dataset.ui = dark ? 'dark' : 'light'
  delete root.dataset.pageTheme
  delete root.dataset.fixed
  const canvas = dark ? '#000000' : '#ffffff'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', canvas)
  window.quireNative?.setChromeColor?.(canvas)
  document.body && (document.body.style.background = '')
}

// The advanced look lives on <html> as data attributes; app.css does the rest.
// It applies in the library and while reading alike.
export function applyLook(s = state) {
  const d = document.documentElement.dataset
  d.style = s.style
  d.uiFont = s.uiFont
  d.accent = s.accent
  d.corners = s.corners
  d.pattern = s.pattern
  d.uiSize = s.uiSize
}

// Small UI flags (sort order, hints already shown).
export function getFlag(name, fallback = null) {
  try {
    const v = localStorage.getItem('quire.flag.' + name)
    return v === null ? fallback : JSON.parse(v)
  } catch { return fallback }
}

export function setFlag(name, value) {
  try { localStorage.setItem('quire.flag.' + name, JSON.stringify(value)) } catch { /* ignore */ }
}
