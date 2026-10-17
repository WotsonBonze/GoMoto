import type { SupabaseClient } from '@supabase/supabase-js'
import type { MaintenanceRecord, MaintenanceRecordStatus } from '@gomoto/core'

const BUCKET = 'maintenance-files'

export async function listMaintenanceRecords(
  client: SupabaseClient,
  tenantId?: string | null,
): Promise<MaintenanceRecord[]> {
  let q = client
    .from('maintenance_records')
    .select('*')
    .order('created_at', { ascending: false })
  if (tenantId) q = q.eq('tenant_id', tenantId)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as MaintenanceRecord[]
}

export async function listMaintenanceRecordsByStatus(
  client: SupabaseClient,
  status: MaintenanceRecordStatus,
): Promise<MaintenanceRecord[]> {
  const { data, error } = await client
    .from('maintenance_records')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as MaintenanceRecord[]
}

export type MaintenanceRecordInsert = Omit<
  MaintenanceRecord,
  | 'id'
  | 'status'
  | 'rejection_reason'
  | 'reviewed_by'
  | 'reviewed_at'
  | 'created_at'
  | 'updated_at'
>

export async function createMaintenanceRecord(
  client: SupabaseClient,
  payload: MaintenanceRecordInsert,
): Promise<MaintenanceRecord> {
  const { data, error } = await client
    .from('maintenance_records')
    .insert(payload)
    .select()
    .single()
  if (error) throw error
  return data as MaintenanceRecord
}

/**
 * Upload de foto para o bucket público `maintenance-files`. O caller traz o
 * binário já materializado (Blob | ArrayBuffer) — assim a função fica
 * agnóstica a web/mobile (no mobile, o URI do expo-image-picker vira
 * ArrayBuffer via fetch().arrayBuffer() antes da chamada).
 */
export async function uploadMaintenanceFile(
  client: SupabaseClient,
  payload: {
    customerId: string
    kind: 'odometer' | 'invoice'
    body: Blob | ArrayBuffer
    contentType: string
  },
): Promise<string> {
  const ext = mimeToExt(payload.contentType)
  const path = `mobile/${payload.customerId}/${payload.kind}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}.${ext}`
  const { error } = await client.storage.from(BUCKET).upload(path, payload.body, {
    contentType: payload.contentType,
    upsert: false,
  })
  if (error) throw error
  const { data } = client.storage.from(BUCKET).getPublicUrl(path)
  return data.publicUrl
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/webp':
      return 'webp'
    case 'image/heic':
      return 'heic'
    case 'image/gif':
      return 'gif'
    default:
      return 'bin'
  }
}

export async function reviewMaintenanceRecord(
  client: SupabaseClient,
  id: string,
  payload:
    | { status: 'approved'; reviewed_by: string; reviewed_at: string }
    | { status: 'rejected'; reviewed_by: string; reviewed_at: string; rejection_reason: string },
): Promise<MaintenanceRecord> {
  const { data, error } = await client
    .from('maintenance_records')
    .update(payload)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data as MaintenanceRecord
}
