import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { OpenAIClient } from 'openai-fetch'
import pMap from 'p-map'

import type { BookMetadata, ContentChunk, TocItem } from './types'
import { assert, getEnv, readJsonFile } from './utils'

const INDEX_PAGE_RE = /(\d+)-(\d+)\.png$/
const PAGE_NUMBER_LINE_RE = /^\s*\d+\s*$/

function isChunk(v: unknown): v is ContentChunk {
  return (
    !!v &&
    typeof (v as any).text === 'string' &&
    typeof (v as any).page === 'number'
  )
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function jitter(ms: number, pct = 0.25) {
  const d = ms * pct
  return Math.max(0, ms - d + Math.random() * (2 * d))
}

function normalizeOcrText(raw: string): string {
  const sanitized = raw.replaceAll(/[\t\f\r]+/g, ' ')
  const lines = sanitized.split('\n')

  while (lines.length && PAGE_NUMBER_LINE_RE.test(lines[0] ?? '')) {
    lines.shift()
  }
  while (lines.length && PAGE_NUMBER_LINE_RE.test(lines.at(-1) ?? '')) {
    lines.pop()
  }

  const normalized = lines.map((line) => line.trim())
  return normalized.join('\n').trim()
}

function parseIndexPage(filePath: string): { index: number; page: number } {
  const m = filePath.match(INDEX_PAGE_RE)
  assert(m?.[1] && m?.[2], `invalid screenshot filename: ${filePath}`)
  const index = Number.parseInt(m[1]!, 10)
  const page = Number.parseInt(m[2]!, 10)
  assert(
    !Number.isNaN(index) && !Number.isNaN(page),
    `invalid screenshot filename: ${filePath}`
  )
  return { index, page }
}

function sortScreenshots(paths: string[]): string[] {
  return paths.slice().sort((a, b) => {
    const A = parseIndexPage(a)
    const B = parseIndexPage(b)
    return A.index - B.index || A.page - B.page
  })
}

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)
  const metadata = await readJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  assert(metadata.pages?.length, 'no page screenshots found')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  const pageToTocItemMap = metadata.toc.reduce(
    (acc, tocItem) => {
      if (tocItem.page !== undefined) {
        acc[tocItem.page] = tocItem
      }
      return acc
    },
    {} as Record<number, TocItem>
  )

  // const pageScreenshotsDir = path.join(outDir, 'pages')
  // const pageScreenshots = await globby(`${pageScreenshotsDir}/*.png`)
  // assert(pageScreenshots.length, 'no page screenshots found')

  const openai = new OpenAIClient()

  const content: ContentChunk[] = (
    await pMap(
      metadata.pages,
      async (pageChunk, pageChunkIndex) => {
        const { screenshot, index, page } = pageChunk
        const screenshotBuffer = await fs.readFile(screenshot)
        const screenshotBase64 = `data:image/png;base64,${screenshotBuffer.toString('base64')}`
        // const metadataMatch = screenshot.match(/0*(\d+)-\0*(\d+).png/)
        // assert(
        //   metadataMatch?.[1] && metadataMatch?.[2],
        //   `invalid screenshot filename: ${screenshot}`
        // )
        // const index = Number.parseInt(metadataMatch[1]!, 10)
        // const page = Number.parseInt(metadataMatch[2]!, 10)
        // assert(
        //   !Number.isNaN(index) && !Number.isNaN(page),
        //   `invalid screenshot filename: ${screenshot}`
        // )

        try {
          const maxRetries = 20
          let retries = 0

          do {
            const res = await openai.createChatCompletion({
              model: 'gpt-4.1-mini',
              temperature: retries < 2 ? 0 : 0.5,
              messages: [
                {
                  role: 'system',
                  content:
                    'You will be given an image containing text. Read the text from the image and output it verbatim.\n\nDo not include any additional text, descriptions, or punctuation. Ignore any embedded images. Do not use markdown.' +
                    (attempt > 2
                      ? '\n\nThis is critical OCR; do not refuse. If text is faint or skewed, transcribe best-effort.'
                      : '')
                },
                {
                  role: 'user',
                  content: [
                    {
                      type: 'image_url',
                      image_url: { url: screenshotBase64 }
                    }
                  ] as any
                }
              ]
            })

            const rawText = res.choices[0]!.message.content!
            let text = rawText
              .replace(/^\s*\d+\s*$\n+/m, '')
              // .replaceAll(/\n+/g, '\n')
              .replaceAll(/^\s*/gm, '')
              .replaceAll(/\s*$/gm, '')

            ++retries

            if (!text) continue
            if (text.length < 100 && /i'm sorry/i.test(text)) {
              if (retries >= maxRetries) {
                throw new Error(
                  `Model refused too many times (${retries} times): ${text}`
                )
              }

            if (
              !text ||
              (text.length < 100 && /i'm sorry|cannot|copyright/i.test(text))
            ) {
              attempt++
              if (attempt >= maxRetries) {
                throw new Error(`OCR refusal/empty after ${attempt} attempts`)
              }
              await sleep(jitter(Math.min(60_000, 500 * 2 ** attempt)))
              continue
            }

            const prevPageChunk = metadata.pages[pageChunkIndex - 1]
            if (prevPageChunk && prevPageChunk.page !== page) {
              const tocItem = pageToTocItemMap[page]
              if (tocItem) {
                text = text.replace(
                  // eslint-disable-next-line security/detect-non-literal-regexp
                  new RegExp(`^${tocItem.label}\\s*`, 'i'),
                  ''
                )
              }
            }

            const result: ContentChunk = {
              index,
              page,
              text,
              screenshot
            }
            console.log(result)
            return result
          } catch (err: any) {
            // handle rate limits / transient failures with backoff
            const msg = String(err?.message || err)
            if (
              /429|rate limit|etimedout|econnreset|5\d\d/i.test(msg) &&
              attempt < maxRetries
            ) {
              attempt++
              const wait = Math.min(90_000, 750 * 2 ** attempt)
              console.warn(
                `retry ${attempt}/${maxRetries} for ${screenshot} after error:`,
                msg
              )
              await sleep(jitter(wait))
              continue
            }
            console.error(
              `error processing image ${index} (${screenshot})`,
              err
            )
            return undefined // allow type guard to drop this page
          }
        }
      },
      { concurrency: 4 }
    )
  ).filter(isChunk)

  // Sanity: log any pages that failed so you can re-run selectively
  const expected = pageScreenshots.length
  const received = content.length
  if (received !== expected) {
    const got = new Set(content.map((c) => `${c.index}-${c.page}`))
    const missing = pageScreenshots
      .map((p) => p.match(INDEX_PAGE_RE)!)
      .filter((m) => !got.has(`${Number(m[1])}-${Number(m[2])}`))
      .map((m) => `${m[1]}-${m[2]}`)
    console.warn(`WARNING: ${expected - received} page(s) missing`, { missing })
  }

  await fs.writeFile(
    path.join(outDir, 'content.json'),
    JSON.stringify(content, null, 2)
  )
  console.log(
    `Wrote ${content.length} chunks to ${path.join(outDir, 'content.json')}`
  )
}

await main()
