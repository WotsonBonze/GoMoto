import type { SupabaseClient } from '@supabase/supabase-js'
import { deriveInspectionScheduleStatus, pickLatestInspectionBySchedule } from '@gomoto/core'
import type {
  Inspection,
  InspectionSchedule,
  InspectionScheduleWithStatus,
} from '@gomoto/core'

export interface ScheduleWithRentalInfo extends InspectionSchedule {
  rental: {
    id: string
    customer: { id: string; name: string } | null
    vehicle: { id: string; license_plate: string; make: string; model: string } | null
  } | null
}

async function withDerivedStatus<T extends InspectionSchedule>(
  client: SupabaseClient,
  schedules: T[],
): Promise<(T & { status: InspectionScheduleWithStatus['status']; latest_inspection: Inspection | null })[]> {
  if (schedules.length === 0) return []

  const { data: inspections, error } = await client
    .from('inspections')
    .select('*')
    .in('schedule_id', schedules.map((s) => s.id))
  if (error) throw error

  const latestBySchedule = pickLatestInspectionBySchedule((inspections ?? []) as Inspection[])
  const today = new Date()

  return schedules.map((schedule) => {
    const latest = latestBySchedule.get(schedule.id) ?? null
    return {
      ...schedule,
      status: deriveInspectionScheduleStatus(schedule, latest, today),
      latest_inspection: latest,
    }
  })
}

/** Agendamentos de vistoria periódica de uma locação, com status derivado. */
export async function listInspectionSchedulesByRental(
  client: SupabaseClient,
  rentalId: string,
): Promise<InspectionScheduleWithStatus[]> {
  const { data, error } = await client
    .from('inspection_schedules')
    .select('*')
    .eq('rental_id', rentalId)
    .order('target_date', { ascending: true })
  if (error) throw error
  return withDerivedStatus(client, (data ?? []) as InspectionSchedule[])
}

/**
 * Todos os agendamentos do tenant (RLS já escopa), com dados de cliente/veículo
 * embutidos — alimenta a lista central de pendências (RF-017).
 */
export async function listInspectionSchedulesForTenant(
  client: SupabaseClient,
): Promise<(ScheduleWithRentalInfo & { status: InspectionScheduleWithStatus['status']; latest_inspection: Inspection | null })[]> {
  const { data, error } = await client
    .from('inspection_schedules')
    .select('*, rental:rentals(id, customer:customers(id,name), vehicle:vehicles(id,license_plate,make,model))')
    .order('target_date', { ascending: true })
  if (error) throw error
  return withDerivedStatus(client, (data ?? []) as ScheduleWithRentalInfo[])
}

/**
 * Um agendamento específico com contexto (cliente/veículo) e status derivado
 * — usado pela tela `/vistorias/schedule/[scheduleId]` quando ainda não há
 * `inspections` submetida para visualizar (só o preview dos itens do perfil).
 */
export async function getInspectionScheduleWithContext(
  client: SupabaseClient,
  scheduleId: string,
): Promise<(ScheduleWithRentalInfo & { status: InspectionScheduleWithStatus['status']; latest_inspection: Inspection | null }) | null> {
  const { data: schedule, error } = await client
    .from('inspection_schedules')
    .select('*, rental:rentals(id, customer:customers(id,name), vehicle:vehicles(id,license_plate,make,model))')
    .eq('id', scheduleId)
    .maybeSingle()
  if (error) throw error
  if (!schedule) return null

  const [result] = await withDerivedStatus(client, [schedule as ScheduleWithRentalInfo])
  return result ?? null
}

/**
 * Agendamentos pendentes (não aprovados) do cliente autenticado — RLS
 * (`customer_self_select_inspection_schedules`) já restringe às próprias
 * locações. Usado pela tela de vistoria periódica do app mobile.
 */
export async function listPendingInspectionSchedulesForCustomer(
  client: SupabaseClient,
  tenantId?: string | null,
): Promise<InspectionScheduleWithStatus[]> {
  let q = client
    .from('inspection_schedules')
    .select('*')
    .order('target_date', { ascending: true })
  if (tenantId) q = q.eq('tenant_id', tenantId)
  const { data, error } = await q
  if (error) throw error
  const withStatus = await withDerivedStatus(client, (data ?? []) as InspectionSchedule[])
  return withStatus.filter((s) => s.status !== 'approved')
}
