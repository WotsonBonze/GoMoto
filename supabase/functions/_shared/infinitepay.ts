/**
 * Processamento de evento da InfinitePay (ADR 0032).
 *
 * Saiu de `infinitepay-webhook/index.ts` na ADR 0034, Fase 3b.
 *
 * Este é o provedor em que a extração mais importa: o `payment_check` exige
 * QUATRO campos, e dois deles (`transaction_nsu` e `invoice_slug`) só existem
 * no corpo que a InfinitePay mandou. Reprocessar sem ler o payload gravado
 * seria impossível — e é justamente por o inbox guardar o corpo inteiro que o
 * replay funciona.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

import {
  accountCredentials, applyPayment, log, markEventTenant, markProcessed,
  type NormalizedPayment, type StoredEvent,
} from './inbox.ts'

export const PROVIDER = 'infinitepay'

export async function processInfinitePayEvent(
  supabase: SupabaseClient,
  event: StoredEvent,
): Promise<void> {
  const eventId = event.id
  const payload = event.payload as {
    order_nsu?: unknown
    transaction_nsu?: unknown
    invoice_slug?: unknown
  }

  const orderNsu = typeof payload.order_nsu === 'string' ? payload.order_nsu : ''
  if (!orderNsu) {
    throw new Error(`evento da InfinitePay sem order_nsu: event_id=${eventId}`)
  }

  const claim = {
    transactionNsu: typeof payload.transaction_nsu === 'string' ? payload.transaction_nsu : '',
    slug: typeof payload.invoice_slug === 'string' ? payload.invoice_slug : '',
  }

  // ── Camada 3: o tenant sai do NOSSO registro ──────────────────────
  const { data: intent } = await supabase
    .from('payment_intents')
    .select('id, tenant_id, provider_account_id, amount')
    .eq('provider', PROVIDER)
    .eq('provider_intent_id', orderNsu)
    .maybeSingle()

  if (!intent) {
    // A InfinitePay só dispara webhook em pagamento aprovado — não há evento
    // de ciclo de vida a descartar aqui. Então todo evento sem tentativa
    // correspondente é dinheiro sem dono, e marcar como processado apagaria o
    // rastro.
    throw new Error(`pagamento sem tentativa correspondente: order_nsu=${orderNsu}`)
  }

  const it = intent as {
    id: string; tenant_id: string; provider_account_id: string; amount: number
  }
  const account = { id: it.provider_account_id, tenant_id: it.tenant_id }

  // O dono do evento é carimbado antes da reconsulta ao `payment_check`
  // (ADR 0034): daqui para a frente tudo pode falhar, e a linha que falha
  // precisa ser visível ao tenant em vez de ficar com `tenant_id` NULL.
  await markEventTenant(supabase, eventId, it.tenant_id)

  // ── Camada 2: a API da InfinitePay é quem diz se foi pago ─────────
  const credentials = await accountCredentials(supabase, account.id)
  const payment = await checkPayment(orderNsu, claim, credentials)

  // O valor cobrado não muda entre a criação do link e o pagamento — o item é
  // fixo. Divergência aqui significa que a consulta resolveu outro pagamento, e
  // isso precisa aparecer. Não é motivo para recusar o dinheiro (ADR 0024: o que
  // entrou tem que ser reconhecido), é motivo para alguém olhar.
  // `Number(...)` nos dois lados: PostgREST devolve NUMERIC como STRING, e
  // comparar 1 com "1.00" acusaria divergência em toda confirmação correta.
  const valorDoIntent = Number(it.amount)
  if (payment.outcome === 'approved' && payment.amount !== null && payment.amount !== valorDoIntent) {
    log('warn', 'webhook.amount_divergente', {
      provider: PROVIDER, order_nsu: orderNsu,
      intent_amount: valorDoIntent, api_amount: payment.amount,
    })
  }

  await applyPayment(supabase, PROVIDER, account, payment, eventId)
  await markProcessed(supabase, eventId, account.tenant_id)
}

/**
 * `capture_method` da InfinitePay → `payment_method_type` do razão.
 *
 * Desconhecido volta `null` e a RPC deriva do intent — que para este provedor é
 * `payment_link` e cai em `other`. Preferível a chutar `pix` e gravar no razão
 * um meio que ninguém usou.
 */
function toLedgerMethod(capture: unknown): string | null {
  if (capture === 'pix') return 'pix'
  if (capture === 'credit_card') return 'credit_card'
  if (capture === 'debit_card') return 'debit_card'
  return null
}

/**
 * Consulta o pagamento e traduz para o vocabulário do inbox.
 *
 * **Os QUATRO campos são obrigatórios.** Verificado contra um pagamento real:
 * qualquer subconjunto responde `{"success": false}`. A API não busca por uma
 * chave — ela CRUZA os quatro e confere a consistência entre eles.
 *
 * **Valores em CENTAVOS**, convertidos aqui — o resto do sistema fala reais.
 *
 * **`amount`, nunca `paid_amount`.** Os dois vêm e são diferentes quando o
 * cliente parcela: `paid_amount` inclui os juros que ELE paga à InfinitePay
 * (1500 e 1510 no exemplo da doc). Esse excedente não é da locadora. Creditar o
 * maior quitaria a cobrança acima do devido e deixaria o saldo negativo.
 *
 * **Sem carimbo de liquidação.** Nem esta resposta nem o corpo do webhook
 * trazem a hora do pagamento, então o razão registra o instante da confirmação.
 * É uma perda de fidelidade conhecida, não um esquecimento.
 */
async function checkPayment(
  orderNsu: string,
  claim: { transactionNsu: string; slug: string },
  credentials: Record<string, unknown>,
): Promise<NormalizedPayment> {
  const handle = credentials.handle
  if (typeof handle !== 'string' || !handle) {
    throw new Error('credencial da InfinitePay malformada')
  }

  // Faltando qualquer um deles a API responderia `success: false`, que agora é
  // tratado como "não consegui verificar" e viraria retentativa eterna. Parar
  // aqui nomeia a causa real.
  if (!claim.transactionNsu || !claim.slug) {
    throw new Error(
      `webhook sem transaction_nsu/invoice_slug — payment_check exige os quatro campos `
      + `(order_nsu=${orderNsu})`,
    )
  }

  const base = (Deno.env.get('INFINITEPAY_API_BASE') ?? 'https://api.checkout.infinitepay.io')
    .replace(/\/+$/, '')

  const res = await fetch(`${base}/payment_check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      handle,
      // Nosso, e é o que ancora a resposta: com um `order_nsu` que não seja
      // deste pagamento, a API responde `paid: false` mesmo que a transação e
      // o slug sejam reais. É o que torna seguro repassar os dois campos que
      // chegaram de fora.
      order_nsu: orderNsu,
      transaction_nsu: claim.transactionNsu,
      slug: claim.slug,
    }),
  })

  if (!res.ok) throw new Error(`InfinitePay payment_check falhou: status=${res.status}`)

  const data = await res.json() as {
    success?: unknown
    paid?: unknown
    amount?: unknown
    paid_amount?: unknown
    capture_method?: unknown
  }

  // `success: false` NÃO é "não foi pago" — é "não consegui responder".
  // Confundir os dois foi o defeito que engoliu o primeiro pagamento real: o
  // evento era marcado como processado, saía da fila de replay e a cobrança
  // ficava aberta sem nada indicando por quê. Aqui vira exceção, e a exceção
  // deixa o evento em `processed_at IS NULL` para ser reprocessado.
  if (data.success !== true) {
    throw new Error(
      `payment_check não confirmou (success=${String(data.success)}) — `
      + `order_nsu=${orderNsu} slug=${claim.slug}`,
    )
  }

  // Aqui sim: a API respondeu e disse que não está pago.
  const approved = data.paid === true
  const cents = typeof data.amount === 'number' ? data.amount : null

  return {
    outcome: approved ? 'approved' : 'ignored',
    providerIntentId: orderNsu,
    amount: approved && cents !== null && cents > 0 ? cents / 100 : null,
    // A InfinitePay não informa quando liquidou. `applyPayment` cai em `now()`.
    paidAt: null,
    method: approved ? toLedgerMethod(data.capture_method) : null,
    detail: approved
      ? `paid capture_method=${String(data.capture_method)} amount=${String(cents)}`
      : `API respondeu paid=false (order_nsu=${orderNsu})`,
  }
}
