/** Returns true if `latest` is strictly newer than `current` (semver without pre-release). */
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const parts = v.split('.').map(Number)
    if (parts.length !== 3 || parts.some(isNaN)) return [0, 0, 0]
    return parts as [number, number, number]
  }
  const [cMaj, cMin, cPat] = parse(current)
  const [lMaj, lMin, lPat] = parse(latest)
  if (lMaj !== cMaj) return lMaj > cMaj
  if (lMin !== cMin) return lMin > cMin
  return lPat > cPat
}
