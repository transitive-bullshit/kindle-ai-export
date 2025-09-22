import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { input } from '@inquirer/prompts'
import delay from 'delay'
import { chromium, type Locator, type Page } from 'playwright'

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

async function completeOtpFlow(page: Page, code: string) {
  // Wait for any known OTP input to appear (Amazon uses several variants)
  const otpInput = page.locator('input#cvf-input-code, input[name="code"], input[type="tel"]');
  await otpInput.waitFor({ state: 'visible', timeout: 120_000 });

  await otpInput.fill(code);

  // Try the common submit buttons first, then fall back to pressing Enter
  const submitCandidates = [
    'input#cvf-submit-otp-button',
    'input[type="submit"][aria-labelledby="cvf-submit-otp-button-announce"]',
    'button[name="verifyCode"]',
  ];

  let clicked = false;
  for (const sel of submitCandidates) {
    const btn = page.locator(sel);
    if (await btn.isVisible()) {
      await btn.click();
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    const byRole = page.getByRole('button', { name: /verify|submit|continue/i });
    if (await byRole.isVisible()) {
      await byRole.click();
      clicked = true;
    }
  }

  if (!clicked) {
    await otpInput.press('Enter');
  }

  // Some accounts show a "remember this device" step; handle it if present
  const rememberCheckbox = page.locator('input[name="rememberDevice"], input#auth-mfa-remember-device');
  if (await rememberCheckbox.isVisible()) {
    await rememberCheckbox.check().catch(() => {});
    const rememberSubmit = page.locator('input#cvf-submit-remember-device, input[type="submit"][aria-labelledby="cvf-submit-remember-device-announce"]');
    if (await rememberSubmit.isVisible()) {
      await rememberSubmit.click();
    } else {
      await page.getByRole('button', { name: /continue|submit/i }).click().catch(() => {});
    }
  }

  // Wait for navigation away from the CVF (challenge) page
  await Promise.race([
    page.waitForURL(/read\.amazon\.[^/]+\//, { timeout: 60_000 }).catch(() => {}),
    page.waitForURL(/kindle-library/, { timeout: 60_000 }).catch(() => {}),
    page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {}),
  ]);
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

    if (!/\/kindle-library/g.test(new URL(page.url()).pathname)) {
      const code = await input({
        message: '2-factor auth code?'
      });

      if (code) {
        try {
          await completeOtpFlow(page, code);
        } catch (err) {
          // As a fallback, try clicking the known OTP submit directly (legacy selector)
          await page
            .locator('input[type="submit"][aria-labelledby="cvf-submit-otp-button-announce"]')
            .click({ timeout: 5_000 })
            .catch(() => {});
        }
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

  // Note: Playwright's Frame and Page share the `locator` and `getByRole` APIs used here.
  async function updateSettings() {
    // Some Kindle flows render the reader inside an iframe; prefer that if present
    const readerFrame = page.frame({ url: /read\.amazon\./ }) || page.mainFrame();
    const scope = readerFrame as unknown as Page; // Page & Frame share locator API we use below

    // Make sure the reader UI is actually visible; toolbars auto-hide
    await scope.waitForLoadState?.('domcontentloaded').catch(() => {});
    await delay(500);

    // Nudge the header/toolbar to appear
    try {
      await page.locator('#reader-header, .top-chrome, ion-toolbar').first().hover({ force: true });
    } catch {}
    try {
      await page.mouse.move(50, 50);
    } catch {}

    // Candidate locators for the settings button (label varies: "Reader settings", "Aa", etc.)
    const candidates = [
      scope.getByRole?.('button', { name: /reader settings/i } as any),
      scope.getByRole?.('button', { name: /^aa$/i } as any),
      scope.locator?.('ion-button[title="Reader settings"]'),
      scope.locator?.('button[title="Reader settings"]'),
      scope.locator?.('ion-button[title="Aa"]'),
      scope.locator?.('[data-testid="reader-settings"], [aria-label="Reader settings"]'),
    ].filter(Boolean) as Locator[];

    let clicked = false;
    const deadline = Date.now() + 30_000;

    // Keep trying until one becomes visible or we time out
    while (!clicked && Date.now() < deadline) {
      for (const cand of candidates) {
        if (await cand.isVisible().catch(() => false)) {
          await cand.click({ timeout: 2_000 }).catch(() => {});
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        // Re-hover the header to keep toolbar visible
        await page.locator('#reader-header, .top-chrome, ion-toolbar').first().hover({ force: true }).catch(() => {});
        await delay(300);
      }
    }

    if (!clicked) {
      await page.screenshot({ path: 'reader-settings-timeout.png', fullPage: true }).catch(() => {});
      throw new Error('Could not find the Reader Settings button. Saved screenshot: reader-settings-timeout.png');
    }

    await delay(800);

    // Change font to Amazon Ember (best-effort across UIs)
    const ember = scope.locator?.('#AmazonEmber, [data-font="Amazon Ember"], button:has-text("Amazon Ember")');
    if (ember) {
      await ember.first().click({ timeout: 2_000 }).catch(() => {});
    }

    // Change layout to single column (label text can vary)
    const singleColGroup = scope.locator?.('[role="radiogroup"][aria-label$=" columns"]');
    if (singleColGroup) {
      await singleColGroup.filter({ hasText: /single column/i }).first().click({ timeout: 2_000 }).catch(() => {});
    } else {
      await scope.getByRole?.('radio', { name: /single column/i } as any).click({ timeout: 2_000 }).catch(() => {});
    }

    // Close settings
    const closeSettings = [
      scope.locator?.('ion-button[title="Reader settings"]'),
      scope.locator?.('button[title="Reader settings"]'),
      scope.getByRole?.('button', { name: /^aa$/i } as any),
    ].filter(Boolean) as Locator[];

    for (const c of closeSettings) {
      if (await c.isVisible().catch(() => false)) {
        await c.click({ timeout: 2_000 }).catch(() => {});
        break;
      }
    }

    await delay(500);
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
      .locator(krRendererMainImageSelector)
      .getAttribute('src')

    const b = await page
      .locator(krRendererMainImageSelector)
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

    let retries = 0

    // Occasionally the next page button doesn't work, so ensure that the main
    // image src actually changes before continuing.
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
    } while (true)
  } while (true)

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
