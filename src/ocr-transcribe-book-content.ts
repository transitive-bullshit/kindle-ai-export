import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { globby } from 'globby'
import pMap from 'p-map'
import { createWorker } from 'tesseract.js'

import type { ContentChunk } from './types'
import { assert, getEnv } from './utils'

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)
  const pageScreenshotsDir = path.join(outDir, 'pages')
  const pageScreenshots = await globby(`${pageScreenshotsDir}/*.png`)
  assert(pageScreenshots.length, 'no page screenshots found')

  // Get concurrency setting (default 4 for OCR to balance speed/memory)
  const concurrency = Math.max(1, Math.min(16, Number.parseInt(getEnv('OCR_CONCURRENCY') || '4', 10)))

  // Create a worker pool
  const workers = await Promise.all(
    Array.from({ length: concurrency }, async () => {
      const worker = await createWorker('eng')
      return worker
    })
  )

  const content: ContentChunk[] = (
    await pMap(
      pageScreenshots,
      async (screenshot, workerIndex) => {
        const metadataMatch = screenshot.match(/0*(\d+)-\0*(\d+).png/)
        assert(
          metadataMatch?.[1] && metadataMatch?.[2],
          `invalid screenshot filename: ${screenshot}`
        )
        const index = Number.parseInt(metadataMatch[1]!, 10)
        const page = Number.parseInt(metadataMatch[2]!, 10)
        assert(
          !Number.isNaN(index) && !Number.isNaN(page),
          `invalid screenshot filename: ${screenshot}`
        )

        try {
          // Use worker from pool (round-robin)
          const worker = workers[workerIndex % workers.length]!
          const { data } = await worker.recognize(screenshot)
          
          const rawText = data.text || ''
          
          const text = rawText
            .replace(/^\s*\d+\s*$\n+/m, '')
            // .replaceAll(/\n+/g, '\n')
            .replaceAll(/^\s*/gm, '')
            .replaceAll(/\s*$/gm, '')

          const result: ContentChunk = {
            index,
            page,
            text,
            screenshot
          }
          console.log(result)

          return result
        } catch (err) {
          console.error(`error processing image ${index} (${screenshot})`, err)
        }
      },
      { concurrency }
    )
  ).filter(Boolean)

  // Terminate all workers
  await Promise.all(workers.map((w: any) => w.terminate()))

  await fs.writeFile(
    path.join(outDir, 'content.json'),
    JSON.stringify(content, null, 2)
  )
  console.log(JSON.stringify(content, null, 2))
}

await main()
