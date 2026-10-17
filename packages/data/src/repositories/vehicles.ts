import type { SupabaseClient } from '@supabase/supabase-js'
import type { Vehicle } from '@gomoto/core'

export async function listVehicles(
  client: SupabaseClient,
  tenantId?: string | null,
): Promise<Vehicle[]> {
  let q = client
    .from('vehicles')
    .select('*')
    .order('created_at', { ascending: false })
  if (tenantId) q = q.eq('tenant_id', tenantId)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as Vehicle[]
}

export async function listAvailableVehicles(client: SupabaseClient): Promise<Vehicle[]> {
  const { data, error } = await client
    .from('vehicles')
    .select('*')
    .eq('status', 'available')
    .order('license_plate', { ascending: true })
  if (error) throw error
  return (data ?? []) as Vehicle[]
}

export async function getVehicle(client: SupabaseClient, id: string): Promise<Vehicle> {
  const { data, error } = await client.from('vehicles').select('*').eq('id', id).single()
  if (error) throw error
  return data as Vehicle
}

export async function createVehicle(
  client: SupabaseClient,
  payload: Omit<Vehicle, 'id' | 'created_at' | 'updated_at'>,
): Promise<Vehicle> {
  const { data, error } = await client.from('vehicles').insert(payload).select().single()
  if (error) throw error
  return data as Vehicle
}

export async function updateVehicle(
  client: SupabaseClient,
  id: string,
  payload: Partial<Omit<Vehicle, 'id' | 'created_at' | 'updated_at'>>,
): Promise<Vehicle> {
  const { data, error } = await client
    .from('vehicles')
    .update(payload)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data as Vehicle
}

export async function deleteVehicle(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('vehicles').delete().eq('id', id)
  if (error) throw error
}
