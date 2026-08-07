import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { useSelectionToolbar } from '../useSelectionToolbar'
import { createTestEditor, type TestEditorHandle } from '../../../../test-support/createTestEditor'

const TRIGGER_DELAY_MS = 150

let handle: TestEditorHandle | null = null

beforeEach(() => {
  // jsdom's Selection / Range stack does not produce real bounding rects.
  // Stub `window.getSelection` to always hand back a single-range Selection
  // with a usable rect so the hook's DOM-rect branch can be exercised.
  vi.spyOn(window, 'getSelection').mockImplementation(
    () =>
      ({
        rangeCount: 1,
        getRangeAt: () =>
          ({
            getBoundingClientRect: () => new DOMRect(100, 100, 50, 18)
          }) as unknown as Range
      }) as unknown as Selection
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  handle?.destroy()
  handle = null
})

// (vi.restoreAllMocks via the earlier afterEach guards the getSelection stub.)

interface RunOpts {
  enabled?: boolean
}

function run(opts: RunOpts = {}) {
  const editor = handle!.editor
  const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => {
    return <>{children}</>
  }
  const result = renderHook(
    () => {
      const containerRef = useRef<HTMLElement | null>(null)
      const sel = useSelectionToolbar({
        editor,
        enabled: opts.enabled ?? true,
        containerRef
      })
      return sel
    },
    { wrapper }
  )
  return result
}

function fireMouseUp(): void {
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
}

function flushTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, TRIGGER_DELAY_MS + 20))
}

describe('useSelectionToolbar', () => {
  it('returns null when selection is empty', async () => {
    handle = createTestEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hallo Welt' }] }]
    })
    handle.editor.commands.setTextSelection({ from: 1, to: 1 })

    const { result } = run()
    act(() => fireMouseUp())
    await act(async () => {
      await flushTimers()
    })

    expect(result.current.state).toBeNull()
  })

  it('returns an anchor when text is selected', async () => {
    handle = createTestEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hallo Welt' }] }]
    })
    handle.editor.commands.setTextSelection({ from: 1, to: 6 })

    const { result } = run()
    act(() => fireMouseUp())
    await act(async () => {
      await flushTimers()
    })

    expect(result.current.state).not.toBeNull()
    expect(result.current.state?.multiChipSelectionOnly).toBe(false)
  })

  it('returns null when selection is whitespace-only', async () => {
    handle = createTestEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a    b' }] }]
    })
    handle.editor.commands.setTextSelection({ from: 2, to: 6 }) // the four spaces

    const { result } = run()
    act(() => fireMouseUp())
    await act(async () => {
      await flushTimers()
    })

    expect(result.current.state).toBeNull()
  })

  it('reports multiChipSelectionOnly when selection covers ≥2 chips with no text', async () => {
    handle = createTestEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'p1',
                type: 'PERSON',
                number: 1,
                source: 'manual',
                original: 'A'
              }
            },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'p2',
                type: 'PERSON',
                number: 2,
                source: 'manual',
                original: 'B'
              }
            }
          ]
        }
      ]
    })
    handle.editor.commands.setTextSelection({ from: 1, to: 3 })

    const { result } = run()
    act(() => fireMouseUp())
    await act(async () => {
      await flushTimers()
    })

    expect(result.current.state).not.toBeNull()
    expect(result.current.state?.multiChipSelectionOnly).toBe(true)
  })

  it('returns null when selection is entirely inside a single chip (chip menu owns it)', async () => {
    handle = createTestEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'p1',
                type: 'PERSON',
                number: 1,
                source: 'manual',
                original: 'A'
              }
            }
          ]
        }
      ]
    })
    handle.editor.commands.setTextSelection({ from: 1, to: 2 })

    const { result } = run()
    act(() => fireMouseUp())
    await act(async () => {
      await flushTimers()
    })

    expect(result.current.state).toBeNull()
  })

  it('stays hidden when enabled is false', async () => {
    handle = createTestEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hallo Welt' }] }]
    })
    handle.editor.commands.setTextSelection({ from: 1, to: 6 })

    const { result } = run({ enabled: false })
    act(() => fireMouseUp())
    await act(async () => {
      await flushTimers()
    })

    expect(result.current.state).toBeNull()
  })

  it('hide() clears the state', async () => {
    handle = createTestEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hallo Welt' }] }]
    })
    handle.editor.commands.setTextSelection({ from: 1, to: 6 })

    const { result } = run()
    act(() => fireMouseUp())
    await act(async () => {
      await flushTimers()
    })
    expect(result.current.state).not.toBeNull()

    act(() => result.current.hide())
    expect(result.current.state).toBeNull()
  })
})
