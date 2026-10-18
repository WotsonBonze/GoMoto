/**
 * Confirmação de pagamento vinda do gateway — dinheiro de terceiro entrando
 * pelo webhook, sem ninguém olhando.
 *
 * O caminho `approved` do webhook fazia quatro requisições HTTP separadas ao
 * PostgREST: inseria em `payments`, inseria a alocação, lançava no razão e
 * marcava o intent como `paid`. Nada de transação em volta. Cada forma de
 * falhar no meio produzia um estrago diferente — cobrança quitada sem caixa no
 * razão, caixa no razão sem cobrança quitada — e todas tinham o mesmo agravante:
 *
 * o guarda de idempotência perguntava pelo status do INTENT, que é o último dos
 * quatro passos. Se a execução morreu antes dele, a retentativa do provedor
 * passava direto pelo guarda e criava um SEGUNDO recebimento do mesmo dinheiro.
 * Provedor de pagamento reentrega por design; isto não era hipótese remota.
 *
 * `fn_confirm_gateway_payment` faz os quatro passos numa transação e ancora a
 * idempotência no fato que não pode faltar — o pagamento ligado ao intent.
 *
 * O que se prova aqui: a segunda entrega do mesmo evento não move nada, o
 * dinheiro chega inteiro ao razão e ao saldo, e o estorno pelo gateway devolve
 * tudo ao estado anterior.
 */

import { test, expect } from '@playwright/test'
import {
  TEST_TAG, getSupabaseAdmin, getTestTenantId,
  createTestVehicle, deleteTestVehicle, createTestContract, deleteTestCustomer,
} from './helpers'
import { createCharge } from '../src/lib/financial/charges'
import { reversePayment } from '../src/lib/financial/payments'

const admin = () => getSupabaseAdmin()
const RUN = Date.now().toString(36)

let vehicleId = ''
let customerId = ''
let rentalId = ''
let accountId = ''

/**
 * Remove a conta do provedor e o que depende dela.
 *
 * `payment_intents.provider_account_id` é `ON DELETE RESTRICT`: apagar a conta
 * direto falha assim que um teste tiver gerado uma tentativa. Como o erro do
 * `afterAll` não era conferido, a falha passava despercebida e cada execução
 * deixava mais uma conta ATIVA no banco — resíduo que chegou a mudar o
 * resultado de um teste que perguntava "existe conta ativa?".
 */
async function removerContaProvedor(accountId: string) {
  if (!accountId) return
  await admin().from('payment_intents').delete().eq('provider_account_id', accountId)
  const { error } = await admin().from('payment_provider_accounts').delete().eq('id', accountId)
  if (error) console.warn(`[limpeza] conta ${accountId} sobreviveu: ${error.message}`)
}

async function saldo(chargeId: string) {
  const { data } = await admin()
    .from('charge_balances')
    .select('status, total_amount, paid_amount, open_amount')
    .eq('charge_id', chargeId)
    .single()
  return data as { status: string; total_amount: number; paid_amount: number; open_amount: number }
}

/** Soma líquida de uma conta para um pagamento — o que o razão enxerga. */
async function caixaDoPagamento(paymentId: string): Promise<number> {
  const { data } = await admin()
    .from('financial_entries')
    .select('amount_signed, financial_transactions!inner(source_id)')
    .eq('account_code', 'caixa_e_bancos')
    .eq('financial_transactions.source_id', paymentId)
  return ((data ?? []) as { amount_signed: number }[])
    .reduce((s, e) => s + Number(e.amount_signed), 0)
}

/** Cria cobrança + intent pendente, como o `payment-intent` faria. */
async function cobrancaComIntent(valor: number) {
  const tenantId = await getTestTenantId()
  const charge = await createCharge(admin(), tenantId, {
    customerId,
    rentalId,
    dueDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    sourceModule: 'manual',
    items: [{
      description: `${TEST_TAG} Gateway ${RUN}`,
      credit_account_code: 'receita_locacao',
      quantity: 1, unit_amount: valor, amount: valor,
    }],
  })

  const { data: intent, error } = await admin()
    .from('payment_intents')
    .insert({
      tenant_id: tenantId, charge_id: charge.chargeId, provider: 'mercadopago',
      provider_account_id: accountId, provider_intent_id: `mp-${RUN}-${valor}`,
      amount: valor, status: 'pending', method: 'pix',
    })
    .select('id')
    .single()
  if (error) throw new Error(`intent: ${error.message}`)

  return { tenantId, chargeId: charge.chargeId, intentId: (intent as { id: string }).id }
}

/** Uma entrega do evento `approved`, exatamente como o webhook a faz. */
async function entregaEvento(tenantId: string, intentId: string, valor: number) {
  const { data, error } = await admin().rpc('fn_confirm_gateway_payment', {
    p_tenant_id: tenantId,
    p_intent_id: intentId,
    p_amount: valor,
    p_paid_at: new Date().toISOString(),
  })
  if (error) throw new Error(`confirmação: ${error.message}`)
  return data as string
}

test.beforeAll(async () => {
  const tenantId = await getTestTenantId()
  const v = await createTestVehicle()
  vehicleId = v.id
  const contract = await createTestContract(vehicleId)
  customerId = contract.customerId
  rentalId = contract.contractId

  const { data, error } = await admin()
    .from('payment_provider_accounts')
    .insert({
      tenant_id: tenantId, provider: 'mercadopago',
      external_account_id: `teste-${RUN}`,
    })
    .select('id')
    .single()
  if (error) throw new Error(`conta do provedor: ${error.message}`)
  accountId = (data as { id: string }).id
})

test.afterAll(async () => {
  await removerContaProvedor(accountId)
  await deleteTestCustomer(customerId)
  await deleteTestVehicle(vehicleId)
})

test.describe('Confirmação do gateway', () => {
  test('uma entrega quita a cobrança e lança o caixa no razão', async () => {
    const { tenantId, chargeId, intentId } = await cobrancaComIntent(250)

    const antes = await saldo(chargeId)
    expect(antes.open_amount).toBe(250)

    const paymentId = await entregaEvento(tenantId, intentId, 250)

    const depois = await saldo(chargeId)
    expect(depois.open_amount).toBe(0)
    expect(depois.status).toBe('paid')
    expect(await caixaDoPagamento(paymentId)).toBe(250)

    const { data: intent } = await admin()
      .from('payment_intents').select('status').eq('id', intentId).single()
    expect((intent as { status: string }).status).toBe('paid')
  })

  test('a REENTREGA do mesmo evento não cria um segundo recebimento', async () => {
    const { tenantId, chargeId, intentId } = await cobrancaComIntent(400)

    const primeiro = await entregaEvento(tenantId, intentId, 400)
    const segundo = await entregaEvento(tenantId, intentId, 400)
    const terceiro = await entregaEvento(tenantId, intentId, 400)

    // Sempre o mesmo pagamento: a função devolve o que já existe.
    expect(segundo).toBe(primeiro)
    expect(terceiro).toBe(primeiro)

    const { count: pagamentos } = await admin()
      .from('payments').select('id', { count: 'exact', head: true })
      .eq('payment_intent_id', intentId)
    expect(pagamentos, 'reentrega duplicou o pagamento').toBe(1)

    const { count: alocacoes } = await admin()
      .from('payment_allocations').select('id', { count: 'exact', head: true })
      .eq('payment_id', primeiro)
    expect(alocacoes, 'reentrega duplicou a alocação').toBe(1)

    const { count: lancamentos } = await admin()
      .from('financial_transactions').select('id', { count: 'exact', head: true })
      .eq('source_module', 'payment').eq('source_id', primeiro)
    expect(lancamentos, 'reentrega duplicou o recebimento no razão').toBe(1)

    // E o cliente não foi creditado duas vezes.
    const s = await saldo(chargeId)
    expect(s.paid_amount).toBe(400)
    expect(await caixaDoPagamento(primeiro)).toBe(400)
  })

  test('o banco recusa um segundo pagamento para o mesmo intent', async () => {
    // A garantia não pode depender só do código da função: é o índice único que
    // torna a duplicata impossível, inclusive para quem inserir por fora.
    const { tenantId, chargeId, intentId } = await cobrancaComIntent(120)
    await entregaEvento(tenantId, intentId, 120)

    const { error } = await admin().from('payments').insert({
      tenant_id: tenantId, customer_id: customerId, amount: 120,
      method: 'pix', paid_at: new Date().toISOString(), payment_intent_id: intentId,
    })

    expect(error, 'o banco aceitou dois pagamentos para o mesmo intent').not.toBeNull()
    expect(error?.code).toBe('23505')
    void chargeId
  })

  test('estorno pelo gateway devolve o saldo e zera o caixa', async () => {
    const { tenantId, chargeId, intentId } = await cobrancaComIntent(180)
    const paymentId = await entregaEvento(tenantId, intentId, 180)

    expect((await saldo(chargeId)).open_amount).toBe(0)

    // É o mesmo caminho que o webhook usa para `refunded`/`charged_back`.
    await reversePayment(admin(), tenantId, paymentId, 'Gateway: refunded (teste)')

    const depois = await saldo(chargeId)
    expect(depois.open_amount, 'a dívida não voltou após o estorno').toBe(180)
    expect(depois.status).toBe('open')
    expect(await caixaDoPagamento(paymentId), 'o caixa não voltou a zero').toBe(0)

    // O pagamento não some — fica marcado. Documento emitido não se apaga.
    const { data: p } = await admin()
      .from('payments').select('reversed_at').eq('id', paymentId).single()
    expect((p as { reversed_at: string | null }).reversed_at).not.toBeNull()
  })

  /**
   * ADR 0030 (G-05): `fn_confirm_gateway_payment` tinha `p_method DEFAULT 'pix'`
   * e o webhook nunca passava nada. Um pagamento de outro meio entraria no razão
   * como PIX. Enquanto só existe PIX o defeito é invisível — e é exatamente por
   * isso que ele precisa morrer antes do segundo gateway.
   */
  test('o método do pagamento vem do intent, não é assumido como pix', async () => {
    const tenantId = await getTestTenantId()
    const charge = await createCharge(admin(), tenantId, {
      customerId, rentalId,
      dueDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
      sourceModule: 'manual',
      items: [{
        description: `${TEST_TAG} Metodo ${RUN}`,
        credit_account_code: 'receita_locacao',
        quantity: 1, unit_amount: 130, amount: 130,
      }],
    })

    const { data: intent, error: intentErr } = await admin()
      .from('payment_intents')
      .insert({
        tenant_id: tenantId, charge_id: charge.chargeId, provider: 'mercadopago',
        provider_account_id: accountId, provider_intent_id: `mp-metodo-${RUN}`,
        amount: 130, status: 'pending', method: 'credit_card',
      })
      .select('id').single()
    if (intentErr) throw new Error(`intent: ${intentErr.message}`)

    const paymentId = await entregaEvento(tenantId, (intent as { id: string }).id, 130)

    const { data: pay } = await admin()
      .from('payments').select('method').eq('id', paymentId).single()
    expect((pay as { method: string }).method, 'gravou pix para um pagamento de cartão').toBe('credit_card')
  })

  test('valor não positivo é recusado', async () => {
    const { tenantId, intentId } = await cobrancaComIntent(90)
    const { error } = await admin().rpc('fn_confirm_gateway_payment', {
      p_tenant_id: tenantId, p_intent_id: intentId,
      p_amount: 0, p_paid_at: new Date().toISOString(),
    })
    expect(error?.message).toContain('AMOUNT_MUST_BE_POSITIVE')
  })
})

/**
 * Pagar com atraso pelo app não pode deixar saldo negativo.
 *
 * O QR é gerado por `calculateAmountDue`: principal MAIS o encargo do atraso. O
 * cliente paga esse valor. Mas `fn_confirm_gateway_payment` só alocava o
 * recebido, sem transformar o encargo em item — a cobrança continuava devendo
 * apenas o principal.
 *
 * Reproduzido antes da correção: cobrança de R$ 350 vencida há 30 dias, app
 * cobrando R$ 360,47, cliente pagando, e o resultado era `open_amount = −10,47`
 * com R$ 0,00 de receita de encargo. O encargo sumia do DRE e o saldo ficava
 * negativo — exatamente o defeito que `realizeAccruedBefore` já havia corrigido
 * no recebimento manual, e que o caminho do gateway não tinha.
 */
test.describe('Gateway com cobrança em atraso', () => {
  test('o encargo do QR vira item, e a cobrança fica quitada — não negativa', async () => {
    const tenantId = await getTestTenantId()

    const vencimento = new Date()
    vencimento.setDate(vencimento.getDate() - 30)
    const venceEm = vencimento.toISOString().slice(0, 10)

    const { data: politica } = await admin()
      .from('late_charge_policies').select('id').eq('tenant_id', tenantId).limit(1).maybeSingle()

    const charge = await createCharge(admin(), tenantId, {
      customerId, rentalId,
      dueDate: venceEm,
      sourceModule: 'manual',
      items: [{
        description: `${TEST_TAG} Atrasada gateway ${RUN}`,
        credit_account_code: 'receita_locacao',
        quantity: 1, unit_amount: 350, amount: 350,
      }],
    })

    await admin().from('charges')
      .update({ late_charge_policy_id: (politica as { id: string }).id })
      .eq('id', charge.chargeId)

    // O QR cobra principal + encargo, e a tentativa guarda quanto é encargo.
    const encargo = 350 * 0.02 + Math.round(350 * 0.000330 * 30 * 100) / 100
    const devido = Math.round((350 + encargo) * 100) / 100

    const { data: intent, error } = await admin()
      .from('payment_intents')
      .insert({
        tenant_id: tenantId, charge_id: charge.chargeId, provider: 'mercadopago',
        provider_account_id: accountId, provider_intent_id: `mp-atraso-${RUN}`,
        amount: devido, accrued_amount: Math.round(encargo * 100) / 100,
        status: 'pending', method: 'pix',
      })
      .select('id').single()
    if (error) throw new Error(`intent: ${error.message}`)

    const paymentId = await entregaEvento(tenantId, (intent as { id: string }).id, devido)

    const s = await saldo(charge.chargeId)
    expect(s.total_amount, 'o encargo não virou item da cobrança').toBe(devido)
    expect(s.paid_amount).toBe(devido)
    expect(s.open_amount, 'saldo negativo: pagou mais do que a cobrança devia').toBe(0)
    expect(s.status).toBe('paid')

    // E o encargo entrou no resultado como receita.
    const { data: receita } = await admin()
      .from('financial_entries')
      .select('amount_signed')
      .eq('charge_id', charge.chargeId)
      .eq('account_code', 'receita_encargos_atraso')

    const total = ((receita ?? []) as { amount_signed: number }[])
      .reduce((acc, e) => acc - Number(e.amount_signed), 0)
    expect(total, 'encargo pago pelo app não virou receita').toBeCloseTo(encargo, 2)

    // A dimensão do veículo precisa ir junto, senão o encargo some do ROI.
    const { data: pernas } = await admin()
      .from('financial_entries')
      .select('vehicle_id, financial_transactions!inner(event_type)')
      .eq('charge_id', charge.chargeId)
      .eq('financial_transactions.event_type', 'late_charge_realized')

    const p = (pernas ?? []) as { vehicle_id: string | null }[]
    expect(p.length).toBe(2)
    for (const perna of p) {
      expect(perna.vehicle_id, 'encargo sem veículo some do resultado da moto').toBe(vehicleId)
    }
    void paymentId
  })

  test('cobrança em dia pelo gateway não ganha encargo', async () => {
    const { tenantId, chargeId, intentId } = await cobrancaComIntent(275)
    await entregaEvento(tenantId, intentId, 275)

    const { data } = await admin()
      .from('charge_items').select('id')
      .eq('charge_id', chargeId).eq('source_module', 'late_charge')

    expect(data ?? [], 'cobrança em dia ganhou encargo').toEqual([])
    expect((await saldo(chargeId)).open_amount).toBe(0)
  })
})
