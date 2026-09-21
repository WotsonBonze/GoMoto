/**
 * A lista "Fora do período — serão canceladas" do encerramento mostra só as
 * primeiras linhas e um botão "Exibir mais X cobranças" para o resto.
 *
 * Um contrato longo encerrado cedo cancela dezenas de parcelas; todas na tela
 * empurravam a decisão que importa (a distribuição de caução e crédito) para
 * muito longe. O total a cancelar segue inteiro na Apuração financeira.
 *
 * Só resume quando esconde AO MENOS DUAS linhas: um botão para revelar uma única
 * linha é pior do que mostrá-la. Por isso o limite de 5 vira "6 mostra todas" e
 * "7 esconde 2".
 */

import { test, expect, type Page } from '@playwright/test'
import {
  getSupabaseAdmin, getTestTenantId, waitForPageLoad,
  createTestVehicle, deleteTestVehicle, createTestCustomer, deleteTestCustomer,
} from './helpers'
import { generateSchedule } from '@gomoto/core'

const admin = () => getSupabaseAdmin()

const pad = (n: number): string => String(n).padStart(2, '0')
const dataLocal = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hoje = (): string => dataLocal(new Date())
const daquiA = (dias: number): string => dataLocal(new Date(Date.now() + dias * 864e5))

const criados = { rentals: [] as string[], vehicles: [] as string[], customers: [] as string[] }
let tenantId = ''

test.beforeAll(async () => { tenantId = await getTestTenantId() })

test.afterAll(async () => {
  for (const id of criados.rentals) {
    await admin().from('rental_billing_schedules').delete().eq('rental_id', id)
    await admin().from('rentals').delete().eq('id', id)
  }
  for (const id of criados.customers) await deleteTestCustomer(id).catch(() => {})
  for (const id of criados.vehicles) await deleteTestVehicle(id).catch(() => {})
})

function paramsDoContrato(fimEmDias: number) {
  return {
    start_date: hoje(), end_date: daquiA(fimEmDias),
    cycle: 'monthly' as const, due_day: 10, cycle_amount: 500, use_pro_rata: false,
  }
}

/** Quantas parcelas o contrato tem com período posterior a hoje — as que o encerramento de hoje cancela. */
function foraDoPeriodo(fimEmDias: number): number {
  return generateSchedule(paramsDoContrato(fimEmDias)).filter((l) => l.period_start > hoje()).length
}

/** O menor contrato (em dias) cujo encerramento de hoje cancela exatamente `n` parcelas. */
function fimComForaDoPeriodo(n: number): number {
  for (let dias = 30; dias <= 900; dias++) {
    if (foraDoPeriodo(dias) === n) return dias
  }
  throw new Error(`nenhum contrato de até 900 dias cancela exatamente ${n} parcelas`)
}

async function locacaoComCronograma(fimEmDias: number): Promise<string> {
  const veiculo = await createTestVehicle()
  criados.vehicles.push(veiculo.id)
  const cliente = await createTestCustomer()
  criados.customers.push(cliente.id)

  const params = paramsDoContrato(fimEmDias)
  const { data, error } = await admin().rpc('create_rental_with_schedule', {
    p_tenant_id: tenantId,
    p_rental: { customer_id: cliente.id, vehicle_id: veiculo.id, contract_type: 'rental', ...params },
    p_schedule: generateSchedule(params),
  })
  if (error) throw new Error(`Setup: create_rental_with_schedule — ${error.message}`)
  criados.rentals.push(data as string)
  return data as string
}

async function abrir(page: Page, rentalId: string) {
  await page.goto(`/locacoes/${rentalId}/encerrar`)
  await waitForPageLoad(page)
  const secao = page.locator('section', { has: page.getByRole('heading', { name: /Fora do período/ }) })
  await expect(secao).toBeVisible({ timeout: 20_000 })
  return { secao, linhas: secao.getByText('Será cancelada.') }
}

test.describe('Encerramento — lista "Fora do período"', () => {
  test('lista longa: mostra as 5 primeiras, "Exibir mais X cobranças" revela o resto e "Exibir menos" volta', async ({ page }) => {
    const fim = 400
    const total = foraDoPeriodo(fim)
    expect(total, 'o cenário precisa de uma lista longa').toBeGreaterThan(7)

    const { secao, linhas } = await abrir(page, await locacaoComCronograma(fim))

    await expect(linhas).toHaveCount(5)
    const mais = secao.getByRole('button', { name: `Exibir mais ${total - 5} cobranças` })
    await expect(mais).toBeVisible()
    await expect(mais).toHaveAttribute('aria-expanded', 'false')

    await mais.click()
    await expect(linhas).toHaveCount(total)
    const menos = secao.getByRole('button', { name: 'Exibir menos' })
    await expect(menos).toHaveAttribute('aria-expanded', 'true')

    await menos.click()
    await expect(linhas).toHaveCount(5)
    await expect(secao.getByRole('button', { name: `Exibir mais ${total - 5} cobranças` })).toBeVisible()
  })

  test('lista curta: mostra tudo e nem oferece o botão', async ({ page }) => {
    const { secao, linhas } = await abrir(page, await locacaoComCronograma(100))
    const total = foraDoPeriodo(100)
    expect(total).toBeGreaterThan(0)
    expect(total).toBeLessThanOrEqual(5)

    await expect(linhas).toHaveCount(total)
    await expect(secao.getByRole('button')).toHaveCount(0)
  })

  test('fronteira: 6 linhas aparecem todas (esconder 1 seria pior); 7 escondem 2', async ({ page }) => {
    const seis = await abrir(page, await locacaoComCronograma(fimComForaDoPeriodo(6)))
    await expect(seis.linhas).toHaveCount(6)
    await expect(seis.secao.getByRole('button')).toHaveCount(0)

    const sete = await abrir(page, await locacaoComCronograma(fimComForaDoPeriodo(7)))
    await expect(sete.linhas).toHaveCount(5)
    await expect(sete.secao.getByRole('button', { name: 'Exibir mais 2 cobranças' })).toBeVisible()
  })

  test('esconder linhas não esconde o total a cancelar: a Apuração segue inteira', async ({ page }) => {
    const fim = 400
    const total = foraDoPeriodo(fim)
    await abrir(page, await locacaoComCronograma(fim))

    // R$ 500 por parcela: a Apuração soma TODAS, não só as 5 visíveis.
    const valor = (total * 500).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    const linha = page.locator('div', { hasText: /^Parcelas ainda não emitidas a cancelar/ }).last()
    await expect(linha).toContainText(valor)
    await expect(page.getByText(`${total} parcelas`, { exact: true })).toBeVisible()
  })
})
