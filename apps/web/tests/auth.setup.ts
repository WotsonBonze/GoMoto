/**
 * @file auth.setup.ts
 * @description Realiza o login uma única vez e salva o estado de autenticação
 * para todos os specs reutilizarem, evitando múltiplos logins desnecessários.
 */

import { test as setup, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const AUTH_FILE = 'tests/.auth/user.json'

setup('autenticar usuário de teste', async ({ page }) => {
  const email = process.env.TEST_USER_EMAIL
  const password = process.env.TEST_USER_PASSWORD

  if (!email || !password) {
    throw new Error(
      'TEST_USER_EMAIL e TEST_USER_PASSWORD precisam estar definidos em .env.test'
    )
  }

  await page.goto('/login')
  await page.waitForLoadState('networkidle')

  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Senha', { exact: true }).fill(password)
  await page.getByRole('button', { name: /entrar/i }).click()

  // Aguarda o redirecionamento para o dashboard após login bem-sucedido
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 })

  // Garante que o diretório existe antes de salvar
  const dir = path.dirname(AUTH_FILE)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // Salva cookies + localStorage com a sessão do Supabase
  await page.context().storageState({ path: AUTH_FILE })
})
