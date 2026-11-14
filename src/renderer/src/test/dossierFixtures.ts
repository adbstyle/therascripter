import type { Dossier, DossierDeletePreview, DossierListItem } from '../../../shared/types/Dossier'

/** Vollständiges Dossier mit neutralen Werten für Renderer-Tests (#204). */
export function makeDossier(overrides: Partial<Dossier> = {}): Dossier {
  return {
    id: 'd1',
    firstName: 'Lukas',
    lastName: 'Hofer',
    externalId: 'PD-1188',
    birthDate: '1978-02-03',
    diagnoses: 'F32.1 Mittelgradige depressive Episode',
    medication: 'Sertralin 50 mg, morgens',
    note: 'Termine dienstags.',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...overrides
  }
}

export function makeDossierListItem(overrides: Partial<DossierListItem> = {}): DossierListItem {
  return {
    id: 'd1',
    firstName: 'Lukas',
    lastName: 'Hofer',
    externalId: 'PD-1188',
    birthDate: '1978-02-03',
    entryCount: 0,
    lastEntryDay: null,
    ...overrides
  }
}

export function makeDeletePreview(
  overrides: Partial<DossierDeletePreview> = {}
): DossierDeletePreview {
  return {
    dossierId: 'd1',
    displayName: 'Lukas Hofer',
    exclusive: { sessions: 0, pdfs: 0 },
    shared: { sessions: 0, pdfs: 0, otherDossiers: [] },
    blockedByRecording: false,
    fingerprint: 'fp-1',
    ...overrides
  }
}
