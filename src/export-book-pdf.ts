import 'dotenv/config'

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import PDFDocument from 'pdfkit'
import sharp from 'sharp'

import type { BookMetadata, ContentChunk } from './types'
import { assert, getEnv } from './utils'

// Build a PDF directly from the captured page screenshots when no transcribed
// text is available. Each image becomes one page, sized to the image so the
// scan isn't scaled or cropped.
async function renderImagePdf({
  outDir,
  metadata
}: {
  outDir: string
  metadata: BookMetadata
}) {
  assert(metadata.pages?.length, 'no page screenshots found')

  const title = metadata.meta.title
  const authors = metadata.meta.authorList

  const doc = new PDFDocument({
    autoFirstPage: false,
    displayTitle: true,
    info: {
      Title: title,
      Author: authors.join(', ')
    }
  })
  const stream = doc.pipe(fs.createWriteStream(path.join(outDir, 'book.pdf')))

  const pages = [...metadata.pages].sort((a, b) => a.index - b.index)

  for (const pageChunk of pages) {
    const buffer = await fsp.readFile(pageChunk.screenshot)
    const { width, height } = await sharp(buffer).metadata()
    assert(
      width && height,
      `invalid screenshot dimensions: ${pageChunk.screenshot}`
    )

    doc.addPage({ size: [width, height], margin: 0 })
    doc.image(buffer, 0, 0, { width, height })
  }

  doc.end()
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', resolve)
    stream.on('error', reject)
  })
}

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)

  const metadata = JSON.parse(
    await fsp.readFile(path.join(outDir, 'metadata.json'), 'utf8')
  ) as BookMetadata
  assert(metadata.meta, 'invalid book metadata: missing meta')

  // Transcribed text is optional. If `content.json` doesn't exist (e.g. the AI
  // transcription step was skipped), build the PDF directly from the captured
  // page images instead.
  const content = await fsp
    .readFile(path.join(outDir, 'content.json'), 'utf8')
    .then((raw) => JSON.parse(raw) as ContentChunk[])
    .catch((err: any) => {
      if (err?.code === 'ENOENT') return undefined
      throw err
    })

  if (!content?.length) {
    await renderImagePdf({ outDir, metadata })
    return
  }

  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  const title = metadata.meta.title
  const authors = metadata.meta.authorList

  const doc = new PDFDocument({
    autoFirstPage: true,
    displayTitle: true,
    info: {
      Title: title,
      Author: authors.join(', ')
    }
  })
  const stream = doc.pipe(fs.createWriteStream(path.join(outDir, 'book.pdf')))

  const fontSize = 12

  const renderTitlePage = () => {
    ;(doc as any).outline.addItem('Title Page')
    doc.fontSize(48)
    doc.y = doc.page.height / 2 - doc.heightOfString(title) / 2
    doc.text(title, { align: 'center' })
    const w = doc.widthOfString(title)

    const byline = `By ${authors.join(',\n')}`

    doc.fontSize(20)
    doc.y -= doc.heightOfString(byline) / 2
    doc.text(byline, {
      align: 'center',
      indent: w - doc.widthOfString(byline)
    })

    doc.addPage()
    doc.fontSize(fontSize)
  }

  renderTitlePage()

  // Skip front-matter entries with page=0 (roman-numeral pages not captured)
  const validToc = metadata.toc.filter(
    (item) => item.page != null && item.page > 0
  )

  let needsNewPage = false
  let index = 0

  for (let i = 0; i < validToc.length; i++) {
    const tocItem = validToc[i]!
    const nextTocItem = validToc[i + 1]

    const rawNext = nextTocItem
      ? content.findIndex((c) => c.page >= nextTocItem.page!)
      : -1
    const nextIndex = rawNext === -1 ? content.length : rawNext

    if (nextIndex < index) continue

    if (needsNewPage) {
      doc.addPage()
    }

    // Aggregate all of the chunks in this chapter into a single string.
    const chunks = content.slice(index, nextIndex)
    const text = chunks.map((chunk) => chunk.text).join(' ')

    ;(doc as any).outline.addItem(tocItem.label)
    doc.fontSize(tocItem.depth === 1 ? 16 : 20)
    doc.text(tocItem.label, { align: 'center', lineGap: 16 })

    doc.fontSize(fontSize)
    doc.moveDown(1)

    if (text) {
      doc.text(text, {
        indent: 20,
        lineGap: 4,
        paragraphGap: 8
      })
    }

    index = nextIndex
    needsNewPage = true
  }

  doc.end()
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', resolve)
    stream.on('error', reject)
  })
}

await main()
