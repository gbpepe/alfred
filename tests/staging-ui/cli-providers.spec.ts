import { expect, test, type Page } from '@playwright/test'

function buildTargetUrl(hash: string): string {
  const token = (process.env.STAGING_TOKEN || '').trim()
  return token ? `/?token=${encodeURIComponent(token)}#${hash}` : `/#${hash}`
}

async function openStagingProvidersTab(page: Page): Promise<{ pageErrors: string[]; failedCliApi: string[] }> {
  const pageErrors: string[] = []
  const failedCliApi: string[] = []

  page.on('pageerror', (err) => {
    pageErrors.push(err.message)
  })
  page.on('response', (res) => {
    if ((res.url().includes('/api/admin/clis') || res.url().includes('/api/admin/providers')) && res.status() >= 400) {
      failedCliApi.push(`${res.status()} ${res.url()}`)
    }
  })

  await page.goto(buildTargetUrl('providers'), { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#providersPage')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('#vpsCliProvidersGrid [data-cli-auth-toggle]')).toHaveCount(4, { timeout: 20_000 })
  await expect(page.locator('#vpsModelCatalogGrid [data-api-test]')).toHaveCount(5, { timeout: 20_000 })

  return { pageErrors, failedCliApi }
}

test.describe('Alfred Staging Dashboard UI/UX (isolated headless browser)', () => {
  test('keeps #vps dedicated to server controls and separates API & CLI onto #providers', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto(buildTargetUrl('vps'), { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#vpsPage')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('#vpsSystemBar')).toBeVisible()
    await expect(page.locator('#vpsStorageCard')).toBeVisible()
    await expect(page.locator('#vpsStorageBars')).toContainText('RAM & Node RSS', { timeout: 15_000 })
    await expect(page.locator('#vpsStorageDirs')).toContainText('store/', { timeout: 15_000 })
    await expect(page.locator('#vpsRunCleanupBtn')).toBeVisible()
    await page.locator('#vpsRunCleanupBtn').click()
    await expect(page.locator('#vpsStorageCleanupStatus')).toContainText('✓ Takarítás kész:', { timeout: 25_000 })
    // Verify the new Async Batch API Overview card (#vpsBatchCard) with KPI bar & 4-provider breakdown
    await expect(page.locator('#vpsBatchCard')).toBeVisible()
    await expect(page.locator('#vpsBatchKpiBar')).toContainText('Összes megtakarítás', { timeout: 15_000 })
    await expect(page.locator('#vpsBatchProvidersGrid [data-batch-provider]')).toHaveCount(4, { timeout: 15_000 })
    for (const bp of ['anthropic', 'gemini', 'vertex-eu', 'openai']) {
      await expect(page.locator(`#vpsBatchProvidersGrid [data-batch-provider="${bp}"]`)).toBeVisible()
    }
    await expect(page.locator('#vpsBatchJobsList')).toBeVisible()
    await expect(page.locator('#vpsServicesGrid')).toBeVisible()
    await expect(page.locator('#providersPage')).toBeHidden()
    await expect(page.locator('#vpsCliProvidersGrid')).toBeHidden()
    await expect(page.locator('#vpsModelCatalogGrid')).toBeHidden()

    // Sidebar link switches cleanly to API & CLI page
    const providersLink = page.locator('.sb-link[data-page="providers"]')
    await providersLink.click()
    await expect(page.locator('#providersPage')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('#vpsPage')).toBeHidden()
    await expect(page.locator('#vpsCliProvidersGrid [data-cli-test]')).toHaveCount(4, { timeout: 20_000 })
    await expect(page.locator('#vpsModelCatalogGrid [data-api-test]')).toHaveCount(5, { timeout: 20_000 })
    await expect(page.locator('#vpsSkillsCatalogCard')).toBeVisible()
    await expect(page.locator('#vpsMcpServersCard')).toBeVisible()
    await expect(page.locator('#vpsSkillsSyncBtn')).toBeVisible()
    await expect(page.locator('#vpsMcpSyncProfilesBtn')).toBeVisible()

    // Trigger 4-CLI skill & profile sync on #providers and verify clean feedback
    await page.locator('#vpsSkillsSyncBtn').click()
    await expect(page.locator('#vpsSkillsCatalogStatus')).toContainText('✓ Szinkron kész', { timeout: 20_000 })
    await page.locator('#vpsMcpSyncProfilesBtn').click()
    await expect(page.locator('#vpsMcpServersStatus')).toContainText('✓ 4-CLI Profil Szinkron kész', { timeout: 20_000 })

    await page.screenshot({ path: 'test-results/staging-providers-page.png', fullPage: true })

    // Also verify the Agents page (#agents) role & global provider dropdowns include the 4 CLI providers
    await page.goto(buildTargetUrl('agents'), { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#vpsRolesGrid')).toBeVisible({ timeout: 20_000 })
    const firstRoleProvSel = page.locator('#vpsRolesGrid [data-role-provider]').first()
    await expect(firstRoleProvSel).toBeVisible({ timeout: 15_000 })
    for (const cliProv of ['claude-cli', 'codex-cli', 'agy-cli', 'gemini-cli']) {
      await expect(firstRoleProvSel.locator(`option[value="${cliProv}"]`)).toHaveCount(1)
    }

    expect(pageErrors).toEqual([])
  })

  test('renders all 3 CLI cards with Test buttons, collapsed drawers, toggle behavior, and red paid API-key warning on #providers', async ({ page }) => {
    const { pageErrors, failedCliApi } = await openStagingProvidersTab(page)

    for (const cliId of ['claude', 'codex', 'gemini', 'agy']) {
      const drawer = page.locator(`[data-cli-auth-drawer="${cliId}"]`)
      await expect(drawer).toBeHidden()

      await expect(page.locator(`[data-cli-test="${cliId}"]`)).toBeVisible()

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

    // Verify Enterprise-only notice on gemini-cli card pointing individual users to agy-cli
    const geminiCard = page.locator('#vpsCliProvidersGrid > div').filter({
      has: page.locator('[data-cli-auth-toggle="gemini"]'),
    })
    await expect(geminiCard).toContainText('Enterprise')
    await expect(geminiCard).toContainText('agy-cli')

    // Verify live quota button + auto-loaded quota strip on Claude and AGY cards when OAuth is active
    await expect(page.locator('[data-cli-quota-btn="claude"]')).toBeVisible()
    await expect(page.locator('[data-cli-quota-btn="codex"]')).toBeVisible()
      await expect(page.locator('[data-cli-quota-btn="agy"]')).toBeVisible()
      for (const qId of ['claude', 'agy'] as const) {
        const card = page.locator('#vpsCliProvidersGrid > div').filter({
          has: page.locator(`[data-cli-auth-toggle="${qId}"]`),
        })
        if ((await card.getByText('OAuth előfizetés OK').count()) > 0) {
          const quotaBox = card.locator(`[data-cli-quota-box="${qId}"]`)
          await expect(quotaBox).toBeVisible({ timeout: 15_000 })
          await expect(quotaBox).toContainText(/szabad|ablak|Kvóta/, { timeout: 15_000 })
        }
      }

      expect(pageErrors).toEqual([])
      expect(failedCliApi).toEqual([])
    })

  test('tests live connection on OAuth-authenticated CLIs and runs safe OAuth start/cancel only on unauthenticated CLIs', async ({ page }) => {
    const { pageErrors, failedCliApi } = await openStagingProvidersTab(page)

    for (const cliId of ['claude', 'codex', 'gemini', 'agy'] as const) {
      const card = page.locator('#vpsCliProvidersGrid > div').filter({
        has: page.locator(`[data-cli-auth-toggle="${cliId}"]`),
      })
      const isOAuthLoggedIn = (await card.getByText('OAuth előfizetés OK').count()) > 0

      if (isOAuthLoggedIn) {
        // NEVER trigger OAuth login on an already-authenticated CLI (could clobber live session).
        // Instead, verify the live "Teszt" button returns a structured result cleanly!
        const testBtn = card.locator(`[data-cli-test="${cliId}"]`)
        await testBtn.click()
        const resultEl = card.locator(`[data-cli-test-result="${cliId}"]`)
        await expect(resultEl).toBeVisible({ timeout: 45_000 })
        if (cliId === 'claude' || cliId === 'codex' || cliId === 'agy') {
          await expect(resultEl).toContainText('✓ Kapcsolat OK', { timeout: 45_000 })
        } else {
          // Wait until "tesztelése (ping)..." resolves to either ✓ Kapcsolat OK or a detailed provider error
          await expect(resultEl).toContainText(/✓ Kapcsolat OK|✕ Hiba \(\d+ ms\)/, { timeout: 45_000 })
        }
        continue
      }

      const toggleBtn = page.locator(`[data-cli-auth-toggle="${cliId}"]`)
      await toggleBtn.click()

      const drawer = page.locator(`[data-cli-auth-drawer="${cliId}"]`)
      await expect(drawer).toBeVisible()

      const startBtn = drawer.locator(`[data-cli-oauth-start="${cliId}"]`)
      if (await startBtn.isDisabled()) {
        // If agy-cli is not yet installed on staging, actually click Telepítés and verify install succeeds!
        if (cliId === 'agy') {
          await toggleBtn.click()
          const installBtn = card.locator('[data-cli-action="install"][data-cli-id="agy"]')
          await installBtn.click()
          await expect(card.locator('[data-cli-action="install"][data-cli-id="agy"]')).toHaveText('Frissítés', {
            timeout: 120_000,
          })
          await expect(card.locator('[data-cli-test="agy"]')).toBeEnabled()
          await page.locator('[data-cli-auth-toggle="agy"]').click()
          await expect(page.locator('[data-cli-auth-drawer="agy"]')).toBeVisible()
        } else {
          await toggleBtn.click()
          continue
        }
      }

      const activeDrawer = page.locator(`[data-cli-auth-drawer="${cliId}"]`)
      const activeStartBtn = activeDrawer.locator(`[data-cli-oauth-start="${cliId}"]`)
      await activeStartBtn.click()

      const loginBox = activeDrawer.locator(`[data-cli-login-box="${cliId}"]`)
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

      await page.locator(`[data-cli-auth-toggle="${cliId}"]`).click()
      await expect(activeDrawer).toBeHidden()
    }

    // Verify Enterprise-only notice on gemini-cli card pointing individual users to agy-cli
    const geminiCard = page.locator('#vpsCliProvidersGrid > div').filter({
      has: page.locator('[data-cli-auth-toggle="gemini"]'),
    })
    await expect(geminiCard).toContainText('Enterprise')
    await expect(geminiCard).toContainText('agy-cli')

    // Verify live quota button + quota box output on Claude card
    await expect(page.locator('[data-cli-quota-btn="claude"]')).toBeVisible()
    await expect(page.locator('[data-cli-quota-btn="codex"]')).toBeVisible()
    const claudeCard = page.locator('#vpsCliProvidersGrid > div').filter({
      has: page.locator('[data-cli-auth-toggle="claude"]'),
    })
    await page.locator('[data-cli-quota-btn="claude"]').click()
    const quotaBox = claudeCard.locator('[data-cli-quota-box="claude"]')
    await expect(quotaBox).toBeVisible({ timeout: 15_000 })
    await expect(quotaBox).toContainText(/5 órás ablak|Nincs aktív Claude OAuth token\./, { timeout: 15_000 })

    expect(pageErrors).toEqual([])
    expect(failedCliApi).toEqual([])
  })

  test('rejects invalid manual OAuth JSON with clear inline error', async ({ page }) => {
    const { pageErrors } = await openStagingProvidersTab(page)

    const toggleBtn = page.locator('[data-cli-auth-toggle="gemini"]')
    await toggleBtn.click()
    const drawer = page.locator('[data-cli-auth-drawer="gemini"]')
    await expect(drawer).toBeVisible()

    await drawer.locator('[data-cli-manual-details="gemini"] summary').click()
    await drawer.locator('[data-cli-auth-input="gemini"]').fill('{invalid-json')
    await drawer.locator('[data-cli-auth-save="gemini"]').click()

    const msgEl = drawer.locator('[data-cli-auth-msg="gemini"]')
    await expect(msgEl).toContainText('Hiba:', { timeout: 10_000 })
    expect(pageErrors).toEqual([])
  })

  test('renders comprehensive Hungarian handbook & tutorials on #docs with quick chapter tabs, TOC, search filter, and copyable code blocks', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto(buildTargetUrl('docs'), { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#docsPage')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('#docsQuickTabs [data-docs-quick]')).toHaveCount(6, { timeout: 15_000 })
    await expect(page.locator('#docsContent')).toContainText('Alfred Kézikönyv & Lépésről-lépésre Tutorialok', {
      timeout: 20_000,
    })
    await expect(page.locator('#docsTocBar [data-docs-toc]').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('#docsContent [data-docs-copy-btn]').first()).toBeVisible()

    // Switch chapter via quick tab (Chapter 3: Per-Agent Profiles, SKILL.md & MCP + Vault)
    await page.locator('[data-docs-quick="03-per-agent-profilok-skill-es-mcp-vault.md"]').click()
    await expect(page.locator('#docsContent')).toContainText('/home/alfred/.cli-profiles/<cliId>/<agentId>', {
      timeout: 15_000,
    })

    // Filter sidebar via search input
    const searchInput = page.locator('#docsSearchInput')
    await searchInput.fill('wal_checkpoint')
    await expect(page.locator('#docsSearchCount')).toContainText('találat')
    await expect(
      page.locator('#docsList .docs-list-item[data-doc="04-vps-eroforras-figyeles-es-housekeeping.md"]'),
    ).toBeVisible()
    await page.locator('#docsSearchClearBtn').click()
    await expect(searchInput).toHaveValue('')

    expect(pageErrors).toEqual([])
  })
})
