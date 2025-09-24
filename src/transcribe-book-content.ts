import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { globby } from 'globby'
import { OpenAIClient } from 'openai-fetch'
import pMap from 'p-map'

import type { ContentChunk } from './types'
import { assert, getEnv } from './utils'

const INDEX_PAGE_RE = /(\d+)-(\d+)\.png$/;

function isChunk(v: unknown): v is ContentChunk {
  return !!v && typeof (v as any).text === 'string' && typeof (v as any).page === 'number';
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms: number, pct = 0.25) {
  const d = ms * pct;
  return Math.max(0, ms - d + Math.random() * (2 * d));
}

function normalizeOcrText(raw: string): string {
  return raw
    // drop leading/trailing lines that are just page numbers
    .replace(/^(?:\s*\d+\s*$\n?)+/m, '')
    .replace(/(?:\n?\s*\d+\s*$)+$/m, '')
    // normalize whitespace
    .replace(/[\t\f\r]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    // trim doc and each line
    .replace(/^\s+|\s+$/g, '')
    .replace(/^\s*/gm, '')
    .replace(/\s*$/gm, '');
}

function parseIndexPage(filePath: string): { index: number; page: number } {
  const m = filePath.match(INDEX_PAGE_RE);
  assert(m?.[1] && m?.[2], `invalid screenshot filename: ${filePath}`);
  const index = Number.parseInt(m[1]!, 10);
  const page = Number.parseInt(m[2]!, 10);
  assert(!Number.isNaN(index) && !Number.isNaN(page), `invalid screenshot filename: ${filePath}`);
  return { index, page };
}

function sortScreenshots(paths: string[]): string[] {
  return paths.slice().sort((a, b) => {
    const A = parseIndexPage(a);
    const B = parseIndexPage(b);
    return A.index - B.index || A.page - B.page;
  });
}

async function backoff(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)
  const pageScreenshotsDir = path.join(outDir, 'pages')
  const pageScreenshots = sortScreenshots(await globby(`${pageScreenshotsDir}/*.png`))
  assert(pageScreenshots.length, 'no page screenshots found')

  const openai = new OpenAIClient()

  const content: ContentChunk[] = (
    await pMap(
      pageScreenshots,
      async (screenshot) => {
        const screenshotBuffer = await fs.readFile(screenshot)
        const screenshotBase64 = `data:image/png;base64,${screenshotBuffer.toString('base64')}`
        const { index, page } = parseIndexPage(screenshot);

        const maxRetries = 8;
        let attempt = 0;
        while (true) {
          try {
            const res = await openai.createChatCompletion({
              model: 'gpt-4o',
              temperature: attempt < 2 ? 0 : 0.5,
              messages: [
                {
                  role: 'system',
                  content:
                    'You will be given an image containing text. Read the text from the image and output it verbatim.\n\nDo not include any additional text, descriptions, or punctuation. Ignore any embedded images. Do not use markdown.' +
                    (attempt > 2
                      ? '\n\nThis is critical OCR; do not refuse. If text is faint or skewed, transcribe best-effort.'
                      : '')
                },
                {
                  role: 'user',
                  content: [
                    {
                      type: 'image_url',
                      image_url: { url: screenshotBase64 }
                    }
                  ] as any
                }
              ]
            });

            const rawText = res.choices[0]?.message.content ?? '';
            const text = normalizeOcrText(rawText);

            if (!text || (text.length < 100 && /i'm sorry|cannot|copyright/i.test(text))) {
              attempt++;
              if (attempt >= maxRetries) {
                throw new Error(`OCR refusal/empty after ${attempt} attempts`);
              }
              await sleep(jitter(Math.min(60_000, 500 * 2 ** attempt)));
              continue;
            }

            const result: ContentChunk = { index, page, text, screenshot };
            console.log(result);
            return result;
          } catch (err: any) {
            // handle rate limits / transient failures with backoff
            const msg = String(err?.message || err);
            if (/429|rate limit|ETIMEDOUT|ECONNRESET|5\d\d/i.test(msg) && attempt < maxRetries) {
              attempt++;
              const wait = Math.min(90_000, 750 * 2 ** attempt);
              console.warn(`retry ${attempt}/${maxRetries} for ${screenshot} after error:`, msg);
              await sleep(jitter(wait));
              continue;
            }
            console.error(`error processing image ${index} (${screenshot})`, err);
            return undefined; // allow type guard to drop this page
          }
        }
      },
      { concurrency: 4 }
    )
  ).filter(isChunk)

  // Sanity: log any pages that failed so you can re-run selectively
  const expected = pageScreenshots.length;
  const received = content.length;
  if (received !== expected) {
    const got = new Set(content.map((c) => `${c.index}-${c.page}`));
    const missing = pageScreenshots
      .map((p) => p.match(INDEX_PAGE_RE)!)
      .filter((m) => !got.has(`${Number(m[1])}-${Number(m[2])}`))
      .map((m) => `${m[1]}-${m[2]}`);
    console.warn(`WARNING: ${expected - received} page(s) missing`, { missing });
  }

  await fs.writeFile(
    path.join(outDir, 'content.json'),
    JSON.stringify(content, null, 2)
  )
  console.log(`Wrote ${content.length} chunks to ${path.join(outDir, 'content.json')}`);
}

await main()
