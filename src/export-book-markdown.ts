import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookMetadata, ContentChunk } from './types'
import { assert, getEnv, readJsonFile } from './utils'

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)

  const content = await readJsonFile<ContentChunk[]>(
    path.join(outDir, 'content.json')
  )
  const metadata = await readJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  assert(content.length, 'no book content found')
  assert(metadata.meta, 'invalid book metadata: missing meta')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  const title = metadata.meta.title
  const authors = metadata.meta.authorList

  let lastTocItemIndex = 0
  for (let i = 0, index = 0; i < metadata.toc.length - 1; i++) {
    const tocItem = metadata.toc[i]!
    if (tocItem.page === undefined) continue

    const nextTocItem = metadata.toc[i + 1]!
    const nextIndex = nextTocItem.page
      ? content.findIndex((c) => c.page >= nextTocItem.page!)
      : content.length
    if (nextIndex < index) continue

    lastTocItemIndex = i
  }

  let output = `# ${title}

> By ${authors.join(', ')}

---

## Table of Contents

${metadata.toc
  .filter(
    (tocItem, index) => tocItem.page !== undefined && index <= lastTocItemIndex
  )
  .map(
    (tocItem) =>
      `${'  '.repeat(tocItem.depth)}- [${tocItem.label}](#${tocItem.label.toLowerCase().replaceAll(/[^\da-z]+/g, '-')})`
  )
  .join('\n')}

---`

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

    output += `

${'#'.repeat(tocItem.depth + 2)} ${tocItem.label}

${text}`

    index = nextIndex
  }

  await fs.writeFile(path.join(outDir, 'book.md'), output)
  console.log(output)
}

await main()
