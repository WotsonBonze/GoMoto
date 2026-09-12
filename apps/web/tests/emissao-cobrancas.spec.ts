import { test, expect } from '@playwright/test'
import {
  TEST_TAG, getSupabaseAdmin, getTestTenantId,
  createTestVehicle, deleteTestVehicle, createTestCustomer, deleteTestCustomer,
  createTestContract,
} from './helpers'
import { createCharge } from '../src/lib/financial/charges'
import { waitForPageLoad } from './helpers'

/**
 * Emissão de cobrança a partir do cronograma — `issue_due_charges`.
 *
 * Este é o único caminho pelo qual nasce cobrança de aluguel, e até aqui
 * **nenhum teste o exercitava**: as specs financeiras criavam cobranças
 * direto, pulando a RPC. A emissão foi conferida à mão uma vez; verificação
 * manual não sobrevive a refatoração, e ela está prestes a mudar de lugar
 * (mover para `pg_cron`, resolvendo a falta de atomicidade entre documento e
 * lançamento).
 *
 * O que este spec fixa é o **contrato** da emissão: quais linhas entram, o que
 * a cobrança carrega, e que rodar duas vezes não duplica. Quando a emissão
 * migrar para dentro do banco, é este spec que dirá se o comportamento se
 * manteve.
 *
 * Usa service_role: o alvo é a RPC, não a RLS.
 */

const admin = () => getSupabaseAdmin()

/** Datas relativas a hoje, para o spec não envelhecer. */
function isoOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

type ScheduleLine = {
  sequence_number: number
  period_start: string
  period_end: string
  due_date: string
  amount: number
}

let customerId = ''
const rentalsCriadas: string[] = []
const veiculosCriados: string[] = []
const veiculoDaLocacao = new Map<string, string>()

/** O veículo desta locação — as asserções de dimensão comparam contra ele. */
function veiculoDa(rentalId: string): string {
  const v = veiculoDaLocacao.get(rentalId)
  if (!v) throw new Error(`locação ${rentalId} não foi criada por criarLocacao`)
  return v
}

/**
 * Cria locação com cronograma pela mesma RPC que a tela usa.
 *
 * Um veículo por locação: o banco recusa duas locações ativas na mesma moto
 * (ADR 0036). O spec reaproveitava um veículo só para todos os casos — o que
 * só funcionava porque a regra não existia.
 */
async function criarLocacao(lines: ScheduleLine[]): Promise<string> {
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
      cycle_amount: 600,
      due_day: 10,
      use_pro_rata: false,
      contract_type: 'rental',
    },
    p_schedule: lines,
  })

  if (error) throw new Error(`Setup falhou ao criar locação: ${error.message}`)
  const id = data as string
  rentalsCriadas.push(id)
  veiculoDaLocacao.set(id, veiculo.id)
  return id
}

/**
 * Emite pelo caminho de PRODUÇÃO.
 *
 * `issue_due_charges` cria o documento e só; quem lança no razão é
 * `fn_issue_charges_for_tenant`, que a envolve e faz as duas coisas na mesma
 * transação — é ela que o `pg_cron` e o disparo manual chamam. Chamar a de
 * dentro deixava cobrança sem lançamento no banco de teste, exatamente o
 * estado que `reconciliacao.spec.ts` existe para proibir.
 *
 * Devolve quantas cobranças saíram.
 */
async function emitir(leadDays = 0): Promise<number> {
  const tenantId = await getTestTenantId()
  const { data, error } = await admin().rpc('fn_issue_charges_for_tenant', {
    p_tenant_id: tenantId,
    p_lead_days: leadDays,
  })
  if (error) throw new Error(`fn_issue_charges_for_tenant: ${error.message}`)
  return (data as number | null) ?? 0
}

/** Linhas do cronograma desta locação, na ordem. */
async function cronograma(rentalId: string) {
  const { data } = await admin()
    .from('rental_billing_schedules')
    .select('id, sequence_number, status, amount, due_date')
    .eq('rental_id', rentalId)
    .order('sequence_number')
  return (data ?? []) as {
    id: string; sequence_number: number; status: string
    amount: number; due_date: string
  }[]
}

/**
 * Cobrança emitida a partir de uma linha de cronograma.
 *
 * A navegação passou a ser pela ORIGEM: `schedules.charge_id` apontava de volta
 * para a cobrança que já aponta para a linha, e dois lados que podem divergir
 * sem nada garantindo é duplicação. `charges.source_id` é uniforme para todas
 * as origens e tem índice.
 */
async function cobrancaDaLinha(scheduleId: string) {
  const { data } = await admin()
    .from('charges')
    .select('id, due_date, status, late_charge_policy_id, customer_id, rental_id')
    .eq('source_module', 'rental')
    .eq('source_id', scheduleId)
    .maybeSingle()
  return data as {
    id: string; due_date: string; status: string
    late_charge_policy_id: string | null; customer_id: string; rental_id: string
  } | null
}

test.describe('Emissão de cobranças a partir do cronograma', () => {
  test.beforeAll(async () => {
    const c = await createTestCustomer()
    customerId = c.id
  })

  test.afterAll(async () => {
    // Cobrança emitida não se apaga (Princípio 5) e prende a locação junto;
    // o cleanup é best-effort, como nos demais specs financeiros.
    for (const id of rentalsCriadas) {
      await admin().from('rental_billing_schedules').delete().eq('rental_id', id)
      await admin().from('rentals').delete().eq('id', id)
    }
    await deleteTestCustomer(customerId).catch(() => {})
    for (const id of veiculosCriados) await deleteTestVehicle(id).catch(() => {})
  })

  test('emite o período que já começou e deixa o futuro em paz', async () => {
    const rentalId = await criarLocacao([
      // já começou — deve emitir
      { sequence_number: 1, period_start: isoOffset(-40), period_end: isoOffset(-10), due_date: isoOffset(-10), amount: 600 },
      // começa amanhã — não deve emitir
      { sequence_number: 2, period_start: isoOffset(1), period_end: isoOffset(31), due_date: isoOffset(31), amount: 600 },
    ])

    await emitir()

    const linhas = await cronograma(rentalId)
    expect(linhas.find((l) => l.sequence_number === 1)?.status).toBe('issued')
    expect(linhas.find((l) => l.sequence_number === 2)?.status).toBe('scheduled')
  })

  test('a cobrança herda valor, vencimento e veículo da linha', async () => {
    const vencimento = isoOffset(-5)
    const rentalId = await criarLocacao([
      { sequence_number: 1, period_start: isoOffset(-35), period_end: vencimento, due_date: vencimento, amount: 437.5 },
    ])

    await emitir()

    const [linha] = await cronograma(rentalId)
    expect(linha!.status).toBe('issued')

    const c = await cobrancaDaLinha(linha!.id)
    expect(c, 'linha emitida sem cobrança correspondente').not.toBeNull()

    expect(c!.due_date).toBe(vencimento)
    expect(c!.status).toBe('open')
    expect(c!.customer_id).toBe(customerId)
    expect(c!.rental_id).toBe(rentalId)

    // A política de encargo é CONGELADA na emissão: mudar a política depois não
    // pode reescrever o que já foi cobrado.
    expect(c!.late_charge_policy_id).not.toBeNull()

    const { data: items } = await admin()
      .from('charge_items')
      .select('amount, credit_account_code, source_module, vehicle_id')
      .eq('charge_id', c!.id)

    const it = (items ?? []) as {
      amount: number; credit_account_code: string; source_module: string; vehicle_id: string | null
    }[]

    expect(it).toHaveLength(1)
    expect(Number(it[0]!.amount)).toBe(437.5)
    expect(it[0]!.credit_account_code).toBe('receita_locacao')
    expect(it[0]!.source_module).toBe('rental')

    // Sem o veículo no item, o lançamento nasce sem a dimensão e a cobrança
    // some do resultado por veículo — foi assim que a receita de caução ficou
    // invisível antes.
    expect(it[0]!.vehicle_id, 'item sem veículo quebra o relatório por veículo').toBe(veiculoDa(rentalId))
  })

  test('rodar de novo não duplica', async () => {
    const rentalId = await criarLocacao([
      { sequence_number: 1, period_start: isoOffset(-20), period_end: isoOffset(-1), due_date: isoOffset(-1), amount: 300 },
    ])

    await emitir()
    const depoisDaPrimeira = await cronograma(rentalId)
    expect(await cobrancaDaLinha(depoisDaPrimeira[0]!.id)).not.toBeNull()

    // Segunda execução: a linha já está `issued`, então não entra no filtro.
    const segunda = await emitir()
    expect(segunda, 'a segunda execução emitiu de novo').toBe(0)

    const { count } = await admin()
      .from('charges')
      .select('id', { count: 'exact', head: true })
      .eq('rental_id', rentalId)

    expect(count, 'a mesma linha gerou duas cobranças').toBe(1)
  })

  test('lead time antecipa a emissão do período seguinte', async () => {
    const rentalId = await criarLocacao([
      { sequence_number: 1, period_start: isoOffset(3), period_end: isoOffset(33), due_date: isoOffset(33), amount: 600 },
    ])

    // Sem antecedência: o período ainda não começou.
    await emitir(0)
    expect((await cronograma(rentalId))[0]!.status).toBe('scheduled')

    // Com 5 dias de antecedência: entra.
    await emitir(5)
    expect((await cronograma(rentalId))[0]!.status).toBe('issued')
  })

  test('cobrança avulsa vinculada à locação entra no resultado do veículo', async () => {
    // Regressão: o formulário de cobrança avulsa pede cliente e locação, nunca
    // veículo. Sem derivar da locação, o lançamento nascia sem a dimensão e a
    // receita sumia de `vehicle_financial_position` — sem erro, sem aviso.
    const rentalId = await criarLocacao([
      { sequence_number: 1, period_start: isoOffset(-9), period_end: isoOffset(21), due_date: isoOffset(21), amount: 600 },
    ])

    const { data: antes } = await admin()
      .from('vehicle_financial_position')
      .select('operating_revenue')
      .eq('vehicle_id', veiculoDa(rentalId))
      .maybeSingle()

    const receitaAntes = Number((antes as { operating_revenue: number } | null)?.operating_revenue ?? 0)

    // Chama o ChargeService de verdade — é nele que a derivação vive, e ele
    // só depende do cliente Supabase, então roda fora do Next.
    const { chargeId } = await createCharge(admin(), await getTestTenantId(), {
      customerId,
      rentalId,
      dueDate: isoOffset(10),
      sourceModule: 'manual',
      items: [{
        description: `${TEST_TAG} Lavagem`,
        credit_account_code: 'receita_locacao',
        quantity: 1,
        unit_amount: 90,
        amount: 90,
        source_module: 'manual',
        // Sem vehicle_id de propósito: é exatamente o caso da cobrança avulsa.
      }],
    })

    const { data: items } = await admin()
      .from('charge_items')
      .select('vehicle_id')
      .eq('charge_id', chargeId)

    expect((items as { vehicle_id: string | null }[])[0]?.vehicle_id).toBe(veiculoDa(rentalId))

    const { data: entries } = await admin()
      .from('financial_entries')
      .select('vehicle_id, account_code')
      .eq('charge_id', chargeId)

    for (const e of (entries ?? []) as { vehicle_id: string | null }[]) {
      expect(e.vehicle_id, 'lançamento sem veículo some do relatório').toBe(veiculoDa(rentalId))
    }

    const { data: depois } = await admin()
      .from('vehicle_financial_position')
      .select('operating_revenue')
      .eq('vehicle_id', veiculoDa(rentalId))
      .maybeSingle()

    const receitaDepois = Number((depois as { operating_revenue: number } | null)?.operating_revenue ?? 0)
    expect(receitaDepois - receitaAntes).toBe(90)
  })

  test('a emissão pelo banco lança no ledger na MESMA transação', async () => {
    // É o ponto inteiro de mover o job para dentro do Postgres. Antes eram
    // duas transações: a cobrança nascia e o lançamento vinha numa segunda
    // chamada. Falha entre as duas deixava a cobrança existindo, visível e
    // pagável, sem nunca ter entrado em contas a receber — e a execução
    // seguinte não corrigia, porque a linha já estava consumida.
    const tenantId = await getTestTenantId()

    const rentalId = await criarLocacao([
      { sequence_number: 1, period_start: isoOffset(-6), period_end: isoOffset(24), due_date: isoOffset(24), amount: 750 },
    ])

    const { error } = await admin().rpc('fn_run_billing_emission', {
      p_triggered_by: 'manual',
      p_lead_days: 0,
    })
    expect(error, error?.message).toBeNull()

    const [linha] = await cronograma(rentalId)
    expect(linha!.status).toBe('issued')

    const cobranca = await cobrancaDaLinha(linha!.id)
    expect(cobranca, 'linha emitida sem cobrança').not.toBeNull()

    // Documento e lançamento existem juntos — nunca um sem o outro.
    const { data: entries } = await admin()
      .from('financial_entries')
      .select('account_code, direction, amount, vehicle_id')
      .eq('charge_id', cobranca!.id)

    const rows = (entries ?? []) as {
      account_code: string; direction: string; amount: number; vehicle_id: string | null
    }[]

    expect(rows.length, 'cobrança emitida sem lançamento no ledger').toBe(2)

    const debito = rows.find((e) => e.direction === 'debit')
    const credito = rows.find((e) => e.direction === 'credit')
    expect(debito?.account_code).toBe('contas_a_receber')
    expect(Number(debito?.amount)).toBe(750)
    expect(credito?.account_code).toBe('receita_locacao')
    expect(Number(credito?.amount)).toBe(750)

    // A dimensão do veículo sobrevive ao caminho SQL.
    expect(debito?.vehicle_id).toBe(veiculoDa(rentalId))

    // E a execução fica registrada, para "não rodou" deixar de ser invisível.
    const { data: run } = await admin()
      .from('billing_runs')
      .select('charges_issued, error, finished_at, triggered_by')
      .eq('tenant_id', tenantId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const r = run as { charges_issued: number; error: string | null; finished_at: string | null; triggered_by: string } | null
    expect(r, 'execução não foi registrada').not.toBeNull()
    expect(r!.error).toBeNull()
    expect(r!.finished_at).not.toBeNull()
    expect(r!.triggered_by).toBe('manual')
    expect(r!.charges_issued).toBeGreaterThan(0)
  })

  test('locação encerrada não gera cobrança', async () => {
    const rentalId = await criarLocacao([
      { sequence_number: 1, period_start: isoOffset(-15), period_end: isoOffset(15), due_date: isoOffset(15), amount: 600 },
    ])

    await admin().from('rentals').update({ status: 'closed' }).eq('id', rentalId)

    await emitir()

    const linhas = await cronograma(rentalId)
    expect(linhas[0]!.status, 'cobrança emitida para locação encerrada').toBe('scheduled')
  })

  test('a tela financeira mostra quando o faturamento rodou', async ({ page }) => {
    // O indicador existe para tornar visível a AUSÊNCIA de execução. Antes,
    // "o job não rodou" e "rodou e não havia nada a faturar" eram
    // indistinguíveis na tela — e foi assim que uma query quebrada manteve a
    // receita recorrente parada sem ninguém notar.
    await admin().rpc('fn_run_billing_emission', { p_triggered_by: 'manual', p_lead_days: 0 })

    await page.goto('/financeiro')
    await waitForPageLoad(page)

    await expect(page.getByText('Faturamento em dia')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/Última execução/)).toBeVisible()
    await expect(page.getByText(/\(manual\)/)).toBeVisible()
  })
})

/**
 * Previsão do cronograma por mês — o card "Previsto para o mês" de /locacoes.
 *
 * O card somava `rentals.cycle_amount` dos contratos ativos, o que junta
 * valores de PERÍODOS diferentes: um contrato mensal de R$ 1.500 mais um
 * semanal de R$ 350 davam R$ 1.850, número sem significado. A variável
 * chamava-se `monthlyRevenue` enquanto somava valor semanal.
 *
 * Somar o cronograma dispensa convenção — cada linha tem vencimento e valor,
 * com pro rata embutido. E a soma vive no BANCO porque uma carteira real passa
 * das 1.000 linhas que o PostgREST devolve (ADR 0025).
 */
/** Leitura da view, para comparar antes e depois. */
async function previsaoDoMes(mes: string): Promise<{ amount: number; lines: number }> {
  const { data } = await getSupabaseAdmin()
    .from('schedule_by_month')
    .select('scheduled_amount, scheduled_lines')
    .eq('month', `${mes}-01`)
    .maybeSingle()
  const row = data as { scheduled_amount: number; scheduled_lines: number } | null
  return { amount: Number(row?.scheduled_amount ?? 0), lines: Number(row?.scheduled_lines ?? 0) }
}

test.describe('Previsão do cronograma por mês', () => {
  test('soma o que vence no mês, sem misturar unidade de ciclo', async () => {
    const tenantId = await getTestTenantId()
    const v = await createTestVehicle()
    const c = await createTestContract(v.id)

    const mes = '2027-04'
    const antes = await previsaoDoMes(mes)
    const linhas = [
      { seq: 900, due: `${mes}-06`, amount: 350, status: 'scheduled' },
      { seq: 901, due: `${mes}-13`, amount: 350, status: 'scheduled' },
      // Emitida CONTA: a pergunta é o que o mês prevê, não o que falta emitir.
      { seq: 902, due: `${mes}-20`, amount: 350, status: 'issued' },
      // Estas não contam.
      { seq: 903, due: `${mes}-27`, amount: 999, status: 'cancelled' },
      // Outro mês.
      { seq: 904, due: '2027-05-04', amount: 350, status: 'scheduled' },
    ]

    for (const l of linhas) {
      await admin().from('rental_billing_schedules').insert({
        tenant_id: tenantId, rental_id: c.contractId, sequence_number: l.seq,
        period_start: l.due, period_end: l.due, due_date: l.due,
        amount: l.amount, status: l.status,
      })
    }

    const depois = await previsaoDoMes(mes)

    // Delta, não total: a view agrega por TENANT, e outros testes deixam
    // cronograma no mesmo mês. Medir o absoluto tornava o teste refém da ordem
    // de execução — foi o que aconteceu na primeira rodada da suíte inteira.
    expect(depois.amount - antes.amount, 'cancelada entrou, ou emitida ficou de fora').toBe(1050)
    expect(depois.lines - antes.lines).toBe(3)

    await deleteTestCustomer(c.customerId).catch(() => {})
    await deleteTestVehicle(v.id).catch(() => {})
  })

  test('contrato encerrado sai da previsão', async () => {
    const tenantId = await getTestTenantId()
    const v = await createTestVehicle()
    const c = await createTestContract(v.id)
    const mes = '2027-06'

    await admin().from('rental_billing_schedules').insert({
      tenant_id: tenantId, rental_id: c.contractId, sequence_number: 950,
      period_start: `${mes}-01`, period_end: `${mes}-08`, due_date: `${mes}-08`,
      amount: 500, status: 'scheduled',
    })

    const comContratoAtivo = await previsaoDoMes(mes)
    expect(comContratoAtivo.amount).toBeGreaterThanOrEqual(500)

    await admin().from('rentals').update({ status: 'closed' }).eq('id', c.contractId)

    const depoisDeEncerrar = await previsaoDoMes(mes)
    expect(
      comContratoAtivo.amount - depoisDeEncerrar.amount,
      'contrato encerrado continuou previsto',
    ).toBe(500)

    await deleteTestCustomer(c.customerId).catch(() => {})
    await deleteTestVehicle(v.id).catch(() => {})
  })
})
