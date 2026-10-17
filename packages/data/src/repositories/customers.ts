import type { SupabaseClient } from '@supabase/supabase-js'
import type { Customer } from '@gomoto/core'

export async function listCustomers(
  client: SupabaseClient,
  tenantId?: string | null,
): Promise<Customer[]> {
  let q = client
    .from('customers')
    .select('*')
    .order('created_at', { ascending: false })
  if (tenantId) q = q.eq('tenant_id', tenantId)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as Customer[]
}

export async function getCustomer(client: SupabaseClient, id: string): Promise<Customer> {
  const { data, error } = await client.from('customers').select('*').eq('id', id).single()
  if (error) throw error
  return data as Customer
}

export async function createCustomer(
  client: SupabaseClient,
  payload: Omit<Customer, 'id' | 'created_at' | 'updated_at'>,
): Promise<Customer> {
  const { data, error } = await client.from('customers').insert(payload).select().single()
  if (error) throw error
  return data as Customer
}

export async function updateCustomer(
  client: SupabaseClient,
  id: string,
  payload: Partial<Omit<Customer, 'id' | 'created_at' | 'updated_at'>>,
): Promise<Customer> {
  const { data, error } = await client
    .from('customers')
    .update(payload)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data as Customer
}

export async function deleteCustomer(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('customers').delete().eq('id', id)
  if (error) throw error
}
