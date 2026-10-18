// Rodar: npx deno test supabase/functions/_shared/mercadopago-check.test.ts

import { checkMercadoPagoPayment, type MercadoPagoClaim, type MercadoPagoRecord } from './mercadopago-check.ts'

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`)
}

function assertProblem(problems: string[], fragment: string) {
  if (!problems.some((p) => p.includes(fragment))) {
    throw new Error(`esperava divergência contendo "${fragment}", veio ${JSON.stringify(problems)}`)
  }
}

// O caso real de 2026-09-25: Pix de R$ 1,00 da WAT Motos, conta 251267991.
const record: MercadoPagoRecord = {
  paymentId: '179914812055',
  chargeId: '72b63ad0-f427-4c69-b4c3-79e3c2e03958',
  amount: '1.00', // PostgREST devolve NUMERIC como string
  accountUserId: '251267991',
}

function claim(overrides: Partial<MercadoPagoClaim['payment']> = {}, ipnUserId = '251267991'): MercadoPagoClaim {
  return {
    ipnUserId,
    payment: {
      id: 179914812055, // a API devolve número
      status: 'approved',
      collector_id: 251267991,
      external_reference: '72b63ad0-f427-4c69-b4c3-79e3c2e03958',
      transaction_amount: 1,
      currency_id: 'BRL',
      ...overrides,
    },
  }
}

Deno.test('pagamento que bate com a cobrança não tem divergência', () => {
  assertEquals(checkMercadoPagoPayment(record, claim()), [])
})

Deno.test('valor em ponto flutuante não gera falsa divergência', () => {
  const r = { ...record, amount: '0.30' }
  assertEquals(checkMercadoPagoPayment(r, claim({ transaction_amount: 0.1 + 0.2 })), [])
})

Deno.test('IPN de outra conta MP é retido', () => {
  assertProblem(checkMercadoPagoPayment(record, claim({}, '999')), 'user_id do IPN')
})

Deno.test('recebedor diferente da conta que gerou o Pix é retido', () => {
  assertProblem(checkMercadoPagoPayment(record, claim({ collector_id: 999 })), 'recebedor')
})

Deno.test('recebedor ausente é retido', () => {
  assertProblem(checkMercadoPagoPayment(record, claim({ collector_id: undefined })), 'recebedor')
})

Deno.test('external_reference de outra cobrança é retido', () => {
  assertProblem(checkMercadoPagoPayment(record, claim({ external_reference: 'outra-cobranca' })), 'external_reference')
})

Deno.test('external_reference ausente é retido', () => {
  assertProblem(checkMercadoPagoPayment(record, claim({ external_reference: null })), 'external_reference')
})

Deno.test('valor pago diferente do cobrado é retido', () => {
  assertProblem(checkMercadoPagoPayment(record, claim({ transaction_amount: 0.99 })), 'valor pago')
})

Deno.test('valor ausente é retido', () => {
  assertProblem(checkMercadoPagoPayment(record, claim({ transaction_amount: undefined })), 'valor pago')
})

Deno.test('resposta da API para outro pagamento é retida', () => {
  assertProblem(checkMercadoPagoPayment(record, claim({ id: 1 })), 'MP devolveu o pagamento')
})

Deno.test('moeda diferente de BRL é retida', () => {
  assertProblem(checkMercadoPagoPayment(record, claim({ currency_id: 'USD' })), 'moeda')
})

Deno.test('todas as divergências aparecem juntas', () => {
  const problems = checkMercadoPagoPayment(record, claim({ collector_id: 1, transaction_amount: 5 }, '2'))
  assertEquals(problems.length, 3)
})
