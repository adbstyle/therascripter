import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ReconcileEventsBanner from '../ReconcileEventsBanner'
import type { ReconcileEvent } from '../../../../../shared/types/ReconcileEvent'

const event = (over: Partial<ReconcileEvent>): ReconcileEvent => ({
  id: 'e1',
  timestamp: '2026-10-11T09:45:00.000Z',
  group: 'summarization',
  fromModelId: 'gemma-summarization',
  toModelId: null,
  reason: 'model-retired',
  status: 'pending',
  ...over
})

describe('ReconcileEventsBanner', () => {
  it('names a retired model by its label, not its catalog id', () => {
    render(
      <ReconcileEventsBanner
        events={[event({ fromLabel: 'Gemma 3 4B Instruct', toLabel: null })]}
        onDismiss={vi.fn()}
      />
    )

    expect(screen.getByText('Gemma 3 4B Instruct')).toBeInTheDocument()
    expect(screen.queryByText('gemma-summarization')).not.toBeInTheDocument()
    expect(screen.getByText(/wird nicht mehr unterstützt/)).toBeInTheDocument()
  })

  it('falls back to the id for events persisted without labels', () => {
    render(
      <ReconcileEventsBanner events={[event({ reason: 'group-cleared' })]} onDismiss={vi.fn()} />
    )

    expect(screen.getByText('gemma-summarization')).toBeInTheDocument()
  })
})
