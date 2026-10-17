import type { SupabaseClient } from '@supabase/supabase-js'
import type { Maintenance } from '@gomoto/core'

export async function listMaintenances(
  client: SupabaseClient,
  tenantId?: string | null,
): Promise<Maintenance[]> {
  let q = client
    .from('maintenances')
    .select('*, vehicle:vehicles(*)')
    .order('created_at', { ascending: false })
  if (tenantId) q = q.eq('tenant_id', tenantId)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as Maintenance[]
}

export async function listMaintenancesByVehicle(
  client: SupabaseClient,
  vehicleId: string,
): Promise<Maintenance[]> {
  const { data, error } = await client
    .from('maintenances')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Maintenance[]
}

export async function createMaintenance(
  client: SupabaseClient,
  payload: Omit<Maintenance, 'id' | 'created_at' | 'updated_at' | 'vehicle'>,
): Promise<Maintenance> {
  const { data, error } = await client.from('maintenances').insert(payload).select().single()
  if (error) throw error
  return data as Maintenance
}

export async function updateMaintenance(
  client: SupabaseClient,
  id: string,
  payload: Partial<Omit<Maintenance, 'id' | 'created_at' | 'updated_at' | 'vehicle'>>,
): Promise<Maintenance> {
  const { data, error } = await client
    .from('maintenances')
    .update(payload)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data as Maintenance
}

export async function deleteMaintenance(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('maintenances').delete().eq('id', id)
  if (error) throw error
}
