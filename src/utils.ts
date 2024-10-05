import type { RequiredCookies, TLSClientResponseData } from './types'

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

function assertImpl(value: unknown, message?: string | Error): asserts value {
  if (value) {
    return
  }

  if (!message) {
    throw new Error('Assertion failed')
  }

  throw typeof message === 'string' ? new Error(message) : message
}

/**
 * Assertion function that defaults to Node.js's `assert` module if it's
 * available, with a basic backup if not.
 */
let assert: (value: unknown, message?: string | Error) => asserts value =
  assertImpl

try {
  // Default to the Node.js assert module if it's available
  const assertImport = await import('node:assert')
  if (assertImport?.default) {
    assert = assertImport.default
  }
} catch {}

export { assert }

export function normalizeAuthors(rawAuthors: string[]): string[] {
  if (!rawAuthors?.length) {
    return []
  }

  const rawAuthor = rawAuthors[0]!

  return Array.from(new Set(rawAuthor.split(':').filter(Boolean)), (authors) =>
    authors
      .split(',')
      .map((elems) => elems.trim())
      .reverse()
      .join(' ')
  )
}

export function toLargeImage(url: string): string {
  return url.replaceAll(/\._SY\d+_\./g, '.')
}

export function serializeCookies(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(
      ([key, value]) =>
        `${key.replaceAll(/[A-Z]/g, (v) => `-${v.toLowerCase()}`)}=${value}`
    )
    .join('; ')
    .trim()
}

export function deserializeCookies(cookies: string): RequiredCookies {
  const values = cookies
    .split(';')
    .map((v) => v.split('='))
    .filter((v) => v.length === 2 && v[0]?.trim() && v[1]?.trim())
    .reduce(
      (acc, [key, value]) => {
        acc[decodeURIComponent(key!.trim())] = decodeURIComponent(value!.trim())
        return acc
      },
      {} as Record<string, string>
    )

  return {
    atMain: values['at-main']!,
    sessionId: values['session-id']!,
    ubidMain: values['ubid-main']!,
    xMain: values['x-main']!
  }
}

const JSONP_REGEX = /\(({.*})\)/

export function parseJsonpResponse<T>(
  response: TLSClientResponseData
): T | undefined {
  const content = response.body.match(JSONP_REGEX)?.[1]
  if (!content) {
    return
  }

  return JSON.parse(content) as T
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
