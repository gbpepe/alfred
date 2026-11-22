import { expect, test, type Page } from '@playwright/test'

function buildTargetUrl(): string {
  const token = (process.env.STAGING_TOKEN || '').trim()
  return token ? `/?token=${encodeURIComponent(token)}#vps` : '/#vps'
}

async function openStagingVpsTab(page: Page): Promise<{ pageErrors: string[]; failedCliApi: string[] }> {
  const pageErrors: string[] = []
  const failedCliApi: string[] = []

  page.on('pageerror', (err) => {
    pageErrors.push(err.message)
  })
  page.on('response', (res) => {
    if (res.url().includes('/api/admin/clis') && res.status() >= 400) {
      failedCliApi.push(`${res.status()} ${res.url()}`)
    }
  })

  await page.goto(buildTargetUrl(), { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#vpsCliProvidersGrid')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('#vpsCliProvidersGrid [data-cli-auth-toggle]')).toHaveCount(3, { timeout: 20_000 })

  return { pageErrors, failedCliApi }
}

test.describe('Alfred Staging Dashboard UI/UX (isolated headless browser)', () => {
  test('renders all 3 CLI cards, collapsed drawers, toggle behavior, and red paid API-key warning', async ({ page }) => {
    const { pageErrors, failedCliApi } = await openStagingVpsTab(page)

    for (const cliId of ['claude', 'codex', 'gemini']) {
      const drawer = page.locator(`[data-cli-auth-drawer="${cliId}"]`)
      await expect(drawer).toBeHidden()

      const toggleBtn = page.locator(`[data-cli-auth-toggle="${cliId}"]`)
      await expect(toggleBtn).toBeVisible()
      await toggleBtn.click()
      await expect(drawer).toBeVisible()
      await toggleBtn.click()
      await expect(drawer).toBeHidden()
    }

    // If any card is in paid API-key mode, verify the strong red warning is displayed
    const paidBadges = page.locator('#vpsCliProvidersGrid', { hasText: 'API kulcs (FIZETŐS!)' })
    if ((await paidBadges.count()) > 0) {
      await expect(page.getByText('FIZETŐS API MÓD:').first()).toBeVisible()
    }

    await page.screenshot({ path: 'test-results/staging-cli-providers.png', fullPage: true })
    expect(pageErrors).toEqual([])
    expect(failedCliApi).toEqual([])
  })

  test('runs browser OAuth start & clean cancel on every installed CLI without JS or API errors', async ({ page }) => {
    const { pageErrors, failedCliApi } = await openStagingVpsTab(page)

    for (const cliId of ['claude', 'codex', 'gemini'] as const) {
      const toggleBtn = page.locator(`[data-cli-auth-toggle="${cliId}"]`)
      await toggleBtn.click()

      const drawer = page.locator(`[data-cli-auth-drawer="${cliId}"]`)
      await expect(drawer).toBeVisible()

      const startBtn = drawer.locator(`[data-cli-oauth-start="${cliId}"]`)
      if (await startBtn.isDisabled()) {
        // CLI not installed on this staging host — skip OAuth launch for this card
        await toggleBtn.click()
        continue
      }

      await startBtn.click()

      const loginBox = drawer.locator(`[data-cli-login-box="${cliId}"]`)
      await expect(loginBox).toBeVisible({ timeout: 15_000 })

      const oauthLink = loginBox.locator('a', { hasText: 'OAuth oldal megnyitása' })
      await expect(oauthLink).toBeVisible({ timeout: 20_000 })
      const href = await oauthLink.getAttribute('href')
      expect(href).toMatch(/^https:\/\//)

      if (cliId === 'codex') {
        await expect(loginBox).toContainText('Eszközkód:')
      } else {
        await expect(loginBox.locator(`[data-cli-login-code-inp="${cliId}"]`)).toBeVisible()
      }

      const cancelBtn = loginBox.locator(`[data-cli-login-cancel="${cliId}"]`)
      await expect(cancelBtn).toBeVisible()
      await cancelBtn.click()
      await expect(loginBox).toBeHidden({ timeout: 10_000 })

      await toggleBtn.click()
      await expect(drawer).toBeHidden()
    }

    expect(pageErrors).toEqual([])
    expect(failedCliApi).toEqual([])
  })

  test('rejects invalid manual OAuth JSON with clear inline error', async ({ page }) => {
    const { pageErrors } = await openStagingVpsTab(page)

    const toggleBtn = page.locator('[data-cli-auth-toggle="gemini"]')
    await toggleBtn.click()
    const drawer = page.locator('[data-cli-auth-drawer="gemini"]')
    await expect(drawer).toBeVisible()

    await drawer.locator('[data-cli-auth-input="gemini"]').fill('{invalid-json')
    await drawer.locator('[data-cli-auth-save="gemini"]').click()

    const msgEl = drawer.locator('[data-cli-auth-msg="gemini"]')
    await expect(msgEl).toContainText('Hiba:', { timeout: 10_000 })
    expect(pageErrors).toEqual([])
  })
})
