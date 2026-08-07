import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { AudioFileService, createWavHeader, float32ToInt16 } from '../AudioFileService'

const TEST_DIR = join(__dirname, '..', '..', '..', '..', '.test-audio-data')
const AUDIO_DIR = join(TEST_DIR, 'audio')
const RECOVERY_DIR = join(TEST_DIR, 'recovery')

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home')
  }
}))

vi.mock('../../db/connection', () => ({
  getDataDir: vi.fn(() => TEST_DIR)
}))

function makeSilentSamples(count: number): Float32Array {
  return new Float32Array(count)
}

function makeToneSamples(count: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    samples[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * amplitude
  }
  return samples
}

describe('float32ToInt16', () => {
  it('converts silence to zeros', () => {
    const input = new Float32Array([0, 0, 0])
    const output = float32ToInt16(input)

    expect(output).toEqual(new Int16Array([0, 0, 0]))
  })

  it('converts full-scale positive to Int16 max', () => {
    const input = new Float32Array([1.0])
    const output = float32ToInt16(input)

    expect(output[0]).toBe(0x7fff)
  })

  it('converts full-scale negative to Int16 min', () => {
    const input = new Float32Array([-1.0])
    const output = float32ToInt16(input)

    expect(output[0]).toBe(-0x8000)
  })

  it('clamps values beyond [-1, 1]', () => {
    const input = new Float32Array([1.5, -1.5])
    const output = float32ToInt16(input)

    expect(output[0]).toBe(0x7fff)
    expect(output[1]).toBe(-0x8000)
  })

  it('preserves relative amplitudes', () => {
    const input = new Float32Array([0.5, -0.5])
    const output = float32ToInt16(input)

    expect(output[0]).toBeGreaterThan(0)
    expect(output[1]).toBeLessThan(0)
    expect(Math.abs(output[0] - Math.abs(output[1]))).toBeLessThanOrEqual(1)
  })
})

describe('createWavHeader', () => {
  it('creates a 44-byte header', () => {
    const header = createWavHeader(0)

    expect(header.length).toBe(44)
  })

  it('writes correct RIFF/WAVE identifiers', () => {
    const header = createWavHeader(0)

    expect(header.toString('ascii', 0, 4)).toBe('RIFF')
    expect(header.toString('ascii', 8, 12)).toBe('WAVE')
    expect(header.toString('ascii', 12, 16)).toBe('fmt ')
    expect(header.toString('ascii', 36, 40)).toBe('data')
  })

  it('sets PCM format (1)', () => {
    const header = createWavHeader(0)

    expect(header.readUInt16LE(20)).toBe(1) // AudioFormat = PCM
  })

  it('sets mono channel', () => {
    const header = createWavHeader(0)

    expect(header.readUInt16LE(22)).toBe(1) // NumChannels
  })

  it('sets 48000 Hz sample rate', () => {
    const header = createWavHeader(0)

    expect(header.readUInt32LE(24)).toBe(48000)
  })

  it('sets 16-bit depth', () => {
    const header = createWavHeader(0)

    expect(header.readUInt16LE(34)).toBe(16)
  })

  it('calculates correct byte rate (48000 * 1 * 2)', () => {
    const header = createWavHeader(0)

    expect(header.readUInt32LE(28)).toBe(96000)
  })

  it('sets data size in header', () => {
    const dataSize = 96000 // 1 second of audio
    const header = createWavHeader(dataSize)

    expect(header.readUInt32LE(40)).toBe(dataSize) // data subchunk size
    expect(header.readUInt32LE(4)).toBe(36 + dataSize) // RIFF chunk size
  })
})

describe('AudioFileService', () => {
  let service: AudioFileService

  beforeEach(() => {
    mkdirSync(AUDIO_DIR, { recursive: true })
    mkdirSync(RECOVERY_DIR, { recursive: true })
    service = new AudioFileService()
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  describe('initWavFile', () => {
    it('creates a WAV file with header', () => {
      const wavPath = service.initWavFile('test-session')

      expect(existsSync(wavPath)).toBe(true)

      const content = readFileSync(wavPath)
      expect(content.length).toBe(44) // Header only
      expect(content.toString('ascii', 0, 4)).toBe('RIFF')
    })
  })

  describe('appendChunk + finalizeWavFile', () => {
    it('writes audio data and finalizes correctly', () => {
      service.initWavFile('test-session')

      // Append 1 second of 440 Hz tone
      const samples = makeToneSamples(48000)
      service.appendChunk('test-session', samples.buffer as ArrayBuffer)

      const result = service.finalizeWavFile('test-session')

      expect(result.durationSeconds).toBeCloseTo(1.0, 1)

      // Verify final WAV file
      const wavPath = join(AUDIO_DIR, 'test-session.wav')
      const content = readFileSync(wavPath)
      const expectedDataSize = 48000 * 2 // 48000 samples * 2 bytes/sample
      expect(content.length).toBe(44 + expectedDataSize)

      // Verify header was updated
      expect(content.readUInt32LE(40)).toBe(expectedDataSize)
      expect(content.readUInt32LE(4)).toBe(36 + expectedDataSize)
    })

    it('appends multiple chunks correctly', () => {
      service.initWavFile('test-session')

      // Send 3 small chunks
      const chunk1 = makeSilentSamples(4800)
      const chunk2 = makeToneSamples(4800)
      const chunk3 = makeSilentSamples(4800)

      service.appendChunk('test-session', chunk1.buffer as ArrayBuffer)
      service.appendChunk('test-session', chunk2.buffer as ArrayBuffer)
      service.appendChunk('test-session', chunk3.buffer as ArrayBuffer)

      const result = service.finalizeWavFile('test-session')

      expect(result.durationSeconds).toBeCloseTo(0.3, 1) // 14400 samples / 48000 = 0.3s
    })

    it('throws when appending to non-existent session', () => {
      expect(() => {
        service.appendChunk('nonexistent', makeSilentSamples(100).buffer as ArrayBuffer)
      }).toThrow('No active recording for session nonexistent')
    })
  })

  describe('recovery', () => {
    it('hasRecoveryFile returns false when no recovery file', () => {
      expect(service.hasRecoveryFile('test-session')).toBe(false)
    })

    it('creates recovery from WAV and recovery PCM', () => {
      service.initWavFile('test-session')

      // Append some audio
      const samples = makeToneSamples(48000)
      service.appendChunk('test-session', samples.buffer as ArrayBuffer)

      // Simulate cleanup without finalize (crash scenario)
      service.cleanup('test-session')

      // Check the WAV exists with partial data
      const wavPath = join(AUDIO_DIR, 'test-session.wav')
      expect(existsSync(wavPath)).toBe(true)
    })
  })

  describe('repairWavAfterCrash', () => {
    it('fixes the stale WAV header from the actual file size', () => {
      // Crash-Szenario: Chunks wurden synchron in die WAV geschrieben, aber
      // finalizeWavFile lief nie — der Header behauptet dataSize=0.
      service.initWavFile('crash-session')
      const samples = makeToneSamples(48000) // 1 s
      service.appendChunk('crash-session', samples.buffer as ArrayBuffer)
      // Neuer Service simuliert App-Neustart (in-memory Maps leer)
      const freshService = new AudioFileService()

      const result = freshService.repairWavAfterCrash('crash-session')

      expect(result?.durationSeconds).toBeCloseTo(1.0, 1)
      const content = readFileSync(join(AUDIO_DIR, 'crash-session.wav'))
      expect(content.readUInt32LE(40)).toBe(48000 * 2)
    })

    it('does NOT append the recovery dump when the WAV exists (would duplicate audio)', () => {
      // Der Recovery-Dump enthält dieselben Chunks, die bereits synchron in
      // die Haupt-WAV geschrieben wurden — Anhängen würde bis zu 60 s Audio
      // duplizieren. Er wird stattdessen verworfen.
      service.initWavFile('crash-session')
      const samples = makeToneSamples(48000)
      service.appendChunk('crash-session', samples.buffer as ArrayBuffer)
      // Recovery-Dump von Hand erzeugen (dumpRecoveryBuffer ist privat und
      // zeitgesteuert): gleiche PCM-Daten wie in der WAV
      const { writeFileSync: wfs } = require('fs') // eslint-disable-line @typescript-eslint/no-require-imports
      const recoveryPath = join(RECOVERY_DIR, 'crash-session.pcm')
      wfs(recoveryPath, Buffer.from(float32ToInt16(samples).buffer))

      const freshService = new AudioFileService()
      const result = freshService.repairWavAfterCrash('crash-session')

      expect(result?.durationSeconds).toBeCloseTo(1.0, 1) // NICHT 2.0
      expect(existsSync(recoveryPath)).toBe(false) // Dump verworfen
    })

    it('rebuilds the WAV from the recovery dump when the WAV is missing', () => {
      const samples = makeToneSamples(48000)
      const { writeFileSync: wfs } = require('fs') // eslint-disable-line @typescript-eslint/no-require-imports
      wfs(join(RECOVERY_DIR, 'lost-session.pcm'), Buffer.from(float32ToInt16(samples).buffer))

      const freshService = new AudioFileService()
      const result = freshService.repairWavAfterCrash('lost-session')

      expect(result?.durationSeconds).toBeCloseTo(1.0, 1)
      expect(existsSync(join(AUDIO_DIR, 'lost-session.wav'))).toBe(true)
    })

    it('returns null when neither WAV nor recovery dump exist', () => {
      expect(service.repairWavAfterCrash('ghost-session')).toBeNull()
    })
  })

  describe('cleanup', () => {
    it('releases file descriptor without error', () => {
      service.initWavFile('test-session')
      service.cleanup('test-session')

      // Should not throw on subsequent operations
      expect(() => {
        service.cleanup('test-session')
      }).not.toThrow()
    })
  })
})
