import { join } from 'path'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'fs'
import { getDataDir } from '../db/connection'

const SAMPLE_RATE = 48000
const BITS_PER_SAMPLE = 16
const NUM_CHANNELS = 1
const WAV_HEADER_SIZE = 44

export class AudioFileService {
  private fileDescriptors = new Map<string, number>()
  private bytesWritten = new Map<string, number>()
  private recoveryBuffers = new Map<string, Buffer[]>()
  private lastRecoveryDump = new Map<string, number>()

  initWavFile(sessionId: string): string {
    const wavPath = this.getWavPath(sessionId)
    const header = createWavHeader(0)
    writeFileSync(wavPath, header)

    const fd = openSync(wavPath, 'a')
    this.fileDescriptors.set(sessionId, fd)
    this.bytesWritten.set(sessionId, 0)
    this.recoveryBuffers.set(sessionId, [])
    this.lastRecoveryDump.set(sessionId, Date.now())

    return wavPath
  }

  appendChunk(sessionId: string, samples: ArrayBuffer): void {
    const fd = this.fileDescriptors.get(sessionId)
    if (fd === undefined) {
      throw new Error(`No active recording for session ${sessionId}`)
    }

    const int16 = float32ToInt16(new Float32Array(samples))
    const buffer = Buffer.from(int16.buffer)

    writeSync(fd, buffer)
    this.bytesWritten.set(sessionId, (this.bytesWritten.get(sessionId) ?? 0) + buffer.length)

    // Accumulate for recovery
    const recoveryChunks = this.recoveryBuffers.get(sessionId)
    if (recoveryChunks) {
      recoveryChunks.push(buffer)
    }

    // Dump recovery buffer every 60 seconds
    const lastDump = this.lastRecoveryDump.get(sessionId) ?? 0
    if (Date.now() - lastDump >= 60_000) {
      this.dumpRecoveryBuffer(sessionId)
      this.lastRecoveryDump.set(sessionId, Date.now())
    }
  }

  finalizeWavFile(sessionId: string): { durationSeconds: number } {
    const fd = this.fileDescriptors.get(sessionId)
    if (fd !== undefined) {
      closeSync(fd)
      this.fileDescriptors.delete(sessionId)
    }

    const dataSize = this.bytesWritten.get(sessionId) ?? 0
    this.bytesWritten.delete(sessionId)

    // Rewrite WAV header with correct size
    const wavPath = this.getWavPath(sessionId)
    const header = createWavHeader(dataSize)
    const headerFd = openSync(wavPath, 'r+')
    writeSync(headerFd, header, 0, WAV_HEADER_SIZE, 0)
    closeSync(headerFd)

    // Clean up recovery
    this.recoveryBuffers.delete(sessionId)
    this.lastRecoveryDump.delete(sessionId)
    this.deleteRecoveryFile(sessionId)

    const durationSeconds = dataSize / (SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8))
    return { durationSeconds }
  }

  cleanup(sessionId: string): void {
    const fd = this.fileDescriptors.get(sessionId)
    if (fd !== undefined) {
      closeSync(fd)
      this.fileDescriptors.delete(sessionId)
    }
    this.bytesWritten.delete(sessionId)
    this.recoveryBuffers.delete(sessionId)
    this.lastRecoveryDump.delete(sessionId)
  }

  hasRecoveryFile(sessionId: string): boolean {
    return existsSync(this.getRecoveryPath(sessionId))
  }

  recoverSession(sessionId: string): { durationSeconds: number } | null {
    const recoveryPath = this.getRecoveryPath(sessionId)
    if (!existsSync(recoveryPath)) return null

    const wavPath = this.getWavPath(sessionId)
    const pcmData = readFileSync(recoveryPath)

    if (existsSync(wavPath)) {
      // Append recovery data to existing WAV
      const fd = openSync(wavPath, 'a')
      writeSync(fd, pcmData)
      closeSync(fd)

      // Calculate total data size (file size minus header)
      const fileBuffer = readFileSync(wavPath)
      const dataSize = fileBuffer.length - WAV_HEADER_SIZE

      // Update header
      const header = createWavHeader(dataSize)
      const headerFd = openSync(wavPath, 'r+')
      writeSync(headerFd, header, 0, WAV_HEADER_SIZE, 0)
      closeSync(headerFd)

      unlinkSync(recoveryPath)
      const durationSeconds = dataSize / (SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8))
      return { durationSeconds }
    }

    // No WAV exists — create one from recovery data
    const header = createWavHeader(pcmData.length)
    writeFileSync(wavPath, Buffer.concat([header, pcmData]))
    unlinkSync(recoveryPath)

    const durationSeconds = pcmData.length / (SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8))
    return { durationSeconds }
  }

  private dumpRecoveryBuffer(sessionId: string): void {
    const chunks = this.recoveryBuffers.get(sessionId)
    if (!chunks || chunks.length === 0) return

    const recoveryPath = this.getRecoveryPath(sessionId)
    const combined = Buffer.concat(chunks)

    // Keep only last 60 seconds of PCM data
    const maxBytes = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8) * 60
    const trimmed =
      combined.length > maxBytes ? combined.subarray(combined.length - maxBytes) : combined

    writeFileSync(recoveryPath, trimmed)

    // Reset buffer — keep only what wasn't dumped
    this.recoveryBuffers.set(sessionId, [])
  }

  private deleteRecoveryFile(sessionId: string): void {
    const recoveryPath = this.getRecoveryPath(sessionId)
    if (existsSync(recoveryPath)) {
      unlinkSync(recoveryPath)
    }
  }

  private getWavPath(sessionId: string): string {
    return join(getDataDir(), 'audio', `${sessionId}.wav`)
  }

  private getRecoveryPath(sessionId: string): string {
    return join(getDataDir(), 'recovery', `${sessionId}.pcm`)
  }
}

function createWavHeader(dataSize: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_SIZE)
  const byteRate = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8)
  const blockAlign = NUM_CHANNELS * (BITS_PER_SAMPLE / 8)

  // RIFF chunk descriptor
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4) // ChunkSize
  header.write('WAVE', 8)

  // fmt subchunk
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20) // AudioFormat (1 = PCM)
  header.writeUInt16LE(NUM_CHANNELS, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(BITS_PER_SAMPLE, 34)

  // data subchunk
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return header
}

function float32ToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return output
}

export { createWavHeader, float32ToInt16 }
