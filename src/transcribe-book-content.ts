import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { globby } from 'globby'
import { OpenAIClient } from 'openai-fetch'
import pMap from 'p-map'
import { setTimeout } from 'node:timers/promises'

import type { ContentChunk } from './types'
import { assert, getEnv } from './utils'

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  // Use path.posix.join for Unix style paths across platforms.
  const outDir = path.posix.join('out', asin)
  const contentPath = path.join(outDir, 'content.json')
  const pageScreenshotsDir = path.posix.join(outDir, 'pages')
  const pageScreenshots = await globby(`${pageScreenshotsDir}/*.png`)
  assert(pageScreenshots.length, 'no page screenshots found')

  // Initialize a new file to append to. Keeps you from losing data transcriptions if error occurs. 
  //Or load existing content.
  let existingContent: ContentChunk[] = []
  try {
    const existingData = await fs.readFile(contentPath, 'utf-8')
    existingContent = JSON.parse(existingData) as ContentChunk[]

  } catch (err) {
    // File doesn't exist yet, start with empty array.
    await fs.writeFile(contentPath, JSON.stringify([], null, 2))
  }

  const openai = new OpenAIClient()

  const content: ContentChunk[] = (
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
          const maxRetries = 20
          let retries = 0
          let backoffTime = 1000

          do {
            try {
              await setTimeout(1000)

              const res = await openai.createChatCompletion({
                model: 'gpt-4o-mini',
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
                if (retries >= maxRetries) {
                  throw new Error(
                    `Model refused too many times (${retries} times): ${text}`
                  )
                }

                // Sometimes the model refuses to generate text for an image
                // presumably if it thinks the content may be copyrighted or
                // otherwise inappropriate. I've seen this both "gpt-4o" and
                // "gpt-4o-mini", but it seems to happen more regularly with
                // "gpt-4o-mini". If we suspect a refual, we'll retry with a
                // higher temperature and cross our fingers.
                console.warn('retrying refusal...', { index, text, screenshot })
                continue
              }

              const result: ContentChunk = {
                index,
                page,
                text,
                screenshot
              }
              console.log(result)

              // Immediately save each successful result
              existingContent.push(result)
              await fs.writeFile(
                contentPath,
                JSON.stringify(existingContent, null, 2)
              )

              return result
            } catch (error: any) {
              // Add exponential backoff if the rate limit is reached
              if (error?.message?.includes('Rate limit reached')) {
                console.warn(`Rate limit reached, waiting ${backoffTime}ms before retry...`)
                await setTimeout(backoffTime)
                backoffTime *= 2
                continue
              }
              throw error
            }
          } while (true)
        } catch (err) {
          console.error(`error processing image ${index} (${screenshot})`, err)
        }
      },
      { concurrency: 8 }
    )
  ).filter(Boolean)

  // Final save is redundant but keeps the original behavior
  await fs.writeFile(
    contentPath,
    JSON.stringify(content, null, 2)
  )
  console.log(JSON.stringify(content, null, 2))
}

await main()
