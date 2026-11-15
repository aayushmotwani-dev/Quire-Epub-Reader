// EPUBs can carry JavaScript. The engine renders pages in same-origin iframes
// that must allow scripts (WebKit bug), so a script in a book could read this
// app's storage. Three layers stop that:
//   1. the Content-Security-Policy only allows scripts from this site,
//   2. script files in the book are never loaded (see blockScripts),
//   3. inline scripts, event handlers and javascript: links are removed from
//      every page before it renders (this file).

const DROP = 'script, object, embed, applet, base, meta[http-equiv], portal, frame, frameset'
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'data', 'xlink:href', 'poster', 'srcdoc']

const isDangerousURL = v => /^\s*(javascript|vbscript|data:text\/html)/i.test(String(v).replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ''))

export function cleanDocument(doc) {
  for (const node of doc.querySelectorAll(DROP)) node.remove()
  for (const node of doc.querySelectorAll('*')) {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) node.removeAttributeNode(attr)
      else if (name === 'srcdoc') node.removeAttributeNode(attr)
      else if (URL_ATTRS.includes(name) && isDangerousURL(attr.value)) node.removeAttributeNode(attr)
    }
  }
  // SVG <animate>/<set> can rewrite href to javascript: at runtime.
  for (const node of doc.querySelectorAll('animate, set, animateTransform, animateMotion')) {
    const target = (node.getAttribute('attributeName') || '').toLowerCase()
    if (target.includes('href') || target.startsWith('on')) node.remove()
  }
  return doc
}

export function cleanMarkup(str, type) {
  const parseType = type === 'text/html' ? 'text/html' : type
  let doc = new DOMParser().parseFromString(str, parseType)
  let html = parseType === 'text/html'
  if (!html && doc.querySelector('parsererror')) {
    doc = new DOMParser().parseFromString(str, 'text/html')
    html = true
  }
  cleanDocument(doc)
  return html
    ? '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
    : new XMLSerializer().serializeToString(doc)
}

const MARKUP = new Set(['application/xhtml+xml', 'text/html', 'image/svg+xml'])

// Kindle and FictionBook files are not loaded through the EPUB loader, so
// their pages are cleaned here instead, as each one is about to be shown.
function guardSections(book) {
  for (const section of book.sections ?? []) {
    if (typeof section.load !== 'function') continue
    const load = section.load.bind(section)
    const unload = section.unload?.bind(section)
    let mine = null
    section.load = async () => {
      const url = await load()
      if (typeof url !== 'string' || !url.startsWith('blob:')) return url
      try {
        const blob = await (await fetch(url)).blob()
        const type = (blob.type || '').split(';')[0]
        if (!MARKUP.has(type)) return url
        if (mine) URL.revokeObjectURL(mine)
        mine = URL.createObjectURL(new Blob([cleanMarkup(await blob.text(), type)], { type: blob.type }))
        return mine
      } catch { return url } // the Content-Security-Policy still stands behind this
    }
    section.unload = () => { if (mine) { URL.revokeObjectURL(mine); mine = null } unload?.() }
  }
}

export function guardBook(book) {
  const target = book.transformTarget
  if (!target) return guardSections(book)
  target.addEventListener('load', e => {
    if (e.detail.isScript) e.detail.allow = false
  })
  target.addEventListener('data', e => {
    const { detail } = e
    const type = detail.type
    detail.data = Promise.resolve(detail.data).then(data => {
      if (typeof data === 'string' && MARKUP.has(type)) return cleanMarkup(data, type)
      if (typeof data === 'string' && /javascript|ecmascript/i.test(type)) return ''
      return data
    }).catch(() => '') // a missing resource should not stop the page
  })
}
