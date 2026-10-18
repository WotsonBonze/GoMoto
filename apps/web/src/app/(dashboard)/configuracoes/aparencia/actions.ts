'use server'

import { ThemePreferenceSchema } from '@gomoto/core'
import { createClient } from '@/lib/supabase/server'
import { getCurrentTenantId } from '@/lib/auth/tenant'
import { logAction } from '@/lib/audit'
import { revalidatePath } from 'next/cache'

async function getAuthenticatedTenant() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'UNAUTHORIZED' as const }
  const tenantId = await getCurrentTenantId(supabase)
  if (!tenantId) return { error: 'UNAUTHORIZED' as const }
  return { supabase, user, tenantId }
}

// ============================================================
// updateThemePreferenceAction — direção de marca + modo de cor (ADR 0019)
// Preferência por operador (tenant_members), não por tenant.
// ============================================================

export async function updateThemePreferenceAction(input: unknown) {
  const ctx = await getAuthenticatedTenant()
  if ('error' in ctx) return { ok: false, error: { code: ctx.error, message: 'Não autorizado' } }

  const parsed = ThemePreferenceSchema.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: first?.message ?? 'Dados inválidos' } }
  }

  // RPC SECURITY DEFINER, não UPDATE direto: a única policy de UPDATE em
  // tenant_members ("Owners/admins can manage members") exige role
  // owner/admin — operator/viewer não conseguem alterar nem a própria
  // linha por ela. Sem a RPC, o update roda sem erro mas afeta 0 linhas.
  const { error } = await ctx.supabase.rpc('update_own_theme_preference', {
    p_theme_brand: parsed.data.theme_brand,
    p_color_mode: parsed.data.color_mode,
  })

  if (error) return { ok: false, error: { code: 'INTERNAL', message: error.message } }

  await logAction({
    action: 'update',
    table: 'tenant_members',
    newData: parsed.data,
  })

  // Revalida o layout raiz (não só /configuracoes) — é onde data-brand/data-mode
  // são escritos no <html> a partir de tenant_members (ADR 0019 §5).
  revalidatePath('/', 'layout')
  return { ok: true, data: undefined }
}
