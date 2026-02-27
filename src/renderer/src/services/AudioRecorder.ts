const SAMPLE_RATE = 48000
const BUFFER_TARGET = SAMPLE_RATE // ~1 second of audio before flushing to main

export type LevelCallback = (level: number) => void

export class AudioRecorder {
  private audioContext: AudioContext | null = null
  private workletNode: AudioWorkletNode | null = null
  private mediaStream: MediaStream | null = null
  private sessionId: string | null = null
  private buffer: Float32Array[] = []
  private bufferSampleCount = 0
  private onLevel: LevelCallback | null = null

  async start(onLevel: LevelCallback): Promise<string> {
    this.onLevel = onLevel

    // Request microphone access (mono, raw — no processing)
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: SAMPLE_RATE
      },
      video: false
    })

    // Create session in main process
    const { sessionId } = await window.api.recording.start()
    this.sessionId = sessionId

    // Set up AudioContext + WorkletNode
    this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })

    await this.audioContext.audioWorklet.addModule(
      new URL('/audio-processor.worklet.js', import.meta.url).href
    )

    this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-processor')

    this.workletNode.port.onmessage = (event: MessageEvent) => {
      this.handleWorkletMessage(event.data)
    }

    // Connect: mic → worklet
    const source = this.audioContext.createMediaStreamSource(this.mediaStream)
    source.connect(this.workletNode)
    // Don't connect worklet to destination (no playback / feedback)

    return sessionId
  }

  async stop(): Promise<void> {
    const sessionId = this.sessionId
    if (!sessionId) return

    // Flush remaining buffer
    this.flushBuffer()

    // Clean up audio resources
    if (this.workletNode) {
      this.workletNode.port.onmessage = null
      this.workletNode.disconnect()
      this.workletNode = null
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop()
      }
      this.mediaStream = null
    }

    if (this.audioContext) {
      await this.audioContext.close()
      this.audioContext = null
    }

    // Tell main process to finalize
    await window.api.recording.stop(sessionId)

    this.sessionId = null
    this.onLevel = null
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  private handleWorkletMessage(data: {
    type: string
    value?: number
    samples?: Float32Array
  }): void {
    if (data.type === 'level' && data.value !== undefined) {
      this.onLevel?.(data.value)
      return
    }

    if (data.type === 'data' && data.samples) {
      this.buffer.push(data.samples)
      this.bufferSampleCount += data.samples.length

      if (this.bufferSampleCount >= BUFFER_TARGET) {
        this.flushBuffer()
      }
    }
  }

  private flushBuffer(): void {
    if (this.buffer.length === 0 || !this.sessionId) return

    // Merge chunks into a single Float32Array
    const merged = new Float32Array(this.bufferSampleCount)
    let offset = 0
    for (const chunk of this.buffer) {
      merged.set(chunk, offset)
      offset += chunk.length
    }

    // Send to main process (fire-and-forget via send)
    window.api.recording.sendData(this.sessionId, merged.buffer)

    this.buffer = []
    this.bufferSampleCount = 0
  }
}
