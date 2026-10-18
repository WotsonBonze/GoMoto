import { test, expect } from '@playwright/test'
import {
  TEST_TAG, getSupabaseAdmin, getTestTenantId, waitForPageLoad,
  createTestVehicle, createTestContract, deleteTestCustomer, getModal,
} from './helpers'
import { createCharge } from '../src/lib/financial/charges'

/**
 * Fração de centavo não pode virar dívida negativa.
 *
 * O campo de recebimento aceitava "446,83000000000000999999" e, pior, 446,836
 * numa cobrança de R$ 446,83: `type="number"` com `step="0.01"` só é validado
 * em submit de formulário NATIVO, que a tela não usa. O valor chegava inteiro
 * ao banco, `NUMERIC(14,2)` arredondava para 446,84, e a cobrança terminava com
 * `open_amount = -0,01` — paga a mais, sem ninguém ter recusado nada.
 */

const admin = () => getSupabaseAdmin()

let tenantId: string
let customerId: string
let rentalId: string
let vehicleId: string

test.beforeAll(async () => {
  tenantId = await getTestTenantId()
  const v = await createTestVehicle()
  vehicleId = v.id
  const contrato = await createTestContract(vehicleId)
  customerId = contrato.customerId
  rentalId = contrato.contractId
})

test.afterAll(async () => {
  await admin().from('rentals').delete().eq('id', rentalId)
  await deleteTestCustomer(customerId).catch(() => {})
  await admin().from('vehicles').delete().eq('id', vehicleId)
})

async function cobrancaDe(valor: number, marca: string) {
  const { chargeId } = await createCharge(admin(), tenantId, {
    customerId, rentalId,
    dueDate: new Date().toISOString().slice(0, 10),
    sourceModule: 'manual', sourceId: crypto.randomUUID(),
    items: [{
      description: marca, credit_account_code: 'receita_locacao',
      quantity: 1, unit_amount: valor, amount: valor,
    }],
  })
  return chargeId
}

test.describe('Fração de centavo', () => {
  test('o banco recusa alocar mais do que a cobrança vale', async () => {
    // A trava da tela é a primeira porta; esta é a fechadura. Sem ela, qualquer
    // caminho que não passe pelo modal — script, importação, integração futura
    // — deixa a cobrança negativa.
    const chargeId = await cobrancaDe(446.83, `${TEST_TAG} Fracao ${Date.now().toString(36)}`)

    const { data: pag } = await admin()
      .from('payments')
      .insert({
        tenant_id: tenantId, customer_id: customerId,
        amount: 446.836, method: 'cash', paid_at: new Date().toISOString(),
      })
      .select('id').single()

    const paymentId = (pag as { id: string }).id

    const { error } = await admin()
      .from('payment_allocations')
      .insert({ tenant_id: tenantId, payment_id: paymentId, charge_id: chargeId, amount: 446.836 })

    expect(error, 'alocar 446,836 numa cobrança de 446,83 tem que falhar').not.toBeNull()
    expect(error!.message).toContain('excedem o valor devido')

    // E o saldo continua intacto: a recusa é antes da escrita, não depois.
    const { data: bal } = await admin()
      .from('charge_balances')
      .select('paid_amount, open_amount, status')
      .eq('charge_id', chargeId).single()

    const b = bal as { paid_amount: number; open_amount: number; status: string }
    expect(Number(b.paid_amount)).toBe(0)
    expect(Number(b.open_amount)).toBe(446.83)

    // O pagamento fica sem alocação de propósito — é o que o teste prova. Mas
    // ele é, literalmente, dinheiro recebido que não quitou nada: a view
    // `financial_reconciliation` (ADR 0034) o acusa, com razão, e a tela de
    // diagnóstico passaria a mostrar um problema falso em todo banco de
    // desenvolvimento. Some com ele aqui, onde ele já cumpriu o papel.
    await admin().from('payments').delete().eq('id', paymentId)
  })

  test('o campo de recebimento não aceita mais de duas casas', async ({ page }) => {
    const marca = `${TEST_TAG} Casas ${Date.now().toString(36)}`
    await cobrancaDe(446.83, marca)

    await page.goto('/cobrancas')
    await waitForPageLoad(page)
    await page.getByPlaceholder(/cliente, placa ou número/i).fill(marca)

    const linha = page.locator('tr', { hasText: marca }).first()
    await expect(linha).toBeVisible({ timeout: 10_000 })
    await linha.getByTitle(/registrar pagamento/i).click()

    const modal = getModal(page)
    await expect(modal).toBeVisible()

    const campo = modal.locator('input[type="number"]')
    await expect(campo, 'nasce com o valor devido, limpo').toHaveValue('446.83')

    // Digitar casas demais: o campo corta na segunda.
    await campo.fill('')
    await campo.type('446,83000000000000999999')
    const digitado = await campo.inputValue()
    expect(digitado, `campo aceitou "${digitado}"`).toMatch(/^\d+([.,]\d{0,2})?$/)

    // E fração de centavo acima do devido continua sendo recusada. O input
    // `type="number"` normaliza a vírgula para ponto — o valor final é
    // "446.83", não "446,83".
    await campo.fill('')
    await campo.type('446,836')
    expect(await campo.inputValue(), 'a terceira casa não pode entrar').toBe('446.83')
  })
})
