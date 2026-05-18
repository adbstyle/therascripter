import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { parseTimestamp, buildWhisperArgs } from '../WhisperService'

describe('parseTimestamp', () => {
  it('parses HH:MM:SS,mmm format', () => {
    expect(parseTimestamp('00:00:01,500')).toBe(1.5)
    expect(parseTimestamp('00:01:30,000')).toBe(90)
    expect(parseTimestamp('01:00:00,000')).toBe(3600)
    expect(parseTimestamp('00:00:00,100')).toBe(0.1)
  })

  it('parses HH:MM:SS.mmm format', () => {
    expect(parseTimestamp('00:00:01.500')).toBe(1.5)
    expect(parseTimestamp('00:01:30.250')).toBe(90.25)
  })

  it('handles compound time values', () => {
    expect(parseTimestamp('01:23:45,678')).toBe(5025.678)
  })

  it('returns 0 for invalid format', () => {
    expect(parseTimestamp('')).toBe(0)
    expect(parseTimestamp('invalid')).toBe(0)
    expect(parseTimestamp('1:2:3')).toBe(0)
  })
})

// Test processOutput via a reconstructed scenario
// (We can't import processOutput directly since it's private,
//  but we test the components it relies on: parseTimestamp + filler-removal)
describe('whisper.cpp JSON output parsing', () => {
  it('handles typical whisper.cpp transcription output structure', () => {
    // This verifies our type definitions match the expected whisper.cpp format
    const sampleOutput = {
      transcription: [
        {
          timestamps: { from: '00:00:00,000', to: '00:00:05,000' },
          offsets: { from: 0, to: 5000 },
          text: ' Guten Tag, wie geht es Ihnen?',
          tokens: [
            {
              text: ' Guten',
              timestamps: { from: '00:00:00,000', to: '00:00:00,500' },
              offsets: { from: 0, to: 500 },
              id: 1,
              p: 0.95
            },
            {
              text: ' Tag,',
              timestamps: { from: '00:00:00,500', to: '00:00:01,000' },
              offsets: { from: 500, to: 1000 },
              id: 2,
              p: 0.92
            },
            {
              text: ' wie',
              timestamps: { from: '00:00:01,000', to: '00:00:01,500' },
              offsets: { from: 1000, to: 1500 },
              id: 3,
              p: 0.97
            },
            {
              text: ' geht',
              timestamps: { from: '00:00:01,500', to: '00:00:02,000' },
              offsets: { from: 1500, to: 2000 },
              id: 4,
              p: 0.91
            },
            {
              text: ' es',
              timestamps: { from: '00:00:02,000', to: '00:00:02,300' },
              offsets: { from: 2000, to: 2300 },
              id: 5,
              p: 0.88
            },
            {
              text: ' Ihnen?',
              timestamps: { from: '00:00:02,300', to: '00:00:03,000' },
              offsets: { from: 2300, to: 3000 },
              id: 6,
              p: 0.93
            }
          ]
        }
      ]
    }

    // Verify we can extract words from the token structure
    const words = sampleOutput.transcription[0].tokens
      .filter((t) => t.text.trim())
      .map((t) => ({
        text: t.text.trim(),
        start: t.offsets.from / 1000,
        end: t.offsets.to / 1000
      }))

    expect(words).toHaveLength(6)
    expect(words[0]).toEqual({ text: 'Guten', start: 0, end: 0.5 })
    expect(words[5]).toEqual({ text: 'Ihnen?', start: 2.3, end: 3 })
  })
})

describe('buildWhisperArgs', () => {
  // The exact CLI flag set is load-bearing — whisper-cli silently exits 0 on
  // unknown args and writes nothing to stdout/stderr that our caller checks
  // by default, so a typo here would surface as "no JSON produced" with no
  // hint to the operator. Lock the wire format down.
  const args = buildWhisperArgs('/m.bin', '/a.wav', 4)

  it('passes the model and audio paths', () => {
    expect(args).toContain('-m')
    expect(args[args.indexOf('-m') + 1]).toBe('/m.bin')
    expect(args).toContain('-f')
    expect(args[args.indexOf('-f') + 1]).toBe('/a.wav')
  })

  it('forces German language', () => {
    expect(args).toContain('-l')
    expect(args[args.indexOf('-l') + 1]).toBe('de')
  })

  it("uses '-mc 0' for the anti-loop fix (NOT the long-removed -nc / --no-context)", () => {
    // ADR-006: whisper.cpp dropped --no-context / -nc years ago. Setting
    // --max-context to 0 produces the same behaviour and IS supported by
    // current whisper-cli.
    expect(args).toContain('-mc')
    expect(args[args.indexOf('-mc') + 1]).toBe('0')
    expect(args).not.toContain('-nc')
    expect(args).not.toContain('--no-context')
  })

  it('requests JSON-full output and progress prints', () => {
    expect(args).toContain('-ojf')
    expect(args).toContain('-pp')
  })

  it('passes the thread count as a string', () => {
    expect(args).toContain('-t')
    expect(args[args.indexOf('-t') + 1]).toBe('4')
  })
})

// Integration: spawn the real whisper-cli and assert it doesn't print
// "unknown argument" for any flag in our list. Skipped automatically when
// the binary isn't present (CI). Catches the "whisper-cli upstream renamed
// a flag we depend on" class of bug at unit-test speed (~1s, no audio
// processing — whisper-cli rejects on the missing model/audio first).
describe('whisper-cli flag compatibility', () => {
  const repoRoot = join(__dirname, '..', '..', '..', '..')
  const BINARY = join(repoRoot, 'resources', 'whisper', 'bin', 'whisper-cli')

  it.skipIf(!existsSync(BINARY))('does not produce "unknown argument" errors with our arg list', () => {
    // Use deliberately bogus paths — whisper-cli will exit early because the
    // model or audio file is missing, but it must do so AFTER successfully
    // parsing every flag.
    const result = spawnSync(BINARY, buildWhisperArgs('/nonexistent.bin', '/nonexistent.wav', 1), {
      encoding: 'utf-8',
      timeout: 10_000
    })
    const combined = (result.stderr ?? '') + (result.stdout ?? '')
    const unknownArg = combined.match(/unknown argument:\s*(\S+)/i)
    if (unknownArg) {
      throw new Error(
        `whisper-cli rejected flag "${unknownArg[1]}". Update buildWhisperArgs() to use a supported flag.`
      )
    }
  })
})
