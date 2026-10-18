import type { SupabaseClient } from '@supabase/supabase-js'
import type { TenantContact } from '@gomoto/core'

/**
 * Contatos da locadora, na ordem em que aparecem no app do cliente.
 *
 * `tenantId` é obrigatório: um cliente de duas locadoras enxerga, pela RLS, os
 * contatos das duas — sem o filtro, a aba Conta misturaria os números.
 */
export async function listTenantContacts(
  client: SupabaseClient,
  tenantId: string,
): Promise<TenantContact[]> {
  const { data, error } = await client
    .from('tenant_contacts')
    .select('id, label, phone, phone_kind, email, business_hours, sort_order')
    .eq('tenant_id', tenantId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as TenantContact[]
}
