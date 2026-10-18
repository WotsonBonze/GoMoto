import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSupabaseContext, useReadScope, useRequiredTenantId } from '../context'
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} from '../repositories/customers'
import type { Customer } from '@gomoto/core'

const KEY = 'customers'

export function useCustomers() {
  const supabase = useSupabaseContext()
  const scope = useReadScope()
  return useQuery({
    queryKey: [KEY, { tenantId: scope.tenantId }],
    queryFn: () => listCustomers(supabase, scope.tenantId),
    enabled: scope.ready,
  })
}

export function useCustomer(id: string) {
  const supabase = useSupabaseContext()
  return useQuery({ queryKey: [KEY, id], queryFn: () => getCustomer(supabase, id) })
}

export function useCreateCustomer() {
  const supabase = useSupabaseContext()
  const getTenantId = useRequiredTenantId()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: Omit<Customer, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>) =>
      createCustomer(supabase, { ...payload, tenant_id: getTenantId() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  })
}

export function useUpdateCustomer() {
  const supabase = useSupabaseContext()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string
      payload: Partial<Omit<Customer, 'id' | 'created_at' | 'updated_at'>>
    }) => updateCustomer(supabase, id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  })
}

export function useDeleteCustomer() {
  const supabase = useSupabaseContext()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteCustomer(supabase, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  })
}
