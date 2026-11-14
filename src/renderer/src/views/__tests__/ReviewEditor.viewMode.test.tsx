import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'
import ReviewEditor from '../ReviewEditor'
import { ToastProvider } from '../../contexts/ToastContext'
import {
  getViewModeStore,
  setViewMode,
  _resetViewModeStoreForTests
} from '../../viewMode/viewModeStore'
import type { EntityMap, ReviewData, ViewMode } from '../../../../shared/types'
import type { TipTapDocument } from '../../../../shared/types/TipTapDocument'

/**
 * Issue #203 — the Review Editor in both views, end to end with the real
 * TipTap editor and NodeViews; only the IPC surface is mocked.
 */

const ENTITY_MAP: EntityMap = {
  'person-1': { original: 'Ruth Gerber', placeholder: '[PERSON 1]', type: 'PERSON', source: 'ner' },
  'ort-1': { original: 'Bern', placeholder: '[ORT 1]', type: 'ORT', source: 'ner' }
}

function chip(entityId: string, type: 'PERSON' | 'ORT', number: number, original: string) {
  return {
    type: 'placeholderChip' as const,
    attrs: { entityId, type, number, source: 'ner' as const, original }
  }
}

const DOCUMENT: TipTapDocument = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'speakerLabel', attrs: { speaker: 'A', label: 'Person A' } },
        { type: 'text', text: ' Hallo ' },
        chip('person-1', 'PERSON', 1, 'Ruth Gerber'),
        { type: 'text', text: ' aus ' },
        chip('ort-1', 'ORT', 1, 'Bern'),
        { type: 'text', text: ' und ' },
        chip('person-2', 'PERSON', 2, ''),
        { type: 'text', text: '.' }
      ]
    }
  ]
}

function reviewData(): ReviewData {
  return {
    document: structuredClone(DOCUMENT),
    entityMap: structuredClone(ENTITY_MAP),
    sessionType: 'audio',
    sessionTitle: 'Gespräch mit [PERSON 1]',
    titleSnapshot: { '[PERSON 1]': 'Ruth Gerber' },
    processedWithModels: null,
    reviewAt: null,
    audioStats: null
  }
}

let api: ReturnType<typeof makeApi>

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
      get: vi.fn().mockResolvedValue({
        title: 'Gespräch mit [PERSON 1]',
        text: '[PERSON 1] aus [ORT 1] erzählt.',
        modelId: 'gemma',
        summarizedAt: null,
        titleSnapshot: { '[PERSON 1]': 'Ruth Gerber' },
        textSnapshot: { '[PERSON 1]': 'Ruth Gerber', '[ORT 1]': 'Bern' }
      }),
      updateTitle: vi.fn().mockResolvedValue(null),
      updateText: vi.fn().mockResolvedValue(null),
      missingReason: vi.fn().mockResolvedValue(null),
      regenerate: vi.fn().mockResolvedValue(true),
      onChanged: vi.fn(() => () => {})
    },
    tasks: { onCompleted: vi.fn(() => () => {}) },
    blocklist: { add: vi.fn(), delete: vi.fn() },
    sessions: { delete: vi.fn() }
  }
}

async function openEditor(initial: ViewMode) {
  api = makeApi(initial)
  window.api = api as unknown as typeof window.api
  _resetViewModeStoreForTests()
  const utils = render(
    <ToastProvider>
      <ReviewEditor sessionId="s1" onBack={() => {}} />
    </ToastProvider>
  )
  await screen.findByText(/erzählt\./)
  return utils
}

/** Runs every debounce/autosave stage, letting React re-render in between. */
async function settleAutosave(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      vi.advanceTimersByTime(2500)
    })
  }
}

function editorElement(): HTMLElement {
  return document.querySelector('.ProseMirror') as HTMLElement
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  _resetViewModeStoreForTests()
})

describe('ReviewEditor — Klartext view (#203)', () => {
  it('opens directly in the saved Klartext view, read-only, without chips (AK 3, 6, 7, 8, 12)', async () => {
    await openEditor('plain')

    const editor = editorElement()
    expect(editor).toHaveAttribute('contenteditable', 'false')
    expect(editor.textContent).toContain('Hallo Ruth Gerber aus Bern und [PERSON 2].')
    // no chip styling, no menu trigger, no hidden token for screen readers (AK 14)
    expect(screen.queryByRole('button', { name: /Aktionen verfügbar/ })).toBeNull()
    expect(editor.textContent).not.toContain('[PERSON 1]')
  })

  it('shows title and summary resolved and read-only (AK 4, 8)', async () => {
    await openEditor('plain')

    const title = screen.getByRole('heading', { name: 'Gespräch mit Ruth Gerber' })
    expect(title).not.toHaveAttribute('contenteditable')
    const summary = screen.getByText('Ruth Gerber aus Bern erzählt.')
    expect(summary).not.toHaveAttribute('contenteditable')
  })

  it('the copy button names and copies the Klartext (AK 2, 9)', async () => {
    await openEditor('plain')

    fireEvent.click(screen.getByRole('button', { name: 'Klartext kopieren' }))
    await waitFor(() => expect(api.review.exportClipboard).toHaveBeenCalled())
    expect(api.review.exportClipboard).toHaveBeenCalledWith(
      '[Person A]: Hallo Ruth Gerber aus Bern und [PERSON 2].'
    )
  })

  it('hides the side panel actions that change the session (AK 8)', async () => {
    await openEditor('plain')
    expect(screen.queryByRole('button', { name: /rückgängig machen/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Weitere Aktionen/ })).toBeNull()
  })
})

describe('ReviewEditor — pseudonymized view (#203)', () => {
  it('shows chips, editable title and the pseudonymized copy (AK 2, 9, 11)', async () => {
    await openEditor('pseudonymized')

    expect(editorElement()).toHaveAttribute('contenteditable', 'true')
    expect(screen.getAllByRole('button', { name: /Aktionen verfügbar/ })).toHaveLength(3)
    expect(editorElement().textContent).not.toContain('Ruth Gerber')
    expect(screen.getByRole('heading', { name: 'Titel bearbeiten' })).toHaveTextContent(
      'Gespräch mit [PERSON 1]'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Pseudonymisiert kopieren' }))
    await waitFor(() => expect(api.review.exportClipboard).toHaveBeenCalled())
    expect(api.review.exportClipboard).toHaveBeenCalledWith(
      '[Person A]: Hallo [PERSON 1] aus [ORT 1] und [PERSON 2].'
    )
  })

  it('switches without changing or saving the session (AK 13, Postcondition 1)', async () => {
    await openEditor('pseudonymized')
    // Let the load's own autosave run out first: setContent's update →
    // 250 ms counter debounce → re-render → 2 s autosave timer
    await settleAutosave()
    await waitFor(() => expect(api.review.save).toHaveBeenCalled())
    const savesBefore = api.review.save.mock.calls.length

    act(() => setViewMode('plain'))
    expect(editorElement()).toHaveAttribute('contenteditable', 'false')
    expect(editorElement().textContent).toContain('Hallo Ruth Gerber aus Bern')
    expect(screen.getByRole('button', { name: 'Klartext kopieren' })).toBeInTheDocument()

    act(() => setViewMode('pseudonymized'))
    expect(editorElement()).toHaveAttribute('contenteditable', 'true')
    expect(screen.getAllByRole('button', { name: /Aktionen verfügbar/ })).toHaveLength(3)

    await settleAutosave()
    expect(api.review.save.mock.calls.length).toBe(savesBefore)
    expect(getViewModeStore().get()).toBe('pseudonymized')
    expect(api.viewMode.set).toHaveBeenNthCalledWith(1, 'plain')
    expect(api.viewMode.set).toHaveBeenNthCalledWith(2, 'pseudonymized')
  })
})
