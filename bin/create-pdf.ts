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

interface TOC {
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
  const { toc } = JSON.parse(
    await fsp.readFile(path.join(outDir, 'toc.json'), 'utf8')
  ) as TOC

  const title = `Kindle Test ${asin}`
  const author = 'Alastair Reynolds'

  const doc = new PDFDocument({
    autoFirstPage: true,
    displayTitle: true,
    info: {
      Title: title,
      Author: author
    }
  })
  const stream = doc.pipe(fs.createWriteStream(path.join(outDir, 'book.pdf')))

  // for (const chunk of content) {
  //   doc.text(chunk.text.replaceAll(/\n+/g, '\n').replaceAll(/^\s*/gm, ''), {
  //     indent: 20,
  //     lineGap: 4,
  //     paragraphGap: 8
  //   })
  //   doc.addPage()
  // }

  const fontSize = 12

  const renderTitlePage = () => {
    ;(doc as any).outline.addItem('Title Page')
    doc.fontSize(60)
    doc.y = doc.page.height / 2 - doc.currentLineHeight()
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

  for (let i = 0; i < toc.length - 1; i++) {
    const tocItem = toc[i]!
    if (tocItem.page === undefined) continue

    const nextTocItem = toc[i + 1]!
    const nextIndex = nextTocItem.page
      ? content.findIndex((c) => c.page >= nextTocItem.page!)
      : content.length
    if (nextIndex < index) continue

    if (needsNewPage) {
      doc.addPage()
    }
    // if (
    //   nextIndex < content.length - 1 &&
    //   content[nextIndex + 1]!.page === content[nextIndex]!.page &&
    //   content[nextIndex]!.page - content[nextIndex - 1]!.page === 1
    // ) {
    //   nextIndex++
    // }
    // console.log({ i, index, nextIndex, title: tocItem.title })
    const chunks = content.slice(index, nextIndex)

    const text = chunks
      .map((chunk) => chunk.text)
      .join(' ')
      .replace(/^\s*\d+\s*$\n+/m, '')
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

  // const text = content
  //   .map((chunk) => chunk.text)
  //   .join(' ')
  //   .replaceAll(/\n+/g, '\n')
  //   .replaceAll(/^\s*/gm, '')

  // doc.text(text, {
  //   indent: 20,
  //   lineGap: 4,
  //   paragraphGap: 8
  // })

  doc.end()
  await new Promise((resolve) => stream.on('finish', resolve))
}

try {
  await main()
} catch (err) {
  console.error('error', err)
  process.exit(1)
}
