import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { input } from '@inquirer/prompts'
import delay from 'delay'
import { chromium, type ConsoleMessage, type Locator, type Page, type Request, type Response } from 'playwright-core'

import type { BookInfo, BookMeta, BookMetadata, PageChunk } from './types'
import {
  assert,
  deromanize,
  getEnv,
  normalizeAuthors,
  parseJsonpResponse
} from './utils'

const TIME = {
  otpVisible: 120_000,
  navOpen: 30_000,
  click: 1000,
  menuOpen: 10_000,
  footerSample: 150,
  imgChangeWait: 1200,
  finalWait: 6000,
} as const;


const SEL = {
  mainImg: '#kr-renderer .kg-full-page-img img',
  footerTitle: 'ion-footer ion-title',
  chevronRight: '.kr-chevron-container-right',
  chevronLeft: '.kr-chevron-container-left',
  readerHeader: '#reader-header, .top-chrome, ion-toolbar',
  tocItems: 'ion-list ion-item',
} as const;

// Helper used to avoid declaring functions inside loops (fixes no-loop-func)
async function captureMainImageBuffer(page: Page): Promise<Buffer> {
  return withCleanCapture(page, () =>
    page.locator(SEL.mainImg).screenshot({ type: 'png', scale: 'css' }) as Promise<Buffer>
  );
}

// Serializable function for .evaluate to avoid inline lambdas inside loops
function getImageDims(img: HTMLImageElement) {
  return {
    naturalWidth: img.naturalWidth || 0,
    naturalHeight: img.naturalHeight || 0,
    cssWidth: (img as any).width || (img as any).clientWidth || 0,
    cssHeight: (img as any).height || (img as any).clientHeight || 0,
  };
}

function getReaderScope(page: Page): Page {
  return (page.frame({ url: /read\.amazon\./ }) || page.mainFrame()) as unknown as Page;
}

async function withCleanCapture<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  const styleEl = await page
    .addStyleTag({
      content:
        '.top-chrome, ion-toolbar, ion-footer { opacity: 0 !important; } ion-popover, ion-modal { display: none !important; }',
    })
    .catch(() => null);
  try {
    return await fn();
  } finally {
    if (styleEl) {
      await styleEl
        .evaluate((el: Element) => {
          (el as HTMLElement).remove();
        })
        .catch(() => {});
    }
  }
}

// eslint-disable-next-line no-process-env
const DEBUG_KINDLE = process.env.DEBUG_KINDLE === '1';
// eslint-disable-next-line no-process-env
const LOG_FOOTER = process.env.LOG_FOOTER === '1';
// eslint-disable-next-line no-process-env
const SKIP_RESET_FLAG = process.env.SKIP_RESET === '1';
const DBG = DEBUG_KINDLE;
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
  await otpInput.waitFor({ state: 'visible', timeout: TIME.otpVisible });

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
    const t = await page.locator(SEL.footerTitle).first().textContent({ timeout: 2000 });
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

  let context: ReturnType<typeof chromium.launchPersistentContext> extends Promise<infer T> ? T | undefined : any;
  let pageRef: Page | undefined;
  try {

  const outDir = path.join('out', asin)
  const userDataDir = path.join(outDir, 'data')
  const pageScreenshotsDir = path.join(outDir, 'pages')
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.mkdir(pageScreenshotsDir, { recursive: true })

  const bookReaderUrl = `https://read.amazon.com/?asin=${asin}`

  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    executablePath:
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--hide-crash-restore-bubble'],
    ignoreDefaultArgs: ['--enable-automation'],
    deviceScaleFactor: 2,
    viewport: { width: 1400, height: 1800 }
  })
  pageRef = await context.newPage(); const page = pageRef;
  if (DBG) {
    page.on('console', (msg: ConsoleMessage) => dlog('[browser]', msg.type(), msg.text()));
    page.on('requestfailed', (req: Request) => dlog('[requestfailed]', req.failure()?.errorText, req.url()));
  }

  let info: BookInfo | undefined
  let meta: BookMeta | undefined

  page.on('response', async (response: Response) => {
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
        } catch {
          // As a fallback, try clicking the known OTP submit directly (legacy selector)
          await page
            .locator('input[type="submit"][aria-labelledby="cvf-submit-otp-button-announce"]')
            .click({ timeout: 5000 })
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
    const scope = getReaderScope(page);

    // Make sure the reader UI is actually visible; toolbars auto-hide
    await scope.waitForLoadState?.('domcontentloaded').catch(() => {});
    await delay(500);

    // Nudge the header/toolbar to appear
    try {
      await page.locator(SEL.readerHeader).first().hover({ force: true });
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
          await cand.click({ timeout: 2000 }).catch(() => {});
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        // Re-hover the header to keep toolbar visible
        await page.locator(SEL.readerHeader).first().hover({ force: true }).catch(() => {});
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
      await ember.first().click({ timeout: 2000 }).catch(() => {});
    }

    // Change layout to single column (label text can vary)
    const singleColGroup = scope.locator?.('[role="radiogroup"][aria-label$=" columns"]');
    if (singleColGroup) {
      await singleColGroup.filter({ hasText: /single column/i }).first().click({ timeout: 2000 }).catch(() => {});
    } else {
      await scope.getByRole?.('radio', { name: /single column/i } as any).click({ timeout: 2000 }).catch(() => {});
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
        await c.click({ timeout: 2000 }).catch(() => {});
        // Wait briefly to see if overlay disappears
        if (settingsOverlay && await settingsOverlay.first().isVisible().catch(() => false)) {
          await settingsOverlay.first().waitFor({ state: 'hidden', timeout: 1000 }).catch(() => {});
        }
        closed = true;
        break;
      }
    }

    // Fallback: force-close via Escape or clicking outside
    const closeDeadline = Date.now() + 3000;
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
            await c.click({ timeout: 1000 }).catch(() => {});
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

    const scope = getReaderScope(page);

    // Make toolbar visible
    await scope.waitForLoadState?.('domcontentloaded').catch(() => {});
    await delay(300);
    await page.locator(SEL.readerHeader).first().hover({ force: true }).catch(() => {});

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
          await cand.click({ timeout: 1000 }).catch(() => {});
          opened = true;
          // Wait for side menu / TOC panel to render (best-effort)
          await page.locator('ion-menu, .side-menu, .toc, ion-list').first().waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
          break;
        }
      }
      if (!opened) {
        // Re-hover header to keep toolbar visible and retry
        await page.locator(SEL.readerHeader).first().hover({ force: true }).catch(() => {});
        await delay(250);
      }
    }

    // Fallback path via the hamburger/reader menu
    if (!opened) {
      // Open the menu if present
      const menuBtn = scope.locator?.('ion-button[title="Reader menu"], button[title="Reader menu"], [aria-label="Reader menu"]');
      if (menuBtn && await menuBtn.first().isVisible().catch(() => false)) {
        await menuBtn.first().click({ timeout: 2000 }).catch(() => {});
        await delay(400);
      }

      const menuItems: Locator[] = [
        scope.locator?.('ion-item[role="listitem"]:has-text("Table of Contents")'),
        scope.locator?.('ion-item[role="listitem"]:has-text("Contents")'),
        scope.getByRole?.('menuitem', { name: /table of contents|contents/i } as any),
      ].filter(Boolean) as Locator[];

      for (const item of menuItems) {
        if (await item.isVisible().catch(() => false)) {
          await item.click({ timeout: 2000 }).catch(() => {});
          opened = true;
          await page.locator('ion-menu, .side-menu, .toc, ion-list').first().waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
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

  // Global flag: if the footer shows only "Location", disable large "Go to Page" jumps.
  let LOCATION_MODE = false;
  let tocSamples: Array<TocItem> = [];
  async function goToPage(pageNumber: number) {
    // Dismiss any overlays first
    await page.keyboard.press('Escape').catch(() => {});
    await delay(100);

    // LOCATION_MODE: Kindle often lacks a reliable "Go to Page" flow when only Locations are shown.
    // Use TOC jumps plus incremental navigation to reach the requested location.
    if (LOCATION_MODE) {
      const navInitial = await getPageNav(false).catch(() => undefined as PageNav | undefined);
      if (!navInitial?.page) return;
      if (pageNumber === navInitial.page) return;

      const stepOnce = async (
        direction: 'forward' | 'backward',
        baseline: PageNav
      ): Promise<PageNav | undefined> => {
        const img = page.locator(SEL.mainImg);
        const box = await img.boundingBox().catch(() => null);
        if (box) {
          await page.mouse
            .click(box.x + box.width * 0.5, box.y + box.height * 0.5)
            .catch(() => {});
          await delay(150);
        }
        const startSrc = await img.getAttribute('src').catch(() => null);
        const chevronSel = direction === 'forward' ? SEL.chevronRight : SEL.chevronLeft;
        const chevron = page.locator(chevronSel);

        if (await chevron.isVisible().catch(() => false)) {
          await chevron.click({ timeout: 800 }).catch(() => {});
        } else {
          const keySequences =
            direction === 'forward'
              ? ['ArrowRight', 'PageDown', 'Space']
              : ['ArrowLeft', 'PageUp', 'Backspace'];
          for (const key of keySequences) {
            await page.keyboard.press(key).catch(() => {});
            await delay(180);
            const srcNow = await img.getAttribute('src').catch(() => null);
            if (startSrc && srcNow && srcNow !== startSrc) break;
          }
          if (box) {
            const ratio = direction === 'forward' ? 0.85 : 0.15;
            await page.mouse
              .click(box.x + box.width * ratio, box.y + box.height * 0.5)
              .catch(() => {});
          }
        }

        const deadline = Date.now() + 1800;
        let latest: PageNav | undefined = baseline;
        while (Date.now() < deadline) {
          let navNow: PageNav | undefined;
          try {
            navNow = await getPageNav(false);
          } catch {
            navNow = undefined;
          }
          if (navNow?.page !== undefined && navNow.page !== baseline.page) {
            latest = navNow;
            break;
          }
          const srcNow = await img.getAttribute('src').catch(() => null);
          if (startSrc && srcNow && srcNow !== startSrc) {
            try {
              latest = await getPageNav(false);
            } catch {
              // keep latest as is
            }
            break;
          }
          await delay(140);
        }
        return latest;
      };

      const attemptTocJump = async (
        direction: 'forward' | 'backward',
        currentNav: PageNav,
        target: number
      ): Promise<PageNav | undefined> => {
        if (!tocSamples.length) return undefined;
        const candidates = tocSamples.filter((item) => item.page !== undefined && item.locator);
        if (!candidates.length) return undefined;

        const filtered = candidates.filter((item) => {
          if (item.page === undefined) return false;
          if (currentNav.page === undefined) return false;
          return direction === 'forward'
            ? item.page > currentNav.page
            : item.page < currentNav.page;
        });
        if (!filtered.length) return undefined;

        let bestMatch: { item: TocItem; diff: number } | undefined;
        for (const item of filtered) {
          const diff = Math.abs((item.page ?? target) - target);
          if (!bestMatch || diff < bestMatch.diff) {
            bestMatch = { item, diff };
          }
        }
        if (!bestMatch?.item.locator) return undefined;

        await openTableOfContents();
        await bestMatch.item.locator.scrollIntoViewIfNeeded().catch(() => {});
        await bestMatch.item.locator.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
        await bestMatch.item.locator.click({ timeout: 2000 }).catch(() => {});
        await delay(400);

        const closeBtn = page.locator('.side-menu-close-button');
        if (await closeBtn.isVisible().catch(() => false)) {
          await closeBtn.click({ timeout: 1000 }).catch(() => {});
          await delay(180);
        } else {
          await page.keyboard.press('Escape').catch(() => {});
          await delay(150);
        }

        const navAfter = await getPageNav(false).catch(() => undefined as PageNav | undefined);
        if (
          navAfter?.page !== undefined &&
          currentNav.page !== undefined &&
          Math.abs(navAfter.page - target) < Math.abs(currentNav.page - target)
        ) {
          return navAfter;
        }
        return navAfter;
      };

      let currentNav: PageNav | undefined = navInitial;
      let iterations = 0;
      let tocAttempts = 0;
      const maxIterations = 6000;

      while (currentNav?.page !== pageNumber && iterations < maxIterations) {
        if (!currentNav?.page) break;
        const delta = pageNumber - currentNav.page;
        if (!delta) break;
        const direction = delta > 0 ? 'forward' : 'backward';
        const absDelta = Math.abs(delta);

        if (absDelta > 50 && tocAttempts < 5) {
          const jumped = await attemptTocJump(direction, currentNav, pageNumber);
          tocAttempts++;
          if (jumped?.page !== undefined && jumped.page !== currentNav.page) {
            currentNav = jumped;
            continue;
          }
        }

        const stepped = await stepOnce(direction, currentNav);
        if (!stepped?.page || stepped.page === currentNav.page) {
          throw new Error(
            `LOCATION_MODE: unable to step ${direction} toward ${pageNumber}; last page ${currentNav.page}`
          );
        }
        currentNav = stepped;
        iterations++;
      }

      if (currentNav?.page !== pageNumber) {
        throw new Error(
          `LOCATION_MODE: failed to reach location ${pageNumber}; last seen ${currentNav?.page ?? 'unknown'}`
        );
      }
      return;
    }

    // If we are already on the requested page, short-circuit
    const current = await getPageNav(false).catch(() => undefined as any);
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

    const scope = getReaderScope(page);

    // Make toolbar visible (it auto-hides)
    const makeToolbarVisible = async () => {
      await scope.waitForLoadState?.('domcontentloaded').catch(() => {});
      await page.locator(SEL.readerHeader).first().hover({ force: true }).catch(() => {});
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
          await cand.click({ timeout: 1000 }).catch(() => {});
          // Wait for the menu list to show up
          const menuList = scope.locator?.('ion-list, [role="menu"], .menu-content');
          await menuList?.first().waitFor({ state: 'visible', timeout: 1000 }).catch(() => {});
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
    await gotoItem.first().click({ timeout: 2000 }).catch(() => {});

    // Wait for the modal and fill the page number
    const modal = scope.locator?.('ion-modal, [role="dialog"]');
    await modal?.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});

    const inputBox = scope.locator?.('ion-modal input[placeholder="page number"], ion-modal input[type="text"], [role="dialog"] input');
    if (!inputBox) {
      await page.screenshot({ path: 'goto-input-missing.png', fullPage: true }).catch(() => {});
      throw new Error('Go to Page input not found. Saved screenshot: goto-input-missing.png');
    }
    await inputBox.first().fill(String(pageNumber), { timeout: 2000 }).catch(() => {});

    // Click Go / submit or press Enter
    const goBtn = scope.locator?.('ion-modal ion-button[item-i-d="go-to-modal-go-button"], ion-modal button:has-text("Go")');
    if (goBtn && await goBtn.first().isVisible().catch(() => false)) {
      await goBtn.first().click({ timeout: 2000 }).catch(() => {});
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
      let lastSrc = await page.locator(SEL.mainImg).getAttribute('src').catch(() => undefined);

      const clickChevron = async (dir: 'left' | 'right') => {
        const selector = dir === 'left' ? SEL.chevronLeft : SEL.chevronRight;
        await page.locator(selector).click({ timeout: 1000 }).catch(() => {});
      };

      // Re-sample current page
      nav = await getPageNav(false).catch(() => undefined as any);

      while (nav?.page !== undefined && nav.page !== pageNumber && steps < maxSteps) {
        const dir = nav.page > pageNumber ? 'left' : 'right';
        await clickChevron(dir);
        // Wait for image to change or page number to update
        const startWait = Date.now();
        while (Date.now() - startWait < 1200) {
          const srcCandidate = await page
            .locator(SEL.mainImg)
            .getAttribute('src')
            .catch(() => null);
          const srcNow = srcCandidate ?? lastSrc;
          if (srcNow && srcNow !== lastSrc) { lastSrc = srcNow; break; }
          await delay(100);
        }
        await delay(100);
        const refreshedNav = await getPageNav(false).catch(() => undefined as PageNav | undefined);
        nav = refreshedNav ?? nav;
        steps++;
      }

      // If still not at target, try opening the menu again once (best-effort)
      if (nav?.page !== pageNumber) {
        // Try pressing Escape (dismiss any lingering modal), then retry the direct method once more
        await page.keyboard.press('Escape').catch(() => {});
        await delay(150);

        // Re-attempt the Go To flow quickly
        const scope2 = getReaderScope(page);
        const reOpenMenu = [
          scope2.locator?.('ion-button[title="Reader menu"]'),
          scope2.locator?.('button[title="Reader menu"]'),
          scope2.getByRole?.('button', { name: /reader menu|menu|more/i } as any),
          scope2.locator?.('[aria-label="Menu"], [data-testid="reader-menu"], ion-button:has(ion-icon[name="menu"])'),
        ].filter(Boolean) as Locator[];
        for (const c of reOpenMenu) {
          if (await c.isVisible().catch(() => false)) { await c.click({ timeout: 1000 }).catch(() => {}); break; }
        }
        const gotoItem2 = scope2.locator?.('ion-item[role="listitem"]:has-text("Go to Page"), [role="menuitem"]:has-text("Go to Page")');
        if (gotoItem2 && await gotoItem2.first().isVisible().catch(() => false)) {
          await gotoItem2.first().click({ timeout: 1000 }).catch(() => {});
          const modal2 = scope2.locator?.('ion-modal, [role="dialog"]');
          await modal2?.first().waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
          const input2 = scope2.locator?.('ion-modal input[placeholder="page number"], [role="dialog"] input');
          if (input2) {
            await input2.first().fill(String(pageNumber)).catch(() => {});
            const goBtn2 = scope2.locator?.('ion-modal ion-button[item-i-d="go-to-modal-go-button"], ion-modal button:has-text("Go")');
            if (goBtn2 && await goBtn2.first().isVisible().catch(() => false)) {
              await goBtn2.first().click({ timeout: 1000 }).catch(() => {});
            } else {
              await input2.first().press('Enter').catch(() => {});
            }
          }
        }

        // Final wait for footer state
        const finalWaitDeadline = Date.now() + TIME.finalWait;
        while (Date.now() < finalWaitDeadline) {
          const finalNav = await getPageNav(false).catch(() => undefined as PageNav | undefined);
          nav = finalNav ?? nav;
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
    const modalEl = scope.locator?.('ion-modal, [role="dialog"]');
    if (modalEl && await modalEl.first().isVisible().catch(() => false)) {
      await page.keyboard.press('Escape').catch(() => {});
      await delay(100);
    }
  }

  async function getPageNav(log: boolean = LOG_FOOTER): Promise<PageNav | undefined> {
    const footerText = await page
      .locator(SEL.footerTitle)
      .first()
      .textContent();
    if (DBG && log) dlog('footer raw:', (footerText || '').trim());

    const parsed = parsePageNav(footerText);

    // Normalize: if the footer only shows "Location N of M", treat that as pages for downstream logic
    if (parsed && parsed.page === undefined && parsed.location !== undefined) {
      return { page: parsed.location, location: parsed.location, total: parsed.total } as PageNav;
    }
    return parsed;
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
  // Detect if footer exposes only "Location" (no true Page), for conservative nav
  try {
    const rawFooter = await getFooterRaw(page);
    const rawParsed = parsePageNav(rawFooter);
    if (rawParsed && rawParsed.page === undefined && rawParsed.location !== undefined) {
      LOCATION_MODE = true;
    }
  } catch {}

  await openTableOfContents()

  const $tocItems = await page.locator(SEL.tocItems).all()
  tocSamples = []

  console.warn(`initializing ${$tocItems.length} TOC items...`)
  for (const tocItem of $tocItems) {
    await tocItem.scrollIntoViewIfNeeded()

    const rawTitle = (await tocItem.textContent())?.trim()
    assert(rawTitle)
    const title = rawTitle as string

    await tocItem.click()
    await delay(250)

    const pageNav = await getPageNav(false)
    if (!pageNav) {
      throw new Error('Failed to read page navigation while collecting TOC items')
    }

    tocSamples.push({
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

  const parsedToc = parseTocItems(tocSamples)
  const toc: TocItem[] = tocSamples.map(({ locator: _, ...tocItem }) => tocItem)

  const { firstPageTocItem, afterLastPageTocItem } = parsedToc
  assert(firstPageTocItem, 'Unable to find first valid page in TOC (post-parse)')
  const total = firstPageTocItem!.total
  const pagePadding = `${total * 2}`.length
  await firstPageTocItem!.locator!.scrollIntoViewIfNeeded()
  await firstPageTocItem!.locator!.click()

  const limitCandidate = afterLastPageTocItem?.page ?? total
  const totalContentPages = Math.min(limitCandidate, total)
  assert(totalContentPages > 0, 'No content pages found')

  // Detect a UI state where there's no visible next chevron and no readable footer
  async function isEndState() {
    try {
      const rightChevron = page.locator(SEL.chevronRight);
      const hasChevron = await rightChevron.isVisible().catch(() => false);
      const footer = page.locator(SEL.footerTitle).first();
      const footerText = (await footer.textContent().catch(() => null))?.trim() || '';
      const parsed = parsePageNav(footerText);
      const nearEnd = parsed?.page !== undefined && parsed?.total !== undefined && parsed.page >= parsed.total - 1;
      const hasFooter = !!parsed?.page || !!parsed?.location;
      if (DBG) dlog('isEndState:', { hasChevron, footerText, parsed, nearEnd });
      // Do NOT treat as end if we have only a location footer; hidden chevrons are common at some zooms
      if (!hasChevron && hasFooter && parsed && parsed.page === undefined && parsed.location !== undefined) return false;
      return (!hasChevron && !hasFooter) || (!hasChevron && nearEnd);
    } catch {
      return false;
    }
  }

  await page.locator('.side-menu-close-button').click()
  await delay(1000)

  // Try multiple ways to advance one page when the right chevron isn't clickable/visible
  async function advanceOnePageFromStuck(prevSrc?: string, targetNextPage?: number) {
    const rightChevron = page.locator(SEL.chevronRight);
    const img = page.locator(SEL.mainImg);
    const box = await img.boundingBox().catch(() => null);

    // Always focus the content image first so keyboard events go to the reader
    if (box) {
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5).catch(() => {});
      await delay(120);
    }

    // 1) If the chevron is visible, click it
    if (await rightChevron.isVisible().catch(() => false)) {
      await rightChevron.click({ timeout: 1000 }).catch(() => {});
      await delay(200);
      const newSrc = await img.getAttribute('src').catch(() => undefined);
      if (prevSrc && newSrc && newSrc !== prevSrc) return true;
    }

    // 2) Keyboard navigation
    for (const key of ['ArrowRight', 'PageDown', 'Space']) {
      await page.keyboard.press(key).catch(() => {});
      await delay(220);
      const newSrc = await img.getAttribute('src').catch(() => undefined);
      if (prevSrc && newSrc && newSrc !== prevSrc) return true;
    }

    // 3) Click right side of the page image
    if (box) {
      await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.5).catch(() => {});
      await delay(220);
      const newSrc = await img.getAttribute('src').catch(() => undefined);
      if (prevSrc && newSrc && newSrc !== prevSrc) return true;
    }

    // 4) Fallback: only on true Page-mode, attempt Go To Page to the next expected page
    if (!LOCATION_MODE && typeof targetNextPage === 'number') {
      try {
        await goToPage(targetNextPage);
        return true;
      } catch {}
    }

    return false;
  }

  const pages: Array<PageChunk> = []
  // Persistent progress trackers across iterations
  let lastCapturedPage: number | undefined;
  let stagnantCount = 0;
  let iterations = 0;
  console.warn(
    `reading ${totalContentPages} pages${total > totalContentPages ? ` (of ${total} total pages stopping at "${parsedToc.afterLastPageTocItem!.title}")` : ''}...`
  )

  let reachedEnd = false;
  // eslint-disable-next-line no-loop-func
  while (!reachedEnd) {
    const pageNav = await getPageNav(false)
    if (pageNav?.page === undefined) {
      break
    }
    if (pageNav.page > totalContentPages) {
      break
    }

    const index = pages.length
    const src = await page
      .locator(SEL.mainImg)
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
        // Removed unused variable reSrc
        if (reNav?.page !== pageNav.page) {
          // We advanced; update locals and continue to next iteration to capture the new page cleanly
          continue;
        }
      }
    }

    // Temporarily hide reader chrome for a clean capture
    const b: Buffer = await captureMainImageBuffer(page);

    // Log effective render size of the main image (helps confirm print-quality)
    try {
      const dims = await page.locator(SEL.mainImg).evaluate(getImageDims as any);
      dlog('dims', dims)
    } catch {}

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
    if (lastCapturedPage === pageNav.page) {
      stagnantCount++;
    } else {
      stagnantCount = 0;
      lastCapturedPage = pageNav.page;
    }

    // If we've been stagnant for several iterations, stop to avoid hanging
    if (stagnantCount >= 2) {
      console.warn('no progress after multiple iterations; assuming end and exiting');
      reachedEnd = true;
      break;
    }

    // Global safety: hard iteration cap to prevent infinite loops
    iterations++;
    if (iterations > totalContentPages * 2) {
      console.warn('iteration cap reached; exiting to prevent hang');
      reachedEnd = true;
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

      const b2: Buffer = await captureMainImageBuffer(page);

      const finalIndex = pages.length;
      // We may not have a footer page number here; best-effort label as current+1 (capped at total)
      const labeledPage = pageNav.page !== undefined
        ? Math.min(pageNav.page + 1, pageNav.total)
        : Math.min((pageNav.location ?? pageNav.total) + 1, pageNav.total);
      const finalPath = path.join(
        pageScreenshotsDir,
        `${finalIndex}`.padStart(pagePadding, '0') + '-' + `${labeledPage}`.padStart(pagePadding, '0') + '.png'
      );
      await fs.writeFile(finalPath, b2);
      pages.push({ index: finalIndex, page: labeledPage, total: pageNav.total, screenshot: finalPath });

      console.warn('final end-of-book capture taken; exiting');
      reachedEnd = true;
      break;
    }
    // Near-end guard: on penultimate page and no next chevron -> exit cleanly
    try {
      const rightChevron = page.locator(SEL.chevronRight);
      const chevronVisible = await rightChevron.isVisible().catch(() => false);
      if (!chevronVisible && pageNav.page >= Math.max(1, pageNav.total - 1)) {
        dlog('near-end guard triggered: page', pageNav.page, 'of', pageNav.total, 'no chevron');
        console.warn('penultimate page with no next control; exiting');
        reachedEnd = true;
        break;
      }
    } catch {}

    if (pageNav.page >= totalContentPages) {
      // We've just captured the final page; stop before attempting navigation
      reachedEnd = true;
      break
    }

    let retries = 0;
    const maxRetries = 20;
    let lastSrc = src;

    do {
      dlog('retry', retries, 'lastSrc', short(lastSrc));
      try {
        if (LOCATION_MODE) {
          // In location-only books, always try the robust step advance (no Go To Page)
          const advanced = await advanceOnePageFromStuck(lastSrc ?? undefined, Math.min(pageNav.page + 1, pageNav.total));
          if (!advanced && (pageNav.total - pageNav.page <= 1)) {
            dlog('retry: end-of-book condition (LOCATION_MODE), stopping');
            console.warn('end-of-book reached or next page control unavailable; stopping');
            retries = maxRetries;
            break;
          }
        } else if (retries % 3 === 0) {
          // Prefer the chevron if present
          const rightChevron = page.locator(SEL.chevronRight);
          if (await rightChevron.isVisible().catch(() => false)) {
            await rightChevron.click({ timeout: 1000 }).catch(() => {});
          } else {
            // Use helper fallbacks when chevron is missing
            const advanced = await advanceOnePageFromStuck(lastSrc ?? undefined, Math.min(pageNav.page + 1, pageNav.total));
            if (!advanced && (pageNav.total - pageNav.page <= 1)) {
              dlog('retry: end-of-book condition, stopping');
              console.warn('end-of-book reached or next page control unavailable; stopping');
              retries = maxRetries;
              break;
            }
          }
        }
      } catch {}

      // Wait for the image to change or the footer to update
      const startWait = Date.now();
      while (Date.now() - startWait < 1500) {
        const srcCandidate = await page
          .locator(SEL.mainImg)
          .getAttribute('src')
          .catch(() => null);
        const srcNow = srcCandidate ?? lastSrc;
        if (srcNow && srcNow !== lastSrc) { lastSrc = srcNow; break; }
        const navNow = await getPageNav(false).catch(() => undefined as PageNav | undefined);
        const navCurrent = navNow ?? pageNav;
        if (navCurrent?.page && navCurrent.page !== pageNav.page) {
          break;
        }
        await delay(120);
      }

      const navNow = await getPageNav(false).catch(() => undefined as PageNav | undefined);
      const navResolved = navNow ?? pageNav;
      if (navResolved?.page && navResolved.page !== pageNav.page) {
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
      reachedEnd = true;
    }

    // Final guard: if we did not advance (footer page unchanged), assume end and exit outer loop
    const navAfter = await getPageNav(false).catch(() => undefined as PageNav | undefined);
    const afterPage: number | undefined = (navAfter ?? pageNav)?.page;
    dlog('final guard: afterPage', afterPage, 'current', pageNav.page, 'totalCap', totalContentPages);
    if (afterPage === undefined || afterPage === pageNav.page || afterPage >= totalContentPages) {
      reachedEnd = true;
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
    if (SKIP_RESET_FLAG || DBG) {
      console.warn(`skip reset enabled — leaving reader at page ${endedOn ?? 'unknown'}`);
    } else if (endedOn === initialPageNav.page) {
      console.warn(`already on initial page ${initialPageNav.page}; skipping reset`);
    } else {
      console.warn(`resetting back to initial page ${initialPageNav.page}...`);
      await goToPage(initialPageNav.page);
    }
  }

  } finally {
    await pageRef?.close().catch(() => {});
    await context?.close().catch(() => {});
  }
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
  // Normalize TOC items: if only `location` is present, treat it as `page`
  const norm = tocItems.map((item) => {
    if (item.page === undefined && item.location !== undefined) {
      return { ...item, page: item.location } as TocItem;
    }
    return item;
  });

  // Find the first page in the TOC which contains the main book content
  const firstPageTocItem = norm.find((item) => item.page !== undefined);
  assert(firstPageTocItem, 'Unable to find first valid page in TOC');

  // Try to find the first page in the TOC after the main book content
  const afterLastPageTocItem = norm.find((item) => {
    if (item.page === undefined) return false;
    if (item === firstPageTocItem) return false;

    const percentage = item.page / item.total;
    if (percentage < 0.9) return false;

    if (/acknowledgements/i.test(item.title)) return true;
    if (/^discover more$/i.test(item.title)) return true;
    if (/^extras$/i.test(item.title)) return true;
    if (/about the author/i.test(item.title)) return true;
    if (/meet the author/i.test(item.title)) return true;
    if (/^also by /i.test(item.title)) return true;
    if (/^copyright$/i.test(item.title)) return true;
    if (/ teaser$/i.test(item.title)) return true;
    if (/ preview$/i.test(item.title)) return true;
    if (/^excerpt from/i.test(item.title)) return true;
    if (/^cast of characters$/i.test(item.title)) return true;
    if (/^timeline$/i.test(item.title)) return true;
    if (/^other titles/i.test(item.title)) return true;

    return false;
  });

  return {
    firstPageTocItem,
    afterLastPageTocItem,
  };
}

await main()
