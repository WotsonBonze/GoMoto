/**
 * Devolução de crédito ao cliente — a segunda forma de quitar o passivo.
 *
 * Crédito é dívida da empresa com o cliente. Existiam duas saídas e só uma
 * estava construída: abater em cobrança futura. Enquanto o contrato vive isso
 * basta; encerrado, não há cobrança para abater e o cliente ia embora credor
 * com o passivo pendurado no balanço.
 *
 * A improvisação natural — "estornar o crédito" — corrompe o dado. Estorno
 * desfaz o que não deveria ter acontecido; o crédito aconteceu e era devido.
 * Inverter `credit_granted` apagaria também a despesa do serviço e a
 * recuperação da parte do cliente: a moto passaria a constar com custo zero.
 *
 * Devolver é `credit_settled`: passivo baixado contra o CAIXA, exatamente como
 * `deposit_returned`. O lançamento de origem permanece intacto — e é isso que
 * se prova aqui.
 */

import { test, expect } from '@playwright/test'
import {
  TEST_TAG, getSupabaseAdmin, getTestTenantId,
  createTestVehicle, deleteTestVehicle, createTestContract, deleteTestCustomer,
} from './helpers'
import { getCreditBalance, settleCredit } from '../src/lib/financial/credits'
import { registerCost } from '../src/lib/financial/maintenance-cost'

const admin = () => getSupabaseAdmin()
const hoje = () => new Date().toISOString().slice(0, 10)

let tenantId = ''
let vehicleId = ''
let customerId = ''
let rentalId = ''

/** Soma líquida de uma conta para este cliente — o que o razão enxerga. */
async function conta(code: string): Promise<number> {
  const { data } = await admin()
    .from('financial_entries')
    .select('amount_signed')
    .eq('account_code', code)
    .eq('customer_id', customerId)
  return ((data ?? []) as { amount_signed: number }[])
    .reduce((s, e) => s + Number(e.amount_signed), 0)
}

/** Manutenção paga pelo cliente, rateada — gera crédito da parte da empresa. */
async function gerarCredito(custo: number, parteDoCliente: number) {
  const { data: m, error } = await admin()
    .from('maintenances')
    .insert({
      tenant_id: tenantId, vehicle_id: vehicleId, type: 'corrective',
      description: `${TEST_TAG} Serviço ${custo}`, scheduled_date: hoje(),
    })
    .select('id').single()
  if (error) throw new Error(`manutenção: ${error.message}`)

  const r = await registerCost(admin(), tenantId, null, {
    maintenance_id: (m as { id: string }).id,
    amount: custo,
    customer_amount: parteDoCliente,
    executor: 'customer',
    due_date: hoje(),
  })
  if (!r.ok) throw new Error(`custo: ${r.error.message}`)
}

test.beforeAll(async () => {
  tenantId = await getTestTenantId()
  const v = await createTestVehicle()
  vehicleId = v.id
  const c = await createTestContract(vehicleId)
  customerId = c.customerId
  rentalId = c.contractId
  void rentalId
})

test.afterAll(async () => {
  await deleteTestCustomer(customerId)
  await deleteTestVehicle(vehicleId)
})

test.describe('Devolver crédito em dinheiro', () => {
  test('baixa o passivo contra o CAIXA e preserva o custo do serviço', async () => {
    await gerarCredito(100, 50)

    expect(await getCreditBalance(admin(), tenantId, customerId)).toBe(50)
    const despesaAntes = await conta('despesa_manutencao')
    const repasseAntes = await conta('repasse_manutencao')

    const r = await settleCredit(admin(), tenantId, {
      customerId, amount: 50, notes: 'PIX de teste',
    })
    expect(r.ok, r.ok ? '' : r.message).toBe(true)

    expect(await getCreditBalance(admin(), tenantId, customerId), 'o passivo não zerou').toBe(0)

    // A prova de que NÃO é estorno: o custo do serviço continua de pé.
    expect(await conta('despesa_manutencao'), 'a devolução apagou a despesa').toBe(despesaAntes)
    expect(await conta('repasse_manutencao'), 'a devolução apagou a recuperação').toBe(repasseAntes)

    // E o dinheiro saiu do caixa, não do recebível.
    const { data: pernas } = await admin()
      .from('financial_entries')
      .select('account_code, amount_signed, financial_transactions!inner(event_type)')
      .eq('customer_id', customerId)
      .eq('financial_transactions.event_type', 'credit_settled')

    const linhas = (pernas ?? []) as { account_code: string; amount_signed: number }[]
    expect(linhas).toHaveLength(2)
    expect(linhas.find((l) => l.account_code === 'caixa_e_bancos')?.amount_signed).toBe(-50)
    expect(linhas.find((l) => l.account_code === 'creditos_de_clientes')?.amount_signed).toBe(50)
    expect(linhas.some((l) => l.account_code === 'contas_a_receber'), 'mexeu no recebível').toBe(false)
  })

  test('não devolve mais do que o saldo', async () => {
    await gerarCredito(200, 0)   // crédito de 200
    const saldo = await getCreditBalance(admin(), tenantId, customerId)

    const r = await settleCredit(admin(), tenantId, { customerId, amount: saldo + 0.01 })
    expect(r.ok, 'devolveu mais do que devia').toBe(false)
    expect(r.ok === false && r.code).toBe('CONFLICT')

    expect(await getCreditBalance(admin(), tenantId, customerId)).toBe(saldo)
  })

  test('devolução parcial deixa o resto disponível', async () => {
    const saldo = await getCreditBalance(admin(), tenantId, customerId)
    expect(saldo).toBeGreaterThan(60)

    await settleCredit(admin(), tenantId, { customerId, amount: 60 })
    expect(await getCreditBalance(admin(), tenantId, customerId)).toBe(saldo - 60)
  })

  test('duas devoluções SIMULTÂNEAS não pagam duas vezes', async () => {
    // O saldo é derivado do razão — não há linha para travar. Sem a trava do
    // cliente, as duas chamadas leem o mesmo saldo e as duas pagam.
    const saldo = await getCreditBalance(admin(), tenantId, customerId)
    expect(saldo).toBeGreaterThan(0)

    const resultados = await Promise.allSettled([
      settleCredit(admin(), tenantId, { customerId, amount: saldo }),
      settleCredit(admin(), tenantId, { customerId, amount: saldo }),
    ])

    const aceitas = resultados.filter(
      (r) => r.status === 'fulfilled' && r.value.ok,
    ).length

    expect(aceitas, 'as duas devoluções concorrentes passaram').toBe(1)
    const depois = await getCreditBalance(admin(), tenantId, customerId)
    expect(depois, `saldo ficou ${depois} — a empresa devolveu a mais`).toBe(0)
  })

  test('valor zero ou negativo é recusado', async () => {
    for (const v of [0, -10]) {
      const r = await settleCredit(admin(), tenantId, { customerId, amount: v })
      expect(r.ok, `aceitou devolver ${v}`).toBe(false)
    }
  })

  test('sem saldo não há o que devolver', async () => {
    expect(await getCreditBalance(admin(), tenantId, customerId)).toBe(0)
    const r = await settleCredit(admin(), tenantId, { customerId, amount: 10 })
    expect(r.ok).toBe(false)
  })
})

test.describe('Encerramento apura o crédito', () => {
  test('a apuração informa o saldo de crédito do cliente', async () => {
    // Antes, `terminate_rental` só olhava caução e cobranças em aberto. O
    // crédito ficava invisível e o cliente ia embora credor.
    const v = await createTestVehicle()
    const c = await createTestContract(v.id)

    const { data: m } = await admin()
      .from('maintenances')
      .insert({
        tenant_id: tenantId, vehicle_id: v.id, type: 'corrective',
        description: `${TEST_TAG} Serviço no encerramento`, scheduled_date: hoje(),
      })
      .select('id').single()

    await registerCost(admin(), tenantId, null, {
      maintenance_id: (m as { id: string }).id,
      amount: 80, customer_amount: 0, executor: 'customer', due_date: hoje(),
    })

    const { data: apuracao, error } = await admin().rpc('terminate_rental', {
      p_tenant_id: tenantId,
      p_rental_id: c.contractId,
      p_termination_date: hoje(),
      p_new_status: 'closed',
      p_force: true,
      p_km_final: 0,
    })
    expect(error, error?.message).toBeNull()

    const a = apuracao as { credit_balance: number; requires_settlement: boolean; customer_id: string }
    expect(a.credit_balance, 'o crédito não apareceu na apuração').toBe(80)
    expect(a.requires_settlement, 'encerrou sem sinalizar que há dinheiro a resolver').toBe(true)
    expect(a.customer_id).toBe(c.customerId)

    await deleteTestCustomer(c.customerId).catch(() => {})
    await deleteTestVehicle(v.id).catch(() => {})
  })
})
