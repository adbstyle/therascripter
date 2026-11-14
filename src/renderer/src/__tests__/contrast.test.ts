import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Gefüllte Knöpfe mit weisser Schrift (Aufnahme starten/stoppen, Löschen,
// Fehler-Toast) brauchen in hell und dunkel ≥ 4.5:1 (WCAG AA, normale Schrift).
const css = readFileSync(join(__dirname, '..', 'assets', 'main.css'), 'utf-8')

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!match) throw new Error(`Token ${name} fehlt`)
  return match[1]
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrastWithWhite = (hex: string): number => 1.05 / (luminance(hex) + 0.05)

const light = css.slice(css.indexOf('@theme'), css.indexOf('.dark {'))
const dark = css.slice(css.indexOf('.dark {'))

describe('Kontrast weisser Schrift auf Aufnahme-Knöpfen', () => {
  for (const [theme, block] of [
    ['hell', light],
    ['dunkel', dark]
  ] as const) {
    for (const name of ['recording-solid', 'recording-solid-hover', 'recording-hover']) {
      it(`${name} (${theme}) ≥ 4.5:1`, () => {
        expect(contrastWithWhite(token(block, name))).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})
