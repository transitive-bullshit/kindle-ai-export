import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { input } from '@inquirer/prompts'
import delay from 'delay'
import { chromium, type Locator } from 'playwright'
import which from 'which'
import looksSame from 'looks-same'
import fastGlob from 'fast-glob'

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

  function fixDoubleUTF8(str) {
    return str
      .replace(/Ã¼/g, 'ü')
      .replace(/Ã¤/g, 'ä')
      .replace(/Ã¶/g, 'ö')
      .replace(/ÃŸ/g, 'ß')
      .replace(/Ã©/g, 'é')
      .replace(/Ã /g, 'à')
      .replace(/Ã¢/g, 'â')
      .replace(/Ã´/g, 'ô')
      .replace(/Ã®/g, 'î')
      .replace(/Ã»/g, 'û')
      .replace(/Ã‰/g, 'É')
      .replace(/Ã‡/g, 'Ç')
      // TODO more
  }

  // from https://m.media-amazon.com/images/I/81m1+3DitYL.js
  // FIXME "Ã¼ber groÃŸe" is decoded to "über groøe" but should be "über große"
  /**
  * UTF8 decodes a string.
  * @param {Object} input String to decode.
  */
  function utf8Decode(input) {
    var string = [];
    var i = 0;
    var c, c1, c2;
    while (i < input.length) {
      c = input.charCodeAt(i);
      if (c < 128) {
        string.push(String.fromCharCode(c));
        i++;
      } else if ((c > 191) && (c < 224)) {
        c1 = input.charCodeAt(i + 1);
        string.push(String.fromCharCode(((c & 31) << 6) | (c1 & 63)));
        i += 2;
      } else {
        c1 = input.charCodeAt(i + 1);
        c2 = input.charCodeAt(i + 2);
        string.push(String.fromCharCode(((c & 15) << 12) | ((c1 & 63) << 6) | (c2 & 63)));
        i += 3;
      }
    }
    return string.join('');
  }

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
        delete body.lastPageReadData // remove deviceName with username
        delete body.kindleSessionId
        info = body
      } else if (url.pathname.endsWith('YJmetadata.jsonp')) {
        let body = await response.text()
        console.log(`writing ${path.join(outDir, 'metadata.response.json')}`)
        await fs.writeFile(
          path.join(outDir, 'metadata.response.json'),
          body
        )
        // try to decode cryptic utf8 encoding
        // body = Buffer.from(body, 'ascii').toString('utf-8') // no
        body = fixDoubleUTF8(body)
        // body = utf8Decode(body)
        const metadata = parseJsonpResponse<any>(body)
        if (metadata.asin !== asin) return
        delete metadata.cpr
        if (Array.isArray(metadata.authorsList)) {
          metadata.authorsList = normalizeAuthors(metadata.authorsList)
        }
        meta = metadata
        console.log(`writing ${path.join(outDir, 'metadata.base.json')}`)
        await fs.writeFile(
          path.join(outDir, 'metadata.base.json'),
          JSON.stringify(metadata, null, 2)
        )
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

    // wait for signin
    while (true) {
      const u = page.url()
      if (
        u == 'https://www.amazon.com/ap/signin' ||
        // captcha: Solve this puzzle to protect your account
        u.startsWith('https://www.amazon.com/ap/cvf/request?')
      ) {
        console.log(`signin loading: url = ${u}`);
        await delay(1000)
        continue
      }
      console.log(`signin done: url = ${u}`);
      break
    }

    const pageUrl = new URL(page.url())
    if (pageUrl.pathname == '/kindle-library') {
      // the book library is loaded (default startpage)
    }
    else if (
      pageUrl.pathname == '/' &&
      pageUrl.searchParams.size == 1 &&
      pageUrl.searchParams.get('asin') != null
    ) {
      // if a book was loaded before, kindle continues at the previous session
    }
    // TODO better check for 2FA page
    // try to locate input elements
    else {
      console.log('unknown pageUrl:', pageUrl)
      console.log('assuming 2-factor auth page')
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

  async function updateSettings(settings = {}) {
    if (!settings) settings = {}
    if (!settings.pageColor) settings.pageColor = 'white'
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

    // set page color
    const selectorByPageColor = {
      white: '#theme-White',
      black: '#theme-Dark',
      sepia: '#theme-Sepia',
      green: '#theme-Green',
    }
    if (selectorByPageColor[settings.pageColor]) {
      console.log(`setting page color ${settings.pageColor} ...`)
      await page.locator(selectorByPageColor[settings.pageColor]).click()
      console.log(`setting page color ${settings.pageColor} done`)
      await delay(1000)
    }

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
    // <button type="button" class="button-native" part="native" aria-label="Reader menu">
    await page.locator('button[aria-label="Reader menu"]').click()
    await delay(1000)
    // <ion-item button="true" lines="none" detail="false" item-i-d="pop_over_menu_go_to_page" data-testid="pop_over_menu_go_to_page" class="popover-menu-item item ios item-lines-none item-fill-none in-list ion-activatable ion-focusable item-label" role="listitem">
    await page
      .locator('ion-item[role="listitem"][item-i-d="pop_over_menu_go_to_page"]')
      .click()
    // <ion-modal is-open="true" show-backdrop="false" animated="false" class="go-to-modal ios modal-default show-modal" id="ion-overlay-6" no-router="" tabindex="-1" style="z-index: 20015;">
    // <input class="native-input sc-ion-input-ios" id="ion-input-0" autocapitalize="off" autocomplete="off" autocorrect="off" name="ion-input-0" pattern="[0-9]*" placeholder="page number" spellcheck="false" type="number">
    await page
      .locator('ion-modal input[placeholder="page number"]')
      .fill(`${pageNumber}`)
    // await page.locator('ion-modal button', { hasText: 'Go' }).click()
    // <ion-button expand="full" color="dark" item-i-d="go-to-modal-go-button" class="go-to-modal-button-primary ion-color ion-color-dark ios button button-full button-solid ion-activatable ion-focusable">Go</ion-button>
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
    await writeTocItemsCache(tocItems, tocItemsCachePath)
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

  const pagesByPageColor = {}

  for (const pageColor of ['white', 'black']) {
    console.log(`extracting screenshots of ${pageColor} pages ...`)
    await updateSettings({ pageColor: pageColor })
    await goToPage(1)
    await fs.mkdir(path.join(pageScreenshotsDir, pageColor), { recursive: true })
    // TODO indent ...

  const pages: Array<PageChunk> = []
  console.warn(
    `reading ${totalContentPages} pages${total > totalContentPages ? ` (of ${total} total pages stopping at "${parsedToc.afterLastPageTocItem!.title}")` : ''}...`
  )

  pagesByPageColor[pageColor] = pages

  // TODO find first missing screenshotPath and seek to that page

  // create sparse array of subpages
  // so later we can insert missing subpages
  const subPageBase = 100

  const subPagePadding = 5 // max subPage: 99999

  let lastPage = 0

  let subPage = subPageBase

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

    // TODO assert(pageNav.page >= lastPage)

    if (pageNav.page > lastPage) {
      subPage = subPageBase
    }
    else {
      subPage += subPageBase
    }

    function getScreenshotPath(page, subPage) {
      return path.join(
        pageScreenshotsDir,
        pageColor,
        (
          `${page}`.padStart(pagePadding, '0') +
          '-' +
          `${subPage}`.padStart(subPagePadding, '0') +
          '.png'
        )
      )
    }

    function getScreenshotPathPattern(page) {
      return path.join(
        pageScreenshotsDir,
        pageColor,
        (
          `${page}`.padStart(pagePadding, '0') +
          '-' +
          '*' +
          '.png'
        )
      )
    }

    let screenshotPath
    while (true) {
      screenshotPath = getScreenshotPath(pageNav.page, subPage)
      if (!(await fileExists(screenshotPath))) {
        break
      }
      // file exists -> change path
      subPage++
    }


    /*
    if (await fileExists(screenshotPath)) {
      console.log(`keeping ${screenshotPath}`)
    }
    else {
      // TODO indent ...
    */

    // FIXME this hangs after some pages
    console.log('taking screenshot of krRendererMainImageSelector ...')
    const b = await page
      .locator(krRendererMainImageSelector)
      .screenshot({ type: 'png', scale: 'css' })
    console.log('taking screenshot of krRendererMainImageSelector done')

    // loop screenshot files of this page to find duplicate images
    let foundDuplicate = false
    const pathPattern = getScreenshotPathPattern(pageNav.page)
    for (const path of await fastGlob.glob(pathPattern)) {
      const {equal} = await looksSame(b, path, {tolerance: 5})
      if (!equal) continue
      foundDuplicate = true
      // screenshotPath = `${path}.dup.${Date.now()}.png`
      screenshotPath = path
      break
    }

    if (foundDuplicate) {
      console.log(`got duplicate of screenshot ${screenshotPath}`)
    }
    else {
      // TODO indent ...

    await fs.writeFile(screenshotPath, b)

    /*
      // ... TODO indent
    }
    */

    pages.push({
      index,
      page: pageNav.page,
      total: pageNav.total,
      screenshot: screenshotPath
    })

    console.warn(pages.at(-1))

      // ... TODO indent
    } // if (!foundDuplicate)

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
          console.log('clicking next page button')
          try {
            // TODO indent ...
          await page
            .locator('.kr-chevron-container-right')
            .click({ timeout: 1000 })
            // ... TODO indent
          }
          catch (exc) {
            console.log(`clicking next page button failed: ${exc}`)
            // fallback on Timeout: waiting for locator('.kr-chevron-container-right')
            // this seems to be a bug in the kindle reader
            // when seeking from the last page to the first page
            // then there is no "next page" button, only a "previous page" button
            console.log(`seeking to next page with goToPage(${pageNav.page + 1})`)
            await goToPage(pageNav.page + 1)
          }
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
    lastPage = pageNav.page
  }

    // ... TODO indent
    console.log(`extracting screenshots of ${pageColor} pages done`)
  } // for (const pageColor of ['white', 'black'])

  const pages = pagesByPageColor['white']

  const result: BookMetadata = { info: info!, meta: meta!, toc, pages, pagesByPageColor }
  console.log(`writing ${path.join(outDir, 'metadata.json')}`)
  await fs.writeFile(
    path.join(outDir, 'metadata.json'),
    JSON.stringify(result, null, 2)
  )
  // no. this would overwrite terminal history
  // console.log(JSON.stringify(result, null, 2))

  if (initialPageNav?.page !== undefined) {
    console.warn(`resetting back to initial page ${initialPageNav.page}...`)
    // Reset back to the initial page
    await goToPage(initialPageNav.page)
  }

  await page.close()
  await context.close()

  console.log(`hint: next steps:`)
  console.log(`  npx tsx src/transcribe-book-content.ts`)
  console.log(`  npx tsx src/export-book-pdf.ts`)
  console.log(`  ebook-convert out/${asin}/book.pdf out/${asin}/book.epub --enable-heuristics`)
  console.log(`  npx tsx src/export-book-markdown.ts`)
  console.log(`  npx tsx src/export-book-audio.ts`)
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
