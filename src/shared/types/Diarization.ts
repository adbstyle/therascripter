export interface SpeakerSegment {
  label: string // "A", "B", "C", etc. (raw from pyannote)
  start: number // seconds
  end: number // seconds
}

export interface DiarizationMetadata {
  model: string // "pyannote-community-1"
  duration: number // total audio duration in seconds
}

export interface DiarizationData {
  speakers: SpeakerSegment[]
  speakerCount: number
  metadata: DiarizationMetadata
}
