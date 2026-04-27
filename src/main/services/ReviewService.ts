import { readFileSync, writeFileSync } from 'fs'
import type Database from 'better-sqlite3'
import { SessionService } from './SessionService'
import { TRANSCRIPTION_PIPELINE_VERSION } from '../ml/whisper-quality'
import type { EntityMap, TranscriptData } from '../../shared/types'
import type { ReviewData } from '../../shared/types/IpcApi'
import type { TipTapDocument } from '../../shared/types/TipTapDocument'
import { countWords } from '../../shared/utils/countWords'

export type { ReviewData }

/**
 * Build a minimal TipTap document from raw whisper transcript segments.
 * Used for transcription_quality_failed sessions that never produced an
 * anonymized document — we still want the editor to show the broken
 * output so the user can verify the loop diagnosis themselves.
 */
function transcriptToFallbackDoc(transcript: TranscriptData): TipTapDocument {
  if (transcript.segments.length === 0) {
    return { type: 'doc', content: [{ type: 'paragraph', content: [] }] }
  }
  return {
    type: 'doc',
    content: transcript.segments.map((seg) => ({
      type: 'paragraph',
      content: seg.text.trim().length > 0 ? [{ type: 'text', text: seg.text }] : []
    }))
  }
}

export class ReviewService {
  private sessionService: SessionService

  constructor(db: Database.Database) {
    this.sessionService = new SessionService(db)
  }

  load(sessionId: string): ReviewData {
    const session = this.sessionService.getSession(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    if (session.status !== 'review' && session.status !== 'transcription_quality_failed') {
      throw new Error(`Session ${sessionId} is not in review status (current: ${session.status})`)
    }

    let document: TipTapDocument
    if (session.status === 'transcription_quality_failed') {
      // No anonymized document exists — render the raw transcript so the user
      // can see the loop and decide whether to re-transcribe.
      if (!session.transcriptPath) {
        document = { type: 'doc', content: [{ type: 'paragraph', content: [] }] }
      } else {
        const rawTranscript = JSON.parse(
          readFileSync(session.transcriptPath, 'utf-8')
        ) as TranscriptData
        document = transcriptToFallbackDoc(rawTranscript)
      }
    } else {
      if (!session.anonymizedPath) {
        throw new Error(`Session ${sessionId} has no anonymized document`)
      }
      const docJson = readFileSync(session.anonymizedPath, 'utf-8')
      document = JSON.parse(docJson) as TipTapDocument
    }

    const entityMap = session.entityMap ?? {}

    // Manual re-transcription only useful when the pipeline config has changed
    // since the failed run — otherwise it would deterministically produce the
    // same output. Renderer hides the retry button when this is false.
    const canRetryTranscription =
      session.status === 'transcription_quality_failed' &&
      (session.transcriptionPipelineVersion ?? 0) < TRANSCRIPTION_PIPELINE_VERSION

    return {
      document,
      entityMap,
      sessionType: session.type,
      sessionTitle: session.title,
      sessionStatus: session.status,
      qualityFlag: session.qualityFlag,
      canRetryTranscription
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

    // Update entity map and word count in database
    const wordCount = countWords(document)
    this.sessionService.updateSession(sessionId, { entityMap, wordCount })
  }
}
