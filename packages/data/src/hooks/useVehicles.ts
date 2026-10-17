import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSupabaseContext, useReadScope, useRequiredTenantId } from '../context'
import {
  listVehicles,
  listAvailableVehicles,
  getVehicle,
  createVehicle,
  updateVehicle,
  deleteVehicle,
} from '../repositories/vehicles'
import type { Vehicle } from '@gomoto/core'

const KEY = 'vehicles'

export function useVehicles() {
  const supabase = useSupabaseContext()
  const scope = useReadScope()
  return useQuery({
    queryKey: [KEY, { tenantId: scope.tenantId }],
    queryFn: () => listVehicles(supabase, scope.tenantId),
    enabled: scope.ready,
  })
}

export function useAvailableVehicles() {
  const supabase = useSupabaseContext()
  return useQuery({ queryKey: [KEY, 'available'], queryFn: () => listAvailableVehicles(supabase) })
}

export function useVehicle(id: string) {
  const supabase = useSupabaseContext()
  return useQuery({ queryKey: [KEY, id], queryFn: () => getVehicle(supabase, id) })
}

export function useCreateVehicle() {
  const supabase = useSupabaseContext()
  const getTenantId = useRequiredTenantId()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: Omit<Vehicle, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>) =>
      createVehicle(supabase, { ...payload, tenant_id: getTenantId() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  })
}

export function useUpdateVehicle() {
  const supabase = useSupabaseContext()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string
      payload: Partial<Omit<Vehicle, 'id' | 'created_at' | 'updated_at'>>
    }) => updateVehicle(supabase, id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  })
}

export function useDeleteVehicle() {
  const supabase = useSupabaseContext()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteVehicle(supabase, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  })
}
