// The Backup block in Settings.

import { $, toast, confirmDialog } from './ui.js'
import { makeBackup, inspectBackup, restoreBackup, librarySize } from './backup.js'
import { saveFile } from './share.js'

const mb = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`
let busy = false

function status(text) {
  const s = $('#backup-status')
  s.hidden = !text
  s.textContent = text || ''
}

function lock(on) {
  busy = on
  for (const id of ['backup-save', 'backup-restore', 'backup-books']) $('#' + id).disabled = on
}

export async function refreshBackupUI() {
  try {
    const { count, bytes } = await librarySize()
    $('#backup-books-label').textContent = count ? `Include the books (${mb(bytes)})` : 'Include the books'
  } catch { /* the label stays generic */ }
}

export function initBackupUI({ restored = () => {} } = {}) {
  $('#backup-save').addEventListener('click', async () => {
    if (busy) return
    lock(true)
    try {
      const file = await makeBackup({
        withBooks: $('#backup-books').checked,
        onProgress: (n, total) => status(`Packing book ${n} of ${total}…`),
      })
      const saved = await saveFile(file)
      status(saved ? `Backup saved as "${file.name}" (${mb(file.size)}).` : '')
    } catch (e) {
      status(e?.message || 'The backup could not be made.')
    } finally { lock(false) }
  })

  $('#backup-restore').addEventListener('click', () => { if (!busy) $('#backup-file').click() })
  $('#backup-file').addEventListener('change', async e => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || busy) return
    lock(true)
    try {
      status('Reading the backup…')
      const info = await inspectBackup(file)
      status('')
      const when = info.created ? ` from ${info.created.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}` : ''
      const books = info.withFiles === info.books
        ? `${info.books} ${info.books === 1 ? 'book' : 'books'}`
        : `reading data for ${info.books} ${info.books === 1 ? 'book' : 'books'} (${info.withFiles} with the book itself)`
      const ok = await confirmDialog({
        title: 'Restore this backup?',
        body: `This backup${when} holds ${books} and ${info.highlights} ${info.highlights === 1 ? 'highlight' : 'highlights'}. Restoring adds what is missing and brings back its settings. Nothing in your library is deleted.`,
        confirm: 'Restore',
      })
      if (!ok) return
      const r = await restoreBackup(file, { onProgress: (n, total) => status(`Restoring book ${n} of ${total}…`) })
      const parts = [`${r.added} ${r.added === 1 ? 'book' : 'books'} added`]
      if (r.updated) parts.push(`${r.updated} updated`)
      if (r.notes) parts.push(`${r.notes} ${r.notes === 1 ? 'highlight or bookmark' : 'highlights and bookmarks'} restored`)
      if (r.skipped) parts.push(`${r.skipped} skipped (the book itself is missing from the backup, or damaged)`)
      status(`Done: ${parts.join(', ')}.`)
      toast('Backup restored')
      await restored()
      refreshBackupUI()
    } catch (err) {
      status(err?.message || 'That backup could not be restored.')
    } finally { lock(false) }
  })
}
