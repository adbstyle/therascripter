/**
 * AudioWorklet processor for real-time PCM audio capture.
 *
 * Runs in the audio rendering thread at real-time priority.
 * Captures mono 48 kHz audio, calculates RMS levels, and sends
 * buffered PCM chunks to the main thread via MessagePort.
 *
 * Messages sent:
 *   { type: 'level', value: number }   — RMS level (0–1) over ~16 ms (768 samples)
 *   { type: 'data', samples: Float32Array } — PCM chunk, every ~100 ms
 *
 * The level is aggregated over 6 render quanta instead of posted per 128-sample
 * block: 62.5 instead of 375 messages per second on the renderer main thread,
 * which also forwards the PCM chunks. ~16 ms keeps one level per 60-Hz frame,
 * so the VU meter's per-value smoothing behaves as before.
 */

const LEVEL_WINDOW = 768 // 6 × 128 samples ≈ 16 ms at 48 kHz

// eslint-disable-next-line no-undef
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._bufferSize = 4800 // ~100 ms at 48 kHz
    this._buffer = new Float32Array(this._bufferSize)
    this._writePos = 0
    this._levelSumSquares = 0
    this._levelSampleCount = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true

    const channel = input[0]

    // Accumulate RMS for the VU meter, post once per LEVEL_WINDOW
    for (let i = 0; i < channel.length; i++) {
      this._levelSumSquares += channel[i] * channel[i]
    }
    this._levelSampleCount += channel.length
    if (this._levelSampleCount >= LEVEL_WINDOW) {
      const rms = Math.sqrt(this._levelSumSquares / this._levelSampleCount)
      this.port.postMessage({ type: 'level', value: rms })
      this._levelSumSquares = 0
      this._levelSampleCount = 0
    }

    // Copy samples into pre-allocated buffer
    const remaining = this._bufferSize - this._writePos
    if (channel.length <= remaining) {
      this._buffer.set(channel, this._writePos)
      this._writePos += channel.length
    } else {
      // Fill current buffer, send it, then start a new one with overflow
      this._buffer.set(channel.subarray(0, remaining), this._writePos)
      this._writePos = this._bufferSize

      // Handle overflow into new buffer
      const overflow = channel.subarray(remaining)
      this.port.postMessage({
        type: 'data',
        samples: this._buffer
      })
      this._buffer = new Float32Array(this._bufferSize)
      this._buffer.set(overflow, 0)
      this._writePos = overflow.length
      return true
    }

    // Send buffered chunk when full (~100 ms)
    if (this._writePos >= this._bufferSize) {
      this.port.postMessage({
        type: 'data',
        samples: this._buffer
      })
      this._buffer = new Float32Array(this._bufferSize)
      this._writePos = 0
    }

    return true
  }
}

// eslint-disable-next-line no-undef
registerProcessor('audio-processor', AudioProcessor)
