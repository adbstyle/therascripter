import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RecordingBar from '../shell/RecordingBar'

describe('RecordingBar', () => {
  it('rendert Status-Text und formatierten Timer', () => {
    render(<RecordingBar duration={3661} onOpenRecording={() => {}} />)
    expect(screen.getByText('Aufnahme läuft')).toBeInTheDocument()
    expect(screen.getByText('01:01:01')).toBeInTheDocument()
    expect(screen.getByText('Zur Aufnahme')).toBeInTheDocument()
  })

  it('feuert onOpenRecording beim Klick auf die Leiste', async () => {
    const user = userEvent.setup()
    const onOpenRecording = vi.fn()
    render(<RecordingBar duration={0} onOpenRecording={onOpenRecording} />)

    await user.click(screen.getByLabelText('Zur laufenden Aufnahme wechseln'))
    expect(onOpenRecording).toHaveBeenCalledTimes(1)
  })
})
