// Book details: look a book up on Open Library, and fetch a cover from it.
//
// This is the only part of Quire that talks to the internet, and only when the
// person presses Search. What is sent: the title and author they typed. What
// comes back is treated as untrusted text and numbers, never as markup.

const SEARCH = 'https://openlibrary.org/search.json'
const COVERS = 'https://covers.openlibrary.org/b/id/'
const MAX_COVER_BYTES = 6 * 1024 * 1024

const clean = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

export const coverUrl = (coverId, size = 'M') =>
  Number.isSafeInteger(coverId) && coverId > 0 && /^[SML]$/.test(size) ? `${COVERS}${coverId}-${size}.jpg?default=false` : ''

export async function searchBooks({ title = '', author = '' }, { signal } = {}) {
  title = clean(title, 200); author = clean(author, 200)
  if (!title && !author) return []
  const params = new URLSearchParams({ fields: 'key,title,author_name,first_publish_year,cover_i', limit: '12' })
  if (title) params.set('title', title)
  if (author) params.set('author', author)
  const res = await fetch(`${SEARCH}?${params}`, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
  if (!res.ok) throw new Error(`Open Library answered ${res.status}`)
  const data = await res.json()
  const docs = Array.isArray(data?.docs) ? data.docs : []
  return docs.slice(0, 12).map(d => ({
    title: clean(d?.title),
    author: clean(Array.isArray(d?.author_name) ? d.author_name.slice(0, 4).join(', ') : ''),
    year: Number.isInteger(d?.first_publish_year) ? d.first_publish_year : 0,
    coverId: Number.isSafeInteger(d?.cover_i) && d.cover_i > 0 ? d.cover_i : 0,
  })).filter(d => d.title)
}

const isImage = blob => blob && blob.size > 0 && blob.size <= MAX_COVER_BYTES && /^image\//.test(blob.type || 'image/jpeg')

// A cover is always fetched as bytes, never shown straight from its address:
// that keeps the app's rule that pages (and books) may not load images from
// the internet. A browser may refuse the fetch for another site's image, so the
// desktop and phone apps have their own, narrowly scoped, way to do it.
export async function fetchCover(coverId, size = 'L') {
  const url = coverUrl(coverId, size)
  if (!url) throw new Error('No cover')
  try {
    const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (res.ok) { const blob = await res.blob(); if (isImage(blob)) return blob }
  } catch { /* try the app's own route */ }
  try {
    const out = await window.quireNative?.fetchCover?.(coverId, size)
    if (out?.data) { const blob = new Blob([out.data], { type: out.type || 'image/jpeg' }); if (isImage(blob)) return blob }
  } catch { /* next */ }
  try {
    const http = window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins?.CapacitorHttp : null
    if (http) {
      const r = await http.get({ url, responseType: 'blob' })
      if (r?.status === 200 && typeof r.data === 'string') {
        const bin = atob(r.data)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const blob = new Blob([bytes], { type: 'image/jpeg' })
        if (isImage(blob)) return blob
      }
    }
  } catch { /* give up below */ }
  throw new Error('The cover could not be downloaded')
}
