import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ProcessWatchdog } from '../ProcessWatchdog'

describe('ProcessWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires onStall when no heartbeat received within threshold', () => {
    const onStall = vi.fn()
    const watchdog = new ProcessWatchdog({
      taskType: 'diarization',
      onStall
    })

    watchdog.start()

    // Advance past the 120s threshold + poll interval
    vi.advanceTimersByTime(135_000)

    expect(onStall).toHaveBeenCalledOnce()

    watchdog.stop()
  })

  it('does not fire onStall when heartbeat resets the timer', () => {
    const onStall = vi.fn()
    const watchdog = new ProcessWatchdog({
      taskType: 'diarization',
      onStall
    })

    watchdog.start()

    // Send heartbeats every 30s — well within the 120s threshold
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(30_000)
      watchdog.heartbeat()
    }

    expect(onStall).not.toHaveBeenCalled()

    watchdog.stop()
  })

  it('fires onStall at most once', () => {
    const onStall = vi.fn()
    const watchdog = new ProcessWatchdog({
      taskType: 'diarization',
      onStall
    })

    watchdog.start()

    // Advance well past multiple poll intervals after stall
    vi.advanceTimersByTime(300_000)

    expect(onStall).toHaveBeenCalledOnce()

    watchdog.stop()
  })

  it('stop() prevents onStall from firing', () => {
    const onStall = vi.fn()
    const watchdog = new ProcessWatchdog({
      taskType: 'diarization',
      onStall
    })

    watchdog.start()

    // Stop before threshold is reached
    vi.advanceTimersByTime(60_000)
    watchdog.stop()

    // Advance past threshold — should not fire
    vi.advanceTimersByTime(200_000)

    expect(onStall).not.toHaveBeenCalled()
  })

  it('uses dynamic threshold for transcription based on audio duration', () => {
    const onStall = vi.fn()
    // 120 min audio → threshold = max(7200/40, 120) = 180s
    const watchdog = new ProcessWatchdog({
      taskType: 'transcription',
      audioDurationSec: 7200,
      onStall
    })

    watchdog.start()

    // At 150s — should NOT have fired (threshold is 180s)
    vi.advanceTimersByTime(150_000)
    expect(onStall).not.toHaveBeenCalled()

    // At 195s — should have fired (past 180s threshold)
    vi.advanceTimersByTime(45_000)
    expect(onStall).toHaveBeenCalledOnce()

    watchdog.stop()
  })

  it('uses minimum 120s threshold for short audio transcription', () => {
    const onStall = vi.fn()
    // 10 min audio → threshold = max(600/40, 120) = max(15, 120) = 120s
    const watchdog = new ProcessWatchdog({
      taskType: 'transcription',
      audioDurationSec: 600,
      onStall
    })

    watchdog.start()

    // At 100s — should NOT have fired
    vi.advanceTimersByTime(100_000)
    expect(onStall).not.toHaveBeenCalled()

    // At 135s — should have fired (past 120s threshold)
    vi.advanceTimersByTime(35_000)
    expect(onStall).toHaveBeenCalledOnce()

    watchdog.stop()
  })

  it('skips polling for in-process task types (alignment)', () => {
    const onStall = vi.fn()
    const watchdog = new ProcessWatchdog({
      taskType: 'alignment',
      onStall
    })

    watchdog.start()

    // Advance well past any threshold — should never fire for in-process tasks
    vi.advanceTimersByTime(600_000)

    expect(onStall).not.toHaveBeenCalled()

    watchdog.stop()
  })

  it('skips polling for in-process task types (extraction)', () => {
    const onStall = vi.fn()
    const watchdog = new ProcessWatchdog({
      taskType: 'extraction',
      onStall
    })

    watchdog.start()

    vi.advanceTimersByTime(600_000)

    expect(onStall).not.toHaveBeenCalled()

    watchdog.stop()
  })

  it('uses 60s threshold for OCR tasks', () => {
    const onStall = vi.fn()
    const watchdog = new ProcessWatchdog({
      taskType: 'ocr',
      onStall
    })

    watchdog.start()

    // At 45s — should NOT have fired
    vi.advanceTimersByTime(45_000)
    expect(onStall).not.toHaveBeenCalled()

    // At 75s — should have fired (past 60s threshold)
    vi.advanceTimersByTime(30_000)
    expect(onStall).toHaveBeenCalledOnce()

    watchdog.stop()
  })

  // Pipeline-Inversion (ADR-007): pyannote runs first now and on long
  // recordings can take minutes per stage with no progress event. The
  // dynamic threshold gives generous slack on long audio.
  it('uses dynamic threshold for diarization based on audio duration', () => {
    const onStall = vi.fn()
    // 60 min audio → threshold = max(3600/15, 120) = 240s
    const watchdog = new ProcessWatchdog({
      taskType: 'diarization',
      audioDurationSec: 3600,
      onStall
    })

    watchdog.start()

    // At 200s — should NOT have fired
    vi.advanceTimersByTime(200_000)
    expect(onStall).not.toHaveBeenCalled()

    // At 260s — should have fired (past 240s threshold)
    vi.advanceTimersByTime(60_000)
    expect(onStall).toHaveBeenCalledOnce()

    watchdog.stop()
  })

  it('uses minimum 120s threshold for short audio diarization', () => {
    const onStall = vi.fn()
    // 1 min audio → threshold = max(60/15, 120) = max(4, 120) = 120s
    const watchdog = new ProcessWatchdog({
      taskType: 'diarization',
      audioDurationSec: 60,
      onStall
    })

    watchdog.start()

    // At 100s — should NOT have fired
    vi.advanceTimersByTime(100_000)
    expect(onStall).not.toHaveBeenCalled()

    // At 135s — should have fired
    vi.advanceTimersByTime(35_000)
    expect(onStall).toHaveBeenCalledOnce()

    watchdog.stop()
  })
})
