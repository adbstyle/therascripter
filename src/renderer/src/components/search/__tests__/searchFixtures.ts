import type {
  SearchDocumentResult,
  SearchDossierResult,
  SearchHit,
  SearchQueryResult
} from '../../../../../shared/types/Search'

/** Testdaten der Suche (#209): Dossiers, Dokumente, Fundstellen. */

export const DOSSIER_HOFER_LUKAS: SearchDossierResult = {
  id: 'd-lukas',
  firstName: 'Lukas',
  lastName: 'Hofer',
  externalId: 'PD-1188',
  birthDate: '1978-02-03'
}

export const DOSSIER_HOFER_LUKAS_2: SearchDossierResult = {
  id: 'd-lukas-2',
  firstName: 'Lukas',
  lastName: 'Hofer',
  externalId: 'PD-2001',
  birthDate: '1990-07-12'
}

export function exactHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    field: 'body',
    kind: 'exact',
    label: { speaker: 'Person B', timestamp: '00:14:32' },
    snippet: {
      text: 'seit ich bei Brändli bin, liege ich oft wach',
      marks: [{ start: 13, end: 20 }],
      truncatedStart: true,
      truncatedEnd: true
    },
    focus: {
      kind: 'hit',
      paraFrom: 3,
      paraTo: 3,
      ranges: [{ p: 3, s: 13, e: 20 }],
      anchor: 'Brändli'
    },
    ...overrides
  }
}

export function semanticHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    field: 'body',
    kind: 'semantic',
    label: {},
    snippet: {
      text: 'Ein- und Durchschlafstörungen im Zusammenhang mit beruflicher Überlastung',
      marks: [],
      truncatedStart: false,
      truncatedEnd: true
    },
    focus: { kind: 'hit', paraFrom: 1, paraTo: 2, anchor: 'Ein- und Durchschlafstörungen' },
    ...overrides
  }
}

export function doc(
  sessionId: string,
  overrides: Partial<SearchDocumentResult> = {}
): SearchDocumentResult {
  return {
    sessionId,
    type: 'audio',
    title: `[PERSON 1] Sitzung ${sessionId}`,
    titlePlain: `Lukas Hofer Sitzung ${sessionId}`,
    sortDay: '2026-11-06',
    dossiers: [DOSSIER_HOFER_LUKAS],
    hits: [exactHit()],
    ...overrides
  }
}

export function answer(
  requestId: number,
  overrides: Partial<SearchQueryResult> = {}
): SearchQueryResult {
  return {
    requestId,
    dossiers: [],
    results: [],
    truncated: false,
    semantic: 'complete',
    ...overrides
  }
}

/** Promise, die der Test von aussen auflöst (zweite Stufe, überholte Antworten). */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
