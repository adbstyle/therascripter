import { describe, it, expect } from 'vitest'
import { sessionDeletionDetails, type SessionDeletionInput } from '../sessionDeletionDetails'

function input(overrides: Partial<SessionDeletionInput>): SessionDeletionInput {
  return {
    type: 'audio',
    audioPath: null,
    pdfPath: null,
    transcriptPath: null,
    diarizationPath: null,
    alignedTranscriptPath: null,
    extractedPath: null,
    anonymizedPath: null,
    summary: null,
    ...overrides
  }
}

// Issue #202, AK 3: the dialog names exactly what exists for this session.
describe('sessionDeletionDetails', () => {
  it('processed audio session within 24 h: recording, transcript, pseudonymization, summary', () => {
    expect(
      sessionDeletionDetails(
        input({
          audioPath: '/a.wav',
          transcriptPath: '/t.json',
          diarizationPath: '/d.json',
          alignedTranscriptPath: '/al.json',
          anonymizedPath: '/an.json',
          summary: 'Zusammenfassung'
        })
      )
    ).toEqual([
      'Audioaufnahme',
      'Transkript inklusive Ihrer Bearbeitungen',
      'Pseudonymisierung samt den Originaltexten aller Platzhalter',
      'Zwischenergebnisse der Verarbeitung',
      'Titel und Zusammenfassung'
    ])
  })

  it('processed audio session after the 24-hour cleanup no longer mentions the recording', () => {
    const details = sessionDeletionDetails(
      input({ transcriptPath: '/t.json', anonymizedPath: '/an.json' })
    )
    expect(details).not.toContain('Audioaufnahme')
    expect(details).toContain('Transkript inklusive Ihrer Bearbeitungen')
    expect(details.at(-1)).toBe('Titel')
  })

  it('processed PDF document: original PDF only while it still exists', () => {
    expect(
      sessionDeletionDetails(
        input({
          type: 'pdf',
          pdfPath: '/x.pdf',
          extractedPath: '/e.json',
          anonymizedPath: '/an.json',
          summary: '  '
        })
      )
    ).toEqual([
      'Original-PDF',
      'Text des PDF-Dokuments inklusive Ihrer Bearbeitungen',
      'Pseudonymisierung samt den Originaltexten aller Platzhalter',
      'Zwischenergebnisse der Verarbeitung',
      'Titel'
    ])
  })

  it('failed session: recording and intermediate results, no transcript or pseudonymization', () => {
    expect(
      sessionDeletionDetails(input({ audioPath: '/a.wav', diarizationPath: '/d.json' }))
    ).toEqual(['Audioaufnahme', 'Zwischenergebnisse der Verarbeitung', 'Titel'])
  })

  it('never mentions the blocklist or backups (Out of Scope 5/6)', () => {
    const all = sessionDeletionDetails(
      input({ audioPath: '/a', anonymizedPath: '/b', transcriptPath: '/c', summary: 'x' })
    ).join(' ')
    expect(all).not.toMatch(/Sperrliste|Backup|Time Machine/i)
  })

  it('names the search data once the session was processed (Epic #192, EK 22)', () => {
    const processed = sessionDeletionDetails(
      input({ anonymizedPath: '/an.json', reviewAt: '2026-11-01T10:00:00.000Z' })
    )
    expect(processed).toContain('Für die Suche aufbereitete Texte')
    expect(processed.at(-1)).toBe('Titel')

    const stillProcessing = sessionDeletionDetails(input({ audioPath: '/a.wav', reviewAt: null }))
    expect(stillProcessing).not.toContain('Für die Suche aufbereitete Texte')
  })
})
