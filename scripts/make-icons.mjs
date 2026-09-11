/**
 * Generates the extension icons.
 *
 * Hand-rolled PNG encoding rather than a dependency: the icons are three flat
 * glyphs and pulling in an image library to draw a rounded square with a check
 * mark would be more code than this, not less.
 *
 * Run with: node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

const INK = [24, 28, 36, 255]
const ACCENT = [48, 84, 216, 255]
const PAPER = [255, 255, 255, 255]

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

function encodePng(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let offset = 0
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y)
      raw[offset++] = r
      raw[offset++] = g
      raw[offset++] = b
      raw[offset++] = a
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Signed distance to a rounded rectangle, for cheap antialiasing. */
function roundedRectDistance(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius)
  const dy = Math.abs(y - cy) - (halfH - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}

function blend(bottom, top, alpha) {
  return [
    Math.round(bottom[0] * (1 - alpha) + top[0] * alpha),
    Math.round(bottom[1] * (1 - alpha) + top[1] * alpha),
    Math.round(bottom[2] * (1 - alpha) + top[2] * alpha),
    Math.max(bottom[3], Math.round(255 * alpha)),
  ]
}

/**
 * The mark: a dark rounded square (the form) with an accent bar down the left
 * (the agent) and two light bars across it (the answers being filled in).
 */
function makeIcon(size) {
  const s = size
  const unit = s / 16

  return (x, y) => {
    const px = x + 0.5
    const py = y + 0.5

    const bodyDist = roundedRectDistance(px, py, s / 2, s / 2, s / 2 - unit * 0.5, s / 2 - unit * 0.5, unit * 3.2)
    const bodyAlpha = Math.min(Math.max(0.5 - bodyDist, 0), 1)
    if (bodyAlpha <= 0) return [0, 0, 0, 0]

    let color = [INK[0], INK[1], INK[2], 255]

    // Accent spine on the left.
    const spine = roundedRectDistance(px, py, unit * 4, s / 2, unit * 0.9, s / 2 - unit * 4, unit * 0.9)
    const spineAlpha = Math.min(Math.max(0.5 - spine, 0), 1)
    if (spineAlpha > 0) color = blend(color, ACCENT, spineAlpha)

    // Two filled rows to the right of the spine.
    for (const [cy, halfW] of [
      [s / 2 - unit * 2.1, unit * 3.4],
      [s / 2 + unit * 1.2, unit * 2.2],
    ]) {
      const bar = roundedRectDistance(px, py, unit * 6.6 + halfW, cy, halfW, unit * 0.75, unit * 0.75)
      const alpha = Math.min(Math.max(0.5 - bar, 0), 1)
      if (alpha > 0) color = blend(color, PAPER, alpha * 0.92)
    }

    return [color[0], color[1], color[2], Math.round(255 * bodyAlpha)]
  }
}

mkdirSync(OUT_DIR, { recursive: true })
for (const size of [16, 48, 128]) {
  const png = encodePng(size, makeIcon(size))
  writeFileSync(resolve(OUT_DIR, `${size}.png`), png)
  console.log(`wrote icons/${size}.png (${png.length} bytes)`)
}
