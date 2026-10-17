import type { SupabaseClient } from '@supabase/supabase-js'
import type { Rental } from '@gomoto/core'

type RentalFilter = {
  status?: 'active' | 'closed' | 'transferred'
}

export async function listRentals(
  client: SupabaseClient,
  filter?: RentalFilter,
  tenantId?: string | null,
): Promise<Rental[]> {
  let q = client
    .from('rentals')
    .select('*, customer:customers(*), vehicle:vehicles(*)')
    .order('created_at', { ascending: false })

  if (filter?.status) {
    q = q.eq('status', filter.status)
  }
  if (tenantId) q = q.eq('tenant_id', tenantId)

  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as Rental[]
}

export async function listActiveRentals(
  client: SupabaseClient,
  tenantId?: string | null,
): Promise<Rental[]> {
  return listRentals(client, { status: 'active' }, tenantId)
}

export async function getRental(client: SupabaseClient, id: string): Promise<Rental> {
  const { data, error } = await client
    .from('rentals')
    .select('*, customer:customers(*), vehicle:vehicles(*)')
    .eq('id', id)
    .single()
  if (error) throw error
  return data as Rental
}

export async function createRentalRecord(
  client: SupabaseClient,
  payload: Omit<Rental, 'id' | 'created_at' | 'updated_at' | 'customer' | 'vehicle'>,
): Promise<Rental> {
  const { data, error } = await client.from('rentals').insert(payload).select().single()
  if (error) throw error
  return data as Rental
}

export async function updateRentalRecord(
  client: SupabaseClient,
  id: string,
  payload: Partial<Omit<Rental, 'id' | 'created_at' | 'updated_at' | 'customer' | 'vehicle'>>,
): Promise<Rental> {
  const { data, error } = await client
    .from('rentals')
    .update(payload)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data as Rental
}
