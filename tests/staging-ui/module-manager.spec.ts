import { expect, test } from '@playwright/test'

function buildTargetUrl(hash: string): string {
  const token = (process.env.STAGING_TOKEN || '').trim()
  return token ? `/?token=${encodeURIComponent(token)}#${hash}` : `/#${hash}`
}

test.describe('Alfred Staging Dashboard — Module & Specialist Agent Manager (#modules)', () => {
  test('renders #modules Odoo grid, 2 GB RAM bar, proactive disabled states, detail modal, search/filters, and live cross-view gating', async ({
    page,
    request,
  }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    const token = (process.env.STAGING_TOKEN || '').trim()
    const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}

    // Ensure clean starting state before UI test
    await request.post('/api/admin/modules/batch-api/enable', {
      headers: authHeaders,
      data: { withDependencies: true },
    })
    await request.post('/api/admin/agent-packages/alfred-batch/enable', {
      headers: authHeaders,
      data: {},
    })

    try {
      // 1. Navigate via #vps then sidebar link RENDSZER -> Modulok & Ügynökök
      await page.goto(buildTargetUrl('vps'), { waitUntil: 'domcontentloaded' })
      await expect(page.locator('#vpsPage')).toBeVisible({ timeout: 20_000 })

      const modulesNavLink = page.locator('.sb-link[data-page="modules"]')
      await expect(modulesNavLink).toBeVisible({ timeout: 15_000 })
      await modulesNavLink.click()

      await expect(page.locator('#modulesPage')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('#modulesSummaryBar')).toBeVisible()
      await expect(page.locator('#modulesRamBar')).toBeVisible()
      await expect(page.locator('#modulesRamSummaryText')).toContainText('MB', { timeout: 15_000 })

      // Inline tip (dismiss + restore) & ? help popover (Esc close + section helps)
      const introTip = page.locator('[data-inline-tip="modules-intro"]')
      await expect(introTip).toBeVisible()
      await page.locator('#modulesIntroTipClose').click()
      await expect(introTip).toBeHidden()

      await expect(page.locator('#modulesHelpBtn')).toBeVisible()
      await page.locator('#modulesHelpBtn').click()
      await expect(page.locator('#modulesHelpPopover')).toBeVisible()
      await page.locator('#modulesRestoreTipsBtn').click()
      await expect(introTip).toBeVisible()
      await expect(page.locator('#modulesHelpPopover')).toBeHidden()

      // Escape key closes help popover
      await page.locator('#modulesHelpBtn').click()
      await expect(page.locator('#modulesHelpPopover')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.locator('#modulesHelpPopover')).toBeHidden()

      // Section-level ? inline help toggles
      for (const [btnId, boxId] of [
        ['#modulesRamHelpBtn', '#modulesRamHelpBox'],
        ['#systemModulesHelpBtn', '#systemModulesHelpBox'],
        ['#agentCatalogHelpBtn', '#agentCatalogHelpBox'],
      ]) {
        await page.locator(btnId).click()
        await expect(page.locator(boxId)).toBeVisible()
        await page.locator(btnId).click()
        await expect(page.locator(boxId)).toBeHidden()
      }

      // Direct #docs chapter 07 API + popover jump verification
      const docResp = await request.get('/api/docs/07-modul-es-ugynok-katalogus.md', { headers: authHeaders })
      expect(docResp.status()).toBe(200)
      const docsListResp = await request.get('/api/docs', { headers: authHeaders })
      expect(docsListResp.status()).toBe(200)
      const docsList = (await docsListResp.json()) as Array<{ name: string; pinned?: boolean }>
      const ch07 = docsList.find((d) => d.name === '07-modul-es-ugynok-katalogus.md')
      expect(ch07?.pinned).toBe(true)

      // 2. Built-in modules locked, batch-api active
      for (const builtInId of ['core-cli', 'core-ops']) {
        const card = page.locator(`[data-module-item="${builtInId}"]`)
        await expect(card).toBeVisible({ timeout: 15_000 })
        await expect(card).toContainText('Alapmodul')
        await expect(card.locator('button[disabled]')).toBeVisible()
      }
      const batchCard = page.locator('[data-module-item="batch-api"]')
      await expect(batchCard).toBeVisible({ timeout: 15_000 })
      await expect(batchCard).toContainText('Aktív')

      // 3. Proactive disabled state on iris-video (missing cloud-storage & worker-machines)
      const irisCard = page.locator('[data-agent-package="iris-video"]')
      await expect(irisCard).toBeVisible({ timeout: 15_000 })
      await expect(irisCard).toContainText('Előkészített · Hiányzó modul')
      const irisInstallBtn = irisCard.locator('[data-pkg-action="install"][data-pkg-id="iris-video"]')
      await expect(irisInstallBtn).toBeDisabled()

      // 4. Részletek modal on module & agent package (tools + SOUL.md preview)
      await batchCard.locator('[data-mod-detail="batch-api"]').click()
      await expect(page.locator('#moduleDetailModalOverlay')).toBeVisible()
      await expect(page.locator('#moduleDetailBody')).toContainText('batch_submit')
      await page.locator('#moduleDetailClose').click()
      await expect(page.locator('#moduleDetailModalOverlay')).toBeHidden()

      await page.locator('[data-pkg-detail="alfred-batch"]').click()
      await expect(page.locator('#moduleDetailModalOverlay')).toBeVisible()
      await expect(page.locator('#moduleDetailBody')).toContainText('SOUL.md előnézet')
      await page.locator('#moduleDetailClose').click()

      // 5. Search & state filter tabs
      const searchInp = page.locator('#modulesSearchInp')
      await searchInp.fill('iris')
      await expect(page.locator('[data-agent-package="iris-video"]')).toBeVisible()
      await expect(page.locator('[data-module-item="core-cli"]')).toHaveCount(0)
      await searchInp.fill('')

      await page.locator('#modulesStateTabs [data-mod-state="needs_config"]').click()
      await expect(page.locator('[data-agent-package="iris-video"]')).toBeVisible()
      await page.locator('#modulesStateTabs [data-mod-state="all"]').click()
      await expect(page.locator('[data-module-item="batch-api"]')).toBeVisible()

      // 6. Live cascade disable flow: batch-api -> confirm modal mentions Alfred Batch -> disables both
      await batchCard.locator('[data-mod-action="disable"]').click()
      await expect(page.locator('#moduleConfirmOverlay')).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('#moduleConfirmBody')).toContainText('Alfred Batch')
      await page.locator('#moduleConfirmOkBtn').click()
      await expect(page.locator('#moduleConfirmOverlay')).toBeHidden({ timeout: 15_000 })
      await expect(page.locator('[data-module-item="batch-api"]')).toContainText('Kikapcsolva', { timeout: 15_000 })

      // 7. Cross-view #vps check: #vpsBatchCard hidden + #vpsHiddenModulesNotice visible
      await page.locator('.sb-link[data-page="vps"]').click()
      await expect(page.locator('#vpsPage')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('#vpsBatchCard')).toBeHidden({ timeout: 15_000 })
      await expect(page.locator('#vpsHiddenModulesNotice')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('#vpsHiddenModulesNotice')).toContainText('kikapcsolt modul kártyája elrejtve')

      // 8. Cross-view #agents check: Alfred Batch shows Kikapcsolva badge
      await page.goto(buildTargetUrl('agents'), { waitUntil: 'domcontentloaded' })
      await expect(page.locator('#agentsPage')).toBeVisible({ timeout: 20_000 })
      const batchAgentCard = page.locator('.agent-card[data-name="alfred-batch"]')
      await expect(batchAgentCard).toBeVisible({ timeout: 15_000 })
      await expect(batchAgentCard).toContainText('Kikapcsolva')

      // 9. Re-enable batch-api + alfred-batch via #modules UI and verify #vpsBatchCard returns
      await page.goto(buildTargetUrl('modules'), { waitUntil: 'domcontentloaded' })
      await expect(page.locator('#modulesPage')).toBeVisible({ timeout: 20_000 })
      const directEnableBtn = page.locator('[data-module-item="batch-api"] [data-mod-action="enable"]')
      if (await directEnableBtn.isVisible().catch(() => false)) {
        await directEnableBtn.click()
      } else {
        await page.locator('[data-module-item="batch-api"] [data-mod-wizard="batch-api"]').click()
        await expect(page.locator('#moduleWizardModalOverlay')).toBeVisible({ timeout: 10_000 })
        await page.locator('#moduleWizardStepper [data-wiz-jump]').last().click()
        await page.locator('#moduleWizardCompleteBtn').click()
        await expect(page.locator('#moduleWizardModalOverlay')).toBeHidden({ timeout: 15_000 })
      }
      await expect(page.locator('[data-module-item="batch-api"]')).toContainText('Aktív', { timeout: 15_000 })
      const enableBatchAgentBtn = page.locator('[data-agent-package="alfred-batch"] [data-pkg-action="enable"]')
      if (await enableBatchAgentBtn.isVisible().catch(() => false)) {
        await enableBatchAgentBtn.click()
      }
      await expect(page.locator('[data-agent-package="alfred-batch"]')).toContainText('Aktív', { timeout: 15_000 })

      await page.locator('.sb-link[data-page="vps"]').click()
      await expect(page.locator('#vpsBatchCard')).toBeVisible({ timeout: 15_000 })
      // Other defaultEnabled=false modules (e.g. cloud-storage) may still keep the notice visible,
      // so assert that Batch API itself is no longer listed as hidden.
      const hiddenNotice = page.locator('#vpsHiddenModulesNotice')
      if (await hiddenNotice.isVisible().catch(() => false)) {
        await expect(hiddenNotice).not.toContainText('Batch API', { timeout: 15_000 })
      }

      // 10. Open chapter 07 directly from #modules header ? popover -> #docs
      await page.locator('.sb-link[data-page="modules"]').click()
      await expect(page.locator('#modulesPage')).toBeVisible({ timeout: 15_000 })
      await page.locator('#modulesHelpBtn').click()
      await expect(page.locator('#modulesHelpPopover')).toBeVisible()
      await page.locator('#modulesHelpOpenDocsBtn').click()
      await expect(page.locator('#docsPage')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('#docsContent')).toContainText('Modul- és Ügynökkatalógus', { timeout: 15_000 })
      await expect(page.locator('#docsContent')).toContainText('Admin REST API Referencia', { timeout: 15_000 })

      expect(pageErrors).toEqual([])
    } finally {
      // Always restore batch-api and alfred-batch active state even if an assertion fails
      await request
        .post('/api/admin/modules/batch-api/enable', {
          headers: authHeaders,
          data: { withDependencies: true },
        })
        .catch(() => {})
      await request
        .post('/api/admin/agent-packages/alfred-batch/enable', {
          headers: authHeaders,
          data: {},
        })
        .catch(() => {})
    }
  })
})
