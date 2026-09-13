import { test, expect } from '@playwright/test'
import {
  TEST_TAG, getSupabase, getSupabaseAdmin, getTestTenantId, createTestVehicle, deleteTestVehicle,
  createTestCustomer, deleteTestCustomer, waitForPageLoad,
} from './helpers'
import { createCharge } from '../src/lib/financial/charges'

/**
 * Cobranças de locação — filtros e encerramento antecipado (Spec 0014).
 *
 * RN-003 (Spec 0010) ganha uma expressão mais limpa no modelo novo. Antes,
 * "cancelar cobranças futuras preservando Entrada e Caução" exigia excluir
 * `billing_type IN ('deposit','down_payment')` do UPDATE — a regra vivia num
 * filtro de query.
 *
 * Agora ela cai por si: período futuro ainda é linha de CRONOGRAMA e é
 * cancelado; Entrada e Caução são DOCUMENTOS emitidos e, por serem imutáveis
 * (Princípio 5), sobrevivem sem tratamento especial.
 */

const RUN_ID = Date.now().toString(36)

let vehicleId = ''
let customerId = ''
let rentalId = ''

test.describe('Cobranças — filtros da listagem', () => {
  test('filtro por status exibe apenas cobranças do status selecionado', async ({ page }) => {
    await page.goto('/cobrancas')
    await waitForPageLoad(page)

    await page.getByRole('button', { name: 'Vencidas' }).click()

    const rows = page.locator('tbody tr')
    const count = await rows.count()

    for (let i = 0; i < count; i++) {
      const row = rows.nth(i)
      const text = await row.textContent()
      if (text?.includes('Nenhuma cobrança')) continue
      // A aba de vencidas só mostra linha com atraso — derivado de due_date,
      // não de status armazenado (Princípio 4).
      await expect(row).toContainText(/\d+d/)
    }
  })

  test('aba de encerradas agrupa canceladas e baixadas', async ({ page }) => {
    await page.goto('/cobrancas')
    await waitForPageLoad(page)

    // 'prejudice' virou 'written_off', e cancelamento entrou no mesmo grupo:
    // ambos saem de contas a receber.
    await page.getByRole('button', { name: 'Encerradas' }).click()
    await expect(page.getByRole('button', { name: 'Encerradas' })).toBeVisible()
  })
})

test.describe('Encerramento antecipado preserva garantias emitidas (RN-003)', () => {
  test.beforeAll(async () => {
    const vehicle = await createTestVehicle()
    const customer = await createTestCustomer()
    vehicleId = vehicle.id
    customerId = customer.id
  })

  test.afterAll(async () => {
    await deleteTestCustomer(customerId).catch(() => {})
    await deleteTestVehicle(vehicleId).catch(() => {})
  })

  test('cancela cronograma futuro e preserva Entrada e Caução', async ({ page }) => {
    const sb = await getSupabase()
    const tenantId = await getTestTenantId()

    // Locação com um período já vencido e dois futuros.
    const { data: newRentalId, error } = await sb.rpc('create_rental_with_schedule', {
      p_tenant_id: tenantId,
      p_rental: {
        customer_id: customerId,
        vehicle_id: vehicleId,
        start_date: '2026-08-10',
        end_date: '2026-11-10',
        cycle: 'monthly',
        cycle_amount: 500,
        due_day: 10,
        use_pro_rata: false,
        contract_type: 'rental',
      },
      p_schedule: [
        { sequence_number: 1, period_start: '2026-08-10', period_end: '2026-09-09', due_date: '2026-08-10', amount: 500 },
        { sequence_number: 2, period_start: '2026-09-10', period_end: '2026-10-09', due_date: '2026-09-10', amount: 500 },
        { sequence_number: 3, period_start: '2026-10-10', period_end: '2026-11-09', due_date: '2026-10-10', amount: 500 },
      ],
    })
    if (error) throw new Error(`Erro ao criar locação: ${error.message}`)
    rentalId = newRentalId as string

    // Caução e Entrada nascem como cobranças EMITIDAS. A caução credita
    // passivo; a entrada credita receita (Spec 0010).
    for (const g of [
      { desc: `${TEST_TAG} Caução ${RUN_ID}`, account: 'caucoes_a_devolver', amount: 300, mod: 'deposit' },
      { desc: `${TEST_TAG} Entrada ${RUN_ID}`, account: 'receita_locacao', amount: 150, mod: 'down_payment' },
    ]) {
      // Origem única por garantia: Caução e Entrada nascem da mesma locação,
      // então precisam de identificadores distintos. `createCharge` cuida do
      // número, do item e do lançamento — o INSERT direto que estava aqui
      // deixava as duas sem razão.
      await createCharge(sb, tenantId, {
        customerId,
        rentalId,
        dueDate: '2026-10-01',
        sourceModule: g.mod,
        sourceId: crypto.randomUUID(),
        items: [{
          description: g.desc,
          credit_account_code: g.account,
          quantity: 1, unit_amount: g.amount, amount: g.amount,
        }],
      })
    }

    // Encerra antes do vencimento dos períodos futuros.
    await page.goto(`/locacoes/${rentalId}/encerrar`)
    await waitForPageLoad(page)
    await page.locator('input[type=date]').first().fill('2026-08-20')
    // Spec 0014: km final é obrigatório em todo encerramento. O veículo de
    // teste nasce com km_current = 0 e a locação não passa km_initial — 0
    // satisfaz o piso.
    await page.locator('input[type=number]').first().fill('0')

    // A apuração é carregada por hook: espera o valor em aberto aparecer antes
    // de procurar a confirmação. Sem isso o teste lê a tela ainda vazia.
    // O valor aparece duas vezes — no painel e no aviso de confirmação —
    // então a asserção é sobre a linha do painel, não sobre o texto solto.
    const linhaAberto = page.locator('div', { hasText: /^Cobranças em aberto/ }).last()
    await expect(linhaAberto).toContainText('R$ 450,00', { timeout: 10_000 })

    // Com débito em aberto, encerrar exige confirmação explícita (F-08).
    const force = page.locator('input[type=checkbox]')
    await expect(force).toBeVisible({ timeout: 10_000 })
    await force.check()

    // Com caução emitida E lançada, encerrar exige dizer para onde o dinheiro
    // do cliente vai — a seção só aparece quando há saldo de caução, e o
    // fixture antigo a escondia por não lançar no razão.
    //
    // A devolução integral passou a ser ESCOLHA explícita: desde a ADR 0026 o
    // padrão da tela é abater, porque devolver dinheiro a quem deve é a ordem
    // errada. Este teste é sobre garantias emitidas sobreviverem ao
    // encerramento, e para isso as cobranças precisam continuar em aberto —
    // então aqui se devolve, de propósito.
    await expect(page.getByText('Destino da caução')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('radio', { name: /Devolver tudo/ }).check()

    await page.getByRole('button', { name: 'Confirmar Encerramento' }).click()

    // A asserção é sobre o RESULTADO, não sobre a URL: com a liquidação da
    // caução no meio, a revalidação da própria rota chega antes do
    // `router.push`, e `/encerrar` responde 404 porque a locação já não está
    // ativa. Esperar a navegação testaria a corrida, não o encerramento.
    await expect.poll(async () => {
      const { data } = await sb.from('rentals').select('status').eq('id', rentalId).single()
      return (data as { status: string } | null)?.status
    }, { timeout: 15_000 }).not.toBe('active')

    // Cronograma futuro cancelado.
    const { data: schedule } = await sb
      .from('rental_billing_schedules')
      .select('sequence_number, status')
      .eq('rental_id', rentalId)
      .order('sequence_number')

    const lines = (schedule ?? []) as { sequence_number: number; status: string }[]
    expect(lines.find((l) => l.sequence_number === 2)?.status).toBe('cancelled')
    expect(lines.find((l) => l.sequence_number === 3)?.status).toBe('cancelled')

    // Garantias sobrevivem: são documentos emitidos, e o encerramento não
    // toca em documento (Princípio 5).
    const { data: charges } = await sb
      .from('charge_balances')
      .select('charge_id, status, open_amount')
      .eq('rental_id', rentalId)

    const abertas = (charges ?? []) as { status: string; open_amount: number }[]
    expect(abertas.length).toBe(2)
    for (const c of abertas) {
      expect(c.status).toBe('open')
      expect(Number(c.open_amount)).toBeGreaterThan(0)
    }
  })
})

test.describe('Reter caução só existe contra dívida (ADR 0026)', () => {
  /**
   * `closeRentalFinancial` lançava `deposit_retained` pelo valor inteiro e
   * chamava `allocateWithoutCash` ignorando o `unallocated`. Sem dívida — ou com
   * dívida menor que a retenção — sobrava `contas_a_receber` creditado sem
   * contrapartida e um `payments` sem alocação: a empresa com o dinheiro, o
   * razão dizendo que o cliente tem a receber, e nenhuma cobrança quitada.
   *
   * A guarda mora em `fn_retain_deposit_on_charge`, não na tela: a Server Action
   * é chamável direto, e invariante de dinheiro não mora no cliente (ADR 0024).
   */
  let vId = ''
  let cId = ''
  let rId = ''

  test.beforeAll(async () => {
    const v = await createTestVehicle()
    const c = await createTestCustomer()
    vId = v.id
    cId = c.id
  })

  test.afterAll(async () => {
    await getSupabaseAdmin().from('rental_billing_schedules').delete().eq('rental_id', rId)
    await getSupabaseAdmin().from('rentals').delete().eq('id', rId)
    await deleteTestCustomer(cId).catch(() => {})
    await deleteTestVehicle(vId).catch(() => {})
  })

  test('a RPC recusa reter acima do que a cobrança deve', async () => {
    const sb = getSupabaseAdmin()
    const tenantId = await getTestTenantId()
    const hoje = new Date().toISOString().slice(0, 10)

    const { data: novoId, error } = await sb.rpc('create_rental_with_schedule', {
      p_tenant_id: tenantId,
      p_rental: {
        customer_id: cId, vehicle_id: vId,
        start_date: hoje, end_date: new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10),
        cycle: 'monthly', cycle_amount: 500, due_day: 10, use_pro_rata: false, contract_type: 'rental',
      },
      p_schedule: [],
    })
    if (error) throw new Error(`Setup: ${error.message}`)
    rId = novoId as string

    // Caução de 800 recebida, pelo mesmo caminho do produto.
    const { chargeId } = await createCharge(sb, tenantId, {
      customerId: cId, rentalId: rId, dueDate: hoje,
      sourceModule: 'deposit', sourceId: crypto.randomUUID(),
      items: [{
        description: `${TEST_TAG} Caução`, credit_account_code: 'caucoes_a_devolver',
        quantity: 1, unit_amount: 800, amount: 800, vehicle_id: vId,
      }],
    })
    await sb.from('deposits').insert({
      tenant_id: tenantId, rental_id: rId, customer_id: cId, amount: 800, charge_id: chargeId,
    })
    await sb.rpc('post_financial_transaction', {
      p_tenant_id: tenantId,
      p_transaction: { event_type: 'payment_received', description: `${TEST_TAG} Caução recebida`, source_module: 'deposit', source_id: rId },
      p_entries: [
        { account_code: 'caixa_e_bancos',   direction: 'debit',  amount: 800, rental_id: rId, customer_id: cId, vehicle_id: vId, charge_id: chargeId },
        { account_code: 'contas_a_receber', direction: 'credit', amount: 800, rental_id: rId, customer_id: cId, vehicle_id: vId, charge_id: chargeId },
      ],
    })

    // Uma dívida de 200 — bem menor que a caução de 800.
    const { chargeId: dividaId } = await createCharge(sb, tenantId, {
      customerId: cId, rentalId: rId, dueDate: hoje,
      sourceModule: 'manual', sourceId: crypto.randomUUID(),
      items: [{
        description: `${TEST_TAG} Diária avulsa`, credit_account_code: 'receita_locacao',
        quantity: 1, unit_amount: 200, amount: 200, vehicle_id: vId,
      }],
    })

    // Reter 500 numa cobrança que deve 200: é o caso que produzia recebível sem
    // lastro. O banco recusa, e nada é gravado.
    const { error: excedeu } = await sb.rpc('fn_retain_deposit_on_charge', {
      p_tenant_id: tenantId, p_rental_id: rId, p_charge_id: dividaId,
      p_amount: 500, p_reason: 'Avaria', p_created_by: null,
    })
    expect(excedeu?.message ?? '', 'reter acima da dívida precisa ser recusado').toContain('AMOUNT_EXCEEDS_CHARGE')

    const { data: semPagamento } = await sb
      .from('payments').select('id').eq('customer_id', cId).eq('method', 'deposit_retention')
    expect((semPagamento ?? []).length, 'a recusa não pode deixar pagamento órfão').toBe(0)

    // Até o limite da dívida, passa — e vira abatimento de verdade.
    const { error: dentro } = await sb.rpc('fn_retain_deposit_on_charge', {
      p_tenant_id: tenantId, p_rental_id: rId, p_charge_id: dividaId,
      p_amount: 200, p_reason: 'Avaria no para-choque', p_created_by: null,
    })
    expect(dentro, 'reter dentro da dívida precisa passar').toBeNull()

    const { data: saldo } = await sb
      .from('charge_balances').select('open_amount').eq('charge_id', dividaId).maybeSingle()
    expect(Number((saldo as { open_amount: number } | null)?.open_amount), 'a retenção não abateu a cobrança').toBe(0)

    const { data: caucao } = await sb
      .from('deposit_balances').select('balance').eq('rental_id', rId).maybeSingle()
    expect(Number((caucao as { balance: number } | null)?.balance), 'o passivo da caução não caiu').toBe(600)
  })
})

test.describe('Encerramento liquida a caução', () => {
  // `closeRentalFinancial` existia com toda a lógica e NENHUM chamador: a tela
  // de encerrar mostrava o saldo da caução e não oferecia como resolvê-lo, então
  // o dinheiro do cliente ficava como passivo para sempre. Confirmado no banco:
  // `caucoes_a_devolver` só tinha lançamento de entrada, nunca de saída.
  let vId = ''
  let cId = ''
  let rId = ''

  test.beforeAll(async () => {
    const v = await createTestVehicle()
    const c = await createTestCustomer()
    vId = v.id
    cId = c.id
  })

  test.afterAll(async () => {
    await getSupabaseAdmin().from('rental_billing_schedules').delete().eq('rental_id', rId)
    await getSupabaseAdmin().from('rentals').delete().eq('id', rId)
    await deleteTestCustomer(cId).catch(() => {})
    await deleteTestVehicle(vId).catch(() => {})
  })

  test('retenção parcial move o passivo e cobra a diferença do cliente', async ({ page }) => {
    const sb = getSupabaseAdmin()
    const tenantId = await getTestTenantId()

    const hoje = new Date().toISOString().slice(0, 10)
    const { data: novoId, error } = await sb.rpc('create_rental_with_schedule', {
      p_tenant_id: tenantId,
      p_rental: {
        customer_id: cId, vehicle_id: vId,
        start_date: hoje, end_date: new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10),
        cycle: 'monthly', cycle_amount: 500, due_day: 10, use_pro_rata: false, contract_type: 'rental',
      },
      p_schedule: [],
    })
    if (error) throw new Error(`Setup: ${error.message}`)
    rId = novoId as string

    // Caução recebida: entra como PASSIVO, não receita.
    //
    // Emitida por `createCharge`, o mesmo caminho do produto. O INSERT direto
    // que estava aqui pulava o lançamento no razão e deixava cobrança órfã —
    // o estado que `reconciliacao.spec.ts` proíbe, e que num fixture vira
    // ruído indistinguível de defeito real.
    const origem = crypto.randomUUID()
    const { chargeId } = await createCharge(sb, tenantId, {
      customerId: cId,
      rentalId: rId,
      dueDate: hoje,
      sourceModule: 'deposit',
      sourceId: origem,
      items: [{
        description: `${TEST_TAG} Caução`,
        credit_account_code: 'caucoes_a_devolver',
        quantity: 1, unit_amount: 800, amount: 800,
        vehicle_id: vId,
      }],
    })
    await sb.from('deposits').insert({
      tenant_id: tenantId, rental_id: rId, customer_id: cId, amount: 800, charge_id: chargeId,
    })
    // O recebimento: a emissão já creditou `caucoes_a_devolver` e debitou
    // `contas_a_receber`; pagar move de a-receber para caixa.
    await sb.rpc('post_financial_transaction', {
      p_tenant_id: tenantId,
      p_transaction: { event_type: 'payment_received', description: `${TEST_TAG} Caução recebida`, source_module: 'deposit', source_id: rId },
      p_entries: [
        { account_code: 'caixa_e_bancos',    direction: 'debit',  amount: 800, rental_id: rId, customer_id: cId, vehicle_id: vId, charge_id: chargeId },
        { account_code: 'contas_a_receber',  direction: 'credit', amount: 800, rental_id: rId, customer_id: cId, vehicle_id: vId, charge_id: chargeId },
      ],
    })

    const saldoInicial = await sb.from('deposit_balances').select('balance').eq('rental_id', rId).maybeSingle()
    expect(Number((saldoInicial.data as { balance: number } | null)?.balance)).toBe(800)

    // Encerra retendo 300 e devolvendo 500.
    await page.goto(`/locacoes/${rId}/encerrar`)
    await waitForPageLoad(page)
    // Spec 0014: km final é obrigatório em todo encerramento.
    await page.locator('input[type=number]').first().fill('0')

    await expect(page.getByText('Destino da caução')).toBeVisible({ timeout: 10_000 })
    // O rótulo mudou de "Reter parte" para "Abater parte da dívida" (ADR 0026):
    // reter É abater, e o nome antigo sugeria que a empresa ficava com o dinheiro.
    await page.getByRole('radio', { name: /Abater parte da dívida/ }).check()
    await page.locator('#retido').fill('300')
    await page.locator('#motivo').fill('Avaria no para-choque')

    // A própria cobrança da caução está em aberto, e com débito pendente o
    // encerramento exige confirmação explícita (F-08).
    await page.locator('input[type=checkbox]').check()

    await page.getByRole('button', { name: 'Confirmar Encerramento' }).click()
    await page.waitForURL((u) => new URL(u).pathname === '/locacoes', { timeout: 15_000 })

    // O passivo zera: 800 recebidos − 300 retidos − 500 devolvidos.
    const saldoFinal = await sb.from('deposit_balances').select('balance').eq('rental_id', rId).maybeSingle()
    expect(
      Number((saldoFinal.data as { balance: number } | null)?.balance ?? 0),
      'caução continuou como passivo depois do encerramento',
    ).toBe(0)

    const { data: entries } = await sb
      .from('financial_entries')
      .select('account_code, direction, amount')
      .eq('rental_id', rId)
      .eq('account_code', 'caucoes_a_devolver')

    const rows = (entries ?? []) as { direction: string; amount: number }[]
    const debitos = rows.filter((e) => e.direction === 'debit')
    expect(debitos.map((e) => Number(e.amount)).sort((a, b) => a - b), 'faltou retenção ou devolução').toEqual([300, 500])

    // E a retenção precisa ABATER a dívida, não só mexer no razão.
    //
    // `deposit_retained` credita `contas_a_receber`, mas `charge_balances` é
    // `itens − ALOCAÇÕES`: sem o par pagamento+alocação a cobrança seguia
    // integralmente em aberto. Ao vivo, reter R$ 400 contra R$ 893,47 deixou o
    // razão dizendo 493,47 e a tela de cobranças dizendo 893,47 — a empresa com
    // o dinheiro e o sistema cobrando de novo.
    //
    // As asserções acima passavam com o defeito no lugar, porque nenhuma
    // olhava o saldo da cobrança.
    const { data: pagamentos } = await sb
      .from('payments')
      .select('id, amount, method')
      .eq('customer_id', cId)
      .eq('method', 'deposit_retention')

    const pg = (pagamentos ?? []) as { id: string; amount: number }[]
    expect(pg.length, 'retenção não virou abatimento da dívida do cliente').toBe(1)
    expect(Number(pg[0]!.amount)).toBe(300)

    const { data: alocacoes } = await sb
      .from('payment_allocations')
      .select('amount')
      .eq('payment_id', pg[0]!.id)

    const alocado = ((alocacoes ?? []) as { amount: number }[])
      .reduce((s, a) => s + Number(a.amount), 0)
    expect(alocado, 'retenção registrada sem alocar em cobrança alguma').toBe(300)

    // A dívida em aberto cai exatamente o que foi alocado — esta é a garantia
    // que importa, e a que faltava.
    //
    // Comparar o saldo das cobranças com o recebível do razão seria mais forte,
    // mas não vale AQUI: este fixture registra o recebimento da caução direto
    // no razão, sem par pagamento+alocação, então as duas fontes já nascem
    // separadas por construção do próprio teste.
    const { data: saldos } = await sb
      .from('charge_balances').select('charge_id, total_amount, open_amount').eq('rental_id', rId)
    const linhas = (saldos ?? []) as { total_amount: number; open_amount: number }[]

    const totalEmitido = linhas.reduce((s, c) => s + Number(c.total_amount), 0)
    const emAberto     = linhas.reduce((s, c) => s + Number(c.open_amount), 0)

    expect(
      Number((totalEmitido - emAberto).toFixed(2)),
      'a retenção não abateu a dívida do cliente',
    ).toBe(alocado)
  })
})
