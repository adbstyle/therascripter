import { readFileSync, writeFileSync } from 'fs'
import type Database from 'better-sqlite3'
import { SessionService } from './SessionService'
import type { EntityMap } from '../../shared/types'
import type { ReviewData } from '../../shared/types/IpcApi'
import type { TipTapDocument } from '../../shared/types/TipTapDocument'
import { countWords } from '../../shared/utils/countWords'

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
      qualityFlag: session.qualityFlag
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
