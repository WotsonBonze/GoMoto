/**
 * Encerramento retroativo decide o que fazer com cada cobrança (Spec 0016,
 * revisão de 2026-09-17).
 *
 * Fora do período (depois da data de encerramento) é SEMPRE cancelada, sem
 * escolha do operador — emitida ou ainda não. Dentro do período é mantida por
 * padrão, com opção de o operador marcar para cancelar mesmo assim. A
 * classificação (`planRetroactiveTermination`) já é coberta em unit tests
 * (`packages/core/src/rules/schedule.spec.ts`). Este spec fixa o CONTRATO de
 * banco que a Server Action orquesta: `cancelCharge` reverte a emissão e
 * recusa cobrança com pagamento ou crédito alocado (RN-001), e `terminate_rental`
 * sincroniza a linha do cronograma da cobrança cancelada e aceita cancelar
 * linha ainda não emitida dentro do período por opção — nada aqui passa pelo
 * browser, mesma abordagem de `multa-rescisao-antecipada.spec.ts` e
 * `ajuste-de-periodo.spec.ts` (o alvo é a RPC, não a RLS).
 */

import { test, expect } from '@playwright/test'
import {
  TEST_TAG, getSupabaseAdmin, getTestTenantId,
  createTestVehicle, deleteTestVehicle, createTestCustomer, deleteTestCustomer,
} from './helpers'
import { generateSchedule, planRetroactiveTermination, type TerminationChargeInfo } from '@gomoto/core'
import { cancelCharge } from '../src/lib/financial/charges'
import { receivePayment } from '../src/lib/financial/payments'

const admin = () => getSupabaseAdmin()

function isoOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

const PARAMS = {
  start_date:   isoOffset(-140),
  end_date:     isoOffset(140),
  cycle:        'monthly' as const,
  due_day:      10,
  cycle_amount: 500,
  use_pro_rata: false,
}

let tenantId = ''
let customerId = ''
let adjustedBy = ''
const rentaisCriadas: string[] = []
const veiculosCriados: string[] = []

async function membroDoTenant(): Promise<string> {
  const { data } = await admin()
    .from('tenant_members')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .limit(1).single()
  return (data as { user_id: string }).user_id
}

/** Um veículo por locação: o banco recusa duas ativas na mesma moto (ADR 0036). */
async function criarLocacao(overrides: Partial<typeof PARAMS> = {}): Promise<string> {
  const params = { ...PARAMS, ...overrides }
  const veiculo = await createTestVehicle()
  veiculosCriados.push(veiculo.id)
  const { data, error } = await admin().rpc('create_rental_with_schedule', {
    p_tenant_id: tenantId,
    p_rental: { customer_id: customerId, vehicle_id: veiculo.id, contract_type: 'rental', ...params },
    p_schedule: generateSchedule(params),
  })
  if (error) throw new Error(`Setup: criarLocacao falhou — ${error.message}`)
  const id = data as string
  rentaisCriadas.push(id)
  return id
}

async function emitir(): Promise<void> {
  const { error } = await admin().rpc('fn_issue_charges_for_tenant', { p_tenant_id: tenantId, p_lead_days: 0 })
  if (error) throw new Error(`fn_issue_charges_for_tenant: ${error.message}`)
}

async function cronograma(rentalId: string) {
  const { data } = await admin()
    .from('rental_billing_schedules')
    .select('id, sequence_number, period_start, period_end, due_date, amount, status')
    .eq('rental_id', rentalId)
    .order('period_start')
  return (data ?? []) as Array<{
    id: string; sequence_number: number; period_start: string; period_end: string
    due_date: string; amount: number; status: 'scheduled' | 'issued' | 'cancelled' | 'superseded'
  }>
}

async function cobrancasDaLocacao(rentalId: string) {
  const { data } = await admin()
    .from('charges')
    .select('id, source_id, charge_number, due_date, status')
    .eq('rental_id', rentalId)
    .eq('source_module', 'rental')
  return (data ?? []) as Array<{
    id: string; source_id: string; charge_number: number; due_date: string
    status: 'open' | 'paid' | 'cancelled' | 'written_off'
  }>
}

async function cobrancaSaldo(chargeId: string) {
  const { data } = await admin()
    .from('charge_balances')
    .select('open_amount, paid_amount, status')
    .eq('charge_id', chargeId)
    .maybeSingle()
  return data as { open_amount: number; paid_amount: number; status: string } | null
}

/** Soma do que a RPC `terminate_rental` lê para apurar e para travar (RENTAL_HAS_OPEN_CHARGES). */
async function somaAberto(rentalId: string): Promise<number> {
  const { data } = await admin()
    .from('charge_balances')
    .select('open_amount')
    .eq('rental_id', rentalId)
    .eq('status', 'open')
  return ((data ?? []) as Array<{ open_amount: number }>).reduce((s, r) => s + Number(r.open_amount), 0)
}

/** Monta o plano a partir do estado REAL do banco — mesma fonte que a tela e a Action usam. */
async function planejarEncerramento(rentalId: string, terminationDate: string) {
  const linhas = await cronograma(rentalId)
  const cobrancas = await cobrancasDaLocacao(rentalId)

  const { data: saldos } = await admin()
    .from('charge_balances')
    .select('charge_id, total_amount, paid_amount, is_overdue')
    .eq('rental_id', rentalId)
  const porId = new Map(((saldos ?? []) as Array<{ charge_id: string; total_amount: number; paid_amount: number; is_overdue: boolean }>)
    .map((b) => [b.charge_id, b]))

  const charges: TerminationChargeInfo[] = cobrancas.map((c) => {
    const balance = porId.get(c.id)
    return {
      schedule_line_id: c.source_id,
      charge_id:        c.id,
      charge_number:    c.charge_number,
      due_date:         c.due_date,
      total_amount:     Number(balance?.total_amount ?? 0),
      paid_amount:      Number(balance?.paid_amount ?? 0),
      status:           c.status,
      is_overdue:       Boolean(balance?.is_overdue ?? false),
    }
  })

  return planRetroactiveTermination(linhas, charges, terminationDate)
}

type EncerrarParams = {
  rentalId: string
  terminationDate: string
  force?: boolean
  extraScheduleLineIds?: string[]
}

async function encerrar(p: EncerrarParams) {
  return admin().rpc('terminate_rental', {
    p_tenant_id:        tenantId,
    p_rental_id:        p.rentalId,
    p_termination_date: p.terminationDate,
    p_new_status:       'closed',
    p_force:            p.force ?? false,
    p_km_final:         0,
    p_charge_fine:      false,
    p_extra_schedule_line_ids_to_cancel: p.extraScheduleLineIds ?? null,
  })
}

test.describe('Encerramento retroativo decide o que fazer com cada cobrança (Spec 0016, revisão)', () => {
  test.beforeAll(async () => {
    tenantId = await getTestTenantId()
    customerId = (await createTestCustomer()).id
    adjustedBy = await membroDoTenant()
  })

  test.afterAll(async () => {
    for (const id of rentaisCriadas) {
      await admin().from('rental_billing_schedules').delete().eq('rental_id', id)
      await admin().from('rentals').delete().eq('id', id)
    }
    await deleteTestCustomer(customerId).catch(() => {})
    for (const id of veiculosCriados) await deleteTestVehicle(id).catch(() => {})
  })

  test('fora do período: cobrança emitida elegível é sempre cancelada, sem marcação alguma (RN-002)', async () => {
    const rentalId = await criarLocacao()
    await emitir()

    const linhas = (await cronograma(rentalId))
      .filter((l) => l.status === 'issued')
      .sort((a, b) => a.period_start.localeCompare(b.period_start))
    expect(linhas.length).toBeGreaterThanOrEqual(2)

    const terminationDate = linhas[0]!.period_start
    const plano = await planejarEncerramento(rentalId, terminationDate)

    // A 1ª linha COMEÇA na data — dentro do período. As demais, fora.
    const foraAuto = plano.filter((l) => l.action === 'cancel_auto')
    expect(foraAuto.length).toBeGreaterThanOrEqual(1)
    expect(foraAuto.every((l) => l.is_outside_period)).toBe(true)

    const alvo = foraAuto.find((l) => l.is_issued)!
    const somaAntes = await somaAberto(rentalId)

    // A Action cancela toda `cancel_auto` sem nenhuma marcação do operador.
    await cancelCharge(admin(), tenantId, alvo.charge_id!, `${TEST_TAG} encerramento retroativo do contrato`, adjustedBy)

    const saldoAlvo = await cobrancaSaldo(alvo.charge_id!)
    expect(saldoAlvo?.status).toBe('cancelled')

    const somaDepois = await somaAberto(rentalId)
    expect(Math.round((somaAntes - somaDepois) * 100) / 100).toBe(alvo.total_amount)

    const { data: settlement, error } = await encerrar({ rentalId, terminationDate, force: true })
    expect(error).toBeNull()
    expect(Number((settlement as { open_amount: number }).open_amount)).toBe(somaDepois)

    // A linha do cronograma da cobrança cancelada acompanha.
    const linhaAlvo = (await cronograma(rentalId)).find((l) => l.id === alvo.schedule_line_id)
    expect(linhaAlvo?.status).toBe('cancelled')
  })

  test('fora do período: linha ainda não emitida é cancelada pela própria RPC, sem passar por cancelCharge', async () => {
    const rentalId = await criarLocacao()
    await emitir()

    const linhas = await cronograma(rentalId)
    const emitidas = linhas.filter((l) => l.status === 'issued').sort((a, b) => a.period_start.localeCompare(b.period_start))
    const terminationDate = emitidas[0]!.period_start

    const planejadaFora = linhas.find((l) => l.status === 'scheduled' && l.period_start > terminationDate)!

    const { error } = await encerrar({ rentalId, terminationDate, force: true })
    expect(error).toBeNull()

    const linhaDepois = (await cronograma(rentalId)).find((l) => l.id === planejadaFora.id)
    expect(linhaDepois?.status).toBe('cancelled')
  })

  test('fora do período: cobrança com pagamento alocado fica bloqueada, não é cancelada automaticamente (RN-001/RF-003)', async () => {
    const rentalId = await criarLocacao()
    await emitir()

    const linhas = (await cronograma(rentalId))
      .filter((l) => l.status === 'issued')
      .sort((a, b) => a.period_start.localeCompare(b.period_start))
    const terminationDate = linhas[0]!.period_start
    const plano = await planejarEncerramento(rentalId, terminationDate)
    const alvo = plano.find((l) => l.is_outside_period && l.is_issued)!

    await receivePayment(admin(), tenantId, {
      customerId, amount: alvo.total_amount, method: 'pix', paidAt: new Date(),
      allocations: [{ chargeId: alvo.charge_id!, amount: alvo.total_amount }],
    })

    const planoDepois = await planejarEncerramento(rentalId, terminationDate)
    const alvoDepois = planoDepois.find((l) => l.charge_id === alvo.charge_id)!
    expect(alvoDepois.action).toBe('blocked')

    await expect(
      cancelCharge(admin(), tenantId, alvo.charge_id!, `${TEST_TAG} tentativa indevida`, adjustedBy),
    ).rejects.toThrow(/pagamento alocado/)
  })

  test('dentro do período: cobrança emitida elegível é mantida por padrão — nada é cancelado sem marcação (RF-002)', async () => {
    const rentalId = await criarLocacao()
    await emitir()

    const linhas = (await cronograma(rentalId))
      .filter((l) => l.status === 'issued')
      .sort((a, b) => a.period_start.localeCompare(b.period_start))
    const terminationDate = linhas[linhas.length - 1]!.period_start // encerra no início da ÚLTIMA emitida
    const plano = await planejarEncerramento(rentalId, terminationDate)

    const dentroOpcional = plano.filter((l) => !l.is_outside_period && l.action === 'keep_optional')
    expect(dentroOpcional.length).toBeGreaterThanOrEqual(1)

    const { error } = await encerrar({ rentalId, terminationDate, force: true })
    expect(error).toBeNull()

    for (const l of dentroOpcional) {
      const saldo = l.charge_id ? await cobrancaSaldo(l.charge_id) : null
      if (saldo) expect(saldo.status).toBe('open') // ninguém marcou — continua exatamente como estava
      const linhaDepois = (await cronograma(rentalId)).find((x) => x.id === l.schedule_line_id)
      expect(linhaDepois?.status).toBe(l.is_issued ? 'issued' : 'scheduled')
    }
  })

  test('dentro do período: cobrança emitida marcada por opção é cancelada, e a linha acompanha (capacidade nova)', async () => {
    const rentalId = await criarLocacao()
    await emitir()

    const linhas = (await cronograma(rentalId))
      .filter((l) => l.status === 'issued')
      .sort((a, b) => a.period_start.localeCompare(b.period_start))
    const terminationDate = linhas[linhas.length - 1]!.period_start
    const plano = await planejarEncerramento(rentalId, terminationDate)
    const alvo = plano.find((l) => !l.is_outside_period && l.action === 'keep_optional' && l.is_issued)!

    // A Action cancela o extra ANTES da RPC, exatamente como faria com o auto.
    await cancelCharge(admin(), tenantId, alvo.charge_id!, `${TEST_TAG} cancelamento opcional dentro do período`, adjustedBy)

    const { error } = await encerrar({ rentalId, terminationDate, force: true })
    expect(error).toBeNull()

    const saldoAlvo = await cobrancaSaldo(alvo.charge_id!)
    expect(saldoAlvo?.status).toBe('cancelled')
    const linhaAlvo = (await cronograma(rentalId)).find((l) => l.id === alvo.schedule_line_id)
    expect(linhaAlvo?.status).toBe('cancelled')
  })

  test('dentro do período: linha ainda não emitida marcada por opção é cancelada via novo parâmetro da RPC (capacidade nova)', async () => {
    const rentalId = await criarLocacao()
    await emitir()

    const linhas = await cronograma(rentalId)
    const emitidas = linhas.filter((l) => l.status === 'issued').sort((a, b) => a.period_start.localeCompare(b.period_start))
    // Vigência bem à frente: praticamente todas as linhas planejadas ficam DENTRO do período.
    const terminationDate = isoOffset(130)
    const planejadaDentro = linhas.find((l) => l.status === 'scheduled' && l.period_start <= terminationDate)!
    void emitidas

    const { error } = await encerrar({
      rentalId, terminationDate, force: true,
      extraScheduleLineIds: [planejadaDentro.id],
    })
    expect(error).toBeNull()

    const linhaDepois = (await cronograma(rentalId)).find((l) => l.id === planejadaDentro.id)
    expect(linhaDepois?.status).toBe('cancelled')
  })

  test('dentro do período: cobrança com pagamento alocado fica keep_locked, sem opção de marcação (RN-001)', async () => {
    const rentalId = await criarLocacao()
    await emitir()

    const linhas = (await cronograma(rentalId))
      .filter((l) => l.status === 'issued')
      .sort((a, b) => a.period_start.localeCompare(b.period_start))
    const terminationDate = linhas[linhas.length - 1]!.period_start
    const plano = await planejarEncerramento(rentalId, terminationDate)
    const alvo = plano.find((l) => !l.is_outside_period && l.is_issued)!

    await receivePayment(admin(), tenantId, {
      customerId, amount: alvo.total_amount, method: 'pix', paidAt: new Date(),
      allocations: [{ chargeId: alvo.charge_id!, amount: alvo.total_amount }],
    })

    const planoDepois = await planejarEncerramento(rentalId, terminationDate)
    expect(planoDepois.find((l) => l.charge_id === alvo.charge_id)).toMatchObject({ action: 'keep_locked' })
  })
})
