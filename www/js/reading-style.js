import { THEMES, FONTS } from './settings.js'

const fontURL = file => new URL(`../fonts/${file}`, import.meta.url).href

// Bundled faces are declared inside each book page, because the page lives
// in its own iframe document and cannot see the app's @font-face rules.
function fontFaces(key) {
  const f = FONTS[key]
  if (!f?.file) return ''
  const family = f.family.split(',')[0]
  if (f.weights) return staticFaces(f, family)
  const axis = f.opsz ? 'opsz' : 'wght'
  const faces = []
  for (const style of f.noItalic ? ['normal'] : ['normal', 'italic']) {
    for (const [subset, range] of [
      ['latin', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'],
      ['latin-ext', 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'],
    ]) {
      faces.push(`@font-face{font-family:${family};font-style:${style};font-weight:200 900;font-display:block;src:url("${fontURL(`${f.file}-${subset}-${axis}-${style}.woff2`)}") format("woff2");unicode-range:${range}}`)
    }
  }
  return faces.join('\n')
}

// Static fonts (Courier Prime): one file per weight and style. Accented
// letters outside Latin-1 come in the regular weight only.
function staticFaces(f, family) {
  const faces = []
  for (const w of f.weights) for (const style of ['normal', 'italic'])
    faces.push(`@font-face{font-family:${family};font-style:${style};font-weight:${w};font-display:block;src:url("${fontURL(`${f.file}-latin-${w}-${style}.woff2`)}") format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`)
  faces.push(`@font-face{font-family:${family};font-style:normal;font-weight:100 900;font-display:block;src:url("${fontURL(`${f.file}-latin-ext-400-normal.woff2`)}") format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F,U+1EF2-1EFF,U+20A0-20AB,U+20AD-20C0,U+2C60-2C7F,U+A720-A7FF}`)
  return faces.join('\n')
}

// Returns [before, after]. "before" is placed ahead of the book's own CSS
// (gentle defaults the publisher may override); "after" comes last and holds
// the choices the reader made explicitly.
export function readingCSS(s, themeKey) {
  const t = THEMES[themeKey]
  const font = FONTS[s.font]
  const before = `
    @namespace epub "http://www.idpf.org/2007/ops";
    html { color-scheme: ${t.dark ? 'dark' : 'light'}; }
    html.q-idle, html.q-idle * { cursor: none !important; } /* focus mode, pointer resting */
    p, li, blockquote, dd { widows: 2; orphans: 2; }
    pre { white-space: pre-wrap !important; }
  `
  const after = `
    ${fontFaces(s.font)}
    html {
      font-size: ${s.size}px !important;
      -webkit-text-size-adjust: none; text-size-adjust: none;
      background: ${t.bg} !important;
      color: ${t.fg} !important;
    }
    body { background: transparent !important; color: ${t.fg} !important; }
    body :where(:not(a, a *, mark, svg, svg *, img, video, math, math *)) { color: inherit !important; }
    ${t.dark ? 'body :where(:not(img, svg, svg *, video, canvas)) { background-color: transparent !important; border-color: ' + t.line + ' !important; }' : ''}
    a:any-link { color: ${t.link} !important; text-decoration-color: ${t.muted} !important; text-underline-offset: .15em; }
    ${font?.family ? `
    body { font-family: ${font.family} !important; }
    body :where(:not(code, pre, kbd, samp, tt, var, math, math *, svg, svg *)) { font-family: inherit !important; }
    ` : ''}
    body { font-optical-sizing: auto; font-size: 1em !important; }
    /* Some books fix their text size in px or pt, which would ignore the size
       chosen in Aa. Body text follows the reader's size; headings keep theirs. */
    body :where(p, li, blockquote, dd, dt, td, th, figcaption, div:not(:has(p, li, blockquote, h1, h2, h3, h4, h5, h6, table))) { font-size: 1em !important; }
    p, li, blockquote, dd, dt, td {
      line-height: ${s.lineHeight} !important;
      text-align: ${s.justify ? 'justify' : 'start'};
      -webkit-hyphens: ${s.hyphenate ? 'auto' : 'manual'};
      hyphens: ${s.hyphenate ? 'auto' : 'manual'};
      -webkit-hyphenate-limit-before: 3; -webkit-hyphenate-limit-after: 3;
      hyphenate-limit-chars: 7 3 3;
      hanging-punctuation: allow-end last;
    }
    [align="left"] { text-align: left !important; }
    [align="right"] { text-align: right !important; }
    [align="center"] { text-align: center !important; }
    ::selection { background: ${t.sel}; }
    ${themeKey === 'night' ? 'img, svg image, video { filter: brightness(.86); }' : ''}
  `
  return [before, after]
}

// Fixed-layout pages are images of the publisher's design: only the
// surround changes with the theme.
export function themeVars(themeKey) {
  const t = THEMES[themeKey]
  return { '--page-bg': t.bg, '--page-fg': t.fg, '--page-muted': t.muted, '--page-line': t.line, '--page-sel': t.sel }
}
