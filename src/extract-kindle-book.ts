import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { SetRequired } from 'type-fest'
import { input } from '@inquirer/prompts'
import delay from 'delay'
import pRace from 'p-race'
// import { chromium } from 'playwright'
import { chromium } from 'patchright'
import sharp from 'sharp'

import type {
  AmazonRenderLocationMap,
  AmazonRenderToc,
  AmazonRenderTocItem,
  BookMetadata,
  TocItem
} from './types'
import { parsePageNav, parseTocItems } from './playwright-utils'
import {
  assert,
  extractTar,
  getEnv,
  hashObject,
  normalizeAuthors,
  normalizeBookMetadata,
  parseJsonpResponse,
  tryReadJsonFile
} from './utils'

// Block amazon analytics requests
// (not strictly necessary, but adblockers do this by default anyway and it
// makes the script run a bit faster)
const urlRegexBlacklist = [
  /unagi-\w+\.amazon\.com/i, // 'unagi-na.amazon.com'
  /m\.media-amazon\.com.*\/showads/i,
  /fls-na\.amazon\.com.*\/remote-weblab-triggers/i
]

type RENDER_METHOD = 'screenshot' | 'blob'
const renderMethod: RENDER_METHOD = 'blob'

async function main() {
  const asin = getEnv('ASIN')
  const amazonEmail = getEnv('AMAZON_EMAIL')
  const amazonPassword = getEnv('AMAZON_PASSWORD')
  assert(asin, 'ASIN is required')
  assert(amazonEmail, 'AMAZON_EMAIL is required')
  assert(amazonPassword, 'AMAZON_PASSWORD is required')
  const asinL = asin.toLowerCase()

  const outDir = path.join('out', asin)
  const userDataDir = path.join(outDir, 'data')
  const pageScreenshotsDir = path.join(outDir, 'pages')
  const metadataPath = path.join(outDir, 'metadata.json')
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.mkdir(pageScreenshotsDir, { recursive: true })

  const krRendererMainImageSelector = '#kr-renderer .kg-full-page-img img'
  // Normalize AMAZON_HOST: tolerate empty values, schemes, trailing slashes
  // and uppercase, since it is compared against url.hostname (always
  // lowercase, no scheme) and interpolated into the reader URL.
  const amazonHost =
    (getEnv('AMAZON_HOST') ?? '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '') || 'read.amazon.com'
  const bookReaderUrl = `https://${amazonHost}/?asin=${asin}`

  const result: SetRequired<Partial<BookMetadata>, 'pages' | 'nav'> = {
    pages: [],
    // locationMap: { locations: [], navigationUnit: [] },
    nav: {
      startPosition: -1,
      endPosition: -1,
      startContentPosition: -1,
      startContentPage: -1,
      endContentPosition: -1,
      endContentPage: -1,
      totalNumPages: -1,
      totalNumContentPages: -1
    }
  }

  const deviceScaleFactor = 2
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    // Kindle's web reader registers a service worker that can serve reader
    // API responses from its own cache, hiding them from page.on('response').
    // Blocking it keeps requests on the observable network path; note that
    // some reader variants still fetch startReading/YJmetadata in ways
    // Playwright cannot observe — see the metadata fallbacks further down.
    serviceWorkers: 'block',
    args: [
      // hide chrome's crash restore popup
      '--hide-crash-restore-bubble',
      // disable chrome's password autosave popups
      '--disable-features=PasswordAutosave',
      // disable chrome's passkey popups
      '--disable-features=WebAuthn',
      // disable chrome creating 1GB temp directories on each run
      '--disable-features=MacAppCodeSignClone'
    ],
    ignoreDefaultArgs: [
      // disable chrome's default automation detection flag
      '--enable-automation',
      // adding this cause chrome shows a weird admin popup without it
      '--no-sandbox',
      // adding this cause chrome shows a weird admin popup without it
      '--disable-blink-features=AutomationControlled'
    ],
    // bypass amazon's default content security policy which allows us to inject
    // our own scripts into the page
    bypassCSP: true,
    deviceScaleFactor,
    viewport: { width: 1280, height: 720 }
  })

  const page = context.pages()[0] ?? (await context.newPage())

  // Set when result.meta was synthesized from env-var fallbacks, so a real
  // YJmetadata.jsonp response arriving later can still overwrite it.
  let isFallbackMeta = false

  await page.route('**/*', async (route) => {
    const urlString = route.request().url()
    for (const regex of urlRegexBlacklist) {
      if (regex.test(urlString)) {
        return route.abort()
      }
    }

    return route.continue()
  })

  page.on('response', async (response) => {
    try {
      const status = response.status()
      if (status !== 200) {
        return
      }

      const url = new URL(response.url())
      if (url.pathname.endsWith('YJmetadata.jsonp')) {
        const body = await response.text()
        const metadata = parseJsonpResponse<any>(body)
        if (metadata.asin !== asin) return

        delete metadata.cpr
        if (Array.isArray(metadata.authorsList)) {
          metadata.authorsList = normalizeAuthors(metadata.authorsList)
        }

        if (!result.meta || isFallbackMeta) {
          console.warn('book meta', metadata)
          result.meta = metadata
          isFallbackMeta = false
        }
      } else if (
        url.hostname === amazonHost &&
        url.searchParams.get('asin')?.toLowerCase() === asinL
      ) {
        if (url.pathname === '/service/mobile/reader/startReading') {
          const body: any = await response.json()
          delete body.karamelToken
          delete body.metadataUrl
          delete body.YJFormatVersion
          if (!result.info) {
            console.warn('book info', body)
          }
          result.info = body
        } else if (url.pathname === '/renderer/render') {
          // TODO: these TAR files have some useful metadata that we could use...
          const params = Object.fromEntries(url.searchParams.entries())
          const hash = hashObject(params)
          const renderDir = path.join(userDataDir, 'render', hash)
          await fs.mkdir(renderDir, { recursive: true })
          const body = await response.body()
          const tempDir = await extractTar(body, { cwd: renderDir })
          const { startingPosition, skipPageCount, numPage } = params
          console.log('RENDER TAR', tempDir, {
            startingPosition,
            skipPageCount,
            numPage
          })

          await processRenderData(renderDir)

          // TODO: `page_data_0_5.json` has start/end/words for each page in this render batch
          // const toc = JSON.parse(
          //   await fs.readFile(path.join(tempDir, 'toc.json'), 'utf8')
          // )
          // console.warn('toc', toc)
        }
      }
    } catch {}
  })

  // Only used for the 'blob' render method
  const capturedBlobs = new Map<
    string,
    {
      type: string
      base64: string
    }
  >()

  if (renderMethod === 'blob') {
    await page.exposeFunction('nodeLog', (...args: any[]) => {
      console.error('[page]', ...args)
    })

    await page.exposeBinding('captureBlob', (_source, url, payload) => {
      capturedBlobs.set(url, payload)
    })

    await context.addInitScript(() => {
      const origCreateObjectURL = URL.createObjectURL.bind(URL)
      URL.createObjectURL = function (blob: Blob) {
        // TODO: filter for image/png blobs? since those are the only ones we're using
        // (haven't found this to be an issue in practice)
        const type = blob.type || 'application/octet-stream'
        const url = origCreateObjectURL(blob)
        // nodeLog('createObjectURL', url, type, blob.size)

        // Snapshot blob bytes immediately because kindle's renderer revokes
        // them immediately after they're used.
        ;(async () => {
          const buf = await blob.arrayBuffer()
          // store raw base64 (not data URL) to keep payload small
          let binary = ''
          const bytes = new Uint8Array(buf)
          for (const byte of bytes) {
            // eslint-disable-next-line unicorn/prefer-code-point
            binary += String.fromCharCode(byte)
          }

          const base64 = btoa(binary)

          // @ts-expect-error captureBlob
          captureBlob(url, { type, base64 })
        })()

        return url
      }
    })
  }

  // Try going directly to the book reader page if we're already authenticated.
  // Otherwise wait for the signin page to load.
  await Promise.any([
    page.goto(bookReaderUrl, { timeout: 30_000 }),
    page.waitForURL('**/ap/signin', { timeout: 30_000 })
  ])

  // If we're on the signin page, start the authentication flow.
  if (/\/ap\/signin/g.test(new URL(page.url()).pathname)) {
    await page.locator('input[type="email"]').fill(amazonEmail)
    await page.locator('input[type="submit"]').click()

    await page.locator('input[type="password"]').fill(amazonPassword)
    // await page.locator('input[type="checkbox"]').click()
    await page.locator('input[type="submit"]').click()

    if (!/\/kindle-library/g.test(new URL(page.url()).pathname)) {
      const code = await input({
        message: '2-factor auth code?'
      })

      // Only enter 2-factor auth code if needed
      if (code) {
        await page.locator('input[type="tel"]').fill(code)
        await page
          .locator(
            'input[type="submit"][aria-labelledby="cvf-submit-otp-button-announce"]'
          )
          .click()
      }
    }

    if (!page.url().includes(bookReaderUrl)) {
      await page.goto(bookReaderUrl)
    }
  }

  async function updateSettings() {
    console.log('Looking for Reader settings button')
    const settingsButton = page
      .locator(
        'ion-button[aria-label="Reader settings"], ' +
          'button[aria-label="Reader settings"]'
      )
      .first()
    await settingsButton.waitFor({ timeout: 30_000 })
    console.log('Clicking Reader settings')
    await settingsButton.click()
    await delay(500)

    // Change font to Amazon Ember
    // My hypothesis is that this font will be easier for OCR to transcribe...
    // TODO: evaluate different fonts & settings
    console.log('Changing font to Amazon Ember')
    await page.locator('#AmazonEmber').click()
    await delay(200)

    // Change layout to single column
    console.log('Changing to single column layout')
    await page
      .locator('[role="radiogroup"][aria-label$=" columns"]', {
        hasText: 'Single Column'
      })
      .click()
    await delay(200)

    console.log('Closing settings')
    await settingsButton.click()
    await delay(500)
  }

  async function goToPage(pageNumber: number) {
    await page.locator('#reader-header').hover({ force: true })
    await delay(200)
    await page.locator('ion-button[aria-label="Reader menu"]').click()
    await delay(500)
    await page
      .locator('ion-item[role="listitem"]', {
        // Location-based books label this menu item "Go to Location"
        hasText: /go to (page|location)/i
      })
      .click()
    await page
      .locator('ion-modal input[placeholder="page number"], ion-modal input')
      .first()
      .fill(`${pageNumber}`)
    // await page.locator('ion-modal button', { hasText: 'Go' }).click()
    await page
      .locator('ion-modal ion-button[item-i-d="go-to-modal-go-button"]')
      .click()
    await delay(500)
  }

  async function getPageNav() {
    const footerText = await page
      .locator('ion-footer ion-title')
      .first()
      .textContent()
    return parsePageNav(footerText)
  }

  async function ensureFixedHeaderUI() {
    await page.locator('.top-chrome').evaluate((el) => {
      el.style.transition = 'none'
      el.style.transform = 'none'
    })
  }

  async function dismissPossibleAlert() {
    const $alertNo = page.locator('ion-alert button', { hasText: 'No' })
    if (await $alertNo.isVisible()) {
      await $alertNo.click()
    }
  }

  async function writeResultMetadata() {
    return fs.writeFile(
      metadataPath,
      JSON.stringify(normalizeBookMetadata(result), null, 2)
    )
  }

  function getTocItems(
    rawTocItem: AmazonRenderTocItem,
    { depth = 0 }: { depth?: number } = {}
  ): TocItem[] {
    const positionId = rawTocItem.tocPositionId
    const page = getPageForPosition(positionId)

    const tocItem: TocItem = {
      label: rawTocItem.label,
      positionId,
      page,
      depth
    }

    const tocItems: TocItem[] = [tocItem]

    if (rawTocItem.entries) {
      for (const rawTocItemEntry of rawTocItem.entries) {
        tocItems.push(...getTocItems(rawTocItemEntry, { depth: depth + 1 }))
      }
    }

    return tocItems
  }

  async function processRenderData(renderDir: string) {
    const locationMap = await tryReadJsonFile<AmazonRenderLocationMap>(
      path.join(renderDir, 'location_map.json')
    )
    // Some books ship a locations-only map with no navigationUnit (no page
    // numbers at all); treat those like a missing location map.
    if (locationMap?.navigationUnit) {
      result.locationMap = locationMap

      for (const navUnit of result.locationMap.navigationUnit) {
        const parsedPage = Number.parseInt(navUnit.label, 10)
        // Front matter pages can carry roman-numeral labels (i, v, III, …);
        // leave those unnumbered rather than aborting the whole render parse.
        navUnit.page = Number.isNaN(parsedPage) ? undefined : parsedPage
      }
    }

    const metadata = await tryReadJsonFile<any>(
      path.join(renderDir, 'metadata.json')
    )
    if (metadata) {
      result.nav.startPosition = metadata.firstPositionId
      result.nav.endPosition = metadata.lastPositionId
    }

    const rawToc = await tryReadJsonFile<AmazonRenderToc>(
      path.join(renderDir, 'toc.json')
    )
    // Note: newer render formats omit location_map.json entirely; the
    // toc is still usable, its items just won't have page numbers
    // (getPageForPosition returns -1 without a location map).
    if (rawToc && !result.toc) {
      const toc: TocItem[] = []

      for (const rawTocItem of rawToc) {
        toc.push(...getTocItems(rawTocItem, { depth: 0 }))
      }

      result.toc = toc
    }
  }

  function getPageForPosition(position: number): number {
    if (!result.locationMap) return -1

    let resultPage = 1

    // TODO: this is O(n) but we can do better
    for (const { startPosition, page } of result.locationMap.navigationUnit) {
      if (startPosition > position) break

      if (page !== undefined) {
        resultPage = page
      }
    }

    return resultPage
  }

  await dismissPossibleAlert()
  await ensureFixedHeaderUI()
  await updateSettings()

  console.log('Waiting for book reader to load...')
  await page
    .waitForSelector(krRendererMainImageSelector, { timeout: 60_000 })
    .catch(() => {
      console.warn(
        'Main reader content may not have loaded, continuing anyway...'
      )
    })

  // Record the initial page navigation so we can reset back to it later
  const initialPageNav = await getPageNav()

  // Seed book data from render TARs saved by previous runs — the reader may
  // serve cached content and never re-request the toc-bearing render.
  const renderRoot = path.join(userDataDir, 'render')
  const priorRenderDirs = await fs.readdir(renderRoot).catch(() => [])
  for (const dir of priorRenderDirs) {
    if (result.toc && result.locationMap) break
    await processRenderData(path.join(renderRoot, dir)).catch(() => {})
  }

  // Give any in-flight render TAR processing a moment to finish before
  // asserting on the data it populates.
  for (let i = 0; i < 100 && !result.toc; i++) {
    await delay(100)
  }

  // At this point, we should have recorded all the base book metadata from the
  // initial network requests.
  // `info` (startReading) and `meta` (YJmetadata.jsonp) are not observable on
  // some Kindle web reader variants even with service workers blocked (e.g.
  // read.amazon.ca). Neither is required for page extraction, so fall back
  // instead of failing hard.
  if (!result.info) {
    console.warn('warning: book info (startReading) not captured; continuing')
  }

  if (!result.meta) {
    console.warn(
      'warning: book meta (YJmetadata.jsonp) not captured; using fallbacks'
    )
    if (result.nav.startPosition < 0) {
      console.warn(
        'warning: no start position available; extraction will begin at page 1 and may include front matter'
      )
    }
    isFallbackMeta = true
    result.meta = {
      asin,
      title: getEnv('BOOK_TITLE')?.trim() || asin,
      authorList: (getEnv('BOOK_AUTHOR') ?? '')
        .split(/[,;]/)
        .map((author) => author.trim())
        .filter(Boolean),
      startPosition: result.nav.startPosition
    } as any
  }

  assert(result.toc?.length, 'expected book toc to be initialized')
  if (!result.locationMap) {
    console.warn(
      'warning: render data has no location_map.json (newer format); using live page navigation for page counts'
    )
  }

  // result.meta is guaranteed by the fallback branch above
  result.nav.startContentPosition = result.meta!.startPosition
  result.nav.totalNumPages = result.locationMap
    ? result.locationMap.navigationUnit.reduce((acc, navUnit) => {
        return Math.max(acc, navUnit.page ?? -1)
      }, -1)
    : (initialPageNav?.total ?? -1)
  if (result.nav.totalNumPages <= 0) {
    // Location-based book with an unparseable footer: no way to know the
    // total ahead of time, so capture until navigation stops advancing.
    console.warn(
      'warning: no page count available from location map or reader footer; capturing until navigation stops'
    )
    result.nav.totalNumPages = 99_999
  }
  assert(result.nav.totalNumPages > 0, 'parsed book nav has no pages')
  result.nav.startContentPage = getPageForPosition(
    result.nav.startContentPosition
  )
  if (result.nav.startContentPage < 1) {
    // No location map to resolve the start-reading position; capture from
    // page 1 and accept some front matter.
    result.nav.startContentPage = 1
  }

  const parsedToc = parseTocItems(result.toc, {
    totalNumPages: result.nav.totalNumPages
  })
  result.nav.endContentPage =
    parsedToc.firstPostContentPageTocItem?.page ?? result.nav.totalNumPages
  result.nav.endContentPosition =
    parsedToc.firstPostContentPageTocItem?.positionId ?? result.nav.endPosition

  result.nav.totalNumContentPages = Math.min(
    parsedToc.firstPostContentPageTocItem?.page ?? result.nav.totalNumPages,
    result.nav.totalNumPages
  )
  assert(result.nav.totalNumContentPages > 0, 'No content pages found')
  const pageNumberPaddingAmount = `${result.nav.totalNumContentPages * 2}`
    .length
  await writeResultMetadata()

  // Navigate to the first content page of the book
  try {
    await goToPage(result.nav.startContentPage)
  } catch (err: any) {
    console.warn(
      'warning: unable to navigate to start page; capturing from current position',
      err.message
    )
  }

  let done = false
  console.warn(
    `\nreading ${result.nav.totalNumContentPages} content pages out of ${result.nav.totalNumPages} total pages...\n`
  )

  // Loop through each page of the book
  do {
    const pageNav = await getPageNav()

    // Location-based books (and unparseable footers) have no page numbers;
    // fall back to the location, then to a simple counter.
    const pageMarker =
      pageNav?.page ?? pageNav?.location ?? result.pages.length + 1

    if (pageMarker > result.nav.totalNumContentPages) {
      break
    }

    const index = result.pages.length

    const src = (await page
      .locator(krRendererMainImageSelector)
      .getAttribute('src'))!

    let renderedPageImageBuffer: Buffer | undefined

    if (renderMethod === 'blob') {
      const blob = await pRace<{ type: string; base64: string } | undefined>(
        (signal) => [
          (async () => {
            while (!signal.aborted) {
              const blob = capturedBlobs.get(src)

              if (blob) {
                capturedBlobs.delete(src)
                return blob
              }

              await delay(1)
            }
          })(),

          delay(10_000, { signal })
        ]
      )

      assert(
        blob,
        `no blob found for src: ${src} (index ${index}; page ${pageMarker})`
      )

      const rawRenderedImage = Buffer.from(blob.base64, 'base64')
      const c = sharp(rawRenderedImage)
      const m = await c.metadata()
      renderedPageImageBuffer = await c
        .resize({
          width: Math.floor(m.width / deviceScaleFactor),
          height: Math.floor(m.height / deviceScaleFactor)
        })
        .png({ quality: 90 })
        .toBuffer()
    } else {
      renderedPageImageBuffer = await page
        .locator(krRendererMainImageSelector)
        .screenshot({ type: 'png', scale: 'css' })
    }

    assert(
      renderedPageImageBuffer,
      `no buffer found for src: ${src} (index ${index}; page ${pageMarker})`
    )

    const screenshotPath = path.join(
      pageScreenshotsDir,
      `${index}`.padStart(pageNumberPaddingAmount, '0') +
        '-' +
        `${pageMarker}`.padStart(pageNumberPaddingAmount, '0') +
        '.png'
    )

    await fs.writeFile(screenshotPath, renderedPageImageBuffer)
    const pageChunk = {
      index,
      page: pageMarker,
      screenshot: screenshotPath
    }
    result.pages.push(pageChunk)
    console.warn(pageChunk)
    await writeResultMetadata()

    let retries = 0

    do {
      // This delay seems to help speed up the navigation process, possibly due
      // to the navigation chevron needing time to settle.
      await delay(100)

      let navigationTimeout = 10_000
      try {
        // await page.keyboard.press('ArrowRight')
        await page
          .locator('.kr-chevron-container-right')
          .click({ timeout: 5000 })
      } catch (err: any) {
        console.warn('unable to click next page button', err.message, pageNav)
        navigationTimeout = 1000
      }

      const navigatedToNextPage = await pRace<boolean | undefined>((signal) => [
        (async () => {
          while (!signal.aborted) {
            const newSrc = await page
              .locator(krRendererMainImageSelector)
              .getAttribute('src')

            if (newSrc && newSrc !== src) {
              // Successfully navigated to the next page
              return true
            }

            await delay(10)
          }

          return false
        })(),

        delay(navigationTimeout, { signal })
      ])

      if (navigatedToNextPage) {
        break
      }

      if (++retries >= 30) {
        console.warn('unable to navigate to next page; breaking...', pageNav)
        done = true
        break
      }
    } while (true)
  } while (!done)

  await writeResultMetadata()
  console.log()
  console.log(metadataPath)

  const resetTarget = initialPageNav?.page ?? initialPageNav?.location
  if (resetTarget !== undefined) {
    console.warn(`resetting back to initial page/location ${resetTarget}...`)
    // Reset back to the initial position
    await goToPage(resetTarget).catch((err: any) => {
      console.warn('warning: unable to reset reading position', err.message)
    })
  }

  await context.close()
  await context.browser()?.close()
}

await main()
