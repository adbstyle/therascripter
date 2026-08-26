import { describe, it, expect } from 'vitest'
import { parseSidecarStderrLine } from '../sidecar-stderr'

describe('parseSidecarStderrLine', () => {
  it('parses progress lines into a 0..1 value', () => {
    expect(parseSidecarStderrLine('[PROGRESS] 0')).toEqual({ kind: 'progress', progress: 0 })
    expect(parseSidecarStderrLine('[PROGRESS] 25')).toEqual({ kind: 'progress', progress: 0.25 })
    expect(parseSidecarStderrLine('[PROGRESS] 100')).toEqual({ kind: 'progress', progress: 1 })
  })

  it('recognises the heartbeat emitted during the model load', () => {
    expect(parseSidecarStderrLine('[HEARTBEAT]')).toEqual({ kind: 'heartbeat' })
  })

  it('never turns a heartbeat into progress', () => {
    // Regression: der Heartbeat überbrückt die Lücke zwischen [PROGRESS] 10
    // und [PROGRESS] 25 (2.24 GB Modell-Load). Würde er Progress schreiben,
    // liefe der Fortschrittsbalken während des Ladens hoch und der in der DB
    // persistierte Wert wäre gelogen.
    const event = parseSidecarStderrLine('[HEARTBEAT]')
    expect(event).not.toBeNull()
    expect(event?.kind).not.toBe('progress')
  })

  it('ignores unrelated stderr noise', () => {
    expect(parseSidecarStderrLine('MPS-Backend aktiv (Apple Silicon GPU)')).toBeNull()
    expect(parseSidecarStderrLine('')).toBeNull()
    expect(
      parseSidecarStderrLine('2026-08-26 09:58:01,123 loading file pytorch_model.bin')
    ).toBeNull()
  })

  it('tolerates flair log prefixes around the markers', () => {
    expect(parseSidecarStderrLine('INFO [PROGRESS] 42')).toEqual({
      kind: 'progress',
      progress: 0.42
    })
    expect(parseSidecarStderrLine('INFO [HEARTBEAT]')).toEqual({ kind: 'heartbeat' })
  })

  it('ignores RTTM and pyannote noise from the diarization sidecar', () => {
    expect(
      parseSidecarStderrLine('SPEAKER audio 1 0.500 1.200 <NA> <NA> SPEAKER_00 <NA> <NA>')
    ).toBeNull()
    expect(parseSidecarStderrLine('Modellverzeichnis: /Users/x/.therascript/models')).toBeNull()
  })

  it('is stateless across calls', () => {
    // Beide Regexes sind absichtlich ohne /g-Flag: mit dem Flag wäre .test()
    // über lastIndex zustandsbehaftet und jeder zweite Heartbeat ginge
    // verloren — der Watchdog bekäme nur die Hälfte der Lebenszeichen.
    for (let i = 0; i < 5; i++) {
      expect(parseSidecarStderrLine('[HEARTBEAT]')).toEqual({ kind: 'heartbeat' })
      expect(parseSidecarStderrLine('[PROGRESS] 10')).toEqual({ kind: 'progress', progress: 0.1 })
    }
  })
})
