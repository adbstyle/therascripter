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
  async execute(
    task: Task,
    onProgress: (progress: number) => void,
    _signal?: AbortSignal
  ): Promise<void> {
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
      // Pipeline-Inversion (ADR-007 / Issue #78): if Pyannote found no speech,
      // Whisper wrote an empty transcript. Produce an empty aligned transcript
      // instead of aborting the pipeline — Erfolgskriterium #2 requires that
      // recordings without speech reach 'review' status with an empty editor.
      const emptyAligned: TranscriptData = {
        words: [],
        segments: [],
        metadata: {
          ...transcript.metadata,
          diarization: diarization.metadata.model
        }
      }
      const alignedTranscriptPath = sessionService.generateAlignedTranscriptPath(task.sessionId)
      writeFileAtomic(alignedTranscriptPath, JSON.stringify(emptyAligned))
      sessionService.updateSession(task.sessionId, { alignedTranscriptPath })
      onProgress(1)
      return
    }

    // Build consistent speaker label mapping (raw label → "Person A", "Person B", ...)
    const labelMap = buildSpeakerLabelMap(diarization.speakers)

    // Align words with speaker segments, absorb phantom speaker islands,
    // then correct sentence boundaries. Island suppression must run FIRST:
    // correctSentenceBoundaries otherwise extends an island backward to the
    // sentence start, making the misassignment look tidier instead of fixing it.
    const rawAligned = alignWords(transcript.words, diarization.speakers, labelMap)
    const deIslanded = suppressSpeakerIslands(rawAligned)
    const alignedWords = correctSentenceBoundaries(deIslanded)

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
    writeFileAtomic(alignedTranscriptPath, JSON.stringify(updatedTranscript))

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

// Minimum number of words for a foreign-speaker island to be absorbed.
// Single-word islands are deliberately kept (product decision): a lone word
// from another speaker mid-sentence may be a genuine short interjection.
const MIN_ISLAND_WORDS = 2

// Maximum island size (words / seconds) that is still treated as a
// diarization artifact. Longer runs are likely genuine speaker turns.
// Calibrated against a verified phantom turn: 5 words / 2.7 s.
const MAX_ISLAND_WORDS = 8
const MAX_ISLAND_DURATION_SEC = 4.0

// Absorb phantom speaker islands: pyannote occasionally emits a short
// foreign-speaker turn in the middle of one speaker's continuous utterance
// (clustering artifact). Word-level overlap alignment then relabels the words
// inside that turn, and rebuildSegmentsWithSpeakers cuts the sentence apart.
// A run of words is absorbed into the surrounding speaker when ALL hold:
//   - sandwich: the runs before and after belong to the SAME other speaker
//   - the run ends mid-sentence (genuine turns end with .!?)
//   - MIN_ISLAND_WORDS <= run length <= MAX_ISLAND_WORDS
//   - run duration <= MAX_ISLAND_DURATION_SEC
// Single pass over the runs of the ORIGINAL input — absorptions do not cascade.
export function suppressSpeakerIslands(words: TranscriptWord[]): TranscriptWord[] {
  if (words.length < 3) return words

  const result = words.map((w) => ({ ...w }))

  // Group words into maximal runs of the same speaker (index ranges, inclusive)
  const runs: { speaker: string | undefined; from: number; to: number }[] = []
  for (let i = 0; i < words.length; i++) {
    const last = runs[runs.length - 1]
    if (last && words[i].speaker === last.speaker) {
      last.to = i
    } else {
      runs.push({ speaker: words[i].speaker, from: i, to: i })
    }
  }

  for (let r = 1; r < runs.length - 1; r++) {
    const run = runs[r]
    const prev = runs[r - 1]
    const next = runs[r + 1]

    // Sandwich: same speaker on both sides
    if (prev.speaker !== next.speaker) continue

    // Genuine turns end at a sentence boundary — only absorb mid-sentence runs
    if (/[.!?]$/.test(words[run.to].text)) continue

    // Size limits: keep single-word blips and anything long enough to be real
    const runLength = run.to - run.from + 1
    if (runLength < MIN_ISLAND_WORDS || runLength > MAX_ISLAND_WORDS) continue
    if (words[run.to].end - words[run.from].start > MAX_ISLAND_DURATION_SEC) continue

    for (let k = run.from; k <= run.to; k++) {
      result[k] = { ...result[k], speaker: prev.speaker }
    }
  }

  return result
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
