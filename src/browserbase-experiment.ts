import 'dotenv/config'

import fs from 'node:fs/promises'

import { input } from '@inquirer/prompts'
import { chromium } from 'playwright-core'

import { assert, getEnv } from './utils'

// TODO: kindle pages don't seem to render properly in headless playwright,
// possibly due to webgl usage in the text renderer?

async function createSession() {
  const res = await fetch('https://www.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: {
      'x-bb-api-key': `${getEnv('BROWSERBASE_API_KEY')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      projectId: getEnv('BROWSERBASE_PROJECT_ID'),
      proxies: true
      // TODO: browserbase fingerprint docs seem to be broken
      // fingerprint: {
      //   devices: ['desktop'],
      //   // locales: ['en-US'],
      //   operatingSystems: ['linux']
      // }
    })
  })

  return res.json() as Promise<{ id: string }>
}

async function main() {
  const amazonEmail = getEnv('AMAZON_EMAIL')
  const amazonPassword = getEnv('AMAZON_PASSWORD')
  assert(amazonEmail, 'AMAZON_EMAIL is required')
  assert(amazonPassword, 'AMAZON_PASSWORD is required')

  const session = await createSession()
  console.log(session)
  const browser = await chromium.connectOverCDP(
    `wss://connect.browserbase.com?apiKey=${getEnv('BROWSERBASE_API_KEY')}&sessionId=${session.id}`
  )

  // Getting the default context to ensure the sessions are recorded.
  const defaultContext = browser.contexts()[0]!
  const page = defaultContext.pages()[0]!

  page.on('console', (msg) => {
    const message = msg.text()
    if (message === 'browserbase-solving-started') {
      console.log('Captcha Solving In Progress')
    } else if (message === 'browserbase-solving-finished') {
      console.log('Captcha Solving Completed')
    }
  })

  await page.goto('https://read.amazon.com/landing')
  await page.locator('[id="top-sign-in-btn"]').click()
  // await page.waitForURL('**/signin')

  await page.locator('input[type="email"]').fill(amazonEmail)
  await page.locator('input[type="submit"]').click()

  await page.locator('input[type="password"]').fill(amazonPassword)
  // await page.locator('input[type="checkbox"]').click()
  await page.locator('input[type="submit"]').click()

  // TODO: **only prompt for 2-factor auth code if needed**
  const code = await input({
    message: '2-factor auth code?'
  })
  if (code) {
    await page.locator('input[type="tel"]').fill(code)
    await page
      .locator(
        'input[type="submit"][aria-labelledby="cvf-submit-otp-button-announce"]'
      )
      .click()
  }

  await page.waitForURL('**/kindle-library')
  await page.locator('#title-B0819W19WD').click()

  const footerText = await page
    .locator('ion-footer ion-title')
    .textContent({ timeout: 90_000 })
  console.log(footerText)

  const b = await page.screenshot({ type: 'png' })
  await fs.writeFile('out/B0819W19WD-page-61.png', b)

  await page.close()
  await browser.close()
}

await main()
