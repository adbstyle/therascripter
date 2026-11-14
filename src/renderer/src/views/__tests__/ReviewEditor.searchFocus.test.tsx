import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ReviewEditor, { SEARCH_HIT_GONE_TEXT } from '../ReviewEditor'
import { ToastProvider } from '../../contexts/ToastContext'
import { _resetViewModeStoreForTests } from '../../viewMode/viewModeStore'
import type { ReviewData, ViewMode } from '../../../../shared/types'
import type { SessionFocus } from '../../navigation/routes'

/**
 * #209 AK 11 — Sprung zur Fundstelle im Editor: Absatz hinterlegt, Begriffe
 * bzw. Chips markiert, in die Mitte gescrollt, angesagt; kein Speichern;
 * Anker-Rückfall; Titel und Zusammenfassung; Esc-Reihenfolge.
 */

function reviewData(): ReviewData {
  return {
    document: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'speakerLabel', attrs: { speaker: 'A', label: 'Person A' } },
            { type: 'text', text: ' ' },
            { type: 'timestamp', attrs: { seconds: 5, formatted: '00:00:05' } },
            { type: 'text', text: ' Wie geht es Ihnen?' }
          ]
        },
        {
          type: 'paragraph',
          content: [
            { type: 'speakerLabel', attrs: { speaker: 'B', label: 'Person B' } },
            { type: 'text', text: ' Seit ' },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'person-1',
                type: 'PERSON',
                number: 1,
                source: 'ner',
                original: 'Reto Fässler'
              }
            },
            { type: 'text', text: ' plant, schlafe ich schlecht.' }
          ]
        }
      ]
    },
    entityMap: {
      'person-1': {
        original: 'Reto Fässler',
        placeholder: '[PERSON 1]',
        type: 'PERSON',
        source: 'ner'
      }
    },
    sessionType: 'audio',
    sessionTitle: 'Rückfall nach Stellenwechsel',
    titleSnapshot: null,
    processedWithModels: null,
    reviewAt: null,
    audioStats: null,
    createdAt: '2026-11-10T09:00:00.000Z',
    documentDate: null
  }
}

function makeApi(initial: ViewMode) {
  return {
    viewMode: { initial, set: vi.fn().mockResolvedValue(undefined) },
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
    dossiers: {
      list: vi.fn().mockResolvedValue([]),
      listForSession: vi.fn().mockResolvedValue([]),
      onChanged: vi.fn(() => () => {})
    },
    sessions: {
      delete: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      onChanged: vi.fn(() => () => {})
    }
  }
}

// Klartext des zweiten Absatzes: « Seit Reto Fässler plant, schlafe ich schlecht.»
const P1 = ' Seit Reto Fässler plant, schlafe ich schlecht.'
function rangeOf(word: string) {
  const s = P1.indexOf(word)
  return { p: 1, s, e: s + word.length }
}

const SCHLAFE: SessionFocus = {
  kind: 'hit',
  paraFrom: 1,
  paraTo: 1,
  ranges: [rangeOf('schlafe')],
  anchor: 'schlafe'
}

let api: ReturnType<typeof makeApi>
const onBack = vi.fn()
const scrollIntoView = vi.fn()

async function openEditor(focus: SessionFocus | undefined, initial: ViewMode = 'pseudonymized') {
  api = makeApi(initial)
  window.api = api as unknown as typeof window.api
  _resetViewModeStoreForTests()
  const utils = render(
    <ToastProvider>
      <ReviewEditor sessionId="s1" onBack={onBack} focus={focus} />
    </ToastProvider>
  )
  await screen.findByText(/schlecht\./)
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
  scrollIntoView.mockClear()
  Element.prototype.scrollIntoView = scrollIntoView
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  _resetViewModeStoreForTests()
})

describe('Fundstelle im Editor (#209 AK 11)', () => {
  it('hinterlegt den Absatz, markiert den Begriff, scrollt zur Mitte und sagt die Stelle an', async () => {
    await openEditor(SCHLAFE)
    const paragraph = await waitFor(() => {
      const el = document.querySelector('p.search-hit-paragraph')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    expect(paragraph.textContent).toContain('schlafe ich schlecht')
    expect(document.querySelector('.search-hit-term')?.textContent).toBe('schlafe')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' })
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(paragraph)
    expect(screen.getByText('Fundstelle in Absatz 2 von 2 hervorgehoben.')).toBeTruthy()
    // Fokus im Textbereich, ohne Textauswahl
    expect(document.activeElement).toBe(screen.getByTestId('editor-scroll'))
  })

  it('speichert durch das Hervorheben nichts', async () => {
    const { unmount } = await openEditor(SCHLAFE)
    await waitFor(() => expect(document.querySelector('.search-hit-term')).not.toBeNull())
    await advance(2500)
    expect(api.review.save).not.toHaveBeenCalled()
    unmount()
    expect(api.review.save).not.toHaveBeenCalled()
  })

  it.each<ViewMode>(['pseudonymized', 'plain'])(
    'markiert einen Treffer im Klarnamen als ganzen Chip (%s), ohne Klarnamen in Attributen',
    async (mode) => {
      await openEditor(
        {
          kind: 'hit',
          paraFrom: 1,
          paraTo: 1,
          ranges: [rangeOf('Fäss')],
          anchor: 'Fäss'
        },
        mode
      )
      const marked = await waitFor(() => {
        const el = document.querySelector('.search-hit-chip')
        expect(el).not.toBeNull()
        return el as HTMLElement
      })
      expect(marked.getAttribute('title')).toBeNull()
      expect(marked.getAttribute('aria-label') ?? '').not.toContain('Fässler')
      if (mode === 'pseudonymized') {
        expect(document.querySelector('p.search-hit-paragraph')?.textContent).not.toContain(
          'Fässler'
        )
      }
    }
  )

  it('meldet eine nicht mehr vorhandene Fundstelle und öffnet oben', async () => {
    await openEditor({
      kind: 'hit',
      paraFrom: 7,
      paraTo: 7,
      ranges: [{ p: 7, s: 0, e: 5 }],
      anchor: 'Kündigung'
    })
    expect((await screen.findAllByText(SEARCH_HIT_GONE_TEXT)).length).toBeGreaterThan(0)
    expect(document.querySelector('.search-hit-paragraph')).toBeNull()
    expect(screen.getByTestId('editor-scroll').scrollTop).toBe(0)
  })

  it('findet die Stelle nach einer Bearbeitung über den Anker wieder', async () => {
    await openEditor({
      kind: 'hit',
      paraFrom: 0,
      paraTo: 0,
      ranges: [{ p: 0, s: 0, e: 7 }],
      anchor: 'schlafe'
    })
    await waitFor(() =>
      expect(document.querySelector('.search-hit-term')?.textContent).toBe('schlafe')
    )
    expect(
      screen.getByText(
        'Fundstelle in Absatz 2 von 2 hervorgehoben, nach einer Bearbeitung wiedergefunden.'
      )
    ).toBeTruthy()
  })

  it('hebt bei einem Treffer im Titel den Titel hervor', async () => {
    await openEditor({ kind: 'title' })
    await waitFor(() => expect(document.querySelector('[data-search-hit="true"]')).not.toBeNull())
    expect(document.querySelector('[data-search-hit="true"]')?.textContent).toContain(
      'Rückfall nach Stellenwechsel'
    )
    expect(screen.getByText('Fundstelle im Titel hervorgehoben.')).toBeTruthy()
  })

  it('hebt bei einem Treffer in der Zusammenfassung das Feld hervor', async () => {
    await openEditor({ kind: 'summary' })
    await waitFor(() =>
      expect(screen.getByText('Fundstelle in der Zusammenfassung hervorgehoben.')).toBeTruthy()
    )
    expect(document.querySelector('.search-hit-field')).not.toBeNull()
  })

  it('entfernt die Markierung beim ersten Scrollen des USERs', async () => {
    await openEditor(SCHLAFE)
    await waitFor(() => expect(document.querySelector('.search-hit-paragraph')).not.toBeNull())
    fireEvent.wheel(screen.getByTestId('editor-scroll'))
    await waitFor(() => expect(document.querySelector('.search-hit-paragraph')).toBeNull())
  })

  it('springt bei einer anderen Fundstelle derselben Sitzung neu, ohne neu zu laden', async () => {
    const { rerender } = await openEditor(SCHLAFE)
    await waitFor(() =>
      expect(document.querySelector('.search-hit-term')?.textContent).toBe('schlafe')
    )
    rerender(
      <ToastProvider>
        <ReviewEditor
          sessionId="s1"
          onBack={onBack}
          focus={{ kind: 'hit', paraFrom: 0, paraTo: 0, anchor: 'Wie geht es' }}
        />
      </ToastProvider>
    )
    await waitFor(() =>
      expect(document.querySelector('p.search-hit-paragraph')?.textContent).toContain('Wie geht es')
    )
    expect(document.querySelector('.search-hit-term')).toBeNull()
    expect(api.review.load).toHaveBeenCalledTimes(1)
  })

  it('Esc, das ein Fenster darüber schon genommen hat, schliesst den Editor nicht', async () => {
    await openEditor(SCHLAFE)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    event.preventDefault()
    window.dispatchEvent(event)
    expect(onBack).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
