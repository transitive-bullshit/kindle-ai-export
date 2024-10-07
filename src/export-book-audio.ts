#!/usr/bin/env node
import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { OpenAIClient } from 'openai-fetch'
import pMap from 'p-map'

import type { BookMetadata, ContentChunk } from './types'
import { assert, getEnv } from './utils'

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)
  const audioOutDir = path.join(outDir, 'audio')
  await fs.mkdir(audioOutDir, { recursive: true })

  const content = JSON.parse(
    await fs.readFile(path.join(outDir, 'content.json'), 'utf8')
  ) as ContentChunk[]
  const metadata = JSON.parse(
    await fs.readFile(path.join(outDir, 'metadata.json'), 'utf8')
  ) as BookMetadata
  assert(content.length, 'no book content found')
  assert(metadata.meta, 'invalid book metadata: missing meta')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  const openai = new OpenAIClient()

  const title = metadata.meta.title
  const authors = metadata.meta.authorList

  const sections: Array<{
    title?: string
    text: string
  }> = []

  sections.push({
    title,
    text: `# ${title}

By ${authors.join(', ')}`
  })

  // $30.000 / 1M characters

  for (let i = 0, index = 0; i < metadata.toc.length - 1; i++) {
    const tocItem = metadata.toc[i]!
    if (tocItem.page === undefined) continue

    const nextTocItem = metadata.toc[i + 1]!
    const nextIndex = nextTocItem.page
      ? content.findIndex((c) => c.page >= nextTocItem.page!)
      : content.length
    if (nextIndex < index) continue

    const chunks = content.slice(index, nextIndex)

    const text = chunks
      .map((chunk) => chunk.text)
      .join(' ')
      .replaceAll('\n', '\n\n')

    const chapterChunks: string[] = []

    chapterChunks.push(`## ${tocItem.title}

${text}`)

    sections.push({
      title: tocItem.title,
      text: `## ${tocItem.title}

${text}`.slice(0, 4095) // TODO: break up by paragraphs and then by sentences
    })

    index = nextIndex

    // TODO
    break
  }

  const audioPadding = `${sections.length}`.length

  await pMap(
    sections,
    async (section, index) => {
      console.log(`Generating audio for section ${index + 1}...`)

      const audio = await openai.createSpeech({
        input: section.text,
        model: 'tts-1-hd',
        voice: 'alloy',
        response_format: 'mp3'
      })

      const filenameBase = `${index}`.padStart(audioPadding, '0')
      await fs.writeFile(
        `${audioOutDir}/${filenameBase}.mp3`,
        Buffer.from(audio)
      )
    },
    { concurrency: 4 }
  )
}

try {
  await main()
} catch (err) {
  console.error('error', err)
  process.exit(1)
}
