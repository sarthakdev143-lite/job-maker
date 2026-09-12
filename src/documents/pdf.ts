/**
 * PDF rendering.
 *
 * Built with pdf-lib and the standard PDF fonts, which means this runs directly
 * in the service worker with no DOM and no offscreen document. Using the
 * built-in fonts rather than embedding one also keeps the file small and, more
 * importantly, keeps the text as real text: a resume rendered to an image is
 * unreadable to the parser on the other end and will score zero.
 *
 * The layout is deliberately plain -- single column, no tables, no graphics,
 * standard section headings. That is what ATS parsers handle reliably, and a
 * handsome two-column resume that parses into gibberish is worse than a dull
 * one that parses cleanly.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { Profile } from '@/storage/schemas'
import type { TailoredResume } from '@/storage/schemas'

const PAGE_WIDTH = 612 // US Letter, the safe default for ATS parsers
const PAGE_HEIGHT = 792
const MARGIN = 54
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2

const INK = rgb(0.08, 0.09, 0.11)
const MUTED = rgb(0.38, 0.4, 0.44)
const RULE = rgb(0.78, 0.79, 0.81)

type Ctx = {
  doc: PDFDocument
  page: PDFPage
  y: number
  regular: PDFFont
  bold: PDFFont
  italic: PDFFont
}

/**
 * pdf-lib returns a Uint8Array whose buffer is typed as ArrayBufferLike; Blob
 * wants a plain ArrayBuffer, so copy out the exact byte range.
 */
function toPdfBlob(bytes: Uint8Array): Blob {
  const copy = bytes.slice()
  return new Blob([copy.buffer as ArrayBuffer], { type: 'application/pdf' })
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  ctx.y = PAGE_HEIGHT - MARGIN
}

function ensureRoom(ctx: Ctx, needed: number): void {
  if (ctx.y - needed < MARGIN) newPage(ctx)
}

/** Greedy word wrap against the font's real measured width. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate
    } else {
      if (current) lines.push(current)
      // A single word longer than the line gets hard-broken rather than dropped.
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        let chunk = ''
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
            lines.push(chunk)
            chunk = ch
          } else {
            chunk += ch
          }
        }
        current = chunk
      } else {
        current = word
      }
    }
  }
  if (current) lines.push(current)
  return lines
}

/** pdf-lib's standard fonts are WinAnsi; anything outside it throws on draw. */
function sanitize(text: string): string {
  return String(text ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/•/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E\n]/g, '')
}

function drawLines(
  ctx: Ctx,
  text: string,
  opts: { font: PDFFont; size: number; color?: ReturnType<typeof rgb>; indent?: number; leading?: number }
): void {
  const indent = opts.indent ?? 0
  const leading = opts.leading ?? opts.size * 1.35
  const lines = wrap(sanitize(text), opts.font, opts.size, CONTENT_WIDTH - indent)
  for (const line of lines) {
    ensureRoom(ctx, leading)
    ctx.page.drawText(line, {
      x: MARGIN + indent,
      y: ctx.y - opts.size,
      size: opts.size,
      font: opts.font,
      color: opts.color ?? INK,
    })
    ctx.y -= leading
  }
}

function sectionHeading(ctx: Ctx, title: string): void {
  ensureRoom(ctx, 34)
  ctx.y -= 10
  ctx.page.drawText(sanitize(title.toUpperCase()), {
    x: MARGIN,
    y: ctx.y - 9,
    size: 9,
    font: ctx.bold,
    color: MUTED,
  })
  ctx.y -= 14
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: PAGE_WIDTH - MARGIN, y: ctx.y },
    thickness: 0.6,
    color: RULE,
  })
  ctx.y -= 10
}

function contactLine(profile: Profile): string {
  return [
    profile.email,
    `${profile.phoneCountryCode} ${profile.phone}`.trim(),
    [profile.city, profile.state, profile.country].filter(Boolean).join(', '),
    profile.linkedin,
    profile.github,
    profile.portfolio,
  ]
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .join('  |  ')
}

function formatRange(start: string, end: string, current: boolean): string {
  const fmt = (v: string): string => {
    if (!v) return ''
    const [year, month] = v.split('-')
    if (!month) return year ?? ''
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const idx = Number(month) - 1
    return `${names[idx] ?? ''} ${year}`.trim()
  }
  const from = fmt(start)
  const to = current ? 'Present' : fmt(end)
  return [from, to].filter(Boolean).join(' - ')
}

/**
 * Render a resume. `tailored` overrides the summary, per-role bullets and skill
 * order when present; without it the profile is rendered as written.
 */
export async function renderResumePdf(profile: Profile, tailored?: TailoredResume | null): Promise<Blob> {
  const doc = await PDFDocument.create()
  doc.setTitle(`${profile.firstName} ${profile.lastName} - Resume`)
  doc.setAuthor(`${profile.firstName} ${profile.lastName}`)
  doc.setCreator('AutoApply')

  const ctx: Ctx = {
    doc,
    page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    y: PAGE_HEIGHT - MARGIN,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  }

  // Header
  const fullName = `${profile.firstName} ${profile.lastName}`.trim() || 'Candidate'
  ensureRoom(ctx, 40)
  ctx.page.drawText(sanitize(fullName), { x: MARGIN, y: ctx.y - 22, size: 22, font: ctx.bold, color: INK })
  ctx.y -= 30

  const headline = tailored?.summary ? profile.headline : profile.headline
  if (headline) {
    drawLines(ctx, headline, { font: ctx.italic, size: 10.5, color: MUTED })
  }
  drawLines(ctx, contactLine(profile), { font: ctx.regular, size: 9, color: MUTED, leading: 12 })

  // Summary
  const summary = tailored?.summary?.trim() || profile.summary.trim()
  if (summary) {
    sectionHeading(ctx, 'Summary')
    drawLines(ctx, summary, { font: ctx.regular, size: 10, leading: 13.5 })
  }

  // Experience
  if (profile.experience.length > 0) {
    sectionHeading(ctx, 'Experience')
    const bulletsFor = (roleId: string): string[] | null => {
      const hit = tailored?.roles.find((r) => r.id === roleId)
      return hit && hit.bullets.length > 0 ? hit.bullets : null
    }

    for (const role of profile.experience) {
      ensureRoom(ctx, 46)
      const heading = `${role.title}${role.company ? `, ${role.company}` : ''}`
      ctx.page.drawText(sanitize(heading), { x: MARGIN, y: ctx.y - 11, size: 11, font: ctx.bold, color: INK })

      const dates = formatRange(role.startDate, role.endDate, role.current)
      const meta = [role.location, dates].filter(Boolean).join('  |  ')
      if (meta) {
        const width = ctx.regular.widthOfTextAtSize(sanitize(meta), 9)
        ctx.page.drawText(sanitize(meta), {
          x: PAGE_WIDTH - MARGIN - width,
          y: ctx.y - 11,
          size: 9,
          font: ctx.regular,
          color: MUTED,
        })
      }
      ctx.y -= 18

      for (const bullet of bulletsFor(role.id) ?? role.bullets) {
        ensureRoom(ctx, 14)
        ctx.page.drawText('-', { x: MARGIN + 4, y: ctx.y - 10, size: 10, font: ctx.regular, color: MUTED })
        drawLines(ctx, bullet, { font: ctx.regular, size: 10, indent: 16, leading: 13 })
      }
      ctx.y -= 6
    }
  }

  // Education
  if (profile.education.length > 0) {
    sectionHeading(ctx, 'Education')
    for (const ed of profile.education) {
      ensureRoom(ctx, 26)
      const line = [ed.degree, ed.field].filter(Boolean).join(', ')
      ctx.page.drawText(sanitize(line || ed.school), { x: MARGIN, y: ctx.y - 11, size: 10.5, font: ctx.bold, color: INK })
      const right = [ed.school !== line ? ed.school : '', formatRange(ed.startDate, ed.endDate, false)]
        .filter(Boolean)
        .join('  |  ')
      if (right) {
        const width = ctx.regular.widthOfTextAtSize(sanitize(right), 9)
        ctx.page.drawText(sanitize(right), {
          x: PAGE_WIDTH - MARGIN - width,
          y: ctx.y - 11,
          size: 9,
          font: ctx.regular,
          color: MUTED,
        })
      }
      ctx.y -= 18
    }
  }

  // Skills, reordered by the tailoring pass when it ran
  const skills = tailored?.skillsOrder?.length ? tailored.skillsOrder : profile.skills
  if (skills.length > 0) {
    sectionHeading(ctx, 'Skills')
    drawLines(ctx, skills.join(' - '), { font: ctx.regular, size: 10, leading: 13.5 })
  }

  if (profile.certifications.length > 0) {
    sectionHeading(ctx, 'Certifications')
    drawLines(ctx, profile.certifications.join(' - '), { font: ctx.regular, size: 10, leading: 13.5 })
  }

  if (profile.languages.length > 0) {
    sectionHeading(ctx, 'Languages')
    drawLines(ctx, profile.languages.join(' - '), { font: ctx.regular, size: 10, leading: 13.5 })
  }

  return toPdfBlob(await doc.save())
}

/** Cover letter on the same letterhead as the resume, for a consistent pair. */
export async function renderCoverLetterPdf(
  profile: Profile,
  body: string,
  meta: { company: string; title: string }
): Promise<Blob> {
  const doc = await PDFDocument.create()
  doc.setTitle(`${profile.firstName} ${profile.lastName} - Cover Letter`)
  doc.setAuthor(`${profile.firstName} ${profile.lastName}`)

  const ctx: Ctx = {
    doc,
    page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    y: PAGE_HEIGHT - MARGIN,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  }

  const fullName = `${profile.firstName} ${profile.lastName}`.trim() || 'Candidate'
  ctx.page.drawText(sanitize(fullName), { x: MARGIN, y: ctx.y - 20, size: 18, font: ctx.bold, color: INK })
  ctx.y -= 28
  drawLines(ctx, contactLine(profile), { font: ctx.regular, size: 9, color: MUTED, leading: 12 })
  ctx.y -= 10

  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: PAGE_WIDTH - MARGIN, y: ctx.y },
    thickness: 0.6,
    color: RULE,
  })
  ctx.y -= 24

  const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  drawLines(ctx, today, { font: ctx.regular, size: 10, color: MUTED, leading: 16 })
  ctx.y -= 6

  if (meta.company) {
    drawLines(ctx, `Hiring Team, ${meta.company}`, { font: ctx.regular, size: 10, leading: 14 })
  }
  if (meta.title) {
    drawLines(ctx, `Re: ${meta.title}`, { font: ctx.bold, size: 10, leading: 18 })
  }
  ctx.y -= 6

  for (const paragraph of String(body ?? '').split(/\n{2,}/)) {
    if (!paragraph.trim()) continue
    drawLines(ctx, paragraph.trim(), { font: ctx.regular, size: 10.5, leading: 15 })
    ctx.y -= 8
  }

  ctx.y -= 6
  drawLines(ctx, 'Regards,', { font: ctx.regular, size: 10.5, leading: 15 })
  drawLines(ctx, fullName, { font: ctx.regular, size: 10.5, leading: 15 })

  return toPdfBlob(await doc.save())
}

/** Blobs cannot cross the messaging boundary; content scripts get a data URL. */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return `data:${blob.type || 'application/pdf'};base64,${btoa(binary)}`
}
