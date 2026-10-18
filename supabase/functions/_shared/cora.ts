/**
 * Processamento de evento da Cora (ADR 0031, sobre o inbox da ADR 0030).
 *
 * Saiu de `cora-webhook/index.ts` na ADR 0034, Fase 3b. O arquivo da função
 * ficou com o que é HTTP — segredo no path, ler headers, responder — e o que é
 * DINHEIRO passou a viver aqui, alcançável também pelo `gateway-replay`.
 *
 * A separação tem uma propriedade que importa mais que a organização: o replay
 * não é um segundo caminho para confirmar pagamento. É **o mesmo caminho**,
 * chamado de outro lugar. Um dreno que reimplementasse a verificação divergiria
 * do webhook no primeiro ajuste, e a divergência apareceria como dinheiro
 * confirmado de dois jeitos diferentes.
 *
 * Por isso tudo aqui lê do `payload` GRAVADO, nunca da requisição viva: na
 * entrega original o payload acabou de ser montado a partir dos headers; no
 * replay ele vem do banco. Mesmos campos, mesma função.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

import {
  accountCredentials, applyPayment, log, markEventTenant, markProcessed,
  type NormalizedPayment, type StoredEvent,
} from './inbox.ts'

export const PROVIDER = 'cora'

/**
 * Eventos que a Cora dispara ao criar a cobrança e que nunca viram dinheiro.
 *
 * `DRAFTED` chega antes mesmo de a invoice ser pagável — e, na prática, antes
 * do nosso próprio INSERT em `payment_intents`, porque a Cora notifica no
 * instante em que recebe o POST enquanto ainda estamos desenhando o QR.
 */
const LIFECYCLE_ONLY = new Set(['INVOICE.DRAFTED', 'INVOICE.CREATED'])

/**
 * A Cora recusou a CREDENCIAL — distinto de "a Cora está fora do ar".
 *
 * A diferença decide se a confirmação sem verificação é permitida (ADR 0033).
 * Um 500 ou uma queda de rede são transitórios e devem ser retentados; um 401
 * não melhora com o tempo, porque o token de 24h só é renovado quando uma
 * cobrança é gerada, e este runtime não sabe renovar.
 */
export class CoraCredentialError extends Error {
  constructor(readonly status: number) {
    super(`Cora recusou a credencial (status=${status})`)
    this.name = 'CoraCredentialError'
  }
}

export async function processCoraEvent(
  supabase: SupabaseClient,
  event: StoredEvent,
): Promise<void> {
  const eventId = event.id
  const eventType = event.event_type
  const invoiceId = String(event.payload.webhook_resource_id ?? '')

  if (!invoiceId) {
    throw new Error(`evento da Cora sem webhook_resource_id: event_id=${eventId}`)
  }

  // Só eventos de invoice movimentam dinheiro nosso.
  if (!eventType.startsWith('invoice.')) {
    await markProcessed(supabase, eventId, null)
    return
  }

  // Eventos de CICLO DE VIDA, que nunca movimentam dinheiro. Descartados aqui,
  // antes da consulta ao banco e antes da ida à API da Cora.
  //
  // O endpoint está cadastrado com `trigger: '*'`, então recebemos os três
  // eventos de toda cobrança gerada. Sem este corte, `invoice.CREATED` fazia
  // uma reconsulta completa à Cora só para ouvir `OPEN (total_paid=0)` — uma
  // viagem por cobrança, às vezes duas.
  //
  // E é DENYLIST, não allowlist, de propósito: se a Cora criar um evento novo
  // que movimente dinheiro, ele passa e é processado. Uma lista de permitidos
  // o descartaria em silêncio, que é o erro caro deste domínio.
  if (LIFECYCLE_ONLY.has(eventType.toUpperCase())) {
    log('info', 'webhook.lifecycle_ignored', { provider: PROVIDER, event_type: eventType })
    await markProcessed(supabase, eventId, null)
    return
  }

  // ── Camada 3: o tenant sai do NOSSO registro ──────────────────────
  // O webhook não diz de quem é a conta, e é melhor assim: casar o id da
  // invoice com uma tentativa que nós criamos é uma prova mais forte do que
  // qualquer identificador que a requisição pudesse trazer.
  const { data: intent } = await supabase
    .from('payment_intents')
    .select('id, tenant_id, provider_account_id, amount')
    .eq('provider', PROVIDER)
    .eq('provider_intent_id', invoiceId)
    .maybeSingle()

  if (!intent) {
    // Chegamos aqui só com evento que PODE ser dinheiro — o ciclo de vida já
    // foi descartado acima. Marcar como processado apagaria o rastro de um
    // pagamento sem dono; o caso real é a invoice órfã, criada na Cora quando
    // o nosso INSERT falhou depois do POST.
    throw new Error(
      `evento ${eventType} sem tentativa correspondente: invoice_id=${invoiceId}`,
    )
  }

  const it = intent as { id: string; tenant_id: string; provider_account_id: string; amount: number }
  const account = { id: it.provider_account_id, tenant_id: it.tenant_id }

  // O dono do evento é carimbado ANTES da ida à API da Cora (ADR 0034). Tudo
  // daqui para a frente pode falhar, e é exatamente nessas linhas que o tenant
  // precisa enxergar — sem isto elas ficavam com `tenant_id` NULL e a RLS as
  // escondia de quem agiria.
  await markEventTenant(supabase, eventId, it.tenant_id)

  // ── Camada 2: a API da Cora é quem diz se foi pago ────────────────
  let payment: NormalizedPayment
  let semVerificacao = false

  try {
    const credentials = await accountCredentials(supabase, account.id)
    payment = await fetchInvoice(invoiceId, credentials)
  } catch (err) {
    // RISCO ACEITO (ADR 0033): credencial vencida não pode travar a
    // confirmação de dinheiro que entrou de verdade.
    //
    // O token da Cora dura 24h e só é renovado quando uma cobrança é gerada —
    // e este runtime (Deno) não alcança a renovação, que vive em `apps/web`.
    // Cobranças emitidas na segunda e pagas na quinta chegavam aqui com token
    // morto e a cobrança ficava aberta com o dinheiro na conta da locadora.
    //
    // Quatro travas, porque isto abre mão da camada 2:
    //
    //   1. SÓ credencial recusada. Um 500 ou uma queda de rede continuam
    //      falhando — são transitórios, e confirmar por causa deles seria
    //      inventar pagamento a partir de instabilidade.
    //   2. SÓ `invoice.PAID`. Qualquer outro evento não vira dinheiro.
    //   3. O VALOR É NOSSO. Vem de `payment_intents.amount`, nunca da
    //      requisição — e no caso da Cora a requisição nem tem corpo para
    //      afirmar valor. Uma notificação forjada não escolhe quanto creditar:
    //      no máximo confirma exatamente o que já íamos cobrar.
    //   4. FICA MARCADO. A ressalva vai para `payments.notes` (o operador lê
    //      junto do recebimento) e para `gateway_events`
    //      (`accepted_without_verification`, que a tela de diagnóstico lê).
    if (!(err instanceof CoraCredentialError) || eventType.toUpperCase() !== 'INVOICE.PAID') {
      throw err
    }

    semVerificacao = true
    payment = {
      outcome: 'approved',
      providerIntentId: invoiceId,
      // `Number(...)`: PostgREST devolve NUMERIC como STRING. Sem a coerção o
      // valor chegaria como "1.00" e qualquer comparação numérica adiante
      // mentiria.
      amount: Number(it.amount),
      // A Cora não diz quando liquidou e não pudemos perguntar: o razão grava
      // o instante da confirmação.
      paidAt: null,
      method: null,
      notes: 'Confirmado SEM verificação na API da Cora — credencial vencida (ADR 0033)',
      detail: `${err.message} — confirmado pelo evento ${eventType}`,
    }

    log('warn', 'webhook.confirmado_sem_verificacao', {
      provider: PROVIDER, invoice_id: invoiceId, intent_id: it.id,
      tenant_id: it.tenant_id, amount: it.amount, status: err.status,
    })
  }

  await applyPayment(supabase, PROVIDER, account, payment, eventId)
  await markProcessed(supabase, eventId, account.tenant_id)

  // "Aceito sem conferir" tem coluna própria (ADR 0034) — booleano com índice
  // parcial, e não prefixo de texto dentro de `processing_error`, que carrega
  // falhas de verdade.
  if (semVerificacao) {
    await supabase
      .from('gateway_events')
      .update({ accepted_without_verification: true })
      .eq('id', eventId)
  }
}

/**
 * Consulta a invoice e traduz para o vocabulário do inbox.
 *
 * `PAID`, `OPEN`, `CANCELLED` são nomes DA CORA. O núcleo só conhece
 * `approved | refunded | ignored`, e é por isso que o próximo gateway não
 * herda este vocabulário.
 *
 * Valores voltam em CENTAVOS e são convertidos aqui — o resto do sistema fala
 * reais (ADR 0031 §3).
 */
async function fetchInvoice(
  invoiceId: string,
  credentials: Record<string, unknown>,
): Promise<NormalizedPayment> {
  const accessToken = credentials.access_token
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('credencial da Cora malformada')
  }

  const base = (Deno.env.get('CORA_API_BASE') ?? 'https://api.cora.com.br').replace(/\/+$/, '')
  const res = await fetch(`${base}/v2/invoices/${invoiceId}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
  })
  // 401/403 é credencial; o resto é instabilidade. Só o primeiro autoriza a
  // confirmação sem verificação.
  if (res.status === 401 || res.status === 403) throw new CoraCredentialError(res.status)
  if (!res.ok) throw new Error(`Cora fetch invoice falhou: status=${res.status}`)

  const inv = await res.json() as {
    status: string
    total_paid: number | null
    total_amount: number | null
    // `finalized_at` é o instante da liquidação — o campo que a Cora devolve de
    // verdade. `paid_at` foi suposição minha e nunca vem; sem isto o razão
    // registrava a hora de CRIAÇÃO do pagamento como data do recebimento.
    payments?: { finalized_at?: string; created_at?: string }[] | null
  }

  const paidCents = inv.total_paid ?? 0

  // "Pago" exige as DUAS coisas: status e dinheiro recebido. Só o status
  // deixaria uma invoice marcada como paga com `total_paid: 0` virar
  // recebimento de valor zero — que a RPC recusaria, mas com erro obscuro.
  const approved = inv.status === 'PAID' && paidCents > 0

  const outcome: NormalizedPayment['outcome'] =
    approved ? 'approved'
    : (inv.status === 'REFUNDED' || inv.status === 'CHARGEBACK') ? 'refunded'
    : 'ignored'

  const last = inv.payments?.[inv.payments.length - 1]

  return {
    outcome,
    providerIntentId: invoiceId,
    amount: paidCents > 0 ? paidCents / 100 : null,
    paidAt: last?.finalized_at ?? last?.created_at ?? null,
    detail: `${inv.status} (total_paid=${paidCents})`,
  }
}
