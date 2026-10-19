import { test, expect, type Browser } from '@playwright/test'
import {
  TEST_TAG,
  getModal,
  waitForPageLoad,
  createTestTenantMember,
  deleteTestAuthUser,
  getSupabaseAdmin,
} from './helpers'

/** Loga como outra persona numa aba isolada (cookies separados do storageState padrão). */
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

test.describe('Usuários do tenant — convite, papéis, revogação (Spec 0011)', () => {
  // Cada caso cria usuário e faz login de verdade, ida e volta pelo GoTrue:
  // cabe nos 30s padrão sozinho, não com a suíte inteira disputando.
  test.slow()

  const createdUserIds: string[] = []

  test.afterAll(async () => {
    for (const id of createdUserIds) await deleteTestAuthUser(id)
  })

  test('cria um novo usuário com senha definida na hora e ele consegue logar (RF-006)', async ({ page, browser }) => {
    const email = `e2e-invite-${Date.now()}@teste.com`

    await page.goto('/configuracoes/usuarios')
    await waitForPageLoad(page)

    await page.getByRole('button', { name: /convidar usuário/i }).click()
    const modal = getModal(page)
    await expect(modal).toBeVisible()

    await modal.getByLabel('Nome').fill(`${TEST_TAG} Convite E2E`)
    await modal.getByLabel('Email').fill(email)
    await modal.getByLabel('Senha', { exact: true }).fill('senha12345')
    await modal.getByLabel('Confirmar senha').fill('senha12345')
    await modal.getByRole('button', { name: /^convidar$/i }).click()

    // Sucesso fecha a modal e recarrega a lista (sem link de convite — a
    // senha já foi definida na hora, ver §3.1 revisado).
    await expect(modal).not.toBeVisible({ timeout: 10_000 })
    await expect(page.locator('tr', { hasText: email })).toBeVisible({ timeout: 10_000 })

    const admin = getSupabaseAdmin()
    const { data } = await admin.auth.admin.listUsers({ perPage: 200 })
    const created = data.users.find((u) => u.email === email)
    if (created) createdUserIds.push(created.id)

    // A senha definida no cadastro já autentica de verdade.
    const { context, page: newUserPage } = await loginAsNewContext(browser, email, 'senha12345')
    try {
      // 45s, não 15: este passo é o mais caro da suíte — contexto de browser
      // novo, login real no GoTrue e primeira navegação até `/dashboard`, que
      // no dev server ainda pode compilar a rota. Isolado passa em ~8s; na
      // suíte cheia estourava os 15s de forma intermitente, e a falha não dizia
      // nada sobre a senha, que é o que o teste afirma.
      await newUserPage.waitForURL(/\/dashboard/, { timeout: 45_000 })
    } finally {
      await context.close()
    }
  })

  test('rejeita convite de email que já é membro do mesmo tenant (RF-010)', async ({ page }) => {
    await page.goto('/configuracoes/usuarios')
    await waitForPageLoad(page)

    await page.getByRole('button', { name: /convidar usuário/i }).click()
    const modal = getModal(page)
    await expect(modal).toBeVisible()

    await modal.getByLabel('Nome').fill(`${TEST_TAG} Duplicado`)
    await modal.getByLabel('Email').fill('empresa01@teste.com')
    await modal.getByLabel('Senha', { exact: true }).fill('senha12345')
    await modal.getByLabel('Confirmar senha').fill('senha12345')
    await modal.getByRole('button', { name: /^convidar$/i }).click()

    await expect(modal.getByText(/já é membro dessa empresa/i)).toBeVisible({ timeout: 10_000 })
  })

  test('reseta a senha de um membro e ele consegue logar com a nova senha', async ({ page, browser }) => {
    const member = await createTestTenantMember('operator')
    createdUserIds.push(member.userId)

    await page.goto('/configuracoes/usuarios')
    await waitForPageLoad(page)

    const row = page.locator('tr', { hasText: member.email })
    await expect(row).toBeVisible({ timeout: 10_000 })
    await row.getByRole('button', { name: /resetar senha/i }).click()

    const modal = getModal(page)
    await expect(modal).toBeVisible()
    await modal.getByLabel('Nova senha', { exact: true }).fill('novaSenha456')
    await modal.getByLabel('Confirmar nova senha').fill('novaSenha456')
    await modal.getByRole('button', { name: /^resetar senha$/i }).click()
    await expect(modal).not.toBeVisible({ timeout: 10_000 })

    const { context, page: resetPage } = await loginAsNewContext(browser, member.email, 'novaSenha456')
    try {
      await resetPage.waitForURL(/\/dashboard/, { timeout: 15_000 })
    } finally {
      await context.close()
    }
  })

  test('lista e busca usuários por nome/email (RF-013/014)', async ({ page }) => {
    const member = await createTestTenantMember('operator')
    createdUserIds.push(member.userId)

    await page.goto('/configuracoes/usuarios')
    await waitForPageLoad(page)

    await expect(page.locator('tr', { hasText: member.email })).toBeVisible({ timeout: 10_000 })

    await page.getByPlaceholder(/buscar por nome ou email/i).fill('não-existe-ninguem')
    await expect(page.locator('tr', { hasText: member.email })).not.toBeVisible()

    await page.getByPlaceholder(/buscar por nome ou email/i).fill(member.email)
    await expect(page.locator('tr', { hasText: member.email })).toBeVisible()
  })

  test('altera o papel de um membro (RF-015)', async ({ page }) => {
    const member = await createTestTenantMember('operator')
    createdUserIds.push(member.userId)

    await page.goto('/configuracoes/usuarios')
    await waitForPageLoad(page)

    const row = page.locator('tr', { hasText: member.email })
    await expect(row).toBeVisible({ timeout: 10_000 })
    await row.locator('select').selectOption('admin')

    await expect(row.locator('select')).toHaveValue('admin', { timeout: 10_000 })
  })

  test('não oferece opção que deixaria o tenant sem owner ativo (RN-003)', async ({ page }) => {
    // empresa01@teste.com é o único Owner ativo de Empresa Teste 1 (seed) —
    // o dropdown da própria linha não deve nem oferecer papéis != owner.
    await page.goto('/configuracoes/usuarios')
    await waitForPageLoad(page)

    const ownerRow = page.locator('tr', { hasText: 'empresa01@teste.com' })
    await expect(ownerRow).toBeVisible({ timeout: 10_000 })
    const options = await ownerRow.locator('select option').allTextContents()
    expect(options).toEqual(['Proprietário'])
  })

  test('revoga o acesso de um membro e bloqueia acesso imediatamente (RF-018/021)', async ({ page, browser }) => {
    const member = await createTestTenantMember('operator')
    createdUserIds.push(member.userId)

    await page.goto('/configuracoes/usuarios')
    await waitForPageLoad(page)

    const row = page.locator('tr', { hasText: member.email })
    await expect(row).toBeVisible({ timeout: 10_000 })
    await row.getByRole('button', { name: /revogar/i }).click()

    const modal = getModal(page)
    await expect(modal).toBeVisible()
    await modal.getByRole('button', { name: /revogar acesso/i }).click()
    await expect(modal).not.toBeVisible({ timeout: 10_000 })
    await expect(row.getByText('Revogado')).toBeVisible({ timeout: 10_000 })

    // Sessão separada: o próprio revogado tenta acessar o cockpit.
    const { context, page: revokedPage } = await loginAsNewContext(browser, member.email, '12345678')
    try {
      await revokedPage.waitForURL(/\/dashboard/, { timeout: 15_000 })
      await expect(revokedPage.getByText(/acesso revogado/i)).toBeVisible({ timeout: 10_000 })
    } finally {
      await context.close()
    }
  })

  test('reativa o acesso de um membro revogado sem gerar novo convite (RF-024/025)', async ({ page, browser }) => {
    const member = await createTestTenantMember('operator', 'revoked')
    createdUserIds.push(member.userId)

    await page.goto('/configuracoes/usuarios')
    await waitForPageLoad(page)

    const row = page.locator('tr', { hasText: member.email })
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row.getByText('Revogado')).toBeVisible()
    await row.getByRole('button', { name: /reativar/i }).click()
    await expect(row.getByText('Ativo')).toBeVisible({ timeout: 10_000 })

    const { context, page: reactivatedPage } = await loginAsNewContext(browser, member.email, '12345678')
    try {
      await reactivatedPage.waitForURL(/\/dashboard/, { timeout: 15_000 })
      await expect(reactivatedPage.getByText(/acesso revogado/i)).not.toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('Operator não acessa a tela de usuários (RNF-003)', async ({ browser }) => {
    const member = await createTestTenantMember('operator')
    createdUserIds.push(member.userId)

    const { context, page } = await loginAsNewContext(browser, member.email, '12345678')
    try {
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 })
      await page.goto('/configuracoes/usuarios')
      await page.waitForURL(/\/configuracoes\/conta$/, { timeout: 10_000 })
    } finally {
      await context.close()
    }
  })
})
