/**
 * Getting text out of whatever file the user drops on the page.
 *
 * This runs in the options page rather than the service worker because pdf.js
 * wants a DOM, and because the file never needs to leave the page: only the
 * extracted text is sent to the worker.
 *
 * PDF text extraction is imperfect by nature -- a PDF stores glyph positions,
 * not paragraphs -- so the goal here is not a faithful reproduction of the
 * layout but a clean linear reading order that a model can make sense of.
 */

const PDF_MIME = 'application/pdf'

export type ExtractResult = {
  text: string
  pages: number
  kind: 'pdf' | 'text' | 'docx'
}

export async function extractResumeText(file: File): Promise<ExtractResult> {
  const name = file.name.toLowerCase()

  if (file.type === PDF_MIME || name.endsWith('.pdf')) {
    return extractFromPdf(file)
  }
  if (name.endsWith('.docx')) {
    return { text: await extractFromDocx(file), pages: 0, kind: 'docx' }
  }
  if (file.type.startsWith('text/') || /\.(txt|md|rtf)$/.test(name)) {
    return { text: await file.text(), pages: 0, kind: 'text' }
  }
  throw new Error(`Cannot read ${file.name}. Upload a PDF, a .docx, or a plain text file - or paste the text instead.`)
}

/* -------------------------------------------------------------------- pdf */

async function extractFromPdf(file: File): Promise<ExtractResult> {
  const pdfjs = await import('pdfjs-dist')

  // The worker is bundled with the extension, so it loads under the page's own
  // origin and satisfies the extension CSP. Without this, pdf.js reaches for a
  // CDN and is blocked.
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

  const data = new Uint8Array(await file.arrayBuffer())
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true })
  const doc = await loadingTask.promise
  const pageCount = doc.numPages

  const pages: string[] = []
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = await doc.getPage(pageNumber)
    const content = await page.getTextContent()
    pages.push(joinTextItems(content.items as TextItem[]))
    page.cleanup()
  }
  // Releasing the loading task tears down the worker; leaking one per import
  // would leave a thread running for every resume the user tries.
  await loadingTask.destroy()

  return { text: pages.join('\n\n').trim(), pages: pageCount, kind: 'pdf' }
}

type TextItem = {
  str: string
  transform: number[]
  width: number
  height: number
  hasEOL?: boolean
}

/**
 * Reassemble text items into lines.
 *
 * pdf.js emits a run of glyphs at a time with no notion of a line, so items are
 * grouped by their baseline y coordinate and then ordered left to right. Items
 * on the same baseline that are far apart horizontally get a gap between them,
 * which is what keeps a two-column resume from reading as interleaved nonsense
 * on every line.
 */
function joinTextItems(items: TextItem[]): string {
  const lines = new Map<number, TextItem[]>()

  for (const item of items) {
    if (!item.str) continue
    const y = Math.round((item.transform?.[5] ?? 0) * 2) / 2 // half-point buckets
    const bucket = lines.get(y)
    if (bucket) bucket.push(item)
    else lines.set(y, [item])
  }

  const ordered = Array.from(lines.entries()).sort((a, b) => b[0] - a[0]) // top down
  const out: string[] = []

  for (const [, lineItems] of ordered) {
    lineItems.sort((a, b) => (a.transform?.[4] ?? 0) - (b.transform?.[4] ?? 0))
    let text = ''
    let previousEnd: number | null = null

    for (const item of lineItems) {
      const x = item.transform?.[4] ?? 0
      if (previousEnd !== null) {
        const gap = x - previousEnd
        // A gap wider than roughly two spaces is a column break or a tab stop.
        if (gap > (item.height || 10) * 1.2) text += '   '
        else if (gap > 1 && !text.endsWith(' ')) text += ' '
      }
      text += item.str
      previousEnd = x + (item.width ?? 0)
    }

    const trimmed = text.trim()
    if (trimmed) out.push(trimmed)
  }

  return out.join('\n')
}

/* ------------------------------------------------------------------- docx */

/**
 * A .docx is a zip of XML. Rather than pull in a Word parser for one feature,
 * this reads the stored (uncompressed) and deflated entries it needs and strips
 * the tags. It handles the files Word and Google Docs produce; anything exotic
 * falls back to asking the user to paste the text.
 */
async function extractFromDocx(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const xml = await readZipEntry(buffer, 'word/document.xml')
  if (!xml) {
    throw new Error('Could not read that .docx. Export it as a PDF, or paste the text instead.')
  }
  return xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Minimal zip reader: finds one entry by name and inflates it. */
async function readZipEntry(buffer: ArrayBuffer, wanted: string): Promise<string | null> {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  const decoder = new TextDecoder()

  // Walk local file headers rather than the central directory; a resume-sized
  // docx has a handful of entries and the first match is the one we want.
  let offset = 0
  while (offset + 30 < bytes.length) {
    if (view.getUint32(offset, true) !== 0x04034b50) break

    const method = view.getUint16(offset + 8, true)
    const compressedSize = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const nameStart = offset + 30
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength))
    const dataStart = nameStart + nameLength + extraLength

    if (name === wanted) {
      const data = bytes.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return decoder.decode(data)
      if (method === 8) {
        const stream = new Blob([data as unknown as BlobPart])
          .stream()
          .pipeThrough(new DecompressionStream('deflate-raw'))
        return new Response(stream).text()
      }
      return null
    }

    // A streamed entry declares its size in a trailing descriptor, which this
    // simple walker cannot skip past reliably.
    if (compressedSize === 0) break
    offset = dataStart + compressedSize
  }
  return null
}
