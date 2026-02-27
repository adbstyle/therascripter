import { nativeImage } from 'electron'
import type { NativeImage } from 'electron'
import { deflateSync } from 'zlib'

/**
 * Generates monochrome 32x32 template images for the macOS menu bar tray.
 * Template images are rendered at 16x16 pt (@2x = 32x32 px) and macOS
 * automatically adapts them for dark/light mode.
 *
 * Uses raw PNG generation to avoid external Canvas dependencies.
 */

const SIZE = 32 // 16pt @2x
const CENTER = SIZE / 2
const RADIUS = 6 // Circle radius in pixels at @2x

function createPngBuffer(pixels: Buffer): Buffer {
  // PNG file format: signature + IHDR + IDAT + IEND
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  // IHDR chunk: width, height, bit depth (8), color type (6 = RGBA)
  const ihdr = createChunk(
    'IHDR',
    Buffer.from([
      ...uint32(SIZE),
      ...uint32(SIZE),
      8, // bit depth
      6, // color type: RGBA
      0, // compression
      0, // filter
      0 // interlace
    ])
  )

  // IDAT chunk: filtered + deflated pixel data
  // Each row is prefixed with filter byte (0 = None)
  const rowSize = 1 + SIZE * 4 // filter byte + RGBA
  const filtered = Buffer.alloc(SIZE * rowSize)
  for (let y = 0; y < SIZE; y++) {
    filtered[y * rowSize] = 0 // filter: None
    pixels.copy(filtered, y * rowSize + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
  }
  const idat = createChunk('IDAT', deflateSync(filtered))

  // IEND chunk
  const iend = createChunk('IEND', Buffer.alloc(0))

  return Buffer.concat([signature, ihdr, idat, iend])
}

function createChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)

  const typeBuffer = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuffer, data])

  const crc = crc32(body)
  const crcBuffer = Buffer.alloc(4)
  crcBuffer.writeUInt32BE(crc >>> 0)

  return Buffer.concat([length, body, crcBuffer])
}

function uint32(value: number): number[] {
  return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

// CRC-32 lookup table
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  crcTable[n] = c
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return crc ^ 0xffffffff
}

function setPixel(pixels: Buffer, x: number, y: number, alpha: number): void {
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return
  const offset = (y * SIZE + x) * 4
  // Template images: macOS uses alpha channel with black pixels
  pixels[offset] = 0 // R
  pixels[offset + 1] = 0 // G
  pixels[offset + 2] = 0 // B
  pixels[offset + 3] = Math.min(255, Math.max(0, Math.round(alpha)))
}

function drawFilledCircle(pixels: Buffer): void {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - CENTER + 0.5
      const dy = y - CENTER + 0.5
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (dist <= RADIUS - 0.5) {
        setPixel(pixels, x, y, 255)
      } else if (dist <= RADIUS + 0.5) {
        // Anti-aliased edge
        const alpha = (RADIUS + 0.5 - dist) * 255
        setPixel(pixels, x, y, alpha)
      }
    }
  }
}

function drawCircleOutline(pixels: Buffer): void {
  const strokeWidth = 1.5
  const innerRadius = RADIUS - strokeWidth
  const outerRadius = RADIUS

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - CENTER + 0.5
      const dy = y - CENTER + 0.5
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (dist >= innerRadius - 0.5 && dist <= outerRadius + 0.5) {
        let alpha = 255
        if (dist < innerRadius + 0.5) {
          alpha = (dist - innerRadius + 0.5) * 255
        } else if (dist > outerRadius - 0.5) {
          alpha = (outerRadius + 0.5 - dist) * 255
        }
        setPixel(pixels, x, y, alpha)
      }
    }
  }
}

export function generateIdleIcon(): NativeImage {
  const pixels = Buffer.alloc(SIZE * SIZE * 4, 0)
  drawCircleOutline(pixels)
  const png = createPngBuffer(pixels)
  const image = nativeImage.createFromBuffer(png, { scaleFactor: 2 })
  image.setTemplateImage(true)
  return image
}

export function generateRecordingIcon(): NativeImage {
  const pixels = Buffer.alloc(SIZE * SIZE * 4, 0)
  drawFilledCircle(pixels)
  const png = createPngBuffer(pixels)
  const image = nativeImage.createFromBuffer(png, { scaleFactor: 2 })
  image.setTemplateImage(true)
  return image
}
