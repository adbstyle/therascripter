import type {
  Dossier,
  DossierDeletePreview,
  DossierListItem,
  DossierRef,
  TimelineEntry
} from '../../../shared/types/Dossier'

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
    createdAt: '2026-11-01T10:00:00.000Z',
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
    search: { exclusiveSearchable: 0, recentQueries: 0 },
    blockedByRecording: false,
    fingerprint: 'fp-1',
    ...overrides
  }
}

/** Verlaufseintrag (#205) — eine Sitzung mit `sortDay` und ihren Dossiers. */
export function makeTimelineEntry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  const now = '2026-11-10T09:00:00.000Z'
  return {
    id: 'e1',
    title: 'Erstgespräch',
    type: 'audio',
    status: 'review',
    audioPath: null,
    transcriptPath: null,
    anonymizedPath: null,
    diarizationPath: null,
    alignedTranscriptPath: null,
    pdfPath: null,
    extractedPath: null,
    entityMap: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    reviewAt: now,
    wordCount: 1200,
    anonymizationCount: 3,
    summary: 'Klient berichtet über Schlafprobleme.',
    summaryModelId: null,
    summarizedAt: null,
    plannedSteps: null,
    retryCount: 0,
    pdfHasScannedPages: null,
    processedWithModels: null,
    titlePlain: 'Erstgespräch',
    summaryPlain: 'Klient berichtet über Schlafprobleme.',
    documentDate: null,
    dossiers: [makeDossierRef()],
    sortDay: '2026-11-10',
    ...overrides
  }
}

export function makeDossierRef(overrides: Partial<DossierRef> = {}): DossierRef {
  return {
    id: 'd1',
    firstName: 'Lukas',
    lastName: 'Hofer',
    externalId: 'PD-1188',
    birthDate: '1978-02-03',
    ...overrides
  }
}
