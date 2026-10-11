import { findPaymentProvider } from '@gomoto/core'
import type { GatewayHistoryEntry } from '@gomoto/data'

/** Como cada alteração aparece para a locadora (ADR 0039). */
const ACTION_LABELS: Record<GatewayHistoryEntry['action'], string> = {
  gateway_connected: 'Conectada',
  gateway_reconnected: 'Reconectada',
  gateway_activated: 'Ativada para cobrar',
  gateway_deactivated: 'Deixou de cobrar',
  gateway_disconnected: 'Desconectada',
  gateway_deleted: 'Excluída',
}

export type GatewayHistoryRow = {
  id: string
  when: string
  gateway: string
  action: string
  account: string
  actor: string
}

/**
 * Linha da tabela de histórico.
 *
 * O autor é o e-mail gravado NO MOMENTO da alteração — continua legível mesmo
 * que o usuário seja removido depois. Sem usuário, foi o sistema: a migration
 * que limpou duplicatas (ADR 0039) aparece com o nome dela, não como "alguém".
 */
export function toHistoryRow(e: GatewayHistoryEntry, timeZone = 'America/Sao_Paulo'): GatewayHistoryRow {
  return {
    id: e.id,
    when: new Intl.DateTimeFormat('pt-BR', {
      timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(e.created_at)),
    gateway: findPaymentProvider(e.provider)?.label ?? e.provider,
    action: ACTION_LABELS[e.action] ?? e.action,
    account: e.account_label ?? e.external_account_id ?? '—',
    actor: e.actor_email ?? systemActorLabel(e.actor_system),
  }
}

function systemActorLabel(actor: string | null): string {
  if (!actor) return 'Sistema'
  if (actor.startsWith('system:migration')) return 'Sistema (ajuste de dados)'
  return 'Sistema'
}
