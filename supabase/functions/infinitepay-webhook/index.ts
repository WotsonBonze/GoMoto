// Supabase Edge Function — Deno runtime
//
// Webhook da InfinitePay (ADR 0032).
//
// A InfinitePay NÃO assina a notificação e não oferece campo de segredo: a
// `webhook_url` viaja no corpo de cada criação de link e é tudo que existe.
// O corpo que chega afirma o pagamento inteiro — valor, meio, transação — e
// aceitar essa afirmação seria deixar qualquer um que descubra a URL quitar
// cobrança alheia.
//
// A resposta são três camadas, e nenhuma basta sozinha:
//
//   1. SEGREDO NO PATH — único lugar onde cabe um segredo. Tempo constante.
//   2. RECONSULTAR em `POST /payment_check`. O que vale é o que a API responde,
//      nunca o que a requisição afirmou. A consulta exige os QUATRO campos —
//      `handle`, `order_nsu`, `transaction_nsu` e `slug` —, e dois deles chegam
//      de fora. Isso é seguro porque a API os CRUZA e ancora a resposta no
//      nosso `order_nsu`. Verificado contra um pagamento real:
//
//        handle + order_nsu                     → {"success":false}
//        handle + slug                          → {"success":false}
//        handle + transaction_nsu               → {"success":false}
//        os quatro, consistentes                → {"success":true,"paid":true}
//        order_nsu ALHEIO + transaction/slug reais → {"success":true,"paid":false}
//
//      A última linha é a que importa: parear uma transação real e alheia com
//      um pedido nosso NÃO confirma nada. A primeira versão mandava só o que
//      era nosso, por precaução, e com isso nunca conseguia confirmar.
//   3. RESOLVER O TENANT PELO NOSSO REGISTRO — `order_nsu` é um UUID que este
//      sistema criou, procurado em `payment_intents`. Nada vindo de fora
//      escolhe de quem é o dinheiro.
//
// `gateway_events.signature_valid` fica `false` para sempre. É honesto: um
// provedor que não assina não pode produzir registro afirmando verificação.
//
// RETENTATIVA INVERTIDA: para a InfinitePay, 200 é "entregue" e **400 é
// reenviar" — o oposto da convenção de todo mundo. Por isso a falha de
// persistência responde 400 e não 500.
//
// Este arquivo ficou com o que é HTTP. As camadas 2 e 3 vivem em
// `_shared/infinitepay.ts` desde a ADR 0034, Fase 3b — e é aqui que a extração
// mais se paga: `payment_check` exige quatro campos, dois deles só existentes no
// corpo que a InfinitePay mandou. Guardar o corpo inteiro no inbox é o que
// permite reprocessar depois.

import { createClient } from 'npm:@supabase/supabase-js@2'

// Mantém o trabalho vivo depois da resposta (runtime do Supabase Edge).
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }
import { log, markFailed, recordEvent } from '../_shared/inbox.ts'
import { PROVIDER, processInfinitePayEvent } from '../_shared/infinitepay.ts'

/** Comparação de tempo constante — o segredo do path não pode vazar por timing. */
function secretMatches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

type WebhookBody = {
  order_nsu?: unknown
  transaction_nsu?: unknown
  invoice_slug?: unknown
  amount?: unknown
  paid_amount?: unknown
  capture_method?: unknown
  receipt_url?: unknown
}

Deno.serve(async (req: Request) => {
  const expectedSecret = Deno.env.get('INFINITEPAY_WEBHOOK_SECRET')
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // ── Camada 1: segredo no path ─────────────────────────────────────
  // Sem segredo configurado a função RECUSA tudo. Deixar a porta aberta por
  // configuração ausente seria abrir o endpoint — e aqui o segredo é a única
  // barreira na porta, já que não há assinatura.
  if (!expectedSecret) {
    log('error', 'webhook.misconfigured', { provider: PROVIDER, reason: 'INFINITEPAY_WEBHOOK_SECRET ausente' })
    return new Response('Not found', { status: 404 })
  }

  const given = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? ''
  if (!secretMatches(given, expectedSecret)) {
    // 404 e não 401: para quem sonda a URL, o endpoint não existe.
    log('warn', 'webhook.bad_secret', { provider: PROVIDER })
    return new Response('Not found', { status: 404 })
  }

  let body: WebhookBody
  try {
    body = await req.json() as WebhookBody
  } catch {
    log('warn', 'webhook.bad_request', { provider: PROVIDER, reason: 'corpo não é JSON' })
    return new Response('Bad request', { status: 400 })
  }

  const orderNsu = typeof body.order_nsu === 'string' ? body.order_nsu : ''
  if (!orderNsu) {
    // Sem `order_nsu` não há como saber de quem é o dinheiro, e reenviar não vai
    // fazer aparecer. 400 pediria retentativa eterna de algo insalvável — mas é
    // o único código de erro que a InfinitePay entende, e engolir com 200
    // apagaria o rastro. Fica registrado no log e devolve 400 uma vez.
    log('warn', 'webhook.bad_request', { provider: PROVIDER, reason: 'sem order_nsu' })
    return new Response('Bad request', { status: 400 })
  }

  // Sem id de evento próprio: a transação é o que identifica a entrega. Duas
  // entregas do mesmo pagamento trazem o mesmo `transaction_nsu`, e é isso que
  // `UNIQUE (provider, provider_event_id)` usa para não creditar duas vezes.
  const providerEventId = typeof body.transaction_nsu === 'string' && body.transaction_nsu
    ? body.transaction_nsu
    : orderNsu

  let eventId: string | null
  try {
    eventId = await recordEvent(supabase, {
      provider: PROVIDER,
      providerEventId,
      // Não há campo de tipo: o webhook só dispara em pagamento aprovado.
      eventType: 'payment.approved',
      payload: body as Record<string, unknown>,
      // Nunca `true`: a InfinitePay não assina. Ver cabeçalho.
      signatureValid: false,
    })
  } catch (err) {
    log('error', 'webhook.persist_failed', { provider: PROVIDER, error: String(err) })
    // 400 = reenviar, na convenção deles. Ver cabeçalho.
    return new Response('Retry', { status: 400 })
  }

  const ok = new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  if (!eventId) return ok

  // RESPONDE ANTES DE PROCESSAR: eles pedem resposta em menos de 1 segundo, e
  // processar envolve uma ida à API deles. Seguro porque o evento JÁ está no
  // inbox — falha de processamento vira linha com `processed_at IS NULL`, que é
  // a fila de replay (`idx_gateway_events_unprocessed`).
  EdgeRuntime.waitUntil(
    // O MESMO processamento que o dreno da fila usa (ADR 0034, Fase 3b): ele
    // lê `order_nsu`, `transaction_nsu` e `invoice_slug` do payload gravado —
    // que é este, o corpo inteiro que a InfinitePay mandou. Guardar o corpo
    // completo no inbox é o que torna o reprocessamento possível aqui, já que
    // `payment_check` exige os quatro campos.
    processInfinitePayEvent(supabase, {
      id: eventId,
      event_type: 'payment.approved',
      provider_event_id: providerEventId,
      payload: body as Record<string, unknown>,
    }).catch((err) => markFailed(supabase, eventId, err)),
  )

  return ok
})
