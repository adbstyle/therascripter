import initialSchema from './001-initial-schema.sql?raw'
import addDiarizationPath from './002-add-diarization-path.sql?raw'
import addReviewAt from './003-add-review-at.sql?raw'
import addTaskCancelledStatus from './004-add-task-cancelled-status.sql?raw'
import addAlignedTranscriptAndExtractedPaths from './005-add-aligned-transcript-and-extracted-paths.sql?raw'
import addWordCount from './006-add-word-count.sql?raw'
import addSummarization from './007-add-summarization.sql?raw'
import resetSummarizationParseErrors from './008-reset-summarization-parse-errors.sql?raw'
import addQualityFlag from './009-add-quality-flag.sql?raw'
import dropPipelineVersion from './010-drop-pipeline-version.sql?raw'
import pipelineInversion from './011-pipeline-inversion.sql?raw'
import statusReductionPlannedStepsRetry from './012-status-reduction-planned-steps-retry.sql?raw'
import pdfHasScannedPages from './013-pdf-has-scanned-pages.sql?raw'
import processedWithModels from './014-processed-with-models.sql?raw'
import addAnonymizationCount from './015-add-anonymization-count.sql?raw'
import taskAttempts from './016-task-attempts.sql?raw'
import sessionDeletingAt from './017-session-deleting-at.sql?raw'
import appMaintenance from './018-app-maintenance.sql?raw'
import patientDossiers from './020-patient-dossiers.sql?raw'

// REGEL für Table-Rebuild-Migrationen (CREATE new → DROP old → RENAME):
// Der Migration-Runner läuft mit PRAGMA foreign_keys = ON. Ein
// `DROP TABLE sessions` feuert dann ON DELETE CASCADE auf task_queue und
// löscht ALLE Task-Zeilen — Migration 012 hat so die komplette Task-Historie
// der Bestandsnutzer beim Upgrade gewiped. Einfache ALTER TABLE ADD COLUMN
// sind nicht betroffen.
//
// ACHTUNG (geprüft mit Migration 020, SQLite 3.51): `PRAGMA defer_foreign_keys
// = ON` verhindert diese Cascade NICHT. Es verschiebt nur die PRÜFUNG von
// Fremdschlüsseln ans Transaktionsende; das implizite DELETE FROM eines
// DROP TABLE führt ON-DELETE-Aktionen (CASCADE, SET NULL) trotzdem sofort
// aus. Schützen würde nur `PRAGMA foreign_keys = OFF` — das ist innerhalb
// einer Transaktion wirkungslos, und der Runner (connection.ts) führt jede
// Migration in einer Transaktion aus. Vor einem Rebuild einer Tabelle, auf die
// andere per ON DELETE verweisen (sessions, dossiers), muss deshalb zuerst der
// Runner erweitert werden: foreign_keys vor der Transaktion aus, danach
// `PRAGMA foreign_key_check`, dann wieder an.
//
// Seit Migration 020 (Patientendossiers, Epic #192) hängen ausserdem
// session_dossiers (Zuordnungen zu Patientendossiers) und recent_items
// («Zuletzt geöffnet») per ON DELETE CASCADE an sessions: ein Rebuild von
// sessions mit eingeschalteten Fremdschlüsseln — auch mit defer_foreign_keys —
// löscht also auch ALLE Zuordnungen und «Zuletzt»-Einträge. Belegt durch den
// Migrationstest 020-patient-dossiers.test.ts.

export interface Migration {
  version: number
  sql: string
}

export const migrations: Migration[] = [
  { version: 1, sql: initialSchema },
  { version: 2, sql: addDiarizationPath },
  { version: 3, sql: addReviewAt },
  { version: 4, sql: addTaskCancelledStatus },
  { version: 5, sql: addAlignedTranscriptAndExtractedPaths },
  { version: 6, sql: addWordCount },
  { version: 7, sql: addSummarization },
  { version: 8, sql: resetSummarizationParseErrors },
  { version: 9, sql: addQualityFlag },
  { version: 10, sql: dropPipelineVersion },
  { version: 11, sql: pipelineInversion },
  { version: 12, sql: statusReductionPlannedStepsRetry },
  { version: 13, sql: pdfHasScannedPages },
  { version: 14, sql: processedWithModels },
  { version: 15, sql: addAnonymizationCount },
  { version: 16, sql: taskAttempts },
  { version: 17, sql: sessionDeletingAt },
  { version: 18, sql: appMaintenance },
  { version: 20, sql: patientDossiers }
]
