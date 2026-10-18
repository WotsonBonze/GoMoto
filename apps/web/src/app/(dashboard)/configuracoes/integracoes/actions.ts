'use server'

/**
 * Reprocessamento de evento de gateway — ADR 0034 Fase 3b.
 *
 * Fecha a Questão 2 da ADR 0033: os webhooks respondem antes de processar, o
 * que faz o provedor considerar a entrega concluída e nunca reenviar. Um evento
 * que falha depois disso fica em `processed_at IS NULL` e, até aqui, ninguém
 * voltava para pegá-lo.
 *
 * O trabalho de verdade acontece na Edge Function `gateway-replay`, que chama
 * o MESMO processador do webhook. Esta action é a porta: confere o papel,
 * confere que o evento é do tenant de quem clicou, e só então dispara.
 */

import { revalidatePath } from 'next/cache'

import { requireTenantOwnerOrAdmin } from '@/lib/auth/tenant'
import { logAction } from '@/lib/audit'
import { replayEvent, replayIsConfigured } from '@/lib/payment/replay'

type ReplayResult =
  | { ok: true; status: 'processed' }
  | { ok: false; message: string }

export async function replayGatewayEventAction(rawEventId: unknown): Promise<ReplayResult> {
  let ctx
  try {
    ctx = await requireTenantOwnerOrAdmin()
  } catch {
    return { ok: false, message: 'Só Owner e Admin podem reprocessar eventos.' }
  }

  if (typeof rawEventId !== 'string' || !rawEventId) {
    return { ok: false, message: 'Evento inválido.' }
  }

  // Titularidade ANTES de chamar a função, que roda com service_role e não
  // confere tenant nenhum. Sem esta linha, um Owner de uma locadora
  // reprocessaria o evento de outra passando o id — a Edge Function aceitaria,
  // porque ela existe para ser chamada por backend confiável.
  //
  // A leitura é com o cliente do USUÁRIO, sob RLS: se o evento não é dele, a
  // consulta não devolve nada, e não precisamos comparar tenant à mão.
  const { data: evento } = await ctx.supabase
    .from('gateway_events')
    .select('id, provider, processed_at')
    .eq('id', rawEventId)
    .maybeSingle()

  if (!evento) return { ok: false, message: 'Evento não encontrado.' }

  const e = evento as { id: string; provider: string; processed_at: string | null }
  if (e.processed_at) {
    return { ok: false, message: 'Este evento já foi processado.' }
  }

  if (!replayIsConfigured()) {
    return { ok: false, message: 'Reprocessamento não configurado neste ambiente.' }
  }

  const r = await replayEvent(e.id)

  if (r.status === 'processed') {
    await logAction({
      action: 'update',
      table: 'gateway_events',
      recordId: e.id,
      newData: { provider: e.provider, replay: 'processed' },
    })

    revalidatePath('/configuracoes/integracoes')
    return { ok: true, status: 'processed' }
  }

  // A falha da verificação também revalida: o evento continua na fila, mas com
  // o motivo NOVO — que é exatamente o que o operador precisa ler para decidir
  // o que fazer.
  if (r.status === 'failed') {
    revalidatePath('/configuracoes/integracoes')
    return { ok: false, message: `Ainda não deu: ${r.error}` }
  }

  if (r.status === 'unreachable') {
    return { ok: false, message: `Não foi possível falar com o reprocessador: ${r.error}` }
  }

  const motivos: Record<string, string> = {
    already_processed: 'Este evento já foi processado.',
    event_not_found: 'Evento não encontrado no inbox.',
    provider_not_replayable: 'Este provedor não sabe reprocessar eventos.',
  }

  return { ok: false, message: motivos[r.reason] ?? `Falha ao reprocessar (${r.httpStatus}).` }
}
