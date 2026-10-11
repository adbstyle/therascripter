import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import RecordingBar from '../shell/RecordingBar'
import { createValueStore } from '../../utils/valueStore'

describe('RecordingBar', () => {
  it('rendert Status-Text und formatierten Timer', () => {
    render(<RecordingBar duration={createValueStore(3661)} onOpenRecording={() => {}} />)
    expect(screen.getByText('Aufnahme läuft')).toBeInTheDocument()
    expect(screen.getByText('01:01:01')).toBeInTheDocument()
    expect(screen.getByText('Zur Aufnahme')).toBeInTheDocument()
  })

  it('aktualisiert den Timer aus dem Store', () => {
    const duration = createValueStore(59)
    render(<RecordingBar duration={duration} onOpenRecording={() => {}} />)

    act(() => duration.set(60))
    expect(screen.getByText('00:01:00')).toBeInTheDocument()
  })

  it('feuert onOpenRecording beim Klick auf die Leiste', async () => {
    const user = userEvent.setup()
    const onOpenRecording = vi.fn()
    render(<RecordingBar duration={createValueStore(0)} onOpenRecording={onOpenRecording} />)

    await user.click(screen.getByLabelText('Zur laufenden Aufnahme wechseln'))
    expect(onOpenRecording).toHaveBeenCalledTimes(1)
  })
})
