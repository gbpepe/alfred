import { expect, test } from '@playwright/test'

function buildTargetUrl(hash: string): string {
  const token = (process.env.STAGING_TOKEN || '').trim()
  return token ? `/?token=${encodeURIComponent(token)}#${hash}` : `/#${hash}`
}

test.describe('Alfred Staging Dashboard — Declarative Module Setup Wizard (#modules)', () => {
  test('walks through batch-api 3-step wizard: any_one counter, secret fields, Discord ID validation, connection test, inline help, and Esc close', async ({
    page,
    request,
  }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    const token = (process.env.STAGING_TOKEN || '').trim()
    const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}

    // Snapshot original DISCORD_CHANNEL_ALFRED_BATCH value so we can restore staging cleanly in finally
    const initialWizardResp = await request.get('/api/admin/modules/batch-api/wizard', { headers: authHeaders })
    expect(initialWizardResp.status()).toBe(200)
    const initialWizardJson = (await initialWizardResp.json()) as {
      state?: {
        steps?: Array<{
          id: string
          fields?: Array<{ key: string; isSet?: boolean; value?: string | null }>
        }>
      }
    }
    const discordStep = initialWizardJson.state?.steps?.find((s) => s.id === 'discord')
    const discordField = discordStep?.fields?.find((f) => f.key === 'DISCORD_CHANNEL_ALFRED_BATCH')
    const originalDiscordChannel = typeof discordField?.value === 'string' ? discordField.value : ''

    try {
      // 1. Open #modules and launch batch-api Setup Wizard
      await page.goto(buildTargetUrl('modules'), { waitUntil: 'domcontentloaded' })
      await expect(page.locator('#modulesPage')).toBeVisible({ timeout: 20_000 })

      const batchCard = page.locator('[data-module-item="batch-api"]')
      await expect(batchCard).toBeVisible({ timeout: 15_000 })

      const wizardBtn = batchCard.locator('[data-mod-wizard="batch-api"]')
      await expect(wizardBtn).toBeVisible({ timeout: 10_000 })
      await wizardBtn.click()

      const modal = page.locator('#moduleWizardModalOverlay')
      await expect(modal).toBeVisible({ timeout: 10_000 })

      // Verify stepper has 3 steps
      await expect(page.locator('#moduleWizardStepper [data-wiz-jump]')).toHaveCount(3)

      // Inline Help ? toggle inside wizard header
      await page.locator('#moduleWizardHelpBtn').click()
      await expect(page.locator('#moduleWizardHelpBox')).toBeVisible()
      await page.locator('#moduleWizardHelpBtn').click()
      await expect(page.locator('#moduleWizardHelpBox')).toBeHidden()

      // 2. Step 1 (providers): any_one counter + secret fields + eye toggle + no prefilled raw secret
      const counter = page.locator('#moduleWizardAnyOneCounter')
      await expect(counter).toBeVisible()
      await expect(counter).toContainText('Legalább 1 szolgáltató szükséges')

      const geminiInp = page.locator('#moduleWizardStepContent [data-wiz-field="GEMINI_API_KEY"]')
      await expect(geminiInp).toBeVisible()
      await expect(geminiInp).toHaveAttribute('type', 'password')
      await expect(geminiInp).toHaveValue('')

      const eyeBtn = page.locator('#moduleWizardStepContent [data-wiz-eye="GEMINI_API_KEY"]')
      await eyeBtn.click()
      await expect(geminiInp).toHaveAttribute('type', 'text')
      await eyeBtn.click()
      await expect(geminiInp).toHaveAttribute('type', 'password')

      // Advance to Step 2 (discord) without modifying Step 1 secrets
      await page.locator('#moduleWizardNextBtn').click()
      const discordInp = page.locator('#moduleWizardStepContent [data-wiz-field="DISCORD_CHANNEL_ALFRED_BATCH"]')
      await expect(discordInp).toBeVisible({ timeout: 10_000 })

      // 3. Step 2 (discord): reject invalid Discord channel ID, then accept valid 18-digit ID
      await discordInp.fill('invalid-channel-id')
      await page.locator('#moduleWizardNextBtn').click()
      const errBanner = page.locator('#moduleWizardError')
      await expect(errBanner).toBeVisible({ timeout: 10_000 })
      // Must remain on Step 2 after validation error
      await expect(discordInp).toBeVisible()

      // Now enter a valid 18-digit Discord channel ID format and advance to Step 3
      const testChannelId = originalDiscordChannel || '123456789012345678'
      await discordInp.fill(testChannelId)
      await page.locator('#moduleWizardNextBtn').click()

      // 4. Step 3 (verify_and_activate): click "Kapcsolat tesztelése" and verify checks render
      const testBtn = page.locator('#moduleWizardTestBtn')
      await expect(testBtn).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('#moduleWizardCompleteBtn')).toBeVisible()

      await testBtn.click()
      const testResults = page.locator('#moduleWizardTestResults')
      await expect(testResults).toContainText(/✓|✕/, { timeout: 15_000 })

      // 5. Close modal via Escape key
      await page.keyboard.press('Escape')
      await expect(modal).toBeHidden({ timeout: 10_000 })

      expect(pageErrors).toEqual([])
    } finally {
      // Restore original DISCORD_CHANNEL_ALFRED_BATCH and keep batch-api + alfred-batch active
      if (originalDiscordChannel) {
        await request
          .post('/api/admin/modules/batch-api/wizard/save', {
            headers: authHeaders,
            data: { stepId: 'discord', values: { DISCORD_CHANNEL_ALFRED_BATCH: originalDiscordChannel } },
          })
          .catch(() => {})
      } else {
        await request
          .post('/api/admin/modules/batch-api/wizard/save', {
            headers: authHeaders,
            data: { stepId: 'discord', clearKeys: ['DISCORD_CHANNEL_ALFRED_BATCH'] },
          })
          .catch(() => {})
      }
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
