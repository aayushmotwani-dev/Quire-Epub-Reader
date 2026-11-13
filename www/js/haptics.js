// A light tap in the hand when a page turns. Phones only: the native apps use
// the Haptics plugin, a browser on Android falls back to a very short vibration.
import { getSettings } from './settings.js'

let last = 0
export function tick() {
  if (!getSettings().haptics) return
  const now = performance.now()
  if (now - last < 60) return
  last = now
  try {
    const cap = window.Capacitor
    const plugin = cap?.isNativePlatform?.() ? cap.Plugins?.Haptics : null
    if (plugin) { plugin.impact({ style: 'LIGHT' }).catch(() => {}); return }
    if (matchMedia('(pointer: coarse)').matches) navigator.vibrate?.(6)
  } catch { /* no haptics here */ }
}
