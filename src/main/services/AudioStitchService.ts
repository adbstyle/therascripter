import { spawn } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { app } from 'electron'
import type { SpeakerSegment, StitchMap, StitchSegment } from '../../shared/types'

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

function getFfmpegPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', 'ffmpeg')
  }
  return join(app.getAppPath(), 'resources', 'bin', 'ffmpeg')
}

/**
 * Build the ffmpeg command-line args to extract and concatenate the speech
 * segments listed in `stitchMap`. Uses input-seek (-ss/-to before -i) for
 * fast seeking on PCM WAV input. Filter-complex `concat` with audio-only
 * (n=N:v=0:a=1) merges the segments. Output is forced to PCM 16-bit 48kHz
 * mono — what whisper-cli expects.
 */
export function buildFfmpegArgs(
  audioPath: string,
  stitchMap: StitchMap,
  outputPath: string
): string[] {
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error']
  for (const seg of stitchMap.segments) {
    args.push(
      '-ss',
      String(seg.originalStart),
      '-to',
      String(seg.originalEnd),
      '-i',
      audioPath
    )
  }

  const n = stitchMap.segments.length
  const filterParts: string[] = []
  for (let i = 0; i < n; i++) {
    filterParts.push(`[${i}:a]`)
  }
  const filter = `${filterParts.join('')}concat=n=${n}:v=0:a=1[out]`
  args.push('-filter_complex', filter, '-map', '[out]')

  args.push('-ar', '48000', '-ac', '1', '-acodec', 'pcm_s16le', outputPath)

  return args
}

function runFfmpeg(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Pre-aborted-signal guard: addEventListener('abort', …) does NOT fire if
    // the signal is already aborted at registration time (per Web spec). If a
    // caller hands us an already-aborted controller (e.g. cancel-recovery on
    // app restart), we'd otherwise leak a long-running ffmpeg subprocess that
    // nothing kills. Live-verified during QA — see PR #79 Bug #2.
    if (signal?.aborted) {
      reject(new Error('ffmpeg aborted before start'))
      return
    }

    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    const onAbort = (): void => {
      try {
        proc.kill('SIGTERM')
      } catch {
        // intentionally swallowed — process may already be gone
      }
    }
    signal?.addEventListener('abort', onAbort)
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr}`))
    })
  })
}

/**
 * Stitch speech segments of `audioPath` into a single WAV using ffmpeg's
 * concat filter. Returns the stitched WAV path + stitch map for timestamp
 * remapping. Caller owns the file (must clean up).
 *
 * Precondition: `speech` must contain at least one segment. Callers MUST
 * short-circuit on empty speech before invoking this — whisper-cli crashes
 * on a 0-sample WAV and ffmpeg refuses to emit one.
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

  const ffmpegArgs = buildFfmpegArgs(audioPath, stitchMap, wavPath)
  await runFfmpeg(getFfmpegPath(), ffmpegArgs, signal)

  return { wavPath, stitchMap }
}
