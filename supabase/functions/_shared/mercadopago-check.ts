/**
 * Conferência do pagamento do Mercado Pago contra a NOSSA cobrança.
 *
 * Função pura, sem import nenhum, de propósito: é a regra que decide se um
 * pagamento pode virar dinheiro no razão, e precisa ser testável fora do
 * runtime da Edge Function.
 *
 * O PRINCÍPIO
 *
 * O dono do pagamento sai do nosso `payment_intent` — que foi criado por UM
 * tenant, para UMA cobrança, com UM valor. O que vem de fora (o IPN e a
 * resposta da API do MP) só pode CONFIRMAR esse registro, nunca escolher
 * outro. Qualquer divergência entre os dois lados significa que não sabemos o
 * que está sendo pago, e aí o certo é não confirmar e deixar o evento na fila
 * com o motivo — dinheiro registrado na cobrança errada é pior que dinheiro
 * esperando alguém olhar.
 */

/** O que nós gravamos ao gerar a cobrança. */
export type MercadoPagoRecord = {
  /** `payment_intents.provider_intent_id` — o id do pagamento no MP. */
  paymentId: string
  /** `payment_intents.charge_id` — enviado ao MP como `external_reference`. */
  chargeId: string
  /** `payment_intents.amount`. Pode chegar como string (NUMERIC do PostgREST). */
  amount: number | string
  /** `payment_provider_accounts.external_account_id` da conta que gerou o Pix. */
  accountUserId: string
}

/** O que chegou de fora: o `user_id` do IPN e a resposta de `GET /v1/payments/{id}`. */
export type MercadoPagoClaim = {
  ipnUserId: string
  payment: {
    id: unknown
    status: unknown
    collector_id?: unknown
    external_reference?: unknown
    transaction_amount?: unknown
    currency_id?: unknown
  }
}

/** Centavos inteiros: comparar reais em ponto flutuante acusaria 0.1 + 0.2. */
function cents(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null
}

/**
 * Devolve a lista de divergências. Vazia = o pagamento é desta cobrança.
 *
 * Todas as checagens rodam, em vez de parar na primeira: quem investiga um
 * evento retido quer ver o quadro inteiro de uma vez.
 */
export function checkMercadoPagoPayment(
  record: MercadoPagoRecord,
  claim: MercadoPagoClaim,
): string[] {
  const problems: string[] = []
  const p = claim.payment

  // A conta que notificou é a conta que gerou o Pix. Um IPN de outra conta
  // apontando para o id do nosso pagamento não tem explicação legítima.
  if (claim.ipnUserId !== record.accountUserId) {
    problems.push(`user_id do IPN (${claim.ipnUserId}) difere da conta que gerou o Pix (${record.accountUserId})`)
  }

  if (String(p.id ?? '') !== record.paymentId) {
    problems.push(`MP devolveu o pagamento ${String(p.id)} ao consultar ${record.paymentId}`)
  }

  // Quem recebe o dinheiro. Ausente é divergência: sem ele não há como afirmar
  // que o dinheiro caiu na conta da locadora.
  if (String(p.collector_id ?? '') !== record.accountUserId) {
    problems.push(`recebedor do pagamento (${String(p.collector_id)}) não é a conta ${record.accountUserId}`)
  }

  // A amarração com a cobrança: `createPixCharge` envia `external_reference =
  // charge_id`. É a prova, vinda do próprio MP, de que este pagamento foi
  // gerado para esta cobrança — e não só um id que casou por acaso.
  if (String(p.external_reference ?? '') !== record.chargeId) {
    problems.push(`external_reference (${String(p.external_reference)}) não é a cobrança ${record.chargeId}`)
  }

  if (p.currency_id !== undefined && p.currency_id !== 'BRL') {
    problems.push(`moeda ${String(p.currency_id)} — esperado BRL`)
  }

  // Pix do MP tem valor fixo: o pago é o gerado. Diferente, não sabemos o que
  // foi pago — e o valor que vai ao razão é o da API, então divergir aqui
  // alocaria na cobrança um valor que ela não pediu.
  const expected = cents(record.amount)
  const paid = cents(p.transaction_amount)
  if (expected === null || paid === null || expected !== paid) {
    problems.push(`valor pago (${String(p.transaction_amount)}) difere do valor cobrado (${String(record.amount)})`)
  }

  return problems
}
