// Supabase Edge Function — Deno runtime
//
// Webhook da Cora (ADR 0031).
//
// A Cora NÃO assina a notificação e NÃO oferece campo de segredo no cadastro do
// endpoint (`POST /endpoints/` aceita só `url`, `resource`, `trigger`). A
// requisição chega sem corpo — apenas os headers `webhook-event-id`,
// `webhook-event-type` e `webhook-resource-id`.
//
// Ou seja: quem descobrir a URL consegue postar "invoice.paid". A resposta são
// três camadas, e nenhuma delas basta sozinha:
//
//   1. SEGREDO NO PATH — é o único lugar onde cabe um segredo. Comparado em
//      tempo constante.
//   2. RECONSULTAR A INVOICE na API da Cora com o token daquele tenant. O que
//      vale é o que a API responde, nunca o que a requisição afirmou.
//   3. RESOLVER O TENANT PELO NOSSO REGISTRO — `webhook-resource-id` é
//      procurado em `payment_intents`. Nada vindo de fora escolhe de quem é o
//      dinheiro.
//
// `gateway_events.signature_valid` fica `false` para sempre aqui. É honesto: um
// provedor que não assina não pode produzir registro afirmando verificação.
//
// Este arquivo ficou com o que é HTTP. As camadas 2 e 3 — reconsultar a invoice,
// resolver o tenant, aplicar ao razão e a confirmação sem verificação da
// ADR 0033 — vivem em `_shared/cora.ts` desde a ADR 0034, Fase 3b, para que o
// dreno da fila reprocesse pelo MESMO caminho em vez de por uma segunda
// implementação.

import { createClient } from 'npm:@supabase/supabase-js@2'

// Mantém o trabalho vivo depois da resposta (runtime do Supabase Edge).
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }
import { log, markFailed, recordEvent } from '../_shared/inbox.ts'
import { PROVIDER, processCoraEvent } from '../_shared/cora.ts'

/** Comparação de tempo constante — o segredo do path não pode vazar por timing. */
function secretMatches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req: Request) => {
  const expectedSecret = Deno.env.get('CORA_WEBHOOK_SECRET')
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // ── Camada 1: segredo no path ─────────────────────────────────────
  // Sem segredo configurado a função RECUSA tudo, em vez de aceitar como o
  // webhook do MP faz em ambiente local. A diferença é que ali a assinatura é
  // a defesa e o segredo é opcional; aqui o segredo é a única barreira na
  // porta — deixá-la aberta por configuração ausente seria abrir o endpoint.
  if (!expectedSecret) {
    log('error', 'webhook.misconfigured', { provider: PROVIDER, reason: 'CORA_WEBHOOK_SECRET ausente' })
    return new Response('Not found', { status: 404 })
  }

  const given = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? ''
  if (!secretMatches(given, expectedSecret)) {
    // 404 e não 401: para quem sonda a URL, o endpoint não existe.
    log('warn', 'webhook.bad_secret', { provider: PROVIDER })
    return new Response('Not found', { status: 404 })
  }

  const eventType = req.headers.get('webhook-event-type') ?? ''
  const resourceId = req.headers.get('webhook-resource-id') ?? ''
  const providerEventId = req.headers.get('webhook-event-id') ?? ''

  if (!eventType || !resourceId || !providerEventId) {
    log('warn', 'webhook.bad_request', { provider: PROVIDER, reason: 'headers incompletos' })
    return new Response('Bad request', { status: 400 })
  }

  // O corpo vem vazio (`content-length: 0`). Guardamos os headers para que o
  // inbox continue sendo auditoria do que o provedor mandou.
  const payload = {
    webhook_event_id: providerEventId,
    webhook_event_type: eventType,
    webhook_resource_id: resourceId,
  }

  let eventId: string | null
  try {
    eventId = await recordEvent(supabase, {
      provider: PROVIDER,
      providerEventId,
      eventType,
      payload,
      // Nunca `true`: a Cora não assina. Ver cabeçalho.
      signatureValid: false,
    })
  } catch (err) {
    log('error', 'webhook.persist_failed', { provider: PROVIDER, error: String(err) })
    return new Response('Internal error', { status: 500 })
  }

  // A Cora espera este corpo exato.
  const ok = new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  if (!eventId) return ok

  // RESPONDE ANTES DE PROCESSAR.
  //
  // O cadastro do endpoint na Cora traz `readTimeout: 2000` — dois segundos.
  // Processar envolve uma ida à API da Cora para reconsultar a invoice, o que
  // sozinho já pode estourar esse prazo. Segurar a resposta faria a Cora
  // considerar a entrega falha e reenviar por lentidão nossa.
  //
  // Seguro porque o evento JÁ está no inbox: se o processamento morrer, a
  // linha fica com `processed_at IS NULL` e o índice
  // `idx_gateway_events_unprocessed` é a fila de reprocessamento.
  EdgeRuntime.waitUntil(
    // O MESMO processamento que o dreno da fila usa (ADR 0034, Fase 3b): ele
    // lê do payload gravado, e é este que acabou de ser gravado.
    processCoraEvent(supabase, {
      id: eventId, event_type: eventType, provider_event_id: providerEventId, payload,
    }).catch((err) => markFailed(supabase, eventId, err)),
  )

  return ok
})
