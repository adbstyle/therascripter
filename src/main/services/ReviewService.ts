import { readFileSync, writeFileSync, existsSync } from 'fs'
import type Database from 'better-sqlite3'
import { SessionService } from './SessionService'
import type { AudioStats, EntityMap, Session } from '../../shared/types'
import type { ReviewData } from '../../shared/types/IpcApi'
import type { TipTapDocument } from '../../shared/types/TipTapDocument'
import type { TranscriptData } from '../../shared/types/Transcript'
import type { DiarizationData } from '../../shared/types/Diarization'
import { countWords } from '../../shared/utils/countWords'
import { countPlaceholderChips } from '../../shared/utils/countPlaceholderChips'

export type { ReviewData }

export class ReviewService {
  private sessionService: SessionService

  constructor(db: Database.Database) {
    this.sessionService = new SessionService(db)
  }

  load(sessionId: string): ReviewData {
    const session = this.sessionService.getSession(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    if (session.status !== 'review') {
      throw new Error(`Session ${sessionId} is not in review status (current: ${session.status})`)
    }
    if (!session.anonymizedPath) {
      throw new Error(`Session ${sessionId} has no anonymized document`)
    }

    const docJson = readFileSync(session.anonymizedPath, 'utf-8')
    const document = JSON.parse(docJson) as TipTapDocument
    const entityMap = session.entityMap ?? {}

    return {
      document,
      entityMap,
      sessionType: session.type,
      sessionTitle: session.title,
      processedWithModels: session.processedWithModels,
      reviewAt: session.reviewAt,
      audioStats: session.type === 'audio' ? aggregateAudioStats(session) : null
    }
  }

  save(sessionId: string, document: TipTapDocument, entityMap: EntityMap): void {
    const session = this.sessionService.getSession(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    if (!session.anonymizedPath) {
      throw new Error(`Session ${sessionId} has no anonymized path`)
    }

    // Write TipTap document to filesystem
    writeFileSync(session.anonymizedPath, JSON.stringify(document, null, 2), 'utf-8')

    // Update entity map, word count, and anonymization count in database
    const wordCount = countWords(document)
    const anonymizationCount = countPlaceholderChips(document)
    this.sessionService.updateSession(sessionId, { entityMap, wordCount, anonymizationCount })
  }
}

/**
 * Issue #99 — Aggregate audio stats for the Provenance panel from the
 * transcript JSON (`metadata.stitchMap`) and the diarization JSON.
 *
 * Each field is aggregated independently and falls through to `null` on any
 * read or parse error so the panel can render a partial result with
 * "nicht verfügbar" placeholders rather than crashing the editor.
 *
 * Data-source contract:
 *  - `stitchMap` is present iff the session ran through the ADR-007 stitched
 *    pipeline. Pre-ADR-007 sessions and the empty-speech short-circuit branch
 *    of WhisperService both produce a transcript without `stitchMap`.
 *  - For empty-speech (Pyannote `speakerCount === 0`) we synthesize
 *    `stitchedDurationSec = 0` so AC9 ("0:00 (0 s)" / 100 % silence) holds
 *    even though the transcript writer skipped the stitch step.
 */
function aggregateAudioStats(session: Session): AudioStats {
  const diarization = readDiarization(session.diarizationPath)
  const transcript = readTranscript(session.transcriptPath)

  const stitchMap = transcript?.metadata.stitchMap ?? null
  const speakerCount = diarization?.speakerCount ?? null

  let originalDurationSec: number | null = null
  let stitchedDurationSec: number | null = null

  if (stitchMap) {
    originalDurationSec = stitchMap.originalDurationSec
    stitchedDurationSec = stitchMap.stitchedDurationSec
  } else if (transcript) {
    // Legacy or empty-speech path: no stitchMap. Fall back to transcript
    // metadata duration for the original length (AC8: Original-Dauer bleibt
    // sichtbar), and synthesize stitched=0 only when Pyannote confirmed no
    // speech (AC9). Pure legacy without that confirmation stays "nicht
    // verfügbar".
    if (typeof transcript.metadata.duration === 'number') {
      originalDurationSec = transcript.metadata.duration
    }
    if (speakerCount === 0) {
      stitchedDurationSec = 0
    }
  }

  return {
    originalDurationSec,
    stitchedDurationSec,
    speakerCount,
    diarizationModel: diarization?.metadata.model ?? null
  }
}

function readTranscript(path: string | null): TranscriptData | null {
  if (!path || !existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as TranscriptData
  } catch {
    return null
  }
}

function readDiarization(path: string | null): DiarizationData | null {
  if (!path || !existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as DiarizationData
  } catch {
    return null
  }
}
