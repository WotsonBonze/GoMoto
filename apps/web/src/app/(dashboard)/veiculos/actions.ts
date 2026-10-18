'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import {
  VehicleSchema,
  VehicleBaseSchema,
  VehicleStatusTransitionSchema,
  AssignMaintenancePlanSchema,
  buildMaintenanceBootstrapRows,
  type VehicleStatus,
  type VehiclePhotoSlot,
  type ActionResult,
} from '@gomoto/core'
import { logAction } from '@/lib/audit'
import { getCurrentTenantId } from '@/lib/auth/tenant'
import { recordStatusTransition } from '@/lib/vehicle-status-history'
import { saveVehicleObligations as saveObligations } from '@/lib/financial/vehicle-obligation'
import { canChangeStatus, isVehicleModelYearCoherent, resolveKmEntryUpdate } from '@gomoto/core'

/**
 * Placa, RENAVAM e chassi são únicos por tenant. O nome da constraint vem na
 * mensagem do Postgres (`vehicles_tenant_<campo>_key`) — é daí que sai o campo
 * para o form abrir a seção certa e marcar o input.
 */
const UNIQUE_FIELD_MESSAGES: Record<string, string> = {
  license_plate: 'Esta placa já está cadastrada.',
  renavam:       'Este RENAVAM já está cadastrado em outro veículo.',
  chassis:       'Este chassi já está cadastrado em outro veículo.',
}
function uniqueViolation(error: { code?: string; message: string }) {
  if (error.code !== '23505') return null
  const field = Object.keys(UNIQUE_FIELD_MESSAGES).find((f) => error.message.includes(`vehicles_tenant_${f}_key`))
  return field ? { code: 'VALIDATION_ERROR' as const, message: UNIQUE_FIELD_MESSAGES[field], field } : null
}

async function getAuthenticatedContext() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const tenantId = user ? await getCurrentTenantId(supabase) : null
  return { supabase, user, tenantId }
}

export async function createVehicle(
  input: unknown,
  photos?: Partial<Record<VehiclePhotoSlot, string>>,
): Promise<ActionResult<{ id: string; failedSlots?: VehiclePhotoSlot[] }>> {
  const { supabase, user, tenantId } = await getAuthenticatedContext()

  if (!user) {
    return { ok: false, error: { code: 'UNAUTHORIZED', message: 'Não autorizado' } }
  }
  if (!tenantId) {
    return { ok: false, error: { code: 'FORBIDDEN', message: 'Tenant não resolvido' } }
  }

  const parsed = VehicleSchema.safeParse(input)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: firstIssue?.message ?? 'Dados inválidos',
        field: firstIssue?.path.join('.'),
      },
    }
  }

  const { data: vehicle, error: insertError } = await supabase
    .from('vehicles')
    .insert({ ...parsed.data, tenant_id: tenantId })
    .select()
    .single()

  if (insertError) {
    const duplicate = uniqueViolation(insertError)
    if (duplicate) return { ok: false, error: duplicate }
    // A mensagem do banco vai junto: engolir o motivo já custou horas de
    // depuração num bug idêntico no cadastro de multas. Se o insert quebra por
    // coluna removida ou constraint, quem está na tela precisa ver o quê.
    console.error('[createVehicle] insert failed', insertError)
    return {
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: `Erro ao cadastrar veículo: ${insertError.message}` },
    }
  }

  try {
    await recordStatusTransition(supabase, {
      vehicleId:      vehicle.id,
      tenantId,
      previousStatus: null,
      newStatus:      vehicle.status as VehicleStatus,
      userId:         user.id,
    })
  } catch {
    // Falha no histórico não deve bloquear o cadastro já criado — logar e continuar
    console.error('[createVehicle] recordStatusTransition failed for', vehicle.id)
  }

  const failedSlots: VehiclePhotoSlot[] = []
  if (photos) {
    await Promise.allSettled(
      (Object.entries(photos) as [VehiclePhotoSlot, string][])
        .filter(([, url]) => !!url)
        .map(async ([slot, url]) => {
          const { error } = await supabase.from('vehicle_photos').upsert({
            vehicle_id: vehicle.id,
            tenant_id:  tenantId,
            slot,
            url,
          }, { onConflict: 'vehicle_id,slot' })
          if (error) {
            console.error('[createVehicle] photo upsert failed', { vehicleId: vehicle.id, slot })
            failedSlots.push(slot)
          }
        }),
    )
  }

  await logAction({ action: 'create', table: 'vehicles', recordId: vehicle.id, newData: vehicle })
  revalidatePath('/veiculos')
  revalidatePath(`/veiculos/${vehicle.id}`)

  return {
    ok: true,
    data: { id: vehicle.id, ...(failedSlots.length > 0 ? { failedSlots } : {}) },
  }
}

export async function updateVehicle(
  vehicleId: string,
  input: unknown,
  photos?: Partial<Record<VehiclePhotoSlot, string | null>>,
): Promise<ActionResult<{ id: string; failedSlots?: VehiclePhotoSlot[] }>> {
  const { supabase, user, tenantId } = await getAuthenticatedContext()

  if (!user) {
    return { ok: false, error: { code: 'UNAUTHORIZED', message: 'Não autorizado' } }
  }
  if (!tenantId) {
    return { ok: false, error: { code: 'FORBIDDEN', message: 'Tenant não resolvido' } }
  }

  const { data: current, error: fetchError } = await supabase
    .from('vehicles')
    .select('id, status, km_entry')
    .eq('id', vehicleId)
    .single()

  if (fetchError || !current) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Veículo não encontrado', field: 'id' } }
  }

  const parsed = VehicleBaseSchema.partial().safeParse(input)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: firstIssue?.message ?? 'Dados inválidos',
        field: firstIssue?.path.join('.'),
      },
    }
  }

  // km_entry é gravado uma vez só (RN-010): aceito enquanto o veículo não tem
  // KM de entrada; depois disso, descartado. O trigger vehicles_km_entry_guard
  // garante o mesmo no banco.
  const { km_entry: requestedKmEntry, ...rest } = parsed.data
  const kmEntry = resolveKmEntryUpdate(current.km_entry, requestedKmEntry)
  const updateData = kmEntry !== undefined ? { ...rest, km_entry: kmEntry } : rest

  // O refine de coerência dos anos vive em VehicleSchema, que `.partial()` não
  // carrega — sem esta checagem a edição aceitaria 2025/2023.
  if (!isVehicleModelYearCoherent(updateData.year_manufacture, updateData.year_model)) {
    return {
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Ano modelo deve ser igual ao ano de fabricação ou o seguinte', field: 'year_model' },
    }
  }

  // Se moto está Locada, status não pode ser alterado (RN-002)
  if (current.status === 'rented' && updateData.status) {
    delete updateData.status
  }

  const previousStatus = current.status as VehicleStatus
  const newStatus = updateData.status as VehicleStatus | undefined

  const { data: updatedVehicle, error: updateError } = await supabase
    .from('vehicles')
    .update(updateData)
    .eq('id', vehicleId)
    .select()
    .single()

  if (updateError) {
    const duplicate = uniqueViolation(updateError)
    if (duplicate) return { ok: false, error: duplicate }
    console.error('[updateVehicle] update failed', updateError)
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: `Erro ao atualizar veículo: ${updateError.message}` } }
  }

  if (newStatus && newStatus !== previousStatus) {
    await recordStatusTransition(supabase, {
      vehicleId,
      tenantId,
      previousStatus,
      newStatus,
      userId: user.id,
    })
  }

  const failedSlots: VehiclePhotoSlot[] = []
  if (photos) {
    await Promise.allSettled(
      (Object.entries(photos) as [VehiclePhotoSlot, string | null][]).map(async ([slot, url]) => {
        if (url === null) {
          // Deletar foto do slot
          const { data: existing } = await supabase
            .from('vehicle_photos')
            .select('url')
            .eq('vehicle_id', vehicleId)
            .eq('slot', slot)
            .maybeSingle()

          if (existing?.url) {
            await supabase.storage.from('vehicle-photos').remove([existing.url])
          }
          await supabase
            .from('vehicle_photos')
            .delete()
            .eq('vehicle_id', vehicleId)
            .eq('slot', slot)
        } else if (url) {
          const { error } = await supabase.from('vehicle_photos').upsert({
            vehicle_id: vehicleId,
            tenant_id:  tenantId,
            slot,
            url,
          }, { onConflict: 'vehicle_id,slot' })
          if (error) {
            console.error('[updateVehicle] photo upsert failed', { vehicleId, slot })
            failedSlots.push(slot)
          }
        }
      }),
    )
  }

  await logAction({
    action: 'update',
    table: 'vehicles',
    recordId: vehicleId,
    oldData: current,
    newData: updatedVehicle,
  })
  revalidatePath('/veiculos')
  revalidatePath(`/veiculos/${vehicleId}`)

  return {
    ok: true,
    data: { id: vehicleId, ...(failedSlots.length > 0 ? { failedSlots } : {}) },
  }
}

export async function changeVehicleStatus(
  vehicleId: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const { supabase, user, tenantId } = await getAuthenticatedContext()

  if (!user) {
    return { ok: false, error: { code: 'UNAUTHORIZED', message: 'Não autorizado' } }
  }
  if (!tenantId) {
    return { ok: false, error: { code: 'FORBIDDEN', message: 'Tenant não resolvido' } }
  }

  const parsed = VehicleStatusTransitionSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Dados inválidos' } }
  }

  const { new_status: newStatus } = parsed.data

  // changeVehicleStatus só aceita sold, inactive, available
  if (!['sold', 'inactive', 'available'].includes(newStatus)) {
    return {
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Transição não permitida por este endpoint' },
    }
  }

  const { data: vehicle, error: fetchError } = await supabase
    .from('vehicles')
    .select('id, status')
    .eq('id', vehicleId)
    .single()

  if (fetchError || !vehicle) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Veículo não encontrado', field: 'id' } }
  }

  const currentStatus = vehicle.status as VehicleStatus

  if (!canChangeStatus(currentStatus, newStatus)) {
    return {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: `Não é possível alterar de "${currentStatus}" para "${newStatus}"`,
      },
    }
  }

  const { error: updateError } = await supabase
    .from('vehicles')
    .update({ status: newStatus })
    .eq('id', vehicleId)

  if (updateError) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Erro ao atualizar status' } }
  }

  await recordStatusTransition(supabase, {
    vehicleId,
    tenantId,
    previousStatus: currentStatus,
    newStatus,
    userId: user.id,
  })

  await logAction({
    action: 'update',
    table: 'vehicles',
    recordId: vehicleId,
    oldData: { status: currentStatus },
    newData: { status: newStatus },
  })

  revalidatePath('/veiculos')
  revalidatePath(`/veiculos/${vehicleId}`)

  return { ok: true, data: { id: vehicleId } }
}

export async function saveVehicleObligations(
  vehicleId: string,
  obligations: Array<{
    type: 'ipva' | 'licensing' | 'dpvat'
    amount: number
    due_date: string
    status: 'pending' | 'paid' | 'exempt'
    reference_year: number
  }>,
): Promise<ActionResult<void>> {
  const { supabase, user, tenantId } = await getAuthenticatedContext()

  if (!user) return { ok: false, error: { code: 'UNAUTHORIZED', message: 'Não autorizado' } }
  if (!tenantId) return { ok: false, error: { code: 'FORBIDDEN', message: 'Tenant não resolvido' } }

  try {
    await saveObligations(supabase, tenantId, vehicleId, obligations, user.id)
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(err instanceof Error ? err.message : err) } }
  }

  await logAction({ action: 'update', table: 'vehicle_obligations', recordId: vehicleId })
  revalidatePath(`/veiculos/${vehicleId}`)
  return { ok: true, data: undefined }
}

export async function assignMaintenancePlan(
  input: unknown,
): Promise<ActionResult<{ id: string; bootstrapped: number }>> {
  const { supabase, user, tenantId } = await getAuthenticatedContext()

  if (!user) {
    return { ok: false, error: { code: 'UNAUTHORIZED', message: 'Não autorizado' } }
  }
  if (!tenantId) {
    return { ok: false, error: { code: 'FORBIDDEN', message: 'Tenant não resolvido' } }
  }

  const parsed = AssignMaintenancePlanSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Dados inválidos' } }
  }
  const { vehicle_id: vehicleId, plan_id: planId, bootstrap_items: bootstrapItems } = parsed.data

  const { data: current, error: fetchError } = await supabase
    .from('vehicles')
    .select('id, maintenance_plan_id, km_entry')
    .eq('id', vehicleId)
    .single()

  if (fetchError || !current) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Veículo não encontrado', field: 'id' } }
  }

  const { error: updateError } = await supabase
    .from('vehicles')
    .update({ maintenance_plan_id: planId })
    .eq('id', vehicleId)

  if (updateError) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Erro ao atualizar plano de manutenção' } }
  }

  let bootstrapped = 0
  if (planId && bootstrapItems) {
    const { data: items } = await supabase
      .from('maintenance_plan_items')
      .select('id, name, interval_km, interval_days')
      .eq('plan_id', planId)

    if (items && items.length > 0) {
      const today = new Date().toISOString().split('T')[0]
      const rows = buildMaintenanceBootstrapRows(items, bootstrapItems, current.km_entry ?? 0, today)

      // Dedup: não recria manutenção aberta com a mesma descrição (idempotência
      // se a action for chamada duas vezes para o mesmo veículo).
      const { data: existing } = await supabase
        .from('maintenances')
        .select('description')
        .eq('vehicle_id', vehicleId)
        .eq('completed', false)
      const skip = new Set((existing ?? []).map((m) => m.description))

      const toInsert = rows
        .filter((r) => !skip.has(r.description))
        .map((r) => ({ ...r, tenant_id: tenantId, vehicle_id: vehicleId }))

      if (toInsert.length > 0) {
        const { error: insertError } = await supabase.from('maintenances').insert(toInsert)
        if (!insertError) bootstrapped = toInsert.length
      }
    }
  }

  await logAction({
    action: 'update',
    table: 'vehicles',
    recordId: vehicleId,
    oldData: { maintenance_plan_id: current.maintenance_plan_id },
    newData: { maintenance_plan_id: planId },
  })

  revalidatePath('/veiculos')
  revalidatePath(`/veiculos/${vehicleId}`)
  revalidatePath('/manutencao')

  return { ok: true, data: { id: vehicleId, bootstrapped } }
}

export async function deleteVehiclePhoto(
  vehicleId: string,
  slot: VehiclePhotoSlot,
): Promise<ActionResult<void>> {
  const { supabase, user } = await getAuthenticatedContext()

  if (!user) {
    return { ok: false, error: { code: 'UNAUTHORIZED', message: 'Não autorizado' } }
  }

  const { data: photo } = await supabase
    .from('vehicle_photos')
    .select('url')
    .eq('vehicle_id', vehicleId)
    .eq('slot', slot)
    .maybeSingle()

  if (photo?.url) {
    await supabase.storage.from('vehicle-photos').remove([photo.url])
  }

  const { error } = await supabase
    .from('vehicle_photos')
    .delete()
    .eq('vehicle_id', vehicleId)
    .eq('slot', slot)

  if (error) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Erro ao remover foto' } }
  }

  await logAction({ action: 'delete', table: 'vehicle_photos', recordId: vehicleId })

  revalidatePath(`/veiculos/${vehicleId}`)
  revalidatePath('/veiculos')

  return { ok: true, data: undefined }
}
