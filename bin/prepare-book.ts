#!/usr/bin/env node
/* eslint-disable no-process-env */
import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { globby } from 'globby'
import { OpenAIClient } from 'openai-fetch'
import pMap from 'p-map'

import { assert } from '../src/utils'

async function main() {
  const asin = process.env.ASIN
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)
  const pageScreenshotsDir = path.join(outDir, 'pages')
  const pageScreenshots = await globby(`${pageScreenshotsDir}/*.png`)

  const openai = new OpenAIClient()

  const results = (
    await pMap(
      pageScreenshots,
      async (screenshot) => {
        const screenshotBuffer = await fs.readFile(screenshot)
        const screenshotBase64 = `data:image/png;base64,${screenshotBuffer.toString('base64')}`
        const index = Number.parseInt(screenshot.match(/0*(\d+)\.png/)![1]!)

        try {
          let retries = 0

          do {
            const res = await openai.createChatCompletion({
              // model: retries < 3 ? 'gpt-4o-mini' : 'gpt-4o',
              model: 'gpt-4o',
              temperature: retries < 2 ? 0 : 0.5,
              messages: [
                {
                  role: 'system',
                  content: `You will be given an image containing text. Read the text from the image and output it **verbatim**.

Do not include any additional text, descriptions, or punctuation. Ignore any embedded images. Do not use markdown.`
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

            const text = res.choices[0]?.message.content!
            ++retries

            if (!text) continue
            if (text.length < 100 && /i'm sorry/i.test(text)) {
              console.warn(`retrying refusal...`, { index, text, screenshot })
              continue
            }

            const result = {
              index,
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

  console.log(JSON.stringify(results, null, 2))
}

try {
  await main()
} catch (err) {
  console.error('error', err)
  process.exit(1)
}
