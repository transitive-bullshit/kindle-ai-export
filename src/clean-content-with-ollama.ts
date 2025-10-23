import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

// import ky from 'ky' // ky doesn't work well in Node.js with Ollama
import pMap from 'p-map'

import type { ContentChunk } from './types'
import { assert, getEnv } from './utils'

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const ollamaBaseUrl = getEnv('OLLAMA_BASE_URL') || 'http://localhost:11434'
  const ollamaModel = getEnv('OLLAMA_MODEL') || 'llama3.2'
  const concurrency = Math.max(1, Math.min(8, Number.parseInt(getEnv('OLLAMA_CONCURRENCY') || '4', 10)))

  const outDir = path.join('out', asin)
  const contentPath = path.join(outDir, 'content.json')

  // Read existing content
  const contentRaw = await fs.readFile(contentPath, 'utf-8')
  const content = JSON.parse(contentRaw) as ContentChunk[]
  assert(content.length > 0, 'No content found in content.json')

  console.log(`Loaded ${content.length} chunks from content.json`)
  console.log(`Using Ollama at ${ollamaBaseUrl} with model ${ollamaModel}`)
  console.log(`Concurrency: ${concurrency} parallel requests\n`)

  // Warm up the model
  console.log('Warming up model...')
  try {
    const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false
      }),
      signal: AbortSignal.timeout(60000)
    })
    await response.json()
    console.log('Model ready!\n')
  } catch (err) {
    console.warn('Model warmup failed:', (err as Error).message)
  }

  let processed = 0
  const cleanedContent: ContentChunk[] = await pMap(
    content,
    async (chunk) => {
      const { index, page, text, screenshot } = chunk

      // Skip empty or very short text
      if (!text || text.length < 20) {
        processed++
        console.log(`[${processed}/${content.length}] Skipped chunk ${index} (too short)`)
        return chunk
      }

      try {
        const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: ollamaModel,
            messages: [
              {
                role: 'system',
                content: `You are a text formatting assistant. Your job is to clean up OCR text by fixing paragraph breaks and spacing while preserving the original content exactly.

Rules:
1. Fix paragraph breaks - add proper line breaks between paragraphs
2. Remove excessive whitespace and fix spacing issues
3. DO NOT change, add, or remove any words
4. DO NOT fix spelling or grammar
5. DO NOT add punctuation
6. Keep dialogue and quoted text exactly as-is
7. Preserve chapter titles and headings
8. Output ONLY the cleaned text, no explanations or comments`
              },
              {
                role: 'user',
                content: `Clean up this text:\n\n${text}`
              }
            ],
            stream: false,
            options: {
              temperature: 0,
              num_predict: 2048
            }
          }),
          signal: AbortSignal.timeout(120000)
        })

        if (!response.ok) {
          throw new Error(`Ollama API error: ${response.status} ${response.statusText}`)
        }

        const data = await response.json() as { message: { content: string } }
        const cleanedText = data.message.content.trim()

        processed++
        const changePercent = Math.abs(cleanedText.length - text.length) / text.length * 100
        console.log(
          `[${processed}/${content.length}] Chunk ${index} (page ${page}): ` +
          `${text.length} → ${cleanedText.length} chars (${changePercent.toFixed(1)}% change)`
        )

        return {
          index,
          page,
          text: cleanedText,
          screenshot
        }
      } catch (err) {
        console.error(`Error processing chunk ${index}:`, (err as Error).message)
        processed++
        return chunk // Return original on error
      }
    },
    { concurrency }
  )

  // Backup original
  const backupPath = path.join(outDir, 'content.backup.json')
  await fs.writeFile(backupPath, contentRaw)
  console.log(`\n✓ Backed up original to ${backupPath}`)

  // Save cleaned content
  await fs.writeFile(
    contentPath,
    JSON.stringify(cleanedContent, null, 2)
  )
  console.log(`✓ Saved cleaned content to ${contentPath}`)
  console.log(`\n✓ Processed ${cleanedContent.length} chunks successfully!`)
}

await main()
