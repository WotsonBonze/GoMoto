/**
 * Contexto do ajuste de período (ADR 0035).
 *
 * A tela e a Server Action precisam EXATAMENTE dos mesmos fatos para alimentar
 * `planPeriodAdjustment` — se cada uma montasse o seu, a prévia e a gravação
 * divergiriam no primeiro caso de borda, que é o defeito que a existência de
 * uma função pura única existe para evitar.
 *
 * Módulo separado de `actions.ts` de propósito: aquele arquivo é `'use server'`
 * e só pode exportar função assíncrona chamável pelo client.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  RentalScheduleParams,
  RentalType,
  ScheduleLineChargeRow,
  ScheduleLineRow,
} from '@gomoto/core'
import { businessToday } from '@/lib/financial'

export type AdjustableRental = {
  id: string
  status: string
  contract_type: RentalType
  signed_contract_path: string | null
  params: RentalScheduleParams
  customer: { id: string; name: string } | null
  vehicle: { id: string; license_plate: string; make: string | null; model: string | null } | null
}

export type PeriodAdjustmentContext = {
  rental: AdjustableRental
  lines: ScheduleLineRow[]
  charges: ScheduleLineChargeRow[]
  /** As outras locações do mesmo veículo — o período desta não pode cruzá-las (ADR 0036). */
  other_rentals: Array<{ start_date: string; end_date: string | null }>
  today: string
}

type RentalRow = {
  id: string
  vehicle_id: string | null
  status: string
  contract_type: RentalType | null
  signed_contract_path: string | null
  start_date: string | null
  end_date: string | null
  cycle: 'weekly' | 'monthly' | null
  due_day: number | null
  cycle_amount: number | null
  use_pro_rata: boolean | null
  customer: { id: string; name: string } | null
  vehicle: { id: string; license_plate: string; make: string | null; model: string | null } | null
}

/**
 * Lê locação, cronograma e as cobranças emitidas a partir dele.
 *
 * Devolve `null` quando a locação não existe no tenant. Locação sem ciclo
 * definido também é `null`: sem os seis parâmetros não há cronograma para
 * regerar, e deixar passar produziria um plano montado sobre `undefined`.
 */
export async function loadPeriodAdjustmentContext(
  supabase: SupabaseClient,
  tenantId: string,
  rentalId: string,
): Promise<PeriodAdjustmentContext | null> {
  const { data, error } = await supabase
    .from('rentals')
    .select(
      'id, vehicle_id, status, contract_type, signed_contract_path, start_date, end_date, cycle, due_day, cycle_amount, use_pro_rata,'
      + ' customer:customers(id,name), vehicle:vehicles(id,license_plate,make,model)',
    )
    .eq('id', rentalId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (error || !data) return null

  const r = data as unknown as RentalRow
  if (!r.start_date || !r.end_date || !r.cycle || !r.due_day || r.cycle_amount == null) return null

  const { data: lineRows } = await supabase
    .from('rental_billing_schedules')
    .select('id, sequence_number, period_start, period_end, due_date, amount, status')
    .eq('tenant_id', tenantId)
    .eq('rental_id', rentalId)
    .order('period_start', { ascending: true })

  const lines = (lineRows ?? []) as ScheduleLineRow[]

  // A origem da cobrança de ciclo é a LINHA do cronograma, não a locação
  // (migration `charge_single_origin`) — por isso o vínculo é
  // source_module='rental' + source_id = <id da linha>, e o saldo vem de
  // `charge_balances`, que é derivado do razão e não coluna do documento.
  const [{ data: chargeRows }, { data: balanceRows }, { data: otherRows }] = await Promise.all([
    supabase
      .from('charges')
      .select('id, source_id, charge_number, due_date, status')
      .eq('tenant_id', tenantId)
      .eq('rental_id', rentalId)
      .eq('source_module', 'rental'),
    supabase
      .from('charge_balances')
      .select('charge_id, total_amount, paid_amount')
      .eq('tenant_id', tenantId)
      .eq('rental_id', rentalId),
    r.vehicle_id
      ? supabase
          .from('rentals')
          .select('start_date, end_date')
          .eq('tenant_id', tenantId)
          .eq('vehicle_id', r.vehicle_id)
          .neq('id', rentalId)
      : Promise.resolve({ data: [] }),
  ])

  const balanceById = new Map(
    ((balanceRows ?? []) as Array<{ charge_id: string; total_amount: number; paid_amount: number }>)
      .map((b) => [b.charge_id, b]),
  )

  const charges: ScheduleLineChargeRow[] = (
    (chargeRows ?? []) as Array<{
      id: string
      source_id: string | null
      charge_number: number
      due_date: string
      status: ScheduleLineChargeRow['status']
    }>
  )
    .filter((c) => c.source_id !== null)
    .map((c) => {
      const balance = balanceById.get(c.id)
      return {
        schedule_line_id: c.source_id!,
        charge_id:        c.id,
        charge_number:    Number(c.charge_number),
        due_date:         c.due_date,
        total_amount:     Number(balance?.total_amount ?? 0),
        paid_amount:      Number(balance?.paid_amount ?? 0),
        status:           c.status,
      }
    })

  return {
    rental: {
      id:                   r.id,
      status:               r.status,
      contract_type:        r.contract_type ?? 'rental',
      signed_contract_path: r.signed_contract_path,
      customer:             r.customer,
      vehicle:              r.vehicle,
      params: {
        start_date:   r.start_date,
        end_date:     r.end_date,
        cycle:        r.cycle,
        due_day:      r.due_day,
        cycle_amount: Number(r.cycle_amount),
        use_pro_rata: r.use_pro_rata ?? true,
      },
    },
    lines,
    charges,
    other_rentals: ((otherRows ?? []) as Array<{ start_date: string | null; end_date: string | null }>)
      .filter((o): o is { start_date: string; end_date: string | null } => o.start_date !== null),
    today: await businessToday(supabase, tenantId),
  }
}
