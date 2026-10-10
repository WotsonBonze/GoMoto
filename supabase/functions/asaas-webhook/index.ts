// Supabase Edge Function — Deno runtime
//
// Webhook do Asaas (ADR 0037, decisões 4 e 5).
//
// A PORTA é o header `asaas-access-token`: o Asaas o envia em toda entrega com
// o `authToken` que a conexão cadastrou no webhook da conta (o mesmo para todas
// as contas — `ASAAS_WEBHOOK_TOKEN`). Comparado em tempo constante.
//
// O token prova que a requisição veio de uma configuração nossa, NÃO que o
// pagamento aconteceu. Por isso `signature_valid` fica `false` — não há
// assinatura do corpo — e a confirmação reconsulta a API com a chave da conta
// DONA do intent (`_shared/asaas.ts`).
//
// SÓ `HTTP 200` CONTA COMO ENTREGA no Asaas: 201/204 também são falha. Depois de
// 15 falhas seguidas a fila da configuração PAUSA, e o que ficar parado mais de
// 14 dias é apagado. Daí:
//   - persistiu → 200, sempre, mesmo que o processamento falhe depois (a falha
//     vai para a fila de replay, que é nossa);
//   - evento duplicado → 200;
//   - corpo sem `id`/`event` → 200 com log: reenviar não o conserta, e recusar
//     contaria para pausar a fila de eventos bons;
//   - falha ao PERSISTIR → 500: aí sim reenviar é o certo.

import { createClient } from 'npm:@supabase/supabase-js@2'

// Mantém o trabalho vivo depois da resposta (runtime do Supabase Edge).
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }
import { log, markFailed, recordEvent } from '../_shared/inbox.ts'
import { PROVIDER, processAsaasEvent } from '../_shared/asaas.ts'

/** Comparação de tempo constante — o token não pode vazar por timing. */
function tokenMatches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

const ok = () => new Response(JSON.stringify({ received: true }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const expected = Deno.env.get('ASAAS_WEBHOOK_TOKEN')
  // Sem token configurado a função recusa tudo. 503 e não 404: aqui quem chama
  // é o Asaas de verdade, e a fila pausar é o alarme certo para "deploy sem
  // segredo" — melhor que aceitar sem porta.
  if (!expected) {
    log('error', 'webhook.misconfigured', { provider: PROVIDER, reason: 'ASAAS_WEBHOOK_TOKEN ausente' })
    return new Response('Service unavailable', { status: 503 })
  }

  const given = req.headers.get('asaas-access-token') ?? ''
  if (!tokenMatches(given, expected)) {
    log('warn', 'webhook.bad_token', { provider: PROVIDER })
    return new Response('Unauthorized', { status: 401 })
  }

  let body: { id?: unknown; event?: unknown } & Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    log('warn', 'webhook.bad_request', { provider: PROVIDER, reason: 'corpo não é JSON' })
    return ok()
  }

  const eventId = typeof body.id === 'string' ? body.id : ''
  const eventType = typeof body.event === 'string' ? body.event : ''
  if (!eventId || !eventType) {
    log('warn', 'webhook.bad_request', { provider: PROVIDER, reason: 'sem id/event' })
    return ok()
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  let stored: string | null
  try {
    stored = await recordEvent(supabase, {
      provider: PROVIDER,
      // `id` do evento é a chave de idempotência que o Asaas recomenda: o mesmo
      // evento pode chegar mais de uma vez (at least once).
      providerEventId: eventId,
      eventType,
      payload: body,
      // Token não é assinatura do corpo. Ver cabeçalho.
      signatureValid: false,
    })
  } catch (err) {
    log('error', 'webhook.persist_failed', { provider: PROVIDER, error: String(err) })
    return new Response('Retry', { status: 500 })
  }

  if (!stored) return ok()

  // Responde ANTES de processar: o processamento reconsulta a API do Asaas, e a
  // entrega não pode esperar por isso. Seguro porque o evento já está no inbox
  // — falha vira linha sem `processed_at`, a fila de replay.
  EdgeRuntime.waitUntil(
    processAsaasEvent(supabase, {
      id: stored,
      event_type: eventType,
      provider_event_id: eventId,
      payload: body,
    }).catch((err) => markFailed(supabase, stored!, err)),
  )

  return ok()
})
