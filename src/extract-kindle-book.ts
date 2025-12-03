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

const TIME = {
  otpVisible: 120_000,
  navOpen: 30_000,
  click: 1000,
  menuOpen: 10_000,
  footerSample: 150,
  imgChangeWait: 1200,
  finalWait: 6000
} as const

const SEL = {
  mainImg: '#kr-renderer .kg-full-page-img img',
  footerTitle: 'ion-footer ion-title',
  chevronRight: '.kr-chevron-container-right',
  chevronLeft: '.kr-chevron-container-left',
  readerHeader: '#reader-header, .top-chrome, ion-toolbar',
  tocItems: 'ion-list ion-item'
} as const

// Helper used to avoid declaring functions inside loops (fixes no-loop-func)
async function captureMainImageBuffer(page: Page): Promise<Buffer> {
  return withCleanCapture(
    page,
    () =>
      page
        .locator(SEL.mainImg)
        .screenshot({ type: 'png', scale: 'css' }) as Promise<Buffer>
  )
}

// Serializable function for .evaluate to avoid inline lambdas inside loops
function getImageDims(img: HTMLImageElement) {
  return {
    naturalWidth: img.naturalWidth || 0,
    naturalHeight: img.naturalHeight || 0,
    cssWidth: (img as any).width || (img as any).clientWidth || 0,
    cssHeight: (img as any).height || (img as any).clientHeight || 0
  }
}

function getReaderScope(page: Page): Page {
  return (page.frame({ url: /read\.amazon\./ }) ||
    page.mainFrame()) as unknown as Page
}

async function withCleanCapture<T>(
  page: Page,
  fn: () => Promise<T>
): Promise<T> {
  const styleEl = await page
    .addStyleTag({
      content:
        '.top-chrome, ion-toolbar, ion-footer { opacity: 0 !important; } ion-popover, ion-modal { display: none !important; }'
    })
    .catch(() => null)
  try {
    return await fn()
  } finally {
    if (styleEl) {
      await styleEl
        .evaluate((el: Element) => {
          ;(el as HTMLElement).remove()
        })
        .catch(() => {})
    }
  }
}

// eslint-disable-next-line no-process-env
const DEBUG_KINDLE = process.env.DEBUG_KINDLE === '1'
// eslint-disable-next-line no-process-env
const LOG_FOOTER = process.env.LOG_FOOTER === '1'
// eslint-disable-next-line no-process-env
const SKIP_RESET_FLAG = process.env.SKIP_RESET === '1'
const DBG = DEBUG_KINDLE
function dlog(...args: any[]) {
  if (DBG) console.warn(new Date().toISOString(), '-', ...args)
}
function short(v?: string | null) {
  if (!v) return String(v)
  try {
    const u = new URL(v)
    return `${u.pathname.split('/').pop()}`
  } catch {
    return v.length > 64 ? v.slice(0, 64) + '…' : v
  }
}

interface PageNav {
  page?: number
  location?: number
  total: number
}
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

async function completeOtpFlow(page: Page, code: string) {
  // Wait for any known OTP input to appear (Amazon uses several variants)
  const otpInput = page.locator(
    'input#cvf-input-code, input[name="code"], input[type="tel"]'
  )
  await otpInput.waitFor({ state: 'visible', timeout: TIME.otpVisible })

  await otpInput.fill(code)

  // Try the common submit buttons first, then fall back to pressing Enter
  const submitCandidates = [
    'input#cvf-submit-otp-button',
    'input[type="submit"][aria-labelledby="cvf-submit-otp-button-announce"]',
    'button[name="verifyCode"]'
  ]

  let clicked = false
  for (const sel of submitCandidates) {
    const btn = page.locator(sel)
    if (await btn.isVisible()) {
      await btn.click()
      clicked = true
      break
    }
  }

  if (!clicked) {
    const byRole = page.getByRole('button', { name: /verify|submit|continue/i })
    if (await byRole.isVisible()) {
      await byRole.click()
      clicked = true
    }
  }

  if (!clicked) {
    await otpInput.press('Enter')
  }

  // Some accounts show a "remember this device" step; handle it if present
  const rememberCheckbox = page.locator(
    'input[name="rememberDevice"], input#auth-mfa-remember-device'
  )
  if (await rememberCheckbox.isVisible()) {
    await rememberCheckbox.check().catch(() => {})
    const rememberSubmit = page.locator(
      'input#cvf-submit-remember-device, input[type="submit"][aria-labelledby="cvf-submit-remember-device-announce"]'
    )
    if (await rememberSubmit.isVisible()) {
      await rememberSubmit.click()
    } else {
      await page
        .getByRole('button', { name: /continue|submit/i })
        .click()
        .catch(() => {})
    }
  }

  // Wait for navigation away from the CVF (challenge) page
  await Promise.race([
    page
      .waitForURL(/read\.amazon\.[^/]+\//, { timeout: 60_000 })
      .catch(() => {}),
    page.waitForURL(/kindle-library/, { timeout: 60_000 }).catch(() => {}),
    page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {})
  ])
}

async function getFooterRaw(page: Page) {
  try {
    const t = await page
      .locator(SEL.footerTitle)
      .first()
      .textContent({ timeout: 2000 })
    return (t || '').trim()
  } catch {
    return ''
  }
}

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
  const bookReaderUrl = `https://read.amazon.com/?asin=${asin}`

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

        if (!result.meta) {
          console.warn('book meta', metadata)
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

          const locationMap = await tryReadJsonFile<AmazonRenderLocationMap>(
            path.join(renderDir, 'location_map.json')
          )
          if (locationMap) {
            result.locationMap = locationMap

            for (const navUnit of result.locationMap.navigationUnit) {
              navUnit.page = Number.parseInt(navUnit.label, 10)
              assert(
                !Number.isNaN(navUnit.page),
                `invalid locationMap page number: ${navUnit.label}`
              )
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
          if (rawToc && result.locationMap && !result.toc) {
            const toc: TocItem[] = []

            for (const rawTocItem of rawToc) {
              toc.push(...getTocItems(rawTocItem, { depth: 0 }))
            }

            result.toc = toc
          }

          // TODO: `page_data_0_5.json` has start/end/words for each page in this render batch
          // const toc = JSON.parse(
          //   await fs.readFile(path.join(tempDir, 'toc.json'), 'utf8')
          // )
          // console.warn('toc', toc)
        }
      }

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

    // Note: Playwright's Frame and Page share the `locator` and `getByRole` APIs used here.
    async function updateSettings() {
      const scope = getReaderScope(page)

      // Make sure the reader UI is actually visible; toolbars auto-hide
      await scope.waitForLoadState?.('domcontentloaded').catch(() => {})
      await delay(500)

      // Nudge the header/toolbar to appear
      try {
        await page.locator(SEL.readerHeader).first().hover({ force: true })
      } catch {}
      try {
        await page.mouse.move(50, 50)
      } catch {}

      // Candidate locators for the settings button (label varies: "Reader settings", "Aa", etc.)
      // Overlay/panel that appears when settings are open (best-effort across UIs)
      const settingsOverlay = scope.locator?.(
        'ion-popover, ion-modal, [role="dialog"], .reader-settings'
      )
      const candidates = [
        scope.getByRole?.('button', { name: /reader settings/i } as any),
        scope.getByRole?.('button', { name: /^aa$/i } as any),
        scope.locator?.('ion-button[title="Reader settings"]'),
        scope.locator?.('button[title="Reader settings"]'),
        scope.locator?.('ion-button[title="Aa"]'),
        scope.locator?.(
          '[data-testid="reader-settings"], [aria-label="Reader settings"]'
        )
      ].filter(Boolean) as Locator[]

      let clicked = false
      const deadline = Date.now() + 30_000

      // Keep trying until one becomes visible or we time out
      while (!clicked && Date.now() < deadline) {
        for (const cand of candidates) {
          if (await cand.isVisible().catch(() => false)) {
            await cand.click({ timeout: 2000 }).catch(() => {})
            clicked = true
            break
          }
        }
        if (!clicked) {
          // Re-hover the header to keep toolbar visible
          await page
            .locator(SEL.readerHeader)
            .first()
            .hover({ force: true })
            .catch(() => {})
          await delay(300)
        }
      }

      if (!clicked) {
        await page
          .screenshot({ path: 'reader-settings-timeout.png', fullPage: true })
          .catch(() => {})
        throw new Error(
          'Could not find the Reader Settings button. Saved screenshot: reader-settings-timeout.png'
        )
      }

      await delay(800)

      // Change font to Amazon Ember (best-effort across UIs)
      const ember = scope.locator?.(
        '#AmazonEmber, [data-font="Amazon Ember"], button:has-text("Amazon Ember")'
      )
      if (ember) {
        await ember
          .first()
          .click({ timeout: 2000 })
          .catch(() => {})
      }

      // Change layout to single column (label text can vary)
      const singleColGroup = scope.locator?.(
        '[role="radiogroup"][aria-label$=" columns"]'
      )
      if (singleColGroup) {
        await singleColGroup
          .filter({ hasText: /single column/i })
          .first()
          .click({ timeout: 2000 })
          .catch(() => {})
      } else {
        await scope
          .getByRole?.('radio', { name: /single column/i } as any)
          .click({ timeout: 2000 })
          .catch(() => {})
      }

      // Give the UI a moment to apply changes before we try to close it
      await delay(200)

      // Close settings (toggle Aa or click the same button again)
      const closeSettings = [
        scope.locator?.('ion-button[title="Reader settings"]'),
        scope.locator?.('button[title="Reader settings"]'),
        scope.getByRole?.('button', { name: /^aa$/i } as any)
      ].filter(Boolean) as Locator[]

      let closed = false
      for (const c of closeSettings) {
        if (await c.isVisible().catch(() => false)) {
          await c.click({ timeout: 2000 }).catch(() => {})
          // Wait briefly to see if overlay disappears
          if (
            settingsOverlay &&
            (await settingsOverlay
              .first()
              .isVisible()
              .catch(() => false))
          ) {
            await settingsOverlay
              .first()
              .waitFor({ state: 'hidden', timeout: 1000 })
              .catch(() => {})
          }
          closed = true
          break
        }
      }

      // Fallback: force-close via Escape or clicking outside
      const closeDeadline = Date.now() + 3000
      while (
        settingsOverlay &&
        (await settingsOverlay
          .first()
          .isVisible()
          .catch(() => false)) &&
        Date.now() < closeDeadline
      ) {
        await page.keyboard.press('Escape').catch(() => {})
        await delay(150)
        if (
          await settingsOverlay
            .first()
            .isVisible()
            .catch(() => false)
        ) {
          // Click outside the overlay to dismiss if possible
          await page.mouse.click(10, 10).catch(() => {})
          await delay(150)
        }
        if (!closed) {
          // Try toggling the Aa/settings button again
          for (const c of closeSettings) {
            if (await c.isVisible().catch(() => false)) {
              await c.click({ timeout: 1000 }).catch(() => {})
              break
            }
          }
        }
      }

      // Final safety: ensure overlay is hidden before proceeding
      if (
        settingsOverlay &&
        (await settingsOverlay
          .first()
          .isVisible()
          .catch(() => false))
      ) {
        await page
          .screenshot({ path: 'settings-stuck.png', fullPage: true })
          .catch(() => {})
        throw new Error(
          'Reader Settings panel did not close. Saved screenshot: settings-stuck.png'
        )
      }

      await delay(300)
    }

    if (!page.url().includes(bookReaderUrl)) {
      await page.goto(bookReaderUrl)
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

          const stepped = await stepOnce(direction, currentNav)
          if (!stepped?.page || stepped.page === currentNav.page) {
            throw new Error(
              `LOCATION_MODE: unable to step ${direction} toward ${pageNumber}; last page ${currentNav.page}`
            )
          }
          currentNav = stepped
          iterations++
        }

        if (currentNav?.page !== pageNumber) {
          throw new Error(
            `LOCATION_MODE: failed to reach location ${pageNumber}; last seen ${currentNav?.page ?? 'unknown'}`
          )
        }
        return
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

  function getPageForPosition(position: number): number {
    if (!result.locationMap) return -1

    let resultPage = 1

    // TODO: this is O(n) but we can do better
    for (const { startPosition, page } of result.locationMap.navigationUnit) {
      if (startPosition > position) break

      resultPage = page
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

  // At this point, we should have recorded all the base book metadata from the
  // initial network requests.
  assert(result.info, 'expected book info to be initialized')
  assert(result.meta, 'expected book meta to be initialized')
  assert(result.toc?.length, 'expected book toc to be initialized')
  assert(result.locationMap, 'expected book location map to be initialized')

  result.nav.startContentPosition = result.meta.startPosition
  result.nav.totalNumPages = result.locationMap.navigationUnit.reduce(
    (acc, navUnit) => {
      return Math.max(acc, navUnit.page ?? -1)
    },
    -1
  )
  assert(result.nav.totalNumPages > 0, 'parsed book nav has no pages')
  result.nav.startContentPage = getPageForPosition(
    result.nav.startContentPosition
  )

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
  await goToPage(result.nav.startContentPage)

  let done = false
  console.warn(
    `\nreading ${result.nav.totalNumContentPages} content pages out of ${result.nav.totalNumPages} total pages...\n`
  )

  // Loop through each page of the book
  do {
    const pageNav = await getPageNav()

    if (pageNav?.page === undefined) {
      break
    }

    if (pageNav.page > result.nav.totalNumContentPages) {
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
        `no blob found for src: ${src} (index ${index}; page ${pageNav.page})`
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
    const pageChunk = {
      index,
      page: pageNav.page,
      screenshot: screenshotPath
    }
    result.pages.push(pageChunk)
    console.warn(pageChunk)
    await writeResultMetadata()

    const parsedToc = parseTocItems(tocSamples)
    const toc: TocItem[] = tocSamples.map(
      ({ locator: _, ...tocItem }) => tocItem
    )

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

        await delay(120)
        retries++
      } while (retries < maxRetries)

  await context.close()
  await context.browser()?.close()
}

await main()
