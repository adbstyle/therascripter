import type { PageData } from '../../shared/types/PDFTypes'
import type { SessionService } from '../services/SessionService'
import { writeFileAtomic } from './file-ops'

export function buildPDFTranscript(
  sessionId: string,
  pages: PageData[],
  model: string,
  sessionService: SessionService
): string {
  const allText = pages
    .map((p) => p.text)
    .filter((t) => t.length > 0)
    .join('\n\n')

  const paragraphs = allText
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const segments =
    paragraphs.length > 0
      ? paragraphs.map((text) => ({ text, start: 0, end: 0 }))
      : [{ text: '', start: 0, end: 0 }]

  const transcriptData = {
    words: [],
    segments,
    metadata: {
      model,
      language: 'de',
      duration: 0,
      source: 'pdf'
    }
  }

  const transcriptPath = sessionService.generateTranscriptPath(sessionId)
  writeFileAtomic(transcriptPath, JSON.stringify(transcriptData, null, 2))
  return transcriptPath
}
