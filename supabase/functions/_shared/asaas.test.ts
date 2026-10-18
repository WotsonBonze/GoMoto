// Rodar de DENTRO de supabase/functions (na raiz, o deno reescreve o package.json):
//   cd supabase/functions && npx deno test _shared/asaas.test.ts

import { normalize, paidAtOf, type AsaasPayment } from './asaas.ts'

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`)
}

const NOW = new Date('2026-10-10T15:00:00Z') // 12:00 em Brasília
const pago = (over: Partial<AsaasPayment> = {}): AsaasPayment => ({
  id: 'pay_1', status: 'RECEIVED', value: 100, billingType: 'PIX', paymentDate: '2026-10-10', ...over,
})

Deno.test('pago em dia: aprovado, sem encargo extra, instante da confirmação', () => {
  const n = normalize('PAYMENT_RECEIVED', pago(), 100, 'America/Sao_Paulo', NOW)
  assertEquals([n.outcome, n.amount, n.method, n.extraLateCharge, n.paidAt], ['approved', 100, 'pix', undefined, NOW.toISOString()])
})

Deno.test('pago depois do vencimento: o que o banco somou vira encargo (verificado: 100 → 102,03)', () => {
  const n = normalize('PAYMENT_RECEIVED', pago({ value: 102.03, originalValue: 100, interestValue: 2.03 }), 100, null, NOW)
  assertEquals([n.outcome, n.amount, n.extraLateCharge], ['approved', 102.03, 2.03])
})

Deno.test('cobrança já vencida na emissão: extra é só o que passou do valor do intent', () => {
  // intent de 102,26 (encargo até a emissão já dentro); pago 102,29 dias depois
  const n = normalize('PAYMENT_RECEIVED', pago({ value: 102.29, originalValue: 102.26, interestValue: 0.03 }), 102.26, null, NOW)
  assertEquals(n.extraLateCharge, 0.03)
})

Deno.test('CONFIRMED também aprova (boleto/cartão); a RPC é idempotente por intent', () => {
  assertEquals(normalize('PAYMENT_CONFIRMED', pago({ status: 'CONFIRMED' }), 100, null, NOW).outcome, 'approved')
})

Deno.test('estorno total vira refunded', () => {
  assertEquals(normalize('PAYMENT_REFUNDED', pago({ status: 'REFUNDED' }), 100, null, NOW).outcome, 'refunded')
})

Deno.test('estorno PARCIAL não é tratado como aprovado mesmo com status RECEIVED', () => {
  const n = normalize('PAYMENT_PARTIALLY_REFUNDED', pago(), 100, null, NOW)
  assertEquals(n.outcome, 'ignored')
})

Deno.test('recebido em dinheiro no painel do Asaas: ignorado (não passou pelo gateway)', () => {
  assertEquals(normalize('PAYMENT_RECEIVED', pago({ status: 'RECEIVED_IN_CASH' }), 100, null, NOW).outcome, 'ignored')
})

Deno.test('pendente/vencida/removida: não houve pagamento', () => {
  for (const status of ['PENDING', 'OVERDUE']) {
    assertEquals(normalize('PAYMENT_DELETED', pago({ status }), 100, null, NOW).outcome, 'ignored')
  }
})

Deno.test('paidAtOf: data de outro dia vira meio-dia no fuso da locadora', () => {
  assertEquals(paidAtOf('2026-10-08', 'America/Sao_Paulo', NOW), '2026-10-08T15:00:00.000Z')
  assertEquals(paidAtOf(null, null, NOW), null)
})

Deno.test('paidAtOf: 22h em Brasília (UTC já é amanhã) ainda reconhece o pagamento de hoje', () => {
  const noite = new Date('2026-10-11T01:00:00Z')
  assertEquals(paidAtOf('2026-10-10', 'America/Sao_Paulo', noite), noite.toISOString())
})

import { environmentMismatch } from './asaas.ts'

Deno.test('ambiente: conta sandbox em deploy de produção não credita', () => {
  if (!environmentMismatch('sandbox', 'production')) throw new Error('deveria divergir')
})

Deno.test('ambiente: mesmo ambiente, ou deploy sem ASAAS_ENVIRONMENT, segue normal', () => {
  assertEquals(environmentMismatch('production', 'production'), null)
  assertEquals(environmentMismatch('sandbox', undefined), null)
})
