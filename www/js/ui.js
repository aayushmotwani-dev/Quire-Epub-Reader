// Small DOM helpers. Book metadata is untrusted, so text always goes in
// through textContent, never innerHTML. Only the static icon strings below
// are inserted as markup.

const P = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
const svg = (body, vb = 24) => `<svg viewBox="0 0 ${vb} ${vb}" width="24" height="24" aria-hidden="true" focusable="false" ${P}>${body}</svg>`

export const ICONS = {
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  search: svg('<circle cx="11" cy="11" r="6.2"/><path d="M20 20l-4.6-4.6"/>'),
  contents: svg('<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.6" cy="6.5" r=".6" fill="currentColor"/><circle cx="4.6" cy="12" r=".6" fill="currentColor"/><circle cx="4.6" cy="17.5" r=".6" fill="currentColor"/>'),
  bookmark: svg('<path d="M7 3.8h10v16.4l-5-3.9-5 3.9z"/>'),
  bookmarkOn: svg('<path d="M7 3.8h10v16.4l-5-3.9-5 3.9z" fill="currentColor"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  more: svg('<circle cx="5.5" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.1" fill="currentColor" stroke="none"/>'),
  trash: svg('<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2h9.2L17.5 7"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="1.8"/><path d="M15.5 8.5V5.8a1.3 1.3 0 0 0-1.3-1.3H5.8a1.3 1.3 0 0 0-1.3 1.3v8.4a1.3 1.3 0 0 0 1.3 1.3h2.7"/>'),
  note: svg('<path d="M5 19h4L19.2 8.8a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L5 15z"/><path d="M13.8 6.2l4 4"/>'),
  export: svg('<path d="M12 4v11M7.5 8.5L12 4l4.5 4.5M5 14.5v4.7h14v-4.7"/>'),
  expand: svg('<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/>'),
  shrink: svg('<path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  chevron: svg('<path d="M9 5l7 7-7 7"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  noteAdd: svg('<path d="M14 3.5H7.5a1.7 1.7 0 0 0-1.7 1.7v13.6a1.7 1.7 0 0 0 1.7 1.7h9a1.7 1.7 0 0 0 1.7-1.7V8z"/><path d="M14 3.5V8h4.2M12 11.5v5M9.5 14h5"/>'),
  define: svg('<path d="M12 6.2C10.3 5 8 4.6 4.5 4.8v12.4c3.5-.2 5.8.2 7.5 1.4 1.7-1.2 4-1.6 7.5-1.4V4.8c-3.5-.2-5.8.2-7.5 1.4zM12 6.2v12.4"/>'),
  speaker: svg('<path d="M5 9.5h3l4.5-3.5v12L8 14.5H5z"/><path d="M15.8 9.2a4 4 0 0 1 0 5.6M18.3 6.7a7.5 7.5 0 0 1 0 10.6"/>'),
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k === 'icon') node.insertAdjacentHTML('afterbegin', ICONS[v])
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else if (v === true) node.setAttribute(k, '')
    else node.setAttribute(k, v)
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue
    node.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return node
}

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

export function iconButton(icon, label, onclick, extra = {}) {
  return el('button', { type: 'button', class: 'icon-btn ' + (extra.class || ''), 'aria-label': label, title: label, icon, onclick, ...extra.attrs })
}

// ---------- toast ----------
let toastTimer
export function toast(message, { action, onAction, duration = 3600 } = {}) {
  const host = $('#toast')
  host.replaceChildren(el('span', { text: message }))
  if (action) host.append(el('button', { type: 'button', class: 'toast-action', text: action, onclick: () => { hideToast(); onAction?.() } }))
  host.classList.add('show')
  clearTimeout(toastTimer)
  if (duration) toastTimer = setTimeout(hideToast, duration)
}
export function hideToast() { $('#toast').classList.remove('show') }

// ---------- confirm dialog ----------
export function confirmDialog({ title, body, confirm = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    const dlg = $('#confirm')
    $('#confirm-title').textContent = title
    $('#confirm-body').textContent = body
    const ok = $('#confirm-ok')
    ok.textContent = confirm
    ok.classList.toggle('danger', danger)
    const finish = value => { dlg.close(); resolve(value) }
    ok.onclick = () => finish(true)
    $('#confirm-cancel').onclick = () => finish(false)
    dlg.oncancel = e => { e.preventDefault(); finish(false) }
    dlg.showModal()
    $('#confirm-cancel').focus()
  })
}

// ---------- text prompt (notes) ----------
export function noteDialog({ title, value = '', quote = '' }) {
  return new Promise(resolve => {
    const dlg = $('#note-dialog')
    $('#note-title').textContent = title
    $('#note-quote').textContent = quote
    $('#note-quote').hidden = !quote
    const ta = $('#note-text')
    ta.value = value
    const finish = v => { dlg.close(); resolve(v) }
    $('#note-save').onclick = () => finish(ta.value.trim())
    $('#note-cancel').onclick = () => finish(null)
    dlg.oncancel = e => { e.preventDefault(); finish(null) }
    dlg.showModal()
    ta.focus()
  })
}

// ---------- sheets and panels ----------
// One open at a time. Each open pushes a history entry so the Android back
// gesture (and the browser back button) closes the sheet instead of the book.
let openSheet = null
let restoreFocus = null

export function showSheet(id, { onClose } = {}) {
  if (openSheet?.id === id) return
  const switching = !!openSheet
  // Switching sheets reuses the history entry; going back() and pushing again
  // in the same tick would race and pop the new entry.
  if (switching) closeSheet({ fromHistory: true, silent: true })
  const node = document.getElementById(id)
  if (!switching) restoreFocus = document.activeElement
  node.hidden = false
  // next frame so the transition runs
  requestAnimationFrame(() => node.classList.add('open'))
  $('#scrim').classList.add('show')
  openSheet = { id, node, onClose }
  const state = { ...(history.state || {}), sheet: id }
  if (switching) history.replaceState(state, '')
  else history.pushState(state, '')
  node.querySelector('[data-autofocus]')?.focus({ preventScroll: true })
    ?? node.querySelector('button, [href], input, select, textarea')?.focus({ preventScroll: true })
}

export function closeSheet({ fromHistory = false, silent = false } = {}) {
  if (!openSheet) return false
  const { node, onClose } = openSheet
  openSheet = null
  node.classList.remove('open')
  $('#scrim').classList.remove('show')
  const hide = () => { if (!node.classList.contains('open')) node.hidden = true }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) hide()
  else setTimeout(hide, 260)
  if (!fromHistory && history.state?.sheet) {
    ignoreNextPop = true
    history.back()
  }
  onClose?.()
  if (!silent) restoreFocus?.focus?.({ preventScroll: true })
  return true
}

export const isSheetOpen = () => !!openSheet
export const openSheetId = () => openSheet?.id ?? null

let ignoreNextPop = false
// Returns true when the popstate was consumed by a sheet.
export function handleSheetPop() {
  if (ignoreNextPop) { ignoreNextPop = false; return true }
  if (openSheet) { closeSheet({ fromHistory: true }); return true }
  return false
}

export function formatAuthors(author) {
  const one = a => typeof a === 'string' ? a : langMap(a?.name)
  if (!author) return ''
  if (Array.isArray(author)) return new Intl.ListFormat('en', { style: 'short', type: 'conjunction' }).format(author.map(one).filter(Boolean))
  return one(author) || ''
}

export function langMap(x) {
  if (!x) return ''
  if (typeof x === 'string') return x
  const keys = Object.keys(x)
  return x[keys[0]] ?? ''
}

export function formatMinutes(min) {
  if (!Number.isFinite(min)) return ''
  const m = Math.max(1, Math.round(min))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60), r = m % 60
  return r ? `${h} h ${r} min` : `${h} h`
}

export const isTouch = () => matchMedia('(pointer: coarse)').matches
export const isCompact = () => matchMedia('(max-width: 699px)').matches
