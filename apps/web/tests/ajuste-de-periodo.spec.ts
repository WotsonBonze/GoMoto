import { test, expect } from '@playwright/test'
import {
  getSupabaseAdmin, getTestTenantId,
  createTestVehicle, deleteTestVehicle, createTestCustomer, deleteTestCustomer,
} from './helpers'
import { generateSchedule, planPeriodAdjustment } from '@gomoto/core'

/**
 * Ajuste de período e condições da locação — `fn_adjust_rental_period` (ADR 0035).
 *
 * O que este spec fixa não é a tela, é o CONTRATO da operação: linha já emitida
 * não é substituída enquanto sua cobrança estiver viva, a numeração continua em
 * vez de reiniciar, e o que a prévia promete é o que o banco faz.
 *
 * A guarda de cobrança viva é a peça mais importante daqui. Ela existe porque
 * entre a leitura da tela e a escrita cabem o job de emissão e um webhook de
 * pagamento — e um teste que só exercitasse o caminho feliz não diria nada
 * sobre isso.
 *
 * Usa service_role: o alvo é a RPC, não a RLS.
 */

const admin = () => getSupabaseAdmin()

function isoOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

const PARAMS = {
  start_date:   isoOffset(-90),
  end_date:     isoOffset(90),
  cycle:        'monthly' as const,
  due_day:      10,
  cycle_amount: 600,
  use_pro_rata: false,
}

let customerId = ''
let adjustedBy = ''
const rentaisCriadas: string[] = []
const veiculosCriados: string[] = []

/**
 * Quem assina o ajuste. `rental_adjustments.adjusted_by` é NOT NULL: reajuste
 * anônimo não existe, e a action sempre passa o usuário da sessão. O spec
 * precisa de um membro real do tenant pelo mesmo motivo.
 */
async function membroDoTenant(): Promise<string> {
  const { data } = await admin()
    .from('tenant_members')
    .select('user_id')
    .eq('tenant_id', await getTestTenantId())
    .limit(1).single()
  return (data as { user_id: string }).user_id
}

/** Um veículo por locação: o banco recusa duas ativas na mesma moto (ADR 0036). */
async function criarLocacao(params = PARAMS): Promise<string> {
  const tenantId = await getTestTenantId()
  const veiculo = await createTestVehicle()
  veiculosCriados.push(veiculo.id)
  const { data, error } = await admin().rpc('create_rental_with_schedule', {
    p_tenant_id: tenantId,
    p_rental: { customer_id: customerId, vehicle_id: veiculo.id, contract_type: 'rental', ...params },
    p_schedule: generateSchedule(params),
  })
  if (error) throw new Error(`Setup falhou ao criar locação: ${error.message}`)
  const id = data as string
  rentaisCriadas.push(id)
  return id
}

async function emitir(): Promise<number> {
  const { data, error } = await admin().rpc('fn_issue_charges_for_tenant', {
    p_tenant_id: await getTestTenantId(),
    p_lead_days: 0,
  })
  if (error) throw new Error(`fn_issue_charges_for_tenant: ${error.message}`)
  return (data as number | null) ?? 0
}

async function cronograma(rentalId: string) {
  const { data } = await admin()
    .from('rental_billing_schedules')
    .select('id, sequence_number, period_start, period_end, due_date, amount, status')
    .eq('rental_id', rentalId)
    .order('period_start')
  return (data ?? []) as Array<{
    id: string; sequence_number: number; period_start: string; period_end: string
    due_date: string; amount: number; status: string
  }>
}

async function cobrancasDaLocacao(rentalId: string) {
  const { data } = await admin()
    .from('charges')
    .select('id, source_id, charge_number, due_date, status')
    .eq('rental_id', rentalId)
    .eq('source_module', 'rental')
  return (data ?? []) as Array<{
    id: string; source_id: string; charge_number: number; due_date: string; status: string
  }>
}

/** Monta o plano a partir do estado REAL do banco, como a tela e a action fazem. */
async function planejar(rentalId: string, next: typeof PARAMS, effectiveFrom: string) {
  const linhas = await cronograma(rentalId)
  const cobrancas = await cobrancasDaLocacao(rentalId)

  const { data: saldos } = await admin()
    .from('charge_balances')
    .select('charge_id, total_amount, paid_amount')
    .eq('rental_id', rentalId)

  const porId = new Map(((saldos ?? []) as Array<{ charge_id: string; total_amount: number; paid_amount: number }>)
    .map((b) => [b.charge_id, b]))

  return planPeriodAdjustment({
    current: PARAMS,
    next,
    contract_type: 'rental',
    lines: linhas as never,
    charges: cobrancas.map((c) => ({
      schedule_line_id: c.source_id,
      charge_id:        c.id,
      charge_number:    c.charge_number,
      due_date:         c.due_date,
      total_amount:     Number(porId.get(c.id)?.total_amount ?? 0),
      paid_amount:      Number(porId.get(c.id)?.paid_amount ?? 0),
      status:           c.status as 'open' | 'paid' | 'cancelled' | 'written_off',
    })),
    effective_from: effectiveFrom,
    today: isoOffset(0),
  })
}

async function aplicar(rentalId: string, next: typeof PARAMS, plan: Awaited<ReturnType<typeof planejar>>) {
  return admin().rpc('fn_adjust_rental_period', {
    p_tenant_id:          await getTestTenantId(),
    p_rental_id:          rentalId,
    p_params:             next,
    p_effective_from:     plan.effective_from,
    p_supersede_line_ids: plan.supersede_lines.map((l) => l.id),
    p_new_lines:          plan.new_lines.map((l) => ({
      sequence_number: l.sequence_number,
      period_start:    l.period_start,
      period_end:      l.period_end,
      due_date:        l.due_date,
      amount:          l.amount,
    })),
    p_justification:      'Ajuste de teste E2E',
    p_adjusted_by:        adjustedBy,
  })
}

test.describe('Ajuste de período da locação', () => {
  test.beforeAll(async () => {
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

  test('nada emitido: o cronograma inteiro é regerado com os parâmetros novos', async () => {
    const futuro = { ...PARAMS, start_date: isoOffset(30), end_date: isoOffset(210) }
    const rentalId = await criarLocacao(futuro)

    const next = { ...futuro, cycle_amount: 900 }
    const plan = await planejar(rentalId, next, isoOffset(30))
    expect(plan.blockers).toEqual([])
    expect(plan.cancel_charges).toHaveLength(0)

    const { error } = await aplicar(rentalId, next, plan)
    expect(error).toBeNull()

    const linhas = await cronograma(rentalId)
    expect(linhas.filter((l) => l.status === 'superseded').length).toBeGreaterThan(0)
    for (const l of linhas.filter((l) => l.status === 'scheduled')) {
      expect(Number(l.amount)).toBeLessThanOrEqual(900)
    }

    const { data: rental } = await admin()
      .from('rentals').select('cycle_amount').eq('id', rentalId).single()
    expect(Number((rental as { cycle_amount: number }).cycle_amount)).toBe(900)
  })

  test('só o prazo muda: o plano existente é reaproveitado, não recriado', async () => {
    // Ciclo/dia/valor/pro-rata continuam iguais — só `end_date` estende. Todo
    // o cronograma que já existia deveria sobreviver com o MESMO id; só a
    // extensão de fato nova deve ser criada. Sem isso, `rental_billing_schedules`
    // dobra de tamanho (metade `superseded`) a cada renovação, sem motivo.
    const rentalId = await criarLocacao(PARAMS)
    const antes = await cronograma(rentalId)
    expect(antes.length).toBeGreaterThan(1)

    const next = { ...PARAMS, end_date: isoOffset(210) }
    const plan = await planejar(rentalId, next, '')
    expect(plan.blockers).toEqual([])

    const { error } = await aplicar(rentalId, next, plan)
    expect(error).toBeNull()

    const depois = await cronograma(rentalId)

    // Nada do que já existia foi riscado.
    expect(depois.filter((l) => l.status === 'superseded')).toHaveLength(0)

    // Toda linha antiga continua lá, com o MESMO id — não é uma cópia com
    // valores iguais, é a linha original intocada.
    for (const original of antes) {
      const mesma = depois.find((l) => l.id === original.id)
      expect(mesma, `linha ${original.sequence_number} foi recriada em vez de mantida`).toBeDefined()
      expect(mesma!.status).toBe('scheduled')
      expect(Number(mesma!.amount)).toBe(Number(original.amount))
    }

    // E só a extensão de fato nova (além do fim antigo) é criada. Sem pro
    // rata a ponta final é descartada (RN-011), então o último período antigo
    // pode terminar ANTES de `PARAMS.end_date` — o corte real é o fim da
    // última linha que já existia, não a data nominal do contrato.
    const novas = depois.filter((l) => !antes.some((a) => a.id === l.id))
    expect(novas.length).toBeGreaterThan(0)
    const fimAntigo = antes.reduce((max, l) => (l.period_end > max ? l.period_end : max), antes[0]!.period_end)
    for (const nova of novas) expect(nova.period_start >= fimAntigo).toBe(true)

    // A auditoria reflete o que de fato foi tocado — quase nada, além do
    // acréscimo.
    const { data: ajuste } = await admin()
      .from('rental_adjustments')
      .select('updated_billings_count, created_lines_count')
      .eq('rental_id', rentalId)
      .order('adjusted_at', { ascending: false })
      .limit(1).single()
    expect((ajuste as { updated_billings_count: number }).updated_billings_count).toBe(0)
    expect((ajuste as { created_lines_count: number }).created_lines_count).toBe(novas.length)
  })

  test('a numeração continua em vez de reiniciar — a UNIQUE proíbe reuso', async () => {
    const futuro = { ...PARAMS, start_date: isoOffset(30), end_date: isoOffset(210) }
    const rentalId = await criarLocacao(futuro)

    const antes = await cronograma(rentalId)
    const maxAntes = Math.max(...antes.map((l) => l.sequence_number))

    const next = { ...futuro, due_day: 20 }
    const plan = await planejar(rentalId, next, isoOffset(30))
    const { error } = await aplicar(rentalId, next, plan)
    expect(error).toBeNull()

    const depois = await cronograma(rentalId)
    const novas = depois.filter((l) => l.status === 'scheduled')
    expect(novas.length).toBeGreaterThan(0)
    for (const l of novas) expect(l.sequence_number).toBeGreaterThan(maxAntes)

    const nums = depois.map((l) => l.sequence_number)
    expect(new Set(nums).size).toBe(nums.length)
  })

  test('recusa substituir linha cuja cobrança ainda está viva', async () => {
    const rentalId = await criarLocacao()
    await emitir()

    const linhas = await cronograma(rentalId)
    const emitidas = linhas.filter((l) => l.status === 'issued')
    expect(emitidas.length).toBeGreaterThan(0)

    // Passa uma linha EMITIDA para substituição sem cancelar a cobrança antes.
    // É exatamente o estado que uma leitura envelhecida da tela produziria.
    const { error } = await admin().rpc('fn_adjust_rental_period', {
      p_tenant_id:          await getTestTenantId(),
      p_rental_id:          rentalId,
      p_params:             { ...PARAMS, due_day: 20 },
      p_effective_from:     isoOffset(0),
      p_supersede_line_ids: [emitidas[0]!.id],
      p_new_lines:          [],
      p_justification:      'Tentativa indevida',
      p_adjusted_by:        adjustedBy,
    })

    expect(error).not.toBeNull()
    expect(error!.message).toContain('LINE_HAS_LIVE_CHARGE')

    // E nada mudou: a recusa é da transação inteira.
    const depois = await cronograma(rentalId)
    expect(depois.find((l) => l.id === emitidas[0]!.id)!.status).toBe('issued')
    const { data: rental } = await admin()
      .from('rentals').select('due_day').eq('id', rentalId).single()
    expect((rental as { due_day: number }).due_day).toBe(PARAMS.due_day)
  })

  test('cobrança cancelada libera a linha, e a auditoria registra o que mudou', async () => {
    const rentalId = await criarLocacao()
    await emitir()

    const linhas = await cronograma(rentalId)
    const ultimaEmitida = linhas.filter((l) => l.status === 'issued').at(-1)!
    const cobrancas = await cobrancasDaLocacao(rentalId)
    const alvo = cobrancas.find((c) => c.source_id === ultimaEmitida.id)!

    await admin().from('charges')
      .update({ status: 'cancelled', cancellation_reason: 'E2E' })
      .eq('id', alvo.id)

    const next = { ...PARAMS, due_day: 20 }
    const { error } = await admin().rpc('fn_adjust_rental_period', {
      p_tenant_id:          await getTestTenantId(),
      p_rental_id:          rentalId,
      p_params:             next,
      p_effective_from:     ultimaEmitida.period_start,
      p_supersede_line_ids: [ultimaEmitida.id],
      p_new_lines:          [],
      p_justification:      'Ajuste após cancelar a cobrança',
      p_adjusted_by:        adjustedBy,
    })
    expect(error).toBeNull()

    const depois = await cronograma(rentalId)
    expect(depois.find((l) => l.id === ultimaEmitida.id)!.status).toBe('superseded')

    const { data: ajuste } = await admin()
      .from('rental_adjustments')
      .select('previous_due_day, new_due_day, effective_from, cancelled_charges_count')
      .eq('rental_id', rentalId)
      .order('adjusted_at', { ascending: false })
      .limit(1).single()

    const a = ajuste as {
      previous_due_day: number; new_due_day: number
      effective_from: string; cancelled_charges_count: number
    }
    expect(a.previous_due_day).toBe(PARAMS.due_day)
    expect(a.new_due_day).toBe(20)
    expect(a.effective_from).toBe(ultimaEmitida.period_start)
    expect(a.cancelled_charges_count).toBe(1)
  })

  test('início avança para dentro de período já emitido: a cobrança cancelada ganha substituta, sem buraco', async () => {
    // Reprodução do bug achado em teste de navegador (2026-09-15): antecipar
    // o início em 2 dias sobre uma locação com períodos já emitidos cancelava
    // a cobrança certa, mas não deixava NENHUMA linha cobrindo o trecho
    // [novo início, vencimento original) — o período ficava sem cobrança
    // nenhuma, em silêncio. `regenFrom` pulava direto para o fim do último
    // período emitido e nunca olhava para o que sobrava antes disso.
    const rentalId = await criarLocacao()
    await emitir()

    const antes = await cronograma(rentalId)
    const primeira = antes[0]!
    expect(primeira.status).toBe('issued')

    const d = new Date(`${primeira.period_start}T00:00:00`)
    d.setDate(d.getDate() + 2)
    const novoInicio = d.toISOString().slice(0, 10)

    const next = { ...PARAMS, start_date: novoInicio }
    const plan = await planejar(rentalId, next, '')
    expect(plan.blockers).toEqual([])
    expect(plan.cancel_charges.map((c) => c.charge_id).length).toBeGreaterThan(0)

    // Fora do teste, `adjustRentalPeriod` cancela cada `plan.cancel_charges`
    // (com estorno de ledger) antes de chamar a RPC. Aqui, sem a Server
    // Action, o teste imita só a parte que a RPC exige: sem isso, a guarda
    // `LINE_HAS_LIVE_CHARGE` recusa a substituição.
    for (const c of plan.cancel_charges) {
      await admin().from('charges')
        .update({ status: 'cancelled', cancellation_reason: 'E2E' })
        .eq('id', c.charge_id)
    }

    const { error } = await aplicar(rentalId, next, plan)
    expect(error).toBeNull()

    const depois = await cronograma(rentalId)
    const cobrancas = await cobrancasDaLocacao(rentalId)

    // A linha original é substituída, e a cobrança dela cancelada.
    const original = depois.find((l) => l.id === primeira.id)!
    expect(original.status).toBe('superseded')
    const cobrancaOriginal = cobrancas.find((c) => c.source_id === primeira.id)!
    expect(cobrancaOriginal.status).toBe('cancelled')

    // O trecho [novo início, vencimento original) tem uma linha NOVA cobrindo
    // — sem pro rata, no valor CHEIO do ciclo (RN-011).
    const substituta = depois.find((l) => l.period_start === novoInicio)
    expect(substituta, 'trecho ficou sem nenhuma linha de cronograma').toBeDefined()
    expect(substituta!.period_end).toBe(primeira.period_end)
    expect(substituta!.due_date).toBe(primeira.due_date)
    expect(Number(substituta!.amount)).toBe(PARAMS.cycle_amount)
    expect(substituta!.status).toBe('scheduled')

    // Nenhum trecho entre o novo início e o fim do contrato fica sem linha:
    // ordenado por período, cada `period_end` encaixa com o `period_start`
    // seguinte, sem furo.
    const vivas = depois
      .filter((l) => l.status === 'scheduled' || l.status === 'issued')
      .sort((a, b) => a.period_start.localeCompare(b.period_start))
    for (let i = 1; i < vivas.length; i++) {
      expect(vivas[i]!.period_start).toBe(vivas[i - 1]!.period_end)
    }
    expect(vivas[0]!.period_start).toBe(novoInicio)
  })

  test('locação encerrada não aceita ajuste', async () => {
    const futuro = { ...PARAMS, start_date: isoOffset(30), end_date: isoOffset(210) }
    const rentalId = await criarLocacao(futuro)
    await admin().from('rentals').update({ status: 'closed' }).eq('id', rentalId)

    const { error } = await admin().rpc('fn_adjust_rental_period', {
      p_tenant_id:          await getTestTenantId(),
      p_rental_id:          rentalId,
      p_params:             futuro,
      p_effective_from:     isoOffset(30),
      p_supersede_line_ids: [],
      p_new_lines:          [],
      p_justification:      'Não deveria passar',
      p_adjusted_by:        adjustedBy,
    })

    expect(error).not.toBeNull()
    expect(error!.message).toContain('RENTAL_NOT_ACTIVE')
  })
})
