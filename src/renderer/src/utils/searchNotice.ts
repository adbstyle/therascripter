import type {
  SearchAvailability,
  SemanticAvailability,
  SemanticSearchStatus
} from '../../../shared/types/Search'
import { SEARCH_MODEL_PENDING_TEXT } from '../../../shared/search-model-texts'
import { describeSearchModel } from './searchModelStatus'

/**
 * Hinweis, warum die Suche nach Bedeutung gerade nicht mitsucht (#209 AK 18,
 * #210 AK 4/5). Die exakte Suche und die Dossier-Treffer gehen immer — das
 * sagt jeder Hinweis dazu.
 */

export const EXACT_SEARCH_STILL_WORKS =
  'Genaue Begriffe, Klarnamen und Patientendossiers finden Sie schon jetzt.'

/** #209 AK 18: Text während einer Verarbeitung. */
export const SEARCH_PROCESSING_TEXT =
  'Die Suche nach Bedeutung ist verfügbar, sobald die Verarbeitung abgeschlossen ist.'

export const SEARCH_TOOL_BLOCKED_TEXT =
  'macOS hat ein Werkzeug von Therascript blockiert, das die Suche nach Bedeutung braucht. Folgen Sie dem Hinweis oben in der App.'

export const SEARCH_ERROR_TEXT =
  'Die Suche nach Bedeutung ist unerwartet abgebrochen. Therascript versucht es gleich von selbst erneut.'

export interface SemanticNotice {
  tone: 'info' | 'error'
  title: string
  text: string
  /** Download-Fortschritt des Suchmodells in Prozent. */
  progress?: number
  /** «Erneut versuchen»: Suchmodell laden bzw. Suche nach Bedeutung wiederholen. */
  action?: 'retry-model' | 'retry-semantic'
}

type UnavailableReason = Exclude<SemanticAvailability, 'ready' | 'loading'>

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  'unavailable-processing',
  'model-missing',
  'tool-blocked',
  'error'
])

function reasonOf(value: string | null | undefined): UnavailableReason | null {
  return value && UNAVAILABLE_REASONS.has(value) ? (value as UnavailableReason) : null
}

/**
 * Der aktuelle Stand (`availability`, live) geht vor dem Stand der letzten
 * Antwort (`status`): so verschwindet der Hinweis, sobald die Suche nach
 * Bedeutung wieder geht, und erscheint, sobald eine Verarbeitung beginnt.
 * Abbruch (`error`) und Blockade der letzten Antwort bleiben sichtbar.
 */
export function semanticNotice(
  availability: SearchAvailability | null,
  status: SemanticSearchStatus | null
): SemanticNotice | null {
  const live = availability ? reasonOf(availability.semantic) : null
  // Verarbeitung bzw. fehlendes Modell sagt der Live-Stand zuverlässiger; ist
  // er wieder «bereit», holt die Suche die Bedeutung ohnehin nach. Ein Abbruch
  // oder eine Blockade betrifft dagegen genau diese Antwort.
  const answerReason = reasonOf(status)
  const fromAnswer =
    availability && (answerReason === 'unavailable-processing' || answerReason === 'model-missing')
      ? null
      : answerReason
  const reason = live ?? fromAnswer
  if (!reason) return null

  switch (reason) {
    case 'unavailable-processing':
      return {
        tone: 'info',
        title: 'Suche nach Bedeutung während der Verarbeitung nicht verfügbar',
        text: `${SEARCH_PROCESSING_TEXT} ${EXACT_SEARCH_STILL_WORKS}`
      }
    case 'model-missing': {
      const model = availability?.model
      if (!model || model.status === 'ready') {
        return {
          tone: 'info',
          title: 'Suche nach Bedeutung noch nicht verfügbar',
          text: `${SEARCH_MODEL_PENDING_TEXT} ${EXACT_SEARCH_STILL_WORKS}`
        }
      }
      const failed = model.status === 'failed' || model.status === 'retry-scheduled'
      return {
        tone: failed ? 'error' : 'info',
        title: failed
          ? 'Das Suchmodell konnte nicht geladen werden'
          : 'Suche nach Bedeutung erst nach dem Laden des Suchmodells verfügbar',
        text: `${describeSearchModel(model)} ${EXACT_SEARCH_STILL_WORKS}`,
        ...(model.status === 'downloading' ? { progress: model.progress } : {}),
        ...(failed ? { action: 'retry-model' as const } : {})
      }
    }
    case 'tool-blocked':
      return {
        tone: 'error',
        title: 'Suche nach Bedeutung blockiert',
        text: `${SEARCH_TOOL_BLOCKED_TEXT} ${EXACT_SEARCH_STILL_WORKS}`
      }
    case 'error':
      return {
        tone: 'error',
        title: 'Suche nach Bedeutung gerade nicht verfügbar',
        text: `${SEARCH_ERROR_TEXT} ${EXACT_SEARCH_STILL_WORKS}`,
        action: 'retry-semantic'
      }
  }
}
