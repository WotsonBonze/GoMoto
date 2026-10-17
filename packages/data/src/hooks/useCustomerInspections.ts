import { useQuery } from '@tanstack/react-query'
import { useReadScope, useSupabaseContext } from '../context'
import { listPendingInspectionSchedulesForCustomer } from '../repositories/inspectionSchedules'
import { listPeriodicInspectionsForCustomer } from '../repositories/inspections'

const KEY = 'inspections-customer'

/**
 * Agendamentos de vistoria periódica pendentes/atrasados/rejeitados do
 * cliente autenticado (RLS já escopa às próprias locações). Alimenta a tela
 * de vistoria periódica do app mobile (RF-016, RF-021).
 */
export function usePendingInspectionSchedulesForCustomer() {
  const supabase = useSupabaseContext()
  const scope = useReadScope()
  return useQuery({
    queryKey: [KEY, 'pending-schedules', { tenantId: scope.tenantId }],
    queryFn: () => listPendingInspectionSchedulesForCustomer(supabase, scope.tenantId),
    enabled: scope.ready,
    staleTime: 60 * 1000,
  })
}

/** Histórico de vistorias periódicas (todos os status) do cliente autenticado — RF-021/RN-010. */
export function usePeriodicInspectionsForCustomer() {
  const supabase = useSupabaseContext()
  const scope = useReadScope()
  return useQuery({
    queryKey: [KEY, 'history', { tenantId: scope.tenantId }],
    queryFn: () => listPeriodicInspectionsForCustomer(supabase, scope.tenantId),
    enabled: scope.ready,
    staleTime: 60 * 1000,
  })
}
