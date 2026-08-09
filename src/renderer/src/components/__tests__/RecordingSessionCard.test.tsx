import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecordingSessionCard } from '../RecordingSessionCard'
import type { Session } from '../../../../shared/types'

const session: Session = {
  id: 'rec-1',
  title: 'Aufnahme 07.08.2026 14:02',
  type: 'audio',
  status: 'recording',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
} as Session

const defaultLive = { duration: 0, level: 0, onStop: () => {} }

describe('RecordingSessionCard', () => {
  it('rendert Titel und REC-Indikator', () => {
    render(<RecordingSessionCard session={session} live={defaultLive} />)
    expect(screen.getByText('Aufnahme 07.08.2026 14:02')).toBeInTheDocument()
    expect(screen.getByText('REC')).toBeInTheDocument()
  })

  it('rendert den formatierten Live-Timer', () => {
    render(<RecordingSessionCard session={session} live={{ ...defaultLive, duration: 3661 }} />)
    expect(screen.getByText('01:01:01')).toBeInTheDocument()
    expect(screen.getByLabelText('Aufnahmedauer 01:01:01')).toBeInTheDocument()
  })

  it('zeigt den Auto-Stop-Countdown', () => {
    render(<RecordingSessionCard session={session} live={{ ...defaultLive, duration: 60 }} />)
    // 7200 - 60 = 7140 s = 01:59:00
    expect(screen.getByText('Auto-Stop nach 01:59:00')).toBeInTheDocument()
  })

  it('feuert onStop beim Klick auf den Stop-Button', async () => {
    const user = userEvent.setup()
    const onStop = vi.fn()
    render(<RecordingSessionCard session={session} live={{ ...defaultLive, onStop }} />)

    await user.click(screen.getByLabelText('Aufnahme stoppen'))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('bietet keinen Lösch-Button an', () => {
    render(<RecordingSessionCard session={session} live={defaultLive} />)
    expect(screen.queryByLabelText('Transkription löschen')).not.toBeInTheDocument()
  })

  it('zeigt Fallback-Titel bei leerem Titel', () => {
    render(<RecordingSessionCard session={{ ...session, title: '' }} live={defaultLive} />)
    expect(screen.getByText('Unbenannte Transkription')).toBeInTheDocument()
  })
})
