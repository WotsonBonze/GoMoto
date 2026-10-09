/**
 * Contatos de emergência 1, 2 e 3.
 *
 * O par que já existia (`emergency_contact_name`/`_phone`) ganhou companhia:
 * `..._name2/_phone2` e `..._name3/_phone3`. Coluna nova é string livre até o
 * PostgREST responder — typecheck e unit test não enxergam o banco — e campo
 * que a action valida mas descarta passa por todos os portões.
 *
 * Por isso o teste segue o valor até quem LÊ: preenche os três pares na tela,
 * confere as seis colunas no banco e volta ao detalhe do cliente para ver as
 * três linhas renderizadas.
 */

import { test, expect } from '@playwright/test'
import {
  createTestCustomer, deleteTestCustomer, waitForPageLoad, getSupabaseAdmin,
} from './helpers'

const admin = () => getSupabaseAdmin()

const CONTATOS = [
  { pos: 1, nome: 'Maria Emergencia',  telefone: '(21) 98888-0001', digitos: '21988880001' },
  { pos: 2, nome: 'Joao Emergencia',   telefone: '(21) 98888-0002', digitos: '21988880002' },
  { pos: 3, nome: 'Ana Emergencia',    telefone: '(21) 98888-0003', digitos: '21988880003' },
]

let customerId = ''

test.describe('Contatos de emergência', () => {
  test.beforeAll(async () => {
    customerId = (await createTestCustomer()).id
  })

  test.afterAll(async () => {
    if (customerId) await deleteTestCustomer(customerId).catch(() => {})
  })

  test('os três pares chegam ao banco e voltam para a tela', async ({ page }) => {
    await page.goto(`/clientes/${customerId}/editar`)
    await waitForPageLoad(page)

    for (const c of CONTATOS) {
      await page.getByLabel(`Nome do Contato de Emergência ${c.pos}`).fill(c.nome)
      await page.getByLabel(`Telefone do Contato de Emergência ${c.pos}`).fill(c.telefone)
    }

    await page.getByRole('button', { name: /^salvar$/i }).click()
    await page.waitForURL(`**/clientes/${customerId}`, { timeout: 15_000 })

    const { data, error } = await admin()
      .from('customers')
      .select([
        'emergency_contact_name',  'emergency_contact_phone',
        'emergency_contact_name2', 'emergency_contact_phone2',
        'emergency_contact_name3', 'emergency_contact_phone3',
      ].join(','))
      .eq('id', customerId)
      .single()

    expect(error, 'coluna de contato de emergência não existe no banco').toBeNull()

    const row = data as unknown as Record<string, string | null>
    for (const c of CONTATOS) {
      const sufixo = c.pos === 1 ? '' : String(c.pos)
      expect(row[`emergency_contact_name${sufixo}`], `nome ${c.pos} não persistiu`).toBe(c.nome)
      // O telefone é gravado só com dígitos (stripPhone) e mascarado na leitura.
      expect(row[`emergency_contact_phone${sufixo}`], `telefone ${c.pos} não persistiu`).toBe(c.digitos)
    }

    // Persistir não basta: o detalhe precisa mostrar os três.
    await waitForPageLoad(page)
    for (const c of CONTATOS) {
      const linha = page.locator('tr', { hasText: `Contato de Emergência ${c.pos}` })
      await expect(linha, `contato ${c.pos} não aparece no detalhe`).toContainText(c.nome)
      await expect(linha).toContainText(c.telefone)
    }

    // Voltar à edição tem de reexibir o que foi salvo — sem isso, salvar de
    // novo apagaria os campos que a tela não recarregou.
    await page.goto(`/clientes/${customerId}/editar`)
    await waitForPageLoad(page)
    for (const c of CONTATOS) {
      await expect(page.getByLabel(`Nome do Contato de Emergência ${c.pos}`)).toHaveValue(c.nome)
      await expect(page.getByLabel(`Telefone do Contato de Emergência ${c.pos}`)).toHaveValue(c.telefone)
    }
  })
})
