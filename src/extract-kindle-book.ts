#!/usr/bin/env node
/* eslint-disable no-process-env */
import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { input } from '@inquirer/prompts'
import delay from 'delay'
import { chromium, type Locator } from 'playwright'

import {
  assert,
  deromanize,
  normalizeAuthors,
  parseJsonpResponse
} from './utils'

interface PageNav {
  page?: number
  location?: number
  total: number
}

interface TocItem extends PageNav {
  title: string
  locator?: Locator
}

interface PageChunk {
  index: number
  page: number
  total: number
  screenshot: string
}

async function main() {
  const asin = process.env.ASIN
  const amazonEmail = process.env.AMAZON_EMAIL
  const amazonPassword = process.env.AMAZON_PASSWORD
  assert(asin, 'ASIN is required')
  assert(amazonEmail, 'AMAZON_EMAIL is required')
  assert(amazonPassword, 'AMAZON_PASSWORD is required')

  const outDir = path.join('out', asin)
  const userDataDir = path.join(outDir, 'data')
  const pageScreenshotsDir = path.join(outDir, 'pages')
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.mkdir(pageScreenshotsDir, { recursive: true })

  const bookReaderUrl = `https://read.amazon.com/?asin=${asin}`

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    executablePath:
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--hide-crash-restore-bubble'],
    ignoreDefaultArgs: ['--enable-automation'],
    deviceScaleFactor: 2,
    viewport: { width: 1280, height: 720 }
  })
  const page = await context.newPage()

  let info: any
  let meta: any

  page.on('response', async (response) => {
    try {
      const status = response.status()
      if (status !== 200) return

      const url = new URL(response.url())
      if (
        url.hostname === 'read.amazon.com' &&
        url.pathname === '/service/mobile/reader/startReading' &&
        url.searchParams.get('asin')?.toLowerCase() === asin.toLowerCase()
      ) {
        const body: any = await response.json()
        delete body.karamelToken
        delete body.metadataUrl
        delete body.YJFormatVersion
        info = body
      } else if (url.pathname.endsWith('YJmetadata.jsonp')) {
        const body = await response.text()
        const metadata = parseJsonpResponse<any>(body)
        if (metadata.asin !== asin) return
        delete metadata.cpr
        if (Array.isArray(metadata.authorsList)) {
          metadata.authorsList = normalizeAuthors(metadata.authorsList)
        }
        meta = metadata
      }
    } catch {}
  })

  await Promise.any([
    page.goto(bookReaderUrl, { timeout: 30_000 }),
    page.waitForURL('**/ap/signin', { timeout: 30_000 })
  ])

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

      // page.waitForURL('**/kindle-library', { timeout: 30_000 })
      // await page.locator(`#title-${asin}`).click()
    }
  }

  // await page.goto('https://read.amazon.com/landing')
  // await page.locator('[id="top-sign-in-btn"]').click()
  // await page.waitForURL('**/signin')

  async function updateSettings() {
    await page.locator('ion-button[title="Reader settings"]').click()
    await delay(1000)

    // Change font to Amazon Ember
    await page.locator('#AmazonEmber').click()

    // Change layout to single column
    await page
      .locator('[role="radiogroup"][aria-label$=" columns"]', {
        hasText: 'Single Column'
      })
      .click()

    await page.locator('ion-button[title="Reader settings"]').click()
    await delay(1000)
  }

  async function goToPage(pageNumber: number) {
    await delay(1000)
    await page.locator('#reader-header').hover({ force: true })
    await delay(200)
    await page.locator('ion-button[title="Reader menu"]').click()
    await delay(1000)
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
    await delay(1000)
  }

  async function getPageNav() {
    const footerText = await page.locator('ion-footer ion-title').textContent()
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
      $alertNo.click()
    }
  }

  await dismissPossibleAlert()
  await ensureFixedHeaderUI()
  await updateSettings()

  const initialPageNav = await getPageNav()

  await page.locator('ion-button[title="Table of Contents"]').click()
  await delay(1000)

  const $tocItems = await page.locator('ion-list ion-item').all()
  const tocItems: Array<TocItem> = []

  console.warn(`initializing ${$tocItems.length} TOC items...`)
  for (const tocItem of $tocItems) {
    await tocItem.scrollIntoViewIfNeeded()

    const title = await tocItem.textContent()
    assert(title)

    await tocItem.click()
    await delay(250)

    const pageNav = await getPageNav()
    assert(pageNav)

    tocItems.push({
      title,
      ...pageNav,
      locator: tocItem
    })

    console.warn({ title, ...pageNav })

    // if (pageNav.page !== undefined) {
    //   break
    // }

    if (pageNav.page !== undefined && pageNav.page >= pageNav.total) {
      break
    }
  }

  const parsedToc = parseTocItems(tocItems)
  const toc: TocItem[] = tocItems.map(({ locator: _, ...tocItem }) => tocItem)

  const total = parsedToc.firstPageTocItem.total
  const pagePadding = `${total * 2}`.length
  await parsedToc.firstPageTocItem.locator!.scrollIntoViewIfNeeded()
  await parsedToc.firstPageTocItem.locator!.click()

  const totalContentPages = Math.min(
    parsedToc.afterLastPageTocItem?.page
      ? parsedToc.afterLastPageTocItem!.page
      : total,
    total
  )
  assert(totalContentPages > 0, 'No content pages found')

  await page.locator('.side-menu-close-button').click()
  await delay(1000)

  const pages: Array<PageChunk> = []
  console.warn(
    `reading ${totalContentPages} pages${total > totalContentPages ? ` (of ${total} total pages stopping at "${parsedToc.afterLastPageTocItem!.title}")` : ''}...`
  )

  do {
    const pageNav = await getPageNav()
    if (pageNav?.page === undefined) {
      break
    }
    if (pageNav.page > totalContentPages) {
      break
    }

    const index = pages.length

    const src = await page
      .locator('#kr-renderer .kg-full-page-img img')
      .getAttribute('src')

    const b = await page
      .locator('#kr-renderer .kg-full-page-img img')
      .screenshot({ type: 'png', scale: 'css' })

    const screenshotPath = path.join(
      pageScreenshotsDir,
      `${index}`.padStart(pagePadding, '0') +
        '-' +
        `${pageNav.page}`.padStart(pagePadding, '0') +
        '.png'
    )
    await fs.writeFile(screenshotPath, b)
    pages.push({
      index,
      page: pageNav.page,
      total: pageNav.total,
      screenshot: screenshotPath
    })

    console.warn(pages.at(-1))

    // Navigation is very spotty without this delay; I think it may be due to
    // the screenshot changing the DOM temporarily and not being stable yet.
    await delay(100)

    if (pageNav.page > totalContentPages) {
      break
    }

    // Occasionally the next page button doesn't work, so ensure that the main
    // image src actually changes before continuing.
    let retries = 0

    do {
      try {
        // Navigate to the next page
        // await delay(100)
        if (retries % 10 === 0) {
          if (retries > 0) {
            console.warn('retrying...', {
              src,
              retries,
              ...pages.at(-1)
            })
          }

          await page
            .locator('.kr-chevron-container-right')
            .click({ timeout: 1000 })
        }
        // await delay(500)
      } catch (err: any) {
        // No next page to navigate to
        console.warn(
          'unable to navigate to next page; breaking...',
          err.message
        )
        break
      }

      const newSrc = await page
        .locator('#kr-renderer .kg-full-page-img img')
        .getAttribute('src')
      if (newSrc !== src) {
        break
      }

      if (pageNav.page >= totalContentPages) {
        break
      }

      await delay(100)

      ++retries
    } while (true)
  } while (true)

  const result = { info, meta, toc, pages }
  await fs.writeFile(
    path.join(outDir, 'metadata.json'),
    JSON.stringify(result, null, 2)
  )
  console.log(JSON.stringify(result, null, 2))

  if (initialPageNav?.page !== undefined) {
    console.warn(`resetting back to initial page ${initialPageNav.page}...`)
    // Reset back to the initial page
    await goToPage(initialPageNav.page)
  }

  await page.close()
  await context.close()
}

function parsePageNav(text: string | null): PageNav | undefined {
  {
    // Parse normal page locations
    const match = text?.match(/page\s+(\d+)\s+of\s+(\d+)/i)
    if (match) {
      const page = Number.parseInt(match?.[1]!)
      const total = Number.parseInt(match?.[2]!)
      if (Number.isNaN(page) || Number.isNaN(total)) {
        return undefined
      }

      return { page, total }
    }
  }

  {
    // Parse locations which are not part of the main book pages
    // (toc, copyright, title, etc)
    const match = text?.match(/location\s+(\d+)\s+of\s+(\d+)/i)
    if (match) {
      const location = Number.parseInt(match?.[1]!)
      const total = Number.parseInt(match?.[2]!)
      if (Number.isNaN(location) || Number.isNaN(total)) {
        return undefined
      }

      return { location, total }
    }
  }

  {
    // Parse locations which use roman numerals
    const match = text?.match(/page\s+([cdilmvx]+)\s+of\s+(\d+)/i)
    if (match) {
      const location = deromanize(match?.[1]!)
      const total = Number.parseInt(match?.[2]!)
      if (Number.isNaN(location) || Number.isNaN(total)) {
        return undefined
      }

      return { location, total }
    }
  }
}

function parseTocItems(tocItems: TocItem[]) {
  // Find the first page in the TOC which contains the main book content
  // (after the title, table of contents, copyright, etc)
  const firstPageTocItem = tocItems.find((item) => item.page !== undefined)
  assert(firstPageTocItem, 'Unable to find first valid page in TOC')

  // Try to find the first page in the TOC after the main book content
  // (e.g. acknowledgements, about the author, etc)
  const afterLastPageTocItem = tocItems.find((item) => {
    if (item.page === undefined) return false
    if (item === firstPageTocItem) return false

    const percentage = item.page / item.total
    if (percentage < 0.9) return false

    if (/acknowledgements/i.test(item.title)) return true
    if (/^discover more$/i.test(item.title)) return true
    if (/^extras$/i.test(item.title)) return true
    if (/about the author/i.test(item.title)) return true
    if (/meet the author/i.test(item.title)) return true
    if (/^also by /i.test(item.title)) return true
    if (/^copyright$/i.test(item.title)) return true
    if (/ teaser$/i.test(item.title)) return true
    if (/ preview$/i.test(item.title)) return true
    if (/^excerpt from/i.test(item.title)) return true
    if (/^cast of characters$/i.test(item.title)) return true
    if (/^timeline$/i.test(item.title)) return true
    if (/^other titles/i.test(item.title)) return true

    return false
  })

  return {
    firstPageTocItem,
    afterLastPageTocItem
  }
}

// fetch(
//   'https://read.amazon.com/service/mobile/reader/startReading?asin=B0819W19WD&clientVersion=20000100',
//   {
//     headers: {
//       accept: '*/*',
//       'accept-language': 'en-US,en;q=0.9',
//       'device-memory': '8',
//       downlink: '10',
//       dpr: '2',
//       ect: '4g',
//       priority: 'u=1, i',
//       rtt: '50',
//       'sec-ch-device-memory': '8',
//       'sec-ch-dpr': '2',
//       'sec-ch-ua':
//         '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
//       'sec-ch-ua-mobile': '?0',
//       'sec-ch-ua-platform': '"macOS"',
//       'sec-ch-viewport-width': '1728',
//       'sec-fetch-dest': 'empty',
//       'sec-fetch-mode': 'cors',
//       'sec-fetch-site': 'same-origin',
//       'viewport-width': '1728',
//       'x-adp-session-token': null,
//       cookie: null,
//       Referer: 'https://read.amazon.com/?asin=B0819W19WD&ref_=kwl_kr_iv_rec_1',
//       'Referrer-Policy': 'strict-origin-when-cross-origin'
//     },
//     body: null,
//     method: 'GET'
//   }
// )

// fetch(
//   'https://k4wyjmetadata.s3.amazonaws.com/books2/B0819W19WD/da38557c/CR%21WPPV87W8317H7FWJRF6JFMVE7SJY/book/YJmetadata.jsonp',
//   {
//     method: 'GET'
//   }
// )

try {
  await main()
} catch (err) {
  console.error('error', err)
  process.exit(1)
}
