export interface TranscriptWord {
  text: string
  start: number // seconds
  end: number // seconds
  speaker?: string // "Person A", "Person B", etc. (added by alignment)
}

export interface TranscriptSegment {
  text: string
  start: number // seconds
  end: number // seconds
  speaker?: string // speaker label for this segment (added by alignment)
}

export interface TranscriptMetadata {
  model: string
  language: string
  duration: number // total audio duration in seconds
  diarization?: string // diarization model name (added by alignment)
}

export interface TranscriptData {
  words: TranscriptWord[]
  segments: TranscriptSegment[]
  metadata: TranscriptMetadata
}
