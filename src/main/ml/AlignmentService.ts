import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { Task } from '../../shared/types'
import type {
  TranscriptData,
  TranscriptWord,
  TranscriptSegment,
  SpeakerSegment,
  DiarizationData
} from '../../shared/types'
import type { TaskExecutor } from '../services/task-executors'
import { SessionService } from '../services/SessionService'
import { getDatabase } from '../db/connection'

const SPEAKER_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

export class AlignmentService implements TaskExecutor {
  async execute(task: Task, onProgress: (progress: number) => void): Promise<void> {
    const db = getDatabase()
    const sessionService = new SessionService(db)
    const session = sessionService.getSession(task.sessionId)

    if (!session?.transcriptPath) {
      throw new Error(`Session ${task.sessionId} hat keinen Transkript-Pfad`)
    }
    if (!existsSync(session.transcriptPath)) {
      throw new Error(`Transkript nicht gefunden: ${session.transcriptPath}`)
    }
    if (!session.diarizationPath) {
      throw new Error(`Session ${task.sessionId} hat keinen Diarization-Pfad`)
    }
    if (!existsSync(session.diarizationPath)) {
      throw new Error(`Diarization-Daten nicht gefunden: ${session.diarizationPath}`)
    }

    onProgress(0.1)

    // Load transcript and diarization data
    const transcript = JSON.parse(readFileSync(session.transcriptPath, 'utf-8')) as TranscriptData
    const diarization = JSON.parse(
      readFileSync(session.diarizationPath, 'utf-8')
    ) as DiarizationData

    onProgress(0.2)

    if (!transcript.words || transcript.words.length === 0) {
      throw new Error('Transkript enthält keine Wörter für die Sprecherzuordnung')
    }

    // Build consistent speaker label mapping (raw label → "Person A", "Person B", ...)
    const labelMap = buildSpeakerLabelMap(diarization.speakers)

    // Align words with speaker segments, then smooth speaker boundaries
    const rawAligned = alignWords(transcript.words, diarization.speakers, labelMap)
    const alignedWords = smoothBoundaries(rawAligned)

    onProgress(0.6)

    // Rebuild segments with speaker labels and paragraph breaks at speaker changes
    const alignedSegments = rebuildSegmentsWithSpeakers(alignedWords, diarization.speakerCount)

    onProgress(0.9)

    // Update transcript with speaker-aligned data
    const updatedTranscript: TranscriptData = {
      words: alignedWords,
      segments: alignedSegments,
      metadata: {
        ...transcript.metadata,
        diarization: diarization.metadata.model
      }
    }

    // Overwrite transcript file with aligned data
    writeFileSync(session.transcriptPath, JSON.stringify(updatedTranscript, null, 2))

    onProgress(1)
  }
}

// Build a mapping from raw pyannote speaker labels (e.g., "SPEAKER_00") to
// consistent labels ("A", "B", "C", ...) ordered by first appearance
export function buildSpeakerLabelMap(segments: SpeakerSegment[]): Map<string, string> {
  const labelMap = new Map<string, string>()
  let nextIndex = 0

  // Sort by start time to assign labels in order of first appearance
  const sorted = [...segments].sort((a, b) => a.start - b.start)

  for (const seg of sorted) {
    if (!labelMap.has(seg.label)) {
      labelMap.set(seg.label, SPEAKER_LABELS[nextIndex] ?? String.fromCharCode(65 + nextIndex))
      nextIndex++
    }
  }

  return labelMap
}

// For each word, find the speaker segment with the greatest temporal overlap.
// Returns null when the word falls entirely in a gap (no overlap with any segment).
export function findBestOverlapSegment(
  word: TranscriptWord,
  segments: SpeakerSegment[]
): SpeakerSegment | null {
  let bestSeg: SpeakerSegment | null = null
  let bestOverlap = 0

  for (const seg of segments) {
    const overlap = Math.max(0, Math.min(word.end, seg.end) - Math.max(word.start, seg.start))
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      bestSeg = seg
    }
  }

  return bestSeg
}

// For each word, find the speaker segment with the greatest temporal overlap
// and assign the mapped speaker label. Falls back to nearest segment for gap words.
export function alignWords(
  words: TranscriptWord[],
  speakers: SpeakerSegment[],
  labelMap: Map<string, string>
): TranscriptWord[] {
  if (speakers.length === 0) return words

  return words.map((word) => {
    // Prefer overlap-based assignment; fall back to nearest-segment for gap words
    const segment =
      findBestOverlapSegment(word, speakers) ??
      findSpeakerForTime((word.start + word.end) / 2, speakers)
    const rawLabel = segment?.label
    const mappedLabel = rawLabel ? labelMap.get(rawLabel) : undefined

    return {
      ...word,
      speaker: mappedLabel ? `Person ${mappedLabel}` : undefined
    }
  })
}

// Post-assignment boundary smoother: when a word at a speaker transition is
// immediately preceded by sentence-ending punctuation (.!?), reassign it to the
// next speaker — it likely starts their sentence, not ends the previous one.
export function smoothBoundaries(words: TranscriptWord[]): TranscriptWord[] {
  if (words.length < 3) return words

  const result = words.map((w) => ({ ...w }))

  for (let i = 1; i < result.length - 1; i++) {
    const prev = words[i - 1]
    const curr = words[i]
    const next = words[i + 1]

    if (
      curr.speaker !== next.speaker && // transition coming up
      curr.speaker === prev.speaker && // curr is still in the previous speaker's run
      /[.!?]$/.test(prev.text) // sentence ended before curr
    ) {
      result[i] = { ...curr, speaker: next.speaker }
    }
  }

  return result
}

// Find the speaker segment containing the given time point
// Falls back to nearest segment if time falls in a gap
export function findSpeakerForTime(
  time: number,
  segments: SpeakerSegment[]
): SpeakerSegment | null {
  // Direct match: time falls within a segment
  for (const seg of segments) {
    if (time >= seg.start && time < seg.end) {
      return seg
    }
  }

  // Fallback: find the nearest segment boundary
  let nearest: SpeakerSegment | null = null
  let minDist = Infinity

  for (const seg of segments) {
    const distToStart = Math.abs(time - seg.start)
    const distToEnd = Math.abs(time - seg.end)
    const dist = Math.min(distToStart, distToEnd)

    if (dist < minDist) {
      minDist = dist
      nearest = seg
    }
  }

  return nearest
}

// Rebuild segments with speaker labels, breaking only at speaker changes
export function rebuildSegmentsWithSpeakers(
  words: TranscriptWord[],
  speakerCount: number
): TranscriptSegment[] {
  if (words.length === 0) return []

  // If only 1 speaker detected, strip speaker labels (per spec: no labels for single speaker)
  const singleSpeaker = speakerCount <= 1
  if (singleSpeaker) {
    return rebuildSegmentsPlainText(words)
  }

  const segments: TranscriptSegment[] = []
  let currentWords: TranscriptWord[] = []
  let currentSpeaker = words[0].speaker

  for (const word of words) {
    // Break on speaker change
    if (word.speaker !== currentSpeaker) {
      if (currentWords.length > 0) {
        segments.push(buildSegment(currentWords, currentSpeaker))
      }
      currentWords = [word]
      currentSpeaker = word.speaker
      continue
    }

    currentWords.push(word)
  }

  // Final segment
  if (currentWords.length > 0) {
    segments.push(buildSegment(currentWords, currentSpeaker))
  }

  return segments
}

// For single-speaker transcripts: rebuild segments without speaker labels
function rebuildSegmentsPlainText(words: TranscriptWord[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  let currentWords: TranscriptWord[] = []

  for (const word of words) {
    currentWords.push(word)

    if (/[.!?]$/.test(word.text)) {
      segments.push({
        text: currentWords.map((w) => w.text).join(' '),
        start: currentWords[0].start,
        end: currentWords[currentWords.length - 1].end
      })
      currentWords = []
    }
  }

  if (currentWords.length > 0) {
    segments.push({
      text: currentWords.map((w) => w.text).join(' '),
      start: currentWords[0].start,
      end: currentWords[currentWords.length - 1].end
    })
  }

  return segments
}

function buildSegment(words: TranscriptWord[], speaker: string | undefined): TranscriptSegment {
  return {
    text: words.map((w) => w.text).join(' '),
    start: words[0].start,
    end: words[words.length - 1].end,
    speaker
  }
}

// Format seconds to [HH:MM:SS] timestamp string
export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}
