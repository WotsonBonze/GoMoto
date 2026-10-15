/**
 * "Hoje" e "fim do dia" no fuso da LOCADORA, não do servidor.
 *
 * A Vercel roda em UTC. Às 22h em Brasília o servidor já está no dia seguinte,
 * e qualquer conta de atraso feita com `new Date()` erra um dia: o encargo sai
 * com um dia a mais e o vencimento mandado ao Asaas com um dia a mais — um dia
 * de juros a menos no código. O banco já resolve isso com `tenants.timezone` e
 * `fn_business_today`; isto é o mesmo do lado da aplicação.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_TZ = 'America/Sao_Paulo'

/** `tenants.timezone`; `null` quando não lido — `tenantToday` cai no padrão. */
export async function fetchTenantTimezone(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<string | null> {
  const { data } = await supabase.from('tenants').select('timezone').eq('id', tenantId).maybeSingle()
  return (data as { timezone: string | null } | null)?.timezone ?? null
}

function datePartsIn(tz: string, at: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return { y: get('year'), m: get('month'), d: get('day') }
}

/**
 * A data de hoje na locadora, como `Date` à meia-noite LOCAL do processo.
 *
 * É o formato que `calculateAmountDue` espera em `asOf`: ela lê
 * `getFullYear/getMonth/getDate`, então o que importa é o dia carregado, não o
 * instante.
 */
export function tenantToday(tz: string | null | undefined, now: Date = new Date()): Date {
  const { y, m, d } = datePartsIn(tz ?? DEFAULT_TZ, now)
  return new Date(y, m - 1, d)
}

/**
 * 23:59:59 de hoje na locadora, em ISO com o deslocamento do fuso
 * (`2026-10-10T23:59:59.000-03:00`).
 *
 * `minLeadMs` existe porque provedores recusam validade curta demais (o
 * Mercado Pago exige pelo menos 30 minutos): perto da meia-noite o código vale
 * até o piso, atravessando a virada por alguns minutos.
 */
export function endOfTenantDayIso(
  tz: string | null | undefined,
  now: Date = new Date(),
  minLeadMs = 0,
): string {
  const zone = tz || DEFAULT_TZ
  const { y, m, d } = datePartsIn(zone, now)
  const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const offset = offsetOf(zone, now)
  const endOfDay = `${date}T23:59:59.000${offset}`

  if (minLeadMs > 0 && Date.parse(endOfDay) - now.getTime() < minLeadMs) {
    return new Date(now.getTime() + minLeadMs).toISOString()
  }
  return endOfDay
}

/** `GMT-03:00` → `-03:00`; `GMT` → `+00:00`. */
function offsetOf(tz: string, at: Date): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  const match = name.match(/GMT([+-]\d{2}:\d{2})/)
  return match ? match[1]! : '+00:00'
}
