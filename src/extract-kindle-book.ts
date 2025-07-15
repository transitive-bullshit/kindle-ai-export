import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { input } from '@inquirer/prompts'
import delay from 'delay'
import { chromium, type Locator } from 'playwright'
import which from 'which'

import type { BookInfo, BookMeta, BookMetadata, PageChunk } from './types'
import {
  assert,
  deromanize,
  getEnv,
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

async function main() {
  const asin = getEnv('ASIN')
  const amazonEmail = getEnv('AMAZON_EMAIL')
  const amazonPassword = getEnv('AMAZON_PASSWORD')
  assert(asin, 'ASIN is required')
  assert(amazonEmail, 'AMAZON_EMAIL is required')
  assert(amazonPassword, 'AMAZON_PASSWORD is required')

  const outDir = path.join('out', asin)
  const userDataDir = path.join(outDir, 'data')
  const pageScreenshotsDir = path.join(outDir, 'pages')
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.mkdir(pageScreenshotsDir, { recursive: true })

  const krRendererMainImageSelector = '#kr-renderer .kg-full-page-img img'
  const bookReaderUrl = `https://read.amazon.com/?asin=${asin}`

  async function getChromeExecutablePath() {
    // find chrome executable path
    // examples:
    // '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    // '/usr/bin/chromium'
    // '/run/current-system/sw/bin/chromium'
    const executableNameList = [
      // TODO prefer CHROME_EXECUTABLE_PATH from env
      // env.CHROME_EXECUTABLE_PATH,
      'Google Chrome',
      'chromium',
      'chromium.exe',
      'chrome',
      'chrome.exe',
      // TODO more
    ]
    let executablePath = null
    for (const executableName of executableNameList) {
      if (!executableName) continue
      executablePath = await which(executableName, { nothrow: true })
      if (executablePath) break
    }
    if (executablePath == null) {
      throw new Error('failed to find chrome executable')
    }
    console.log(`found chrome executable ${executablePath}`)
    return executablePath
  }

  const executablePath = await getChromeExecutablePath()

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    executablePath: executablePath,
    args: ['--hide-crash-restore-bubble'],
    ignoreDefaultArgs: ['--enable-automation'],
    deviceScaleFactor: 2,
    viewport: { width: 1280, height: 720 }
  })
  const page = await context.newPage()

  let info: BookInfo | undefined
  let meta: BookMeta | undefined

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

    // FIXME only ask for 2FA code if needed
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
    const selectorReaderSettings = 'button[aria-label="Reader settings"]'
    // <button type="button" class="button-native" part="native" aria-label="Reader settings">
    console.log('opening Reader settings ...')
    await page.locator(selectorReaderSettings).click()
    console.log('opening Reader settings done')
    await delay(1000)

    // Change font to Amazon Ember
    // <span id="AmazonEmber" class="font-family-selector" tabindex="0" role="radio" aria-checked="false">
    console.log('setting font ...')
    await page.locator('#AmazonEmber').click()
    console.log('setting font done')
    await delay(1000)

    // Change layout to single column
    console.log('setting single column layout ...')
    // <span aria-label="Single Column" id="columns-1" value="1" role="radio" name="column-selector" aria-checked="false" tabindex="0">
    await page.locator('#columns-1').click()
    console.log('setting single column layout done')
    await delay(1000)

    console.log('closing Reader settings ...')
    await page.locator(selectorReaderSettings).click()
    console.log('closing Reader settings done')
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

  /*
  <div class="alert-wrapper ion-overlay-wrapper sc-ion-alert-ios">
    <div class="alert-head sc-ion-alert-ios">
      <h2 id="alert-7-hdr" class="alert-title sc-ion-alert-ios">Most Recent Page Read</h2>
    </div>
    <div id="alert-7-msg" class="alert-message sc-ion-alert-ios">
      You're on page 1. The most recent page is 10 from "swim's Kindle Cloud Reader" at 04:20 pm on Jan 01, 2025. Go to page 10?
    </div>
    <div class="alert-button-group sc-ion-alert-ios">
      <button type="button" class="alert-button ion-focusable ion-activatable secondary sc-ion-alert-ios" tabindex="0">
        <span class="alert-button-inner sc-ion-alert-ios">No</span>
      </button>
      <button type="button" class="alert-button ion-focusable ion-activatable sc-ion-alert-ios" tabindex="0">
        <span class="alert-button-inner sc-ion-alert-ios">Yes</span>
      </button>
    </div>
  </div>
  */
  // TODO handle different alerts
  // div#alert-7-msg + div.alert-button-group button.secondary

  async function dismissPossibleAlert() {
    const $alertNo = page.locator('div.alert-wrapper button.secondary', { hasText: 'No' })
    if (await $alertNo.isVisible()) {
      $alertNo.click()
    }
  }

  // wait for alert
  // otherwise it hangs at updateSettings() -> Change font to Amazon Ember
  // TODO better. wait for page load
  await delay(5000)

  await dismissPossibleAlert()
  await ensureFixedHeaderUI()
  await updateSettings()

  const initialPageNav = await getPageNav()

  await page.locator('button[aria-label="Table of Contents"]').click()
  await delay(1000)

  const $tocItems = await page.locator('ion-list ion-item').all()
  const tocItems: Array<TocItem> = []

  async function fileExists(path) {
    // alternative to fs.exists
    // https://stackoverflow.com/questions/17699599/node-js-check-if-file-exists
    try {
      await fs.stat(path)
      return true
    }
    catch (exc) {
      // Error: ENOENT: no such file or directory
      return false
    }
  }

  async function readTocItemsCache(tocItems, tocItemsCachePath) {
    if (!(await fileExists(tocItemsCachePath))) {
      // no such file, or file not readable
      console.log(`not reading cache ${tocItemsCachePath}`)
      return
    }
    const tocItemsCachePathTrash = `${tocItemsCachePath}.trash.${Date.now()}`
    let tocItemsCached = null
    try {
      tocItemsCached = JSON.parse(await fs.readFile(tocItemsCachePath, { encoding: 'utf8' }))
      if (!Array.isArray(tocItemsCached)) {
        throw new Error('tocItemsCached is not an array')
      }
      if (tocItemsCached.length == 0) {
        throw new Error('tocItemsCached is an empty array')
      }
    }
    catch (exc) {
      console.log(`error: failed to read cache ${tocItemsCachePath} - ${exc} - moving file to ${tocItemsCachePathTrash}`)
      await fs.rename(tocItemsCachePath, tocItemsCachePathTrash)
      return
    }
    console.log(`reading cache ${tocItemsCachePath}`)
    for (const tocItem of tocItemsCached) {
      tocItems.push(tocItem)
    }
  }

  async function writeTocItemsCache(tocItems, tocItemsCachePath) {
    console.log(`writing cache ${tocItemsCachePath}`)
    await fs.writeFile(tocItemsCachePath, JSON.stringify(tocItems), { encoding: 'utf8' })
  }

  const tocItemsCachePath = `${outDir}/tocItems.json`

  await readTocItemsCache(tocItems, tocItemsCachePath)

  if (tocItems.length == 0) {
    // TODO indent ...
    // /run/current-system/sw/bin/chromium
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
    // ... TODO indent
    await writeTocItemsCache()
  }

  const parsedToc = parseTocItems(tocItems)
  const toc: TocItem[] = tocItems.map(({ locator: _, ...tocItem }) => tocItem)

  const total = parsedToc.firstPageTocItem.total
  const pagePadding = `${total * 2}`.length
  await page.locator(parsedToc.firstPageTocItem.locator._selector)!.scrollIntoViewIfNeeded()
  await page.locator(parsedToc.firstPageTocItem.locator._selector)!.click()

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

  // TODO find first missing screenshotPath and seek to that page

  while (true) {
    const pageNav = await getPageNav()
    if (pageNav?.page === undefined) {
      break
    }
    if (pageNav.page >= totalContentPages) {
      console.log('reached last page')
      break
    }

    const index = pages.length

    console.log('getting image source of krRendererMainImageSelector ...')
    const src = await page
      .locator(krRendererMainImageSelector)
      .getAttribute('src')
    console.log('getting image source of krRendererMainImageSelector done')

    const screenshotPath = path.join(
      pageScreenshotsDir,
      `${index}`.padStart(pagePadding, '0') +
        '-' +
        `${pageNav.page}`.padStart(pagePadding, '0') +
        '.png'
    )

    if (await fileExists(screenshotPath)) {
      console.log(`keeping ${screenshotPath}`)
    }
    else {
      // TODO indent ...

    // FIXME this hangs after some pages
    console.log('taking screenshot of krRendererMainImageSelector ...')
    const b = await page
      .locator(krRendererMainImageSelector)
      .screenshot({ type: 'png', scale: 'css' })
    console.log('taking screenshot of krRendererMainImageSelector done')

    await fs.writeFile(screenshotPath, b)

      // ... TODO indent
    }

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

    let retries = 0

    // Occasionally the next page button doesn't work, so ensure that the main
    // image src actually changes before continuing.
    while (true) {
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

          // Click the next page button
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
        .locator(krRendererMainImageSelector)
        .getAttribute('src')
      if (newSrc !== src) {
        break
      }

      if (pageNav.page >= totalContentPages) {
        break
      }

      await delay(100)

      ++retries
    }
  }

  const result: BookMetadata = { info: info!, meta: meta!, toc, pages }
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

await main()
