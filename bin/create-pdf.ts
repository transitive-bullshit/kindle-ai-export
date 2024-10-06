#!/usr/bin/env node
/* eslint-disable no-process-env */
import 'dotenv/config'

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import PDFDocument from 'pdfkit'

import { assert } from '../src/utils'

interface ContentChunk {
  index: number
  page: number
  text: string
  screenshot: string
}

interface TocItem {
  title: string
  page?: number
  location?: number
  total: number
}

interface PageChunk {
  index: number
  page: number
  total: number
  screenshot: string
}

interface Meta {
  ACR: string
  asin: string
  authorList: Array<string>
  bookSize: string
  bookType: string
  cover: string
  language: string
  positions: {
    cover: number
    srl: number
    toc: number
  }
  publisher: string
  refEmId: string
  releaseDate: string
  sample: boolean
  title: string
  version: string
  startPosition: number
  endPosition: number
}

interface Info {
  clippingLimit: number
  contentChecksum: any
  contentType: string
  contentVersion: string
  deliveredAsin: string
  downloadRestrictionReason: any
  expirationDate: any
  format: string
  formatVersion: string
  fragmentMapUrl: any
  hasAnnotations: boolean
  isOwned: boolean
  isSample: boolean
  kindleSessionId: string
  lastPageReadData: {
    deviceName: string
    position: number
    syncTime: number
  }
  manifestUrl: any
  originType: string
  pageNumberUrl: any
  requestedAsin: string
  srl: number
}

interface Metadata {
  info: Info
  meta: Meta
  toc: TocItem[]
  pages: PageChunk[]
}

async function main() {
  const asin = process.env.ASIN
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)

  const content = JSON.parse(
    await fsp.readFile(path.join(outDir, 'content.json'), 'utf8')
  ) as ContentChunk[]
  const metadata = JSON.parse(
    await fsp.readFile(path.join(outDir, 'metadata.json'), 'utf8')
  ) as Metadata

  const title = metadata.meta.title
  const author = metadata.meta.authorList.join('\n')

  const doc = new PDFDocument({
    autoFirstPage: true,
    displayTitle: true,
    info: {
      Title: title,
      Author: author
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

    const byline = `By ${author}`

    doc.fontSize(20)
    doc.y -= 10
    doc.text(byline, {
      align: 'center',
      indent: w - doc.widthOfString(byline)
    })

    doc.addPage()
    doc.fontSize(fontSize)
  }

  renderTitlePage()

  let needsNewPage = false
  let index = 0

  for (let i = 0; i < metadata.toc.length - 1; i++) {
    const tocItem = metadata.toc[i]!
    if (tocItem.page === undefined) continue

    const nextTocItem = metadata.toc[i + 1]!
    const nextIndex = nextTocItem.page
      ? content.findIndex((c) => c.page >= nextTocItem.page!)
      : content.length
    if (nextIndex < index) continue

    if (needsNewPage) {
      doc.addPage()
    }
    const chunks = content.slice(index, nextIndex)

    const text = chunks
      .map((chunk) => chunk.text)
      .join(' ')
      .replaceAll(/\n+/g, '\n')
      .replaceAll(/^\s*/gm, '')

    ;(doc as any).outline.addItem(tocItem.title)
    doc.fontSize(20)
    doc.text(tocItem.title, { align: 'center', lineGap: 16 })

    doc.fontSize(fontSize)
    doc.moveDown(1)

    doc.text(text, {
      indent: 20,
      lineGap: 4,
      paragraphGap: 8
    })

    index = nextIndex
    needsNewPage = true
  }

  doc.end()
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve)
    stream.on('error', reject)
  })
}

try {
  await main()
} catch (err) {
  console.error('error', err)
  process.exit(1)
}
