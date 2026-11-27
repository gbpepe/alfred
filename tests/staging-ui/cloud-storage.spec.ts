import { expect, test } from '@playwright/test'

function buildTargetUrl(hash: string): string {
  const token = (process.env.STAGING_TOKEN || '').trim()
  return token ? `/?token=${encodeURIComponent(token)}#${hash}` : `/#${hash}`
}

test.describe('Alfred Staging Dashboard — Cloud Storage Module & Multi-Account UI', () => {
  test('verifies cloud-storage wizard (oauth_redirect copy box + probe) and #vpsCloudStorageCard multi-account controls', async ({
    page,
    request,
  }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    const token = (process.env.STAGING_TOKEN || '').trim()
    const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}

    // Snapshot original enabled state of cloud-storage so we can restore staging cleanly
    const modsResp = await request.get('/api/admin/modules', { headers: authHeaders })
    expect(modsResp.status()).toBe(200)
    const modsJson = (await modsResp.json()) as {
      modules?: Array<{ id: string; enabled: boolean }>
    }
    const cloudMod = modsJson.modules?.find((m) => m.id === 'cloud-storage')
    expect(cloudMod, 'cloud-storage module must be discovered in /api/admin/modules').toBeTruthy()
    const initiallyEnabled = Boolean(cloudMod?.enabled)

    try {
      // 1. Open #modules and inspect cloud-storage Setup Wizard
      await page.goto(buildTargetUrl('modules'), { waitUntil: 'domcontentloaded' })
      await expect(page.locator('#modulesPage')).toBeVisible({ timeout: 20_000 })

      const cloudCard = page.locator('[data-module-item="cloud-storage"]')
      await expect(cloudCard).toBeVisible({ timeout: 15_000 })

      const wizardBtn = cloudCard.locator('[data-mod-wizard="cloud-storage"]')
      await expect(wizardBtn).toBeVisible({ timeout: 10_000 })
      await wizardBtn.click()

      const modal = page.locator('#moduleWizardModalOverlay')
      await expect(modal).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('#moduleWizardStepper [data-wiz-jump]')).toHaveCount(3)

      // Step 1 (credentials): verify oauth_redirect copy box renders callback URL
      const copyRedirectBtn = page.locator('#moduleWizardStepContent [data-wiz-copy-redirect]')
      await expect(copyRedirectBtn).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('#moduleWizardStepContent')).toContainText('/oauth-cloud-callback.html')

      // Jump to Step 3 (verify_and_activate) and run cloud_storage_probe
      await page.locator('#moduleWizardStepper [data-wiz-jump="2"]').click()
      const testBtn = page.locator('#moduleWizardTestBtn')
      await expect(testBtn).toBeVisible({ timeout: 10_000 })
      await testBtn.click()
      const testResults = page.locator('#moduleWizardTestResults')
      await expect(testResults).toContainText(/✓|✕/, { timeout: 15_000 })

      // Close modal via Escape
      await page.keyboard.press('Escape')
      await expect(modal).toBeHidden({ timeout: 10_000 })

      // 2. Enable cloud-storage and verify #vpsCloudStorageCard on #vps
      const enableResp = await request.post('/api/admin/modules/cloud-storage/enable', {
        headers: authHeaders,
        data: {},
      })
      expect(enableResp.status()).toBe(200)

      await page.goto(buildTargetUrl('vps'), { waitUntil: 'domcontentloaded' })
      await expect(page.locator('#vpsPage')).toBeVisible({ timeout: 20_000 })

      const vpsCloudCard = page.locator('#vpsCloudStorageCard')
      await expect(vpsCloudCard).toBeVisible({ timeout: 15_000 })

      // Provider tabs exist and switch cleanly
      const gdriveTab = vpsCloudCard.locator('[data-cloud-tab="gdrive"]')
      const onedriveTab = vpsCloudCard.locator('[data-cloud-tab="onedrive"]')
      const dropboxTab = vpsCloudCard.locator('[data-cloud-tab="dropbox"]')
      await expect(gdriveTab).toBeVisible({ timeout: 10_000 })
      await expect(onedriveTab).toBeVisible()
      await expect(dropboxTab).toBeVisible()

      await onedriveTab.click()
      await expect(onedriveTab).toHaveClass(/btn-primary/)
      await dropboxTab.click()
      await expect(dropboxTab).toHaveClass(/btn-primary/)
      await gdriveTab.click()
      await expect(gdriveTab).toHaveClass(/btn-primary/)

      // Multi-account add controls visible inside active provider body
      await expect(page.locator('#vpsCloudNewAccAliasInp')).toBeVisible()
      await expect(page.locator('#vpsCloudNewAccModeSel')).toBeVisible()
      await expect(page.locator('#vpsCloudAddAccountBtn')).toBeVisible()

      // Global settings controls visible
      await expect(page.locator('#vpsCloudDefaultProviderSel')).toBeVisible()
      await expect(page.locator('#vpsCloudDefaultShareEmailInp')).toBeVisible()
      await expect(page.locator('#vpsCloudAllowPublicChk')).toBeVisible()
      await expect(page.locator('#vpsCloudSaveGlobalBtn')).toBeVisible()

      // Verify /oauth-cloud-callback.html static page is served
      const cbResp = await request.get('/oauth-cloud-callback.html')
      expect(cbResp.status()).toBe(200)
      const cbBody = await cbResp.text()
      expect(cbBody).toContain('alfred_cloud_oauth_callback')

      expect(pageErrors).toEqual([])
    } finally {
      if (!initiallyEnabled) {
        await request
          .post('/api/admin/modules/cloud-storage/disable', {
            headers: authHeaders,
            data: {},
          })
          .catch(() => {})
      }
    }
  })
})
