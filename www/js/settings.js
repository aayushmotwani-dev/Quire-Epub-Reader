// Reading preferences, shared by every book (like Apple Books).
// localStorage can throw (private mode, blocked storage), so every access is guarded.

const KEY = 'quire.settings.v1'

export const THEMES = {
  paper: { name: 'Paper', bg: '#ffffff', fg: '#1c1c1c', muted: '#7a7a7a', line: '#e8e8e8', link: '#1c1c1c', sel: 'rgba(255,95,0,.22)', dark: false },
  linen: { name: 'Linen', bg: '#f4ecdf', fg: '#3a2f25', muted: '#8c7c6a', line: '#e3d7c4', link: '#3a2f25', sel: 'rgba(90,60,20,.18)', dark: false },
  slate: { name: 'Slate', bg: '#2b2c2f', fg: '#d2d2d4', muted: '#8d8e93', line: '#3b3c40', link: '#e6e6e8', sel: 'rgba(255,106,26,.3)', dark: true },
  ember: { name: 'Ember', bg: '#17110c', fg: '#e8d5b9', muted: '#8f7b63', line: '#2b2218', link: '#ff9a52', sel: 'rgba(255,106,26,.32)', dark: true },
  night: { name: 'Night', bg: '#000000', fg: '#bdbdbd', muted: '#6f6f6f', line: '#1f1f1f', link: '#dcdcdc', sel: 'rgba(255,106,26,.34)', dark: true },
}

export const FONTS = {
  publisher: { name: 'Original', family: null },
  literata: { name: 'Literata', family: "'Quire Literata', Georgia, serif", file: 'literata', opsz: true },
  source: { name: 'Source Serif', family: "'Quire Source Serif', Georgia, serif", file: 'source-serif-4', opsz: true },
  geist: { name: 'Geist', family: "'Quire Geist', system-ui, sans-serif", file: 'geist', noItalic: true },
  atkinson: { name: 'Atkinson', family: "'Quire Atkinson', system-ui, sans-serif", file: 'atkinson-hyperlegible-next' },
  typewriter: { name: 'Typewriter', family: "'Quire Typewriter', 'Courier New', monospace", file: 'courier-prime', weights: [400, 700] },
}

// Side margin as a percentage of the page width, per step of the slider.
export const MARGINS = [3, 5, 7, 9, 12]

export const TURNS = { slide: 'Slide', page: 'Curl', none: 'None' }
export const APPEARANCES = { system: 'System', light: 'Light', dark: 'Dark' }

// Advanced settings: how the app itself looks and behaves.
export const STYLES = { quire: 'Quire', typewriter: 'Typewriter', matrix: 'Dot matrix' }
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
    for (const k of ['justify', 'hyphenate', 'focus'])
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
  if (style === 'typewriter') return setSettings({ style, uiFont: 'typewriter', font: 'typewriter', justify: false, hyphenate: false })
  const patch = { style }
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
export function isDarkScheme(s = state) {
  return s.appearance === 'dark' || (s.appearance === 'system' && darkQuery.matches)
}

export function resolveThemeKey(s = state) {
  if (s.theme !== 'auto') return s.theme
  return isDarkScheme(s) ? 'night' : 'paper'
}

export function onSystemThemeChange(fn) {
  darkQuery.addEventListener('change', fn)
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
