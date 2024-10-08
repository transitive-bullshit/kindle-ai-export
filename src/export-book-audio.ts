import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import ffmpeg from 'fluent-ffmpeg'
import ky from 'ky'
import ID3 from 'node-id3'
import { OpenAIClient } from 'openai-fetch'
import pMap from 'p-map'
import { UnrealSpeechClient } from 'unrealspeech-api'

import type { SpeechParams } from '../../openai-fetch/dist/types'
import type { BookMetadata, ContentChunk } from './types'
import {
  assert,
  ffmpegOnProgress,
  fileExists,
  getEnv,
  hashObject
} from './utils'

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
  const ttsEngine = (getEnv('TTS_ENGINE') as TTSEngine) ?? 'openai'
  assert(
    ttsEngine === 'openai' || ttsEngine === 'unrealspeech',
    `Invalid TTS engine "${ttsEngine}"`
  )
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

  // let lastTocItemIndex = 0
  for (let i = 0, index = 0; i < metadata.toc.length - 1; i++) {
    const tocItem = metadata.toc[i]!
    if (tocItem.page === undefined) continue

    const nextTocItem = metadata.toc[i + 1]!
    const nextIndex = nextTocItem.page
      ? content.findIndex((c) => c.page >= nextTocItem.page!)
      : content.length
    if (nextIndex < index) continue
    // lastTocItemIndex = i

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

  const audioChunks = await pMap(
    batches,
    async (batch, index) => {
      const audioBaseFilename = `${index}`.padStart(audioPadding, '0')
      const audioFilePath = path.join(ttsOutDir, `${audioBaseFilename}.mp3`)
      const result = { ...batch, audioFilePath }

      // Don't recreate the audio file for this batch if it already exists.
      // Allow `process.env.FORCE` to override this behavior.
      if (!force && (await fileExists(audioFilePath))) {
        console.log(`Skipping audio batch ${index + 1}: ${audioFilePath}`)
        return result
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
      return result
    },
    { concurrency: 16 }
  )

  const audioParts = await pMap(
    audioChunks,
    async (audioChunk) => {
      const probeData = await ffmpegProbe(audioChunk.audioFilePath)

      const duration =
        probeData.format.duration ??
        (probeData.streams[0]?.duration as unknown as number)
      assert(
        duration !== undefined && !Number.isNaN(duration),
        `Failed to determine audio duration for file: ${audioChunk.audioFilePath}`
      )

      return {
        ...audioChunk,
        duration
      }
    },
    { concurrency: 16 }
  )

  const audioConcatInputFilePath = path.join(ttsOutDir, 'files.txt')
  const audioConcatInput = audioParts
    .map((a) => `file ${path.basename(a.audioFilePath)}`)
    .join('\n')
  await fs.writeFile(audioConcatInputFilePath, audioConcatInput)
  const audiobookOutputFilePath = path.join(ttsOutDir, 'audiobook.mp3')

  const expectedDurationMs =
    audioParts.reduce((duration, a) => duration + a.duration, 0) * 1000

  // Use ffmpeg to concatenate the audio files into a single audiobook file.
  await new Promise<void>((resolve, reject) => {
    ffmpeg(audioConcatInputFilePath)
      .inputOptions(['-f', 'concat'])
      .withOptions([
        // metadata (mp3 tags)
        '-metadata',
        `title="${title}"`
        // TODO: fluent-ffmpeg is choking on this metadata tag for some reason
        // '-metadata',
        // `artist="${authors.join('/')}"`,
        // '-metadata',
        // `encoded_by="https://github.com/transitive-bullshit/kindle-ai-export"`
        // '-metadata',
        // `WCOM="https://www.amazon.com/dp/${asin}"`
      ])
      .outputOptions([
        // misc
        '-hide_banner',
        '-map_metadata',
        '-1',
        '-map_chapters',
        '-1',

        // audio
        '-c',
        'copy'
      ])
      .output(audiobookOutputFilePath)
      .on('start', (cmd) => console.log({ cmd }))
      .on(
        'progress',
        ffmpegOnProgress((progress) => {
          console.log(`Processing audio: ${Math.floor(progress * 100)}%`)
        }, expectedDurationMs)
      )
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })

  try {
    // Add ID3 metadata to the MP3 audiobook file.
    await new Promise<void>((resolve, reject) => {
      const res = ID3.update(
        {
          title,
          artist: authors.join('/'),
          encodedBy: 'https://github.com/transitive-bullshit/kindle-ai-export'
          // image: 'https://m.media-amazon.com/images/I/41sMaof0iQL.jpg', // TODO
          // TODO: these tags don't seem to be working properly in the node-id3 library
          // chapter: metadata.toc
          //   .map((tocItem, index) => {
          //     if (tocItem.page === undefined) return undefined
          //     if (index > lastTocItemIndex) return undefined

          //     const nextTocItem = metadata.toc[index + 1]
          //     const audioPartIndexTocItem = audioParts.findIndex(
          //       (a) => a.title === tocItem.title
          //     )
          //     const audioPartIndexNextTocItem = nextTocItem
          //       ? audioParts.findIndex((a) => a.title === nextTocItem.title)
          //       : audioParts.length
          //     const startTimeMs = Math.floor(
          //       1000 *
          //         audioParts
          //           .slice(0, audioPartIndexTocItem)
          //           .reduce((duration, a) => duration + a.duration, 0)
          //     )
          //     const endTimeMs = Math.ceil(
          //       1000 *
          //         audioParts
          //           .slice(0, audioPartIndexNextTocItem)
          //           .reduce((duration, a) => duration + a.duration, 0)
          //     )
          //     console.log(index, tocItem.title, { startTimeMs, endTimeMs })
          //     return {
          //       elementID: tocItem.title,
          //       startTimeMs,
          //       endTimeMs
          //     }
          //   })
          //   .filter(Boolean),
          // tableOfContents: [
          //   {
          //     elementID: 'TOC',
          //     isOrdered: true,
          //     elements: metadata.toc
          //       .map((tocItem, index) => {
          //         if (tocItem.page === undefined) return undefined
          //         if (index > lastTocItemIndex) return undefined

          //         return tocItem.title
          //       })
          //       .filter(Boolean)
          //   }
          // ]
        },
        audiobookOutputFilePath
      )

      if (res !== true) {
        reject(res)
      } else {
        resolve()
      }
    })
  } catch (err: any) {
    console.warn(
      `(warning) Failed to add extra ID3 metadata to audiobook: ${err.message}\n`
    )
  }

  console.log(`Audiobook generated: ${audiobookOutputFilePath}`)
}

async function ffmpegProbe(filePath: string) {
  return new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err)
      resolve(data)
    })
  })
}

await main()
