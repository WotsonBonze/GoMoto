import { test, expect } from '@playwright/test'
import {
  TEST_TAG, getSupabaseAdmin, getTestTenantId,
  createTestVehicle, deleteTestVehicle, createTestContract, deleteTestCustomer,
  waitForPageLoad, getModal,
} from './helpers'
import { createCharge } from '../src/lib/financial/charges'
import { receivePayment } from '../src/lib/financial/payments'

/**
 * Crédito do cliente e encargo por atraso — dois fluxos que movimentam dinheiro
 * e nunca tinham sido exercitados.
 *
 * Os dois compartilham a mesma ideia: o valor existe como PROJEÇÃO até alguém
 * decidir realizá-lo. Encargo projetado não é receita; crédito disponível não é
 * abatimento. Só viram lançamento quando o operador confirma — e é exatamente
 * essa transição que nenhum teste cobria.
 */

const admin = () => getSupabaseAdmin()
const RUN = Date.now().toString(36)

let vehicleId = ''
let customerId = ''
let rentalId = ''
const extras: { vehicleId: string; customerId: string; rentalId: string }[] = []

async function saldo(chargeId: string) {
  const { data } = await admin()
    .from('charge_balances')
    .select('status, open_amount, total_amount, paid_amount, is_overdue, days_overdue')
    .eq('charge_id', chargeId)
    .maybeSingle()
  return data as {
    status: string; open_amount: number; total_amount: number; paid_amount: number
    is_overdue: boolean; days_overdue: number
  } | null
}

/** Cobrança já vencida: a data não pode ser alterada depois (Princípio 5). */
async function cobrancaVencida(valor: number, diasAtras: number, cliente = customerId, locacao = rentalId) {
  const tenantId = await getTestTenantId()
  const vencimento = new Date(Date.now() - diasAtras * 864e5).toISOString().slice(0, 10)

  const { chargeId } = await createCharge(admin(), tenantId, {
    customerId: cliente,
    rentalId: locacao,
    dueDate: vencimento,
    sourceModule: 'manual',
    sourceId: crypto.randomUUID(),
    items: [{
      description: `${TEST_TAG} Aluguel ${RUN}`,
      credit_account_code: 'receita_locacao',
      quantity: 1, unit_amount: valor, amount: valor,
    }],
  })
  return chargeId
}

test.describe('Crédito do cliente e encargo por atraso', () => {
  test.beforeAll(async () => {
    const v = await createTestVehicle()
    vehicleId = v.id
    const contrato = await createTestContract(vehicleId)
    customerId = contrato.customerId
    rentalId = contrato.contractId
  })

  test.afterAll(async () => {
    for (const e of extras) {
      await admin().from('customer_credits').delete().eq('customer_id', e.customerId)
      await admin().from('rentals').delete().eq('id', e.rentalId)
      await deleteTestCustomer(e.customerId).catch(() => {})
      await deleteTestVehicle(e.vehicleId).catch(() => {})
    }
    await admin().from('customer_credits').delete().eq('customer_id', customerId)
    await admin().from('rentals').delete().eq('id', rentalId)
    await deleteTestCustomer(customerId).catch(() => {})
    await deleteTestVehicle(vehicleId).catch(() => {})
  })

  test('encargo só vira receita ao receber, com o valor do dia do pagamento', async ({ page }) => {
    const chargeId = await cobrancaVencida(500, 40)

    const antes = await saldo(chargeId)
    expect(antes!.is_overdue, 'setup: a cobrança precisa estar vencida').toBe(true)

    // Enquanto projetado, o encargo NÃO existe no razão.
    const { data: semEncargo } = await admin()
      .from('financial_entries')
      .select('id')
      .eq('charge_id', chargeId)
      .eq('account_code', 'receita_encargos_atraso')

    expect(semEncargo ?? [], 'encargo projetado não pode estar lançado').toEqual([])

    // Receber é o que realiza o encargo. O botão "Consolidar encargo" fazia
    // isso à parte e foi removido: ele recalculava do zero a cada clique — a
    // multa sobre o saldo já acrescido, e os juros de TODOS os dias desde o
    // vencimento original — então dois cliques no mesmo dia cobravam o encargo
    // duas vezes, com base maior na segunda. Não havia guarda nenhuma.
    await page.goto(`/cobrancas/${chargeId}`)
    await waitForPageLoad(page)
    await page.getByRole('button', { name: 'Registrar pagamento' }).click()

    const modal = getModal(page)
    await expect(modal).toBeVisible()

    // Mesma implementação da lista: as duas telas eram modais separados que
    // divergiram — um recusava valor acima do saldo, o outro deixava passar, e
    // um deles mandava o erro pra trás de si. Aqui checamos que a tela de
    // detalhe também mostra o cabeçalho com cobrança e vencimento.
    await expect(modal.getByText(/Cobrança #\d+/)).toBeVisible()
    await expect(modal.getByText('Vencimento')).toBeVisible()

    await modal.getByRole('button', { name: 'Confirmar pagamento' }).click()
    await expect(modal).toBeHidden({ timeout: 15_000 })

    // "Pago em" é a data do RECEBIMENTO, e a cobrança foi recebida HOJE. O
    // campo saía de `status === 'paid' ? due_date : null` — o vencimento com
    // outro rótulo — e ainda passava por `toLocaleString`, que lê "YYYY-MM-DD"
    // como meia-noite UTC: esta cobrança, vencida há 30 dias, aparecia paga um
    // mês atrás, às 21:00 do dia ANTERIOR ao próprio vencimento.
    const hoje = new Date()
    const hojeBR = `${String(hoje.getDate()).padStart(2, '0')}/`
      + `${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`
    const linhaPagoEm = page.locator('tr').filter({ hasText: 'Pago em' })
    await expect(linhaPagoEm, 'a tela precisa dizer quando foi pago').toContainText(hojeBR)

    // Agora sim: item na cobrança e receita no razão.
    const { data: itens } = await admin()
      .from('charge_items')
      .select('amount, credit_account_code, source_module')
      .eq('charge_id', chargeId)
      .eq('source_module', 'late_charge')

    const it = (itens ?? []) as { amount: number; credit_account_code: string }[]
    expect(it.length, 'consolidar não gerou item de encargo').toBe(1)
    expect(it[0]!.credit_account_code).toBe('receita_encargos_atraso')

    const { data: lancamentos } = await admin()
      .from('financial_entries')
      .select('direction, amount')
      .eq('charge_id', chargeId)
      .eq('account_code', 'receita_encargos_atraso')

    const l = (lancamentos ?? []) as { direction: string; amount: number }[]
    expect(l.length, 'encargo realizado sem lançamento').toBe(1)
    expect(l[0]!.direction).toBe('credit')

    // O documento cresce pelo encargo — nem mais, nem menos — e o pagamento
    // quita o principal MAIS o encargo do dia, deixando a cobrança zerada.
    const depois = await saldo(chargeId)
    expect(Number(depois!.total_amount)).toBe(500 + Number(it[0]!.amount))
    expect(
      Number(depois!.open_amount),
      'o valor pago precisa cobrir principal + encargo calculado no dia',
    ).toBe(0)
    expect(Number(depois!.paid_amount)).toBe(500 + Number(it[0]!.amount))

    // E o encargo chega ao resultado do VEÍCULO.
    //
    // As pernas de `late_charge_realized` saíam sem `vehicle_id` enquanto a
    // emissão o carregava. Como `vehicle_financial_position` agrega por essa
    // dimensão, toda receita de atraso simplesmente não entrava no resultado da
    // moto — sem erro, sem log, só um número menor do que deveria. As asserções
    // acima passavam com o defeito no lugar, porque nenhuma olhava a dimensão.
    const { data: pernas } = await admin()
      .from('financial_entries')
      .select('vehicle_id')
      .eq('charge_id', chargeId)
      .eq('account_code', 'receita_encargos_atraso')

    const p = (pernas ?? []) as { vehicle_id: string | null }[]
    expect(p[0]?.vehicle_id, 'encargo lançado sem veículo some do resultado da moto').toBe(vehicleId)

    const { data: posicao } = await admin()
      .from('vehicle_financial_position')
      .select('operating_revenue')
      .eq('vehicle_id', vehicleId)
      .single()

    expect(
      Number((posicao as { operating_revenue: number }).operating_revenue),
      'receita do veículo não incorporou o encargo consolidado',
    ).toBe(500 + Number(it[0]!.amount))
  })

  test('crédito disponível abate a dívida e some do saldo do cliente', async ({ page }) => {
    const tenantId = await getTestTenantId()

    // Cliente próprio: `applyCredits` ataca a cobrança MAIS ANTIGA do cliente,
    // então reaproveitar o cliente do teste anterior faria o crédito cair na
    // cobrança errada — e a asserção olharia para a cobrança que não mudou.
    const v2 = await createTestVehicle()
    const contrato2 = await createTestContract(v2.id)
    extras.push({ vehicleId: v2.id, customerId: contrato2.customerId, rentalId: contrato2.contractId })

    const cliente2 = contrato2.customerId
    const chargeId = await cobrancaVencida(300, 5, cliente2, contrato2.contractId)

    // O crédito precisa do LANÇAMENTO, não só da linha: `customer_credit_balances`
    // agrega o ledger. Inserir só a linha dava saldo zero — foi assim que
    // descobri que a concessão pelo produto também não lançava.
    const { data: credito } = await admin().from('customer_credits').insert({
      tenant_id: tenantId, customer_id: cliente2, amount: 120,
      origin: 'manual_adjustment', reason: `${TEST_TAG} Crédito ${RUN}`,
    }).select('id').single()

    await admin().rpc('post_financial_transaction', {
      p_tenant_id: tenantId,
      p_transaction: {
        event_type: 'credit_granted',
        description: `${TEST_TAG} Crédito concedido`,
        source_module: 'customer_credit',
        source_id: (credito as { id: string }).id,
      },
      p_entries: [
        { account_code: 'despesa_operacional', direction: 'debit', amount: 120, customer_id: cliente2 },
        { account_code: 'creditos_de_clientes', direction: 'credit', amount: 120, customer_id: cliente2 },
      ],
    })

    const antes = await saldo(chargeId)
    expect(Number(antes!.open_amount)).toBe(300)

    await page.goto(`/cobrancas/${chargeId}`)
    await waitForPageLoad(page)
    await page.getByRole('button', { name: 'Aplicar crédito' }).click()

    const modal = getModal(page)
    await expect(modal).toBeVisible()
    // O valor não vem preenchido: o operador informa quanto aplicar, e o
    // placeholder mostra o disponível.
    await modal.locator('input[type=number]').fill('120')
    await modal.getByRole('button', { name: 'Aplicar crédito' }).click()
    await expect(modal).toBeHidden({ timeout: 15_000 })

    // A dívida cai pelo crédito aplicado, e SÓ pelo crédito: aplicar crédito
    // não realiza encargo por atraso (esse é o registro de pagamento, na data
    // do recebimento — ver 'Aplicar crédito não realiza encargo' abaixo). O
    // documento continua devendo o principal, sem multa nem juros lançados.
    const depois = await saldo(chargeId)
    expect(Number(depois!.paid_amount)).toBe(120)
    expect(Number(depois!.total_amount), 'aplicar crédito não pode gravar encargo').toBe(300)
    expect(
      Number(depois!.open_amount),
      'crédito não abateu a dívida',
    ).toBeCloseTo(180, 2)

    // E o passivo com o cliente é baixado no razão — crédito é dívida NOSSA
    // com ele, então aplicá-lo debita `creditos_de_clientes`.
    const { data: lancamentos } = await admin()
      .from('financial_entries')
      .select('direction, amount')
      .eq('charge_id', chargeId)
      .eq('account_code', 'creditos_de_clientes')

    const l = (lancamentos ?? []) as { direction: string; amount: number }[]
    expect(l.length, 'aplicação de crédito sem lançamento').toBe(1)
    expect(l[0]!.direction).toBe('debit')
    expect(Number(l[0]!.amount)).toBe(120)

    // O saldo de crédito do cliente zera: não pode ser aplicado duas vezes.
    const { data: saldoCredito } = await admin()
      .from('customer_credit_balances')
      .select('balance')
      .eq('customer_id', cliente2)
      .maybeSingle()

    expect(
      // `available` não existe: a view expõe `balance`. Enquanto o nome estava
      // errado, o PostgREST devolvia erro, `?? 0` engolia, e a asserção passava
      // sem olhar nada.
      Number((saldoCredito as { balance: number } | null)?.balance ?? 0),
      'crédito continuou disponível depois de aplicado',
    ).toBe(0)
  })

  test('receber cobrança vencida realiza o encargo sozinho, sem saldo negativo', async ({ page }) => {
    // O encargo nasce do relógio e não é gravado (Princípio 4). Isso criava um
    // descompasso no recebimento: a tela oferecia "principal + encargo", o
    // documento devia só o principal, e `open_amount` é `total − alocado` SEM
    // piso em zero. Pagar o valor sugerido empurrava o saldo para negativo e o
    // encargo nunca virava receita.
    //
    // Consolidar deixou de ser pré-requisito: receber realiza o acumulado
    // primeiro. O encargo é devido por contrato desde o atraso — não é decisão
    // de quem recebe.
    const chargeId = await cobrancaVencida(400, 10)

    const antes = await saldo(chargeId)
    expect(Number(antes!.total_amount)).toBe(400)

    await page.goto(`/cobrancas/${chargeId}`)
    await waitForPageLoad(page)

    // O valor sugerido inclui o encargo — é o que o operador aceita por padrão.
    await page.getByRole('button', { name: 'Registrar pagamento' }).click()
    const modal = getModal(page)
    await expect(modal).toBeVisible()

    const sugerido = Number(await modal.locator('input[type=number]').inputValue())
    expect(sugerido, 'a tela deveria sugerir principal + encargo').toBeGreaterThan(400)

    await modal.getByRole('button', { name: /confirmar pagamento/i }).click()
    await expect(modal).toBeHidden({ timeout: 15_000 })

    const depois = await saldo(chargeId)

    // O total subiu para incluir o encargo realizado…
    expect(
      Number(depois!.total_amount),
      'encargo não foi realizado no recebimento',
    ).toBeCloseTo(sugerido, 2)

    // …e a cobrança fecha exatamente em zero, nunca negativa.
    expect(Number(depois!.paid_amount)).toBeCloseTo(sugerido, 2)
    expect(Number(depois!.open_amount), 'saldo negativo ou sobra após o pagamento').toBe(0)

    // O encargo virou receita de verdade.
    const { data: lancamento } = await admin()
      .from('financial_entries')
      .select('amount')
      .eq('charge_id', chargeId)
      .eq('account_code', 'receita_encargos_atraso')
      .maybeSingle()

    expect(lancamento, 'encargo cobrado sem virar receita').not.toBeNull()
  })

  test('quitar com crédito NÃO realiza o encargo do atraso', async ({ page }) => {
    // Assimetria proposital, e não a antiga: quem realiza encargo é o registro
    // de PAGAMENTO, sempre na data do recebimento (`realizeAccruedBefore` com
    // `paidAt`). Aplicar crédito não tem campo de data — só existe "agora" — e
    // gravar juros de hoje ali quebrava a reconciliação de um pagamento
    // retroativo: operador abre uma cobrança vencida que o cliente já pagou
    // (fora do sistema) antes do vencimento, aplica o desconto com o saldo
    // dele, e o juros de HOJE virava item permanente da cobrança. Registrar o
    // restante com a data retroativa (dentro do prazo) recalculava tudo
    // certo — só que o juros já lançado pelo crédito não voltava atrás, porque
    // tinha deixado de ser projeção. Ver `applyCustomerCredits`.
    const tenantId = await getTestTenantId()

    const v = await createTestVehicle()
    const contrato = await createTestContract(v.id)
    extras.push({ vehicleId: v.id, customerId: contrato.customerId, rentalId: contrato.contractId })

    const chargeId = await cobrancaVencida(500, 20, contrato.customerId, contrato.contractId)

    const { data: credito } = await admin().from('customer_credits').insert({
      tenant_id: tenantId, customer_id: contrato.customerId, amount: 100,
      origin: 'manual_adjustment', reason: `${TEST_TAG} Crédito ${RUN}`,
    }).select('id').single()

    await admin().rpc('post_financial_transaction', {
      p_tenant_id: tenantId,
      p_transaction: {
        event_type: 'credit_granted',
        description: `${TEST_TAG} Crédito concedido`,
        source_module: 'customer_credit',
        source_id: (credito as { id: string }).id,
      },
      p_entries: [
        { account_code: 'despesa_operacional',  direction: 'debit',  amount: 100, customer_id: contrato.customerId },
        { account_code: 'creditos_de_clientes', direction: 'credit', amount: 100, customer_id: contrato.customerId },
      ],
    })

    const antes = await saldo(chargeId)
    expect(Number(antes!.total_amount)).toBe(500)

    await page.goto(`/cobrancas/${chargeId}`)
    await waitForPageLoad(page)
    await page.getByRole('button', { name: 'Aplicar crédito' }).click()

    const modal = getModal(page)
    await expect(modal).toBeVisible()
    await modal.locator('input[type=number]').fill('100')
    await modal.getByRole('button', { name: 'Aplicar crédito' }).click()
    await expect(modal).toBeHidden({ timeout: 15_000 })

    const depois = await saldo(chargeId)

    // O total NÃO sobe: crédito não é evento de realização de encargo.
    expect(
      Number(depois!.total_amount),
      'quitar com crédito não pode realizar o encargo do atraso',
    ).toBe(500)

    // E não há lançamento de receita de encargo vindo desta operação.
    const { data: encargo } = await admin()
      .from('financial_entries')
      .select('amount')
      .eq('charge_id', chargeId)
      .eq('account_code', 'receita_encargos_atraso')
      .maybeSingle()

    expect(encargo, 'crédito não pode gerar receita de encargo').toBeNull()

    // O crédito foi consumido e o saldo devido cai por ele.
    expect(Number(depois!.paid_amount)).toBe(100)
    expect(Number(depois!.open_amount)).toBeCloseTo(Number(depois!.total_amount) - 100, 2)
  })
})

/**
 * A regra final: aplicar crédito só realiza encargo quando o valor pedido
 * AVANÇA sobre o que já é dívida lançada (`open_amount`) — ou seja, quando o
 * crédito está cobrindo (total ou parcialmente) o juros ainda em projeção.
 * Abater só até `open_amount` é desconto puro e não toca o encargo.
 *
 * Os dois casos vivem lado a lado porque são o mesmo mecanismo visto de dois
 * ângulos: o primeiro teste reproduz o caso relatado ao vivo (cobrança vencida
 * no sistema, mas paga fora dele antes do vencimento — o crédito é só parte de
 * um desconto, o resto vem por pagamento retroativo, e nada disso pode gerar
 * juros); o segundo prova que, quando o crédito É a quitação inteira da
 * cobrança, o juros até hoje entra na conta — do contrário, quitar 100% com
 * crédito seria uma forma de escapar do encargo que já correu.
 *
 * Antes da correção anterior a esta: aplicar qualquer crédito realizava o
 * encargo com base em HOJE (`new Date()`, sem campo de data no modal),
 * gravando juros permanentes mesmo num desconto parcial. Depois da correção
 * anterior, crédito nunca realizava encargo — nem quando quitava tudo,
 * abrindo espaço para pagar uma cobrança vencida 100% em crédito sem nunca
 * pagar o juros que já tinha corrido.
 */
test.describe('Aplicar crédito só realiza encargo quando avança sobre ele', () => {
  let v3 = ''
  let c3 = ''
  let r3 = ''

  test.beforeAll(async () => {
    const veiculo = await createTestVehicle()
    v3 = veiculo.id
    const contrato = await createTestContract(v3)
    c3 = contrato.customerId
    r3 = contrato.contractId
  })

  test.afterAll(async () => {
    await admin().from('customer_credits').delete().eq('customer_id', c3)
    await admin().from('rentals').delete().eq('id', r3)
    await deleteTestCustomer(c3).catch(() => {})
    await deleteTestVehicle(v3).catch(() => {})
  })

  test('crédito seguido de pagamento retroativo dentro do prazo não cobra juros', async ({ page }) => {
    const tenantId = await getTestTenantId()

    // Vencida há 10 dias no sistema — mas o cliente pagou antes disso.
    const chargeId = await cobrancaVencida(500, 10, c3, r3)
    const { data: chargeRow } = await admin().from('charges').select('due_date').eq('id', chargeId).single()
    const dueDate = (chargeRow as { due_date: string }).due_date

    // Concede R$ 200 de crédito ao cliente — é o "desconto" que o operador vai
    // abater na cobrança.
    const { data: credito } = await admin().from('customer_credits').insert({
      tenant_id: tenantId, customer_id: c3, amount: 200,
      origin: 'manual_adjustment', reason: `${TEST_TAG} Crédito retroativo ${RUN}`,
    }).select('id').single()

    await admin().rpc('post_financial_transaction', {
      p_tenant_id: tenantId,
      p_transaction: {
        event_type: 'credit_granted',
        description: `${TEST_TAG} Crédito concedido`,
        source_module: 'customer_credit',
        source_id: (credito as { id: string }).id,
      },
      p_entries: [
        { account_code: 'despesa_operacional',  direction: 'debit',  amount: 200, customer_id: c3 },
        { account_code: 'creditos_de_clientes', direction: 'credit', amount: 200, customer_id: c3 },
      ],
    })

    await page.goto(`/cobrancas/${chargeId}`)
    await waitForPageLoad(page)

    // Passo 1: aplica o desconto com o saldo do cliente.
    await page.getByRole('button', { name: 'Aplicar crédito' }).click()
    const creditModal = getModal(page)
    await expect(creditModal).toBeVisible()
    await creditModal.locator('input[type=number]').fill('200')
    await creditModal.getByRole('button', { name: 'Aplicar crédito' }).click()
    await expect(creditModal).toBeHidden({ timeout: 15_000 })

    // Só o crédito abateu — nenhum juros de hoje pode ter sido gravado.
    const aposCredito = await saldo(chargeId)
    expect(Number(aposCredito!.total_amount), 'aplicar crédito não pode gravar encargo').toBe(500)
    expect(Number(aposCredito!.open_amount)).toBeCloseTo(300, 2)

    // Passo 2: registra o restante com a data em que o cliente REALMENTE
    // pagou — dois dias antes do vencimento, portanto dentro do prazo.
    await page.getByRole('button', { name: 'Registrar pagamento' }).click()
    const payModal = getModal(page)
    await expect(payModal).toBeVisible()

    const [ano, mes, dia] = dueDate.split('-').map(Number)
    const dataRetroativa = new Date(ano!, mes! - 1, dia! - 2)
    const campoData = payModal.locator('input[type="date"]')
    await campoData.fill(
      `${dataRetroativa.getFullYear()}-`
      + `${String(dataRetroativa.getMonth() + 1).padStart(2, '0')}-`
      + `${String(dataRetroativa.getDate()).padStart(2, '0')}`,
    )

    // Pago em dia: a tela não pode sugerir multa nem juros.
    await expect(payModal.getByText('Valor devido')).toBeVisible()
    await expect(payModal.getByText(/dias de atraso/)).toHaveCount(0)

    const valorSugerido = Number(await payModal.locator('input[type="number"]').inputValue())
    expect(valorSugerido, 'pagamento em dia não pode incluir juros').toBe(300)

    await payModal.getByRole('button', { name: /confirmar pagamento/i }).click()
    await expect(payModal).toBeHidden({ timeout: 15_000 })

    // Nada de encargo em NENHUMA das duas pernas do recebimento.
    const final = await saldo(chargeId)
    expect(Number(final!.total_amount), 'nenhum encargo deveria ter sido lançado').toBe(500)
    expect(Number(final!.open_amount)).toBe(0)
    expect(Number(final!.paid_amount)).toBe(500)

    const { data: encargos } = await admin()
      .from('charge_items')
      .select('id')
      .eq('charge_id', chargeId)
      .eq('source_module', 'late_charge')
    expect(encargos ?? [], 'pagamento em dia não pode gerar item de encargo').toEqual([])
  })

  test('quitar a cobrança inteira com crédito realiza o juros até hoje', async ({ page }) => {
    const tenantId = await getTestTenantId()

    // Vencida há 15 dias, sem nenhum pagamento anterior.
    const chargeId = await cobrancaVencida(400, 15, c3, r3)

    // Crédito generoso — mais do que a cobrança pode chegar a valer — para o
    // teto do modal ser o total devido HOJE (juros incluído), não o saldo.
    const { data: credito } = await admin().from('customer_credits').insert({
      tenant_id: tenantId, customer_id: c3, amount: 1000,
      origin: 'manual_adjustment', reason: `${TEST_TAG} Crédito quitação total ${RUN}`,
    }).select('id').single()

    await admin().rpc('post_financial_transaction', {
      p_tenant_id: tenantId,
      p_transaction: {
        event_type: 'credit_granted',
        description: `${TEST_TAG} Crédito concedido`,
        source_module: 'customer_credit',
        source_id: (credito as { id: string }).id,
      },
      p_entries: [
        { account_code: 'despesa_operacional',  direction: 'debit',  amount: 1000, customer_id: c3 },
        { account_code: 'creditos_de_clientes', direction: 'credit', amount: 1000, customer_id: c3 },
      ],
    })

    await page.goto(`/cobrancas/${chargeId}`)
    await waitForPageLoad(page)
    await page.getByRole('button', { name: 'Aplicar crédito' }).click()

    const modal = getModal(page)
    await expect(modal).toBeVisible()

    // O atalho existe porque o saldo cobre o total devido hoje — clicar nele
    // preenche o valor que inclui o juros, deixando a decisão explícita.
    await modal.getByRole('button', { name: /Quitar a cobrança inteira agora/ }).click()

    // E o aviso de que este valor lança encargo precisa estar na tela ANTES
    // de confirmar — não só no extrato, depois.
    await expect(modal.getByText(/inclui juros até hoje/)).toBeVisible()

    const valorPreenchido = Number(await modal.locator('input[type=number]').inputValue())
    expect(valorPreenchido, 'o atalho preenche o total com juros, não só o principal').toBeGreaterThan(400)

    await modal.getByRole('button', { name: 'Aplicar crédito' }).click()
    await expect(modal).toBeHidden({ timeout: 15_000 })

    // O total da cobrança cresceu: o juros virou item de verdade.
    const depois = await saldo(chargeId)
    expect(Number(depois!.total_amount), 'quitar tudo com crédito precisa realizar o juros').toBeGreaterThan(400)
    expect(Number(depois!.open_amount), 'quitação total não pode sobrar saldo').toBe(0)
    expect(Number(depois!.paid_amount)).toBeCloseTo(Number(depois!.total_amount), 2)

    const { data: encargo } = await admin()
      .from('financial_entries')
      .select('amount')
      .eq('charge_id', chargeId)
      .eq('account_code', 'receita_encargos_atraso')
      .maybeSingle()
    expect(encargo, 'juros não virou receita').not.toBeNull()
  })
})

/**
 * Os juros pagos são os do DIA DO PAGAMENTO.
 *
 * A cobrança é emitida, o cliente paga quando pode, e o encargo cobrado tem que
 * refletir o atraso até aquele dia — nem o do vencimento, nem o de hoje.
 *
 * `realizeAccruedBefore` recebe `paidAt` e o repassa como `asOf` para
 * `calculateAccruedCharges`. É isso que se prova aqui, com a mesma dívida
 * quitada em datas diferentes.
 */
test.describe('Encargo segue a data do pagamento', () => {
  test('pagar mais tarde custa mais, na proporção dos dias', async () => {
    const tenantId = await getTestTenantId()

    // Duas cobranças idênticas: mesmo valor, mesmo vencimento.
    const cedo  = await cobrancaVencida(1000, 30)
    const tarde = await cobrancaVencida(1000, 30)

    const emT30 = new Date(); emT30.setHours(12, 0, 0, 0)
    const emT60 = new Date(emT30); emT60.setDate(emT60.getDate() + 30)

    // A primeira é quitada hoje (30 dias de atraso).
    const b1 = await saldo(cedo)
    await receivePayment(admin(), tenantId, {
      customerId, amount: Number(b1!.open_amount), method: 'pix', paidAt: emT30,
      allocations: [{ chargeId: cedo, amount: Number(b1!.open_amount) }],
    }).catch(() => { /* o encargo entra antes de alocar; valor exato abaixo */ })

    const encargoDe = async (chargeId: string) => {
      const { data } = await admin()
        .from('charge_items')
        .select('amount')
        .eq('charge_id', chargeId)
        .eq('source_module', 'late_charge')
      return ((data ?? []) as { amount: number }[]).reduce((s, i) => s + Number(i.amount), 0)
    }

    const encargo30 = await encargoDe(cedo)
    expect(encargo30, 'atraso de 30 dias precisa gerar encargo').toBeGreaterThan(0)

    // A segunda é quitada 30 dias depois (60 de atraso).
    const b2 = await saldo(tarde)
    await receivePayment(admin(), tenantId, {
      customerId, amount: Number(b2!.open_amount), method: 'pix', paidAt: emT60,
      allocations: [{ chargeId: tarde, amount: Number(b2!.open_amount) }],
    }).catch(() => { /* idem */ })

    const encargo60 = await encargoDe(tarde)

    // Multa é única (mesma base, mesmo valor); os juros dobram com o dobro dos
    // dias. Então o encargo de 60 dias é maior, mas NÃO é o dobro.
    expect(encargo60, 'pagar depois tem que custar mais').toBeGreaterThan(encargo30)
    expect(encargo60, 'o encargo não pode dobrar: a multa é cobrada uma vez só')
      .toBeLessThan(encargo30 * 2)
  })

  test('pagar sem atraso não gera encargo nenhum', async () => {
    const tenantId = await getTestTenantId()
    const emDia = await cobrancaVencida(400, -5)   // vence daqui a 5 dias

    const b = await saldo(emDia)
    await receivePayment(admin(), tenantId, {
      customerId, amount: Number(b!.open_amount), method: 'pix', paidAt: new Date(),
      allocations: [{ chargeId: emDia, amount: Number(b!.open_amount) }],
    })

    const { data } = await admin()
      .from('charge_items')
      .select('id')
      .eq('charge_id', emDia)
      .eq('source_module', 'late_charge')

    expect(data ?? [], 'cobrança em dia não pode ganhar encargo').toEqual([])
    expect(Number((await saldo(emDia))!.open_amount)).toBe(0)
  })
})

/**
 * O modal mostra a conta dos juros, e ela muda com a data do recebimento.
 *
 * Os dois modais exibiam só "Valor devido". Juros são conta que o cliente vai
 * querer conferir: "R$ 360,47" não se discute, "350,00 de principal, 7,00 de
 * multa e 3,47 de juros por 30 dias" se confere.
 *
 * E o cabeçalho da LISTA mostrava `amount_due` calculado para HOJE enquanto o
 * campo de valor já usava a data escolhida — mudar a data alterava o que seria
 * cobrado e o cabeçalho seguia afirmando outro número.
 */
/**
 * Cobrança com descrição ÚNICA, para a busca da lista isolá-la.
 *
 * Filtrar por número não serve: a busca casa por substring, e "312" aparece em
 * 1312, 3120… Todas as cobranças da rodada compartilham a mesma descrição.
 */
async function cobrancaBuscavel(valor: number, diasAtras: number, marca: string) {
  const tenantId = await getTestTenantId()
  const vencimento = new Date(Date.now() - diasAtras * 864e5).toISOString().slice(0, 10)
  const { chargeId } = await createCharge(admin(), tenantId, {
    customerId, rentalId, dueDate: vencimento,
    sourceModule: 'manual', sourceId: crypto.randomUUID(),
    items: [{
      description: marca,
      credit_account_code: 'receita_locacao',
      quantity: 1, unit_amount: valor, amount: valor,
    }],
  })
  return { chargeId, vencimento }
}

test.describe('Detalhamento do encargo no recebimento', () => {
  // Fixtures próprias: o `afterAll` do primeiro bloco apaga cliente, locação e
  // veículo, e as variáveis de módulo passam a apontar para linhas que já não
  // existem.
  test.beforeAll(async () => {
    const v = await createTestVehicle()
    vehicleId = v.id
    const contrato = await createTestContract(vehicleId)
    customerId = contrato.customerId
    rentalId = contrato.contractId
  })

  test.afterAll(async () => {
    await admin().from('customer_credits').delete().eq('customer_id', customerId)
    await admin().from('rentals').delete().eq('id', rentalId)
    await deleteTestCustomer(customerId).catch(() => {})
    await deleteTestVehicle(vehicleId).catch(() => {})
  })

  test('a tela mostra principal, multa, juros e dias — e refaz tudo ao mudar a data', async ({ page }) => {
    const marca = `${TEST_TAG} Detalhe30 ${Date.now().toString(36)}`
    const { vencimento } = await cobrancaBuscavel(350, 30, marca)

    await page.goto('/cobrancas')
    await waitForPageLoad(page)

    await page.getByPlaceholder(/cliente, placa ou número/i).fill(marca)
    // Filtrado, sobra uma linha: o único botão de receber é o dela.
    await expect(page.getByTitle('Registrar pagamento')).toHaveCount(1)
    await page.getByTitle('Registrar pagamento').click()

    const modal = getModal(page)
    await expect(modal).toBeVisible()

    // O vencimento no cabeçalho: sem ele o operador não sabe QUAL data gerou o
    // encargo que está prestes a cobrar, e teria de fechar o modal pra conferir.
    const [ano, mes, dia] = vencimento.split('-')
    await expect(modal.getByText(`${dia}/${mes}/${ano}`)).toBeVisible()

    // Quantos dias a tela diz, sem fixar o número: `toISOString` devolve UTC e
    // o cálculo usa data local, então "30 dias atrás" pode render 29. O que
    // importa é a tela mostrar os dias e REFAZER a conta ao mudar a data.
    const textoDias = modal.locator('text=/\\d+ dias? de atraso/')
    await expect(textoDias, 'a tela precisa dizer quantos dias de atraso').toBeVisible()

    const diasIniciais = Number((await textoDias.innerText()).match(/(\d+) dias?/)![1])
    expect(diasIniciais).toBeGreaterThan(25)

    await expect(modal.getByText('Principal')).toBeVisible()
    await expect(modal.getByText('Multa')).toBeVisible()

    const campoData  = modal.locator('input[type="date"]')
    const campoValor = modal.locator('input[type="number"]')

    const valorInicial = Number(await campoValor.inputValue())
    expect(valorInicial, 'o valor tem que incluir o encargo').toBeGreaterThan(350)

    // Recuando 20 dias, o atraso encolhe na mesma medida e os juros caem.
    const antes = new Date()
    antes.setDate(antes.getDate() - 20)
    await campoData.fill(
      `${antes.getFullYear()}-${String(antes.getMonth() + 1).padStart(2, '0')}-${String(antes.getDate()).padStart(2, '0')}`,
    )

    await expect(
      modal.locator(`text=/${diasIniciais - 20} dias? de atraso/`),
      'os dias de atraso precisam acompanhar a data escolhida',
    ).toBeVisible()

    const valorRecuado = Number(await campoValor.inputValue())
    expect(valorRecuado, 'menos dias de atraso, menos juros').toBeLessThan(valorInicial)
    expect(valorRecuado, 'a multa é única: o valor não pode cair abaixo do principal')
      .toBeGreaterThan(350)
  })

  test('cobrança em dia não mostra multa nem juros', async ({ page }) => {
    const marca = `${TEST_TAG} EmDia ${Date.now().toString(36)}`
    await cobrancaBuscavel(200, -5, marca)   // vence daqui a 5 dias

    await page.goto('/cobrancas')
    await waitForPageLoad(page)

    await page.getByPlaceholder(/cliente, placa ou número/i).fill(marca)
    // Filtrado, sobra uma linha: o único botão de receber é o dela.
    await expect(page.getByTitle('Registrar pagamento')).toHaveCount(1)
    await page.getByTitle('Registrar pagamento').click()

    const modal = getModal(page)
    await expect(modal).toBeVisible()
    await expect(modal.getByText('Valor devido')).toBeVisible()
    await expect(modal.getByText(/dias de atraso/)).toHaveCount(0)
  })
})
