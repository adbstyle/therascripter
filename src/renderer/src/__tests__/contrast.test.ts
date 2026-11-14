import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
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

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

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

describe('Kontrast von Text auf Primärfarben und Links (WCAG AA, 4.5:1)', () => {
  for (const [theme, block] of [
    ['hell', light],
    ['dunkel', dark]
  ] as const) {
    describe(theme, () => {
      // Gefüllte Knöpfe (Download starten, Speichern, …): weisse Schrift
      for (const name of ['primary-solid', 'primary-solid-hover']) {
        it(`weisse Schrift auf ${name} ≥ 4.5:1`, () => {
          expect(contrastWithWhite(token(block, name))).toBeGreaterThanOrEqual(4.5)
        })
      }

      // Links und Akzenttext (z. B. «Erneut versuchen») auf den Flächen
      for (const fg of ['primary', 'primary-hover']) {
        for (const bg of ['surface-0', 'surface-1', 'surface-2']) {
          it(`${fg} auf ${bg} ≥ 4.5:1`, () => {
            expect(contrast(token(block, fg), token(block, bg))).toBeGreaterThanOrEqual(4.5)
          })
        }
      }

      // Ausgewählte Einträge und Badges auf der hellen Primärfläche
      it('primary-hover auf primary-light ≥ 4.5:1', () => {
        expect(
          contrast(token(block, 'primary-hover'), token(block, 'primary-light'))
        ).toBeGreaterThanOrEqual(4.5)
      })
    })
  }

  it('kein gefüllter Knopf nutzt mehr bg-primary mit weisser Schrift', () => {
    const root = join(__dirname, '..')
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full)
        } else if (entry.name.endsWith('.tsx')) {
          readFileSync(full, 'utf-8')
            .split('\n')
            .forEach((line, i) => {
              if (/\bbg-primary\b(?![-/])/.test(line) && line.includes('text-white')) {
                hits.push(`${entry.name}:${i + 1}`)
              }
            })
        }
      }
    }
    walk(root)
    expect(hits).toEqual([])
  })
})
