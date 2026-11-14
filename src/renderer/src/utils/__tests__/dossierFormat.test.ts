import { describe, it, expect } from 'vitest'
import {
  dossierIdentification,
  duplicateNameText,
  entryCountLabel,
  lastEntryLabel
} from '../dossierFormat'
import { summarizeDeletion } from '../dossierDeletion'
import type { DossierDeletePreview, DossierRef } from '../../../../shared/types/Dossier'

const ref = (over: Partial<DossierRef> = {}): DossierRef => ({
  id: 'x',
  firstName: 'Maria',
  lastName: 'Hofer',
  externalId: null,
  birthDate: null,
  ...over
})

describe('dossierFormat', () => {
  it('nennt ID und Geburtsdatum zur Unterscheidung', () => {
    expect(dossierIdentification(ref({ externalId: 'PD-1', birthDate: '1978-02-03' }))).toBe(
      'PD-1 · 03.02.1978'
    )
    expect(dossierIdentification(ref({ birthDate: '1978-02-03' }))).toBe('03.02.1978')
    expect(dossierIdentification(ref())).toBe('')
  })

  it('zählt Einträge', () => {
    expect(entryCountLabel(0)).toBe('Keine Einträge')
    expect(entryCountLabel(1)).toBe('1 Eintrag')
    expect(entryCountLabel(9)).toBe('9 Einträge')
  })

  it('beschreibt den letzten Eintrag relativ zu heute', () => {
    expect(lastEntryLabel(null, '2026-11-14')).toBe('—')
    expect(lastEntryLabel('2026-11-14', '2026-11-14')).toBe('Heute')
    expect(lastEntryLabel('2026-11-13', '2026-11-14')).toBe('Gestern')
    expect(lastEntryLabel('2025-12-31', '2026-01-01')).toBe('Gestern')
    expect(lastEntryLabel('2026-11-05', '2026-11-14')).toBe('05.11.')
    expect(lastEntryLabel('2025-11-05', '2026-11-14')).toBe('05.11.2025')
  })

  it('formuliert den Hinweis auf gleiche Namen', () => {
    expect(duplicateNameText([ref({ externalId: 'PD-0412', birthDate: '1969-06-11' })])).toBe(
      'Es gibt bereits ein Patientendossier mit diesem Namen (PD-0412 · 11.06.1969).'
    )
    expect(duplicateNameText([ref(), ref({ externalId: 'PD-2' })])).toBe(
      'Es gibt bereits 2 Patientendossiers mit diesem Namen (PD-2).'
    )
    expect(duplicateNameText([ref()])).toBe(
      'Es gibt bereits ein Patientendossier mit diesem Namen.'
    )
  })
})

function preview(over: Partial<DossierDeletePreview> = {}): DossierDeletePreview {
  return {
    dossierId: 'd1',
    displayName: 'Lukas Hofer',
    exclusive: { sessions: 0, pdfs: 0 },
    shared: { sessions: 0, pdfs: 0, otherDossiers: [] },
    blockedByRecording: false,
    fingerprint: 'f',
    ...over
  }
}

describe('summarizeDeletion (#204 AK 17, #207 AK 1)', () => {
  it('nennt ohne Inhalte nur die Angaben des Dossiers', () => {
    const s = summarizeDeletion(preview())
    expect(s.title).toBe('Patientendossier Lukas Hofer löschen?')
    expect(s.sections).toEqual([
      { heading: 'Gelöscht werden:', items: ['Stammdaten, Diagnosen, Medikation und Notiz'] }
    ])
    expect(s.confirmLabel).toBe('Dossier löschen')
  })

  it('zählt mitgelöschte und erhaltene Sitzungen und PDF-Dokumente', () => {
    const s = summarizeDeletion(
      preview({
        exclusive: { sessions: 6, pdfs: 2 },
        shared: { sessions: 1, pdfs: 0, otherDossiers: [ref()] }
      })
    )
    expect(s.sections).toEqual([
      {
        heading: 'Gelöscht werden:',
        items: [
          '6 Sitzungen und 2 PDF-Dokumente samt Text und Zusammenfassung',
          'Stammdaten, Diagnosen, Medikation und Notiz'
        ]
      },
      {
        heading: 'Erhalten bleiben:',
        items: ['1 Sitzung, die auch im Dossier Hofer, Maria liegt', 'Einträge in der Sperrliste']
      }
    ])
    expect(s.confirmLabel).toBe('Dossier und 8 Inhalte löschen')
  })

  it('kürzt viele andere Dossiers auf drei Namen', () => {
    const others = ['A', 'B', 'C', 'D', 'E'].map((n) => ref({ lastName: n, firstName: 'X' }))
    const s = summarizeDeletion(
      preview({
        exclusive: { sessions: 0, pdfs: 1 },
        shared: { sessions: 0, pdfs: 2, otherDossiers: others }
      })
    )
    expect(s.sections[1].items[0]).toBe(
      '2 PDF-Dokumente, die auch in den Dossiers A, X; B, X; C, X und 2 weiteren liegen'
    )
    expect(s.confirmLabel).toBe('Dossier und 1 Inhalt löschen')
  })

  it('verbindet zwei Dossiers mit «und»', () => {
    const s = summarizeDeletion(
      preview({
        shared: {
          sessions: 2,
          pdfs: 0,
          otherDossiers: [ref(), ref({ firstName: 'Nina', lastName: 'Keller' })]
        }
      })
    )
    expect(s.sections[1].items[0]).toBe(
      '2 Sitzungen, die auch in den Dossiers Hofer, Maria und Keller, Nina liegen'
    )
    expect(s.message).toBe('Das Patientendossier wird endgültig entfernt.')
  })
})
