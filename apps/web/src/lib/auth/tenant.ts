import type { SupabaseClient } from '@supabase/supabase-js'
import type { TenantMemberRole } from '@gomoto/core'

import { createClient } from '@/lib/supabase/server'

/**
 * Resolve o tenant ativo do usuário autenticado a partir de `tenant_members`.
 * Retorna null se não houver usuário ou vínculo. Sob RLS, um membro revogado
 * não enxerga a própria linha (get_user_tenants() filtra status='active') —
 * então isso também devolve null para revogados, propositalmente (Spec 0011 §2.1).
 */
export async function getCurrentTenantId(client: SupabaseClient): Promise<string | null> {
  const {
    data: { user },
  } = await client.auth.getUser()
  if (!user) return null
  const { data } = await client
    .from('tenant_members')
    .select('tenant_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return data?.tenant_id ?? null
}

/**
 * Papel do usuário autenticado no tenant atual, ou null se não houver vínculo.
 * Não lança: serve para decidir o que MOSTRAR (ex.: menu de Configurações).
 * Para decidir o que PERMITIR, use os guards abaixo.
 */
export async function getCurrentTenantRole(client: SupabaseClient): Promise<TenantMemberRole | null> {
  const {
    data: { user },
  } = await client.auth.getUser()
  if (!user) return null
  const tenantId = await getCurrentTenantId(client)
  if (!tenantId) return null
  const { data } = await client
    .from('tenant_members')
    .select('role')
    .eq('tenant_id', tenantId)
    .eq('user_id', user.id)
    .maybeSingle()
  return (data?.role as TenantMemberRole | undefined) ?? null
}

export type TenantMemberContext = {
  supabase: SupabaseClient
  userId: string
  tenantId: string
  role: TenantMemberRole
}

/**
 * Guard de Server Actions/pages do cockpit de tenant: garante que o caller
 * é Owner ou Admin do tenant atual (Spec 0011 RN-006) e devolve o contexto
 * pronto. Lança erro caso contrário — mesmo formato de requirePlatformAdmin()
 * (lib/auth/platform.ts): rotas usam redirect() antes para evitar throw,
 * Server Actions capturam e devolvem ActionResult.
 */
export async function requireTenantOwnerOrAdmin(): Promise<TenantMemberContext> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHORIZED')

  const tenantId = await getCurrentTenantId(supabase)
  if (!tenantId) throw new Error('UNAUTHORIZED')

  const { data: member } = await supabase
    .from('tenant_members')
    .select('role')
    .eq('tenant_id', tenantId)
    .eq('user_id', user.id)
    .maybeSingle()

  const role = member?.role as TenantMemberRole | undefined
  if (role !== 'owner' && role !== 'admin') throw new Error('FORBIDDEN')

  return { supabase, userId: user.id, tenantId, role }
}

/** Guard restrito a Tenant Owner. Lança FORBIDDEN se for Admin/Operator/Viewer. */
export async function requireTenantOwner(): Promise<TenantMemberContext> {
  const ctx = await requireTenantOwnerOrAdmin()
  if (ctx.role !== 'owner') throw new Error('FORBIDDEN')
  return ctx
}
