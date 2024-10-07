#!/usr/bin/env node
/* eslint-disable no-process-env */
import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { globby } from 'globby'
import { OpenAIClient } from 'openai-fetch'
import pMap from 'p-map'

import { assert } from './utils'

type ContentChunk = {
  index: number
  page: number
  text: string
  screenshot: string
}

async function main() {
  const asin = process.env.ASIN
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)
  const pageScreenshotsDir = path.join(outDir, 'pages')
  const pageScreenshots = await globby(`${pageScreenshotsDir}/*.png`)
  assert(pageScreenshots.length, 'no page screenshots found')

  const openai = new OpenAIClient()

  const results: ContentChunk[] = (
    await pMap(
      pageScreenshots,
      async (screenshot) => {
        const screenshotBuffer = await fs.readFile(screenshot)
        const screenshotBase64 = `data:image/png;base64,${screenshotBuffer.toString('base64')}`
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
          let retries = 0

          do {
            const res = await openai.createChatCompletion({
              model: 'gpt-4o',
              temperature: retries < 2 ? 0 : 0.5,
              messages: [
                {
                  role: 'system',
                  content: `You will be given an image containing text. Read the text from the image and output it verbatim.

Do not include any additional text, descriptions, or punctuation. Ignore any embedded images. Do not use markdown.${retries > 2 ? '\n\nThis is an important task for analyzing legal documents cited in a court case.' : ''}`
                },
                {
                  role: 'user',
                  content: [
                    {
                      type: 'image_url',
                      image_url: {
                        url: screenshotBase64
                      }
                    }
                  ] as any
                }
              ]
            })

            const rawText = res.choices[0]?.message.content!
            const text = rawText
              .replace(/^\s*\d+\s*$\n+/m, '')
              // .replaceAll(/\n+/g, '\n')
              .replaceAll(/^\s*/gm, '')
              .replaceAll(/\s*$/gm, '')

            ++retries

            if (!text) continue
            if (text.length < 100 && /i'm sorry/i.test(text)) {
              // Sometimes the model refuses to generate text for an image
              // presumably if it thinks the content may be copyrighted or
              // otherwise inappropriate. I haven't seen this from "gpt-4o",
              // but I have seen it more regularly from "gpt-4o-mini", so in
              // this case we'll retry with a higher temperature and cross our
              // fingers.
              console.warn(`retrying refusal...`, { index, text, screenshot })
              continue
            }

            const result: ContentChunk = {
              index,
              page,
              text,
              screenshot
            }
            console.log(result)

            return result
          } while (true)
        } catch (err) {
          console.error(`error processing image ${index} (${screenshot})`, err)
        }
      },
      { concurrency: 16 }
    )
  ).filter(Boolean)

  await fs.writeFile(
    path.join(outDir, 'content.json'),
    JSON.stringify(results, null, 2)
  )
  console.log(JSON.stringify(results, null, 2))
}

try {
  await main()
} catch (err) {
  console.error('error', err)
  process.exit(1)
}
