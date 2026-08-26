import { describe, it, expect } from 'vitest'
import { parseNerStderrLine } from '../AnonymizationService'

describe('parseNerStderrLine', () => {
  it('parses progress lines into a 0..1 value', () => {
    expect(parseNerStderrLine('[PROGRESS] 0')).toEqual({ kind: 'progress', progress: 0 })
    expect(parseNerStderrLine('[PROGRESS] 25')).toEqual({ kind: 'progress', progress: 0.25 })
    expect(parseNerStderrLine('[PROGRESS] 100')).toEqual({ kind: 'progress', progress: 1 })
  })

  it('recognises the heartbeat emitted during the model load', () => {
    expect(parseNerStderrLine('[HEARTBEAT]')).toEqual({ kind: 'heartbeat' })
  })

  it('never turns a heartbeat into progress', () => {
    // Regression: der Heartbeat überbrückt die Lücke zwischen [PROGRESS] 10
    // und [PROGRESS] 25 (2.24 GB Modell-Load). Würde er Progress schreiben,
    // liefe der Fortschrittsbalken während des Ladens hoch und der in der DB
    // persistierte Wert wäre gelogen.
    const event = parseNerStderrLine('[HEARTBEAT]')
    expect(event).not.toBeNull()
    expect(event?.kind).not.toBe('progress')
  })

  it('ignores unrelated stderr noise', () => {
    expect(parseNerStderrLine('MPS-Backend aktiv (Apple Silicon GPU)')).toBeNull()
    expect(parseNerStderrLine('')).toBeNull()
    expect(parseNerStderrLine('2026-08-26 09:58:01,123 loading file pytorch_model.bin')).toBeNull()
  })

  it('tolerates flair log prefixes around the markers', () => {
    expect(parseNerStderrLine('INFO [PROGRESS] 42')).toEqual({ kind: 'progress', progress: 0.42 })
    expect(parseNerStderrLine('INFO [HEARTBEAT]')).toEqual({ kind: 'heartbeat' })
  })
})
