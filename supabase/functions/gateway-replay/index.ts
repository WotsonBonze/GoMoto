// Supabase Edge Function — Deno runtime
//
// Dreno da fila de replay (ADR 0034 Fase 3b; Questão 2 da ADR 0033).
//
// O PROBLEMA QUE ELA FECHA
//
// Os três webhooks respondem ANTES de processar, porque os provedores exigem
// resposta rápida (a Cora cadastra `readTimeout: 2000`; a InfinitePay pede menos
// de 1 segundo). O evento fica durável no inbox antes da resposta, então nada se
// perde — mas ao responder `200` **abrimos mão da retentativa do provedor**:
// para ele a entrega foi um sucesso, e ele nunca mais manda aquele evento.
//
// Consequência: se o processamento falhar depois — token vencido, provedor fora
// do ar, bug nosso, ou a instância morrer antes de o `waitUntil` terminar —, a
// linha fica com `processed_at IS NULL` e `processing_error`, e **ninguém volta
// para pegá-la**. `idx_gateway_events_unprocessed` sempre foi chamado de "fila
// de replay" e nunca teve consumidor. Esta função é o consumidor.
//
// POR QUE ELA NÃO REIMPLEMENTA NADA
//
// Reprocessar é reconsultar o provedor e aplicar ao razão — exatamente o que o
// webhook faz. Uma segunda implementação divergiria da primeira no primeiro
// ajuste, e a divergência apareceria como dinheiro confirmado de dois jeitos
// diferentes. Por isso os processadores saíram dos arquivos de webhook para
// `_shared/<provedor>.ts`, e ambos os caminhos chamam a MESMA função, que lê do
// payload gravado.
//
// AUTENTICAÇÃO
//
// `verify_jwt` fica LIGADO (o default), ao contrário dos webhooks — aqui não há
// provedor externo para acomodar. Quem chama é a Server Action do cockpit, com
// a chave `service_role`, depois de ter conferido papel (Owner/Admin) e de ter
// confirmado que o evento é do tenant de quem clicou. Esta função não recebe
// tenant por parâmetro: ela reprocessa um evento por id, e o id só chega aqui
// depois daquela checagem.

import { createClient } from 'npm:@supabase/supabase-js@2'

import { log, markFailed, markProcessed, type StoredEvent } from '../_shared/inbox.ts'
import { processCoraEvent } from '../_shared/cora.ts'
import { processMercadoPagoEvent } from '../_shared/mercadopago.ts'
import { processInfinitePayEvent } from '../_shared/infinitepay.ts'
import { processAsaasEvent } from '../_shared/asaas.ts'

type Processador = (
  supabase: ReturnType<typeof createClient>,
  event: StoredEvent,
) => Promise<void>

/**
 * DENYLIST invertida: provedor que não está aqui não é reprocessável.
 *
 * É o oposto da escolha feita no filtro de eventos da Cora, e de propósito:
 * lá, deixar passar o desconhecido evita descartar dinheiro em silêncio; aqui,
 * o desconhecido é um provedor para o qual não temos como reconsultar nada, e
 * fingir que reprocessamos seria pior que recusar.
 */
const PROCESSADORES: Record<string, Processador> = {
  cora: processCoraEvent,
  mercadopago: processMercadoPagoEvent,
  infinitepay: processInfinitePayEvent,
  asaas: processAsaasEvent,
}

type EventRow = {
  id: string
  provider: string
  event_type: string
  provider_event_id: string
  payload: Record<string, unknown>
  processed_at: string | null
  attempts: number
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  let body: { event_id?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }

  const eventId = typeof body.event_id === 'string' ? body.event_id : ''
  if (!eventId) return json({ error: 'event_id_required' }, 400)

  const { data, error } = await supabase
    .from('gateway_events')
    .select('id, provider, event_type, provider_event_id, payload, processed_at, attempts')
    .eq('id', eventId)
    .maybeSingle()

  if (error) return json({ error: 'lookup_failed', detail: error.message }, 500)
  if (!data) return json({ error: 'event_not_found' }, 404)

  const event = data as EventRow

  // Já processado não se reprocessa. `fn_confirm_gateway_payment` é idempotente
  // — ela devolve o pagamento existente em vez de criar um segundo —, então
  // repetir não duplicaria dinheiro. Mas reprocessar o que já deu certo gasta
  // uma ida à API do provedor e, num evento de estorno, embaralharia o
  // histórico. Recusar é a resposta honesta.
  if (event.processed_at) {
    return json({ status: 'already_processed', processed_at: event.processed_at }, 409)
  }

  const processar = PROCESSADORES[event.provider]
  if (!processar) {
    return json({ error: 'provider_not_replayable', provider: event.provider }, 422)
  }

  // Quem conta é o `markFailed`, no caminho da falha. Incrementar aqui também
  // contaria duas vezes a mesma tentativa — e `attempts` significa "quantas
  // vezes isto já falhou", não "quantas vezes foi tocado".
  log('info', 'replay.start', {
    provider: event.provider, event_id: event.id, ja_falhou: event.attempts ?? 0,
  })

  try {
    await processar(supabase, {
      id: event.id,
      event_type: event.event_type,
      provider_event_id: event.provider_event_id,
      payload: event.payload ?? {},
    })
  } catch (err) {
    // A falha volta para a MESMA fila, com o erro atualizado. O operador vê o
    // motivo novo na tela de diagnóstico em vez de continuar olhando o antigo.
    await markFailed(supabase, event.id, err)
    return json({ status: 'failed', error: String(err) }, 200)
  }

  // O processador marca como processado quando conclui. Se ele decidiu que o
  // evento não vira dinheiro e ainda assim não marcou, marcamos aqui: um evento
  // que passou pelo replay sem erro não pode voltar para a fila.
  const { data: depois } = await supabase
    .from('gateway_events')
    .select('processed_at')
    .eq('id', event.id)
    .maybeSingle()

  if (!(depois as { processed_at: string | null } | null)?.processed_at) {
    await markProcessed(supabase, event.id, null)
  }

  // Sucesso limpa o erro anterior: ele descreve uma tentativa que não vale
  // mais, e deixá-lo na linha faria a tela mostrar como problema algo já
  // resolvido.
  await supabase
    .from('gateway_events')
    .update({ processing_error: null })
    .eq('id', event.id)

  log('info', 'replay.ok', { provider: event.provider, event_id: event.id })

  return json({ status: 'processed', event_id: event.id })
})
