/**
 * Multa por rescisão antecipada de contrato (Spec 0015).
 *
 * Multa e prazo mínimo deixam de ser CONTRACT_TERMINATION_FINE_BRL/
 * RENTAL_MINIMUM_DURATION (constantes globais) e passam a ser configuráveis
 * por locação (`rentals.early_termination_fine_amount`/`minimum_term_days`).
 * O acerto (cobrança + abatimento de caução/crédito) entra DENTRO da RPC
 * `terminate_rental`, na mesma transação do encerramento — nada aqui passa
 * pelo browser: são as mesmas garantias de banco que `billings-rentals.spec.ts`
 * e `pagamento-despesa.spec.ts` testam chamando a RPC direto via service_role.
 */

import { test, expect } from '@playwright/test'
import {
  TEST_TAG, getSupabaseAdmin, getTestTenantId,
  createTestVehicle, createTestCustomer, deleteTestCustomer, deleteTestVehicle,
} from './helpers'
import { createCharge } from '../src/lib/financial/charges'
import { receivePayment } from '../src/lib/financial/payments'

const admin = () => getSupabaseAdmin()

function isoOffset(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const hoje = () => isoOffset(0)

let tenantId = ''

test.beforeAll(async () => {
  tenantId = await getTestTenantId()
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function criarLocacao(opts: {
  vehicleId: string
  customerId: string
  startDate?: string
  earlyTerminationFineAmount?: number | null
  minimumTermDays?: number | null
}): Promise<string> {
  const { data, error } = await admin().rpc('create_rental_with_schedule', {
    p_tenant_id: tenantId,
    p_rental: {
      customer_id: opts.customerId,
      vehicle_id: opts.vehicleId,
      contract_type: 'rental',
      start_date: opts.startDate ?? hoje(),
      end_date: isoOffset(365),
      cycle: 'monthly',
      due_day: 10,
      cycle_amount: 500,
      use_pro_rata: false,
      early_termination_fine_amount: opts.earlyTerminationFineAmount ?? null,
      minimum_term_days: opts.minimumTermDays ?? null,
    },
    p_schedule: [],
  })
  if (error) throw new Error(`Setup: criarLocacao falhou — ${error.message}`)
  return data as string
}

/**
 * Caução recebida pelo mesmo caminho do produto: cobrança emitida + PAGA de
 * verdade (`receivePayment` — `payments` + `payment_allocations`), não só um
 * lançamento manual no razão. Sem a alocação real, `charge_balances` continua
 * marcando a própria cobrança da caução como em aberto, e `terminate_rental`
 * recusa com `RENTAL_HAS_OPEN_CHARGES` antes de chegar na multa.
 */
async function criarCaucao(rentalId: string, customerId: string, vehicleId: string, amount: number): Promise<void> {
  const { chargeId } = await createCharge(admin(), tenantId, {
    customerId, rentalId, dueDate: hoje(),
    sourceModule: 'deposit', sourceId: crypto.randomUUID(),
    items: [{
      description: `${TEST_TAG} Caução`, credit_account_code: 'caucoes_a_devolver',
      quantity: 1, unit_amount: amount, amount, vehicle_id: vehicleId,
    }],
  })
  await admin().from('deposits').insert({
    tenant_id: tenantId, rental_id: rentalId, customer_id: customerId, amount, charge_id: chargeId,
  })
  await receivePayment(admin(), tenantId, {
    customerId, amount, method: 'pix', paidAt: new Date(),
    allocations: [{ chargeId, amount }],
  })
}

/** Crédito concedido ao cliente pelo mesmo caminho do produto (customer_credits + razão). */
async function concederCredito(customerId: string, amount: number): Promise<void> {
  const { data: linha, error: linhaErr } = await admin().from('customer_credits').insert({
    tenant_id: tenantId, customer_id: customerId, amount, origin: 'manual', reason: `${TEST_TAG} crédito de teste`,
  }).select('id').single()
  if (linhaErr) throw new Error(`Setup: concederCredito falhou — ${linhaErr.message}`)

  const { error } = await admin().rpc('post_financial_transaction', {
    p_tenant_id: tenantId,
    p_transaction: {
      event_type: 'credit_granted', description: `${TEST_TAG} crédito de teste`,
      source_module: 'customer_credit', source_id: (linha as { id: string }).id,
    },
    p_entries: [
      { account_code: 'despesa_operacional', direction: 'debit',  amount, customer_id: customerId },
      { account_code: 'creditos_de_clientes', direction: 'credit', amount, customer_id: customerId },
    ],
  })
  if (error) throw new Error(`Setup: concederCredito falhou ao lançar — ${error.message}`)
}

type EncerrarParams = {
  rentalId: string
  terminationDate?: string
  chargeFine?: boolean
  fineDepositAmount?: number
  fineCreditAmount?: number
  force?: boolean
}

async function encerrar(p: EncerrarParams) {
  return admin().rpc('terminate_rental', {
    p_tenant_id: tenantId,
    p_rental_id: p.rentalId,
    p_termination_date: p.terminationDate ?? hoje(),
    p_new_status: 'closed',
    p_force: p.force ?? false,
    p_km_final: 0,
    p_charge_fine: p.chargeFine ?? false,
    p_fine_deposit_amount: p.fineDepositAmount ?? 0,
    p_fine_credit_amount: p.fineCreditAmount ?? 0,
  })
}

async function depositoSaldo(rentalId: string): Promise<number> {
  const { data } = await admin().from('deposit_balances').select('balance').eq('rental_id', rentalId).maybeSingle()
  return Number((data as { balance: number } | null)?.balance ?? 0)
}

async function creditoSaldo(customerId: string): Promise<number> {
  const { data } = await admin().from('customer_credit_balances').select('balance').eq('customer_id', customerId).maybeSingle()
  return Number((data as { balance: number } | null)?.balance ?? 0)
}

async function cobrancaSaldo(chargeId: string) {
  const { data } = await admin().from('charge_balances').select('open_amount, paid_amount, status').eq('charge_id', chargeId).maybeSingle()
  return data as { open_amount: number; paid_amount: number; status: string } | null
}

// ---------------------------------------------------------------------------
// Suíte
// ---------------------------------------------------------------------------

test.describe('Multa por rescisão antecipada (Spec 0015)', () => {
  let vehicleId = ''
  let customerId = ''
  const rentalIds: string[] = []

  test.beforeEach(async () => {
    vehicleId = (await createTestVehicle()).id
    customerId = (await createTestCustomer()).id
  })

  test.afterEach(async () => {
    for (const id of rentalIds.splice(0)) {
      await admin().from('deposits').delete().eq('rental_id', id)
      await admin().from('rental_billing_schedules').delete().eq('rental_id', id)
      await admin().from('rentals').delete().eq('id', id)
    }
    await deleteTestCustomer(customerId).catch(() => {})
    await deleteTestVehicle(vehicleId).catch(() => {})
  })

  test('cobra a multa dentro do prazo mínimo e abate integralmente da caução (CA-001/005/008/009/010)', async () => {
    const rentalId = await criarLocacao({
      vehicleId, customerId, earlyTerminationFineAmount: 1000, minimumTermDays: 90,
    })
    rentalIds.push(rentalId)
    await criarCaucao(rentalId, customerId, vehicleId, 1500)

    const { data, error } = await encerrar({
      rentalId, chargeFine: true, fineDepositAmount: 1000, fineCreditAmount: 0,
    })
    expect(error).toBeNull()

    const settlement = data as {
      fine_eligible: boolean; fine_charged: boolean; fine_amount: number
      fine_deposit_amount: number; fine_charge_id: string
    }
    expect(settlement.fine_eligible).toBe(true)
    expect(settlement.fine_charged).toBe(true)
    expect(settlement.fine_amount).toBe(1000)
    expect(settlement.fine_deposit_amount).toBe(1000)

    const saldoCobrancaMulta = await cobrancaSaldo(settlement.fine_charge_id)
    expect(saldoCobrancaMulta?.open_amount).toBe(0)
    expect(saldoCobrancaMulta?.paid_amount).toBe(1000)

    expect(await depositoSaldo(rentalId)).toBe(500) // 1500 - 1000

    const { data: rental } = await admin().from('rentals').select('status').eq('id', rentalId).single()
    expect((rental as { status: string }).status).toBe('closed')

    // RN-008 (auditoria da decisão) não é coberta aqui: este spec chama a RPC
    // `terminate_rental` direto via service_role, mas o `logAction(newData:
    // fine_decision)` mora na Server Action `terminateRental` (actions.ts),
    // uma camada acima da RPC. Provar RN-008 de ponta a ponta exige um teste
    // de browser passando pela Server Action de verdade — fora do escopo
    // desta suíte, que testa a garantia de banco (ver cabeçalho do arquivo).
  })

  test('locação sem multa configurada — encerramento não cobra nada (RN-003)', async () => {
    const rentalId = await criarLocacao({ vehicleId, customerId })
    rentalIds.push(rentalId)

    const { data, error } = await encerrar({ rentalId, chargeFine: false })
    expect(error).toBeNull()
    const settlement = data as { fine_eligible: boolean; fine_charged: boolean; fine_amount: number }
    expect(settlement.fine_eligible).toBe(false)
    expect(settlement.fine_amount).toBe(0)
  })

  test('fora do prazo mínimo — nenhuma multa, mesmo com config (CA-006)', async () => {
    const rentalId = await criarLocacao({
      vehicleId, customerId,
      startDate: isoOffset(-100),
      earlyTerminationFineAmount: 1000,
      minimumTermDays: 90,
    })
    rentalIds.push(rentalId)

    const { data, error } = await encerrar({ rentalId, chargeFine: false })
    expect(error).toBeNull()
    expect((data as { fine_eligible: boolean }).fine_eligible).toBe(false)

    const { error: recusado } = await encerrar({ rentalId: rentalId, chargeFine: true })
    // A locação já fechou na chamada acima — RENTAL_NOT_ACTIVE é o esperado
    // aqui; o caso "config existe mas fora do prazo" já ficou provado por
    // fine_eligible=false logo acima.
    expect(recusado?.message ?? '').toContain('RENTAL_NOT_ACTIVE')
  })

  test('operador decide não cobrar a multa exibida (CA-007)', async () => {
    const rentalId = await criarLocacao({
      vehicleId, customerId, earlyTerminationFineAmount: 1000, minimumTermDays: 90,
    })
    rentalIds.push(rentalId)

    const { data, error } = await encerrar({ rentalId, chargeFine: false })
    expect(error).toBeNull()
    const settlement = data as { fine_eligible: boolean; fine_charged: boolean }
    expect(settlement.fine_eligible).toBe(true)
    expect(settlement.fine_charged).toBe(false)

    const { data: charges } = await admin().from('charges').select('id').eq('rental_id', rentalId).eq('source_module', 'early_termination_fine')
    expect(charges ?? []).toHaveLength(0)
  })

  test('quitação combinada: parte caução, parte crédito, resto vira cobrança em aberto (CA-011/012, RN-005)', async () => {
    const rentalId = await criarLocacao({
      vehicleId, customerId, earlyTerminationFineAmount: 1000, minimumTermDays: 90,
    })
    rentalIds.push(rentalId)
    await criarCaucao(rentalId, customerId, vehicleId, 400)
    await concederCredito(customerId, 300)

    const { data, error } = await encerrar({
      rentalId, chargeFine: true, fineDepositAmount: 400, fineCreditAmount: 300,
    })
    expect(error).toBeNull()
    const settlement = data as { fine_amount: number; fine_charge_id: string }
    expect(settlement.fine_amount).toBe(1000)

    const saldoCobrancaMulta = await cobrancaSaldo(settlement.fine_charge_id)
    // 1000 - 400 (caução) - 300 (crédito) = 300 em aberto
    expect(saldoCobrancaMulta?.open_amount).toBe(300)
    expect(saldoCobrancaMulta?.status).toBe('open')

    expect(await depositoSaldo(rentalId)).toBe(0)
    expect(await creditoSaldo(customerId)).toBe(0)
  })

  test('soma dos abatimentos maior que a multa é recusada (RN-006)', async () => {
    const rentalId = await criarLocacao({
      vehicleId, customerId, earlyTerminationFineAmount: 500, minimumTermDays: 90,
    })
    rentalIds.push(rentalId)
    await criarCaucao(rentalId, customerId, vehicleId, 1000)

    const { error } = await encerrar({
      rentalId, chargeFine: true, fineDepositAmount: 600, fineCreditAmount: 0,
    })
    expect(error?.message ?? '').toContain('FINE_ALLOCATION_EXCEEDS_TOTAL')

    // Nada foi commitado — a locação continua ativa (RN-009).
    const { data: rental } = await admin().from('rentals').select('status').eq('id', rentalId).single()
    expect((rental as { status: string }).status).toBe('active')
  })

  test('cobrar multa não elegível (config obsoleta) é recusado sem deixar estado ambíguo (RN-002, RN-009)', async () => {
    const rentalId = await criarLocacao({ vehicleId, customerId }) // sem config
    rentalIds.push(rentalId)

    const { error } = await encerrar({ rentalId, chargeFine: true })
    expect(error?.message ?? '').toContain('FINE_NOT_APPLICABLE')

    const { data: rental } = await admin().from('rentals').select('status').eq('id', rentalId).single()
    expect((rental as { status: string }).status).toBe('active')

    const { data: charges } = await admin().from('charges').select('id').eq('rental_id', rentalId).eq('source_module', 'early_termination_fine')
    expect(charges ?? []).toHaveLength(0)
  })

  test('duas chamadas concorrentes de terminate_rental — só uma é aceita (RN-010)', async () => {
    const rentalId = await criarLocacao({ vehicleId, customerId })
    rentalIds.push(rentalId)

    const resultados = await Promise.allSettled([
      encerrar({ rentalId }),
      encerrar({ rentalId }),
    ])

    const semErro = resultados.filter((r) => r.status === 'fulfilled' && !(r.value as { error: unknown }).error)
    expect(semErro, 'apenas uma das duas chamadas concorrentes pode ter sucesso').toHaveLength(1)

    const { data: rental } = await admin().from('rentals').select('status').eq('id', rentalId).single()
    expect((rental as { status: string }).status).toBe('closed')
  })
})
