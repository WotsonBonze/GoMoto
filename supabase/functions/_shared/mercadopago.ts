/**
 * Processamento de evento do Mercado Pago (ADR 0030).
 *
 * Saiu de `mercadopago-webhook/index.ts` na ADR 0034, Fase 3b, pelo mesmo
 * motivo dos outros dois: o dreno da fila precisa reprocessar um evento
 * gravado, e reimplementar a verificação seria criar um segundo caminho para
 * confirmar dinheiro.
 *
 * O DONO SAI DA COBRANÇA, NÃO DA CONTA
 *
 * Até 2026-09-25 este era o único processador que resolvia o tenant pelo
 * identificador do PROVEDOR (`user_id` do IPN → `payment_provider_accounts`).
 * Isso pressupunha uma conta MP por tenant, e o banco nunca garantiu isso: o
 * índice único é `(tenant_id, provider, external_account_id)`. Com a mesma
 * conta conectada em dois tenants, a busca achava duas linhas, o
 * `.maybeSingle()` devolvia erro, o erro era ignorado como "conta não
 * existe", e o evento era marcado como processado — um Pix pago em produção
 * sumiu assim, sem erro e sem rastro na tela de diagnóstico.
 *
 * Agora é igual à Cora e à InfinitePay: o id do pagamento casa com um
 * `payment_intent` que NÓS criamos, e é ele que diz tenant, cobrança, conta e
 * valor. O que vem de fora só confirma — ver `mercadopago-check.ts`.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

import {
  accountCredentials, applyPayment, log, markEventTenant, markProcessed,
  type NormalizedPayment, type StoredEvent,
} from './inbox.ts'
import { checkMercadoPagoPayment } from './mercadopago-check.ts'

export const PROVIDER = 'mercadopago'

type IntentRow = {
  id: string; tenant_id: string; charge_id: string
  provider_account_id: string; amount: number | string
}

type AccountRow = { id: string; tenant_id: string; provider: string; external_account_id: string }

type MercadoPagoPayment = {
  id: unknown; status: string; status_detail: string
  transaction_amount: number; date_approved: string | null
  collector_id?: unknown; external_reference?: unknown; currency_id?: unknown
}

export async function processMercadoPagoEvent(
  supabase: SupabaseClient,
  event: StoredEvent,
): Promise<void> {
  const eventId = event.id
  const payload = event.payload as {
    type?: unknown
    action?: unknown
    live_mode?: unknown
    user_id?: unknown
    data?: { id?: unknown }
  }

  if (payload.type !== 'payment') {
    await markProcessed(supabase, eventId, null)
    return
  }

  const mpUserId = String(payload.user_id ?? '')
  const mpPaymentId = String(payload.data?.id ?? '')

  if (!mpUserId || !mpPaymentId) {
    throw new Error(
      `IPN do Mercado Pago incompleto: user_id=${mpUserId || '(vazio)'} data.id=${mpPaymentId || '(vazio)'}`,
    )
  }

  // ── 1. O dono sai do NOSSO registro ───────────────────────────────
  // Erro de leitura é exceção, não "não achei": confundir os dois é
  // exatamente o defeito que este arquivo corrige.
  const { data: intentData, error: intentError } = await supabase
    .from('payment_intents')
    .select('id, tenant_id, charge_id, provider_account_id, amount')
    .eq('provider', PROVIDER)
    .eq('provider_intent_id', mpPaymentId)
    .maybeSingle()

  if (intentError) throw new Error(`leitura do intent: ${intentError.message}`)

  if (!intentData) {
    // Pagamento que o GoMoto não gerou — maquininha, link de pagamento, Pix
    // avulso na mesma conta MP. Não é nosso para confirmar: registra e segue.
    //
    // Não existe o caso "nosso, mas o intent ainda não foi gravado": o QR só é
    // entregue ao cliente DEPOIS de `fn_open_payment_intent`, então não há como
    // pagar um Pix cujo intent não existe. O `payment.created` pode chegar
    // antes da gravação, mas ele é `pending`; a aprovação vem em outro evento.
    log('info', 'webhook.foreign_payment', {
      provider: PROVIDER, event_id: eventId, mp_payment_id: mpPaymentId,
      mp_user_id: mpUserId, mp_action: payload.action ?? null, live_mode: payload.live_mode ?? null,
    })
    await markProcessed(supabase, eventId, null)
    return
  }

  const intent = intentData as IntentRow

  // O dono do evento é carimbado antes de qualquer coisa que possa falhar
  // (ADR 0034): a linha retida precisa ser visível ao tenant.
  await markEventTenant(supabase, eventId, intent.tenant_id)

  // ── 2. A conta é a que GEROU o Pix, não a que o IPN nomeia ────────
  const { data: accountData, error: accountError } = await supabase
    .from('payment_provider_accounts')
    .select('id, tenant_id, provider, external_account_id')
    .eq('id', intent.provider_account_id)
    .maybeSingle()

  if (accountError) throw new Error(`leitura da conta: ${accountError.message}`)
  const account = accountData as AccountRow | null
  if (!account || account.provider !== PROVIDER || account.tenant_id !== intent.tenant_id) {
    throw new Error(
      `conta ${intent.provider_account_id} do intent ${intent.id} ausente ou de outro tenant/provedor`,
    )
  }

  // ── 3. A API do MP é quem diz se foi pago ─────────────────────────
  // Com a credencial da conta que gerou o Pix: é ela que enxerga o pagamento.
  const credentials = await accountCredentials(supabase, account.id)
  const mp = await fetchPayment(mpPaymentId, credentials)
  const payment = normalize(mpPaymentId, mp)

  // ── 4. O que veio de fora tem que bater com a cobrança ────────────
  // Só para o que mexe no razão. Pix expirado ou pendente não credita nada,
  // e reter esses eventos seria ruído na fila.
  if (payment.outcome !== 'ignored') {
    const problems = checkMercadoPagoPayment(
      {
        paymentId: mpPaymentId,
        chargeId: intent.charge_id,
        amount: intent.amount,
        accountUserId: account.external_account_id,
      },
      { ipnUserId: mpUserId, payment: mp },
    )

    if (problems.length > 0) {
      // Exceção, não `return`: o evento fica com `processed_at IS NULL` e
      // `processing_error`, visível ao tenant e reprocessável depois de
      // investigado. Nada é gravado no razão.
      throw new Error(
        `pagamento ${mpPaymentId} não confere com a cobrança ${intent.charge_id}: ${problems.join('; ')}`,
      )
    }
  }

  await applyPayment(supabase, PROVIDER, { id: account.id, tenant_id: account.tenant_id }, payment, eventId)
  await markProcessed(supabase, eventId, intent.tenant_id)
}

/** `GET /v1/payments/{id}` com a credencial da conta. */
async function fetchPayment(
  mpPaymentId: string,
  credentials: Record<string, unknown>,
): Promise<MercadoPagoPayment> {
  const accessToken = credentials.access_token
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('credencial do Mercado Pago malformada')
  }

  const res = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(mpPaymentId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`MP fetch failed: status=${res.status}`)

  return await res.json() as MercadoPagoPayment
}

/**
 * Traduz para o vocabulário do inbox.
 *
 * A tradução mora aqui de propósito: `approved`, `refunded` e `charged_back`
 * são nomes DESTE provedor. O núcleo só conhece `approved | refunded | ignored`,
 * e é por isso que o próximo gateway não precisa herdar este vocabulário.
 */
function normalize(mpPaymentId: string, p: MercadoPagoPayment): NormalizedPayment {
  const outcome: NormalizedPayment['outcome'] =
    p.status === 'approved' ? 'approved'
    : (p.status === 'refunded' || p.status === 'charged_back') ? 'refunded'
    : 'ignored'

  return {
    outcome,
    providerIntentId: mpPaymentId,
    amount: p.transaction_amount ?? null,
    paidAt: p.date_approved,
    detail: `${p.status} (${p.status_detail})`,
  }
}
