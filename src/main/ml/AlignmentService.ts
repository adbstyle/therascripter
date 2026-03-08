import { existsSync, readFileSync } from 'fs'
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
import { writeFileAtomic } from '../utils/file-ops'

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

    // Align words with speaker segments, then correct sentence boundaries
    const rawAligned = alignWords(transcript.words, diarization.speakers, labelMap)
    const alignedWords = correctSentenceBoundaries(rawAligned)

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

    // Write aligned transcript to a separate file (preserves raw ASR transcript)
    const alignedTranscriptPath = sessionService.generateAlignedTranscriptPath(task.sessionId)
    writeFileAtomic(alignedTranscriptPath, JSON.stringify(updatedTranscript, null, 2))

    sessionService.updateSession(task.sessionId, { alignedTranscriptPath })

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

// Maximum number of words to look back when snapping a speaker change
// to the nearest sentence boundary. Limits false positives from genuine
// mid-sentence interruptions.
const MAX_SENTENCE_LOOKBACK = 5

// Minimum number of consecutive words the new speaker must have starting at
// the change point (in the original input). Prevents snapping for isolated
// speaker blips like A-B-A where B is a single misassigned word.
const MIN_NEW_SPEAKER_RUN = 2

// Sentence-aware boundary correction: when a speaker change occurs mid-sentence,
// snap it backward to the nearest sentence boundary (.!?) and reassign the
// intermediate words to the new speaker. This handles multi-word misassignment
// caused by pyannote segment boundaries being 0.5-1.5s off from actual transitions.
export function correctSentenceBoundaries(words: TranscriptWord[]): TranscriptWord[] {
  if (words.length < 2) return words

  const result = words.map((w) => ({ ...w }))

  for (let i = 1; i < result.length; i++) {
    // Find speaker change (read from immutable original to prevent cascade effects)
    if (words[i].speaker === words[i - 1].speaker) continue

    // Speaker change is already at a sentence boundary — nothing to fix
    if (/[.!?]$/.test(result[i - 1].text)) continue

    // Look backward for nearest .!? within MAX_SENTENCE_LOOKBACK words
    let sentEnd = -1
    for (let j = i - 2; j >= Math.max(0, i - MAX_SENTENCE_LOOKBACK - 1); j--) {
      if (/[.!?]$/.test(result[j].text)) {
        sentEnd = j
        break
      }
    }

    if (sentEnd < 0) continue // no sentence boundary found within lookback

    // Safety 1: only snap if all words between sentEnd+1 and i-1 had the same speaker
    // in the ORIGINAL input (prevents snapping through mixed-speaker regions)
    const outgoingSpeaker = words[i - 1].speaker
    let allSame = true
    for (let k = sentEnd + 1; k < i; k++) {
      if (words[k].speaker !== outgoingSpeaker) {
        allSame = false
        break
      }
    }
    if (!allSame) continue

    // Safety 2: verify the new speaker persists for at least MIN_NEW_SPEAKER_RUN
    // consecutive words starting at i. Prevents snapping for isolated speaker blips
    // (e.g. A-B-A where B is a single misassigned word from pyannote).
    // Skip this check when fewer than MIN_NEW_SPEAKER_RUN words remain (end of transcript).
    if (i + MIN_NEW_SPEAKER_RUN <= words.length) {
      let newSpeakerRun = 0
      for (let f = i; f < i + MIN_NEW_SPEAKER_RUN; f++) {
        if (words[f].speaker === words[i].speaker) newSpeakerRun++
        else break
      }
      if (newSpeakerRun < MIN_NEW_SPEAKER_RUN) continue
    }

    // Reassign words between sentence boundary and speaker change to the new speaker
    const newSpeaker = words[i].speaker
    for (let k = sentEnd + 1; k < i; k++) {
      result[k] = { ...result[k], speaker: newSpeaker }
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
