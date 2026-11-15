import { describe, it, expect } from 'vitest'
import { ceilGigabytes, formatBytes } from '../format-bytes'
import { MODEL_DEFINITIONS } from '../../model-catalog'
import { MINIMUM_DISK_SPACE_BYTES } from '../../constants/disk-space'

// Grössen dezimal wie macOS/Finder (Abschluss-Check Epic #192, Punkt 7)
describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [999, '999 B'],
    [1_000, '1 KB'],
    [340_400, '340 KB'],
    [999_600, '1 MB'],
    [547_000_000, '547 MB'],
    [999_600_000, '1.0 GB'],
    [1_036_271_860, '1.0 GB'],
    [2_101_189_732, '2.1 GB'],
    [3_349_516_256, '3.3 GB']
  ])('%d Bytes → %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text)
  })

  it('rechnet dezimal, nicht binär (1 GiB ist 1.1 GB)', () => {
    expect(formatBytes(1024 ** 3)).toBe('1.1 GB')
    expect(formatBytes(1e9)).toBe('1.0 GB')
  })

  it('Ersteinrichtung: Standard-ASR plus Pflichtmodelle zeigen «2.1 GB» wie README und Website', () => {
    const total = MODEL_DEFINITIONS.filter(
      (m) => m.isRequired || m.id === 'whisper-large-v3-turbo'
    ).reduce((sum, m) => sum + m.sizeBytes, 0)
    expect(formatBytes(total)).toBe('2.1 GB')
  })

  it('Suchmodell «430 MB» — öffentlich «0.43 GB»', () => {
    const search = MODEL_DEFINITIONS.find((m) => m.id === 'embeddinggemma-2-text')
    expect(formatBytes(search!.sizeBytes)).toBe('430 MB')
  })

  it('Mindestplatz bleibt 5 GiB und wird als «5.4 GB» angezeigt', () => {
    expect(MINIMUM_DISK_SPACE_BYTES).toBe(5 * 1024 ** 3)
    expect(formatBytes(MINIMUM_DISK_SPACE_BYTES)).toBe('5.4 GB')
  })
})

describe('ceilGigabytes', () => {
  it('rundet auf ganze dezimale GB auf', () => {
    expect(ceilGigabytes(1)).toBe(1)
    expect(ceilGigabytes(1e9)).toBe(1)
    expect(ceilGigabytes(1e9 + 1)).toBe(2)
    expect(ceilGigabytes(5 * 1024 ** 3)).toBe(6)
  })
})
