/**
 * O que o encerramento retroativo faz com cada linha do cronograma (Spec 0016).
 *
 * A tela (via `@gomoto/data`) e a Server Action `terminateRental` precisam dos
 * MESMOS fatos para classificar cada linha — a Action nunca confia na lista de
 * ids que o client manda para o cancelamento OPCIONAL (dentro do período);
 * ela recarrega o plano aqui e reconfere cada id recebido contra ele (mesmo
 * motivo pelo qual `loadPeriodAdjustmentContext` existe para o ajuste de
 * período, ADR 0035).
 *
 * Módulo separado de `actions.ts` de propósito: aquele arquivo é `'use server'`
 * e só pode exportar função assíncrona chamável pelo client.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  planRetroactiveTermination,
  type ScheduleLineRow,
  type ScheduleLineChargeRow,
  type TerminationChargeInfo,
  type TerminationLine,
} from '@gomoto/core'

/**
 * Classifica toda linha viva do cronograma (`scheduled` ou `issued`) da
 * locação em relação a `terminationDate` — fora do período (cancelamento
 * automático ou bloqueado) ou dentro dele (mantida, com opção de cancelar).
 *
 * Mesmo vínculo que `loadPeriodAdjustmentContext` usa: a origem da cobrança de
 * ciclo é a LINHA do cronograma, não a locação — `charges.source_module='rental'`
 * + `charges.source_id = <id da linha>` (migration `charge_single_origin`).
 */
export async function loadTerminationPlan(
  supabase: SupabaseClient,
  tenantId: string,
  rentalId: string,
  terminationDate: string,
): Promise<TerminationLine[]> {
  const [
    { data: lineRows },
    { data: chargeRows },
    { data: balanceRows },
  ] = await Promise.all([
    supabase
      .from('rental_billing_schedules')
      .select('id, sequence_number, period_start, period_end, due_date, amount, status')
      .eq('tenant_id', tenantId)
      .eq('rental_id', rentalId)
      .in('status', ['scheduled', 'issued']),
    supabase
      .from('charges')
      .select('id, source_id, charge_number, due_date, status')
      .eq('tenant_id', tenantId)
      .eq('rental_id', rentalId)
      .eq('source_module', 'rental'),
    supabase
      .from('charge_balances')
      .select('charge_id, total_amount, paid_amount, is_overdue')
      .eq('tenant_id', tenantId)
      .eq('rental_id', rentalId),
  ])

  const balanceById = new Map(
    ((balanceRows ?? []) as Array<{ charge_id: string; total_amount: number; paid_amount: number; is_overdue: boolean }>)
      .map((b) => [b.charge_id, b]),
  )

  const charges: TerminationChargeInfo[] = (
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
        is_overdue:       Boolean(balance?.is_overdue ?? false),
      }
    })

  const lines = (lineRows ?? []) as ScheduleLineRow[]
  return planRetroactiveTermination(lines, charges, terminationDate)
}
