'use server'

import { LateChargePolicyInputSchema, toPolicyRow } from '@gomoto/core'
import { requireTenantOwner } from '@/lib/auth/tenant'
import { logAction } from '@/lib/audit'
import { revalidatePath } from 'next/cache'

/** Política de encargo é restrita a Tenant Owner: define quanto TODO cliente
 *  paga de multa e juros. A trava que vale é a do banco, em
 *  `fn_create_late_charge_policy`. */
async function getOwnerTenant() {
  try {
    return await requireTenantOwner()
  } catch (err) {
    const code = err instanceof Error && err.message === 'FORBIDDEN' ? 'FORBIDDEN' : 'UNAUTHORIZED'
    return { error: code as 'FORBIDDEN' | 'UNAUTHORIZED' }
  }
}

// ============================================================
// createLateChargePolicyAction — nova versão da política de encargo
// ============================================================

/**
 * O que estava aqui era `saveFinancialSettings`: gravava a configuração como
 * JSON em `settings.late_charge_defaults` e devolvia `{ ok: true }`. Nenhum
 * código lia essa chave — a emissão sempre resolveu a política em
 * `late_charge_policies`. A action não tinha um único chamador, o que a
 * manteve inofensiva; ligar um formulário nela teria produzido uma tela que
 * aceita 5% de multa, responde "salvo", e segue cobrando 2%.
 *
 * A gravação é nova VERSÃO, nunca edição da vigente: cobrança emitida guarda
 * `late_charge_policy_id` e continua valendo o que valia no dia. A numeração
 * e a trava de retroatividade ficam na função do banco, sob lock do tenant.
 */
export async function createLateChargePolicyAction(input: unknown) {
  const ctx = await getOwnerTenant()
  if ('error' in ctx) {
    const message = ctx.error === 'FORBIDDEN'
      ? 'Apenas o Proprietário da empresa pode alterar a política de encargo'
      : 'Não autorizado'
    return { ok: false as const, error: { code: ctx.error, message } }
  }

  const parsed = LateChargePolicyInputSchema.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false as const, error: { code: 'VALIDATION_ERROR', message: first?.message ?? 'Dados inválidos' } }
  }

  const row = toPolicyRow(parsed.data)

  const { data, error } = await ctx.supabase.rpc('fn_create_late_charge_policy', {
    p_tenant_id:           ctx.tenantId,
    p_fee_type:            row.fee_type,
    p_fee_value:           row.fee_value,
    p_daily_interest_rate: row.daily_interest_rate,
    p_grace_period_days:   row.grace_period_days,
    p_min_amount:          row.min_amount,
    p_effective_from:      row.effective_from,
    p_created_by:          ctx.userId,
  })

  if (error) {
    const conhecidos: Record<string, string> = {
      EFFECTIVE_FROM_IN_PAST: 'A vigência não pode começar antes de hoje — política nova não retroage sobre o que já foi cobrado.',
      TENANT_NOT_FOUND:       'Empresa não encontrada.',
    }
    const chave = Object.keys(conhecidos).find((k) => error.message.includes(k))
    return {
      ok: false as const,
      error: { code: chave ? 'VALIDATION_ERROR' : 'INTERNAL', message: chave ? conhecidos[chave]! : error.message },
    }
  }

  await logAction({
    action: 'create',
    table:  'late_charge_policies',
    recordId: data as string,
    newData: { ...row, tenant_id: ctx.tenantId },
  })

  revalidatePath('/configuracoes/encargos')
  revalidatePath('/cobrancas')
  return { ok: true as const, data: { id: data as string } }
}
