import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import ky from 'ky'
import { OpenAIClient } from 'openai-fetch'
import pMap from 'p-map'
import { UnrealSpeechClient } from 'unrealspeech-api'

import type { SpeechParams } from '../../openai-fetch/dist/types'
import type { BookMetadata, ContentChunk } from './types'
import { assert, fileExists, getEnv, hashObject } from './utils'

type TTSEngine = 'openai' | 'unrealspeech'

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')
  const force = getEnv('FORCE') === 'true'

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

  // TTS engine configuration
  const ttsEngine = 'openai' as TTSEngine
  const openaiEngineParams: Omit<SpeechParams, 'input'> = {
    model: 'tts-1-hd',
    voice: 'alloy',
    response_format: 'mp3'
  }
  const unrealSpeechEngineParams: Omit<
    Parameters<UnrealSpeechClient['speech']>[0],
    'text'
  > = {
    voiceId: 'Scarlett'
  }
  const ttsEngineParams: any =
    ttsEngine === 'openai' ? openaiEngineParams : unrealSpeechEngineParams
  const ttsEngineVoice =
    ttsEngine === 'openai'
      ? openaiEngineParams.voice
      : unrealSpeechEngineParams.voiceId
  assert(ttsEngineVoice, 'Invalid TTS engine config: missing voice')

  const unrealSpeech =
    ttsEngine === 'unrealspeech' ? new UnrealSpeechClient() : undefined
  const openai = ttsEngine === 'openai' ? new OpenAIClient() : undefined
  const maxCharactersPerAudioBatch = ttsEngine === 'openai' ? 4096 : 3000

  const title = metadata.meta.title
  const authors = metadata.meta.authorList

  const configDirHash = hashObject({
    ttsEngine,
    ttsEngineParams,
    title,
    authors,
    content
  })
  const configDir = `${ttsEngine}-${ttsEngineVoice}-${configDirHash}`
  const ttsOutDir = path.join(audioOutDir, configDir)
  await fs.mkdir(ttsOutDir, { recursive: true })

  const batches: Array<{
    title?: string
    text: string
  }> = []

  batches.push({
    title,
    text: `${title}

By ${authors.join(', ')}`
  })

  for (let i = 0, index = 0; i < metadata.toc.length - 1; i++) {
    const tocItem = metadata.toc[i]!
    if (tocItem.page === undefined) continue

    const nextTocItem = metadata.toc[i + 1]!
    const nextIndex = nextTocItem.page
      ? content.findIndex((c) => c.page >= nextTocItem.page!)
      : content.length
    if (nextIndex < index) continue

    // Aggregate the text
    const chunks = content.slice(index, nextIndex)
    const text = chunks
      .map((chunk) => chunk.text)
      .join(' ')
      .replaceAll('\n', '\n\n')

    // Split the text in this chapter into paragraphs.
    const t = `${tocItem.title}

${text}`.split('\n\n')

    // Combine successive paragraphs if they can fit with a single audio batch.
    let j = 0
    do {
      const chunk = t[j]!

      if (chunk.length > maxCharactersPerAudioBatch) {
        throw new Error(
          `TODO: handle large paragraphs ${chunk.length} characters: ${chunk}`
        )
      }

      if (j < t.length - 1) {
        const nextChunk = t[j + 1]!

        const combined = `${chunk}\n\n${nextChunk}`
        if (combined.length <= maxCharactersPerAudioBatch) {
          t[j] = combined
          t.splice(j + 1, 1)
          continue
        }
      }

      ++j
    } while (j < t.length)

    for (const [k, element] of t.entries()) {
      batches.push({
        title: k === 0 ? tocItem.title : undefined,
        text: element!
      })
    }

    index = nextIndex
  }

  console.log()
  console.log(batches)
  console.log()
  console.log(`Generating audio for ${batches.length} batches to ${ttsOutDir}`)
  console.log()
  const audioPadding = `${batches.length}`.length

  await pMap(
    batches,
    async (batch, index) => {
      const audioBaseFilename = `${index}`.padStart(audioPadding, '0')
      const audioFilePath = path.join(ttsOutDir, `${audioBaseFilename}.mp3`)

      // Don't recreate the audio file for this batch if it already exists.
      // Allow `process.env.FORCE` to override this behavior.
      if (!force && (await fileExists(audioFilePath))) {
        console.log(`Skipping audio batch ${index + 1}: ${audioFilePath}`)
        return
      }

      console.log(`Generating audio batch ${index + 1}: ${audioFilePath}`)
      let audio: ArrayBuffer

      if (ttsEngine === 'openai') {
        audio = await openai!.createSpeech({
          ...ttsEngineParams,
          input: batch.text
        })
      } else {
        const res = await unrealSpeech!.speech({
          ...ttsEngineParams,
          text: batch.text
        })
        console.log(res)

        audio = await ky.get(res.OutputUri).arrayBuffer()
      }

      await fs.writeFile(audioFilePath, Buffer.from(audio))
    },
    { concurrency: 16 }
  )
}

await main()
