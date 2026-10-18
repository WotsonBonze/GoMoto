/**
 * Dinheiro que chega para cobrança cancelada — ADR 0033, Questão 1.
 *
 * Cancelar reverte a emissão no razão, mas o código de pagamento continuava
 * vivo no provedor. Quem pagasse depois via `fn_confirm_gateway_payment`
 * alocar normalmente e lançar crédito em `contas_a_receber` — que a reversão já
 * tinha zerado. O recebível do cliente ficava NEGATIVO: os livros passavam a
 * afirmar que a locadora devia a ele, sem ninguém ter decidido isso.
 *
 * DECIDIDO pelo humano em 2026-09-07: vira crédito do cliente. Cancelar é dizer
 * "você não deve isto", então o dinheiro que chega depois é dele.
 *
 * Recusar nunca foi opção — a ADR 0024 exige que o que entrou seja reconhecido.
 */

import { test, expect } from '@playwright/test'
import { TEST_TAG, getSupabaseAdmin, getTestTenantId } from './helpers'
import { cancelCharge } from '../src/lib/financial/charges'

const admin = () => getSupabaseAdmin()
const sufixo = Date.now().toString().slice(-9)

let tenantId = ''
let customerId = ''
let contaId = ''

/** Cria cobrança + tentativa pendente + evento, prontos para confirmar. */
async function montarCobranca(valor: number, marca: string) {
  const { data: cobranca } = await admin().rpc('fn_create_charge', {
    p_tenant_id: tenantId,
    p_charge: {
      customer_id: customerId, due_date: new Date().toISOString().slice(0, 10),
      source_module: 'manual', source_id: crypto.randomUUID(),
    },
    p_items: [{
      description: `${TEST_TAG} ${marca}`, credit_account_code: 'receita_locacao',
      quantity: 1, unit_amount: valor, amount: valor,
    }],
  })
  const chargeId = (cobranca as { charge_id: string }).charge_id

  const { data: evento } = await admin().from('gateway_events').insert({
    tenant_id: tenantId, provider: 'cora', provider_event_id: `cancel-${sufixo}-${marca}`,
    event_type: 'invoice.PAID', payload: {}, signature_valid: false,
    processed_at: null, accepted_without_verification: false,
    processing_error: null, attempts: 0, outcome: null,
  }).select('id').single()

  const { data: intentId } = await admin().rpc('fn_open_payment_intent', {
    p_tenant_id: tenantId, p_charge_id: chargeId, p_provider: 'cora',
    p_provider_account_id: contaId, p_method: 'pix',
    p_provider_intent_id: `inv-${sufixo}-${marca}`, p_amount: valor,
    p_accrued_amount: 0, p_expires_at: null, p_payload: {},
  })

  return { chargeId, intentId: intentId as string, eventId: (evento as { id: string }).id }
}

async function confirmar(intentId: string, eventId: string, valor: number) {
  const { data, error } = await admin().rpc('fn_confirm_gateway_payment', {
    p_tenant_id: tenantId, p_intent_id: intentId, p_amount: valor,
    p_paid_at: new Date().toISOString(), p_method: null,
    p_notes: 'Confirmado pelo gateway',
    p_gateway_event_id: eventId, p_provider: 'cora',
  })
  if (error) throw new Error(`confirmação falhou: ${error.message}`)
  return data as string
}

/** Saldo de uma conta do razão para este cliente, nesta cobrança. */
async function saldoNoRazao(conta: string, chargeId: string) {
  const { data } = await admin()
    .from('financial_entries')
    .select('amount_signed')
    .eq('account_code', conta)
    .eq('charge_id', chargeId)
  return ((data ?? []) as { amount_signed: number }[])
    .reduce((s, e) => s + Number(e.amount_signed), 0)
}

test.beforeAll(async () => {
  tenantId = await getTestTenantId()
  const { data: c } = await admin()
    .from('customers').select('id').eq('tenant_id', tenantId).limit(1).single()
  customerId = (c as { id: string }).id

  contaId = crypto.randomUUID()
  await admin().from('payment_provider_accounts').insert({
    id: contaId, tenant_id: tenantId, provider: 'cora',
    external_account_id: `cancel-${sufixo}`, active: true, is_default: false,
  })
})

test.describe('Pagamento de cobrança cancelada (ADR 0033 Q1)', () => {
  test('vira crédito do cliente, e não recebível negativo', async () => {
    const { chargeId, intentId, eventId } = await montarCobranca(120, 'cancelada')

    // Cancela pelo caminho do produto: status + reversão da emissão.
    await admin().from('charges')
      .update({ status: 'cancelled', cancellation_reason: `${TEST_TAG} teste` })
      .eq('id', chargeId)
    await admin().rpc('post_financial_transaction', {
      p_tenant_id: tenantId,
      p_transaction: {
        event_type: 'charge_cancelled', description: `${TEST_TAG} cancelamento`,
        source_module: 'charge', source_id: chargeId,
      },
      p_entries: [
        { account_code: 'receita_locacao', direction: 'debit', amount: 120,
          customer_id: customerId, charge_id: chargeId },
        { account_code: 'contas_a_receber', direction: 'credit', amount: 120,
          customer_id: customerId, charge_id: chargeId },
      ],
    })

    const { data: creditoAntes } = await admin()
      .from('customer_credit_balances').select('balance')
      .eq('tenant_id', tenantId).eq('customer_id', customerId).maybeSingle()
    const antes = Number((creditoAntes as { balance: number } | null)?.balance ?? 0)

    // O cliente paga o Pix que continuava vivo.
    const paymentId = await confirmar(intentId, eventId, 120)

    // 1. O dinheiro foi reconhecido (ADR 0024), com a ressalva no próprio registro.
    const { data: pagamento } = await admin()
      .from('payments').select('amount, notes').eq('id', paymentId).single()
    const p = pagamento as { amount: number; notes: string }
    expect(Number(p.amount)).toBe(120)
    expect(p.notes).toContain('cancelada')

    // 2. NÃO alocou. Alocar contra cobrança cancelada é o que criava o negativo.
    const { count: alocacoes } = await admin()
      .from('payment_allocations').select('id', { count: 'exact', head: true })
      .eq('payment_id', paymentId)
    expect(alocacoes ?? 0, 'alocou contra uma cobrança cancelada').toBe(0)

    // 3. Virou crédito, ligado ao pagamento que o originou.
    const { data: credito } = await admin()
      .from('customer_credits').select('amount, origin').eq('payment_id', paymentId).single()
    const cr = credito as { amount: number; origin: string }
    expect(Number(cr.amount)).toBe(120)
    expect(cr.origin).toBe('cancelled_charge')

    // 4. O RECEBÍVEL desta cobrança não ficou negativo — o defeito original.
    expect(await saldoNoRazao('contas_a_receber', chargeId),
      'contas_a_receber ficou negativo, que é exatamente o bug da ADR 0033').toBe(0)

    // 5. E o saldo de crédito do cliente subiu.
    const { data: creditoDepois } = await admin()
      .from('customer_credit_balances').select('balance')
      .eq('tenant_id', tenantId).eq('customer_id', customerId).maybeSingle()
    expect(Number((creditoDepois as { balance: number }).balance) - antes).toBe(120)
  })

  test('cobrança em aberto continua sendo quitada normalmente', async () => {
    // O contraponto: sem ele, uma regressão que mandasse TUDO para crédito
    // passaria no teste acima e quebraria o produto inteiro em silêncio.
    const { chargeId, intentId, eventId } = await montarCobranca(80, 'aberta')
    const paymentId = await confirmar(intentId, eventId, 80)

    const { count: alocacoes } = await admin()
      .from('payment_allocations').select('id', { count: 'exact', head: true })
      .eq('payment_id', paymentId)
    expect(alocacoes ?? 0, 'cobrança em aberto deixou de ser quitada').toBe(1)

    const { count: creditos } = await admin()
      .from('customer_credits').select('id', { count: 'exact', head: true })
      .eq('payment_id', paymentId)
    expect(creditos ?? 0, 'cobrança em aberto virou crédito').toBe(0)

    const { data: saldo } = await admin()
      .from('charge_balances').select('status, open_amount').eq('charge_id', chargeId).single()
    expect((saldo as { status: string }).status).toBe('paid')
    expect(Number((saldo as { open_amount: number }).open_amount)).toBe(0)
  })

  test('a reconciliação não acusa o crédito como problema', async () => {
    // `payment_without_allocation` existe para achar dinheiro que não quitou
    // nada — e este legitimamente não quitou. Sem a exceção, toda aplicação da
    // decisão viraria falso positivo permanente na tela de diagnóstico.
    const { data } = await admin()
      .from('financial_reconciliation')
      .select('issue, entity_id')
      .eq('issue', 'payment_without_allocation')

    const { data: creditos } = await admin()
      .from('customer_credits').select('payment_id')
      .eq('origin', 'cancelled_charge').not('payment_id', 'is', null)

    const idsDeCredito = new Set(
      ((creditos ?? []) as { payment_id: string }[]).map((c) => c.payment_id),
    )
    const acusados = ((data ?? []) as { entity_id: string }[])
      .filter((r) => idsDeCredito.has(r.entity_id))

    expect(acusados, 'recebimento que virou crédito foi acusado como problema').toEqual([])
  })
})

test.describe('Cancelar encerra a tentativa (ADR 0033 Q1, metade mecânica)', () => {
  test('a tentativa pendente é expirada — o QR sai da mão do cliente', async () => {
    const { chargeId, intentId } = await montarCobranca(60, 'expira')

    const { data: antes } = await admin()
      .from('payment_intents').select('status').eq('id', intentId).single()
    expect((antes as { status: string }).status).toBe('pending')

    // Pelo caminho real: `cancelCharge` é o ponto único por onde os cinco
    // chamadores passam. Ele tenta cancelar no provedor primeiro — aqui a conta
    // não tem credencial no Vault, então a tentativa remota falha e é ENGOLIDA
    // de propósito. Expirar localmente não pode depender disso.
    await cancelCharge(admin(), tenantId, chargeId, `${TEST_TAG} cancelamento`, null)

    const { data: depois } = await admin()
      .from('payment_intents').select('status').eq('id', intentId).single()
    expect((depois as { status: string }).status,
      'a tentativa continuou pendente: o código de pagamento segue vivo').toBe('expired')

    // E a cobrança ficou cancelada de verdade — falha no provedor não desfaz
    // a decisão do operador.
    const { data: cobranca } = await admin()
      .from('charges').select('status').eq('id', chargeId).single()
    expect((cobranca as { status: string }).status).toBe('cancelled')
  })
})
