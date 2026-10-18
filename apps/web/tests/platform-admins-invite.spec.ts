import { test, expect, type Browser } from '@playwright/test'
import { TEST_TAG, getModal, waitForPageLoad, createTestPlatformAdmin, deleteTestPlatformAdmin, getSupabaseAdmin } from './helpers'

async function loginAsNewContext(browser: Browser, email: string, password: string) {
  // storageState:undefined é necessário mesmo com newContext() — sem isso o
  // Playwright herda a sessão do Owner compartilhada pelo projeto "chromium"
  // (tests/.auth/user.json, ver playwright.config.ts) em vez de abrir limpo.
  const context = await browser.newContext({ storageState: undefined })
  const page = await context.newPage()
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Senha', { exact: true }).fill(password)
  await page.getByRole('button', { name: /entrar/i }).click()
  return { context, page }
}

test.describe('Platform Admins — criação de admin do zero (Spec 0011)', () => {
  // Cria usuário e faz login de verdade, ida e volta pelo GoTrue: cabe nos
  // 30s padrão sozinho, não com a suíte inteira disputando o servidor.
  test.slow()

  const createdUserIds: string[] = []

  test.afterAll(async () => {
    for (const id of createdUserIds) await deleteTestPlatformAdmin(id)
  })

  test('Platform Owner cria admin do zero com senha e ele consegue logar (RF-001)', async ({ browser }) => {
    const email = `e2e-platform-invite-${Date.now()}@teste.com`

    const { context, page } = await loginAsNewContext(browser, 'master@teste.com', '12345678')
    try {
      await page.waitForURL(/\/admin\/dashboard/, { timeout: 30_000 })
      await page.goto('/admin/platform-admins')
      await waitForPageLoad(page)

      await page.getByRole('button', { name: /adicionar admin/i }).click()

      const modal = getModal(page)
      await expect(modal).toBeVisible()
      await modal.getByLabel('Nome').fill(`${TEST_TAG} Platform Admin`)
      await modal.getByLabel('Email').fill(email)
      await modal.getByLabel('Senha', { exact: true }).fill('senha12345')
      await modal.getByLabel('Confirmar senha').fill('senha12345')
      await modal.getByRole('button', { name: /^adicionar$/i }).click()

      // Sucesso fecha a modal — sem link de convite (senha já definida na hora).
      await expect(modal).not.toBeVisible({ timeout: 10_000 })
      await expect(page.getByText(email)).toBeVisible({ timeout: 10_000 })

      const admin = getSupabaseAdmin()
      const { data } = await admin.auth.admin.listUsers({ perPage: 200 })
      const created = data.users.find((u) => u.email === email)
      if (created) createdUserIds.push(created.id)
    } finally {
      await context.close()
    }

    // A senha definida no cadastro já autentica de verdade.
    const { context: newCtx, page: newPage } = await loginAsNewContext(browser, email, 'senha12345')
    try {
      await newPage.waitForURL(/\/admin\/dashboard/, { timeout: 30_000 })
    } finally {
      await newCtx.close()
    }
  })

  test('reseta a senha de um platform admin e ele consegue logar com a nova senha', async ({ browser }) => {
    const target = await createTestPlatformAdmin('operator')
    createdUserIds.push(target.userId)

    const { context, page } = await loginAsNewContext(browser, 'master@teste.com', '12345678')
    try {
      await page.waitForURL(/\/admin\/dashboard/, { timeout: 30_000 })
      await page.goto('/admin/platform-admins')
      await waitForPageLoad(page)

      const row = page.locator('tr', { hasText: target.email })
      await expect(row).toBeVisible({ timeout: 10_000 })
      await row.getByRole('button', { name: /resetar senha/i }).click()

      const modal = getModal(page)
      await expect(modal).toBeVisible()
      await modal.getByLabel('Nova senha', { exact: true }).fill('novaSenha456')
      await modal.getByLabel('Confirmar nova senha').fill('novaSenha456')
      await modal.getByRole('button', { name: /^resetar senha$/i }).click()
      await expect(modal).not.toBeVisible({ timeout: 10_000 })
    } finally {
      await context.close()
    }

    const { context: resetCtx, page: resetPage } = await loginAsNewContext(browser, target.email, 'novaSenha456')
    try {
      await resetPage.waitForURL(/\/admin\/dashboard/, { timeout: 30_000 })
    } finally {
      await resetCtx.close()
    }
  })

  test('rejeita email que já é admin da plataforma (RF-004)', async ({ browser }) => {
    const { context, page } = await loginAsNewContext(browser, 'master@teste.com', '12345678')
    try {
      await page.waitForURL(/\/admin\/dashboard/, { timeout: 30_000 })
      await page.goto('/admin/platform-admins')
      await waitForPageLoad(page)

      await page.getByRole('button', { name: /adicionar admin/i }).click()
      const modal = getModal(page)
      await expect(modal).toBeVisible()
      await modal.getByLabel('Nome').fill(`${TEST_TAG} Duplicado`)
      await modal.getByLabel('Email').fill('master@teste.com')
      await modal.getByLabel('Senha', { exact: true }).fill('senha12345')
      await modal.getByLabel('Confirmar senha').fill('senha12345')
      await modal.getByRole('button', { name: /^adicionar$/i }).click()

      await expect(modal.getByText(/já é admin da plataforma/i)).toBeVisible({ timeout: 10_000 })
    } finally {
      await context.close()
    }
  })

  test('rejeita email que já é Usuário do Sistema de um tenant (RF-003)', async ({ browser }) => {
    const { context, page } = await loginAsNewContext(browser, 'master@teste.com', '12345678')
    try {
      await page.waitForURL(/\/admin\/dashboard/, { timeout: 30_000 })
      await page.goto('/admin/platform-admins')
      await waitForPageLoad(page)

      await page.getByRole('button', { name: /adicionar admin/i }).click()
      const modal = getModal(page)
      await expect(modal).toBeVisible()
      await modal.getByLabel('Nome').fill(`${TEST_TAG} Duplicado`)
      await modal.getByLabel('Email').fill('empresa01@teste.com')
      await modal.getByLabel('Senha', { exact: true }).fill('senha12345')
      await modal.getByLabel('Confirmar senha').fill('senha12345')
      await modal.getByRole('button', { name: /^adicionar$/i }).click()

      await expect(modal.getByText(/já é usuário do sistema/i)).toBeVisible({ timeout: 10_000 })
    } finally {
      await context.close()
    }
  })

  test('Platform Operator não vê a ação de criar admin (RNF-004)', async ({ browser }) => {
    const operator = await createTestPlatformAdmin('operator')
    createdUserIds.push(operator.userId)

    const { context, page } = await loginAsNewContext(browser, operator.email, '12345678')
    try {
      await page.waitForURL(/\/admin\/dashboard/, { timeout: 30_000 })
      await page.goto('/admin/platform-admins')
      await waitForPageLoad(page)
      await expect(page.getByRole('button', { name: /adicionar admin/i })).not.toBeVisible()
    } finally {
      await context.close()
    }
  })
})
