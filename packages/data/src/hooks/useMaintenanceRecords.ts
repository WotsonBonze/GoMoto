import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSupabaseContext, useReadScope, useRequiredTenantId } from '../context'
import {
  createMaintenanceRecord,
  listMaintenanceRecords,
  listMaintenanceRecordsByStatus,
  reviewMaintenanceRecord,
  uploadMaintenanceFile,
} from '../repositories/maintenanceRecords'
import type { MaintenanceRecord, MaintenanceRecordStatus } from '@gomoto/core'

const KEY = 'maintenance_records'

export function useMaintenanceRecords() {
  const supabase = useSupabaseContext()
  const scope = useReadScope()
  return useQuery({
    queryKey: [KEY, { tenantId: scope.tenantId }],
    queryFn: () => listMaintenanceRecords(supabase, scope.tenantId),
    enabled: scope.ready,
  })
}

export function useMaintenanceRecordsByStatus(status: MaintenanceRecordStatus) {
  const supabase = useSupabaseContext()
  return useQuery({
    queryKey: [KEY, 'status', status],
    queryFn: () => listMaintenanceRecordsByStatus(supabase, status),
  })
}

export type CreateMaintenanceRecordInput = {
  customer_id: string
  vehicle_id: string
  maintenance_id: string | null
  actual_km: number
  cost: number | null
  workshop: string | null
  notes: string | null
  // O caller traz os Blobs/ArrayBuffers das fotos já materializados — o hook
  // faz upload e grava as URLs públicas em odometer_photo_url / invoice_photo_url.
  odometer_photo?: { body: Blob | ArrayBuffer; contentType: string } | null
  invoice_photo?: { body: Blob | ArrayBuffer; contentType: string } | null
}

export function useCreateMaintenanceRecord() {
  const supabase = useSupabaseContext()
  const getTenantId = useRequiredTenantId()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateMaintenanceRecordInput): Promise<MaintenanceRecord> => {
      const odometer_photo_url = input.odometer_photo
        ? await uploadMaintenanceFile(supabase, {
            customerId: input.customer_id,
            kind: 'odometer',
            body: input.odometer_photo.body,
            contentType: input.odometer_photo.contentType,
          })
        : null
      const invoice_photo_url = input.invoice_photo
        ? await uploadMaintenanceFile(supabase, {
            customerId: input.customer_id,
            kind: 'invoice',
            body: input.invoice_photo.body,
            contentType: input.invoice_photo.contentType,
          })
        : null
      return createMaintenanceRecord(supabase, {
        tenant_id: getTenantId(),
        customer_id: input.customer_id,
        vehicle_id: input.vehicle_id,
        maintenance_id: input.maintenance_id,
        actual_km: input.actual_km,
        cost: input.cost,
        workshop: input.workshop,
        notes: input.notes,
        odometer_photo_url,
        invoice_photo_url,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] })
      qc.invalidateQueries({ queryKey: ['maintenances'] })
    },
  })
}

export function useReviewMaintenanceRecord() {
  const supabase = useSupabaseContext()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string
      payload:
        | { status: 'approved'; reviewed_by: string; reviewed_at: string }
        | {
            status: 'rejected'
            reviewed_by: string
            reviewed_at: string
            rejection_reason: string
          }
    }) => reviewMaintenanceRecord(supabase, id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY] })
      qc.invalidateQueries({ queryKey: ['maintenances'] })
    },
  })
}
