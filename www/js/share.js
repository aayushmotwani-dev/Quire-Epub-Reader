// Hand a file to the person: the share sheet on phones, a download elsewhere.
// Resolves true when it was downloaded, false when it was shared or cancelled.
export async function saveFile(file, { preferShare = matchMedia('(pointer: coarse)').matches } = {}) {
  if (preferShare && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name })
      return false
    } catch (e) {
      if (e?.name === 'AbortError') return false
      // fall through to a normal download
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}

export const safeName = (s, fallback = 'Quire') => String(s || '').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) || fallback
