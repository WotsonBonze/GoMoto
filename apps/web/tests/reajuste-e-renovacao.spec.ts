/**
 * Reajuste e extensão do cronograma.
 *
 * São as duas operações que mexem no plano de cobrança de uma locação já ativa.
 * Desde a ADR 0035 as duas moram na mesma tela (`/ajustar`), mas continuam
 * separadas aqui porque a pergunta que cada uma faz é diferente. A pergunta que importa nas duas é a mesma, e é o
 * Princípio 5 da ADR 0024: **documento emitido é imutável**. Reajustar não pode
 * reescrever cobrança que já foi entregue ao cliente — só o que ainda é plano.
 *
 * O cronograma (`rental_billing_schedules`) é mutável de propósito; a cobrança
 * (`charges`) não é. Se um reajuste alcançasse linha já emitida, o valor cobrado
 * mudaria depois do fato, e o cliente teria em mãos um documento que não bate
 * com o sistema.
 *
 * Usa service_role: o alvo são as RPCs, não a RLS (coberta em
 * `tenant-isolation-financeiro.spec.ts`).
 */

import { test, expect } from '@playwright/test'
import {
  TEST_TAG, getSupabaseAdmin, getTestTenantId,
  createTestVehicle, deleteTestVehicle, createTestCustomer, deleteTestCustomer,
  waitForPageLoad,
} from './helpers'

const admin = () => getSupabaseAdmin()

function isoOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

let customerId = ''
const rentalsCriadas: string[] = []
const veiculosCriados: string[] = []

type ScheduleLine = {
  sequence_number: number
  period_start: string
  period_end: string
  due_date: string
  amount: number
}

/**
 * Um veículo por locação: o banco recusa duas locações ativas na mesma moto
 * (ADR 0036). O spec reaproveitava um veículo só para todos os casos — o que
 * só funcionava porque a regra não existia.
 */
async function criarLocacao(lines: ScheduleLine[], cycleAmount: number): Promise<string> {
  const tenantId = await getTestTenantId()
  const veiculo = await createTestVehicle()
  veiculosCriados.push(veiculo.id)
  const { data, error } = await admin().rpc('create_rental_with_schedule', {
    p_tenant_id: tenantId,
    p_rental: {
      customer_id: customerId,
      vehicle_id: veiculo.id,
      start_date: lines[0]!.period_start,
      end_date: lines[lines.length - 1]!.period_end,
      cycle: 'monthly',
      cycle_amount: cycleAmount,
      due_day: 10,
      use_pro_rata: false,
      contract_type: 'rental',
    },
    p_schedule: lines,
  })
  if (error) throw new Error(`Setup falhou ao criar locação: ${error.message}`)
  const id = data as string
  rentalsCriadas.push(id)
  return id
}

async function cronograma(rentalId: string) {
  const { data } = await admin()
    .from('rental_billing_schedules')
    .select('id, sequence_number, status, amount, period_start, due_date')
    .eq('rental_id', rentalId)
    .order('sequence_number')
  return (data ?? []) as {
    id: string; sequence_number: number; status: string
    amount: number; period_start: string; due_date: string
  }[]
}

/** Usuário do tenant de teste — `rental_adjustments.adjusted_by` é NOT NULL. */
async function testUserId(): Promise<string> {
  const tenantId = await getTestTenantId()
  const { data } = await admin()
    .from('tenant_members').select('user_id').eq('tenant_id', tenantId).limit(1).single()
  return (data as { user_id: string }).user_id
}

async function reajustar(rentalId: string, novoValor: number, aPartirDe: string) {
  const tenantId = await getTestTenantId()
  const { data, error } = await admin().rpc('adjust_rental_schedule', {
    p_tenant_id:      tenantId,
    p_rental_id:      rentalId,
    p_new_amount:     novoValor,
    p_effective_from: aPartirDe,
    p_justification:  `${TEST_TAG} reajuste anual`,
    p_adjusted_by:    await testUserId(),
  })
  if (error) throw new Error(`adjust_rental_schedule: ${error.message}`)
  return data as number
}

test.beforeAll(async () => {
  const c = await createTestCustomer()
  customerId = c.id
})

test.afterAll(async () => {
  for (const id of rentalsCriadas) {
    const linhas = await cronograma(id)
    const ids = linhas.map((l) => l.id)
    if (ids.length > 0) {
      const { data: cobr } = await admin()
        .from('charges').select('id').in('source_id', ids).eq('source_module', 'rental')
      for (const c of (cobr ?? []) as { id: string }[]) {
        await admin().from('financial_entries').delete().eq('charge_id', c.id)
        await admin().from('charge_items').delete().eq('charge_id', c.id)
        await admin().from('charges').delete().eq('id', c.id)
      }
    }
    await admin().from('rental_adjustments').delete().eq('rental_id', id)
    await admin().from('rental_billing_schedules').delete().eq('rental_id', id)
    await admin().from('rentals').delete().eq('id', id)
  }
  if (customerId) await deleteTestCustomer(customerId).catch(() => {})
  for (const id of veiculosCriados) await deleteTestVehicle(id).catch(() => {})
})

test.describe('Reajuste do cronograma', () => {
  test('alcança as linhas futuras e não toca a cobrança já emitida', async () => {
    const tenantId = await getTestTenantId()

    // A emissão dispara pelo INÍCIO do período, não pelo vencimento: a cobrança
    // nasce quando o ciclo começa, para o cliente poder pagar antes de vencer.
    // Por isso o ciclo ainda-plano precisa começar no futuro, não só vencer nele.
    const rentalId = await criarLocacao([
      { sequence_number: 1, period_start: isoOffset(-60), period_end: isoOffset(-31), due_date: isoOffset(-31), amount: 600 },
      { sequence_number: 2, period_start: isoOffset(-30), period_end: isoOffset(-1),  due_date: isoOffset(-1),  amount: 600 },
      { sequence_number: 3, period_start: isoOffset(15),  period_end: isoOffset(44),  due_date: isoOffset(44),  amount: 600 },
    ], 600)

    await admin().rpc('fn_issue_charges_for_tenant', { p_tenant_id: tenantId, p_lead_days: 0 })

    const antes = await cronograma(rentalId)
    const emitidas = antes.filter((l) => l.status === 'issued')
    expect(emitidas.length, 'nada foi emitido — o setup não exercita imutabilidade').toBeGreaterThan(0)

    // Guarda o valor da cobrança emitida ANTES do reajuste, para provar que ela
    // não se move.
    const { data: cobrancaAntes } = await admin()
      .from('charge_balances')
      .select('charge_id, total_amount')
      .eq('charge_id', (await admin()
        .from('charges').select('id')
        .eq('source_module', 'rental').eq('source_id', emitidas[0]!.id).single()
      ).data!.id)
      .single()

    const totalEmitidoAntes = Number((cobrancaAntes as { total_amount: number }).total_amount)

    // Reajusta valendo de hoje em diante: só o ciclo 3 ainda é plano.
    const atualizadas = await reajustar(rentalId, 750, isoOffset(0))
    expect(atualizadas, 'reajuste devia alcançar exatamente a linha futura').toBe(1)

    const depois = await cronograma(rentalId)
    for (const linha of depois) {
      if (linha.status === 'issued') {
        expect(Number(linha.amount), `linha ${linha.sequence_number} emitida foi reescrita`).toBe(600)
      } else {
        expect(Number(linha.amount), `linha ${linha.sequence_number} futura não reajustou`).toBe(750)
      }
    }

    // O documento continua valendo o que valia quando foi emitido.
    const { data: cobrancaDepois } = await admin()
      .from('charge_balances')
      .select('total_amount')
      .eq('charge_id', (cobrancaAntes as { charge_id: string }).charge_id)
      .single()

    expect(
      Number((cobrancaDepois as { total_amount: number }).total_amount),
      'reajuste mudou o valor de cobrança já emitida (Princípio 5)',
    ).toBe(totalEmitidoAntes)

    // O novo valor vira o padrão da locação, e o reajuste fica registrado com
    // o valor anterior — é a trilha que explica por que os ciclos divergem.
    const { data: rental } = await admin()
      .from('rentals').select('cycle_amount').eq('id', rentalId).single()
    expect(Number((rental as { cycle_amount: number }).cycle_amount)).toBe(750)

    const { data: ajuste } = await admin()
      .from('rental_adjustments')
      .select('previous_cycle_amount, new_cycle_amount, updated_billings_count, justification')
      .eq('rental_id', rentalId)
      .single()

    const a = ajuste as {
      previous_cycle_amount: number; new_cycle_amount: number
      updated_billings_count: number; justification: string
    }
    expect(Number(a.previous_cycle_amount)).toBe(600)
    expect(Number(a.new_cycle_amount)).toBe(750)
    expect(a.updated_billings_count).toBe(1)
  })

  test('reajuste retroativo não alcança linha já emitida', async () => {
    const tenantId = await getTestTenantId()

    const rentalId = await criarLocacao([
      { sequence_number: 1, period_start: isoOffset(-30), period_end: isoOffset(-1),  due_date: isoOffset(-1),  amount: 500 },
      { sequence_number: 2, period_start: isoOffset(15),  period_end: isoOffset(44),  due_date: isoOffset(44),  amount: 500 },
    ], 500)

    await admin().rpc('fn_issue_charges_for_tenant', { p_tenant_id: tenantId, p_lead_days: 0 })

    // Data efetiva no passado, cobrindo o período já emitido: a RPC filtra por
    // `status = 'scheduled'`, então a linha emitida fica fora mesmo assim.
    const atualizadas = await reajustar(rentalId, 900, isoOffset(-60))

    const linhas = await cronograma(rentalId)
    const emitida = linhas.find((l) => l.status === 'issued')
    expect(emitida, 'setup não emitiu nada').toBeDefined()
    expect(
      Number(emitida!.amount),
      'reajuste retroativo reescreveu linha emitida — documento deixou de ser imutável',
    ).toBe(500)

    const futura = linhas.find((l) => l.status === 'scheduled')
    expect(Number(futura!.amount)).toBe(900)
    expect(atualizadas).toBe(1)
  })
})

test.describe('Estender o prazo pela tela de Ajustar', () => {
  /**
   * Renovar deixou de ser tela própria (ADR 0035): esticar o fim é mudar um dos
   * seis parâmetros do cronograma, e ter dois donos para `end_date` fazia as
   * regras divergirem. A INVARIANTE, porém, é a mesma de antes e continua sendo
   * o que este teste protege: estender não pode tocar no que já foi emitido.
   *
   * A vigência sugerida por `planPeriodAdjustment` é o fim do último período
   * emitido, então o caminho de estender preserva as linhas emitidas sem o
   * operador precisar pensar nisso.
   */
  test('acrescenta ciclos ao plano sem tocar no que já foi emitido', async ({ page }) => {
    const tenantId = await getTestTenantId()

    // Locação terminando em 15 dias, com o primeiro ciclo já emitido.
    const rentalId = await criarLocacao([
      { sequence_number: 1, period_start: isoOffset(-30), period_end: isoOffset(-1), due_date: isoOffset(-1), amount: 400 },
      { sequence_number: 2, period_start: isoOffset(0),   period_end: isoOffset(15), due_date: isoOffset(10), amount: 400 },
    ], 400)

    await admin().rpc('fn_issue_charges_for_tenant', { p_tenant_id: tenantId, p_lead_days: 0 })

    const antes = await cronograma(rentalId)
    const emitidasAntes = antes.filter((l) => l.status === 'issued')
    expect(emitidasAntes.length, 'setup não emitiu nada').toBeGreaterThan(0)

    const { count: cobrancasAntes } = await admin()
      .from('charges').select('id', { count: 'exact', head: true })
      .eq('rental_id', rentalId)

    await page.goto(`/locacoes/${rentalId}/ajustar`)
    await waitForPageLoad(page)

    // Estende por mais ~2 meses. A data de fim é o segundo campo de data; o
    // terceiro é a vigência, que fica no padrão (fim do último emitido).
    await page.locator('input[type=date]').nth(1).fill(isoOffset(75))
    await page.locator('textarea').fill('Renovação combinada com o cliente')
    await page.getByRole('button', { name: /confirmar ajuste/i }).click()
    await page.waitForURL(`/locacoes/${rentalId}/financeiro`, { timeout: 15_000 })

    const depois = await cronograma(rentalId)

    // Nenhuma linha EMITIDA muda de status ou valor — é o Princípio 5.
    for (const original of emitidasAntes) {
      const igual = depois.find((l) => l.id === original.id)
      expect(igual, `linha ${original.sequence_number} sumiu`).toBeDefined()
      expect(igual!.status, `linha emitida ${original.sequence_number} mudou de status`).toBe('issued')
      expect(Number(igual!.amount), `linha emitida ${original.sequence_number} mudou de valor`).toBe(Number(original.amount))
    }

    // As linhas novas nascem como plano, não emitidas: quem emite é o job,
    // quando o período começar.
    const novas = depois.filter((l) => !antes.some((a) => a.id === l.id))
    expect(novas.length, 'não gerou ciclo novo').toBeGreaterThan(0)
    const maxAntes = Math.max(...antes.map((l) => l.sequence_number))
    for (const nova of novas) {
      expect(nova.status, 'linha nova já nasceu emitida — pulou o job').toBe('scheduled')
      // A numeração CONTINUA — `UNIQUE (rental_id, sequence_number)` proíbe reuso.
      expect(nova.sequence_number).toBeGreaterThan(maxAntes)
      expect(Number(nova.amount)).toBe(400)
    }

    // Sem repetição de sequência.
    const seqs = depois.map((l) => l.sequence_number)
    expect(new Set(seqs).size).toBe(seqs.length)

    // E estender não emite cobrança por si só.
    const { count: cobrancasDepois } = await admin()
      .from('charges').select('id', { count: 'exact', head: true })
      .eq('rental_id', rentalId)
    expect(cobrancasDepois, 'estender emitiu cobrança fora do job').toBe(cobrancasAntes ?? 0)

    // A data final da locação acompanha o plano.
    const { data: rental } = await admin()
      .from('rentals').select('end_date').eq('id', rentalId).single()
    expect((rental as { end_date: string }).end_date).toBe(isoOffset(75))
  })

  test('/renovar e /reajustar continuam vivas como redirect', async ({ page }) => {
    // Rotas antigas estão em links salvos, no histórico e em abas abertas: 404
    // no meio de uma operação é pior do que uma navegação a mais.
    const rentalId = await criarLocacao([
      { sequence_number: 1, period_start: isoOffset(30), period_end: isoOffset(60), due_date: isoOffset(60), amount: 400 },
    ], 400)

    for (const antiga of ['renovar', 'reajustar']) {
      await page.goto(`/locacoes/${rentalId}/${antiga}`)
      await page.waitForURL(`/locacoes/${rentalId}/ajustar`, { timeout: 15_000 })
    }
  })
})
