import { useQuery } from '@tanstack/react-query'
import { useReadScope, useSupabaseContext } from '../context'
import { listRentals, listActiveRentals } from '../repositories/rentals'
import type { Rental } from '@gomoto/core'

const KEY = 'rentals'

export function useRentals(filter?: { status?: 'active' | 'closed' | 'transferred' }) {
  const supabase = useSupabaseContext()
  const scope = useReadScope()
  return useQuery<Rental[]>({
    queryKey: [KEY, filter, { tenantId: scope.tenantId }],
    queryFn: () => listRentals(supabase, filter, scope.tenantId),
    enabled: scope.ready,
  })
}

export function useActiveRentals() {
  const supabase = useSupabaseContext()
  const scope = useReadScope()
  return useQuery<Rental[]>({
    queryKey: [KEY, 'active', { tenantId: scope.tenantId }],
    queryFn: () => listActiveRentals(supabase, scope.tenantId),
    enabled: scope.ready,
  })
}
