/** Returns true if the device has a coarse (touch) primary pointer. */
export function useHasTouch(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(pointer: coarse)').matches
}
