import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSupabaseContext, useReadScope, useRequiredTenantId } from '../context'
import {
  listMaintenances,
  listMaintenancesByVehicle,
  createMaintenance,
  updateMaintenance,
  deleteMaintenance,
} from '../repositories/maintenances'
import type { Maintenance } from '@gomoto/core'

const KEY = 'maintenances'

export function useMaintenances() {
  const supabase = useSupabaseContext()
  const scope = useReadScope()
  return useQuery({
    queryKey: [KEY, { tenantId: scope.tenantId }],
    queryFn: () => listMaintenances(supabase, scope.tenantId),
    enabled: scope.ready,
  })
}

export function useMaintenancesByVehicle(vehicleId: string) {
  const supabase = useSupabaseContext()
  return useQuery({
    queryKey: [KEY, 'vehicle', vehicleId],
    queryFn: () => listMaintenancesByVehicle(supabase, vehicleId),
    enabled: !!vehicleId,
  })
}

export function useCreateMaintenance() {
  const supabase = useSupabaseContext()
  const getTenantId = useRequiredTenantId()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (
      payload: Omit<Maintenance, 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'vehicle'>,
    ) => createMaintenance(supabase, { ...payload, tenant_id: getTenantId() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  })
}

export function useUpdateMaintenance() {
  const supabase = useSupabaseContext()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string
      payload: Partial<Omit<Maintenance, 'id' | 'created_at' | 'updated_at' | 'vehicle'>>
    }) => updateMaintenance(supabase, id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  })
}

export function useDeleteMaintenance() {
  const supabase = useSupabaseContext()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteMaintenance(supabase, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  })
}
