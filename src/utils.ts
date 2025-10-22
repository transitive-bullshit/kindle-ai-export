import fs from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import hashObjectImpl from 'hash-object'
import timeFormat from 'hh-mm-ss'
import sortKeys from 'sort-keys'
import { extract } from 'tar'
import { temporaryDirectory } from 'tempy'

import type { BookMetadata } from './types'

export function assert(
  value: unknown,
  message?: string | Error
): asserts value {
  if (value) {
    return
  }

  if (!message) {
    throw new Error('Assertion failed')
  }

  throw typeof message === 'string' ? new Error(message) : message
}

export function getEnv(name: string): string | undefined {
  try {
    return typeof process !== 'undefined'
      ? // eslint-disable-next-line no-process-env
        process.env?.[name]
      : undefined
  } catch {
    return undefined
  }
}

export function normalizeAuthors(rawAuthors: string[]): string[] {
  if (!rawAuthors?.length) {
    return []
  }

  const rawAuthor = rawAuthors[0]!

  return Array.from(new Set(rawAuthor.split(':').filter(Boolean)), (authors) =>
    authors
      .split(',')
      .map((elems) => elems.trim())
      .toReversed()
      .join(' ')
  )
}

const JSONP_REGEX = /\(({.*})\)/

export function parseJsonpResponse<T = unknown>(body: string): T | undefined {
  const content = body?.match(JSONP_REGEX)?.[1]
  if (!content) {
    return
  }

  try {
    return JSON.parse(content) as T
  } catch {
    return
  }
}
const numerals = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }

export function deromanize(romanNumeral: string): number {
  const roman = romanNumeral.toUpperCase().split('')
  let num = 0
  let val = 0

  while (roman.length) {
    val = numerals[roman.shift()! as keyof typeof numerals]
    num += val * (val < numerals[roman[0] as keyof typeof numerals] ? -1 : 1)
  }

  return num
}

export async function fileExists(
  filePath: string,
  mode: number = fs.constants.F_OK | fs.constants.R_OK
): Promise<boolean> {
  try {
    await fs.access(filePath, mode)
    return true
  } catch {
    return false
  }
}

export function hashObject(obj: Record<string, any>): string {
  return hashObjectImpl(obj, {
    algorithm: 'sha1',
    encoding: 'hex'
  })
}

export type FfmpegProgressEvent = {
  frames: number
  currentFps: number
  currentKbps: number
  targetSize: number
  timemark: string
  percent?: number | undefined
}

export function ffmpegOnProgress(
  onProgress: (progress: number, event: FfmpegProgressEvent) => void,
  durationMs: number
) {
  return (event: FfmpegProgressEvent) => {
    let progress = 0

    try {
      const timestamp = timeFormat.toMs(event.timemark)
      progress = timestamp / durationMs
    } catch {}

    if (
      Number.isNaN(progress) &&
      event.percent !== undefined &&
      !Number.isNaN(event.percent)
    ) {
      progress = event.percent / 100
    }

    if (!Number.isNaN(progress)) {
      progress = Math.max(0, Math.min(1, progress))
      onProgress(progress, event)
    }
  }
}

/**
 * Decompress a TAR (optionally .tar.gz/.tgz) Buffer to a fresh temp directory.
 * Returns the absolute path of the temp directory.
 */
export async function extractTar(
  buf: Buffer,
  {
    strip = 0,
    cwd = temporaryDirectory()
  }: { strip?: number; cwd?: string } = {}
): Promise<string> {
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b

  try {
    const extractor = extract({
      cwd,
      gzip: isGzip,
      strip
    })

    await pipeline(Readable.from(buf), extractor)
    return cwd
  } catch (err) {
    // Clean up the temp dir if extraction fails
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T
}

export async function tryReadJsonFile<T = unknown>(
  filePath: string
): Promise<T | undefined> {
  try {
    return readJsonFile(filePath)
  } catch {}
}

const bookMetadataFieldOrder: (keyof BookMetadata)[] = [
  'meta',
  'info',
  'nav',
  'toc',
  'pages',
  'locationMap'
]

const bookMetadataFieldsOrderMap = Object.fromEntries(
  bookMetadataFieldOrder.map((f, i) => [f, i])
)

function bookMetadataFieldComparator(a: string, b: string): number {
  const aIndex = bookMetadataFieldsOrderMap[a] ?? Infinity
  const bIndex = bookMetadataFieldsOrderMap[b] ?? Infinity

  return aIndex - bIndex
}
export function normalizeBookMetadata(
  book: Partial<BookMetadata>
): Partial<BookMetadata> {
  return sortKeys(book, { compare: bookMetadataFieldComparator })
}
