/**
 * Processamento de evento do Asaas (ADR 0037, decisão 5).
 *
 * Mesmo desenho dos outros três: lê SÓ o evento gravado no inbox, para que a
 * entrega original e o dreno da fila de replay sejam a mesma função.
 *
 * Duas regras fazem o trabalho:
 *
 * 1. **O dono sai do nosso registro.** `payment.id` é procurado em
 *    `payment_intents`; a conta e a credencial são as DO INTENT. Nada no corpo
 *    escolhe de quem é o dinheiro — nem `account.id`, que é a conta Asaas e pode
 *    estar conectada a mais de um tenant (o caso que fez o Mercado Pago perder
 *    um Pix real em 2026-09-25).
 * 2. **O fato sai da reconsulta.** `GET /payments/{id}` com a chave da conta do
 *    intent; o status que a API devolve decide, o nome do evento é só gatilho.
 *    O token do webhook prova que a requisição veio de uma configuração nossa,
 *    não que o pagamento aconteceu.
 *
 * O webhook recebe TUDO da conta Asaas da locadora — inclusive cobranças que
 * ela emite fora do GoMoto. Sem intent, `externalReference` decide: `gomoto:`
 * é dinheiro nosso sem dono (erro, fica na fila); o resto não é da nossa conta.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

import {
  accountCredentials, applyPayment, log, markEventTenant, markProcessed,
  type NormalizedPayment, type StoredEvent,
} from './inbox.ts'

export const PROVIDER = 'asaas'

const BASES: Record<string, string> = {
  production: 'https://api.asaas.com/v3',
  sandbox: 'https://api-sandbox.asaas.com/v3',
}

/** Eventos que podem significar dinheiro entrando ou saindo. */
const MONEY_EVENTS = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_REFUNDED'])

type AsaasEventPayload = {
  event?: unknown
  payment?: { id?: unknown; externalReference?: unknown }
  account?: { id?: unknown }
}

/** Resposta de `GET /payments/{id}`, só o que se lê. */
export type AsaasPayment = {
  id: string
  status: string
  value: number
  originalValue?: number | null
  interestValue?: number | null
  billingType?: string | null
  paymentDate?: string | null
  confirmedDate?: string | null
  externalReference?: string | null
}

export async function processAsaasEvent(
  supabase: SupabaseClient,
  event: StoredEvent,
): Promise<void> {
  const eventId = event.id
  const payload = event.payload as AsaasEventPayload
  const type = String(payload.event ?? event.event_type)

  // Chave desabilitada/expirando por inatividade: não é dinheiro, mas é o aviso
  // de que a próxima cobrança vai falhar. Fica no log com a conta para a
  // operação agir antes da locadora descobrir pelo cliente.
  if (type.startsWith('ACCESS_TOKEN_')) {
    log('error', 'asaas.chave_em_risco', {
      provider: PROVIDER, event_type: type, asaas_account_id: payload.account?.id ?? null,
    })
    await markProcessed(supabase, eventId, null)
    return
  }

  const paymentId = typeof payload.payment?.id === 'string' ? payload.payment.id : ''
  if (!paymentId) {
    log('info', 'webhook.sem_cobranca', { provider: PROVIDER, event_type: type })
    await markProcessed(supabase, eventId, null)
    return
  }

  const externalRef = typeof payload.payment?.externalReference === 'string'
    ? payload.payment.externalReference
    : ''

  const { data: intent } = await supabase
    .from('payment_intents')
    .select('id, tenant_id, provider_account_id, amount')
    .eq('provider', PROVIDER)
    .eq('provider_intent_id', paymentId)
    .maybeSingle()

  if (!intent) {
    // Cobrança do GoMoto sem intent e com dinheiro em jogo: a criação no Asaas
    // aconteceu e a gravação aqui não (corrida, falha no meio). Erro de
    // propósito — fica na fila de replay como dinheiro sem dono a investigar.
    if (externalRef.startsWith('gomoto:') && MONEY_EVENTS.has(type)) {
      throw new Error(`cobrança do GoMoto sem tentativa correspondente: payment=${paymentId} ref=${externalRef}`)
    }
    // O resto é da conta da locadora, não do GoMoto. Tratar como erro encheria
    // a fila de replay de ruído permanente.
    log('info', 'webhook.fora_do_gomoto', { provider: PROVIDER, event_type: type, payment_id: paymentId })
    await markProcessed(supabase, eventId, null)
    return
  }

  const it = intent as { id: string; tenant_id: string; provider_account_id: string; amount: number }
  const account = { id: it.provider_account_id, tenant_id: it.tenant_id }

  await markEventTenant(supabase, eventId, it.tenant_id)

  const credentials = await accountCredentials(supabase, account.id)
  const remote = await fetchPayment(paymentId, credentials)
  const timezone = await tenantTimezone(supabase, it.tenant_id)

  let payment = normalize(type, remote, Number(it.amount), timezone)

  // Conta de OUTRO ambiente não move dinheiro aqui. Uma conta sandbox esquecida
  // conectada depois da virada para produção ainda recebe eventos do sandbox —
  // pagamento fictício que, confirmado, quitaria uma dívida real. Registrado
  // como ignorado (com o motivo) em vez de erro: reprocessar não muda nada.
  const mismatch = environmentMismatch(credentials.environment, Deno.env.get('ASAAS_ENVIRONMENT'))
  if (mismatch && payment.outcome !== 'ignored') {
    log('error', 'asaas.ambiente_divergente', {
      provider: PROVIDER, payment_id: paymentId, tenant_id: it.tenant_id, detail: mismatch,
    })
    payment = { ...payment, outcome: 'ignored', extraLateCharge: undefined, detail: mismatch }
  }

  if (payment.outcome === 'approved' && payment.extraLateCharge) {
    log('info', 'asaas.encargo_cobrado_no_pagamento', {
      provider: PROVIDER, payment_id: paymentId, intent_amount: Number(it.amount),
      paid: remote.value, extra: payment.extraLateCharge, interest_value: remote.interestValue ?? null,
    })
  }

  await applyPayment(supabase, PROVIDER, account, payment, eventId)
  await markProcessed(supabase, eventId, account.tenant_id)
}

/**
 * Status do Asaas → vocabulário do inbox. Puro, para teste.
 *
 * - `RECEIVED` | `CONFIRMED`: aprovado. Boleto e cartão mandam os dois eventos;
 *   a confirmação é idempotente por intent, então o segundo não credita.
 * - `REFUNDED`: estorno total.
 * - `PAYMENT_PARTIALLY_REFUNDED` chega com a cobrança ainda `RECEIVED`.
 *   Decidido pelo EVENTO antes do status: `fn_reverse_payment` só sabe estornar
 *   tudo, e tratar como aprovado seria um no-op que esconde o estorno.
 * - `RECEIVED_IN_CASH`: a locadora marcou como recebido no painel do Asaas.
 *   Não passou dinheiro pelo gateway; quem registra recebimento em dinheiro é o
 *   cockpit. Ignorado com aviso.
 * - qualquer outro (`PENDING`, `OVERDUE`, removida…): não houve pagamento.
 */
export function normalize(
  eventType: string,
  p: AsaasPayment,
  intentAmount: number,
  timezone: string | null,
  now: Date = new Date(),
): NormalizedPayment & { extraLateCharge?: number } {
  const base = { providerIntentId: p.id, amount: p.value, method: toLedgerMethod(p.billingType) }

  if (eventType === 'PAYMENT_PARTIALLY_REFUNDED') {
    return {
      ...base, outcome: 'ignored', paidAt: null,
      detail: `estorno PARCIAL no Asaas (status=${p.status}) — requer ação do operador`,
    }
  }

  if (p.status === 'RECEIVED' || p.status === 'CONFIRMED') {
    // O que o banco do pagador somou ao código (multa e juros do `cobv`) é a
    // diferença para o valor do intent — derivada do NOSSO registro, não de
    // `interestValue`, para não depender da semântica de um campo deles. Os
    // dois são logados lado a lado.
    const extra = round2(Math.max(0, p.value - intentAmount))
    return {
      ...base,
      outcome: 'approved',
      paidAt: paidAtOf(p.paymentDate ?? p.confirmedDate ?? null, timezone, now),
      ...(extra > 0 ? { extraLateCharge: extra } : {}),
      detail: `${p.status} (value=${p.value}, original=${p.originalValue ?? p.value})`,
    }
  }

  if (p.status === 'REFUNDED') {
    return { ...base, outcome: 'refunded', paidAt: null, detail: 'REFUNDED no Asaas' }
  }

  if (p.status === 'RECEIVED_IN_CASH') {
    return {
      ...base, outcome: 'ignored', paidAt: null,
      detail: 'marcada como recebida em dinheiro no painel do Asaas — registre o recebimento no GoMoto',
    }
  }

  return { ...base, outcome: 'ignored', paidAt: null, detail: `status ${p.status}` }
}

/**
 * A conta do evento é de um ambiente que este deploy não aceita?
 *
 * Sem `ASAAS_ENVIRONMENT` nos secrets da função, aceita qualquer um — é o
 * comportamento de antes, e o desenvolvimento local fica sem configuração.
 */
export function environmentMismatch(credentialEnv: unknown, deployEnv: string | undefined): string | null {
  if (deployEnv !== 'production' && deployEnv !== 'sandbox') return null
  if (credentialEnv === deployEnv) return null
  return `conta Asaas de ambiente ${String(credentialEnv)} num deploy ${deployEnv} — não credita`
}

/**
 * Instante do pagamento para o razão.
 *
 * O Asaas só informa a DATA (verificado), e o horário exato exige permissão de
 * saque, que a conexão recusa. Pagamento de hoje → o instante da confirmação
 * (o webhook chega em segundos). De outro dia (reprocessamento tardio) → meio-dia
 * daquele dia no fuso da locadora, para não cair no dia errado do razão.
 */
export function paidAtOf(date: string | null, timezone: string | null, now: Date): string | null {
  if (!date) return null
  const tz = timezone || 'America/Sao_Paulo'
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
  if (date === today) return now.toISOString()

  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(now).find((x) => x.type === 'timeZoneName')?.value ?? 'GMT'
  const offset = name.match(/GMT([+-]\d{2}:\d{2})/)?.[1] ?? '+00:00'
  return new Date(`${date}T12:00:00${offset}`).toISOString()
}

/** `billingType` → `payment_method_type`. Desconhecido = `null`: a RPC deriva do intent. */
function toLedgerMethod(billingType: string | null | undefined): string | null {
  switch (billingType) {
    case 'PIX': return 'pix'
    case 'CREDIT_CARD': return 'credit_card'
    case 'DEBIT_CARD': return 'debit_card'
    case 'BOLETO': return 'bank_transfer'
    default: return null
  }
}

async function fetchPayment(paymentId: string, credentials: Record<string, unknown>): Promise<AsaasPayment> {
  const apiKey = credentials.api_key
  const base = BASES[String(credentials.environment)]
  if (typeof apiKey !== 'string' || !apiKey || !base) {
    throw new Error('credencial do Asaas malformada')
  }

  const res = await fetch(`${base}/payments/${encodeURIComponent(paymentId)}`, {
    headers: { access_token: apiKey, 'User-Agent': 'GoMoto/1.0', Accept: 'application/json' },
  })
  // Sem verificar não há confirmação: o evento fica na fila (ADR 0033 — "não
  // consegui verificar" não é "não foi pago").
  if (!res.ok) throw new Error(`Asaas GET /payments falhou: status=${res.status}`)

  const p = await res.json() as AsaasPayment
  if (p?.id !== paymentId || typeof p.value !== 'number' || typeof p.status !== 'string') {
    throw new Error(`Asaas devolveu cobrança inesperada para ${paymentId}`)
  }
  return p
}

async function tenantTimezone(supabase: SupabaseClient, tenantId: string): Promise<string | null> {
  const { data } = await supabase.from('tenants').select('timezone').eq('id', tenantId).maybeSingle()
  return (data as { timezone: string | null } | null)?.timezone ?? null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
