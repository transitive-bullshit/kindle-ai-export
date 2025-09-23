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

const DBG = !!process.env.DEBUG_KINDLE;
function dlog(...args: any[]) { if (DBG) console.warn(new Date().toISOString(), '-', ...args); }
function short(v?: string | null) {
  if (!v) return String(v);
  try { const u = new URL(v); return `${u.pathname.split('/').pop()}`; } catch { return v.length > 64 ? v.slice(0,64) + '…' : v; }
}

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

async function getFooterRaw(page: Page) {
  try {
    const t = await page.locator('ion-footer ion-title').first().textContent({ timeout: 2000 });
    return (t || '').trim();
  } catch { return ''; }
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
    viewport: { width: 1400, height: 1800 }
  })
  const page = await context.newPage()
  if (DBG) {
    page.on('console', (msg) => dlog('[browser]', msg.type(), msg.text()));
    page.on('requestfailed', (req) => dlog('[requestfailed]', req.failure()?.errorText, req.url()));
  }

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
  dlog('landed on', page.url());

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
    // Overlay/panel that appears when settings are open (best-effort across UIs)
    const settingsOverlay = scope.locator?.('ion-popover, ion-modal, [role="dialog"], .reader-settings')
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

    // Give the UI a moment to apply changes before we try to close it
    await delay(200);

    // Close settings (toggle Aa or click the same button again)
    const closeSettings = [
      scope.locator?.('ion-button[title="Reader settings"]'),
      scope.locator?.('button[title="Reader settings"]'),
      scope.getByRole?.('button', { name: /^aa$/i } as any),
    ].filter(Boolean) as Locator[];

    let closed = false;
    for (const c of closeSettings) {
      if (await c.isVisible().catch(() => false)) {
        await c.click({ timeout: 2_000 }).catch(() => {});
        // Wait briefly to see if overlay disappears
        if (settingsOverlay && await settingsOverlay.first().isVisible().catch(() => false)) {
          await settingsOverlay.first().waitFor({ state: 'hidden', timeout: 1_000 }).catch(() => {});
        }
        closed = true;
        break;
      }
    }

    // Fallback: force-close via Escape or clicking outside
    const closeDeadline = Date.now() + 3_000;
    while (settingsOverlay && await settingsOverlay.first().isVisible().catch(() => false) && Date.now() < closeDeadline) {
      await page.keyboard.press('Escape').catch(() => {});
      await delay(150);
      if (await settingsOverlay.first().isVisible().catch(() => false)) {
        // Click outside the overlay to dismiss if possible
        await page.mouse.click(10, 10).catch(() => {});
        await delay(150);
      }
      if (!closed) {
        // Try toggling the Aa/settings button again
        for (const c of closeSettings) {
          if (await c.isVisible().catch(() => false)) {
            await c.click({ timeout: 1_000 }).catch(() => {});
            break;
          }
        }
      }
    }

    // Final safety: ensure overlay is hidden before proceeding
    if (settingsOverlay && await settingsOverlay.first().isVisible().catch(() => false)) {
      await page.screenshot({ path: 'settings-stuck.png', fullPage: true }).catch(() => {});
      throw new Error('Reader Settings panel did not close. Saved screenshot: settings-stuck.png');
    }

    await delay(300);
  }

  async function openTableOfContents() {
    // Ensure no modal/panel is open before attempting TOC
    await page.keyboard.press('Escape').catch(() => {});
    await delay(100);

    // Some Kindle layouts render inside an iframe; prefer that if present
    const readerFrame = page.frame({ url: /read\.amazon\./ }) || page.mainFrame();
    const scope = readerFrame as unknown as Page; // Page & Frame share locator API used below

    // Make toolbar visible
    await scope.waitForLoadState?.('domcontentloaded').catch(() => {});
    await delay(300);
    await page.locator('#reader-header, .top-chrome, ion-toolbar').first().hover({ force: true }).catch(() => {});

    const directCandidates: Locator[] = [
      scope.getByRole?.('button', { name: /table of contents/i } as any),
      scope.getByRole?.('button', { name: /contents/i } as any),
      scope.locator?.('ion-button[title="Table of Contents"]'),
      scope.locator?.('button[title="Table of Contents"]'),
      scope.locator?.('[aria-label="Table of Contents"], [data-testid="toc-button"]'),
    ].filter(Boolean) as Locator[];

    const deadline = Date.now() + 30_000;
    let opened = false;

    // Try direct buttons first with retries while the toolbar may be auto-hiding
    while (!opened && Date.now() < deadline) {
      for (const cand of directCandidates) {
        if (await cand.isVisible().catch(() => false)) {
          await cand.click({ timeout: 1_000 }).catch(() => {});
          opened = true;
          // Wait for side menu / TOC panel to render (best-effort)
          await page.locator('ion-menu, .side-menu, .toc, ion-list').first().waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
          break;
        }
      }
      if (!opened) {
        // Re-hover header to keep toolbar visible and retry
        await page.locator('#reader-header, .top-chrome, ion-toolbar').first().hover({ force: true }).catch(() => {});
        await delay(250);
      }
    }

    // Fallback path via the hamburger/reader menu
    if (!opened) {
      // Open the menu if present
      const menuBtn = scope.locator?.('ion-button[title="Reader menu"], button[title="Reader menu"], [aria-label="Reader menu"]');
      if (menuBtn && await menuBtn.first().isVisible().catch(() => false)) {
        await menuBtn.first().click({ timeout: 2_000 }).catch(() => {});
        await delay(400);
      }

      const menuItems: Locator[] = [
        scope.locator?.('ion-item[role="listitem"]:has-text("Table of Contents")'),
        scope.locator?.('ion-item[role="listitem"]:has-text("Contents")'),
        scope.getByRole?.('menuitem', { name: /table of contents|contents/i } as any),
      ].filter(Boolean) as Locator[];

      for (const item of menuItems) {
        if (await item.isVisible().catch(() => false)) {
          await item.click({ timeout: 2_000 }).catch(() => {});
          opened = true;
          await page.locator('ion-menu, .side-menu, .toc, ion-list').first().waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
          break;
        }
      }
    }

    if (!opened) {
      await page.screenshot({ path: 'toc-open-timeout.png', fullPage: true }).catch(() => {});
      throw new Error('Could not open Table of Contents. Saved screenshot: toc-open-timeout.png');
    }

    await delay(800);
  }

  async function goToPage(pageNumber: number) {
    // Dismiss any overlays first
    await page.keyboard.press('Escape').catch(() => {});
    await delay(100);

    // If we are already on the requested page, short-circuit
    let current = await getPageNav(false).catch(() => undefined as any);
    if (current?.page === pageNumber) {
      return;
    }

    // Clamp target page within [1, total]
    if (current?.total) {
      pageNumber = Math.min(Math.max(1, pageNumber), current.total);
      if (current.page === pageNumber) {
        return;
      }
    }

    // Some Kindle layouts render the reader inside an iframe; prefer that if present
    const readerFrame = page.frame({ url: /read\.amazon\./ }) || page.mainFrame();
    const scope = readerFrame as unknown as Page; // Page & Frame share locator API used below

    // Make toolbar visible (it auto-hides)
    const makeToolbarVisible = async () => {
      await scope.waitForLoadState?.('domcontentloaded').catch(() => {});
      await page.locator('#reader-header, .top-chrome, ion-toolbar').first().hover({ force: true }).catch(() => {});
      await delay(150);
      await page.mouse.move(60, 60).catch(() => {});
      await delay(150);
    };

    await makeToolbarVisible();

    // Open the Reader menu (hamburger/kebab). Try multiple candidates with retries.
    const menuCandidates: Locator[] = [
      scope.locator?.('ion-button[title="Reader menu"]'),
      scope.locator?.('button[title="Reader menu"]'),
      scope.getByRole?.('button', { name: /reader menu|menu|more/i } as any),
      // Some builds expose a generic kebab/hamburger without title
      scope.locator?.('[aria-label="Menu"], [data-testid="reader-menu"], ion-button:has(ion-icon[name="menu"])'),
    ].filter(Boolean) as Locator[];

    let menuOpened = false;
    const openDeadline = Date.now() + 10_000;
    while (!menuOpened && Date.now() < openDeadline) {
      for (const cand of menuCandidates) {
        if (await cand.isVisible().catch(() => false)) {
          await cand.click({ timeout: 1_000 }).catch(() => {});
          // Wait for the menu list to show up
          const menuList = scope.locator?.('ion-list, [role="menu"], .menu-content');
          await menuList?.first().waitFor({ state: 'visible', timeout: 1_000 }).catch(() => {});
          // Heuristic: if "Go to Page" is visible, we consider the menu opened
          const gotoItem = scope.locator?.('ion-item[role="listitem"]:has-text("Go to Page"), [role="menuitem"]:has-text("Go to Page")');
          if (gotoItem && await gotoItem.first().isVisible().catch(() => false)) {
            menuOpened = true;
            break;
          }
        }
      }
      if (!menuOpened) {
        await makeToolbarVisible();
      }
    }

    if (!menuOpened) {
      await page.screenshot({ path: 'goto-open-menu-timeout.png', fullPage: true }).catch(() => {});
      throw new Error('Could not open Reader menu to navigate to a page. Saved screenshot: goto-open-menu-timeout.png');
    }

    // Click "Go to Page"
    const gotoItem = scope.locator?.('ion-item[role="listitem"]:has-text("Go to Page"), [role="menuitem"]:has-text("Go to Page")');
    if (!gotoItem || !await gotoItem.first().isVisible().catch(() => false)) {
      await page.screenshot({ path: 'goto-item-missing.png', fullPage: true }).catch(() => {});
      throw new Error('"Go to Page" menu item not found. Saved screenshot: goto-item-missing.png');
    }
    await gotoItem.first().click({ timeout: 2_000 }).catch(() => {});

    // Wait for the modal and fill the page number
    const modal = scope.locator?.('ion-modal, [role="dialog"]');
    await modal?.first().waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});

    const inputBox = scope.locator?.('ion-modal input[placeholder="page number"], ion-modal input[type="text"], [role="dialog"] input');
    if (!inputBox) {
      await page.screenshot({ path: 'goto-input-missing.png', fullPage: true }).catch(() => {});
      throw new Error('Go to Page input not found. Saved screenshot: goto-input-missing.png');
    }
    await inputBox.first().fill(String(pageNumber), { timeout: 2_000 }).catch(() => {});

    // Click Go / submit or press Enter
    const goBtn = scope.locator?.('ion-modal ion-button[item-i-d="go-to-modal-go-button"], ion-modal button:has-text("Go")');
    if (goBtn && await goBtn.first().isVisible().catch(() => false)) {
      await goBtn.first().click({ timeout: 2_000 }).catch(() => {});
    } else {
      await inputBox.first().press('Enter').catch(() => {});
    }

    // Wait until the footer reflects the requested page or we time out
    const waitDeadline = Date.now() + 12_000;
    let nav = undefined as any;
    while (Date.now() < waitDeadline) {
      nav = await getPageNav(false).catch(() => undefined as any);
      if (nav?.page === pageNumber) break;
      await delay(150);
    }

    // Fallback: if footer didn't update to the requested page, walk via chevrons
    if (!nav || nav.page !== pageNumber) {
      // Determine direction and walk with safety limits
      const maxSteps = 1200; // generous upper bound for big books
      let steps = 0;
      let lastSrc = await page.locator(krRendererMainImageSelector).getAttribute('src').catch(() => undefined);

      const clickChevron = async (dir: 'left' | 'right') => {
        const selector = dir === 'left' ? '.kr-chevron-container-left' : '.kr-chevron-container-right';
        await page.locator(selector).click({ timeout: 1_000 }).catch(() => {});
      };

      // Re-sample current page
      nav = await getPageNav(false).catch(() => undefined as any);

      while (nav?.page !== undefined && nav.page !== pageNumber && steps < maxSteps) {
        const dir = nav.page > pageNumber ? 'left' : 'right';
        await clickChevron(dir);
        // Wait for image to change or page number to update
        const startWait = Date.now();
        while (Date.now() - startWait < 1200) {
          const srcNow = await page.locator(krRendererMainImageSelector).getAttribute('src').catch(() => lastSrc);
          if (srcNow && srcNow !== lastSrc) { lastSrc = srcNow; break; }
          await delay(100);
        }
        await delay(100);
        nav = await getPageNav(false).catch(() => nav);
        steps++;
      }

      // If still not at target, try opening the menu again once (best-effort)
      if (nav?.page !== pageNumber) {
        // Try pressing Escape (dismiss any lingering modal), then retry the direct method once more
        await page.keyboard.press('Escape').catch(() => {});
        await delay(150);

        // Re-attempt the Go To flow quickly
        const readerFrame2 = page.frame({ url: /read\.amazon\./ }) || page.mainFrame();
        const scope2 = readerFrame2 as unknown as Page;
        const reOpenMenu = [
          scope2.locator?.('ion-button[title="Reader menu"]'),
          scope2.locator?.('button[title="Reader menu"]'),
          scope2.getByRole?.('button', { name: /reader menu|menu|more/i } as any),
          scope2.locator?.('[aria-label="Menu"], [data-testid="reader-menu"], ion-button:has(ion-icon[name="menu"])'),
        ].filter(Boolean) as Locator[];
        for (const c of reOpenMenu) {
          if (await c.isVisible().catch(() => false)) { await c.click({ timeout: 1_000 }).catch(() => {}); break; }
        }
        const gotoItem2 = scope2.locator?.('ion-item[role="listitem"]:has-text("Go to Page"), [role="menuitem"]:has-text("Go to Page")');
        if (gotoItem2 && await gotoItem2.first().isVisible().catch(() => false)) {
          await gotoItem2.first().click({ timeout: 1_000 }).catch(() => {});
          const modal2 = scope2.locator?.('ion-modal, [role="dialog"]');
          await modal2?.first().waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
          const input2 = scope2.locator?.('ion-modal input[placeholder="page number"], [role="dialog"] input');
          if (input2) {
            await input2.first().fill(String(pageNumber)).catch(() => {});
            const goBtn2 = scope2.locator?.('ion-modal ion-button[item-i-d="go-to-modal-go-button"], ion-modal button:has-text("Go")');
            if (goBtn2 && await goBtn2.first().isVisible().catch(() => false)) {
              await goBtn2.first().click({ timeout: 1_000 }).catch(() => {});
            } else {
              await input2.first().press('Enter').catch(() => {});
            }
          }
        }

        // Final wait for footer state
        const finalWaitDeadline = Date.now() + 6_000;
        while (Date.now() < finalWaitDeadline) {
          nav = await getPageNav(false).catch(() => nav);
          if (nav?.page === pageNumber) break;
          await delay(150);
        }
      }

      if (nav?.page !== pageNumber) {
        await page.screenshot({ path: 'goto-fallback-failed.png', fullPage: true }).catch(() => {});
        throw new Error(`Failed to navigate to page ${pageNumber}. Saved screenshot: goto-fallback-failed.png (last seen page ${nav?.page ?? 'unknown'})`);
      }
    }

    // Close modal if it somehow remains
    if (modal && await modal.first().isVisible().catch(() => false)) {
      await page.keyboard.press('Escape').catch(() => {});
      await delay(100);
    }
  }

  async function getPageNav(log: boolean = process.env.LOG_FOOTER === '1') {
    const footerText = await page
      .locator('ion-footer ion-title')
      .first()
      .textContent()
    if (DBG && log) dlog('footer raw:', (footerText || '').trim());
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

  const initialPageNav = await getPageNav(false)

  await openTableOfContents()

  const $tocItems = await page.locator('ion-list ion-item').all()
  const tocItems: Array<TocItem> = []

  console.warn(`initializing ${$tocItems.length} TOC items...`)
  for (const tocItem of $tocItems) {
    await tocItem.scrollIntoViewIfNeeded()

    const title = await tocItem.textContent()
    assert(title)

    await tocItem.click()
    await delay(250)

    const pageNav = await getPageNav(false)
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

  // Detect a UI state where there's no visible next chevron and no readable footer
  async function isEndState() {
    try {
      const rightChevron = page.locator('.kr-chevron-container-right');
      const hasChevron = await rightChevron.isVisible().catch(() => false);
      const footer = page.locator('ion-footer ion-title').first();
      const footerText = (await footer.textContent().catch(() => null))?.trim() || '';
      const parsed = parsePageNav(footerText);
      const nearEnd = parsed?.page !== undefined && parsed?.total !== undefined && parsed.page >= parsed.total - 1;
      const hasFooter = !!parsed?.page || !!parsed?.location;
      if (DBG) dlog('isEndState:', { hasChevron, footerText, parsed, nearEnd });
      return (!hasChevron && !hasFooter) || (!hasChevron && nearEnd);
    } catch {
      return false;
    }
  }

  await page.locator('.side-menu-close-button').click()
  await delay(1000)

  // Try multiple ways to advance one page when the right chevron isn't clickable/visible
  async function advanceOnePageFromStuck(prevSrc?: string, targetNextPage?: number) {
    const rightChevron = page.locator('.kr-chevron-container-right');

    // 1) If the chevron is visible, click it
    if (await rightChevron.isVisible().catch(() => false)) {
      await rightChevron.click({ timeout: 1000 }).catch(() => {});
      await delay(200);
      const newSrc = await page.locator(krRendererMainImageSelector).getAttribute('src').catch(() => undefined);
      if (prevSrc && newSrc && newSrc !== prevSrc) return true;
    }

    // 2) Keyboard navigation
    for (const key of ['ArrowRight', 'PageDown', 'Space']) {
      await page.keyboard.press(key).catch(() => {});
      await delay(250);
      const newSrc = await page.locator(krRendererMainImageSelector).getAttribute('src').catch(() => undefined);
      if (prevSrc && newSrc && newSrc !== prevSrc) return true;
    }

    // 3) Click right side of the page image
    const box = await page.locator(krRendererMainImageSelector).boundingBox().catch(() => null);
    if (box) {
      await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.5).catch(() => {});
      await delay(250);
      const newSrc = await page.locator(krRendererMainImageSelector).getAttribute('src').catch(() => undefined);
      if (prevSrc && newSrc && newSrc !== prevSrc) return true;
    }

    // 4) Fallback: use Go To Page modal to jump to the next expected page
    if (typeof targetNextPage === 'number') {
      try {
        await goToPage(targetNextPage);
        return true;
      } catch {}
    }

    return false;
  }

  const pages: Array<PageChunk> = []
  // Persistent progress trackers across iterations
  let __lastCapturedPage: number | undefined = undefined;
  let __stagnantCount = 0;
  let __iterations = 0;
  console.warn(
    `reading ${totalContentPages} pages${total > totalContentPages ? ` (of ${total} total pages stopping at "${parsedToc.afterLastPageTocItem!.title}")` : ''}...`
  )

  let __reachedEnd = false;
  while (!__reachedEnd) {
    const pageNav = await getPageNav(false)
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
    dlog('loop: at page', pageNav.page, 'of', pageNav.total, 'src', short(src));

    // If we somehow didn't advance and are still on the same page as the last capture, try to advance before capturing again
    const prevEntry = pages.at(-1);
    if (prevEntry && prevEntry.page === pageNav.page) {
      dlog('loop: duplicate page detected, attempting advance');
      const advanced = await advanceOnePageFromStuck(src ?? undefined, Math.min(pageNav.page + 1, pageNav.total));
      dlog('loop: advance attempted');
      if (advanced) {
        // Re-sample nav and src after attempting to advance
        await delay(200);
        const reNav = await getPageNav(false).catch(() => pageNav);
        const reSrc = await page.locator(krRendererMainImageSelector).getAttribute('src').catch(() => src);
        if (reNav?.page !== pageNav.page) {
          // We advanced; update locals and continue to next iteration to capture the new page cleanly
          continue;
        }
      }
    }

    // Temporarily hide reader chrome for a clean capture
    const styleEl = await page.addStyleTag({
      content: `
        .top-chrome, ion-toolbar, ion-footer { opacity: 0 !important; }
        ion-popover, ion-modal { display: none !important; }
      `
    }).catch(() => null)

    // Log effective render size of the main image (helps confirm print-quality)
    try {
      const dims = await page.locator(krRendererMainImageSelector).evaluate((img: HTMLImageElement) => ({
        naturalWidth: img.naturalWidth || 0,
        naturalHeight: img.naturalHeight || 0,
        cssWidth: img.width || (img as any).clientWidth || 0,
        cssHeight: img.height || (img as any).clientHeight || 0,
      }))
      dlog('dims', dims)
    } catch {}

    const b = await page
      .locator(krRendererMainImageSelector)
      .screenshot({ type: 'png', scale: 'css' })

    // Remove the temporary style if we added it
    if (styleEl) {
      await styleEl.evaluate((el: any) => {
        if (el && el.parentNode) {
          el.parentNode.removeChild(el);
        }
      }).catch(() => {})
          }

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

    dlog('captured', pages.at(-1))

    // Track progress across iterations; if page number doesn't change, count it
    if (__lastCapturedPage === pageNav.page) {
      __stagnantCount++;
    } else {
      __stagnantCount = 0;
      __lastCapturedPage = pageNav.page;
    }

    // If we've been stagnant for several iterations, stop to avoid hanging
    if (__stagnantCount >= 2) {
      console.warn('no progress after multiple iterations; assuming end and exiting');
      __reachedEnd = true;
      break;
    }

    // Global safety: hard iteration cap to prevent infinite loops
    __iterations++;
    if (__iterations > totalContentPages * 2) {
      console.warn('iteration cap reached; exiting to prevent hang');
      __reachedEnd = true;
      break;
    }

    // Navigation is very spotty without this delay; I think it may be due to
    // the screenshot changing the DOM temporarily and not being stable yet.
    await delay(100)

    // If we appear to be at the practical end (no footer and no next chevron),
    // take one **final** safety screenshot and exit cleanly.
    dlog('loop: checking end state');
    if (await isEndState()) {
      await delay(200);

      // Temporarily hide reader chrome for a clean capture
      const styleEl2 = await page.addStyleTag({
        content: `
          .top-chrome, ion-toolbar, ion-footer { opacity: 0 !important; }
          ion-popover, ion-modal { display: none !important; }
        `
      }).catch(() => null)

      const b2 = await page.locator(krRendererMainImageSelector).screenshot({ type: 'png', scale: 'css' });

      if (styleEl2) {
        await styleEl2.evaluate((el: any) => { if (el && el.parentNode) { el.parentNode.removeChild(el); } }).catch(() => {})
      }

      const finalIndex = pages.length;
      // We may not have a footer page number here; best-effort label as current+1 (capped at total)
      const labeledPage = pageNav.page !== undefined ? Math.min(pageNav.page + 1, pageNav.total) : pageNav.total;
      const finalPath = path.join(
        pageScreenshotsDir,
        `${finalIndex}`.padStart(pagePadding, '0') + '-' + `${labeledPage}`.padStart(pagePadding, '0') + '.png'
      );
      await fs.writeFile(finalPath, b2);
      pages.push({ index: finalIndex, page: labeledPage, total: pageNav.total, screenshot: finalPath });

      console.warn('final end-of-book capture taken; exiting');
      __reachedEnd = true;
      break;
    }
    // Near-end guard: on penultimate page and no next chevron -> exit cleanly
    try {
      const rightChevron = page.locator('.kr-chevron-container-right');
      const chevronVisible = await rightChevron.isVisible().catch(() => false);
      if (!chevronVisible && pageNav.page >= Math.max(1, pageNav.total - 1)) {
        dlog('near-end guard triggered: page', pageNav.page, 'of', pageNav.total, 'no chevron');
        console.warn('penultimate page with no next control; exiting');
        __reachedEnd = true;
        break;
      }
    } catch {}

    if (pageNav.page >= totalContentPages) {
      // We've just captured the final page; stop before attempting navigation
      __reachedEnd = true;
      break
    }

    let retries = 0;
    const maxRetries = 20;
    let lastSrc = src;

    do {
      dlog('retry', retries, 'lastSrc', short(lastSrc));
      try {
        if (retries % 3 === 0) {
          // Prefer the chevron if present
          const rightChevron = page.locator('.kr-chevron-container-right');
          if (await rightChevron.isVisible().catch(() => false)) {
            await rightChevron.click({ timeout: 1000 }).catch(() => {});
          } else {
            // Use helper fallbacks when chevron is missing
            const advanced = await advanceOnePageFromStuck(lastSrc ?? undefined, Math.min(pageNav.page + 1, pageNav.total));
            if (!advanced) {
              // If we're at the end (last or last-1 page), stop instead of looping forever
              if (pageNav.total - pageNav.page <= 1) {
                dlog('retry: end-of-book condition, stopping');
                console.warn('end-of-book reached or next page control unavailable; stopping');
                retries = maxRetries;
                break;
              }
            }
          }
        }
      } catch {}

      // Wait for the image to change or the footer to update
      const startWait = Date.now();
      while (Date.now() - startWait < 1500) {
        const srcNow = await page.locator(krRendererMainImageSelector).getAttribute('src').catch(() => lastSrc);
        if (srcNow && srcNow !== lastSrc) { lastSrc = srcNow; break; }
        const navNow = await getPageNav(false).catch(() => pageNav);
        if (navNow?.page && navNow.page !== pageNav.page) {
          break;
        }
        await delay(120);
      }

      const navNow = await getPageNav(false).catch(() => pageNav);
      if (navNow?.page && navNow.page !== pageNav.page) {
        break; // advanced successfully
      }

      if (pageNav.page >= totalContentPages) {
        break; // we've captured the final target page
      }

      await delay(120);
      retries++;
    } while (retries < maxRetries)

    if (retries >= maxRetries) {
      dlog('navigation retries exhausted');
      console.warn('navigation retries exhausted; exiting at current page');
      __reachedEnd = true;
    }

    // Final guard: if we did not advance (footer page unchanged), assume end and exit outer loop
    const navAfter = await getPageNav(false).catch(() => pageNav);
    const afterPage: number | undefined = navAfter?.page;
    dlog('final guard: afterPage', afterPage, 'current', pageNav.page, 'totalCap', totalContentPages);
    if (afterPage === undefined || afterPage === pageNav.page || afterPage >= totalContentPages) {
      __reachedEnd = true;
    }
  }

  const result: BookMetadata = { info: info!, meta: meta!, toc, pages }
  await fs.writeFile(
    path.join(outDir, 'metadata.json'),
    JSON.stringify(result, null, 2)
  )
  if (DBG) dlog('DONE: pages captured', pages.length);
  console.log(JSON.stringify(result, null, 2))

  if (initialPageNav?.page !== undefined) {
    const endedOn = pages.at(-1)?.page;
    const SKIP_RESET = process.env.SKIP_RESET === '1' || DBG;

    if (SKIP_RESET) {
      console.warn(`skip reset enabled — leaving reader at page ${endedOn ?? 'unknown'}`);
    } else if (endedOn === initialPageNav.page) {
      console.warn(`already on initial page ${initialPageNav.page}; skipping reset`);
    } else {
      console.warn(`resetting back to initial page ${initialPageNav.page}...`);
      await goToPage(initialPageNav.page);
    }
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
