export interface TranscriptWord {
  text: string
  start: number // seconds
  end: number // seconds
}

export interface TranscriptSegment {
  text: string
  start: number // seconds
  end: number // seconds
}

export interface TranscriptMetadata {
  model: string
  language: string
  duration: number // total audio duration in seconds
}

export interface TranscriptData {
  words: TranscriptWord[]
  segments: TranscriptSegment[]
  metadata: TranscriptMetadata
}
