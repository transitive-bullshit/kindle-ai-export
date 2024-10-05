#!/usr/bin/env node
/* eslint-disable no-process-env */
import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { input } from '@inquirer/prompts'
import delay from 'delay'
import { chromium, type Locator } from 'playwright'

import { assert } from '../src/utils'

interface PageNav {
  page?: number
  location?: number
  total: number
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

  // const browser = await chromium.launch({
  //   headless: false,
  //   channel: 'chrome',
  //   executablePath:
  //     '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  // })
  // const context = await browser.newContext(devices['Desktop Chrome'])
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
  const tocItems: Array<{
    title: string
    pageNav: PageNav
    locator: Locator
  }> = []

  console.log(`initializing ${$tocItems.length} TOC items...`)
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
      pageNav,
      locator: tocItem
    })

    console.log(tocItems.at(-1))

    if (pageNav.page !== undefined) {
      break
    }

    if (pageNav.page !== undefined && pageNav.page >= pageNav.total) {
      break
    }
  }

  const toc = tocItems.map((tocItem) => ({
    ...tocItem.pageNav,
    title: tocItem.title
  }))

  const firstPageTocItem = tocItems.find(
    (item) => item.pageNav?.page !== undefined
  )
  assert(firstPageTocItem, 'Unable to find first valid page in TOC')

  const total = firstPageTocItem.pageNav.total
  const pagePadding = `${total * 3}`.length
  await firstPageTocItem.locator.scrollIntoViewIfNeeded()
  await firstPageTocItem.locator.click()

  await page.locator('.side-menu-close-button').click()
  await delay(1000)

  const pages: Array<{
    index: number
    page: number
    total: number
    screenshot: string
  }> = []

  console.log(`reading ${total} pages...`)

  do {
    const pageNav = await getPageNav()
    if (pageNav?.page === undefined) {
      break
    }
    const index = pages.length

    const src = await page
      .locator('#kr-renderer .kg-full-page-img img')
      .getAttribute('src')

    // await hideAppUI()
    const b = await page
      .locator('#kr-renderer .kg-full-page-img img')
      .screenshot({ type: 'png', scale: 'css' })
    // await showAppUI()

    const screenshotPath = path.join(
      pageScreenshotsDir,
      `${index}`.padStart(pagePadding, '0') + '.png'
    )
    await fs.writeFile(screenshotPath, b)
    pages.push({
      index,
      page: pageNav.page,
      total: pageNav.total,
      screenshot: screenshotPath
    })

    console.log({ src, ...pages.at(-1) })
    // await delay(5000)

    // 5/6, 21/22

    // Navigation is very spotty without this delay; I think it may be due to
    // the screenshot changing the DOM temporarily and not being stable yet.
    await delay(100)

    if (pageNav.page >= pageNav.total) {
      break
    }

    if (pageNav.page >= 3) {
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
            console.log('retrying...', {
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
      } catch {
        // No next page to navigate to
        break
      }

      const newSrc = await page
        .locator('#kr-renderer .kg-full-page-img img')
        .getAttribute('src')
      if (newSrc !== src) {
        break
      }

      await delay(100)

      ++retries
    } while (true)
  } while (true)

  if (initialPageNav?.page !== undefined) {
    console.log(`resetting back to initial page ${initialPageNav.page}...`)
    // Reset back to the initial page
    await goToPage(initialPageNav.page)
  }

  await page.close()
  await context.close()

  console.log(JSON.stringify({ toc, pages }, null, 2))
}

function parsePageNav(text: string | null): PageNav | undefined {
  const match = text?.match(/page\s+(\d+)\s+of\s+(\d+)/i)
  if (match) {
    const page = Number.parseInt(match?.[1]!)
    const total = Number.parseInt(match?.[2]!)
    if (Number.isNaN(page) || Number.isNaN(total)) {
      return undefined
    }

    return { page, total }
  } else {
    const match = text?.match(/location\s+(\d+)\s+of\s+(\d+)/i)
    const location = Number.parseInt(match?.[1]!)
    const total = Number.parseInt(match?.[2]!)
    if (Number.isNaN(location) || Number.isNaN(total)) {
      return undefined
    }

    return { location, total }
  }
}

try {
  await main()
} catch (err) {
  console.error('error', err)
  process.exit(1)
}
