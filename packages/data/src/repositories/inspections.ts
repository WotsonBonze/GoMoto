import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  Inspection,
  InspectionProfile,
  InspectionProfileChecklistItem,
  InspectionProfilePhotoItem,
} from '@gomoto/core'
import { listInspectionSchedulesForTenant, type ScheduleWithRentalInfo } from './inspectionSchedules'

export interface InspectionWithRentalInfo extends Inspection {
  rental: {
    id: string
    status: string
    customer: { id: string; name: string } | null
    vehicle: { id: string; license_plate: string; make: string; model: string } | null
  } | null
}

/**
 * Vistorias check-in/check-out pendentes + periódicas submetidas aguardando
 * análise. Inclui `rental.status` para o caller decidir se um check-out
 * pendente já está de fato disponível (locação encerrada) ou ainda bloqueado
 * (Spec 0009 §3.1 — check-out nasce `pending` na criação, mas só é
 * executável na prática após o encerramento).
 */
export async function listActionablePendingInspections(
  client: SupabaseClient,
): Promise<InspectionWithRentalInfo[]> {
  const { data, error } = await client
    .from('inspections')
    .select('*, rental:rentals(id, status, customer:customers(id,name), vehicle:vehicles(id,license_plate,make,model))')
    .in('status', ['pending', 'submitted'])
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as InspectionWithRentalInfo[]
}

/**
 * Agendamentos de vistoria periódica ainda não submetidos (pendentes ou
 * atrasados) — visibilidade do administrativo sobre o que falta ao cliente,
 * sem poder de ação direta (RN-011).
 */
export async function listInspectionSchedulesAwaitingCustomer(
  client: SupabaseClient,
): Promise<(ScheduleWithRentalInfo & { status: 'pending' | 'overdue' | 'rejected'; latest_inspection: Inspection | null })[]> {
  const all = await listInspectionSchedulesForTenant(client)
  return all.filter(
    (s): s is typeof all[number] & { status: 'pending' | 'overdue' | 'rejected' } =>
      s.status === 'pending' || s.status === 'overdue' || s.status === 'rejected',
  )
}

/** Vistorias de check-in/check-out + periódicas de uma locação específica. */
export async function listInspectionsByRental(
  client: SupabaseClient,
  rentalId: string,
): Promise<Inspection[]> {
  const { data, error } = await client
    .from('inspections')
    .select('*')
    .eq('rental_id', rentalId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as Inspection[]
}

/** Histórico agregado de vistorias de um veículo, através de todas as suas locações (RF-023). */
export async function listVehicleInspectionHistory(
  client: SupabaseClient,
  vehicleId: string,
): Promise<InspectionWithRentalInfo[]> {
  const { data, error } = await client
    .from('inspections')
    .select('*, rental:rentals!inner(id, vehicle_id, customer:customers(id,name), vehicle:vehicles(id,license_plate,make,model))')
    .eq('rental.vehicle_id', vehicleId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as InspectionWithRentalInfo[]
}

/** Vistoria + itens do perfil vinculado — usado para montar o formulário de execução/análise. */
export async function getInspectionForExecution(
  client: SupabaseClient,
  inspectionId: string,
): Promise<{ inspection: Inspection; profile: InspectionProfile } | null> {
  const { data: inspection, error: inspErr } = await client
    .from('inspections')
    .select('*')
    .eq('id', inspectionId)
    .maybeSingle()
  if (inspErr) throw inspErr
  if (!inspection) return null

  const [checklistResult, photoResult] = await Promise.all([
    client
      .from('inspection_profile_checklist_items')
      .select('*')
      .eq('profile_id', (inspection as Inspection).inspection_profile_id)
      .order('sort_order', { ascending: true }),
    client
      .from('inspection_profile_photo_items')
      .select('*')
      .eq('profile_id', (inspection as Inspection).inspection_profile_id)
      .order('sort_order', { ascending: true }),
  ])
  if (checklistResult.error) throw checklistResult.error
  if (photoResult.error) throw photoResult.error

  const { data: profile, error: profileErr } = await client
    .from('inspection_profiles')
    .select('*')
    .eq('id', (inspection as Inspection).inspection_profile_id)
    .single()
  if (profileErr) throw profileErr

  return {
    inspection: inspection as Inspection,
    profile: {
      ...(profile as InspectionProfile),
      checklist_items: (checklistResult.data ?? []) as InspectionProfileChecklistItem[],
      photo_items: (photoResult.data ?? []) as InspectionProfilePhotoItem[],
    },
  }
}

/** Vistorias periódicas (todos os status) das locações do cliente autenticado — RLS já escopa. */
export async function listPeriodicInspectionsForCustomer(
  client: SupabaseClient,
  tenantId?: string | null,
): Promise<Inspection[]> {
  let q = client
    .from('inspections')
    .select('*')
    .eq('kind', 'periodic')
    .order('created_at', { ascending: false })
  if (tenantId) q = q.eq('tenant_id', tenantId)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as Inspection[]
}
