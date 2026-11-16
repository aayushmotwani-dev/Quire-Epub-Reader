// Quire: ComicInfo.xml (the common comic tag file) gives the title, series,
// writer, genres, language and, for manga, the right-to-left reading order.
// Only text is read from it.
const readComicInfo = async (entries, loadText) => {
    const entry = entries.find(e => /(^|\/)comicinfo\.xml$/i.test(e.filename))
    if (!entry || !loadText || (entry.uncompressedSize ?? 0) > 512 * 1024) return null
    try {
        const doc = new DOMParser().parseFromString(await loadText(entry.filename), 'application/xml')
        if (doc.querySelector('parsererror')) return null
        const get = tag => doc.getElementsByTagName(tag)[0]?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
        return {
            title: get('Title'), series: get('Series'), number: get('Number'), volume: get('Volume'),
            writer: get('Writer'), penciller: get('Penciller'), genre: get('Genre'), tags: get('Tags'),
            language: get('LanguageISO'), summary: get('Summary'), manga: get('Manga'),
        }
    } catch { return null }
}

export const makeComicBook = async ({ entries, loadBlob, getSize, loadText }, file) => {
    const cache = new Map()
    const urls = new Map()
    const load = async name => {
        if (cache.has(name)) return cache.get(name)
        const src = URL.createObjectURL(await loadBlob(name))
        const page = URL.createObjectURL(
            new Blob([`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin: 0"><img src="${src}"></body></html>`], { type: 'text/html' }))
        urls.set(name, [src, page])
        cache.set(name, page)
        return page
    }
    const unload = name => {
        urls.get(name)?.forEach?.(url => URL.revokeObjectURL(url))
        urls.delete(name)
        cache.delete(name)
    }

    const exts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.jxl', '.avif']
    const files = entries
        .map(entry => entry.filename)
        .filter(name => exts.some(ext => name.toLowerCase().endsWith(ext))) // Quire: PAGE01.JPG is a page too
        .filter(name => !/(^|\/)(__MACOSX\/|\.)/.test(name)) // Quire: Mac resource forks are not pages
        .sort(new Intl.Collator([], { numeric: true }).compare)
    if (!files.length) throw new Error('No supported image files in archive')

    const book = {}
    book.getCover = () => loadBlob(files[0])
    book.metadata = { title: file.name }
    const info = await readComicInfo(entries, loadText)
    if (info) {
        const issue = info.number || info.volume
        const title = info.title || (info.series && issue ? `${info.series} ${issue}` : '')
        if (title) book.metadata.title = title
        const by = info.writer || info.penciller
        if (by) book.metadata.author = by.split(/\s*,\s*/).filter(Boolean).map(name => ({ name }))
        if (info.language) book.metadata.language = info.language
        if (info.summary) book.metadata.description = info.summary
        const subjects = [info.genre, info.tags].filter(Boolean).join(',').split(/\s*,\s*/).filter(Boolean)
        if (subjects.length) book.metadata.subject = subjects
        if (info.series) book.metadata.belongsTo = { series: { name: info.series, position: issue } }
        if (/^yesandrighttoleft$/i.test(info.manga)) book.dir = 'rtl'
    }
    book.sections = files.map(name => ({
        id: name,
        load: () => load(name),
        unload: () => unload(name),
        size: getSize(name),
    }))
    book.toc = files.map((name, i) => ({ label: `Page ${i + 1}`, href: name })) // Quire: not the file names
    book.rendition = { layout: 'pre-paginated' }
    book.resolveHref = href => ({ index: book.sections.findIndex(s => s.id === href) })
    book.splitTOCHref = href => [href, null]
    book.getTOCFragment = doc => doc.documentElement
    book.destroy = () => {
        for (const arr of urls.values())
            for (const url of arr) URL.revokeObjectURL(url)
    }
    return book
}
