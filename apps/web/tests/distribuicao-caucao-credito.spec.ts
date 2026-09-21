/**
 * Distribuição dirigida de caução e crédito no encerramento (Spec 0017).
 *
 * O operador informa, dívida a dívida, quanto de caução e quanto de crédito
 * aplicar. A distribuição inteira roda DENTRO de `terminate_rental`, na mesma
 * transação que trava e fecha a locação — então qualquer recusa desfaz tudo
 * (RN-006), inclusive o encerramento.
 *
 * Duas camadas, de propósito:
 *  - RPC direto via service_role: as GARANTIAS de banco (tetos, atomicidade,
 *    guarda de dívida cancelada/de outra locação). É o que impede a violação
 *    mesmo que alguém chame a Server Action sem passar pela tela.
 *  - Browser: a TELA (lista de dívidas, feedback instantâneo, sobra, multa como
 *    linha comum) e o que só existe do lado da aplicação (autor do pagamento e
 *    trilha de auditoria).
 *
 * Mesma abordagem de `multa-rescisao-antecipada.spec.ts` e
 * `encerramento-retroativo-cobrancas.spec.ts`.
 */

import { test, expect } from '@playwright/test'
import {
  TEST_TAG, getSupabaseAdmin, getTestTenantId, waitForPageLoad,
  createTestVehicle, deleteTestVehicle, createTestCustomer, deleteTestCustomer,
} from './helpers'
import { createCharge, cancelCharge } from '../src/lib/financial/charges'
import { receivePayment } from '../src/lib/financial/payments'

const admin = () => getSupabaseAdmin()

function pad(n: number): string { return String(n).padStart(2, '0') }
function dataLocal(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const hoje = (): string => dataLocal(new Date())
const daquiA = (dias: number): string => dataLocal(new Date(Date.now() + dias * 864e5))

let tenantId = ''
let autorId = ''
const criados = { rentals: [] as string[], vehicles: [] as string[], customers: [] as string[] }

test.beforeAll(async () => {
  tenantId = await getTestTenantId()
  const { data } = await admin().from('tenant_members').select('user_id').eq('tenant_id', tenantId).limit(1).single()
  autorId = (data as { user_id: string }).user_id
})

test.afterAll(async () => {
  for (const id of criados.rentals) {
    await admin().from('rental_billing_schedules').delete().eq('rental_id', id)
    await admin().from('rentals').delete().eq('id', id)
  }
  for (const id of criados.customers) await deleteTestCustomer(id).catch(() => {})
  for (const id of criados.vehicles) await deleteTestVehicle(id).catch(() => {})
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Divida = { nome: string; valor: number; origem?: string }
type Cenario = { rentalId: string; customerId: string; vehicleId: string; dividas: Record<string, string> }

/**
 * Concede crédito como o app concede: linha em `customer_credits` E lançamento
 * no razão (a origem do lançamento é o CRÉDITO, o mesmo par que a reconciliação
 * procura — um fixture com origem solta deixa resíduo que derruba outra suíte).
 */
async function concederCredito(customerId: string, valor: number) {
  const { data: linha, error: linhaErr } = await admin().from('customer_credits').insert({
    tenant_id: tenantId, customer_id: customerId, amount: valor,
    origin: 'manual', reason: `${TEST_TAG} crédito de teste`,
  }).select('id').single()
  if (linhaErr) throw new Error(`customer_credits: ${linhaErr.message}`)

  const { error } = await admin().rpc('post_financial_transaction', {
    p_tenant_id: tenantId,
    p_transaction: {
      event_type: 'credit_granted', description: `${TEST_TAG} crédito de teste`,
      source_module: 'customer_credit', source_id: (linha as { id: string }).id,
    },
    p_entries: [
      { account_code: 'despesa_manutencao', direction: 'debit', amount: valor, customer_id: customerId },
      { account_code: 'creditos_de_clientes', direction: 'credit', amount: valor, customer_id: customerId },
    ],
  })
  if (error) throw new Error(`crédito: ${error.message}`)
}

/**
 * Uma locação ativa, com a caução PAGA (passivo no razão, cobrança quitada — o
 * mesmo estado que o produto deixa), crédito do cliente e dívidas em aberto.
 *
 * A caução é paga por `receivePayment`, e não só lançada no razão: sem o par
 * pagamento+alocação, a própria cobrança da caução ficaria em aberto e entraria
 * na lista de dívidas como se o cliente a devesse.
 */
async function montar(opts: {
  caucao?: number
  credito?: number
  dividas: Divida[]
  multa?: { valor: number; dias: number }
  customerId?: string
}): Promise<Cenario> {
  const sb = admin()
  const veiculo = await createTestVehicle()
  criados.vehicles.push(veiculo.id)

  let customerId = opts.customerId
  if (!customerId) {
    customerId = (await createTestCustomer()).id
    criados.customers.push(customerId)
  }

  const { data: novoId, error } = await sb.rpc('create_rental_with_schedule', {
    p_tenant_id: tenantId,
    p_rental: {
      customer_id: customerId, vehicle_id: veiculo.id,
      start_date: hoje(), end_date: daquiA(60),
      cycle: 'monthly', cycle_amount: 500, due_day: 10, use_pro_rata: false, contract_type: 'rental',
      ...(opts.multa
        ? { early_termination_fine_amount: opts.multa.valor, minimum_term_days: opts.multa.dias }
        : {}),
    },
    p_schedule: [],
  })
  if (error) throw new Error(`Setup: create_rental_with_schedule — ${error.message}`)
  const rentalId = novoId as string
  criados.rentals.push(rentalId)

  if (opts.caucao) {
    const { chargeId } = await createCharge(sb, tenantId, {
      customerId, rentalId, dueDate: hoje(),
      sourceModule: 'deposit', sourceId: crypto.randomUUID(),
      items: [{
        description: `${TEST_TAG} Caução`, credit_account_code: 'caucoes_a_devolver',
        quantity: 1, unit_amount: opts.caucao, amount: opts.caucao, vehicle_id: veiculo.id,
      }],
    })
    await sb.from('deposits').insert({
      tenant_id: tenantId, rental_id: rentalId, customer_id: customerId, amount: opts.caucao, charge_id: chargeId,
    })
    await receivePayment(sb, tenantId, {
      customerId, amount: opts.caucao, method: 'pix', paidAt: new Date(),
      allocations: [{ chargeId, amount: opts.caucao }],
    })
  }

  if (opts.credito) await concederCredito(customerId, opts.credito)

  const dividas: Record<string, string> = {}
  for (const d of opts.dividas) {
    const { chargeId } = await createCharge(sb, tenantId, {
      customerId, rentalId, dueDate: hoje(),
      sourceModule: d.origem ?? 'manual', sourceId: crypto.randomUUID(),
      items: [{
        description: `${TEST_TAG} ${d.nome}`, credit_account_code: 'receita_locacao',
        quantity: 1, unit_amount: d.valor, amount: d.valor, vehicle_id: veiculo.id,
      }],
    })
    dividas[d.nome] = chargeId
  }

  return { rentalId, customerId, vehicleId: veiculo.id, dividas }
}

/** `terminate_rental` como a Server Action o chama — `force` porque sempre sobra dívida aberta. */
async function encerrar(c: Cenario, extra: Record<string, unknown> = {}) {
  return admin().rpc('terminate_rental', {
    p_tenant_id: tenantId, p_rental_id: c.rentalId, p_termination_date: hoje(),
    p_force: true, p_km_final: 0,
    ...extra,
  })
}

async function saldoDaCobranca(chargeId: string) {
  const { data } = await admin()
    .from('charge_balances').select('status, open_amount, paid_amount, source_module')
    .eq('charge_id', chargeId).single()
  const r = data as { status: string; open_amount: number; paid_amount: number; source_module: string }
  return { ...r, open_amount: Number(r.open_amount), paid_amount: Number(r.paid_amount) }
}

async function saldoDaCaucao(rentalId: string): Promise<number> {
  const { data } = await admin().from('deposit_balances').select('balance').eq('rental_id', rentalId).maybeSingle()
  return Number((data as { balance: number } | null)?.balance ?? 0)
}

async function saldoDeCredito(customerId: string): Promise<number> {
  const { data } = await admin().from('customer_credit_balances').select('balance').eq('customer_id', customerId).maybeSingle()
  return Number((data as { balance: number } | null)?.balance ?? 0)
}

async function statusDaLocacao(rentalId: string): Promise<string> {
  const { data } = await admin().from('rentals').select('status').eq('id', rentalId).single()
  return (data as { status: string }).status
}

async function pagamentos(customerId: string, method: string) {
  const { data } = await admin()
    .from('payments').select('id, amount, notes, received_by')
    .eq('customer_id', customerId).eq('method', method)
  return ((data ?? []) as Array<{ id: string; amount: number; notes: string | null; received_by: string | null }>)
    .map((p) => ({ ...p, amount: Number(p.amount) }))
}

/** Locação segue ativa e nada foi gravado — o retrato de "recusou tudo" (RN-006). */
async function esperarNadaAplicado(c: Cenario) {
  expect(await statusDaLocacao(c.rentalId), 'a locação não pode ter fechado').toBe('active')
  expect((await pagamentos(c.customerId, 'deposit_retention')).length, 'retenção de caução vazou').toBe(0)
  expect((await pagamentos(c.customerId, 'credit')).length, 'abatimento de crédito vazou').toBe(0)
}

// ---------------------------------------------------------------------------
// Garantias de banco — RPC direto
// ---------------------------------------------------------------------------

test.describe('terminate_rental — distribuição dirigida (banco)', () => {
  test('CA-003/CA-010: caução em duas dívidas baixa cada uma exatamente no valor alocado, e só elas', async () => {
    const c = await montar({
      caucao: 500,
      dividas: [{ nome: 'A', valor: 300 }, { nome: 'B', valor: 200 }, { nome: 'C', valor: 100 }],
    })

    const { data, error } = await encerrar(c, {
      p_deposit_allocations: [
        { charge_id: c.dividas.A, amount: 300 },
        { charge_id: c.dividas.B, amount: 200 },
      ],
      p_deposit_reason: 'Avaria no para-choque',
    })
    expect(error, error?.message).toBeNull()

    expect(await saldoDaCobranca(c.dividas.A)).toMatchObject({ status: 'paid', paid_amount: 300, open_amount: 0 })
    expect(await saldoDaCobranca(c.dividas.B)).toMatchObject({ status: 'paid', paid_amount: 200, open_amount: 0 })
    // RF-010: nenhuma outra dívida é tocada.
    expect(await saldoDaCobranca(c.dividas.C)).toMatchObject({ status: 'open', paid_amount: 0, open_amount: 100 })

    expect(await saldoDaCaucao(c.rentalId)).toBe(0)
    expect(await statusDaLocacao(c.rentalId)).not.toBe('active')

    const retencoes = await pagamentos(c.customerId, 'deposit_retention')
    expect(retencoes.map((p) => p.amount).sort((a, b) => a - b)).toEqual([200, 300])
    // O motivo único vira a descrição de cada retenção (ADR 0026).
    for (const r of retencoes) expect(r.notes).toBe('Retenção de caução — Avaria no para-choque')

    const s = data as { deposit_allocated: number; deposit_remaining: number }
    expect(Number(s.deposit_allocated)).toBe(500)
    expect(Number(s.deposit_remaining)).toBe(0)
  })

  test('CA-004/RN-004: crédito numa dívida diferente da que recebeu caução — cada uma no seu destino', async () => {
    const c = await montar({
      caucao: 300, credito: 200,
      dividas: [{ nome: 'A', valor: 300 }, { nome: 'B', valor: 200 }],
    })

    const { error } = await encerrar(c, {
      p_deposit_allocations: [{ charge_id: c.dividas.A, amount: 300 }],
      p_credit_allocations:  [{ charge_id: c.dividas.B, amount: 200 }],
      p_deposit_reason: 'Diária em aberto',
    })
    expect(error, error?.message).toBeNull()

    expect((await pagamentos(c.customerId, 'deposit_retention')).map((p) => p.amount)).toEqual([300])
    expect((await pagamentos(c.customerId, 'credit')).map((p) => p.amount)).toEqual([200])
    expect(await saldoDaCobranca(c.dividas.A)).toMatchObject({ status: 'paid', paid_amount: 300 })
    expect(await saldoDaCobranca(c.dividas.B)).toMatchObject({ status: 'paid', paid_amount: 200 })
    expect(await saldoDeCredito(c.customerId)).toBe(0)
  })

  test('RN-001: a mesma dívida recebe caução E crédito — passa até o teto conjunto, não além', async () => {
    const dentro = await montar({ caucao: 200, credito: 100, dividas: [{ nome: 'A', valor: 300 }] })
    const ok = await encerrar(dentro, {
      p_deposit_allocations: [{ charge_id: dentro.dividas.A, amount: 200 }],
      p_credit_allocations:  [{ charge_id: dentro.dividas.A, amount: 100 }],
      p_deposit_reason: 'Diária em aberto',
    })
    expect(ok.error, ok.error?.message).toBeNull()
    expect(await saldoDaCobranca(dentro.dividas.A)).toMatchObject({ status: 'paid', paid_amount: 300 })

    // 200 + 150 > 300: cada fonte cabe sozinha, a soma não. O crédito é aplicado
    // DEPOIS da caução e relê a dívida já reduzida.
    const alem = await montar({ caucao: 200, credito: 150, dividas: [{ nome: 'A', valor: 300 }] })
    const { error } = await encerrar(alem, {
      p_deposit_allocations: [{ charge_id: alem.dividas.A, amount: 200 }],
      p_credit_allocations:  [{ charge_id: alem.dividas.A, amount: 150 }],
      p_deposit_reason: 'Diária em aberto',
    })
    expect(error?.message ?? '').toContain('AMOUNT_EXCEEDS_CHARGE')
    // A caução (aplicada ANTES do crédito estourar) também foi desfeita.
    expect((await saldoDaCobranca(alem.dividas.A)).paid_amount).toBe(0)
    await esperarNadaAplicado(alem)
  })

  test('CA-005: alocar mais caução do que a dívida deve é recusado e nada é gravado', async () => {
    const c = await montar({ caucao: 500, dividas: [{ nome: 'A', valor: 100 }] })
    const { error } = await encerrar(c, {
      p_deposit_allocations: [{ charge_id: c.dividas.A, amount: 150 }],
      p_deposit_reason: 'Avaria no para-choque',
    })
    expect(error?.message ?? '').toContain('AMOUNT_EXCEEDS_CHARGE')
    expect(await saldoDaCobranca(c.dividas.A)).toMatchObject({ paid_amount: 0, open_amount: 100 })
    await esperarNadaAplicado(c)
  })

  test('CA-006/RN-006: soma de caução acima do saldo é recusada e desfaz TAMBÉM a alocação anterior', async () => {
    // Saldo 400. A (300) cabe sozinha; B (200) não cabe depois dela.
    const c = await montar({
      caucao: 400,
      dividas: [{ nome: 'A', valor: 300 }, { nome: 'B', valor: 200 }],
    })
    const { error } = await encerrar(c, {
      p_deposit_allocations: [
        { charge_id: c.dividas.A, amount: 300 },
        { charge_id: c.dividas.B, amount: 200 },
      ],
      p_deposit_reason: 'Avaria no para-choque',
    })
    expect(error?.message ?? '').toContain('AMOUNT_EXCEEDS_DEPOSIT')

    // "Nada aplicado pela metade": a alocação em A JÁ tinha passado quando a de B falhou.
    expect((await saldoDaCobranca(c.dividas.A)).paid_amount, 'a alocação de A sobreviveu à falha de B').toBe(0)
    expect(await saldoDaCaucao(c.rentalId)).toBe(400)
    await esperarNadaAplicado(c)
  })

  test('CA-007: soma de crédito acima do saldo é recusada', async () => {
    const c = await montar({
      credito: 100,
      dividas: [{ nome: 'A', valor: 300 }, { nome: 'B', valor: 200 }],
    })
    const { error } = await encerrar(c, {
      p_credit_allocations: [
        { charge_id: c.dividas.A, amount: 80 },
        { charge_id: c.dividas.B, amount: 50 },
      ],
    })
    expect(error?.message ?? '').toContain('AMOUNT_EXCEEDS_BALANCE')
    expect(await saldoDeCredito(c.customerId)).toBe(100)
    await esperarNadaAplicado(c)
  })

  test('CA-011/RN-006: dívida que ficou menor entre a tela e a confirmação — recusa a distribuição INTEIRA', async () => {
    const c = await montar({
      caucao: 500, credito: 150,
      dividas: [{ nome: 'A', valor: 300 }, { nome: 'B', valor: 200 }],
    })

    // O que "chegou no meio": B passou de 200 para 50 em aberto (outro caminho
    // abateu 150). A tela ainda mostra 200.
    const outro = await admin().rpc('fn_apply_customer_credit', {
      p_tenant_id: tenantId, p_customer_id: c.customerId,
      p_charge_id: c.dividas.B, p_amount: 150, p_created_by: null,
    })
    expect(outro.error, outro.error?.message).toBeNull()

    const { error } = await encerrar(c, {
      p_deposit_allocations: [
        { charge_id: c.dividas.A, amount: 100 },   // ainda cabe
        { charge_id: c.dividas.B, amount: 100 },   // já não cabe (deve 50)
      ],
      p_deposit_reason: 'Avaria no para-choque',
    })
    expect(error?.message ?? '').toContain('AMOUNT_EXCEEDS_CHARGE')

    // A alocação válida em A não sobrou de pé, e a locação nem fechou.
    expect((await saldoDaCobranca(c.dividas.A)).paid_amount).toBe(0)
    expect(await statusDaLocacao(c.rentalId)).toBe('active')
    expect((await pagamentos(c.customerId, 'deposit_retention')).length).toBe(0)
  })

  test('RN-005/RN-006: dívida CANCELADA no meio do caminho é recusada — a view não filtra status', async () => {
    const c = await montar({
      caucao: 500,
      dividas: [{ nome: 'A', valor: 300 }, { nome: 'B', valor: 200 }],
    })

    // Outro operador cancela B depois de a tela carregar. `open_amount` da view é
    // `itens − alocações` e ignora o status: sem a guarda, a caução iria para uma
    // cobrança que deixou de existir.
    await cancelCharge(admin(), tenantId, c.dividas.B, `${TEST_TAG} cancelada no meio`, autorId)

    const { error } = await encerrar(c, {
      p_deposit_allocations: [
        { charge_id: c.dividas.A, amount: 100 },
        { charge_id: c.dividas.B, amount: 100 },
      ],
      p_deposit_reason: 'Avaria no para-choque',
    })
    expect(error?.message ?? '').toContain('CHARGE_NOT_OPEN')
    expect((await saldoDaCobranca(c.dividas.A)).paid_amount).toBe(0)
    await esperarNadaAplicado(c)
  })

  test('defesa em profundidade: dívida de OUTRA locação do mesmo cliente é recusada (caução e crédito)', async () => {
    const c1 = await montar({ caucao: 300, credito: 200, dividas: [{ nome: 'A', valor: 100 }] })
    // Segunda locação, mesmo cliente, outra moto — o contrato "que segue vivo".
    const c2 = await montar({ customerId: c1.customerId, dividas: [{ nome: 'X', valor: 200 }] })

    const viaCaucao = await encerrar(c1, {
      p_deposit_allocations: [{ charge_id: c2.dividas.X, amount: 100 }],
      p_deposit_reason: 'Avaria no para-choque',
    })
    expect(viaCaucao.error?.message ?? '').toContain('CHARGE_NOT_IN_RENTAL')

    const viaCredito = await encerrar(c1, {
      p_credit_allocations: [{ charge_id: c2.dividas.X, amount: 100 }],
    })
    expect(viaCredito.error?.message ?? '').toContain('CHARGE_NOT_IN_RENTAL')

    expect(await saldoDaCobranca(c2.dividas.X)).toMatchObject({ paid_amount: 0, open_amount: 200 })
    expect(await statusDaLocacao(c1.rentalId)).toBe('active')
    expect(await statusDaLocacao(c2.rentalId)).toBe('active')
  })

  test('RF-008: sobra de caução — o depósito fecha, o saldo que sobrou segue no razão', async () => {
    const c = await montar({ caucao: 500, dividas: [{ nome: 'A', valor: 300 }] })
    const { data, error } = await encerrar(c, {
      p_deposit_allocations: [{ charge_id: c.dividas.A, amount: 300 }],
      p_deposit_reason: 'Avaria no para-choque',
    })
    expect(error, error?.message).toBeNull()

    const s = data as { deposit_allocated: number; deposit_remaining: number; credit_remaining: number }
    expect(Number(s.deposit_allocated)).toBe(300)
    expect(Number(s.deposit_remaining)).toBe(200)

    // "Deixar em custódia": o depósito fecha do mesmo jeito (fim do vínculo com o
    // contrato), e o saldo continua visível — `deposit_balances` não filtra closed_at.
    const { data: dep } = await admin().from('deposits').select('closed_at').eq('rental_id', c.rentalId).single()
    expect((dep as { closed_at: string | null }).closed_at).not.toBeNull()
    expect(await saldoDaCaucao(c.rentalId)).toBe(200)
  })

  test('RN-007: a multa e uma dívida comum na MESMA chamada; e a view expõe a origem (RF-001)', async () => {
    const c = await montar({
      caucao: 500,
      multa: { valor: 150, dias: 60 },
      dividas: [{ nome: 'A', valor: 200, origem: 'down_payment' }],
    })

    const { data, error } = await encerrar(c, {
      p_charge_fine: true,
      p_fine_deposit_amount: 150,
      p_deposit_allocations: [{ charge_id: c.dividas.A, amount: 200 }],
      p_deposit_reason: 'Avaria no para-choque',
    })
    expect(error, error?.message).toBeNull()

    const fineId = (data as { fine_charge_id: string }).fine_charge_id
    expect(await saldoDaCobranca(fineId)).toMatchObject({
      status: 'paid', paid_amount: 150, source_module: 'early_termination_fine',
    })
    expect(await saldoDaCobranca(c.dividas.A)).toMatchObject({
      status: 'paid', paid_amount: 200, source_module: 'down_payment',
    })
    expect(await saldoDaCaucao(c.rentalId)).toBe(150)   // 500 − 150 (multa) − 200 (dívida)
  })

  test('compatibilidade: sem os parâmetros novos a RPC encerra como antes (migration sobe antes do app)', async () => {
    const c = await montar({ dividas: [{ nome: 'A', valor: 100 }] })
    const { error } = await encerrar(c)
    expect(error, error?.message).toBeNull()
    expect(await statusDaLocacao(c.rentalId)).not.toBe('active')
    expect(await saldoDaCobranca(c.dividas.A)).toMatchObject({ status: 'open', open_amount: 100 })
  })
})

// ---------------------------------------------------------------------------
// A tela
// ---------------------------------------------------------------------------

async function abrirEncerramento(page: import('@playwright/test').Page, c: Cenario) {
  await page.goto(`/locacoes/${c.rentalId}/encerrar`)
  await waitForPageLoad(page)
  // Spec 0014: km final é obrigatório. O veículo de teste nasce com km 0.
  await page.locator('input[type=number]').first().fill('0')
  await expect(page.getByText('Distribuição de caução e crédito')).toBeVisible({ timeout: 15_000 })
}

test.describe('Tela de encerramento — distribuição dirigida', () => {
  test('CA-001/CA-002/CA-003/CA-010: lista as dívidas, atualiza o resta ao vivo, baixa exatamente o alocado e audita', async ({ page }) => {
    const c = await montar({
      caucao: 500,
      dividas: [
        { nome: 'Entrada', valor: 300, origem: 'down_payment' },
        { nome: 'Despesa', valor: 200, origem: 'expense' },
        { nome: 'Avulsa',  valor: 100, origem: 'manual' },
      ],
    })
    await abrirEncerramento(page, c)

    // CA-001: cada dívida individualmente, com a origem e o valor devido.
    for (const [nome, rotulo, valor] of [
      ['Entrada', 'Entrada', 'R$ 300,00'], ['Despesa', 'Despesa', 'R$ 200,00'], ['Avulsa', 'Manual', 'R$ 100,00'],
    ] as const) {
      const linha = page.locator('tr', { has: page.locator(`#caucao-${c.dividas[nome]}`) })
      await expect(linha).toContainText(rotulo)
      await expect(linha).toContainText(valor)
    }
    await expect(page.getByText('R$ 0,00 de R$ 500,00 alocados')).toBeVisible()

    // CA-002: o alocado e o que resta acompanham a digitação, sem ir ao servidor.
    await page.locator(`#caucao-${c.dividas.Entrada}`).fill('300')
    await expect(page.getByText('R$ 300,00 de R$ 500,00 alocados')).toBeVisible()
    await page.locator(`#caucao-${c.dividas.Despesa}`).fill('200')
    await expect(page.getByText('R$ 500,00 de R$ 500,00 alocados')).toBeVisible()

    await page.locator('#motivo').fill('Avaria no para-choque')
    await page.locator('input[type=checkbox]').check()   // dívida em aberto (a Avulsa)
    await page.getByRole('button', { name: 'Confirmar Encerramento' }).click()

    await expect.poll(() => statusDaLocacao(c.rentalId), { timeout: 20_000 }).not.toBe('active')

    // CA-003/CA-010: exatamente o alocado, e só nas dívidas escolhidas.
    expect(await saldoDaCobranca(c.dividas.Entrada)).toMatchObject({ status: 'paid', paid_amount: 300 })
    expect(await saldoDaCobranca(c.dividas.Despesa)).toMatchObject({ status: 'paid', paid_amount: 200 })
    expect(await saldoDaCobranca(c.dividas.Avulsa)).toMatchObject({ status: 'open', paid_amount: 0 })

    // O autor do abatimento se preserva: as actions que isto substituiu passavam
    // `user.id`, e dentro da RPC isso vira `auth.uid()`.
    const retencoes = await pagamentos(c.customerId, 'deposit_retention')
    expect(retencoes.map((p) => p.amount).sort((a, b) => a - b)).toEqual([200, 300])
    for (const r of retencoes) expect(r.received_by, 'retenção sem autor').not.toBeNull()

    // E a decisão fica na trilha: quem gastou o dinheiro do cliente, onde e por quê.
    //
    // POLL, não leitura direta: a locação vira "encerrada" quando a RPC comita, e
    // `logAction` roda logo DEPOIS, na Server Action. Ler a trilha assim que o
    // status muda pega a janela entre os dois — o teste falhava de vez em quando,
    // e mais quando o dev server estava recompilando a rota.
    const buscarRegistro = async () => {
      const { data: trilha } = await admin()
        .from('audit_logs').select('new_data')
        .eq('table_name', 'rentals').eq('record_id', c.rentalId).eq('action', 'update')
      return ((trilha ?? []) as Array<{ new_data: Record<string, unknown> | null }>)
        .map((r) => r.new_data).find((d) => d && 'deposit_allocations' in d)
    }
    await expect.poll(async () => !!(await buscarRegistro()), {
      timeout: 15_000, message: 'a distribuição não foi auditada',
    }).toBe(true)

    const registro = (await buscarRegistro())!
    expect((registro.deposit_allocations as unknown[]).length).toBe(2)
    expect(registro.deposit_reason).toBe('Avaria no para-choque')
  })

  test('CA-005/CA-006: a tela recusa a caução que passa do limite, mostra onde, e trava o botão', async ({ page }) => {
    const c = await montar({
      caucao: 300, credito: 100,
      dividas: [{ nome: 'A', valor: 200 }, { nome: 'B', valor: 200 }],
    })
    await abrirEncerramento(page, c)
    await page.locator('input[type=checkbox]').check()
    const confirmar = page.getByRole('button', { name: 'Confirmar Encerramento' })
    await expect(confirmar).toBeEnabled()

    // CA-005 / RN-001: caução + crédito somam mais do que A deve. O crédito vai
    // PRIMEIRO porque ele é limitado ao digitar (teste abaixo) — o que estoura a
    // linha é a caução, que continua mostrando o aviso em vez de cortar.
    await page.locator(`#credito-${c.dividas.A}`).fill('100')
    await page.locator(`#caucao-${c.dividas.A}`).fill('150')
    await expect(page.locator('ul[role=alert]')).toContainText('a mais do que ela deve')
    await expect(confirmar).toBeDisabled()

    await page.locator(`#caucao-${c.dividas.A}`).fill('100')
    await expect(page.locator('ul[role=alert]')).toHaveCount(0)
    await expect(confirmar).toBeEnabled()

    // CA-006 / RN-002: cada linha cabe, a soma passa do saldo de caução (300).
    await page.locator(`#credito-${c.dividas.A}`).fill('')
    await page.locator(`#caucao-${c.dividas.A}`).fill('200')
    await page.locator(`#caucao-${c.dividas.B}`).fill('200')
    await expect(page.locator('ul[role=alert]')).toContainText('A caução alocada passa do saldo em R$ 100,00')
    await expect(confirmar).toBeDisabled()

    expect(await statusDaLocacao(c.rentalId)).toBe('active')
  })

  test('CA-007: o crédito digitado nunca passa do saldo — a tela corta o valor, não deixa montar a violação', async ({ page }) => {
    const c = await montar({
      credito: 100,
      dividas: [{ nome: 'A', valor: 300 }, { nome: 'B', valor: 200 }],
    })
    await abrirEncerramento(page, c)
    await page.locator('input[type=checkbox]').check()
    const confirmar = page.getByRole('button', { name: 'Confirmar Encerramento' })

    await page.locator(`#credito-${c.dividas.A}`).fill('80')
    await expect(page.locator(`#credito-${c.dividas.A}`)).toHaveValue('80')

    // Sobram 20 de crédito: digitar 80 na B vira 20, e nenhum aviso aparece.
    await page.locator(`#credito-${c.dividas.B}`).fill('80')
    await expect(page.locator(`#credito-${c.dividas.B}`)).toHaveValue('20.00')
    await expect(page.locator('ul[role=alert]')).toHaveCount(0)
    await expect(page.getByText('R$ 100,00 de R$ 100,00 alocados')).toBeVisible()
    await expect(confirmar).toBeEnabled()

    // Saldo esgotado: nada mais cabe em lugar nenhum.
    await page.locator(`#credito-${c.dividas.A}`).fill('90')
    await expect(page.locator(`#credito-${c.dividas.A}`)).toHaveValue('80.00')
  })

  test('crédito: "Máx." aplica na linha o que cabe agora, e o campo não passa desse teto', async ({ page }) => {
    // Teto de cada linha = o MENOR entre o que a dívida ainda deve (depois da
    // caução) e o saldo que as outras linhas deixaram.
    const c = await montar({
      caucao: 100, credito: 350,
      dividas: [{ nome: 'A', valor: 200 }, { nome: 'B', valor: 300 }, { nome: 'C', valor: 100 }],
    })
    await abrirEncerramento(page, c)

    const campo = (n: 'A' | 'B' | 'C') => page.locator(`#credito-${c.dividas[n]}`)
    const maximo = (n: 'A' | 'B' | 'C') => page.locator(`#credito-max-${c.dividas[n]}`)

    // A caução cobre 50 da A: sobram 150 para o crédito nela, mesmo com 350 de saldo.
    await page.locator(`#caucao-${c.dividas.A}`).fill('50')
    await campo('A').fill('999')
    await expect(campo('A')).toHaveValue('150.00')
    await expect(maximo('A')).toBeDisabled()               // já está no teto

    // A B comporta 300, mas o saldo só deixou 200 (350 − 150).
    await expect(maximo('B')).toBeEnabled()
    await maximo('B').click()
    await expect(campo('B')).toHaveValue('200.00')
    await expect(maximo('B')).toBeDisabled()
    await expect(page.getByText('R$ 350,00 de R$ 350,00 alocados')).toBeVisible()

    // Saldo esgotado: o atalho da C fica desligado e o campo recusa qualquer valor.
    await expect(maximo('C')).toBeDisabled()
    await campo('C').fill('50')
    await expect(campo('C')).toHaveValue('')

    // Liberar crédito na A reabre espaço nas outras: a B passa a comportar 250.
    await campo('A').fill('100')
    await expect(maximo('B')).toBeEnabled()
    await maximo('B').click()
    await expect(campo('B')).toHaveValue('250.00')
    await expect(page.locator('ul[role=alert]')).toHaveCount(0)

    // E o que a tela montou é exatamente o que o servidor aplica.
    await page.locator('#motivo').fill('Diária em aberto')
    await page.locator('input[type=checkbox]').check()
    await page.getByRole('radio', { name: /Deixar em custódia/ }).check()
    await page.getByRole('button', { name: 'Confirmar Encerramento' }).click()

    await expect.poll(() => statusDaLocacao(c.rentalId), { timeout: 20_000 }).not.toBe('active')
    const creditos = await pagamentos(c.customerId, 'credit')
    expect(creditos.map((p) => p.amount).sort((x, y) => x - y)).toEqual([100, 250])
    expect(await saldoDeCredito(c.customerId)).toBe(0)
  })

  test('RF-008/RF-009: sobra de caução e de crédito — a escolha vale, e o que sai do caixa é mostrado antes', async ({ page }) => {
    const c = await montar({ caucao: 500, credito: 200, dividas: [{ nome: 'A', valor: 300 }] })
    await abrirEncerramento(page, c)

    await page.locator(`#caucao-${c.dividas.A}`).fill('300')
    await page.locator('#motivo').fill('Avaria no para-choque')

    // Sem dívida restante, devolver é o padrão da caução; o crédito fica com o cliente.
    await expect(page.getByText('Sobra de caução: R$ 200,00')).toBeVisible()
    await expect(page.getByText('Sobra de crédito: R$ 200,00')).toBeVisible()
    await expect(page.getByRole('radio', { name: /Devolver R\$ 200,00 ao cliente/ })).toBeChecked()
    await expect(page.getByRole('radio', { name: /Deixar como crédito do cliente/ })).toBeChecked()

    // Devolver o crédito também: "Sai do caixa" precisa somar as duas, antes de confirmar.
    await page.getByRole('radio', { name: /Devolver R\$ 200,00 em dinheiro/ }).check()
    await expect(page.locator('div', { hasText: /^Sai do caixa/ }).last()).toContainText('R$ 400,00')

    await page.locator('input[type=checkbox]').check()
    await page.getByRole('button', { name: 'Confirmar Encerramento' }).click()

    await expect.poll(() => statusDaLocacao(c.rentalId), { timeout: 20_000 }).not.toBe('active')
    // A devolução roda DEPOIS do encerramento, em chamadas separadas: espera o razão.
    await expect.poll(() => saldoDaCaucao(c.rentalId), { timeout: 20_000 }).toBe(0)
    await expect.poll(() => saldoDeCredito(c.customerId), { timeout: 20_000 }).toBe(0)

    expect(await saldoDaCobranca(c.dividas.A)).toMatchObject({ status: 'paid', paid_amount: 300 })
  })

  test('RF-008: com dívida em aberto a sobra de caução exige escolha — nunca sai dinheiro por inércia', async ({ page }) => {
    const c = await montar({ caucao: 500, dividas: [{ nome: 'A', valor: 300 }] })
    await abrirEncerramento(page, c)
    await page.locator('input[type=checkbox]').check()

    // Nada distribuído: sobram R$ 500 e o cliente ainda deve R$ 300.
    await expect(page.getByText('O cliente ainda deve R$ 300,00')).toBeVisible()
    await expect(page.getByRole('radio', { name: /Devolver R\$ 500,00 ao cliente/ })).not.toBeChecked()
    await expect(page.getByRole('radio', { name: /Deixar em custódia/ })).not.toBeChecked()

    await page.getByRole('button', { name: 'Confirmar Encerramento' }).click()
    await expect(page.getByText('Decida o que fazer com a caução que sobrou')).toBeVisible()
    expect(await statusDaLocacao(c.rentalId), 'sem escolha, nada pode ter sido encerrado').toBe('active')

    // Deixar em custódia: encerra, o depósito fecha e o saldo segue no razão.
    await page.getByRole('radio', { name: /Deixar em custódia/ }).check()
    await page.getByRole('button', { name: 'Confirmar Encerramento' }).click()
    await expect.poll(() => statusDaLocacao(c.rentalId), { timeout: 20_000 }).not.toBe('active')

    expect(await saldoDaCaucao(c.rentalId)).toBe(500)
    expect(await saldoDaCobranca(c.dividas.A)).toMatchObject({ status: 'open', paid_amount: 0 })
  })

  test('CA-012/RN-007: a multa é uma linha da lista, sem seção de abatimento própria', async ({ page }) => {
    const c = await montar({
      caucao: 500, multa: { valor: 150, dias: 60 },
      dividas: [{ nome: 'A', valor: 200 }],
    })
    await abrirEncerramento(page, c)

    // Antes de decidir cobrar, a multa não é dívida: só a A na lista.
    await expect(page.locator('tbody tr')).toHaveCount(1)

    await page.getByRole('radio', { name: 'Cobrar a multa', exact: true }).check()
    await expect(page.locator('tbody tr')).toHaveCount(2)
    await expect(page.locator('tr', { has: page.locator('#caucao-fine') })).toContainText('Multa por rescisão')

    // O fluxo próprio da Spec 0015 (dois inputs de abatimento dentro da seção da multa) sumiu.
    await expect(page.getByText(/Abater da caução \(disponível/)).toHaveCount(0)
    await expect(page.getByText(/Abater do crédito \(disponível/)).toHaveCount(0)

    await page.locator('#caucao-fine').fill('150')
    await page.locator(`#caucao-${c.dividas.A}`).fill('200')
    await page.locator('#motivo').fill('Avaria no para-choque')
    await page.locator('input[type=checkbox]').check()   // A ainda estava em aberto quando a tela carregou
    await page.getByRole('button', { name: 'Confirmar Encerramento' }).click()

    await expect.poll(() => statusDaLocacao(c.rentalId), { timeout: 20_000 }).not.toBe('active')
    await expect.poll(() => saldoDaCaucao(c.rentalId), { timeout: 20_000 }).toBe(0)

    const { data: multa } = await admin()
      .from('charge_balances').select('status, paid_amount')
      .eq('rental_id', c.rentalId).eq('source_module', 'early_termination_fine').single()
    expect(multa).toMatchObject({ status: 'paid' })
    expect(Number((multa as { paid_amount: number }).paid_amount)).toBe(150)
    expect(await saldoDaCobranca(c.dividas.A)).toMatchObject({ status: 'paid', paid_amount: 200 })
  })
})
