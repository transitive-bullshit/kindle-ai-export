import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { input } from '@inquirer/prompts'
import delay from 'delay'
import pRace from 'p-race'
// import { chromium } from 'playwright'
import { chromium } from 'patchright'
import sharp from 'sharp'

import type { BookMetadata, TocItem } from './types'
import { parsePageNav, parseTocItems } from './playwright-utils'
import { assert, getEnv, normalizeAuthors, parseJsonpResponse } from './utils'

// Block amazon analytics requests
// (not strictly necessary, but adblockers do this by default anyway and it
// makes the script run a bit faster)
const urlRegexBlacklist = [
  /unagi-\w+.amazon.com/i, // 'unagi-na.amazon.com'
  /m\.media-amazon\.com.*\/showads/i,
  /fls-na\.amazon\.com.*\/remote-weblab-triggers/i
]

type RENDER_METHOD = 'screenshot' | 'blob'
const renderMethod: RENDER_METHOD = 'blob'

async function main() {
  const asin = getEnv('ASIN')
  const amazonEmail = getEnv('AMAZON_EMAIL')
  const amazonPassword = getEnv('AMAZON_PASSWORD')
  const force = !!getEnv('FORCE')
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
  const bookReaderUrl = `https://read.amazon.com/?asin=${asin}`

  const result: BookMetadata = {
    meta: {} as any,
    info: {} as any,
    toc: [],
    pages: []
  }
  let prevBookMetadata: Partial<BookMetadata> = {}

  if (!force) {
    try {
      prevBookMetadata = JSON.parse(
        await fs.readFile(metadataPath, 'utf8')
      ) as Partial<BookMetadata>
    } catch {}
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    args: [
      // hide chrome's crash restore popup
      '--hide-crash-restore-bubble',
      // disable chrome's password autosave popups
      '--disable-features=PasswordAutosave',
      // disable chrome's passkey popups
      '--disable-features=WebAuthn'
    ],
    ignoreDefaultArgs: [
      // disable chrome's default automation detection flag
      '--enable-automation',
      // adding this cause chrome shows a weird admin popup without it
      '--no-sandbox',
      // adding this cause chrome shows a weird admin popup without it
      '--disable-blink-features=AutomationControlled'
    ],
    deviceScaleFactor: 2,
    viewport: { width: 1280, height: 720 },
    // bypass amazon's default content security policy which allows us to inject
    // our own scripts into the page
    bypassCSP: true
  })

  const page = context.pages()[0] ?? (await context.newPage())

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

        if (!Object.keys(result.meta).length) {
          if (
            metadata.version &&
            metadata.version === prevBookMetadata.meta?.version
          ) {
            if (!result.toc.length && prevBookMetadata.toc?.length) {
              // Use previously extracted TOC
              console.warn('using cached TOC', prevBookMetadata.toc)
              result.toc = prevBookMetadata.toc
            }
          }

          result.meta = metadata
        }
      } else if (
        url.hostname === 'read.amazon.com' &&
        url.searchParams.get('asin')?.toLowerCase() === asinL
      ) {
        if (url.pathname === '/service/mobile/reader/startReading') {
          const body: any = await response.json()
          delete body.karamelToken
          delete body.metadataUrl
          delete body.YJFormatVersion
          if (!Object.keys(result.info).length) {
            console.warn('book info', body)
          }
          result.info = body
        } else if (url.pathname === '/renderer/render') {
          // TODO: these TAR files have some useful metadata that we could use...
          // const body = await response.body()
          // const tempDir = await extractTarToTemp(body)
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
    await page.locator('ion-button[aria-label="Reader settings"]').click()
    await delay(500)

    // Change font to Amazon Ember
    // My hypothesis is that this font will be easier for OCR to transcribe...
    // TODO: evaluate different fonts & settings
    await page.locator('#AmazonEmber').click()

    // Change layout to single column
    await page
      .locator('[role="radiogroup"][aria-label$=" columns"]', {
        hasText: 'Single Column'
      })
      .click()

    await page.locator('ion-button[aria-label="Reader settings"]').click()
    await delay(500)
  }

  async function goToPage(pageNumber: number) {
    await page.locator('#reader-header').hover({ force: true })
    await delay(200)
    await page.locator('ion-button[aria-label="Reader menu"]').click()
    await delay(500)
    await page
      .locator('ion-item[role="listitem"]', { hasText: 'Go to Page' })
      .click()
    await page
      .locator('ion-modal input[placeholder="page number"]')
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
    return fs.writeFile(metadataPath, JSON.stringify(result, null, 2))
  }

  await dismissPossibleAlert()
  await ensureFixedHeaderUI()
  await updateSettings()

  const initialPageNav = await getPageNav()

  if (!force && result.toc.length) {
    // Using a cached table of contents
  } else {
    // Extract the table of contents
    await page.locator('ion-button[aria-label="Table of Contents"]').click()
    await delay(500)

    const numTocItems = await page.locator('ion-list ion-item').count()
    const $tocTopLevelItems = await page
      // TODO: this is pretty brittle
      .locator('ion-list > div > ion-item')
      .all()
    const tocItems: Array<TocItem> = []

    console.warn(`initializing ${numTocItems} TOC items...`)

    // Make sure toc items are in order by y-position; for some reason, the `.all()`
    // above doesn't always retain the document ordering.
    const $tocTopLevelItems2 = await Promise.all(
      $tocTopLevelItems.map(async (tocItem) => {
        const bbox = await tocItem.boundingBox()
        return { tocItem, bbox }
      })
    )

    $tocTopLevelItems2.sort((a, b) => a.bbox!.y - b.bbox!.y)
    const $tocTopLevelItems3 = $tocTopLevelItems2.map(({ tocItem }) => tocItem)

    // Loop through each TOC item and extract the page number and title.
    for (const $tocItem of $tocTopLevelItems3) {
      const label = (await $tocItem.textContent())?.trim()
      if (!label) continue

      await $tocItem.click()
      await delay(10)

      const pageNav = await getPageNav()
      assert(pageNav)

      const currentTocItem: TocItem = {
        label,
        depth: 0,
        ...pageNav
      }
      tocItems.push(currentTocItem)
      console.warn(currentTocItem)

      // if (pageNav.page !== undefined) {
      //   // TODO: this assumes the toc items are in order and contiguous...
      //   if (pageNav.page >= pageNav.total) {
      //     break
      //   }
      // }

      const subTocItems = await $tocItem
        .locator(' + .show-children ion-item')
        .all()

      if (subTocItems.length > 0) {
        console.warn(`${label}: found ${subTocItems.length} sub-TOC items...`)

        for (const $subTocItem of subTocItems) {
          const label = await $subTocItem.textContent()
          assert(label)

          await $subTocItem.click()
          await delay(10)

          const pageNav = await getPageNav()
          assert(pageNav)

          tocItems.push({
            label,
            depth: 1,
            ...pageNav
          })

          console.warn(currentTocItem.label, '=> sub-toc', {
            label,
            ...pageNav
          })
        }
      }
    }

    result.toc = tocItems

    // Close the table of contents modal
    await page.locator('.side-menu-close-button').click()
    await delay(500)

    // Navigate to the first content page of the book
    // await parsedToc.firstContentPageTocItem.locator!.click()
  }

  const parsedToc = parseTocItems(result.toc)

  const totalPages = parsedToc.firstContentPageTocItem.total
  const totalContentPages = Math.min(
    parsedToc.firstPostContentPageTocItem?.page ?? totalPages,
    totalPages
  )
  assert(totalContentPages > 0, 'No content pages found')
  const pageNumberPaddingAmount = `${totalContentPages * 2}`.length
  await writeResultMetadata()

  // Navigate to the first content page of the book
  await goToPage(parsedToc.firstContentPageTocItem.page! ?? 1)

  let maxPageSeen = -1
  let done = false
  console.warn(
    `\nreading ${totalContentPages} content pages out of ${totalPages} total pages...\n`
  )

  // Loop through each page of the book
  do {
    const pageNav = await getPageNav()

    if (pageNav?.page === undefined) {
      break
    }

    if (pageNav.page > totalContentPages) {
      break
    }

    if (pageNav.page < maxPageSeen) {
      break
    }

    const index = result.pages.length
    maxPageSeen = Math.max(maxPageSeen, pageNav.page)

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
        `no blob found for src: ${src} (index ${index}; page ${pageNav.page})`
      )

      const rawRenderedImage = Buffer.from(blob.base64, 'base64')
      const c = sharp(rawRenderedImage)
      const m = await c.metadata()
      renderedPageImageBuffer = await c
        .resize({
          width: Math.floor(m.width / 2),
          height: Math.floor(m.height / 2)
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
      `no buffer found for src: ${src} (index ${index}; page ${pageNav.page})`
    )

    const screenshotPath = path.join(
      pageScreenshotsDir,
      `${index}`.padStart(pageNumberPaddingAmount, '0') +
        '-' +
        `${pageNav.page}`.padStart(pageNumberPaddingAmount, '0') +
        '.png'
    )

    await fs.writeFile(screenshotPath, renderedPageImageBuffer)
    result.pages.push({
      index,
      page: pageNav.page,
      total: pageNav.total,
      screenshot: screenshotPath
    })
    await writeResultMetadata()

    console.warn(result.pages.at(-1))

    let retries = 0

    do {
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

      if (++retries >= 10) {
        console.warn('unable to navigate to next page; breaking...', pageNav)
        done = true
        break
      }
    } while (true)

    // Navigation is very spotty without this delay; I think it may be due to
    // the screenshot changing the DOM temporarily and not being stable yet.
    // await delay(100)

    // let retries = 0

    // // Occasionally the next page button doesn't work, so ensure that the main
    // // image src actually changes before continuing.
    // do {
    //   try {
    //     // Navigate to the next page
    //     // await delay(100)
    //     if (retries % 10 === 0) {
    //       if (retries > 0) {
    //         console.warn('retrying...', {
    //           src,
    //           retries,
    //           ...result.pages.at(-1)
    //         })
    //       }

    //       // Click the next page button
    //       await page
    //         .locator('.kr-chevron-container-right')
    //         .click({ timeout: 1000 })
    //     }
    //     // await delay(500)
    //   } catch (err: any) {
    //     // No next page to navigate to
    //     console.warn(
    //       'unable to navigate to next page; breaking...',
    //       err.message
    //     )
    //     break
    //   }

    //   const newSrc = await page
    //     .locator(krRendererMainImageSelector)
    //     .getAttribute('src')
    //   if (newSrc !== src) {
    //     // Successfully navigated to the next page
    //     break
    //   }

    //   if (pageNav.page >= totalContentPages) {
    //     break
    //   }

    //   await delay(100)

    //   ++retries
    // } while (true)
  } while (!done)

  await writeResultMetadata()
  console.log()
  console.log(JSON.stringify(result, null, 2))

  if (initialPageNav?.page !== undefined) {
    console.warn(`resetting back to initial page ${initialPageNav.page}...`)
    // Reset back to the initial page
    await goToPage(initialPageNav.page)
  }

  // await page.close()
  await context.close()
  await context.browser()?.close()
}

await main()
