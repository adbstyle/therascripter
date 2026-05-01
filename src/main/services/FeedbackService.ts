import { app } from 'electron'
import { execSync } from 'child_process'
import { release } from 'os'
import { getSettings } from './SettingsService'
import {
  getModelById,
  isModelInstalled
} from './ModelDownloadService'
import type { ModelGroup } from '../../shared/validation/model-catalog-schemas'

export const FEEDBACK_RECIPIENT = 'therascript.flatworm325@passmail.com'

export interface FeedbackContent {
  recipient: string
  subject: string
  body: string
  mailto: string
}

interface ModelLine {
  label: string
  group: ModelGroup
  /** Empty active id is treated as "(deaktiviert)" instead of "(nicht installiert)". */
  optional?: boolean
}

const MODEL_LINES: ModelLine[] = [
  { label: 'Transkription', group: 'asr' },
  { label: 'Diarisierung', group: 'diarization' },
  { label: 'NER', group: 'ner' },
  { label: 'Summarization', group: 'summarization', optional: true }
]

function getChipName(): string {
  try {
    return execSync('sysctl -n machdep.cpu.brand_string', {
      encoding: 'utf-8',
      timeout: 3000
    }).trim()
  } catch {
    return 'Unbekannt'
  }
}

function getMacOSVersion(): string {
  try {
    return execSync('sw_vers -productVersion', {
      encoding: 'utf-8',
      timeout: 3000
    }).trim()
  } catch {
    return `Darwin ${release()}`
  }
}

function getActiveIdForGroup(group: ModelGroup): string {
  const active = getSettings().get('activeModels')
  if (group === 'asr') return active.transcription
  if (group === 'diarization') return active.diarization
  if (group === 'ner') return active.ner
  if (group === 'summarization') return active.summarization
  return ''
}

function formatModelLine(line: ModelLine): string {
  const activeId = getActiveIdForGroup(line.group)
  if (!activeId) {
    return `${line.label}: ${line.optional ? '(deaktiviert)' : '(nicht installiert)'}`
  }
  if (!isModelInstalled(activeId)) {
    return `${line.label}: ${activeId} (nicht installiert)`
  }
  const def = getModelById(activeId)
  const shortName = def?.label ?? activeId
  return `${line.label}: ${shortName} (${activeId})`
}

export function buildFeedbackContent(): FeedbackContent {
  const version = app.getVersion()
  const osVersion = getMacOSVersion()
  const chip = getChipName()

  const subject = `Therascript Feedback – v${version}`

  const modelLines = MODEL_LINES.map(formatModelLine).join('\n')

  const body = [
    'Beschreibung',
    '(Was ist passiert?)',
    '',
    'Erwartetes Verhalten',
    '(Was hätte passieren sollen?)',
    '',
    'Schritte zur Reproduktion',
    '1. ',
    '2. ',
    '3. ',
    '',
    '— Bitte oberhalb dieser Zeile schreiben. Die folgenden Angaben helfen bei der Triage. —',
    '',
    'Systeminformationen',
    `App-Version: ${version}`,
    `macOS: ${osVersion}`,
    `Chip: ${chip}`,
    '',
    'Aktive Modelle',
    modelLines,
    '',
    'Hinweis zum Datenschutz',
    'Bitte keine Patientendaten, Transkriptinhalte oder Audio-Auszüge beifügen.',
    '',
    'Hinweis zur Bearbeitung',
    'Triage erfolgt im Rahmen der Möglichkeiten — es besteht keine garantierte Antwortfrist.'
  ].join('\n')

  // Per RFC 6068 the addr-spec is not percent-encoded — only the query values are.
  const mailto = `mailto:${FEEDBACK_RECIPIENT}?subject=${encodeURIComponent(
    subject
  )}&body=${encodeURIComponent(body)}`

  return {
    recipient: FEEDBACK_RECIPIENT,
    subject,
    body,
    mailto
  }
}

/**
 * Vollständiger Mail-Inhalt für die Zwischenablage — inklusive Empfänger und
 * Betreff, da der User ohne funktionierenden Mailclient sonst beides nicht
 * hat.
 */
export function buildClipboardPayload(content: FeedbackContent): string {
  return [
    `An: ${content.recipient}`,
    `Betreff: ${content.subject}`,
    '',
    content.body
  ].join('\n')
}
