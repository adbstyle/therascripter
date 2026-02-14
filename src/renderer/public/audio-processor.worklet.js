/**
 * AudioWorklet processor for real-time PCM audio capture.
 *
 * Runs in the audio rendering thread at real-time priority.
 * Captures mono 48 kHz audio, calculates RMS levels, and sends
 * buffered PCM chunks to the main thread via MessagePort.
 *
 * Messages sent:
 *   { type: 'level', value: number }   — RMS level (0–1), every 128 samples
 *   { type: 'data', samples: Float32Array } — PCM chunk, every ~100 ms
 */

// eslint-disable-next-line no-undef
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._bufferSize = 4800 // ~100 ms at 48 kHz
    this._buffer = new Float32Array(this._bufferSize)
    this._writePos = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true

    const channel = input[0]

    // Calculate RMS for VU meter
    let sum = 0
    for (let i = 0; i < channel.length; i++) {
      sum += channel[i] * channel[i]
    }
    const rms = Math.sqrt(sum / channel.length)
    this.port.postMessage({ type: 'level', value: rms })

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
