import { describe, it, expect } from 'vitest'
import {
  ambiguousDossierNames,
  dossierDistinction,
  dossierLabel,
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
    search: { exclusiveSearchable: 0, recentQueries: 0 },
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

  it.each([
    [{ sessions: 1, pdfs: 0 }, '1 Sitzung, die auch im Dossier Hofer, Maria liegt'],
    [{ sessions: 0, pdfs: 1 }, '1 PDF-Dokument, das auch im Dossier Hofer, Maria liegt'],
    [
      { sessions: 1, pdfs: 1 },
      '1 Sitzung und 1 PDF-Dokument, die auch im Dossier Hofer, Maria liegen'
    ],
    [{ sessions: 3, pdfs: 0 }, '3 Sitzungen, die auch im Dossier Hofer, Maria liegen'],
    [{ sessions: 0, pdfs: 2 }, '2 PDF-Dokumente, die auch im Dossier Hofer, Maria liegen']
  ])('Grammatik der geteilten Inhalte: %o', (counts, text) => {
    const s = summarizeDeletion(preview({ shared: { ...counts, otherDossiers: [ref()] } }))
    expect(s.sections[1].items[0]).toBe(text)
  })

  it('nennt gleichnamige andere Dossiers mit «ID · Geburtsdatum»', () => {
    const other = ref({ id: 'b', externalId: 'P-1001', birthDate: '1985-02-14' })
    const ambiguous = ambiguousDossierNames([ref({ id: 'a' }), other])
    const s = summarizeDeletion(
      preview({ shared: { sessions: 0, pdfs: 1, otherDossiers: [other] } }),
      ambiguous
    )
    expect(s.sections[1].items[0]).toBe(
      '1 PDF-Dokument, das auch im Dossier Hofer, Maria (P-1001 · 14.02.1985) liegt'
    )
  })
})

describe('gleichnamige Dossiers unterscheiden (Sichtprüfung)', () => {
  const a = ref({ id: 'a', externalId: 'P-1001', birthDate: '1985-02-14' })
  const b = ref({ id: 'b', externalId: null, birthDate: '1970-01-01' })
  const c = ref({ id: 'c' })
  const other = ref({ id: 'd', firstName: 'Nina', lastName: 'Keller', externalId: 'P-7' })

  it('erkennt mehrfach vergebene Namen nach der Dublettenregel (Umlaute, Gross/klein)', () => {
    const set = ambiguousDossierNames([
      ref({ id: '1', lastName: 'Müller', firstName: 'Hanna' }),
      ref({ id: '2', lastName: 'MUELLER', firstName: ' hanna ' }),
      other
    ])
    expect(set.size).toBe(1)
    expect(dossierLabel(other, set)).toBe('Keller, Nina')
  })

  it('Zusatz: ID, sonst Geburtsdatum, sonst keiner — nur bei gleichem Namen', () => {
    const set = ambiguousDossierNames([a, b, c, other])
    expect(dossierDistinction(a, set)).toBe('P-1001')
    expect(dossierDistinction(b, set)).toBe('01.01.1970')
    expect(dossierDistinction(c, set)).toBe('')
    expect(dossierDistinction(other, set)).toBe('')
    expect(dossierLabel(a, set)).toBe('Hofer, Maria (P-1001)')
    expect(dossierLabel(b, set)).toBe('Hofer, Maria (01.01.1970)')
    expect(dossierLabel(c, set)).toBe('Hofer, Maria')
    expect(dossierLabel(other, set)).toBe('Keller, Nina')
  })
})
