import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, within } from '@testing-library/react'
import ReviewEditor from '../ReviewEditor'
import { ToastProvider } from '../../contexts/ToastContext'
import { _resetViewModeStoreForTests } from '../../viewMode/viewModeStore'
import type { ReviewData } from '../../../../shared/types'

/**
 * Epic #192 (Sichtprüfung): Öffnen ohne Bearbeitung schreibt nichts — jedes
 * review:save markiert die Sitzung als «für die Suche neu aufzubereiten».
 */

function reviewData(): ReviewData {
  return {
    document: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hallo ' },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'person-1',
                type: 'PERSON',
                number: 1,
                source: 'ner',
                original: 'Ruth Gerber'
              }
            },
            { type: 'text', text: ' erzählt.' }
          ]
        }
      ]
    },
    entityMap: {
      'person-1': {
        original: 'Ruth Gerber',
        placeholder: '[PERSON 1]',
        type: 'PERSON',
        source: 'ner'
      }
    },
    sessionType: 'audio',
    sessionTitle: 'Titel',
    titleSnapshot: null,
    processedWithModels: null,
    reviewAt: null,
    audioStats: null
  }
}

function makeApi() {
  return {
    viewMode: { initial: 'pseudonymized', set: vi.fn().mockResolvedValue(undefined) },
    settings: { get: vi.fn().mockResolvedValue(false), set: vi.fn().mockResolvedValue(undefined) },
    review: {
      load: vi.fn().mockImplementation(async () => reviewData()),
      save: vi.fn().mockResolvedValue(undefined),
      exportClipboard: vi.fn().mockResolvedValue(undefined)
    },
    summary: {
      get: vi.fn().mockResolvedValue(null),
      updateTitle: vi.fn(),
      updateText: vi.fn(),
      missingReason: vi.fn().mockResolvedValue(null),
      regenerate: vi.fn(),
      onChanged: vi.fn(() => () => {})
    },
    tasks: { onCompleted: vi.fn(() => () => {}) },
    blocklist: { add: vi.fn(), delete: vi.fn() },
    sessions: { delete: vi.fn(), list: vi.fn().mockResolvedValue([]) }
  }
}

let api: ReturnType<typeof makeApi>
const onBack = vi.fn()

async function openEditor() {
  api = makeApi()
  window.api = api as unknown as typeof window.api
  _resetViewModeStoreForTests()
  const utils = render(
    <ToastProvider>
      <ReviewEditor sessionId="s1" onBack={onBack} />
    </ToastProvider>
  )
  await screen.findByText(/erzählt\./)
  return utils
}

async function advance(ms: number): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      vi.advanceTimersByTime(ms)
    })
  }
}

beforeEach(() => {
  onBack.mockClear()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  _resetViewModeStoreForTests()
})

describe('Review-Editor öffnen', () => {
  it('speichert ohne Bearbeitung nicht, auch nicht beim Schliessen', async () => {
    const { unmount } = await openEditor()
    await advance(2500)
    expect(api.review.save).not.toHaveBeenCalled()
    expect(screen.queryByText(/Gespeichert/)).toBeNull()
    unmount()
    expect(api.review.save).not.toHaveBeenCalled()
  })

  it('Esc schliesst den Editor auch mit Fokus im Text', async () => {
    await openEditor()
    const pm = document.querySelector('.ProseMirror') as HTMLElement
    pm.focus()
    fireEvent.keyDown(pm, { key: 'Escape' })
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('Review-Editor: Übersicht bei schmaler Textspalte', () => {
  type RoCallback = (entries: Array<{ contentRect: { width: number } }>) => void
  let callbacks: RoCallback[] = []

  beforeEach(() => {
    callbacks = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: RoCallback) {
          callbacks.push(cb)
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function resize(width: number): Promise<void> {
    await act(async () => {
      for (const cb of callbacks) cb([{ contentRect: { width } }])
    })
  }

  const panel = (): HTMLElement =>
    document.querySelector('[aria-label="Übersicht schliessen"]')!.closest('[data-overlay]')!
  const toggle = (): HTMLElement =>
    screen.getByRole('button', { name: 'Übersicht ein-/ausblenden' })

  it('breit: kein Schliessen-Knopf, Übersicht daneben', async () => {
    await openEditor()
    await resize(900)
    expect(screen.queryByRole('button', { name: 'Übersicht schliessen' })).toBeNull()
    expect(document.querySelector('[data-overlay]')).toBeNull()
  })

  it('schmal: Übersicht ist eine Überlagerung, Fokus hinein und zurück', async () => {
    await openEditor()
    await resize(552)
    expect(panel().classList.contains('hidden')).toBe(true)
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')

    await act(async () => {
      fireEvent.click(toggle())
    })
    expect(panel().classList.contains('hidden')).toBe(false)
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(panel().querySelector('[tabindex="-1"]')).toBe(document.activeElement)
    // Die gespeicherte Vorgabe (daneben) bleibt unberührt
    expect(api.settings.set).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(within(panel()).getByRole('button', { name: 'Übersicht schliessen' }))
    })
    expect(panel().classList.contains('hidden')).toBe(true)
    expect(document.activeElement).toBe(toggle())
  })

  it('schmal: Esc schliesst zuerst die Überlagerung, das zweite Esc den Editor', async () => {
    await openEditor()
    await resize(552)
    await act(async () => {
      fireEvent.click(toggle())
    })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onBack).not.toHaveBeenCalled()
    expect(panel().classList.contains('hidden')).toBe(true)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('offener Zustand bleibt beim Überschreiten der Schwelle erhalten, Hysterese 720/760', async () => {
    await openEditor()
    await resize(552)
    await act(async () => {
      fireEvent.click(toggle())
    })
    expect(panel().classList.contains('hidden')).toBe(false)
    await resize(740)
    expect(document.querySelector('[data-overlay]')).not.toBeNull()
    await resize(800)
    expect(document.querySelector('[data-overlay]')).toBeNull()
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(api.settings.set).not.toHaveBeenCalled()
  })

  it('geschlossene Überlagerung bleibt beim Verbreitern zu, auch bei gespeichert «offen»', async () => {
    api = makeApi()
    api.settings.get.mockResolvedValue(true)
    window.api = api as unknown as typeof window.api
    _resetViewModeStoreForTests()
    render(
      <ToastProvider>
        <ReviewEditor sessionId="s1" onBack={onBack} />
      </ToastProvider>
    )
    await screen.findByText(/erzählt\./)
    await resize(552)
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    await resize(900)
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    expect(api.settings.set).not.toHaveBeenCalled()
  })

  it('Kopieren-Knopf nennt die aktive Ansicht auch ohne sichtbaren Text', async () => {
    await openEditor()
    expect(screen.getByRole('button', { name: 'Pseudonymisiert kopieren' })).toBeInTheDocument()
  })
})

type PmElement = HTMLElement & { editor: { commands: { insertContent: (t: string) => boolean } } }

function type(text: string): void {
  const pm = document.querySelector('.ProseMirror') as PmElement
  act(() => {
    pm.editor.commands.insertContent(text)
  })
}

describe('Review-Editor: Übersicht nach dem Öffnen', () => {
  it('listet den Namen aus dem Text, ohne zu speichern', async () => {
    await openEditor()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Übersicht ein-/ausblenden' }))
    })
    await advance(300)
    expect(screen.queryByText('Keine Pseudonymisierungen')).toBeNull()
    expect(document.querySelector('[data-original]')?.textContent).toContain('Ruth Gerber')
    expect(screen.getByText(/3 Wörter/)).toBeInTheDocument()
    await advance(2500)
    expect(api.review.save).not.toHaveBeenCalled()
  })
})

describe('Review-Editor: Speichern beim Schliessen', () => {
  it('tippen, nach 100 ms schliessen: genau ein Save', async () => {
    const { unmount } = await openEditor()
    type('x')
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    unmount()
    expect(api.review.save).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(api.review.save.mock.calls[0][1])).toContain('x')
  })

  it('tippen, 3 s warten, schliessen: kein zweiter Save', async () => {
    const { unmount } = await openEditor()
    type('x')
    await advance(1000)
    await advance(1000)
    await advance(1000)
    expect(api.review.save).toHaveBeenCalledTimes(1)
    unmount()
    expect(api.review.save).toHaveBeenCalledTimes(1)
  })

  it('nichts tippen: kein Save', async () => {
    const { unmount } = await openEditor()
    unmount()
    expect(api.review.save).not.toHaveBeenCalled()
  })
})

describe('Review-Editor: Speichern beim Beenden der App (Review PR #219)', () => {
  it('speichert eine ausstehende Änderung, wenn der Main-Prozess vor dem Beenden nachfragt', async () => {
    const { flushPendingEdits } = await import('../../services/pendingEdits')
    await openEditor()
    type('x')
    await act(async () => {
      await flushPendingEdits()
    })
    expect(api.review.save).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(api.review.save.mock.calls[0][1])).toContain('x')
  })

  it('speichert ohne Änderung nichts und meldet sich beim Schliessen ab', async () => {
    const { flushPendingEdits } = await import('../../services/pendingEdits')
    const { unmount } = await openEditor()
    await act(async () => {
      await flushPendingEdits()
    })
    expect(api.review.save).not.toHaveBeenCalled()
    type('y')
    unmount()
    expect(api.review.save).toHaveBeenCalledTimes(1)
    await flushPendingEdits()
    expect(api.review.save).toHaveBeenCalledTimes(1)
  })
})
