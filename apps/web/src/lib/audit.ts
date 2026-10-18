import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getCurrentTenantId } from '@/lib/auth/tenant'

interface AuditParams {
  /**
   * O vocabulário da trilha.
   *
   * `payment_confirmed`, `payment_reversed` e `token_refreshed` NÃO são escritos
   * daqui: quem os grava é o banco, por trigger, na mesma transação do
   * pagamento (ADR 0034 Fase 5). Eles ficam listados porque quem lê a trilha
   * encontra os três, e um vocabulário incompleto faria parecer que só existe o
   * que a aplicação escreve.
   *
   * A escolha não é estilística. A confirmação de gateway roda em Deno, com
   * `service_role`, e este módulo vive em `apps/web` — nenhuma disciplina de
   * código alcança um caminho que não passa pela aplicação. Foi por isso que
   * `payment_confirmed` existiu aqui por meses sem um único escritor.
   */
  action: 'create' | 'update' | 'delete'
    | 'connect_payment' | 'disconnect_payment'
    | 'generate_pix'
    | 'payment_confirmed' | 'payment_reversed' | 'token_refreshed'
  table: string
  recordId?: string
  oldData?: unknown
  newData?: unknown
}

/**
 * Por que devolve resultado em vez de `void`.
 *
 * Antes, três desfechos diferentes eram indistinguíveis do lado de fora:
 * gravou, não havia quem gravar (sem sessão), e falhou. E o pior deles era
 * invisível até no log — **o erro do INSERT nunca era conferido**, então uma
 * gravação recusada pela RLS ou por constraint passava sem deixar nada.
 *
 * O chamador segue livre para ignorar o retorno, e a maioria ignora com razão:
 * perder o registro de "editou um veículo" não justifica desfazer a edição. O
 * ponto é que agora ele PODE saber. Para dinheiro a pergunta nem se coloca:
 * aquela trilha é escrita pelo banco, na mesma transação, e não tem como não
 * acontecer.
 */
export type AuditResult =
  | { ok: true }
  | { ok: false; reason: 'no_session' | 'no_tenant' | 'write_failed'; detail?: string }

function audit(level: 'info' | 'warn' | 'error', action: string, fields: Record<string, unknown>) {
  const out = JSON.stringify({ ts: new Date().toISOString(), level, action, ...fields })
  level === 'error' ? console.error(out) : console.warn(out)
}

export async function logAction(params: AuditParams): Promise<AuditResult> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      // Não é erro: é caminho sem sessão. Mas também não é sucesso, e tratar os
      // dois como a mesma coisa foi o que deixou a trilha silenciosamente vazia.
      audit('warn', 'audit.skipped', { reason: 'no_session', action: params.action, table: params.table })
      return { ok: false, reason: 'no_session' }
    }

    const tenantId = await getCurrentTenantId(supabase)
    if (!tenantId) {
      audit('warn', 'audit.skipped', { reason: 'no_tenant', action: params.action, table: params.table })
      return { ok: false, reason: 'no_tenant' }
    }

    const { error } = await supabase.from('audit_logs').insert({
      tenant_id: tenantId,
      user_id: user.id,
      action: params.action,
      table_name: params.table,
      record_id: params.recordId ?? null,
      old_data: params.oldData ?? null,
      new_data: params.newData ?? null,
    })

    if (error) {
      audit('error', 'audit.write_failed', {
        action: params.action, table: params.table,
        record_id: params.recordId ?? null, error: error.message,
      })
      return { ok: false, reason: 'write_failed', detail: error.message }
    }

    return { ok: true }
  } catch (err) {
    audit('error', 'audit.write_failed', {
      action: params.action, table: params.table, error: String(err),
    })
    return { ok: false, reason: 'write_failed', detail: String(err) }
  }
}

export async function logPlatformAction(
  supabase: SupabaseClient,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await supabase.from('platform_audit_logs').insert({
      actor_id: actorId,
      action,
      target_type: targetType,
      target_id: targetId,
      metadata,
    })
  } catch (err) {
    console.error('[PLATFORM AUDIT ERROR]', err)
  }
}
