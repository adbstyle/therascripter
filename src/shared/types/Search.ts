import type { SessionType } from './Session'
import type { DossierRef } from './Dossier'

/**
 * Suche (Epic #192 — #209, #211). Typen für Main und Renderer.
 *
 * Ausschnitte und Anker stehen immer im Klartext: indexiert ist nur der
 * Klartext (Chips mit ihrem Original), Platzhalter sind pro Sitzung nummeriert
 * und als Suchbegriff sinnlos (Epic OOS 9).
 */

/** Suche über alle Inhalte oder nur in einem Patientendossier (#211). */
export type SearchScope = { kind: 'all' } | { kind: 'dossier'; dossierId: string }

export interface SearchQueryInput {
  /** Vom Renderer vergeben; veraltete Antworten werden daran verworfen. */
  requestId: number
  query: string
  scope: SearchScope
}

/** Feld einer Sitzung, in dem ein Treffer liegt (#209 AK 5). */
export type SearchField = 'title' | 'summary' | 'body'

/** Treffer über die exakte Suche oder nach Bedeutung (ab PR S4). */
export type SearchHitKind = 'exact' | 'semantic'

/** Bereich `[start, end)` in einem Text (UTF-16-Einheiten). */
export interface SearchMark {
  start: number
  end: number
}

export interface SearchSnippet {
  /** Klartext-Ausschnitt (#209 AK 9). */
  text: string
  /** Exakte Treffer im Ausschnitt; leer bei Treffern nach Bedeutung. */
  marks: SearchMark[]
  /** Der Ausschnitt beginnt bzw. endet mitten im Abschnitt («…» anzeigen). */
  truncatedStart: boolean
  truncatedEnd: boolean
}

/**
 * Bereich im Klartext eines Absatzes `p` des TipTap-Dokuments: Text zählt mit
 * seiner Länge, ein Chip mit der Länge seines `original` (ohne Original mit
 * seinem Platzhalter-Token), Sprecher- und Zeit-Knoten zählen nicht.
 */
export interface SearchParagraphRange {
  p: number
  s: number
  e: number
}

/**
 * Wohin «zur Fundstelle springen» führt (#209 AK 11). PR S5 übernimmt das in
 * `SessionFocus` der Navigation.
 */
export type SearchFocus =
  | { kind: 'title' }
  | { kind: 'summary' }
  | {
      kind: 'hit'
      /** Absätze des Abschnitts (Indizes in `doc.content`), als ganze hinterlegt. */
      paraFrom: number
      paraTo: number
      /** Exakte Wörter zum Markieren; fehlt bei Treffern nach Bedeutung. */
      ranges?: SearchParagraphRange[]
      /**
       * Text, an dem die Stelle nach einer Bearbeitung wiedergefunden wird:
       * das erste exakte Wort bzw. der Anfang der Unit.
       */
      anchor: string
    }

export interface SearchHit {
  field: SearchField
  kind: SearchHitKind
  /** Sprecher und Zeitmarke der Unit, sofern vorhanden (PDFs: keine). */
  label: { speaker?: string; timestamp?: string }
  snippet: SearchSnippet
  focus: SearchFocus
}

/** Eine Sitzung bzw. ein PDF-Dokument mit Treffern (#209 AK 7, AK 9). */
export interface SearchDocumentResult {
  sessionId: string
  type: SessionType
  /** Titel, wie gespeichert (pseudonymisiert, sofern er Platzhalter trägt). */
  title: string
  /** Titel im Klartext — der Renderer wählt nach der Ansicht. */
  titlePlain: string
  /** Tag im Verlauf (`YYYY-MM-DD`): Dokumentdatum bei PDFs, sonst Aufnahmetag. */
  sortDay: string
  dossiers: DossierRef[]
  /** Bis zu SEARCH_MAX_HITS_PER_DOCUMENT Fundstellen, die passendste zuerst. */
  hits: SearchHit[]
}

/** Gefundenes Patientendossier (#209 AK 23–26): ID · Geburtsdatum unterscheiden. */
export type SearchDossierResult = DossierRef

/**
 * Warum die Suche nach Bedeutung gerade nicht geht (PR S4):
 * - processing: eine Verarbeitung läuft oder steht an (#209 AK 18)
 * - model-missing: das Suchmodell ist (noch) nicht installiert
 * - tool-blocked: macOS hat das Python-Werkzeug blockiert (#168)
 * - error: der Suchprozess ist abgestürzt bzw. liess sich nicht starten;
 *   ein neuer Versuch folgt nach kurzer Pause von selbst
 */
export type SearchUnavailableReason = 'processing' | 'model-missing' | 'tool-blocked' | 'error'

/**
 * Stand der Suche nach Bedeutung in einer Antwort.
 * - pending (`search:query`): sie folgt — der Renderer ruft `search:semantic`
 * - complete (`search:semantic`): `results` enthält exakte und Treffer nach Bedeutung
 * - superseded (`search:semantic`): eine neuere Anfrage desselben Fensters hat
 *   diese abgelöst; die Antwort enthält nur die exakten Treffer
 * - sonst: nicht verfügbar, `results` enthält nur die exakten Treffer
 */
export type SemanticSearchStatus =
  | 'pending'
  | 'complete'
  | 'superseded'
  | 'unavailable-processing'
  | 'model-missing'
  | 'tool-blocked'
  | 'error'

/** Zustand des Suchprozesses (Worker) — `search:warmup` und `search:processStateChanged`. */
export type SearchProcessPhase = 'stopped' | 'starting' | 'ready' | 'busy' | 'stopping'

export interface SearchProcessState {
  phase: SearchProcessPhase
  /** null = die Suche nach Bedeutung ist möglich (der Prozess startet bei Bedarf). */
  reason: SearchUnavailableReason | null
}

export interface SearchQueryResult {
  requestId: number
  /** Getrennt und vor den Inhalten anzeigen (#209 AK 24). */
  dossiers: SearchDossierResult[]
  results: SearchDocumentResult[]
  /** true, wenn mehr Sitzungen getroffen wurden als SEARCH_MAX_DOCUMENT_RESULTS. */
  truncated: boolean
  semantic: SemanticSearchStatus
}

/** Eine der fünf letzten Suchanfragen (#209 AK 27). */
export interface RecentSearchQuery {
  query: string
  usedAt: string
}
