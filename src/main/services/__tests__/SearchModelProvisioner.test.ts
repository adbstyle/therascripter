import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ModelDefinition } from '../../../shared/model-catalog'
import type { SearchModelState } from '../../../shared/types/Search'
import type { ModelInstallOptions, ModelInstallResult } from '../ModelDownloadService'
import {
  SEARCH_MODEL_BUSY_RECHECK_MS,
  SEARCH_MODEL_LONG_RETRY_MS,
  SEARCH_MODEL_RETRY_DELAYS_MS,
  SearchModelProvisioner,
  type SearchModelProvisionerDeps
} from '../SearchModelProvisioner'

const MIN = 60_000
const def = {
  id: 'embeddinggemma-2-text',
  label: 'EmbeddingGemma 2',
  url: 'https://cdn/eg2.tar.gz',
  sizeBytes: 430_211_881,
  sha256: 'a'.repeat(64),
  relativePath: 'search-embeddinggemma-2-text-v1',
  checkPath: 'search-embeddinggemma-2-text-v1/READY',
  archive: true,
  group: 'search',
  isRequired: true,
  deferrable: true
} as ModelDefinition

interface Harness {
  deps: SearchModelProvisionerDeps
  states: SearchModelState[]
  installed: { value: boolean }
  install: ReturnType<typeof vi.fn>
  removeLeftovers: ReturnType<typeof vi.fn>
}

function harness(overrides: Partial<SearchModelProvisionerDeps> = {}): Harness {
  const states: SearchModelState[] = []
  const installed = { value: false }
  const install = vi.fn()
  const removeLeftovers = vi.fn()
  const deps: SearchModelProvisionerDeps = {
    getModel: () => def,
    isPublished: () => true,
    isInstalled: () => installed.value,
    setupComplete: () => true,
    isBusy: () => false,
    freeBytes: () => 50e9,
    install: (d, o) => install(d, o),
    removeLeftovers,
    onStateChange: (s) => states.push(s),
    now: () => new Date(),
    log: () => {},
    ...overrides
  }
  return { deps, states, installed, install, removeLeftovers }
}

/** Fake-Download: meldet Fortschritt und liefert dann das Ergebnis. */
function fakeInstall(h: Harness, result: ModelInstallResult, onDone?: () => void): void {
  h.install.mockImplementation(async (_d: ModelDefinition, o: ModelInstallOptions) => {
    o.onProgress?.({ downloadedBytes: 1, totalBytes: 2, percent: 50 })
    onDone?.()
    return result
  })
}

const fail = (reason: string, error = reason): ModelInstallResult =>
  ({ ok: false, reason, error }) as ModelInstallResult

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-14T10:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('SearchModelProvisioner', () => {
  it('meldet unpublished und lädt nichts, solange das Modell nicht veröffentlicht ist', async () => {
    const h = harness({ isPublished: () => false })
    const p = new SearchModelProvisioner(h.deps)
    expect(p.getState()).toEqual({ status: 'unpublished' })
    await p.retryNow()
    expect(h.install).not.toHaveBeenCalled()
    expect(p.getState()).toEqual({ status: 'unpublished' })
  })

  it('liegt das Modell schon da (auch unveröffentlicht), ist es bereit — ohne Download', async () => {
    const h = harness({ isPublished: () => false })
    h.installed.value = true
    const p = new SearchModelProvisioner(h.deps)
    expect(p.getState()).toEqual({ status: 'ready' })
    p.start()
    await vi.runAllTimersAsync()
    expect(h.install).not.toHaveBeenCalled()
  })

  it('lädt nach dem Start im Hintergrund, meldet Fortschritt und dann bereit (#210 AK 2)', async () => {
    const h = harness()
    fakeInstall(h, { ok: true, installed: true }, () => (h.installed.value = true))
    const p = new SearchModelProvisioner(h.deps)
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.install).toHaveBeenCalledTimes(1)
    expect(h.states).toEqual([
      { status: 'downloading', progress: 0 },
      { status: 'downloading', progress: 50 },
      { status: 'ready' }
    ])
  })

  it('lädt nie neben der Ersteinrichtung — erst, wenn sie abgeschlossen ist', async () => {
    let setup = false
    const h = harness({ setupComplete: () => setup })
    fakeInstall(h, { ok: true, installed: true })
    const p = new SearchModelProvisioner(h.deps)
    p.start()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(h.install).not.toHaveBeenCalled()
    setup = true
    p.start() // modelDownload:start stösst nach der Ersteinrichtung an
    await vi.advanceTimersByTimeAsync(0)
    expect(h.install).toHaveBeenCalledTimes(1)
  })

  it('Single-Flight: zweiter Anstoss während eines Downloads lädt nicht erneut', async () => {
    const h = harness()
    let finish: (r: ModelInstallResult) => void = () => {}
    h.install.mockReturnValue(new Promise((r) => (finish = r)))
    const p = new SearchModelProvisioner(h.deps)
    p.start()
    p.start()
    const retry = p.retryNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.install).toHaveBeenCalledTimes(1)
    h.installed.value = true
    finish({ ok: true, installed: true })
    expect(await retry).toEqual({ status: 'ready' })
  })

  it.each(['network', 'disk-space', 'checksum', 'extract', 'unknown'] as const)(
    'Grund %s: Wiederholung nach 1, 5 und 30 Minuten, danach failed und alle 6 Stunden',
    async (reason) => {
      const h = harness()
      fakeInstall(h, fail(reason))
      const p = new SearchModelProvisioner(h.deps)
      p.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(p.getState()).toEqual({
        status: 'retry-scheduled',
        reason,
        nextAttemptAt: '2026-11-14T10:01:00.000Z'
      })

      const expectedCalls = [2, 3, 4]
      for (const [i, delay] of SEARCH_MODEL_RETRY_DELAYS_MS.entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1)
        expect(h.install).toHaveBeenCalledTimes(expectedCalls[i] - 1)
        await vi.advanceTimersByTimeAsync(1)
        expect(h.install).toHaveBeenCalledTimes(expectedCalls[i])
      }
      // Nach dem 4. Fehlschlag: failed, die App versucht es still weiter
      expect(p.getState()).toEqual({ status: 'failed', reason })
      await vi.advanceTimersByTimeAsync(SEARCH_MODEL_LONG_RETRY_MS)
      expect(h.install).toHaveBeenCalledTimes(5)
      await vi.advanceTimersByTimeAsync(SEARCH_MODEL_LONG_RETRY_MS)
      expect(h.install).toHaveBeenCalledTimes(6)
      expect(p.getState()).toEqual({ status: 'failed', reason })
    }
  )

  it('zu wenig Platz: kein Download, Grund disk-space', async () => {
    const h = harness({ freeBytes: () => 500e6 })
    const p = new SearchModelProvisioner(h.deps)
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.install).not.toHaveBeenCalled()
    expect(p.getState()).toMatchObject({ status: 'retry-scheduled', reason: 'disk-space' })
  })

  it('entpackt, aber ohne READY: Grund extract', async () => {
    const h = harness()
    fakeInstall(h, { ok: true, installed: false })
    const p = new SearchModelProvisioner(h.deps)
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(p.getState()).toMatchObject({ status: 'retry-scheduled', reason: 'extract' })
  })

  it('wirft der Download, gilt der Grund unknown', async () => {
    const h = harness()
    h.install.mockRejectedValue(new Error('kaputt'))
    const p = new SearchModelProvisioner(h.deps)
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(p.getState()).toMatchObject({ status: 'retry-scheduled', reason: 'unknown' })
  })

  it('«Erneut versuchen» lädt sofort und beginnt die Staffel von vorn', async () => {
    const h = harness()
    fakeInstall(h, fail('network'))
    const p = new SearchModelProvisioner(h.deps)
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    for (const delay of SEARCH_MODEL_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay)
    expect(p.getState()).toEqual({ status: 'failed', reason: 'network' })

    fakeInstall(h, fail('network'))
    expect(await p.retryNow()).toEqual({
      status: 'retry-scheduled',
      reason: 'network',
      nextAttemptAt: new Date(Date.now() + MIN).toISOString()
    })
    fakeInstall(h, { ok: true, installed: true }, () => (h.installed.value = true))
    expect(await p.retryNow()).toEqual({ status: 'ready' })
    // Kein alter Timer mehr: es folgt kein weiterer Versuch
    const calls = h.install.mock.calls.length
    await vi.advanceTimersByTimeAsync(SEARCH_MODEL_LONG_RETRY_MS * 2)
    expect(h.install).toHaveBeenCalledTimes(calls)
  })

  it('stop() bricht den Download ab und plant nichts neu (Beenden, Update-Austausch)', async () => {
    const h = harness()
    let signal: { aborted: boolean } | null = null
    h.install.mockImplementation(async (_d: ModelDefinition, o: ModelInstallOptions) => {
      signal = o.signal
      await new Promise((r) => setTimeout(r, 5 * MIN))
      return o.signal.aborted ? fail('aborted', 'Aborted') : fail('network')
    })
    const p = new SearchModelProvisioner(h.deps)
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    p.stop()
    expect(signal!.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(SEARCH_MODEL_LONG_RETRY_MS * 2)
    expect(h.install).toHaveBeenCalledTimes(1)
    expect(p.getState()).toEqual({ status: 'downloading', progress: 0 })
  })

  it('bricht beim Beenden auch das Entpacken ab (abortExtraction)', async () => {
    const h = harness()
    fakeInstall(h, { ok: true, installed: true })
    const p = new SearchModelProvisioner(h.deps)
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.install.mock.calls[0][1]).toMatchObject({ abortExtraction: true })
  })

  it('stop() während des Wartens löscht den geplanten Versuch', async () => {
    const h = harness()
    fakeInstall(h, fail('network'))
    const p = new SearchModelProvisioner(h.deps)
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    p.stop()
    await vi.advanceTimersByTimeAsync(SEARCH_MODEL_LONG_RETRY_MS * 2)
    expect(h.install).toHaveBeenCalledTimes(1)
  })

  it('beginnt während Aufnahme oder Verarbeitung nicht, prüft aber minütlich neu', async () => {
    let busy = true
    const h = harness({ isBusy: () => busy })
    fakeInstall(h, { ok: true, installed: true }, () => (h.installed.value = true))
    const p = new SearchModelProvisioner(h.deps)
    p.start()
    await vi.advanceTimersByTimeAsync(SEARCH_MODEL_BUSY_RECHECK_MS * 3)
    expect(h.install).not.toHaveBeenCalled()
    busy = false
    await vi.advanceTimersByTimeAsync(SEARCH_MODEL_BUSY_RECHECK_MS)
    expect(h.install).toHaveBeenCalledTimes(1)
    expect(p.getState()).toEqual({ status: 'ready' })
  })

  it('hat das Update das Modell mitgebracht: bereit, kein Download, Reste aufgeräumt', async () => {
    const h = harness()
    h.installed.value = true // nach dem Austausch liegt READY schon da
    const p = new SearchModelProvisioner(h.deps)
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.install).not.toHaveBeenCalled()
    expect(h.removeLeftovers).toHaveBeenCalledWith(def)
    expect(p.getState()).toEqual({ status: 'ready' })
  })

  it('meldet jeden Zustandswechsel, Fortschritt nur bei neuem Prozentwert', async () => {
    const h = harness()
    h.install.mockImplementation(async (_d: ModelDefinition, o: ModelInstallOptions) => {
      for (const percent of [0, 10, 10.2, 10.4, 55, 100]) {
        o.onProgress?.({ downloadedBytes: 0, totalBytes: 0, percent })
      }
      h.installed.value = true
      return { ok: true, installed: true }
    })
    const p = new SearchModelProvisioner(h.deps)
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.states).toEqual([
      { status: 'downloading', progress: 0 },
      { status: 'downloading', progress: 10 },
      { status: 'downloading', progress: 55 },
      { status: 'downloading', progress: 100 },
      { status: 'ready' }
    ])
  })

  describe('Anzeige, solange nichts lädt (Review PR #224)', () => {
    it('vor abgeschlossener Ersteinrichtung: waiting setup, nie downloading', async () => {
      const h = harness({ setupComplete: () => false })
      const p = new SearchModelProvisioner(h.deps)
      expect(p.getState()).toEqual({ status: 'waiting', reason: 'setup' })
      p.start()
      await vi.advanceTimersByTimeAsync(10 * MIN)
      expect(p.getState()).toEqual({ status: 'waiting', reason: 'setup' })
      expect(h.states.some((s) => s.status === 'downloading')).toBe(false)
    })

    it('vor dem ersten Versuch: waiting starting statt «Wird geladen 0 %»', () => {
      const p = new SearchModelProvisioner(harness().deps)
      expect(p.getState()).toEqual({ status: 'waiting', reason: 'starting' })
    })

    it('während Aufnahme/Verarbeitung: waiting busy mit nachgeführter Prüfzeit', async () => {
      const h = harness({ isBusy: () => true })
      const p = new SearchModelProvisioner(h.deps)
      p.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(p.getState()).toEqual({
        status: 'waiting',
        reason: 'busy',
        nextAttemptAt: '2026-11-14T10:01:00.000Z'
      })
      await vi.advanceTimersByTimeAsync(SEARCH_MODEL_BUSY_RECHECK_MS)
      expect(p.getState()).toMatchObject({ nextAttemptAt: '2026-11-14T10:02:00.000Z' })
      expect(h.states.some((s) => s.status === 'downloading')).toBe(false)
    })

    it('«Erneut versuchen» während laufender Arbeit liefert waiting busy (sichtbar)', async () => {
      const h = harness({ isBusy: () => true })
      const p = new SearchModelProvisioner(h.deps)
      expect(await p.retryNow()).toMatchObject({ status: 'waiting', reason: 'busy' })
      expect(h.install).not.toHaveBeenCalled()
    })
  })

  describe('Aufwachen aus dem Ruhezustand', () => {
    it('holt einen im Ruhezustand fällig gewordenen Versuch sofort nach, Zeit stimmt danach', async () => {
      let resume: () => void = () => {}
      const h = harness({ subscribeResume: (l) => (resume = l) })
      fakeInstall(h, fail('network'))
      const p = new SearchModelProvisioner(h.deps)
      p.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(p.getState()).toMatchObject({ nextAttemptAt: '2026-11-14T10:01:00.000Z' })

      // Mac schläft 2 Stunden: Uhr springt, Timer feuern (noch) nicht
      vi.setSystemTime(new Date('2026-11-14T12:00:00Z'))
      resume()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.install).toHaveBeenCalledTimes(2)
      expect(p.getState()).toEqual({
        status: 'retry-scheduled',
        reason: 'network',
        nextAttemptAt: '2026-11-14T12:05:00.000Z'
      })
    })

    it('ist der Versuch noch nicht fällig, ändert das Aufwachen nichts', async () => {
      let resume: () => void = () => {}
      const h = harness({ subscribeResume: (l) => (resume = l) })
      fakeInstall(h, fail('network'))
      const p = new SearchModelProvisioner(h.deps)
      p.start()
      await vi.advanceTimersByTimeAsync(0)
      resume()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.install).toHaveBeenCalledTimes(1)
    })
  })
})
