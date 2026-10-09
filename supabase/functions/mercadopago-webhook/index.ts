// Supabase Edge Function — Deno runtime
//
// Webhook do Mercado Pago (ADR 0030, sobre ADR 0024).
//
// Este arquivo ficou com o que é HTTP: o formato do IPN, o esquema de assinatura
// `x-signature`, gravar no inbox e responder.
//
// O PROCESSAMENTO — reconsultar o pagamento no MP, traduzir o vocabulário de
// status e aplicar ao razão — mora em `_shared/mercadopago.ts` desde a ADR 0034,
// Fase 3b. A razão não é organização: o dreno da fila precisa reprocessar um
// evento gravado, e se ele reimplementasse a verificação existiriam DOIS
// caminhos para confirmar dinheiro, que divergiriam no primeiro ajuste.
//
// O que é igual a todo provedor — inbox, confirmação, estorno, idempotência —
// segue em `_shared/inbox.ts`.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'

// Mantém o trabalho vivo depois da resposta (runtime do Supabase Edge).
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }
import { verifyWebhookSignature } from '../_shared/signature.ts'
import { log, markFailed, recordEvent } from '../_shared/inbox.ts'
import { PROVIDER, processMercadoPagoEvent } from '../_shared/mercadopago.ts'

const IPNSchema = z.object({
  type: z.enum(['payment', 'merchant_order']),
  // O MP manda como string hoje, mas já mandou como número. Número caía no
  // `safeParse` e virava `unknown_type` — pagamento descartado como ruído.
  user_id: z.union([z.string(), z.number()]).transform(String),
  data: z.object({ id: z.string() }),
})

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const url = new URL(req.url)
  const dataId = url.searchParams.get('data.id') ?? ''
  const xRequestId = req.headers.get('x-request-id') ?? ''

  let body: unknown
  try {
    body = await req.json()
  } catch {
    log('warn', 'webhook.bad_request', { provider: PROVIDER, reason: 'invalid_json' })
    return new Response('Bad request', { status: 400 })
  }

  const ipn = IPNSchema.safeParse(body)
  if (!ipn.success) {
    log('info', 'webhook.skipped', { provider: PROVIDER, reason: 'unknown_type' })
    return new Response('OK', { status: 200 })
  }

  // Segredo configurado EXIGE assinatura. Antes, a verificação era pulada
  // quando o cabeçalho `x-signature` não vinha, e `signatureValid` ficava em
  // `true` por inicialização: bastava omitir o cabeçalho para forjar uma
  // confirmação de pagamento — gravada como assinatura válida.
  const verdict = await verifyWebhookSignature({
    secret: Deno.env.get('MERCADOPAGO_WEBHOOK_SECRET'),
    signatureHeader: req.headers.get('x-signature'),
    dataId,
    requestId: xRequestId,
  })

  if (!verdict.accept) {
    log('warn', 'webhook.signature_rejected', {
      provider: PROVIDER, reason: verdict.reason, x_request_id: xRequestId, data_id: dataId,
    })
    return new Response('Unauthorized', { status: 401 })
  }

  if (verdict.reason === 'unverified_no_secret') {
    log('warn', 'webhook.signature_unverified', {
      provider: PROVIDER, reason: 'MERCADOPAGO_WEBHOOK_SECRET ausente',
    })
  }

  const providerEventId = `${ipn.data.type}:${ipn.data.data.id}:${xRequestId || dataId}`

  let eventId: string | null
  try {
    eventId = await recordEvent(supabase, {
      provider: PROVIDER,
      providerEventId,
      eventType: ipn.data.type,
      payload: body,
      signatureValid: verdict.signatureValid,
    })
  } catch (err) {
    log('error', 'webhook.persist_failed', { provider: PROVIDER, error: String(err) })
    return new Response('Internal error', { status: 500 })
  }

  // Duplicata: o UNIQUE reconheceu, nada a fazer.
  if (!eventId) return new Response('OK', { status: 200 })

  // RESPONDE ANTES DE PROCESSAR.
  //
  // O comentário aqui sempre disse isso, mas o código fazia o contrário: o
  // `await` segurava a resposta até a consulta ao MP e a confirmação
  // terminarem. Gateway lento nosso vira reenvio deles.
  //
  // Seguro porque o evento já está no inbox: falha no processamento deixa a
  // linha com `processed_at IS NULL`, que é a fila de reprocessamento.
  EdgeRuntime.waitUntil(
    // O MESMO processamento que o dreno da fila usa (ADR 0034, Fase 3b): ele
    // lê do payload gravado, e é este que acabou de ser gravado.
    processMercadoPagoEvent(supabase, {
      id: eventId,
      event_type: ipn.data.type,
      provider_event_id: providerEventId,
      payload: body as Record<string, unknown>,
    }).catch((err) => markFailed(supabase, eventId, err)),
  )

  return new Response('OK', { status: 200 })
})
