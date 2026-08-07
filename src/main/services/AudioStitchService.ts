import { existsSync, mkdirSync } from 'fs'
import { open, stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { SpeakerSegment, StitchMap, StitchSegment } from '../../shared/types'
import { createWavHeader } from './AudioFileService'

export const DEFAULT_PADDING_SEC = 0.2

export interface StitchedAudio {
  wavPath: string
  stitchMap: StitchMap
}

/**
 * Pure: compute the stitch-map from speech segments.
 * - Pads each segment by ±paddingSec, clipped to [0, originalDuration].
 * - Sorts by start, merges overlapping padded ranges.
 * - Computes cumulative `stitchedStart` for each merged segment.
 */
export function computeStitchMap(
  speech: SpeakerSegment[],
  paddingSec: number,
  originalDurationSec: number
): StitchMap {
  if (speech.length === 0) {
    return {
      segments: [],
      paddingSec,
      stitchedDurationSec: 0,
      originalDurationSec
    }
  }

  // 1. Pad + clamp + sort
  const padded = speech
    .map((s) => ({
      start: Math.max(0, s.start - paddingSec),
      end: Math.min(originalDurationSec, s.end + paddingSec)
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start)

  // 2. Merge overlapping
  const merged: { start: number; end: number }[] = []
  for (const seg of padded) {
    const last = merged[merged.length - 1]
    if (last && seg.start <= last.end) {
      last.end = Math.max(last.end, seg.end)
    } else {
      merged.push({ ...seg })
    }
  }

  // 3. Build StitchSegment[]
  const segments: StitchSegment[] = []
  let cumulative = 0
  for (const m of merged) {
    const duration = m.end - m.start
    segments.push({
      originalStart: m.start,
      originalEnd: m.end,
      stitchedStart: cumulative,
      duration
    })
    cumulative += duration
  }

  return {
    segments,
    paddingSec,
    stitchedDurationSec: cumulative,
    originalDurationSec
  }
}

/**
 * Concatenate the PCM byte ranges described by `stitchMap` into a new WAV.
 *
 * Ersetzt den früheren ffmpeg-Subprozess (ein -ss/-to/-i-Triplet pro Segment
 * + N-Input-concat-Filtergraph): bei hunderten Segmenten hielt ffmpeg
 * hunderte Demuxer/Decoder offen (EMFILE-Risiko) — für das, was bei
 * garantiert 48 kHz/16-bit/mono PCM (siehe PyannoteSidecar/WhisperService-
 * Asserts) reine Byte-Arithmetik ist: Sample-Offset = round(t · 48000),
 * Byte-Offset = 44 + Offset · 2. Entfernt zugleich das 48-MB-ffmpeg-Binary
 * aus dem Bundle.
 *
 * Async + chunked (1 MiB), damit der Main-Process-Event-Loop während des
 * Kopierens nicht blockiert. Kooperative Abort-Checks pro Chunk.
 */
export async function stitchPcmSegments(
  audioPath: string,
  stitchMap: StitchMap,
  outputPath: string,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    throw new Error('Stitching abgebrochen')
  }

  const SAMPLE_RATE = 48000
  const BYTES_PER_SAMPLE = 2 // 16-bit mono
  const WAV_HEADER_SIZE = 44
  const CHUNK_SIZE = 1024 * 1024

  const srcStat = await stat(audioPath)
  const srcSize = srcStat.size

  // Byte-Ranges berechnen: round() auf Sample-Ebene hält die Offsets
  // automatisch frame-aligned (2 Bytes pro Sample, mono).
  const ranges = stitchMap.segments.map((seg) => {
    const startByte = WAV_HEADER_SIZE + Math.round(seg.originalStart * SAMPLE_RATE) * BYTES_PER_SAMPLE
    const endByte = WAV_HEADER_SIZE + Math.round(seg.originalEnd * SAMPLE_RATE) * BYTES_PER_SAMPLE
    const clampedStart = Math.min(Math.max(WAV_HEADER_SIZE, startByte), srcSize)
    const clampedEnd = Math.min(Math.max(clampedStart, endByte), srcSize)
    return { start: clampedStart, end: clampedEnd }
  })
  const totalBytes = ranges.reduce((sum, r) => sum + (r.end - r.start), 0)

  const src = await open(audioPath, 'r')
  try {
    const out = await open(outputPath, 'w')
    try {
      await out.write(createWavHeader(totalBytes))
      const buf = Buffer.allocUnsafe(CHUNK_SIZE)
      for (const range of ranges) {
        let pos = range.start
        while (pos < range.end) {
          if (signal?.aborted) {
            throw new Error('Stitching abgebrochen')
          }
          const toRead = Math.min(CHUNK_SIZE, range.end - pos)
          const { bytesRead } = await src.read(buf, 0, toRead, pos)
          if (bytesRead <= 0) break
          await out.write(buf, 0, bytesRead)
          pos += bytesRead
        }
      }
    } finally {
      await out.close()
    }
  } finally {
    await src.close()
  }
}

/**
 * Stitch speech segments of `audioPath` into a single WAV via direct PCM
 * byte-range concatenation. Returns the stitched WAV path + stitch map for
 * timestamp remapping. Caller owns the file (must clean up).
 *
 * Precondition: `speech` must contain at least one segment. Callers MUST
 * short-circuit on empty speech before invoking this — whisper-cli crashes
 * on a 0-sample WAV.
 */
export async function stitchSpeechSegments(
  audioPath: string,
  speech: SpeakerSegment[],
  originalDurationSec: number,
  signal?: AbortSignal,
  outputDir?: string
): Promise<StitchedAudio> {
  if (speech.length === 0) {
    throw new Error(
      'stitchSpeechSegments called with empty speech array — caller must short-circuit'
    )
  }

  const stitchMap = computeStitchMap(speech, DEFAULT_PADDING_SEC, originalDurationSec)

  const dir = outputDir ?? join(tmpdir(), 'therascript-stitch')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const wavPath = join(dir, `stitched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)

  await stitchPcmSegments(audioPath, stitchMap, wavPath, signal)

  return { wavPath, stitchMap }
}
